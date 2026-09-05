import {Worker, type WorkerOptions} from 'node:worker_threads'

import type {
  KnowledgeChunkResult,
  KnowledgeJob,
  KnowledgeRecallHit,
  KnowledgeSource,
  ReplaceKnowledgeSourceInput,
} from './types.js'

export interface KnowledgeStoreClientOptions {
  readonly path: string
  readonly maxSources?: number
}

export type KnowledgeStoreErrorCode =
  | 'STORE_ALREADY_OPEN'
  | 'STORE_CLOSED'
  | 'STORE_CAPACITY'
  | 'STORE_INVALID_INPUT'
  | 'STORE_READ_FAILED'
  | 'STORE_SENSITIVE_CONTENT_REJECTED'
  | 'STORE_SENSITIVE_PATH_DENIED'
  | 'STORE_WRITE_FAILED'

export type KnowledgeStoreClientErrorCode = KnowledgeStoreErrorCode
  | 'CLIENT_CLOSED'
  | 'WORKER_ERROR'
  | 'WORKER_EXITED'
  | 'WORKER_PROTOCOL_FAILURE'

export class KnowledgeStoreClientError extends Error {
  constructor(readonly code: KnowledgeStoreClientErrorCode) {
    super(code)
    this.name = 'KnowledgeStoreClientError'
  }
}

interface KnowledgeStoreWorker {
  postMessage(value: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
}

interface WorkerResponse {
  readonly kind: 'response'
  readonly request_id: number
  readonly ok: boolean
  readonly result?: unknown
  readonly error_code?: KnowledgeStoreErrorCode
}

interface Pending<Result> {
  readonly resolve: (result: Result) => void
  readonly reject: (error: KnowledgeStoreClientError) => void
}

export class KnowledgeStoreClient {
  readonly #worker: KnowledgeStoreWorker
  readonly #pending = new Map<number, Pending<unknown>>()
  #nextRequestId = 1
  #closed = false
  #failed = false
  #expectedExit = false
  #exited = false
  #closing: Promise<void> | undefined
  #resolveClosing: (() => void) | undefined
  #rejectClosing: ((error: KnowledgeStoreClientError) => void) | undefined

  constructor(options: KnowledgeStoreClientOptions) {
    const workerUrl = new URL('./store-worker.js', import.meta.url)
    const workerOptions: WorkerOptions = {workerData: {path: options.path, maxSources: options.maxSources}}
    this.#worker = new Worker(workerUrl, workerOptions)
    this.#worker.on('message', message => this.#handleMessage(message))
    this.#worker.on('error', () => this.#fail('WORKER_ERROR'))
    this.#worker.on('exit', code => this.#handleExit(code))
  }

  async open(): Promise<void> { await this.#request('open', {}) }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    this.#closed = true
    this.#expectedExit = true
    this.#rejectPending('CLIENT_CLOSED')
    if (this.#exited) return this.#closing = Promise.resolve()
    this.#closing = new Promise((resolve, reject) => {
      this.#resolveClosing = resolve
      this.#rejectClosing = reject
    })
    try {
      // This is deliberately not an RPC promise: existing requests were rejected above,
      // while the Worker drains its bounded SQLite call and exits after the close signal.
      this.#worker.postMessage({kind: 'request', request_id: this.#nextRequestId++, operation: 'close'})
    } catch {
      void this.#worker.terminate().catch(() => undefined)
    }
    return this.#closing
  }

  listSources(): Promise<readonly KnowledgeSource[]> { return this.#request('list_sources', {}) }

  async replaceSource(input: ReplaceKnowledgeSourceInput): Promise<void> {
    await this.#request('replace_source', {input})
  }

  async removeSource(id: string): Promise<void> { await this.#request('remove_source', {id}) }

  recall(
    query: string,
    vector: readonly number[],
    providerId: string,
    k: number,
  ): Promise<readonly KnowledgeRecallHit[]> {
    return this.#request('recall', {query, vector: [...vector], provider_id: providerId, k})
  }

  getChunk(locator: string): Promise<KnowledgeChunkResult> { return this.#request('get_chunk', {locator}) }

  async recordJob(input: KnowledgeJob): Promise<void> { await this.#request('record_job', {input}) }

  listJobs(): Promise<readonly KnowledgeJob[]> { return this.#request('list_jobs', {}) }

  #request<Result>(operation: string, payload: Record<string, unknown>): Promise<Result> {
    if (this.#closed || this.#failed) return Promise.reject(new KnowledgeStoreClientError('CLIENT_CLOSED'))
    return this.#send(operation, payload)
  }

  #send<Result>(operation: string, payload: Record<string, unknown>): Promise<Result> {
    const requestId = this.#nextRequestId++
    return new Promise<Result>((resolve, reject) => {
      this.#pending.set(requestId, {resolve: resolve as (result: unknown) => void, reject})
      try {
        this.#worker.postMessage({kind: 'request', request_id: requestId, operation, ...payload})
      } catch {
        this.#pending.delete(requestId)
        reject(new KnowledgeStoreClientError('WORKER_PROTOCOL_FAILURE'))
      }
    })
  }

  #handleMessage(message: unknown): void {
    const response = parseResponse(message)
    if (response === undefined) return this.#fail('WORKER_PROTOCOL_FAILURE')
    const pending = this.#pending.get(response.request_id)
    if (pending === undefined) return this.#fail('WORKER_PROTOCOL_FAILURE')
    this.#pending.delete(response.request_id)
    if (!response.ok) {
      pending.reject(new KnowledgeStoreClientError(response.error_code!))
      return
    }
    pending.resolve(response.result)
  }

  #handleExit(code: number): void {
    this.#exited = true
    if (this.#resolveClosing !== undefined || this.#rejectClosing !== undefined) {
      const resolve = this.#resolveClosing
      const reject = this.#rejectClosing
      this.#resolveClosing = undefined
      this.#rejectClosing = undefined
      if (code === 0) resolve?.()
      else reject?.(new KnowledgeStoreClientError('WORKER_EXITED'))
      return
    }
    if (!this.#expectedExit) this.#fail('WORKER_EXITED')
  }

  #fail(code: Extract<KnowledgeStoreClientErrorCode, `WORKER_${string}`>): void {
    if (this.#failed || this.#expectedExit) return
    this.#failed = true
    this.#rejectPending(code)
    void this.#worker.terminate().catch(() => undefined)
  }

  #rejectPending(code: KnowledgeStoreClientErrorCode): void {
    const error = new KnowledgeStoreClientError(code)
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

function parseResponse(value: unknown): WorkerResponse | undefined {
  if (!isRecord(value) || value.kind !== 'response' || !positiveInteger(value.request_id) || typeof value.ok !== 'boolean') return undefined
  if (value.ok) {
    if (!hasOnlyKeys(value, ['kind', 'request_id', 'ok', 'result']) || !('result' in value)) return undefined
    return {kind: 'response', request_id: value.request_id, ok: true, result: value.result}
  }
  if (!hasOnlyKeys(value, ['kind', 'request_id', 'ok', 'error_code']) || !isStoreCode(value.error_code)) return undefined
  return {kind: 'response', request_id: value.request_id, ok: false, error_code: value.error_code}
}

function isStoreCode(value: unknown): value is KnowledgeStoreErrorCode {
  return value === 'STORE_ALREADY_OPEN' || value === 'STORE_CLOSED' || value === 'STORE_CAPACITY'
    || value === 'STORE_INVALID_INPUT' || value === 'STORE_READ_FAILED'
    || value === 'STORE_SENSITIVE_CONTENT_REJECTED' || value === 'STORE_SENSITIVE_PATH_DENIED'
    || value === 'STORE_WRITE_FAILED'
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}
