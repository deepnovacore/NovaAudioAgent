import {createHash, randomUUID} from 'node:crypto'
import {chmodSync, lstatSync} from 'node:fs'
import {isMainThread, parentPort, workerData} from 'node:worker_threads'
import {DatabaseSync} from 'node:sqlite'

import {SensitiveContentPolicy, SensitivePathPolicy} from '../memory/sensitivity.js'
import {preparePrivateDatabasePath, PrivateDatabaseError} from '../storage/private-database.js'
import type {
  KnowledgeChunkInput,
  KnowledgeChunkResult,
  KnowledgeJob,
  KnowledgeRecallHit,
  KnowledgeSource,
  KnowledgeIndexChunk,
  ReplaceKnowledgeSourceInput,
} from './types.js'

const MAX_SOURCE_BYTES = 10 * 1024 * 1024
const MAX_CHUNKS = 20_000
const DEFAULT_MAX_SOURCES = 100
const MAX_JOBS = 256
const RRF_K = 60

type StoreCode =
  | 'STORE_ALREADY_OPEN'
  | 'STORE_CLOSED'
  | 'STORE_CAPACITY'
  | 'STORE_INVALID_INPUT'
  | 'STORE_READ_FAILED'
  | 'STORE_SENSITIVE_CONTENT_REJECTED'
  | 'STORE_SENSITIVE_PATH_DENIED'
  | 'STORE_WRITE_FAILED'

class StoreError extends Error {
  constructor(readonly code: StoreCode) {
    super(code)
  }
}

interface WorkerData {
  readonly path: string
  readonly maxSources?: number
  readonly forceLexical?: boolean
}

interface Request extends Record<string, unknown> {
  readonly kind: 'request'
  readonly request_id: number
  readonly operation: string
}

type Row = Record<string, string | number | Uint8Array | null>

if (isMainThread || parentPort === null) throw new Error('knowledge store worker cannot run on the main thread')

const port = parentPort
const data = parseWorkerData(workerData)
const paths = new SensitivePathPolicy()
const content = new SensitiveContentPolicy()
let database: DatabaseSync | undefined
let ftsAvailable = false

port.on('message', message => {
  const request = parseRequest(message)
  if (request === undefined) {
    port.postMessage({kind: 'protocol_error'})
    return
  }
  try {
    const result = execute(request)
    if (request.operation === 'close') {
      port.close()
      return
    }
    port.postMessage({kind: 'response', request_id: request.request_id, ok: true, result})
  } catch (error) {
    if (request.operation === 'close') {
      port.close()
      return
    }
    port.postMessage({kind: 'response', request_id: request.request_id, ok: false, error_code: codeFor(error)})
  }
})

function execute(request: Request): unknown {
  switch (request.operation) {
    case 'open': return open()
    case 'close': return close()
    case 'list_sources': return listSources()
    case 'list_chunks': return listChunks(request.source_id, request.offset)
    case 'link_evidence': return linkEvidence(request.links)
    case 'replace_source': return replaceSource(request.input)
    case 'purge_evidence': return purgeEvidence(request.ids)
    case 'remove_source': return removeSource(request.id)
    case 'recall': return recall(request.query, request.vector, request.provider_id, request.k)
    case 'unembedded_sources': return unembeddedSources(request.provider_id, request.dims)
    case 'unembedded_chunks': return unembeddedChunks(request.source_id, request.provider_id, request.dims)
    case 'set_vectors': return setVectors(request.input)
    case 'get_chunk': return getChunk(request.locator)
    case 'record_job': return recordJob(request.input)
    case 'list_jobs': return listJobs()
    default: throw new StoreError('STORE_INVALID_INPUT')
  }
}

function open(): {readonly fts: boolean} {
  if (database !== undefined) throw new StoreError('STORE_ALREADY_OPEN')
  ftsAvailable = false
  let opened: DatabaseSync | undefined
  try {
    const path = preparePrivateDatabasePath(data.path)
    opened = new DatabaseSync(path, {allowExtension: false, enableForeignKeyConstraints: true})
    opened.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL')
    opened.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, locator TEXT NOT NULL,
        mime TEXT NOT NULL, fingerprint TEXT NOT NULL, bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        heading_path TEXT NOT NULL, text TEXT NOT NULL, token_estimate INTEGER NOT NULL,
        ordinal INTEGER NOT NULL, content_digest TEXT NOT NULL, legacy_digest TEXT
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, state TEXT NOT NULL,
        error_code TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence_links (
        chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_suppressed (hash TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS knowledge_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO knowledge_metadata(key, value) VALUES ('fts_dirty', 1);
      CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks(source_id);
      CREATE INDEX IF NOT EXISTS embeddings_model_idx ON embeddings(provider_id, dims);
      CREATE INDEX IF NOT EXISTS jobs_updated_idx ON jobs(updated_at DESC, id DESC);
    `)
    migrateChunkDigests(opened)
    ftsAvailable = enableFts(opened)
    secureSidecar(path, '-wal')
    secureSidecar(path, '-shm')
    database = opened
    opened = undefined
    return {fts: ftsAvailable}
  } catch (error) {
    try { opened?.close() } catch { /* stable error only */ }
    database = undefined
    ftsAvailable = false
    if (error instanceof StoreError) throw error
    if (error instanceof PrivateDatabaseError) throw new StoreError(error.code)
    throw new StoreError('STORE_WRITE_FAILED')
  }
}

/** Upgrade the original identity-tag schema without replacing rows or losing citations. */
function migrateChunkDigests(opened: DatabaseSync): void {
  if (opened.prepare('PRAGMA table_info(chunks)').all().some(row => row.name === 'content_digest')) return
  try {
    opened.exec(`BEGIN IMMEDIATE;
      ALTER TABLE chunks ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chunks ADD COLUMN content_digest TEXT NOT NULL DEFAULT '';
      ALTER TABLE chunks ADD COLUMN legacy_digest TEXT;
    `)
    const rows = opened.prepare(`SELECT c.id, c.source_id, c.heading_path, c.text, s.title
      FROM chunks c JOIN sources s ON s.id = c.source_id ORDER BY c.source_id, c.rowid`).all() as Row[]
    const update = opened.prepare('UPDATE chunks SET ordinal = ?, content_digest = ?, legacy_digest = ? WHERE id = ?')
    let sourceId = '', ordinal = 0
    for (const row of rows) {
      const source = textValue(row, 'source_id'), id = textValue(row, 'id')
      if (source !== sourceId) {sourceId = source; ordinal = 0}
      update.run(ordinal++, contentDigest(textValue(row, 'title'), textValue(row, 'heading_path'), textValue(row, 'text')), locatorDigest(source, id), id)
    }
    opened.exec('COMMIT')
  } catch (error) {
    try {opened.exec('ROLLBACK')} catch { /* no active transaction */ }
    throw error
  }
}

function close(): null {
  if (database === undefined) return null
  const opened = database
  database = undefined
  try {
    opened.close()
    return null
  } catch {
    throw new StoreError('STORE_WRITE_FAILED')
  }
}

function enableFts(opened: DatabaseSync): boolean {
  if (data.forceLexical || !supportsFts5(opened)) return false
  try {
    opened.exec('BEGIN IMMEDIATE')
    const exists = opened.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunks_fts'").get() !== undefined
    const dirty = opened.prepare("SELECT value FROM knowledge_metadata WHERE key = 'fts_dirty'").get()?.value !== 0
    opened.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id UNINDEXED, source_id UNINDEXED, text, heading_path
      );
    `)
    if (!exists || dirty) opened.exec(`
      DELETE FROM chunks_fts;
      INSERT INTO chunks_fts(chunk_id, source_id, text, heading_path)
      SELECT id, source_id, text, heading_path FROM chunks;
      UPDATE knowledge_metadata SET value = 0 WHERE key = 'fts_dirty';
    `)
    opened.exec('COMMIT')
    return true
  } catch {
    try { opened.exec('ROLLBACK') } catch { /* no active transaction */ }
    return false
  }
}

function supportsFts5(opened: DatabaseSync): boolean {
  try {
    opened.prepare('SELECT fts5(?) AS available').get('knowledge')
    return true
  } catch {
    return false
  }
}

function listSources(): readonly KnowledgeSource[] {
  return db().prepare(`
    SELECT id, title, kind, locator, mime, fingerprint, bytes, created_at, updated_at, status
    FROM sources ORDER BY updated_at DESC, id ASC
  `).all().map(row => sourceFrom(row as Row))
}

function listChunks(sourceValue: unknown, offsetValue: unknown): readonly KnowledgeIndexChunk[] {
  const sourceId = boundedString(sourceValue, 200), offset = nonnegativeInteger(offsetValue, MAX_CHUNKS)
  return db().prepare(`SELECT c.id, c.source_id, c.text, c.ordinal, c.content_digest, s.locator, s.updated_at, l.evidence_id
    FROM chunks c JOIN sources s ON s.id = c.source_id LEFT JOIN evidence_links l ON l.chunk_id = c.id
    WHERE c.source_id = ? ORDER BY c.ordinal, c.id LIMIT 100 OFFSET ?`).all(sourceId, offset).map(value => {
    const row = value as Row
    return {chunk_id: textValue(row, 'id'), source_id: sourceId, text: textValue(row, 'text'), ordinal: numberValue(row, 'ordinal'),
      locator: textValue(row, 'locator'), observed_at: new Date(numberValue(row, 'updated_at')).toISOString(), content_digest: textValue(row, 'content_digest'),
      ...(typeof row.evidence_id === 'string' ? {evidence_id: row.evidence_id} : {})}
  })
}

function linkEvidence(value: unknown): null {
  if (!Array.isArray(value) || value.length > 100) throw new StoreError('STORE_INVALID_INPUT')
  const links = value.map(item => {
    if (!isRecord(item)) throw new StoreError('STORE_INVALID_INPUT')
    return {chunk_id: boundedString(item.chunk_id, 200), content_digest: boundedString(item.content_digest, 200), evidence_id: boundedString(item.evidence_id, 600)}
  })
  const opened = db()
  try {
    opened.exec('BEGIN IMMEDIATE')
    for (const link of links) {
      if (!opened.prepare('SELECT 1 FROM chunks WHERE id = ? AND content_digest = ?').get(link.chunk_id, link.content_digest)) throw new StoreError('STORE_WRITE_FAILED')
      opened.prepare('INSERT INTO evidence_links(chunk_id,evidence_id) VALUES (?,?) ON CONFLICT(chunk_id) DO UPDATE SET evidence_id=excluded.evidence_id').run(link.chunk_id, link.evidence_id)
    }
    opened.exec('COMMIT'); return null
  } catch (error) { try {opened.exec('ROLLBACK')} catch { /* no active transaction */ } throw error }
}

/** Chunks without a vector from this provider, so a scan can commit lexically and embed later. */
function unembeddedSources(providerValue: unknown, dimsValue: unknown): readonly string[] {
  const providerId = boundedString(providerValue, 160), dims = positiveInteger(dimsValue, 4096)
  return (db().prepare(`SELECT DISTINCT c.source_id FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.provider_id = ? AND e.dims = ?
    WHERE e.chunk_id IS NULL LIMIT 1000`).all(providerId, dims) as Row[]).map(row => textValue(row, 'source_id'))
}

function unembeddedChunks(sourceValue: unknown, providerValue: unknown, dimsValue: unknown): {fingerprint: string | null; chunks: readonly {chunk_id: string; content_digest: string; text: string; evidence_id?: string}[]} {
  const sourceId = boundedString(sourceValue, 200), providerId = boundedString(providerValue, 160), dims = positiveInteger(dimsValue, 4096)
  const opened = db(), source = opened.prepare('SELECT fingerprint FROM sources WHERE id = ?').get(sourceId) as Row | undefined
  if (source === undefined) return {fingerprint: null, chunks: []}
  const chunks = (opened.prepare(`SELECT c.id, c.content_digest, c.text, l.evidence_id FROM chunks c
    LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.provider_id = ? AND e.dims = ? LEFT JOIN evidence_links l ON l.chunk_id = c.id
    WHERE c.source_id = ? AND e.chunk_id IS NULL ORDER BY c.ordinal, c.id LIMIT 100`).all(providerId, dims, sourceId) as Row[]).map(row => ({
    chunk_id: textValue(row, 'id'), content_digest: textValue(row, 'content_digest'), text: textValue(row, 'text'),
    ...(typeof row.evidence_id === 'string' ? {evidence_id: row.evidence_id} : {})}))
  return {fingerprint: textValue(source, 'fingerprint'), chunks}
}

/** Writes only while the source fingerprint and each chunk digest still match what was embedded. */
function setVectors(value: unknown): number {
  if (!isRecord(value) || !Array.isArray(value.vectors) || value.vectors.length > 100) throw new StoreError('STORE_INVALID_INPUT')
  const sourceId = boundedString(value.source_id, 200), fingerprint = boundedString(value.fingerprint, 200)
  const providerId = boundedString(value.provider_id, 160), dims = positiveInteger(value.dims, 4096)
  const vectors = value.vectors.map(item => {
    if (!isRecord(item)) throw new StoreError('STORE_INVALID_INPUT')
    const vector = numericVector(item.vector)
    if (vector.length !== dims) throw new StoreError('STORE_INVALID_INPUT')
    return {chunk_id: boundedString(item.chunk_id, 200), content_digest: boundedString(item.content_digest, 200), vector}
  })
  const opened = db()
  try {
    opened.exec('BEGIN IMMEDIATE')
    let written = 0
    if (opened.prepare('SELECT 1 FROM sources WHERE id = ? AND fingerprint = ?').get(sourceId, fingerprint)) {
      const matches = opened.prepare('SELECT 1 FROM chunks WHERE id = ? AND source_id = ? AND content_digest = ?')
      const write = opened.prepare('INSERT INTO embeddings(chunk_id, provider_id, dims, vector) VALUES (?, ?, ?, ?) ON CONFLICT(chunk_id) DO UPDATE SET provider_id = excluded.provider_id, dims = excluded.dims, vector = excluded.vector')
      for (const item of vectors) if (matches.get(item.chunk_id, sourceId, item.content_digest)) {write.run(item.chunk_id, providerId, dims, vectorBlob(item.vector)); written++}
    }
    opened.exec('COMMIT'); return written
  } catch (error) {
    try {opened.exec('ROLLBACK')} catch { /* no active transaction */ }
    if (error instanceof StoreError) throw error
    throw new StoreError('STORE_WRITE_FAILED')
  }
}

function evidenceLink(chunkId: string): {evidence_id?: string} {
  const row = db().prepare('SELECT evidence_id FROM evidence_links WHERE chunk_id = ?').get(chunkId)
  return typeof row?.evidence_id === 'string' ? {evidence_id: row.evidence_id} : {}
}

function replaceSource(value: unknown): null {
  const input = parseReplaceInput(value)
  const opened = db()
  try {
    opened.exec('BEGIN IMMEDIATE')
    const retiredId = input.replaces_source_id && input.replaces_source_id !== input.source.id ? input.replaces_source_id : undefined
    const retiring = retiredId ? opened.prepare('SELECT locator FROM sources WHERE id = ?').get(retiredId) as Row | undefined : undefined
    if (retiredId && retiring?.locator !== input.source.locator) throw new StoreError('STORE_INVALID_INPUT')
    const sourceExists = opened.prepare('SELECT 1 AS present FROM sources WHERE id = ?').get(input.source.id)
    const sourceCount = numberValue(opened.prepare('SELECT COUNT(*) AS count FROM sources').get() as Row, 'count')
    if (sourceCount - Number(!!retiredId) + Number(sourceExists === undefined) > data.maxSources) throw new StoreError('STORE_CAPACITY')
    const oldCount = numberValue(opened.prepare('SELECT COUNT(*) AS count FROM chunks WHERE source_id = ?').get(input.source.id) as Row, 'count')
      + (retiredId ? numberValue(opened.prepare('SELECT COUNT(*) AS count FROM chunks WHERE source_id = ?').get(retiredId) as Row, 'count') : 0)
    const totalCount = numberValue(opened.prepare('SELECT COUNT(*) AS count FROM chunks').get() as Row, 'count')
    if (totalCount - oldCount + input.chunks.length > MAX_CHUNKS) throw new StoreError('STORE_CAPACITY')
    const previous = new Map((opened.prepare('SELECT id, ordinal, content_digest, legacy_digest FROM chunks WHERE source_id = ? ORDER BY ordinal').all(input.source.id) as Row[]).map(row=>[numberValue(row,'ordinal'),row]))
    if (ftsAvailable) opened.prepare('DELETE FROM chunks_fts WHERE source_id = ?').run(input.source.id)
    else opened.exec("UPDATE knowledge_metadata SET value = 1 WHERE key = 'fts_dirty'")
    if (retiredId) {
      if (ftsAvailable) opened.prepare('DELETE FROM chunks_fts WHERE source_id = ?').run(retiredId)
      opened.prepare('DELETE FROM sources WHERE id = ?').run(retiredId)
    }
    opened.prepare('DELETE FROM sources WHERE id = ?').run(input.source.id)
    opened.prepare(`
      INSERT INTO sources(id, title, kind, locator, mime, fingerprint, bytes, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.source.id, input.source.title, input.source.kind, input.source.locator, input.source.mime,
      input.source.fingerprint, input.source.bytes, input.source.created_at, input.source.updated_at,
      input.source.status,
    )
    const chunkStatement = opened.prepare(`
      INSERT INTO chunks(id, source_id, heading_path, text, token_estimate, ordinal, content_digest, legacy_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const embeddingStatement = opened.prepare(`
      INSERT INTO embeddings(chunk_id, provider_id, dims, vector) VALUES (?, ?, ?, ?)
    `)
    const ftsStatement = ftsAvailable ? opened.prepare(`
      INSERT INTO chunks_fts(chunk_id, source_id, text, heading_path) VALUES (?, ?, ?, ?)
    `) : undefined
    // ponytail: ordinal correspondence; use semantic matching only if stable section tracking is required.
    for (const [ordinal, chunk] of input.chunks.entries()) {
      if ((chunk.evidence_id && opened.prepare('SELECT 1 FROM knowledge_suppressed WHERE hash=?').get(purgeHash(chunk.evidence_id))) || opened.prepare('SELECT 1 FROM knowledge_suppressed WHERE hash=?').get(purgeHash(input.source.id+'\0'+chunk.text))) continue
      const old = previous.get(ordinal)
      const id = old === undefined ? randomUUID() : textValue(old, 'id')
      const digest = contentDigest(input.source.title, chunk.heading_path, chunk.text)
      const legacy = old?.content_digest === digest ? old.legacy_digest ?? null : null
      chunkStatement.run(id, input.source.id, chunk.heading_path, chunk.text, chunk.token_estimate, ordinal, digest, legacy)
      if (chunk.evidence_id) opened.prepare('INSERT INTO evidence_links(chunk_id,evidence_id) VALUES (?,?)').run(id, chunk.evidence_id)
      if(chunk.vector!==null)embeddingStatement.run(id, input.provider_id, input.dims, vectorBlob(chunk.vector))
      ftsStatement?.run(id, input.source.id, chunk.text, chunk.heading_path)
    }
    opened.exec('COMMIT')
    return null
  } catch (error) {
    try { opened.exec('ROLLBACK') } catch { /* no active transaction */ }
    if (error instanceof StoreError) throw error
    throw new StoreError('STORE_WRITE_FAILED')
  }
}

function purgeHash(value:string):string {return createHash('sha256').update(value).digest('hex')}

/** Persist the fence and remove all managed copies atomically; every retry compacts again. */
function purgeEvidence(value:unknown):null {
 if(!Array.isArray(value)||value.length>4096)throw new StoreError('STORE_INVALID_INPUT')
 const ids=[...new Set(value.map(id=>boundedString(id,600)))],opened=db()
 opened.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE')
 try{
  for(const id of ids){
   opened.prepare('INSERT OR IGNORE INTO knowledge_suppressed VALUES(?)').run(purgeHash(id))
   const chunks=opened.prepare('SELECT c.id,c.source_id,c.text FROM chunks c JOIN evidence_links e ON e.chunk_id=c.id WHERE e.evidence_id=?').all(id)
   for(const chunk of chunks){
    opened.prepare('INSERT OR IGNORE INTO knowledge_suppressed VALUES(?)').run(purgeHash(String(chunk.source_id)+'\0'+String(chunk.text)))
    // Even a lexical-only worker must clean an existing FTS copy created by a prior runtime.
    if(opened.prepare("SELECT 1 FROM sqlite_master WHERE name='chunks_fts'").get())opened.prepare('DELETE FROM chunks_fts WHERE chunk_id=?').run(String(chunk.id))
    opened.prepare('DELETE FROM chunks WHERE id=?').run(String(chunk.id))
   }
  }
  opened.exec('COMMIT')
 }catch(error){try{opened.exec('ROLLBACK')}catch{/* preserve failure */}throw error}
 // FTS internal segments retain deleted tokens until merged; rebuild contains only surviving chunks.
 if(opened.prepare("SELECT 1 FROM sqlite_master WHERE name='chunks_fts'").get()){
  opened.exec("DROP TABLE chunks_fts; CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED,source_id UNINDEXED,text,heading_path); INSERT INTO chunks_fts(chunk_id,source_id,text,heading_path) SELECT id,source_id,text,heading_path FROM chunks")
 }
 const checkpoint=opened.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
 if(checkpoint&&Number(checkpoint.busy)>0)throw new StoreError('STORE_WRITE_FAILED')
 opened.exec('VACUUM')
 const after=opened.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
 if(after&&Number(after.busy)>0)throw new StoreError('STORE_WRITE_FAILED')
 return null
}

function removeSource(value: unknown): null {
  const id = boundedString(value, 200)
  const opened = db()
  try {
    opened.exec('BEGIN IMMEDIATE')
    if (ftsAvailable) opened.prepare('DELETE FROM chunks_fts WHERE source_id = ?').run(id)
    else opened.exec("UPDATE knowledge_metadata SET value = 1 WHERE key = 'fts_dirty'")
    opened.prepare('DELETE FROM sources WHERE id = ?').run(id)
    opened.exec('COMMIT')
    return null
  } catch {
    try { opened.exec('ROLLBACK') } catch { /* no active transaction */ }
    throw new StoreError('STORE_WRITE_FAILED')
  }
}

function recall(queryValue: unknown, vectorValue: unknown, providerValue: unknown, kValue: unknown): readonly KnowledgeRecallHit[] {
  const query = boundedString(queryValue, 512)
  const vector = numericVector(vectorValue)
  const providerId = boundedString(providerValue, 160)
  const k = positiveInteger(kValue, 5)
  if (k > 5 || vector.length > 4096) throw new StoreError('STORE_INVALID_INPUT')
  const opened = db()
  const dims = vector.length
  const candidates = new Map<string, {readonly row: Row; readonly vectorRank?: number; readonly lexicalRank?: number}>()
  const vectors = opened.prepare(`
    SELECT c.id, c.source_id, c.content_digest, s.title, c.heading_path, c.text, e.vector
    FROM chunks c JOIN sources s ON s.id = c.source_id JOIN embeddings e ON e.chunk_id = c.id
    WHERE e.provider_id = ? AND e.dims = ?
  `).all(providerId, dims) as Row[]
  const scored = vectors.map(row => ({row, score: cosine(vector, blobVector(row.vector ?? null, dims))}))
    .sort((left, right) => right.score - left.score || textValue(left.row, 'source_id').localeCompare(textValue(right.row, 'source_id')) || textValue(left.row, 'id').localeCompare(textValue(right.row, 'id')))
    .slice(0, 50)
  for (const [index, candidate] of scored.entries()) {
    candidates.set(textValue(candidate.row, 'id'), {row: candidate.row, vectorRank: index + 1})
  }

  for (const [index, row] of lexicalCandidates(opened, query).entries()) {
    const id = textValue(row, 'id')
    candidates.set(id, {...candidates.get(id), row, lexicalRank: index + 1})
  }
  if (candidates.size === 0) return []
  return [...candidates.values()]
    .map(ranks => {
      const {row} = ranks
      const score = (ranks.vectorRank === undefined ? 0 : 1 / (RRF_K + ranks.vectorRank))
        + (ranks.lexicalRank === undefined ? 0 : 1 / (RRF_K + ranks.lexicalRank))
      return hitFrom(row, score)
    })
    .sort((left, right) => right.score - left.score || left.source_id.localeCompare(right.source_id) || left.locator.localeCompare(right.locator))
    .slice(0, k)
}

function getChunk(value: unknown): KnowledgeChunkResult {
  const parsed = parseLocator(boundedString(value, 600))
  if (parsed === undefined) return {status: 'gone'}
  const row = db().prepare(`
    SELECT c.id, c.source_id, c.content_digest, c.legacy_digest, c.heading_path, c.text, s.title
    FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.id = ? AND c.source_id = ?
  `).get(parsed.chunkId, parsed.sourceId) as Row | undefined
  if (row === undefined) return {status: 'gone'}
  return {
    ...evidenceLink(textValue(row, 'id')),
    status: textValue(row, 'content_digest').slice(0, 12) === parsed.digest || row.legacy_digest === parsed.digest ? 'ok' : 'stale', text: redactOutput(textValue(row, 'text')), title: redactOutput(textValue(row, 'title')),
    heading_path: redactOutput(textValue(row, 'heading_path')), source_id: textValue(row, 'source_id'),
  }
}

function recordJob(value: unknown): null {
  const job = parseJob(value)
  const opened = db()
  try {
    opened.exec('BEGIN IMMEDIATE')
    opened.prepare(`
      INSERT INTO jobs(id, source_id, state, error_code, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source_id = excluded.source_id, state = excluded.state,
        error_code = excluded.error_code, updated_at = excluded.updated_at
    `).run(job.id, job.source_id, job.state, job.error_code, job.updated_at)
    opened.prepare(`
      DELETE FROM jobs WHERE id IN (
        SELECT id FROM jobs ORDER BY updated_at DESC, id ASC LIMIT -1 OFFSET ?
      )
    `).run(MAX_JOBS)
    opened.exec('COMMIT')
    return null
  } catch {
    try { opened.exec('ROLLBACK') } catch { /* no active transaction */ }
    throw new StoreError('STORE_WRITE_FAILED')
  }
}

function listJobs(): readonly KnowledgeJob[] {
  return db().prepare(`SELECT id, source_id, state, error_code, updated_at FROM jobs ORDER BY updated_at DESC, id ASC`).all()
    .map(row => jobFrom(row as Row))
}

function parseReplaceInput(value: unknown): ReplaceKnowledgeSourceInput {
  if (!isRecord(value) || !isRecord(value.source) || !Array.isArray(value.chunks)) throw new StoreError('STORE_INVALID_INPUT')
  const source = parseSource(value.source)
  const providerId = screenContent(boundedString(value.provider_id, 160))
  const dims = positiveInteger(value.dims, 4096)
  const chunks = value.chunks.map(parseChunk)
  for (const chunk of chunks) if (chunk.vector!==null&&chunk.vector.length !== dims) throw new StoreError('STORE_INVALID_INPUT')
  const replacesSourceId = value.replaces_source_id === undefined ? undefined : boundedString(value.replaces_source_id, 200)
  return {source, chunks, provider_id: providerId, dims, ...(replacesSourceId ? {replaces_source_id: replacesSourceId} : {})}
}

function parseSource(value: Record<string, unknown>): KnowledgeSource {
  const kind = value.kind
  if (kind !== 'file' && kind !== 'url' && kind !== 'folder_child') throw new StoreError('STORE_INVALID_INPUT')
  const locator = boundedString(value.locator, 4096)
  if (kind === 'file' || kind === 'folder_child') {
    if (!paths.allows(locator)) throw new StoreError('STORE_SENSITIVE_PATH_DENIED')
  } else {
    try { new URL(locator) } catch { throw new StoreError('STORE_INVALID_INPUT') }
  }
  return {
    id: screenContent(boundedString(value.id, 200)), title: screenContent(boundedString(value.title, 512)),
    kind, locator: screenContent(locator), mime: screenContent(boundedString(value.mime, 200)),
    fingerprint: screenContent(boundedString(value.fingerprint, 200)), bytes: nonnegativeInteger(value.bytes, MAX_SOURCE_BYTES),
    created_at: nonnegativeInteger(value.created_at, Number.MAX_SAFE_INTEGER),
    updated_at: nonnegativeInteger(value.updated_at, Number.MAX_SAFE_INTEGER),
    status: value.status === 'ready' || value.status === 'failed' ? value.status : invalid(),
  }
}

function parseChunk(value: unknown): KnowledgeChunkInput {
  if (!isRecord(value)) throw new StoreError('STORE_INVALID_INPUT')
  return {
    heading_path: screenContent(boundedString(value.heading_path, 1024)),
    ...(value.evidence_id === undefined ? {} : {evidence_id: boundedString(value.evidence_id, 600)}),
    text: screenContent(boundedCodePoints(value.text, 3200)),
    token_estimate: nonnegativeInteger(value.token_estimate, 1_000_000),
    vector: value.vector===null?null:numericVector(value.vector),
  }
}

function parseJob(value: unknown): KnowledgeJob {
  if (!isRecord(value)) throw new StoreError('STORE_INVALID_INPUT')
  const state = value.state
  if (state !== 'running' && state !== 'complete' && state !== 'failed') throw new StoreError('STORE_INVALID_INPUT')
  const error = value.error_code
  if (error !== null && typeof error !== 'string') throw new StoreError('STORE_INVALID_INPUT')
  return {
    id: screenContent(boundedString(value.id, 200)), source_id: screenContent(boundedString(value.source_id, 200)),
    state, error_code: error === null ? null : screenContent(boundedString(error, 200)),
    updated_at: nonnegativeInteger(value.updated_at, Number.MAX_SAFE_INTEGER),
  }
}

function sourceFrom(row: Row): KnowledgeSource {
  const kind = textValue(row, 'kind')
  const status = textValue(row, 'status')
  if ((kind !== 'file' && kind !== 'url' && kind !== 'folder_child') || (status !== 'ready' && status !== 'failed')) throw new StoreError('STORE_READ_FAILED')
  return {
    id: textValue(row, 'id'), title: redactOutput(textValue(row, 'title')), kind, locator: textValue(row, 'locator'),
    mime: textValue(row, 'mime'), fingerprint: textValue(row, 'fingerprint'), bytes: numberValue(row, 'bytes'),
    created_at: numberValue(row, 'created_at'), updated_at: numberValue(row, 'updated_at'), status,
  }
}

function jobFrom(row: Row): KnowledgeJob {
  const state = textValue(row, 'state')
  if (state !== 'running' && state !== 'complete' && state !== 'failed') throw new StoreError('STORE_READ_FAILED')
  const error = row.error_code
  if (error !== null && typeof error !== 'string') throw new StoreError('STORE_READ_FAILED')
  return {id: textValue(row, 'id'), source_id: textValue(row, 'source_id'), state, error_code: error, updated_at: numberValue(row, 'updated_at')}
}

function hitFrom(row: Row, score: number): KnowledgeRecallHit {
  const sourceId = textValue(row, 'source_id')
  const id = textValue(row, 'id')
  return {
    ...evidenceLink(id),
    locator: `knowledge://${sourceId}/${id}?d=${textValue(row, 'content_digest').slice(0, 12)}`,
    source_id: sourceId, title: redactOutput(textValue(row, 'title')), heading_path: redactOutput(textValue(row, 'heading_path')),
    text: redactOutput(truncateCodePoints(textValue(row, 'text'), 600)), score,
  }
}

function db(): DatabaseSync {
  if (database === undefined) throw new StoreError('STORE_CLOSED')
  return database
}

function parseWorkerData(value: unknown): Required<WorkerData> {
  if (!isRecord(value) || typeof value.path !== 'string') throw new Error('invalid knowledge worker data')
  const maxSources = value.maxSources === undefined ? DEFAULT_MAX_SOURCES : positiveInteger(value.maxSources, MAX_CHUNKS)
  if (value.forceLexical !== undefined && typeof value.forceLexical !== 'boolean') throw new Error('invalid knowledge worker data')
  return {path: value.path, maxSources, forceLexical: value.forceLexical === true}
}

function parseRequest(value: unknown): Request | undefined {
  if (!isRecord(value) || value.kind !== 'request' || !positiveInteger(value.request_id, Number.MAX_SAFE_INTEGER) || typeof value.operation !== 'string') return undefined
  return value as Request
}

function codeFor(error: unknown): StoreCode {
  return error instanceof StoreError ? error.code : 'STORE_WRITE_FAILED'
}

function screenContent(value: string): string {
  if (content.scrub('knowledge', value).kind !== 'clean') throw new StoreError('STORE_SENSITIVE_CONTENT_REJECTED')
  if (paths.scrubText('knowledge', value).kind !== 'clean') throw new StoreError('STORE_SENSITIVE_PATH_DENIED')
  return value
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new StoreError('STORE_INVALID_INPUT')
  return value
}

function boundedCodePoints(value: unknown, max: number): string {
  const text = boundedString(value, max * 2)
  if ([...text].length > max) throw new StoreError('STORE_INVALID_INPUT')
  return text
}

function nonnegativeInteger(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new StoreError('STORE_INVALID_INPUT')
  return value
}

function positiveInteger(value: unknown, max: number): number {
  const integer = nonnegativeInteger(value, max)
  if (integer === 0) throw new StoreError('STORE_INVALID_INPUT')
  return integer
}

function numericVector(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096) throw new StoreError('STORE_INVALID_INPUT')
  const vector = value.map(item => {
    if (typeof item !== 'number' || !Number.isFinite(item)) throw new StoreError('STORE_INVALID_INPUT')
    const float = Math.fround(item)
    if (!Number.isFinite(float)) throw new StoreError('STORE_INVALID_INPUT')
    return float
  })
  if (!vector.some(item => item !== 0)) throw new StoreError('STORE_INVALID_INPUT')
  return vector
}

function vectorBlob(vector: readonly number[]): Buffer {
  const blob = Buffer.allocUnsafe(vector.length * 4)
  vector.forEach((value, index) => blob.writeFloatLE(value, index * 4))
  return blob
}

function blobVector(value: string | number | Uint8Array | null, dims: number): readonly number[] {
  if (!(value instanceof Uint8Array) || value.byteLength !== dims * 4) throw new StoreError('STORE_READ_FAILED')
  const blob = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  const vector = Array.from({length: dims}, (_item, index) => blob.readFloatLE(index * 4))
  if (!vector.every(Number.isFinite)) throw new StoreError('STORE_READ_FAILED')
  return vector
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  return leftNorm === 0 || rightNorm === 0 ? -1 : dot / Math.sqrt(leftNorm * rightNorm)
}

function safeFtsQuery(query: string): string {
  return lexicalTerms(query).map(token => `"${token.replaceAll('"', '""')}"`).join(' ')
}

function lexicalTerms(query: string): readonly string[] {
  return [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 24)
}

function lexicalCandidates(opened: DatabaseSync, query: string): readonly Row[] {
  const terms = lexicalTerms(query)
  if (terms.length === 0) return []
  if (ftsAvailable) {
    return opened.prepare(`
      SELECT c.id, c.source_id, c.content_digest, s.title, c.heading_path, c.text
      FROM chunks_fts f JOIN chunks c ON c.id = f.chunk_id JOIN sources s ON s.id = c.source_id
      WHERE chunks_fts MATCH ?
      ORDER BY bm25(chunks_fts), f.chunk_id ASC LIMIT 50
    `).all(safeFtsQuery(query)) as Row[]
  }
  const clauses = terms.map(() => '(c.text LIKE ? ESCAPE \'\\\' OR c.heading_path LIKE ? ESCAPE \'\\\')').join(' AND ')
  const values = terms.flatMap(term => {
    const pattern = `%${term.replace(/[\\%_]/gu, character => `\\${character}`)}%`
    return [pattern, pattern]
  })
  return opened.prepare(`
    SELECT c.id, c.source_id, c.content_digest, s.title, c.heading_path, c.text
    FROM chunks c JOIN sources s ON s.id = c.source_id
    WHERE ${clauses}
    ORDER BY c.source_id ASC, c.id ASC LIMIT 50
  `).all(...values) as Row[]
}

function contentDigest(title: string, heading: string, text: string): string {
  return createHash('sha256').update(JSON.stringify([title, heading, text])).digest('hex')
}

function locatorDigest(sourceId: string, chunkId: string): string {
  return createHash('sha256').update(`${sourceId}:${chunkId}`).digest('hex').slice(0, 12)
}

function parseLocator(locator: string): {readonly sourceId: string; readonly chunkId: string; readonly digest: string} | undefined {
  try {
    const url = new URL(locator)
    const chunkId = url.pathname.slice(1)
    const digest = url.searchParams.get('d')
    if (url.protocol !== 'knowledge:' || url.username !== '' || url.password !== '' || url.port !== '' || !url.hostname || !chunkId || digest === null) return undefined
    return {sourceId: url.hostname, chunkId, digest}
  } catch {
    return undefined
  }
}

function textValue(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new StoreError('STORE_READ_FAILED')
  return value
}

function numberValue(row: Row, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new StoreError('STORE_READ_FAILED')
  return value
}

function truncateCodePoints(value: string, max: number): string {
  return [...value].slice(0, max).join('')
}

function secureSidecar(databasePath: string, suffix: '-wal' | '-shm'): void {
  const path = `${databasePath}${suffix}`
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isFile() || !ownedByCurrentUser(info.uid)) throw new StoreError('STORE_WRITE_FAILED')
    // SQLite creates these with the process umask; they live in the already-admitted private parent.
    // Tightening their mode prevents a later reopen from leaving document bytes world-readable.
    chmodSync(path, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function ownedByCurrentUser(uid: number): boolean {
  return process.platform === 'win32' || typeof process.getuid !== 'function' || uid === process.getuid()
}

function redactOutput(value: string): string {
  let result = ''
  let offset = 0
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'`()\[\]{},;!?]+/giu)) {
    const index = match.index
    if (index === undefined) continue
    result += redactPathSpans(value.slice(offset, index))
    const token = match[0]
    result += safeOutputUrl(token) ? token : redactPathSpans(token)
    offset = index + token.length
  }
  return result + redactPathSpans(value.slice(offset))
}

function safeOutputUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === '' && url.password === ''
      && content.scrub('knowledge-output-url', value).kind === 'clean'
  } catch {
    return false
  }
}

function redactPathSpans(value: string): string {
  return value.replace(/(?:\\\\[^\s<>"'`()\[\]{},;!?]+|[A-Za-z]:[\\/][^\s<>"'`()\[\]{},;!?]+|\/(?!\/)[^\s<>"'`()\[\]{},;!?]+)/gu, '[path]')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(): never { throw new StoreError('STORE_INVALID_INPUT') }
