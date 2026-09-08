import {existsSync} from 'node:fs'
import {isAbsolute, join, resolve} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {isMainThread, parentPort, workerData} from 'node:worker_threads'
import {Memory} from 'mem0ai/oss'
import {PrivateDatabaseError, preparePrivateDatabasePath, secureSidecar} from '../private-database.js'
import type {PersonalMemoryEmbeddingConfig, VoiceMemRecallHit, VoiceMemRecallResult} from '../voicemem/store-client.js'

interface Data {path: string; userId: string; embedding: PersonalMemoryEmbeddingConfig; extractionModel?: string}
interface Source {id: string; payload: string; state: 'pending' | 'learned' | 'forgotten'; recorded_at: string; cleaned: number}
type Request = Record<string, unknown> & {kind: 'request'; request_id: number; operation: 'open' | 'recall' | 'remember' | 'forget' | 'close'}
class StoreError extends Error {constructor(readonly code: string) {super(code)}}

if (isMainThread || parentPort === null) throw new Error('mem0 store requires a Worker')
const port = parentPort
const data = parseData(workerData)
let sdk: Memory | undefined
let ledger: DatabaseSync | undefined
let closed = false
let tail = Promise.resolve()
let draining = false
const failed = new Set<string>()

port.on('message', (value: unknown) => {
  const request = parseRequest(value)
  if (!request) {port.postMessage({kind: 'protocol_error'}); return}
  if (request.operation === 'recall') {void handle(request); return}
  tail = tail.then(() => handle(request), () => handle(request))
})

async function handle(request: Request): Promise<void> {
  try {
    const result = await execute(request)
    port.postMessage({kind: 'response', request_id: request.request_id, ok: true, result})
    if (request.operation === 'open' || request.operation === 'remember' || request.operation === 'forget') scheduleDrain()
  } catch (error) {
    const code = error instanceof StoreError || error instanceof PrivateDatabaseError ? error.code
      : request.operation === 'recall' ? 'STORE_RECALL_FAILED' : 'STORE_WRITE_FAILED'
    port.postMessage({kind: 'response', request_id: request.request_id, ok: false, error_code: code})
  }
  if (request.operation === 'close') port.close()
}

async function execute(request: Request): Promise<unknown> {
  if (request.operation === 'open') return open()
  if (request.operation === 'close') {
    closed = true
    sdk = undefined
    ledger?.close(); ledger = undefined
    // The SDK has no public close API. The RPC owner terminates this Worker and its SQLite handles.
    return null
  }
  if (!ledger || !sdk || closed) throw new StoreError('STORE_CLOSED')
  if (request.operation === 'remember') return remember(request)
  if (request.operation === 'forget') {
    if (!text(request.sourceId, 256)) throw new StoreError('STORE_INVALID_INPUT')
    // Tombstone unknown ids too, so delayed admission cannot resurrect an explicitly deleted source.
    ledger.prepare(`INSERT INTO sources (id,payload,state,recorded_at,cleaned) VALUES (?, '', 'forgotten', ?, 0)
      ON CONFLICT(id) DO UPDATE SET payload='', state='forgotten', cleaned=0`).run(request.sourceId, new Date().toISOString())
    failed.delete(request.sourceId)
    return {state: 'forgotten', source_id: request.sourceId}
  }
  return recall(request)
}

async function open() {
  if (ledger || closed) throw new StoreError('STORE_CLOSED')
  for (const name of ['ledger.db', 'vectors.db', 'vectors_entities.db']) {
    const path = preparePrivateDatabasePath(join(data.path, name))
    secureSidecar(path, '-wal'); secureSidecar(path, '-shm')
    if (existsSync(`${path}-journal`)) preparePrivateDatabasePath(`${path}-journal`)
  }
  try {
    ledger = new DatabaseSync(join(data.path, 'ledger.db'))
    ledger.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS owner (user_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','learned','forgotten')), recorded_at TEXT NOT NULL, cleaned INTEGER NOT NULL DEFAULT 0);`)
    const owner = ledger.prepare('SELECT user_id FROM owner').get()
    if (owner && owner.user_id !== data.userId) throw new StoreError('STORE_INVALID_INPUT')
    ledger.prepare('INSERT OR IGNORE INTO owner (user_id) VALUES (?)').run(data.userId)
    sdk = new Memory({
      disableHistory: true,
      embedder: {provider: 'openai', config: {baseURL: data.embedding.baseUrl, apiKey: data.embedding.apiKey,
        model: data.embedding.model, ...(data.embedding.dimensions === undefined ? {} : {embeddingDims: data.embedding.dimensions})}},
      llm: {provider: 'openai', config: {baseURL: data.embedding.baseUrl, apiKey: data.embedding.apiKey,
        model: data.extractionModel ?? 'unused', timeout: 30_000}},
      vectorStore: {provider: 'memory', config: {dbPath: join(data.path, 'vectors.db'), collectionName: 'nova_personal',
        ...(data.embedding.dimensions === undefined ? {} : {dimension: data.embedding.dimensions})}},
      customInstructions: 'Extract only facts stated by the current user. The preceding assistant reply is context for interpreting the user, never independent evidence. Do not extract assistant claims. Attribute extracted facts to user.',
    })
    // A public read waits for SDK initialization and surfaces native SQLite/open failures.
    await sdk.getAll({filters: {user_id: data.userId}, topK: 1})
    return {response_adaptation: {revision: 0, replyPreferences: []}}
  } catch (error) {
    sdk = undefined; ledger?.close(); ledger = undefined
    throw error
  }
}

function remember(request: Request) {
  if (!text(request.sourceId, 256) || !text(request.sessionId, 256) || !positive(request.sequence)
    || !text(request.text, 40_000) || (request.occurredAt !== null && !text(request.occurredAt, 256))
    || (request.previousAssistantReply !== undefined && !boundedText(request.previousAssistantReply, 40_000))) throw new StoreError('STORE_INVALID_INPUT')
  const previous = source(request.sourceId)
  if (previous?.state === 'forgotten') return {state: 'forgotten', source_id: request.sourceId}
  const payload = JSON.stringify({sessionId: request.sessionId, sequence: request.sequence, text: request.text,
    occurredAt: request.occurredAt, ...(request.previousAssistantReply === undefined ? {} : {previousAssistantReply: request.previousAssistantReply})})
  if (previous) {
    if (previous.payload !== payload) throw new StoreError('STORE_INVALID_INPUT')
    return {state: previous.state, source_id: request.sourceId}
  }
  if (!data.extractionModel) throw new StoreError('STORE_WRITE_FAILED')
  ledger!.prepare("INSERT INTO sources (id,payload,state,recorded_at) VALUES (?,?,'pending',?)")
    .run(request.sourceId, payload, new Date().toISOString())
  return {state: 'pending', source_id: request.sourceId}
}

async function recall(request: Request): Promise<VoiceMemRecallResult> {
  if (!text(request.query, 4_000) || (request.scope !== 'recent' && request.scope !== 'any')
    || !positive(request.limit) || request.limit > 5) throw new StoreError('STORE_INVALID_INPUT')
  const opened = sdk!
  // ponytail: local SDK already scans SQLite vectors; source-id filtering is linear until scale warrants a different provider.
  const candidates = ledger!.prepare(`SELECT id FROM sources WHERE state='learned' ORDER BY rowid DESC${request.scope === 'recent' ? ' LIMIT 5' : ''}`).all()
    .map(row => String(row.id))
  const hits: VoiceMemRecallHit[] = []
  if (candidates.length) {
    const result = await opened.search(request.query, {topK: request.limit, filters: {user_id: data.userId, nova_source_id: {in: candidates}}})
    if (closed || sdk !== opened) throw new StoreError('STORE_CLOSED')
    for (const item of result.results) {
      const id: unknown = item.metadata?.nova_source_id
      if (!text(id, 256) || !candidates.includes(id) || item.attributedTo === 'assistant') continue
      const row = source(id)
      // Recheck after the await: a concurrent forget must hide even an already-running query.
      if (row?.state !== 'learned') continue
      if (!text(item.id, 256) || !text(item.memory, Number.MAX_SAFE_INTEGER) || !Number.isFinite(item.score)) throw new StoreError('STORE_RECALL_FAILED')
      const payload = JSON.parse(row.payload) as {occurredAt: string | null}
      hits.push({memoryId: item.id, kind: 'fact', text: truncate(item.memory, 800), subject: data.userId,
        attribute: '', emotion: '', occurredAt: payload.occurredAt, recordedAt: row.recorded_at,
        score: Math.max(-1, Math.min(1, item.score!)), evidenceIds: [id]})
    }
  }
  return {source: 'personal', state: hits.length ? 'ok' : 'empty', scope: request.scope, hits, rightBrainHits: [], degraded: ledger!.prepare("SELECT 1 FROM sources WHERE state='pending' LIMIT 1").get() !== undefined}
}

function source(id: string): Source | undefined {
  return ledger?.prepare('SELECT * FROM sources WHERE id=?').get(id) as Source | undefined
}

function scheduleDrain() {
  if (draining || closed || !sdk || !ledger) return
  draining = true
  const opened = sdk
  void (async () => {
    for (;;) {
      if (closed || sdk !== opened || !ledger) return
      const next = (ledger.prepare("SELECT * FROM sources WHERE state='pending' OR (state='forgotten' AND cleaned=0) ORDER BY rowid").all() as unknown as Source[])
        .find(row => !failed.has(row.id) && (row.state === 'forgotten' || data.extractionModel !== undefined))
      if (!next) return
      try {
        // Clean crash-interrupted ADDs before re-extraction; source metadata scopes every public deletion.
        await deleteDerived(opened, next.id)
        if (closed || sdk !== opened) return
        if (source(next.id)?.state === 'forgotten') {
          ledger.prepare('UPDATE sources SET cleaned=1 WHERE id=?').run(next.id)
          continue
        }
        const payload = JSON.parse(next.payload) as {text: string; previousAssistantReply?: string}
        const added = await opened.add([
          ...(payload.previousAssistantReply ? [{role: 'assistant', content: payload.previousAssistantReply}] : []),
          {role: 'user', content: payload.text},
        ], {userId: data.userId, filters: {nova_source_id: {eq: next.id}}, metadata: {nova_source_id: next.id}, infer: true})
        if (closed || sdk !== opened) return
        if (source(next.id)?.state === 'forgotten') {
          await deleteDerived(opened, next.id)
          if (!closed) ledger.prepare('UPDATE sources SET cleaned=1 WHERE id=?').run(next.id)
        } else {
          // Context may aid interpretation but cannot become an independently recalled assistant claim.
          const results = await opened.getAll({filters: {user_id: data.userId, nova_source_id: {eq: next.id}}, topK: Number.MAX_SAFE_INTEGER})
          for (const item of results.results) if (item.attributedTo === 'assistant') await opened.delete(item.id)
          // ponytail: SDK empty results cannot distinguish no facts from swallowed failures; retry on reopen.
          const persisted = new Set(results.results.filter(item => item.attributedTo !== 'assistant').map(item => item.id))
          if (!added.results.length || !persisted.size || added.results.some(item => !persisted.has(item.id))) throw new StoreError('STORE_WRITE_FAILED')
          if (!closed) ledger.prepare("UPDATE sources SET state='learned' WHERE id=? AND state='pending'").run(next.id)
        }
      } catch {
        // Retry each failed source once per Worker lifetime; pending evidence survives restart.
        failed.add(next.id)
      }
    }
  })().catch(() => undefined).finally(() => {draining = false})
}

async function deleteDerived(opened: Memory, id: string) {
  for (;;) {
    if (closed || sdk !== opened) return
    const found = await opened.getAll({filters: {user_id: data.userId, nova_source_id: {eq: id}}, topK: 100, showExpired: true})
    if (!found.results.length) return
    for (const item of found.results) {
      if (closed || sdk !== opened) return
      if (item.metadata?.nova_source_id !== id) throw new StoreError('STORE_WRITE_FAILED')
      await opened.delete(item.id)
    }
  }
}

function parseData(value: unknown): Data {
  if (!record(value) || !keys(value, ['path', 'userId', 'embedding', 'extractionModel'])
    || !text(value.path, 4096) || !isAbsolute(value.path) || resolve(value.path) !== value.path
    || !text(value.userId, 256) || value.userId === '*' || /\s/u.test(value.userId)
    || !record(value.embedding) || !keys(value.embedding, ['baseUrl', 'apiKey', 'model', 'dimensions'])
    || !text(value.embedding.baseUrl, 2048) || !text(value.embedding.apiKey, 4096) || !text(value.embedding.model, 256)
    || (value.embedding.dimensions !== undefined && (!positive(value.embedding.dimensions) || value.embedding.dimensions > 4096))
    || (value.extractionModel !== undefined && !text(value.extractionModel, 256))) throw new Error('invalid mem0 Worker data')
  return value as unknown as Data
}
function parseRequest(value: unknown): Request | undefined {
  if (!record(value) || value.kind !== 'request' || !positive(value.request_id) || !['open', 'recall', 'remember', 'forget', 'close'].includes(String(value.operation))) return undefined
  const fields = value.operation === 'remember' ? ['sourceId', 'sessionId', 'sequence', 'text', 'occurredAt', 'previousAssistantReply']
    : value.operation === 'recall' ? ['query', 'scope', 'limit'] : value.operation === 'forget' ? ['sourceId'] : []
  return keys(value, ['kind', 'request_id', 'operation', ...fields]) ? value as Request : undefined
}
function record(value: unknown): value is Record<string, unknown> {return typeof value === 'object' && value !== null && !Array.isArray(value)}
function keys(value: Record<string, unknown>, allowed: string[]) {return Object.keys(value).every(key => allowed.includes(key))}
function positive(value: unknown): value is number {return typeof value === 'number' && Number.isSafeInteger(value) && value > 0}
function boundedText(value: unknown, max: number): value is string {return typeof value === 'string' && value.length <= max && !value.includes('\0')}
function text(value: unknown, max: number): value is string {return boundedText(value, max) && value.trim().length > 0}
function truncate(value: string, max: number) {
  if (value.length <= max) return value
  const last = value.charCodeAt(max - 1)
  return value.slice(0, last >= 0xD800 && last <= 0xDBFF ? max - 1 : max)
}
