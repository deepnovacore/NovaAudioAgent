import {isMainThread, parentPort, workerData} from 'node:worker_threads'

import {
  OpenAIEmbeddingModel,
  OpenAITextModel,
  VoiceMem,
  isGlobalReplyPreference,
  type MemoryHit,
  type SearchResult,
  type TextModel,
} from 'voicemem'

import type {PersonalMemoryRecallScope} from '../memory/personal-memory.js'

import {compareCodePoints} from '../canonical-json.js'
import {PrivateDatabaseError, preparePrivateDatabasePath, secureSidecar} from '../private-database.js'
import {parseVoiceMemRecallHit} from './store-client.js'
import type {
  PersonalMemoryEmbeddingConfig,
  VoiceMemRecallHit,
  VoiceMemRecallResult,
  VoiceMemAdmissionReceipt,
  VoiceMemOpenResult,
  VoiceMemResponseAdaptation,
  PersonalMemoryStoreErrorCode,
} from './store-client.js'

const PERSONAL_SCOPE = 'personal'
const MAX_LIMIT = 5
const MAX_QUERY_CHARS = 4_000
const MAX_HIT_TEXT_CHARS = 800
const MAX_EVIDENCE_IDS = 8
const MAX_REPLY_PREFERENCES = 8
const MAX_REPLY_PREFERENCE_TEXT_CHARS = 1_000

class StoreError extends Error {
  constructor(readonly code: PersonalMemoryStoreErrorCode) {
    super(code)
  }
}

interface WorkerData {
  readonly path: string
  readonly userId: string
  readonly embedding: PersonalMemoryEmbeddingConfig
  readonly extractionModel?: string
}

interface Request extends Record<string, unknown> {
  readonly kind: 'request'
  readonly request_id: number
  readonly operation: 'open' | 'recall' | 'remember' | 'close'
  readonly sourceId?: unknown
  readonly sessionId?: unknown
  readonly sequence?: unknown
  readonly text?: unknown
  readonly occurredAt?: unknown
  readonly previousAssistantReply?: unknown
}

if (isMainThread || parentPort === null) throw new Error('personal memory store worker cannot run on the main thread')

const port = parentPort
const data = parseWorkerData(workerData)
let memory: VoiceMem | undefined
let tail = Promise.resolve()
let owner: AbortController | undefined
let drain: Promise<void> | undefined
const failedSourceIds = new Set<string>()
let responseAdaptation: VoiceMemResponseAdaptation = {revision: 0, replyPreferences: []}

port.on('message', message => {
  const request = parseRequest(message)
  if (request === undefined) {
    port.postMessage({kind: 'protocol_error'})
    return
  }
  // Recall is independently abortable; a slow query must not delay durable admission or close.
  if (request.operation === 'recall') { void handle(request); return }
  tail = tail.then(() => handle(request), () => handle(request))
})

async function handle(request: Request): Promise<void> {
  try {
    const result = await execute(request)
    port.postMessage({kind: 'response', request_id: request.request_id, ok: true, result})
    // The initial adaptation snapshot is part of the open response. Start background learning only
    // after that response is published, so a notice can never outrun its baseline revision.
    if (request.operation === 'open') scheduleDrain()
    if (request.operation === 'close') port.close()
  } catch (error) {
    port.postMessage({kind: 'response', request_id: request.request_id, ok: false, error_code: codeFor(error, request.operation)})
    if (request.operation === 'close') port.close()
  }
}

async function execute(request: Request): Promise<unknown> {
  switch (request.operation) {
    case 'open': return open()
    case 'recall': return recall(request.query, request.scope, request.limit)
    case 'remember': return remember(request)
    case 'close': return close()
  }
}

function open(): VoiceMemOpenResult {
  if (memory !== undefined) throw new StoreError('STORE_ALREADY_OPEN')
  try {
    const path = preparePrivateDatabasePath(data.path)
    memory = new VoiceMem({
      path,
      userId: data.userId,
      model: data.extractionModel === undefined ? inertTextModel : new OpenAITextModel({
        baseUrl:data.embedding.baseUrl,apiKey:data.embedding.apiKey,model:data.extractionModel,
      }),
      embeddings: new OpenAIEmbeddingModel({
        baseUrl: data.embedding.baseUrl,
        apiKey: data.embedding.apiKey,
        model: data.embedding.model,
        ...(data.embedding.dimensions === undefined ? {} : {dimensions: data.embedding.dimensions}),
      }),
    })
    secureSidecar(path, '-wal')
    secureSidecar(path, '-shm')
    owner = new AbortController()
    failedSourceIds.clear()
    responseAdaptation = snapshotResponseAdaptation(memory, 0)
    return {response_adaptation: responseAdaptation}
  } catch (error) {
    const opened = memory
    memory = undefined
    void opened?.close().catch(() => undefined)
    if (error instanceof PrivateDatabaseError) throw new StoreError(error.code)
    if (error instanceof StoreError) throw error
    throw new StoreError('STORE_WRITE_FAILED')
  }
}

async function close(): Promise<null> {
  owner?.abort()
  owner=undefined
  const opened = memory
  memory = undefined
  responseAdaptation = {revision: 0, replyPreferences: []}
  if (opened === undefined) return null
  try {
    await opened.close()
    return null
  } catch {
    throw new StoreError('STORE_WRITE_FAILED')
  }
}

async function recall(query: unknown, scope: unknown, limit: unknown): Promise<VoiceMemRecallResult> {
  const opened = memory
  if (opened === undefined) throw new StoreError('STORE_CLOSED')
  if (!nonempty(query, MAX_QUERY_CHARS) || query.includes('\0') || !recallScope(scope)
    || !positiveInteger(limit) || limit > MAX_LIMIT) {
    throw new StoreError('STORE_INVALID_INPUT')
  }
  try {
    const result = await opened.search(query, {
      scope: PERSONAL_SCOPE,
      topK: limit,
      ...(scope === 'recent' ? {candidateLimit: MAX_LIMIT} : {}),
      ...(owner === undefined ? {} : {signal:owner.signal}),
    })
    return project(result, scope)
  } catch (error) {
    if (error instanceof StoreError) throw error
    throw new StoreError('STORE_RECALL_FAILED')
  }
}

function remember(request: Request): VoiceMemAdmissionReceipt {
  const opened=memory
  if(opened===undefined)throw new StoreError('STORE_CLOSED')
  if(!nonempty(request.sourceId,256)||!nonempty(request.sessionId,256)||!positiveInteger(request.sequence)
    ||!nonempty(request.text,40_000)||(request.occurredAt!==null&&!nonempty(request.occurredAt,256))
    ||(request.previousAssistantReply!==undefined&&!boundedText(request.previousAssistantReply,40_000))) throw new StoreError('STORE_INVALID_INPUT')
  if(data.extractionModel===undefined)throw new StoreError('STORE_WRITE_FAILED')
  try {
    const receipt=opened.admitText(request.text,{sourceId:request.sourceId,sessionId:request.sessionId,sequence:request.sequence,
      occurredAt:request.occurredAt,scope:PERSONAL_SCOPE,role:'user',authority:'inferred',speaker:data.userId,
      ...(request.previousAssistantReply === undefined ? {} : {previousAssistantReply: request.previousAssistantReply})})
    scheduleDrain()
    return {state:receipt.state, source_id:receipt.source_id}
  } catch { throw new StoreError('STORE_WRITE_FAILED') }
}

function scheduleDrain(): void {
  const opened=memory
  if(opened===undefined||data.extractionModel===undefined||drain!==undefined)return
  drain=drainPending(opened).then(() => {
    drain=undefined
    try {
      if(memory===opened&&opened.store.pending(data.userId,PERSONAL_SCOPE).some(source=>!failedSourceIds.has(source.id))) scheduleDrain()
    } catch { console.error('[personal-memory] background_learning_failed') }
  }, () => {
    drain=undefined
    // Keep admitted sources durable; retry after admission or reopen, never spin on storage errors.
    console.error('[personal-memory] background_learning_failed')
  })
}

async function drainPending(opened: VoiceMem): Promise<void> {
  for(const source of opened.store.pending(data.userId,PERSONAL_SCOPE)) {
    if(owner?.signal.aborted || memory !== opened)return
    if(failedSourceIds.has(source.id))continue
    try {
      const receipt = await opened.resumeIngest(source.id,{scope:PERSONAL_SCOPE,...(owner === undefined ? {} : {signal:owner.signal})})
      if (receipt.state === 'committed') publishResponseAdaptation(opened)
    }
    catch {
      if(owner?.signal.aborted)return
      // Deliberately process-local: a crash retains pending evidence for one recovery retry on open.
      failedSourceIds.add(source.id)
    }
  }
}

function publishResponseAdaptation(opened: VoiceMem): void {
  const next = snapshotResponseAdaptation(opened, responseAdaptation.revision + 1)
  if (sameResponseAdaptation(responseAdaptation, next)) return
  responseAdaptation = next
  port.postMessage({kind: 'response_adaptation', adaptation: responseAdaptation})
}

/**
 * `store.list` is already fixed to this resource's host user and personal scope. The projection is
 * sorted and capped before it crosses the Worker boundary; it never carries recalled source text.
 */
function snapshotResponseAdaptation(opened: VoiceMem, revision: number): VoiceMemResponseAdaptation {
  const replyPreferences = opened.store.list(data.userId, PERSONAL_SCOPE)
    .filter(item => isGlobalReplyPreference(item.record))
    .toSorted((left, right) => compareCodePoints(right.record.recordedAt, left.record.recordedAt)
      || compareCodePoints(left.record.id, right.record.id))
    .slice(0, MAX_REPLY_PREFERENCES)
    .map(item => ({
      id: bounded(item.record.id, 256),
      text: bounded(item.record.text, MAX_REPLY_PREFERENCE_TEXT_CHARS),
      evidenceIds: item.record.evidenceIds.slice(0, MAX_EVIDENCE_IDS).map(id => bounded(id, 256)),
    }))
  return {revision, replyPreferences}
}

function sameResponseAdaptation(left: VoiceMemResponseAdaptation, right: VoiceMemResponseAdaptation): boolean {
  return left.replyPreferences.length === right.replyPreferences.length && left.replyPreferences.every((preference, index) => {
    const other = right.replyPreferences[index]
    return preference.id === other?.id && preference.text === other.text
      && preference.evidenceIds.length === other.evidenceIds.length && preference.evidenceIds.every((id, evidenceIndex) => id === other.evidenceIds[evidenceIndex])
  })
}

function project(result: SearchResult, scope: PersonalMemoryRecallScope): VoiceMemRecallResult {
  const hits = result.hits.map(projectHit)
  const rightBrainHits = result.rbHits.map(projectHit)
  return {
    source: 'personal',
    state: hits.length === 0 && rightBrainHits.length === 0 ? 'empty' : 'ok',
    scope,
    hits,
    rightBrainHits,
    degraded: result.degraded,
  }
}

function projectHit(hit: MemoryHit): VoiceMemRecallHit {
  return parseVoiceMemRecallHit({
    memoryId: bounded(hit.id, 256),
    kind: hit.kind,
    text: bounded(hit.text, MAX_HIT_TEXT_CHARS),
    subject: bounded(hit.subject, 256),
    ...(hit.attributedTo === undefined ? {} : {attributedTo: bounded(hit.attributedTo, 256)}),
    attribute: boundedOptional(hit.attribute, 256),
    emotion: boundedOptional(hit.emotion, 256),
    occurredAt: hit.occurredAt === null ? null : bounded(hit.occurredAt, 256),
    recordedAt: bounded(hit.recordedAt, 256),
    score: boundedScore(hit.score),
    evidenceIds: hit.evidenceIds.slice(0, MAX_EVIDENCE_IDS).map(item => bounded(item, 256)),
  })
}

const inertTextModel: TextModel = {
  complete(): Promise<string> {
    return Promise.reject(new Error('personal_memory_ingest_not_enabled'))
  },
}

function parseWorkerData(value: unknown): WorkerData {
  if (!isRecord(value) || !hasOnlyKeys(value, ['path', 'userId', 'embedding', 'extractionModel']) || !nonempty(value.path, 4_096) || !nonempty(value.userId, 256)
    || !isRecord(value.embedding) || !nonempty(value.embedding.baseUrl, 2_048)
    || !nonempty(value.embedding.apiKey, 4_096) || !nonempty(value.embedding.model, 256)
    || !hasOnlyKeys(value.embedding, ['baseUrl', 'apiKey', 'model', 'dimensions'])
    || (value.embedding.dimensions !== undefined && (!positiveInteger(value.embedding.dimensions) || value.embedding.dimensions > 4_096))
    || (value.extractionModel !== undefined && !nonempty(value.extractionModel,256))) {
    throw new Error('invalid personal memory worker data')
  }
  return {
    path: value.path,
    userId: value.userId,
    embedding: {
      baseUrl: value.embedding.baseUrl,
      apiKey: value.embedding.apiKey,
      model: value.embedding.model,
      ...(value.embedding.dimensions === undefined ? {} : {dimensions: value.embedding.dimensions}),
    },
    ...(value.extractionModel === undefined ? {} : {extractionModel:value.extractionModel}),
  }
}

function parseRequest(value: unknown): Request | undefined {
  if (!isRecord(value) || value.kind !== 'request' || !positiveInteger(value.request_id)
    || (value.operation !== 'open' && value.operation !== 'recall' && value.operation !== 'remember' && value.operation !== 'close')) return undefined
  const allowed = value.operation === 'recall'
    ? ['kind', 'request_id', 'operation', 'query', 'scope', 'limit']
    : value.operation === 'remember'
      ? ['kind','request_id','operation','sourceId','sessionId','sequence','text','occurredAt','previousAssistantReply']
      : ['kind', 'request_id', 'operation']
  if (!hasOnlyKeys(value, allowed)) return undefined
  return value as Request
}

function codeFor(error: unknown, operation: Request['operation']): PersonalMemoryStoreErrorCode {
  if (error instanceof StoreError) return error.code
  return operation === 'recall' ? 'STORE_RECALL_FAILED' : 'STORE_WRITE_FAILED'
}

function bounded(value: string, max: number): string {
  if (value.length <= max) return value
  const end = value.charCodeAt(max - 1) >= 0xD800 && value.charCodeAt(max - 1) <= 0xDBFF ? max - 1 : max
  return value.slice(0, end)
}

function boundedOptional(value: string, max: number): string {
  return bounded(value, max)
}

function boundedScore(value: number): number {
  if (!Number.isFinite(value) || value < -1 - 1e-12 || value > 1 + 1e-12) throw new StoreError('STORE_READ_FAILED')
  return value
}

function recallScope(value: unknown): value is PersonalMemoryRecallScope {
  return value === 'recent' || value === 'any'
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonempty(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}
