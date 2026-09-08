import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {isMainThread, parentPort, workerData} from 'node:worker_threads'
import {z} from 'zod'
import {canonicalJson} from '../canonical-json.js'
import {memoryItemSchema} from '../memory.js'
import {PrivateDatabaseError, preparePrivateDatabasePath, secureSidecar} from '../private-database.js'
import {
  BLACKBOARD_BATCH_BYTES, BlackboardStoreError, blackboardBatchSchema, blackboardOptionsSchema,
  blackboardReceiptSchema, blackboardSnapshotSchema,
  type BlackboardBatch, type BlackboardReceipt, type BlackboardSnapshot,
} from './blackboard-store.js'

if (isMainThread || parentPort === null) throw new Error('blackboard storage requires its worker')
const port = parentPort
const options = blackboardOptionsSchema.parse(workerData)
const scope = options.conversationId
const allowedChannels = new Set(options.channels)
const requestSchema = z.object({
  id: z.number().int().positive(), operation: z.enum(['open', 'load', 'commit', 'close']),
  batch: blackboardBatchSchema.optional(),
}).strict()
type Row = Record<string, unknown>
let database: DatabaseSync | undefined

port.on('message', value => {
  const parsed = requestSchema.safeParse(value)
  if (!parsed.success) { port.postMessage({id: 0, ok: false, error: 'invalid_input'}); return }
  const request = parsed.data
  try {
    let result: unknown
    switch (request.operation) {
      case 'open': result = open(); break
      case 'load': result = transaction(() => { maintain(now()); return snapshot() }); break
      case 'commit':
        if (request.batch === undefined) throw new BlackboardStoreError('invalid_input')
        result = transaction(() => commit(request.batch!)); break
      case 'close': database?.close(); database = undefined; result = null; break
    }
    port.postMessage({id: request.id, ok: true, result})
  } catch (error) {
    if (request.operation === 'open') { try { database?.close() } catch { /* failed open */ } database = undefined }
    const code = error instanceof BlackboardStoreError ? error.code
      : error instanceof PrivateDatabaseError && error.code === 'STORE_INVALID_INPUT' ? 'invalid_input' : 'storage'
    port.postMessage({id: request.id, ok: false, error: code})
  }
  if (request.operation === 'close') port.close()
})

function db(): DatabaseSync {
  if (database === undefined) throw new BlackboardStoreError('closed')
  return database
}
function rows(sql: string, ...params: (string | number)[]): Row[] { return db().prepare(sql).all(...params) }
function row(sql: string, ...params: (string | number)[]): Row {
  const result = db().prepare(sql).get(...params)
  if (result === undefined) throw new BlackboardStoreError('storage')
  return result
}
function number(record: Row, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new BlackboardStoreError('storage')
  return value
}
function string(record: Row, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new BlackboardStoreError('storage')
  return value
}
function transaction<T>(operation: () => T): T {
  db().exec('BEGIN IMMEDIATE')
  try { const result = operation(); db().exec('COMMIT'); return result }
  catch (error) { try { db().exec('ROLLBACK') } catch { /* preserve the original failure */ } throw error }
}
function now(): number {
  const value = Math.max(Date.now(), number(row('SELECT last_now FROM meta'), 'last_now'))
  db().prepare('UPDATE meta SET last_now=?').run(value)
  return value
}
function state(): Row {
  const result = db().prepare('SELECT * FROM conversations WHERE id=?').get(scope)
  if (result === undefined) throw new BlackboardStoreError('generation')
  return result
}

function open(): BlackboardSnapshot {
  if (database !== undefined) throw new BlackboardStoreError('busy')
  const path = preparePrivateDatabasePath(options.path)
  secureSidecar(path, '-wal'); secureSidecar(path, '-shm')
  database = new DatabaseSync(path, {allowExtension: false, enableForeignKeyConstraints: true})
  db().exec('PRAGMA busy_timeout=1000')
  transaction(() => {
    const version = number(row('PRAGMA user_version'), 'user_version')
    if (version !== 0 && version !== 1) throw new BlackboardStoreError('schema')
    if (version === 0) {
      if (rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length > 0) {
        throw new BlackboardStoreError('schema')
      }
      db().exec(`
        CREATE TABLE meta(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK(generation>=0), last_now INTEGER NOT NULL CHECK(last_now>=0));
        CREATE TABLE clocks(channel TEXT PRIMARY KEY, highwater INTEGER NOT NULL CHECK(highwater>=0));
        CREATE TABLE conversations(id TEXT PRIMARY KEY, generation INTEGER NOT NULL, revision INTEGER NOT NULL,
          digest TEXT, receipt TEXT, updated INTEGER NOT NULL);
        CREATE TABLE channels(scope TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          channel TEXT NOT NULL REFERENCES clocks(channel), retention INTEGER NOT NULL DEFAULT 0,
          summary TEXT, through_seq INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL DEFAULT 0,
          summary_bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,channel));
        CREATE TABLE records(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL, channel TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq>0),
          recorded INTEGER NOT NULL, bytes INTEGER NOT NULL, item TEXT NOT NULL,
          UNIQUE(scope,channel,seq), FOREIGN KEY(scope,channel) REFERENCES channels(scope,channel) ON DELETE CASCADE);
        CREATE INDEX records_retention ON records(recorded);
        PRAGMA user_version=1;
      `)
      db().prepare('INSERT INTO meta VALUES(1,?,0,0)').run(options.ownerId)
    }
    if (number(row('SELECT COUNT(*) AS n FROM meta'), 'n') !== 1
      || number(row('SELECT id FROM meta'), 'id') !== 1) throw new BlackboardStoreError('storage')
    if (string(row('SELECT owner FROM meta'), 'owner') !== options.ownerId) throw new BlackboardStoreError('owner')
    if (rows('SELECT 1 FROM records JOIN clocks ON records.channel=clocks.channel WHERE records.seq>clocks.highwater LIMIT 1').length > 0) {
      throw new BlackboardStoreError('storage')
    }
  })
  db().exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=16777216')
  secureSidecar(path, '-wal'); secureSidecar(path, '-shm')
  return transaction(() => {
    const at = now()
    maintain(at)
    if (rows('SELECT id FROM conversations WHERE id=?', scope).length === 0) {
      // ponytail: bounded host namespaces; expand only with an explicit history-management policy.
      if (number(row('SELECT COUNT(*) AS n FROM conversations'), 'n') >= 128) throw new BlackboardStoreError('capacity')
      db().exec('UPDATE meta SET generation=generation+1')
      db().prepare('INSERT INTO conversations VALUES(?,?,0,NULL,NULL,?)').run(scope, number(row('SELECT generation FROM meta'), 'generation'), at)
    }
    for (const channel of options.channels) {
      db().prepare('INSERT OR IGNORE INTO clocks VALUES(?,0)').run(channel)
      db().prepare('INSERT OR IGNORE INTO channels(scope,channel) VALUES(?,?)').run(scope, channel)
    }
    if (number(row('SELECT COUNT(*) AS n FROM clocks'), 'n') > 128) throw new BlackboardStoreError('capacity')
    db().prepare('UPDATE conversations SET updated=? WHERE id=?').run(at, scope)
    return snapshot()
  })
}

function commit(batch: BlackboardBatch): BlackboardReceipt {
  const current = state()
  const digest = createHash('sha256').update(canonicalJson(batch)).digest('hex')
  const revision = number(current, 'revision')
  // Check the receipt before generation: a retried clear still carries its original generation.
  if (batch.revision === revision) {
    if (current.digest !== digest || typeof current.receipt !== 'string') throw new BlackboardStoreError('revision_conflict')
    return blackboardReceiptSchema.parse(JSON.parse(current.receipt))
  }
  if (batch.revision < revision) throw new BlackboardStoreError('revision_conflict')
  if (batch.revision !== revision + 1) throw new BlackboardStoreError('revision_gap')
  if (batch.generation !== number(current, 'generation')) throw new BlackboardStoreError('generation')
  const at = now()
  const firstNewOrdinal = number(row('SELECT COALESCE(MAX(ordinal),0) AS n FROM records'), 'n') + 1
  const appended = batch.mutations.filter(mutation => mutation.kind === 'append')
  if (appended.length > options.retention.maxItems
    || Buffer.byteLength(canonicalJson(batch), 'utf8') > BLACKBOARD_BATCH_BYTES
    || appended.reduce((bytes, mutation) => bytes + Buffer.byteLength(canonicalJson(mutation.item), 'utf8'), 0) > options.retention.maxBytes) {
    throw new BlackboardStoreError('capacity')
  }
  const affected = new Map<string, {scope: string; channel: string; through: number}>()
  for (const mutation of batch.mutations) {
    if (mutation.kind === 'clear') {
      for (const entry of rows('SELECT channel,COALESCE(MAX(seq),0) AS seq FROM records WHERE scope=? GROUP BY channel', scope)) {
        prune(scope, string(entry, 'channel'), number(entry, 'seq'), affected)
      }
      db().prepare('UPDATE channels SET summary=NULL,through_seq=0,expires=0,summary_bytes=0 WHERE scope=?').run(scope)
      db().exec('UPDATE meta SET generation=generation+1')
      db().prepare('UPDATE conversations SET generation=(SELECT generation FROM meta) WHERE id=?').run(scope)
      continue
    }
    const channel = mutation.kind === 'append' ? mutation.item.channel : mutation.channel
    if (!allowedChannels.has(channel)) throw new BlackboardStoreError('invalid_input')
    if (mutation.kind === 'append') {
      const highwater = number(row('SELECT highwater FROM clocks WHERE channel=?', channel), 'highwater')
      if (mutation.item.seq !== highwater + 1) throw new BlackboardStoreError('sequence')
      const json = canonicalJson(mutation.item)
      const bytes = Buffer.byteLength(json, 'utf8')
      if (bytes > Math.min(options.retention.maxBytes, 256 * 1024)) throw new BlackboardStoreError('capacity')
      db().prepare('INSERT INTO records(scope,channel,seq,recorded,bytes,item) VALUES(?,?,?,?,?,?)')
        .run(scope, channel, mutation.item.seq, at, bytes, json)
      db().prepare('UPDATE clocks SET highwater=? WHERE channel=?').run(mutation.item.seq, channel)
    } else {
      if (Buffer.byteLength(mutation.text, 'utf8') > options.retention.maxBytes) throw new BlackboardStoreError('capacity')
      const existing = row('SELECT retention,through_seq FROM channels WHERE scope=? AND channel=?', scope, channel)
      if (mutation.retentionRevision !== number(existing, 'retention') || mutation.throughSequence < number(existing, 'through_seq')) {
        throw new BlackboardStoreError('retention')
      }
      if (rows('SELECT seq FROM records WHERE scope=? AND channel=? AND seq=?', scope, channel, mutation.throughSequence).length === 0) {
        throw new BlackboardStoreError('sequence')
      }
      const oldest = number(row('SELECT MIN(recorded) AS at FROM records WHERE scope=? AND channel=? AND seq<=?', scope, channel, mutation.throughSequence), 'at')
      db().prepare('UPDATE channels SET summary=?,through_seq=?,expires=?,summary_bytes=? WHERE scope=? AND channel=?')
        .run(mutation.text, mutation.throughSequence, oldest + options.retention.ttlMs, Buffer.byteLength(mutation.text, 'utf8'), scope, channel)
    }
  }
  maintain(at, affected, appended.length === 0 ? Infinity : firstNewOrdinal)
  const receipt: BlackboardReceipt = {
    generation: number(state(), 'generation'), revision: batch.revision,
    retention: [...affected.values()].filter(entry => entry.scope === scope).map(entry => ({
      channel: entry.channel, prunedThroughSequence: entry.through,
      retentionRevision: number(row('SELECT retention FROM channels WHERE scope=? AND channel=?', scope, entry.channel), 'retention'),
    })),
  }
  db().prepare('UPDATE conversations SET revision=?,digest=?,receipt=?,updated=? WHERE id=?')
    .run(batch.revision, digest, JSON.stringify(receipt), at, scope)
  return receipt
}

type Pruned = Map<string, {scope: string; channel: string; through: number}>
function prune(conversation: string, channel: string, through: number, affected: Pruned): void {
  const changed = db().prepare('DELETE FROM records WHERE scope=? AND channel=? AND seq<=?').run(conversation, channel, through).changes
  if (changed === 0) return
  const key = `${conversation}\0${channel}`
  db().prepare('UPDATE channels SET retention=retention+?,summary=NULL,through_seq=0,expires=0,summary_bytes=0 WHERE scope=? AND channel=?')
    .run(affected.has(key) ? 0 : 1, conversation, channel)
  affected.set(key, {scope: conversation, channel, through: Math.max(affected.get(key)?.through ?? 0, through)})
}

function maintain(at: number, affected: Pruned = new Map(), protectedOrdinal = Infinity): void {
  // Validate before using metadata to delete records under a byte budget.
  for (const entry of rows(`SELECT channels.*,clocks.highwater,records.seq AS summary_source
    FROM channels JOIN clocks ON channels.channel=clocks.channel
    LEFT JOIN records ON records.scope=channels.scope AND records.channel=channels.channel AND records.seq=channels.through_seq
    WHERE channels.scope=?`, scope)) {
    if (entry.summary === null) {
      if (number(entry, 'summary_bytes') !== 0 || number(entry, 'through_seq') !== 0 || number(entry, 'expires') !== 0) {
        throw new BlackboardStoreError('storage')
      }
    } else if (Buffer.byteLength(string(entry, 'summary'), 'utf8') !== number(entry, 'summary_bytes')
      || number(entry, 'through_seq') === 0 || number(entry, 'through_seq') > number(entry, 'highwater')
      || number(entry, 'expires') === 0 || entry.summary_source !== entry.through_seq) {
      throw new BlackboardStoreError('storage')
    }
  }
  const cutoff = at - options.retention.ttlMs
  for (const entry of rows('SELECT scope,channel,MAX(seq) AS seq FROM records WHERE scope=? AND recorded<=? GROUP BY scope,channel', scope, cutoff)) {
    prune(string(entry, 'scope'), string(entry, 'channel'), number(entry, 'seq'), affected)
  }
  for (const entry of rows('SELECT channel FROM channels WHERE scope=? AND summary IS NOT NULL AND expires<=?', scope, at)) {
    const channel = string(entry, 'channel')
    const key = `${scope}\0${channel}`
    db().prepare('UPDATE channels SET retention=retention+?,summary=NULL,through_seq=0,expires=0,summary_bytes=0 WHERE scope=? AND channel=?')
      .run(affected.has(key) ? 0 : 1, scope, channel)
    if (!affected.has(key)) affected.set(key, {scope, channel, through: 0})
  }
  let count = number(row('SELECT COUNT(*) AS n FROM records WHERE scope=?', scope), 'n')
  let bytes = number(row('SELECT COALESCE(SUM(bytes),0) AS n FROM records WHERE scope=?', scope), 'n')
    + number(row('SELECT COALESCE(SUM(summary_bytes),0) AS n FROM channels WHERE scope=?', scope), 'n')
  const selected = new Map<string, {scope: string; channel: string; through: number}>()
  for (const entry of rows('SELECT scope,channel,seq,ordinal,bytes FROM records WHERE scope=? ORDER BY ordinal', scope)) {
    if (count <= options.retention.maxItems && bytes <= options.retention.maxBytes) break
    if (number(entry, 'ordinal') >= protectedOrdinal) throw new BlackboardStoreError('capacity')
    const conversation = string(entry, 'scope'), channel = string(entry, 'channel')
    const key = `${conversation}\0${channel}`
    if (!selected.has(key)) bytes -= number(row('SELECT summary_bytes FROM channels WHERE scope=? AND channel=?', conversation, channel), 'summary_bytes')
    selected.set(key, {scope: conversation, channel, through: number(entry, 'seq')})
    count -= 1; bytes -= number(entry, 'bytes')
  }
  for (const entry of selected.values()) prune(entry.scope, entry.channel, entry.through, affected)
  if (count > options.retention.maxItems || bytes > options.retention.maxBytes) throw new BlackboardStoreError('capacity')
  // A scope's policy never evicts another scope. The owner-wide hard ceiling rejects new writes.
  const ownerCount = number(row('SELECT COUNT(*) AS n FROM records'), 'n')
  const ownerBytes = number(row('SELECT COALESCE(SUM(bytes),0) AS n FROM records'), 'n')
    + number(row('SELECT COALESCE(SUM(summary_bytes),0) AS n FROM channels'), 'n')
  if (ownerCount > 10_000 || ownerBytes > 64 * 1024 * 1024) throw new BlackboardStoreError('capacity')
}

function snapshot(): BlackboardSnapshot {
  const current = state()
  return blackboardSnapshotSchema.parse({
    generation: number(current, 'generation'), revision: number(current, 'revision'),
    channels: rows('SELECT clocks.channel,clocks.highwater,channels.retention,channels.summary,channels.through_seq,channels.expires FROM channels JOIN clocks ON channels.channel=clocks.channel WHERE channels.scope=? ORDER BY clocks.channel', scope)
      .map(entry => {
        const channel = string(entry, 'channel')
        const highWater = number(entry, 'highwater')
        const items = rows('SELECT item,seq,bytes,recorded,ordinal FROM records WHERE scope=? AND channel=? ORDER BY seq', scope, channel)
          .map(record => {
            const json = string(record, 'item')
            if (Buffer.byteLength(json, 'utf8') !== number(record, 'bytes') || number(record, 'bytes') > 256 * 1024) {
              throw new BlackboardStoreError('storage')
            }
            const item = memoryItemSchema.parse(JSON.parse(json))
            if (item.channel !== channel || item.seq !== number(record, 'seq') || item.seq > highWater || canonicalJson(item) !== json) {
              throw new BlackboardStoreError('storage')
            }
            return {item, recordedAtMs: number(record, 'recorded'), ordinal: number(record, 'ordinal')}
          })
        if (entry.summary !== null && !items.some(record => record.item.seq === number(entry, 'through_seq'))) {
          throw new BlackboardStoreError('storage')
        }
        return {
          name: channel, highWater, retentionRevision: number(entry, 'retention'),
          summary: entry.summary === null ? null : {text: string(entry, 'summary'), throughSequence: number(entry, 'through_seq'), expiresAtMs: number(entry, 'expires')},
          items,
        }
      }),
  })
}
