import {Worker, type WorkerOptions} from 'node:worker_threads'

import {PersonalMemoryError, type PersonalMemoryRecallScope, type PersonalMemoryRecallResult, type PersonalMemoryRecallHit, type PersonalMemoryAdmissionReceipt, type PersonalMemoryRememberTurn, type PersonalMemoryResource, type PersonalMemoryResponseAdaptation} from '../memory/personal-memory.js'

export interface PersonalMemoryEmbeddingConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly dimensions?: number
}

export interface PersonalMemoryStoreClientOptions {
  /** Absolute, host-selected location for the one durable personal-memory database. */
  readonly path: string
  /** Host identity is fixed for this Worker lifetime, never supplied to recall RPCs. */
  readonly userId: string
  readonly embedding: PersonalMemoryEmbeddingConfig
  /** Enables local extraction in the Worker. Omit for read-only personal recall. */
  readonly extractionModel?: string
  /** Only workers implementing durable source tombstones may enable this capability. */
  readonly supportsForget?: boolean
  /** Test seam. Production uses a Node Worker. */
  readonly workerFactory?: (url: URL, options: WorkerOptions) => PersonalMemoryStoreWorker
}

export interface VoiceMemRecallHit {
  readonly memoryId: string
  readonly kind: 'fact' | 'heartnote' | 'trait'
  readonly text: string
  readonly subject: string
  readonly attributedTo?: string
  readonly attribute: string
  readonly emotion: string
  readonly occurredAt: string | null
  readonly recordedAt: string
  readonly score: number
  /** Stable evidence references only; raw source payloads never leave the Worker. */
  readonly evidenceIds: readonly string[]
}

export interface VoiceMemRecallResult {
  readonly source: 'personal'
  readonly state: 'ok' | 'empty'
  readonly scope: PersonalMemoryRecallScope
  readonly hits: readonly VoiceMemRecallHit[]
  readonly rightBrainHits: readonly VoiceMemRecallHit[]
  readonly degraded: boolean
}

export interface VoiceMemAdmissionReceipt {
  readonly state: 'pending' | 'learned' | 'forgotten'
  readonly source_id: string
}

/** Worker-only projection of the adapter's cached response-adjustment snapshot. */
export interface VoiceMemResponseAdaptation {
  readonly revision: number
  readonly replyPreferences: readonly {
    readonly id: string
    readonly text: string
    readonly evidenceIds: readonly string[]
  }[]
}

export interface VoiceMemOpenResult {
  readonly response_adaptation: VoiceMemResponseAdaptation
}

export type PersonalMemoryStoreErrorCode =
  | 'STORE_ALREADY_OPEN'
  | 'STORE_CLOSED'
  | 'STORE_INVALID_INPUT'
  | 'STORE_READ_FAILED'
  | 'STORE_WRITE_FAILED'
  | 'STORE_RECALL_FAILED'

export type PersonalMemoryStoreClientErrorCode = PersonalMemoryStoreErrorCode
  | 'CLIENT_CLOSED'
  | 'WORKER_ERROR'
  | 'WORKER_EXITED'
  | 'WORKER_PROTOCOL_FAILURE'

export class PersonalMemoryStoreClientError extends PersonalMemoryError {
  constructor(readonly code: PersonalMemoryStoreClientErrorCode) {
    super(['STORE_READ_FAILED', 'STORE_RECALL_FAILED', 'STORE_INVALID_INPUT'].includes(code) ? 'error' : 'unavailable')
    this.name = 'PersonalMemoryStoreClientError'
  }
}

export interface PersonalMemoryStoreWorker {
  postMessage(value: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  unref?(): void
  terminate(): Promise<number>
}

interface WorkerResponse {
  readonly kind: 'response'
  readonly request_id: number
  readonly ok: boolean
  readonly result?: unknown
  readonly error_code?: PersonalMemoryStoreErrorCode
}

interface WorkerResponseAdaptationNotice {
  readonly kind: 'response_adaptation'
  readonly adaptation: VoiceMemResponseAdaptation
}

interface Pending<Result> {
  readonly resolve: (result: Result) => void
  readonly reject: (error: unknown) => void
}

const CLOSE_GRACE_MS = 250
const REQUEST_TIMEOUT_MS = 5_000
const MAX_QUERY_CHARS = 4_000
const MAX_LIMIT = 5
const MAX_REPLY_PREFERENCES = 8
const MAX_REPLY_PREFERENCE_TEXT_CHARS = 1_000

/**
 * The sole main-thread handle to the personal VoiceMem Worker.
 *
 * The Worker owns VoiceMem, DatabaseSync, migrations and query embeddings. This client only moves
 * bounded request/result values over the Worker boundary; it never opens the personal SQLite path.
 */
export class PersonalMemoryStoreClient implements PersonalMemoryResource {
  readonly #workerFactory: (url: URL, options: WorkerOptions) => PersonalMemoryStoreWorker
  readonly #workerOptions: WorkerOptions
  declare readonly remember?: (turn: PersonalMemoryRememberTurn) => Promise<PersonalMemoryAdmissionReceipt>
  declare readonly forget?: (sourceId: string) => Promise<PersonalMemoryAdmissionReceipt>
  readonly responseAdaptation = (): PersonalMemoryResponseAdaptation => {
    if (this.#failed) throw new PersonalMemoryStoreClientError(this.#failure ?? 'WORKER_ERROR')
    if (this.#closed) throw new PersonalMemoryStoreClientError('CLIENT_CLOSED')
    if (!this.#opened) throw new PersonalMemoryStoreClientError('STORE_CLOSED')
    return copyAdaptation(this.#adaptation)
  }
  #worker: PersonalMemoryStoreWorker | undefined
  readonly #pending = new Map<number, Pending<unknown>>()
  /** Responses to an aborted caller are intentionally discarded, not protocol failures. */
  readonly #dropped = new Set<number>()
  #nextRequestId = 1
  #closed = false
  #opened = false
  #failed = false
  #failure: Extract<PersonalMemoryStoreClientErrorCode, `WORKER_${string}`> | undefined
  #expectedExit = false
  #closing: Promise<void> | undefined
  #adaptation: PersonalMemoryResponseAdaptation = freezeAdaptation({revision: 0, replyPreferences: []})

  constructor(options: PersonalMemoryStoreClientOptions) {
    validateOptions(options)
    if (options.supportsForget === true && options.workerFactory === undefined) throw new Error('Forget requires a worker with durable tombstones')
    this.#workerOptions = {workerData: {
      path: options.path,
      userId: options.userId,
      embedding: {...options.embedding},
      ...(options.extractionModel === undefined ? {} : {extractionModel: options.extractionModel}),
    }}
    this.#workerFactory = options.workerFactory ?? ((url, configured) => new Worker(url, configured))
    if (options.extractionModel !== undefined) this.remember = turn => this.#remember(turn)
    if (options.supportsForget === true) this.forget = sourceId => this.#forget(sourceId)
  }

  async open(): Promise<void> {
    if (this.#closed || this.#failed) throw new PersonalMemoryStoreClientError('CLIENT_CLOSED')
    try { this.#ensureWorker() } catch { throw this.#protocolFailure() }
    await this.#request<unknown>('open', {})
  }

  recall(
    query: string,
    options: {readonly scope?: PersonalMemoryRecallScope; readonly limit?: number; readonly signal?: AbortSignal} = {},
  ): Promise<PersonalMemoryRecallResult> {
    validateRecall(query, options)
    options.signal?.throwIfAborted()
    if (!this.#opened) return Promise.reject(new PersonalMemoryStoreClientError('STORE_CLOSED'))
    return this.#request<VoiceMemRecallResult>(
      'recall',
      {query, scope: options.scope ?? 'recent', limit: options.limit ?? MAX_LIMIT},
      options.signal,
    ).then(result => {
      try {
        const parsed = parseRecallResult(result)
        return {source: parsed.source, state: parsed.state, scope: parsed.scope, degraded: parsed.degraded,
          hits: parsed.hits.map(projectHit), contextHits: parsed.rightBrainHits.map(projectHit)}
      } catch (error) {
        this.#fail('WORKER_PROTOCOL_FAILURE')
        throw error
      }
    })
  }

  #remember(turn: PersonalMemoryRememberTurn): Promise<PersonalMemoryAdmissionReceipt> {
    validateRemember(turn)
    if (!this.#opened) return Promise.reject(new PersonalMemoryStoreClientError('STORE_CLOSED'))
    return this.#request<VoiceMemAdmissionReceipt>('remember', {
      sourceId:turn.sourceId,sessionId:turn.sessionId,sequence:turn.sequence,text:turn.text,occurredAt:turn.occurredAt,
      ...(turn.previousAssistantReply === undefined ? {} : {previousAssistantReply: turn.previousAssistantReply}),
    }).then(result => {
      try {
        const receipt = parseAdmissionReceipt(result)
        if (receipt.source_id !== turn.sourceId) throw this.#protocolFailure()
        return {sourceId: receipt.source_id, state: receipt.state === 'forgotten' ? 'deleted' : 'stored'}
      }
      catch (error) { this.#fail('WORKER_PROTOCOL_FAILURE'); throw error }
    })
  }

  async #forget(sourceId: string): Promise<PersonalMemoryAdmissionReceipt> {
    if (!nonempty(sourceId, 256)) throw new PersonalMemoryStoreClientError('STORE_INVALID_INPUT')
    if (!this.#opened) throw new PersonalMemoryStoreClientError('STORE_CLOSED')
    const result = await this.#request<VoiceMemAdmissionReceipt>('forget', {sourceId})
    try {
      const receipt = parseAdmissionReceipt(result)
      if (receipt.source_id !== sourceId || receipt.state !== 'forgotten') throw this.#protocolFailure()
      return {sourceId, state:'deleted'}
    } catch (error) {this.#fail('WORKER_PROTOCOL_FAILURE'); throw error}
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    this.#closed = true
    this.#rejectPending('CLIENT_CLOSED')
    this.#closing = this.#closeFresh()
    return this.#closing
  }

  async #closeFresh(): Promise<void> {
    const worker = this.#worker
    if (worker === undefined) return
    this.#expectedExit = true
    if (!this.#failed) {
      try {
        const graceful = this.#send<unknown>('close', {})
        await Promise.race([graceful.promise.catch(() => undefined), wait(CLOSE_GRACE_MS)])
      } catch {
        // Termination below owns a Worker that cannot accept the close signal.
      }
    }
    worker.unref?.()
    try { await Promise.race([worker.terminate(), wait(CLOSE_GRACE_MS)]) } catch { /* already gone */ }
    this.#rejectPending('CLIENT_CLOSED')
    this.#dropped.clear()
  }

  #request<Result>(operation: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    if (this.#closed || this.#failed) return Promise.reject(new PersonalMemoryStoreClientError('CLIENT_CLOSED'))
    const sent = this.#send<Result>(operation, payload)
    if (signal === undefined) return sent.promise
    const onAbort = () => {
      const pending = this.#pending.get(sent.requestId)
      if (pending === undefined) return
      this.#pending.delete(sent.requestId)
      this.#dropped.add(sent.requestId)
      pending.reject(abortReason(signal))
      if (this.#dropped.size > 256) this.#fail('WORKER_ERROR')
    }
    signal.addEventListener('abort', onAbort, {once: true})
    if (signal.aborted) onAbort()
    return sent.promise.finally(() => signal.removeEventListener('abort', onAbort))
  }

  #send<Result>(operation: string, payload: Record<string, unknown>): {readonly requestId: number; readonly promise: Promise<Result>} {
    const requestId = this.#nextRequestId++
    const promise = new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => this.#fail('WORKER_ERROR'), REQUEST_TIMEOUT_MS)
      this.#pending.set(requestId, {
        resolve: result => { clearTimeout(timer); resolve(result as Result) },
        reject: error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
      })
      try {
        this.#worker!.postMessage({...payload, kind: 'request', request_id: requestId, operation})
      } catch {
        this.#pending.get(requestId)?.reject(new PersonalMemoryStoreClientError('WORKER_PROTOCOL_FAILURE'))
        this.#pending.delete(requestId)
      }
    })
    return {requestId, promise}
  }

  #handleMessage(message: unknown): void {
    let notice: WorkerResponseAdaptationNotice | undefined
    try { notice = parseResponseAdaptationNotice(message) }
    catch { this.#fail('WORKER_PROTOCOL_FAILURE'); return }
    if (notice !== undefined) {
      if (!this.#closed) {
        try {
          if (!this.#opened) throw new PersonalMemoryStoreClientError('WORKER_PROTOCOL_FAILURE')
          this.#setNextAdaptation(notice.adaptation)
        }
        catch { this.#fail('WORKER_PROTOCOL_FAILURE') }
      }
      return
    }
    const response = parseResponse(message)
    if (response === undefined) return this.#fail('WORKER_PROTOCOL_FAILURE')
    if (this.#dropped.delete(response.request_id)) return
    const pending = this.#pending.get(response.request_id)
    if (pending === undefined) return this.#fail('WORKER_PROTOCOL_FAILURE')
    this.#pending.delete(response.request_id)
    if (!response.ok) {
      pending.reject(new PersonalMemoryStoreClientError(response.error_code!))
      return
    }
    if (!this.#opened) {
      try {
        this.#setInitialAdaptation(parseOpenResult(response.result))
        this.#opened = true
      } catch {
        pending.reject(this.#protocolFailure())
        return
      }
    }
    pending.resolve(response.result)
  }

  #fail(code: Extract<PersonalMemoryStoreClientErrorCode, `WORKER_${string}`>): void {
    if (this.#failed || this.#expectedExit) return
    this.#failed = true
    this.#failure = code
    this.#rejectPending(code)
    this.#worker?.unref?.()
    void this.#worker?.terminate().catch(() => undefined)
  }

  #ensureWorker(): void {
    if (this.#worker !== undefined) return
    const worker = this.#workerFactory(new URL('./store-worker.js', import.meta.url), this.#workerOptions)
    this.#worker = worker
    worker.on('message', message => this.#handleMessage(message))
    worker.on('error', () => this.#fail('WORKER_ERROR'))
    worker.on('exit', () => {
      if (!this.#expectedExit) this.#fail('WORKER_EXITED')
    })
  }

  #protocolFailure(): PersonalMemoryStoreClientError {
    this.#fail('WORKER_PROTOCOL_FAILURE')
    return new PersonalMemoryStoreClientError('WORKER_PROTOCOL_FAILURE')
  }

  #setInitialAdaptation(adaptation: VoiceMemResponseAdaptation): void {
    if (adaptation.revision < this.#adaptation.revision) throw new PersonalMemoryStoreClientError('WORKER_PROTOCOL_FAILURE')
    this.#adaptation = freezeAdaptation(adaptation)
  }

  #setNextAdaptation(adaptation: VoiceMemResponseAdaptation): void {
    if (adaptation.revision <= this.#adaptation.revision) throw new PersonalMemoryStoreClientError('WORKER_PROTOCOL_FAILURE')
    this.#adaptation = freezeAdaptation(adaptation)
  }

  #rejectPending(code: PersonalMemoryStoreClientErrorCode): void {
    const error = new PersonalMemoryStoreClientError(code)
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

function validateOptions(options: PersonalMemoryStoreClientOptions): void {
  if (!isRecord(options) || !nonempty(options.path, 4_096) || !nonempty(options.userId, 256)
    || !isRecord(options.embedding) || !nonempty(options.embedding.baseUrl, 2_048)
    || !nonempty(options.embedding.apiKey, 4_096) || !nonempty(options.embedding.model, 256)
    || (options.embedding.dimensions !== undefined && (!positiveInteger(options.embedding.dimensions) || options.embedding.dimensions > 4_096))
    || (options.extractionModel !== undefined && !nonempty(options.extractionModel, 256))) {
    throw new Error('Invalid personal memory store options')
  }
}

function validateRemember(turn: PersonalMemoryRememberTurn): void {
  if (!isRecord(turn) || !nonempty(turn.sourceId,256) || !nonempty(turn.sessionId,256) || !positiveInteger(turn.sequence)
    || !nonempty(turn.text,40_000) || (turn.occurredAt !== null && !nonempty(turn.occurredAt,256))
    || (turn.previousAssistantReply !== undefined && !boundedText(turn.previousAssistantReply, 40_000))) throw new Error('Invalid personal memory admission request')
}

function validateRecall(
  query: string,
  options: {readonly scope?: PersonalMemoryRecallScope; readonly limit?: number; readonly signal?: AbortSignal},
): void {
  if (!nonempty(query, MAX_QUERY_CHARS) || query.includes('\0')
    || (options.scope !== undefined && options.scope !== 'recent' && options.scope !== 'any')
    || (options.limit !== undefined && (!positiveInteger(options.limit) || options.limit > MAX_LIMIT))) {
    throw new Error('Invalid personal memory recall request')
  }
}

function parseRecallResult(value: unknown): VoiceMemRecallResult {
  if (!isRecord(value) || value.source !== 'personal' || (value.state !== 'ok' && value.state !== 'empty')
    || (value.scope !== 'recent' && value.scope !== 'any') || typeof value.degraded !== 'boolean'
    || !Array.isArray(value.hits) || !Array.isArray(value.rightBrainHits)) {
    throw new PersonalMemoryStoreClientError('WORKER_PROTOCOL_FAILURE')
  }
  const hits = value.hits.map(parseVoiceMemRecallHit)
  const rightBrainHits = value.rightBrainHits.map(parseVoiceMemRecallHit)
  if (hits.length > MAX_LIMIT || rightBrainHits.length > MAX_LIMIT
    || (value.state === 'empty' && (hits.length !== 0 || rightBrainHits.length !== 0))) {
    throw new PersonalMemoryStoreClientError('WORKER_PROTOCOL_FAILURE')
  }
  return {source: 'personal', state: value.state, scope: value.scope, hits, rightBrainHits, degraded: value.degraded}
}

function parseAdmissionReceipt(value: unknown): VoiceMemAdmissionReceipt {
  if (!isRecord(value) || (value.state !== 'pending' && value.state !== 'learned' && value.state !== 'forgotten')
    || !nonempty(value.source_id,256) || !hasOnlyKeys(value,['state','source_id'])) throw new PersonalMemoryStoreClientError('WORKER_PROTOCOL_FAILURE')
  return {state:value.state,source_id:value.source_id}
}

function parseResponseAdaptationNotice(value: unknown): WorkerResponseAdaptationNotice | undefined {
  if (!isRecord(value) || value.kind !== 'response_adaptation') return undefined
  if (!hasOnlyKeys(value, ['kind', 'adaptation'])) throw new PersonalMemoryStoreClientError('WORKER_PROTOCOL_FAILURE')
  return {kind: 'response_adaptation', adaptation: parseResponseAdaptation(value.adaptation)}
}

function parseResponseAdaptation(value: unknown): VoiceMemResponseAdaptation {
  if (!isRecord(value) || !nonnegativeInteger(value.revision) || !Array.isArray(value.replyPreferences)
    || value.replyPreferences.length > MAX_REPLY_PREFERENCES || !hasOnlyKeys(value, ['revision', 'replyPreferences'])) {
    throw new PersonalMemoryStoreClientError('WORKER_PROTOCOL_FAILURE')
  }
  const replyPreferences = value.replyPreferences.map(item => {
    if (!isRecord(item) || !nonempty(item.id, 256) || !nonempty(item.text, MAX_REPLY_PREFERENCE_TEXT_CHARS)
      || !Array.isArray(item.evidenceIds) || item.evidenceIds.length > 8 || !item.evidenceIds.every(id => nonempty(id, 256))
      || !hasOnlyKeys(item, ['id', 'text', 'evidenceIds'])) {
      throw new PersonalMemoryStoreClientError('WORKER_PROTOCOL_FAILURE')
    }
    return {id: item.id, text: item.text, evidenceIds: [...item.evidenceIds]}
  })
  return {revision: value.revision, replyPreferences}
}

function parseOpenResult(value: unknown): VoiceMemResponseAdaptation {
  if (!isRecord(value) || !hasOnlyKeys(value, ['response_adaptation'])) {
    throw new PersonalMemoryStoreClientError('WORKER_PROTOCOL_FAILURE')
  }
  return parseResponseAdaptation(value.response_adaptation)
}

function freezeAdaptation(adaptation: VoiceMemResponseAdaptation): PersonalMemoryResponseAdaptation {
  return Object.freeze({
    revision: adaptation.revision,
    replyPreferences: Object.freeze(adaptation.replyPreferences.map(preference => Object.freeze({
      id: preference.id, text: preference.text, evidenceIds: Object.freeze([...preference.evidenceIds]),
    }))),
  })
}

function copyAdaptation(adaptation: PersonalMemoryResponseAdaptation): PersonalMemoryResponseAdaptation {
  return freezeAdaptation(adaptation)
}

export function parseVoiceMemRecallHit(value: unknown): VoiceMemRecallHit {
  if (!isRecord(value) || !nonempty(value.memoryId, 256) || !memoryKind(value.kind) || !nonempty(value.text, 800)
    || !nonempty(value.subject, 256) || typeof value.attribute !== 'string' || value.attribute.length > 256
    || typeof value.emotion !== 'string' || value.emotion.length > 256
    || (value.attributedTo !== undefined && !nonempty(value.attributedTo, 256))
    || (value.occurredAt !== null && !nonempty(value.occurredAt, 256)) || !nonempty(value.recordedAt, 256)
    || typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < -1 - 1e-12 || value.score > 1 + 1e-12
    || !Array.isArray(value.evidenceIds) || value.evidenceIds.length > 8 || !value.evidenceIds.every(item => nonempty(item, 256))) {
    throw new PersonalMemoryStoreClientError('WORKER_PROTOCOL_FAILURE')
  }
  return {
    memoryId: value.memoryId, kind: value.kind, text: value.text, subject: value.subject,
    ...(value.attributedTo === undefined ? {} : {attributedTo: value.attributedTo}), attribute: value.attribute,
    emotion: value.emotion, occurredAt: value.occurredAt, recordedAt: value.recordedAt, score: value.score,
    evidenceIds: [...value.evidenceIds],
  }
}

function parseResponse(value: unknown): WorkerResponse | undefined {
  if (!isRecord(value) || value.kind !== 'response' || !positiveInteger(value.request_id) || typeof value.ok !== 'boolean') return undefined
  if (value.ok) {
    if (!hasOnlyKeys(value, ['kind', 'request_id', 'ok', 'result']) || !Object.hasOwn(value, 'result')) return undefined
    return {kind: 'response', request_id: value.request_id, ok: true, result: value.result}
  }
  if (!hasOnlyKeys(value, ['kind', 'request_id', 'ok', 'error_code']) || !isStoreCode(value.error_code)) return undefined
  return {kind: 'response', request_id: value.request_id, ok: false, error_code: value.error_code}
}

function isStoreCode(value: unknown): value is PersonalMemoryStoreErrorCode {
  return value === 'STORE_ALREADY_OPEN' || value === 'STORE_CLOSED' || value === 'STORE_INVALID_INPUT'
    || value === 'STORE_READ_FAILED' || value === 'STORE_WRITE_FAILED' || value === 'STORE_RECALL_FAILED'
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  return new DOMException('The operation was aborted', 'AbortError')
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}

function memoryKind(value: unknown): value is VoiceMemRecallHit['kind'] {
  return value === 'fact' || value === 'heartnote' || value === 'trait'
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
}

function nonempty(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function projectHit(hit: VoiceMemRecallHit): PersonalMemoryRecallHit {
  return {...hit, kind: hit.kind === 'heartnote' ? 'experience' : hit.kind}
}
