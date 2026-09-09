import assert from 'node:assert/strict'
import {chmod, mkdtemp, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {Worker} from 'node:worker_threads'
import {BlackboardStore} from '../src/memory/blackboard-store.js'
import {memoryItemSchema} from '../src/memory.js'
import {canonicalJson} from '../src/canonical-json.js'
import {secureSidecar} from '../src/private-database.js'

const item = (seq: number, text: string) => memoryItemSchema.parse({
  channel: 'conversation', seq, ts: 1, trust: 'trusted_user', priority: 100, content: {text},
})

test('private SQLite sidecars secure the opened file without following symlinks', {skip: process.platform === 'win32'}, async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-blackboard-'))
  try {
    const database = join(directory, 'board.sqlite')
    const target = join(directory, 'unrelated.txt')
    await writeFile(target, 'unchanged')
    await chmod(target, 0o640)
    await symlink(target, `${database}-wal`)
    assert.throws(() => secureSidecar(database, '-wal'))
    assert.equal((await stat(target)).mode & 0o777, 0o640)
    await writeFile(`${database}-shm`, 'ordinary sidecar')
    await chmod(`${database}-shm`, 0o644)
    secureSidecar(database, '-shm')
    assert.equal((await stat(`${database}-shm`)).mode & 0o777, 0o600)
  } finally { await rm(directory, {recursive: true, force: true}) }
})

test('blackboard commits, reopens and retries a clear without reusing a reference', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-blackboard-'))
  const options = {path: join(directory, 'memory.sqlite'), ownerId: 'local', conversationId: 'one', channels: ['conversation']}
  let store = new BlackboardStore(options)
  try {
    const initial = await store.open()
    const batch = {generation: initial.generation, revision: 1, mutations: [{kind: 'append' as const, item: item(1, 'project milestone')}]}
    const receipt = await store.commit(batch)
    assert.deepEqual(await store.commit(batch), receipt)
    await assert.rejects(store.commit({...batch, mutations: [{kind: 'append', item: item(1, 'changed evidence')}]}), /conflict/u)
    await store.close()
    store = new BlackboardStore(options)
    const recovered = await store.open()
    assert.deepEqual(await store.commit(batch), receipt)
    assert.equal(recovered.channels[0]?.items[0]?.item.content.text, 'project milestone')
    assert.equal(recovered.channels[0]?.highWater, 1)
    assert.equal(recovered.revision, 1)
    const clear = {generation: recovered.generation, revision: 2, mutations: [{kind: 'clear' as const}]}
    const cleared = await store.commit(clear)
    await store.close()
    store = new BlackboardStore(options)
    await store.open()
    assert.deepEqual(await store.commit(clear), cleared)
    await assert.rejects(store.commit({generation: recovered.generation, revision: 3, mutations: [
      {kind: 'append', item: item(2, 'late forgotten work')},
    ]}), /generation/u)
    await store.commit({generation: cleared.generation, revision: 3, mutations: [{kind: 'append', item: item(2, 'new turn')}]})
    assert.deepEqual((await store.load()).channels[0]?.items.map(row => row.item.content.text), ['new turn'])
  } finally {
    await store.close()
    await rm(directory, {recursive: true, force: true})
  }
})

test('wall-clock retention expires both records and the summaries that depend on them', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-blackboard-'))
  const store = new BlackboardStore({
    path: join(directory, 'memory.sqlite'), ownerId: 'local', conversationId: 'one', channels: ['conversation'],
    retention: {ttlMs: 100},
  })
  try {
    const {generation} = await store.open()
    await store.commit({generation, revision: 1, mutations: [
      {kind: 'append', item: item(1, 'expires')},
      {kind: 'summary', channel: 'conversation', text: 'expires too', throughSequence: 1, retentionRevision: 0},
    ]})
    await delay(150)
    const snapshot = await store.load()
    assert.deepEqual(snapshot.channels[0]?.items, [])
    assert.equal(snapshot.channels[0]?.summary, null)
    assert.equal(snapshot.channels[0]?.highWater, 1)
    assert.equal(snapshot.channels[0]?.retentionRevision, 1)
  } finally { await store.close(); await rm(directory, {recursive: true, force: true}) }
})

test('a committed record survives abrupt process death with its replay receipt', {timeout: 10_000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-blackboard-'))
  const options = {path: join(directory, 'memory.sqlite'), ownerId: 'local', conversationId: 'one', channels: ['conversation']}
  const writer = join(directory, 'writer.mjs')
  await writeFile(writer, `
    import {BlackboardStore} from ${JSON.stringify(new URL('../src/memory/blackboard-store.js', import.meta.url).href)};
    const store = new BlackboardStore(${JSON.stringify(options)});
    const {generation} = await store.open();
    await store.commit({generation,revision:1,mutations:[{kind:'append',item:${JSON.stringify(item(1, 'durable progress'))}}]});
    console.log('COMMITTED');
    setInterval(() => {},1000);
  `)
  const child = spawn(process.execPath, [writer], {stdio: ['ignore', 'pipe', 'pipe']})
  const exited = once(child, 'exit')
  t.after(async () => { child.kill('SIGKILL'); await exited; await rm(directory, {recursive: true, force: true}) })
  child.stderr.resume()
  await new Promise<void>((resolve, reject) => {
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('COMMITTED')) resolve() })
    child.on('error', reject)
    child.on('exit', () => reject(new Error('writer exited before commit')))
  })
  child.kill('SIGKILL')
  await exited
  const store = new BlackboardStore(options)
  try {
    const snapshot = await store.open()
    assert.equal(snapshot.channels[0]?.items[0]?.item.content.text, 'durable progress')
    const receipt = await store.commit({generation: snapshot.generation, revision: 1, mutations: [
      {kind: 'append', item: item(1, 'durable progress')},
    ]})
    assert.equal(receipt.revision, 1)
    assert.equal((await store.load()).channels[0]?.items.length, 1)
  } finally { await store.close() }
})

test('failed batches roll back and bounded retention invalidates dependent summaries', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-blackboard-'))
  const store = new BlackboardStore({
    path: join(directory, 'memory.sqlite'), ownerId: 'local', conversationId: 'one', channels: ['conversation'],
    retention: {maxItems: 2},
  })
  try {
    const {generation} = await store.open()
    await assert.rejects(store.commit({generation, revision: 1, mutations: [
      {kind: 'append', item: item(1, 'must roll back')},
      {kind: 'append', item: item(3, 'sequence gap')},
    ]}), /sequence/u)
    assert.equal((await store.load()).channels[0]?.highWater, 0)
    await store.commit({generation, revision: 1, mutations: [
      {kind: 'append', item: item(1, 'old')}, {kind: 'append', item: item(2, 'kept')},
      {kind: 'summary', channel: 'conversation', text: 'old and kept', throughSequence: 2, retentionRevision: 0},
    ]})
    const receipt = await store.commit({generation, revision: 2, mutations: [{kind: 'append', item: item(3, 'new')}]})
    assert.equal(receipt.retention[0]?.prunedThroughSequence, 1)
    const snapshot = await store.load()
    assert.deepEqual(snapshot.channels[0]?.items.map(row => row.item.seq), [2, 3])
    assert.equal(snapshot.channels[0]?.summary, null)
    await assert.rejects(store.commit({generation, revision: 3, mutations: [
      {kind: 'summary', channel: 'conversation', text: 'old returns', throughSequence: 2, retentionRevision: 0},
    ]}), /retention/u)
  } finally {
    await store.close()
    await rm(directory, {recursive: true, force: true})
  }
})

test('scopes share only a monotonic channel clock and reject another database owner', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-blackboard-'))
  const options = {path: join(directory, 'memory.sqlite'), ownerId: 'local', channels: ['conversation']}
  const one = new BlackboardStore({...options, conversationId: 'one', channels: ['conversation', 'private-channel']})
  const two = new BlackboardStore({...options, conversationId: 'two', retention: {maxItems: 1}})
  const reopenedOne = new BlackboardStore({...options, conversationId: 'one'})
  const other = new BlackboardStore({...options, ownerId: 'other', conversationId: 'one'})
  try {
    const {generation} = await one.open()
    await one.commit({generation, revision: 1, mutations: [{kind: 'append', item: item(1, 'private to one')}]})
    await one.close()
    const snapshot = await two.open()
    assert.deepEqual(snapshot.channels.map(channel => channel.name), ['conversation'])
    assert.deepEqual(snapshot.channels[0]?.items, [])
    assert.equal(snapshot.channels[0]?.highWater, 1)
    await two.commit({generation: snapshot.generation, revision: 1, mutations: [{kind: 'append', item: item(2, 'private to two')}]})
    assert.equal((await reopenedOne.open()).channels.find(channel => channel.name === 'conversation')?.items[0]?.item.content.text, 'private to one')
    await assert.rejects(other.open(), /owner/u)
  } finally {
    await Promise.all([one.close(), two.close(), other.close(), reopenedOne.close()])
    await rm(directory, {recursive: true, force: true})
  }
})

test('failed open releases its worker even when the caller only catches the error', {timeout: 5000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-blackboard-'))
  const writer = join(directory, 'failed-open.mjs')
  await writeFile(writer, `
    import {BlackboardStore} from ${JSON.stringify(new URL('../src/memory/blackboard-store.js', import.meta.url).href)};
    const store = new BlackboardStore({path:'not-absolute.sqlite',ownerId:'local',conversationId:'one',channels:['conversation']});
    try { await store.open(); process.exitCode=1; }
    catch(error) { if(error.code!=='invalid_input') process.exitCode=1; }
  `)
  const child = spawn(process.execPath, [writer], {stdio: 'ignore'})
  const exited = once(child, 'exit')
  t.after(async () => { child.kill('SIGKILL'); await exited; await rm(directory, {recursive: true, force: true}) })
  assert.deepEqual(await exited, [0, null])
})

test('recovery refuses a record whose identity or highwater was corrupted on disk', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-blackboard-'))
  try {
    const wrongIdentity = canonicalJson({...item(1, 'known fact'), channel: 'other'})
    for (const [index, damage] of [
      {sql: 'UPDATE records SET item=?,bytes=?', params: [wrongIdentity, Buffer.byteLength(wrongIdentity)]},
      {sql: 'UPDATE clocks SET highwater=0', params: []},
      {sql: 'UPDATE channels SET summary_bytes=0', params: []},
      {sql: 'UPDATE channels SET summary_bytes=1000000', params: []},
      {sql: 'UPDATE channels SET expires=0', params: []},
      {sql: 'DELETE FROM records', params: []},
      {sql: "INSERT INTO meta VALUES(2,'local',0,0)", params: []},
    ].entries()) {
      const options = {path: join(directory, `memory-${index}.sqlite`), ownerId: 'local', conversationId: 'one', channels: ['conversation']}
      const original = new BlackboardStore(options)
      try {
        const {generation} = await original.open()
        await original.commit({generation, revision: 1, mutations: [
          {kind: 'append', item: item(1, 'known fact')},
          {kind: 'summary', channel: 'conversation', text: 'known fact summary', throughSequence: 1, retentionRevision: 0},
        ]})
      } finally { await original.close() }
      const corruptor = new Worker(`
        const {parentPort,workerData}=require('node:worker_threads');
        const {DatabaseSync}=require('node:sqlite');
        const db=new DatabaseSync(workerData.path);
        db.exec('PRAGMA ignore_check_constraints=ON');
        db.prepare(workerData.sql).run(...workerData.params); db.close(); parentPort.postMessage('done');
      `, {eval: true, workerData: {path: options.path, ...damage}})
      try { await once(corruptor, 'message') } finally { await corruptor.terminate() }
      const recovered = new BlackboardStore(options)
      try { await assert.rejects(recovered.open(), /storage/u) } finally { await recovered.close() }
    }
  } finally { await rm(directory, {recursive: true, force: true}) }
})

test('close drains an admitted commit, is idempotent and releases the database for immediate reopen', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-blackboard-'))
  const options = {path: join(directory, 'memory.sqlite'), ownerId: 'local', conversationId: 'one', channels: ['conversation']}
  let store = new BlackboardStore(options)
  try {
    const {generation} = await store.open()
    const batch = {generation, revision: 1, mutations: [{kind: 'append' as const, item: item(1, 'closing checkpoint')}]}
    const pending = store.commit(batch)
    const closing = store.close()
    assert.equal(store.close(), closing)
    await assert.rejects(store.load(), /closed/u)
    const [receipt] = await Promise.all([pending, closing])
    store = new BlackboardStore(options)
    const snapshot = await store.open()
    assert.equal(snapshot.channels[0]?.items[0]?.item.content.text, 'closing checkpoint')
    assert.deepEqual(await store.commit(batch), receipt)
    await store.commit({generation, revision: 2, mutations: [{kind: 'append', item: item(2, 'after reopen')}]})
  } finally { await store.close(); await rm(directory, {recursive: true, force: true}) }
})

test('summary-only writes report cross-channel capacity pruning within their own scope', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-blackboard-'))
  const store = new BlackboardStore({path: join(directory, 'memory.sqlite'), ownerId: 'local',
    conversationId: 'one', channels: ['conversation', 'other'], retention: {maxBytes: 512}})
  try {
    const {generation} = await store.open()
    await store.commit({generation, revision: 1, mutations: [
      {kind: 'append', item: {...item(1, 'x'.repeat(100)), channel: 'other'}},
      {kind: 'append', item: item(1, 'y'.repeat(100))},
    ]})
    const receipt = await store.commit({generation, revision: 2, mutations: [
      {kind: 'summary', channel: 'conversation', text: 's'.repeat(100), throughSequence: 1, retentionRevision: 0},
    ]})
    assert.deepEqual(receipt.retention, [{channel: 'other', retentionRevision: 1, prunedThroughSequence: 1}])
    assert.equal((await store.load()).channels.find(channel => channel.name === 'conversation')?.summary?.text, 's'.repeat(100))
  } finally { await store.close(); await rm(directory, {recursive: true, force: true}) }
})

test('extending raw-record retention does not extend an existing summary or hide its invalidation', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-blackboard-'))
  const options = {path: join(directory, 'memory.sqlite'), ownerId: 'local', conversationId: 'one', channels: ['conversation']}
  let store = new BlackboardStore({...options, retention: {ttlMs: 1000}})
  try {
    const {generation} = await store.open()
    await store.commit({generation, revision: 1, mutations: [
      {kind: 'append', item: item(1, 'retained source')},
      {kind: 'summary', channel: 'conversation', text: 'short-lived summary', throughSequence: 1, retentionRevision: 0},
    ]})
    const expires = (await store.load()).channels[0]!.summary!.expiresAtMs
    await store.close()
    store = new BlackboardStore({...options, retention: {ttlMs: 100_000}})
    await store.open()
    await delay(Math.max(0, expires - Date.now() + 20))
    const receipt = await store.commit({generation, revision: 2, mutations: []})
    assert.deepEqual(receipt.retention, [{channel: 'conversation', retentionRevision: 1, prunedThroughSequence: 0}])
    const snapshot = await store.load()
    assert.equal(snapshot.channels[0]?.summary, null)
    assert.equal(snapshot.channels[0]?.items.length, 1)
  } finally { await store.close(); await rm(directory, {recursive: true, force: true}) }
})

test('byte retention preserves a fitting new record and rejects oversized writes atomically', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-blackboard-'))
  const store = new BlackboardStore({
    path: join(directory, 'memory.sqlite'), ownerId: 'local', conversationId: 'one', channels: ['conversation'],
    retention: {maxBytes: 512},
  })
  try {
    const {generation} = await store.open()
    await store.commit({generation, revision: 1, mutations: [{kind: 'append', item: item(1, 'a'.repeat(350))}]})
    const receipt = await store.commit({generation, revision: 2, mutations: [{kind: 'append', item: item(2, 'b'.repeat(350))}]})
    assert.equal(receipt.retention[0]?.prunedThroughSequence, 1)
    await assert.rejects(store.commit({generation, revision: 3, mutations: [{kind: 'append', item: item(3, 'c'.repeat(1000))}]}), /capacity/u)
    const snapshot = await store.load()
    assert.deepEqual(snapshot.channels[0]?.items.map(record => record.item.seq), [2])
    assert.equal(snapshot.channels[0]?.highWater, 2)
    assert.equal(snapshot.revision, 2)
  } finally { await store.close(); await rm(directory, {recursive: true, force: true}) }
})

test('store close budget starts after the in-flight commit receipt', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-board-close-receipt-'))
  const store = new BlackboardStore({path: join(directory, 'board.sqlite'), ownerId: 'local', conversationId: 'close-receipt', channels: ['conversation']})
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock restores the receiver with call/apply.
  const send = Worker.prototype.postMessage
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock restores the receiver with call/apply.
  const terminate = Worker.prototype.terminate
  let release: (() => void) | undefined
  let terminated = 0
  let pending: Promise<unknown> | undefined
  try {
    const initial = await store.open()
    t.mock.method(Worker.prototype, 'postMessage', function(this: Worker, ...args: Parameters<typeof send>) {
      if ((args[0] as {operation?: string}).operation === 'commit') release = () => send.apply(this, args)
      else send.apply(this, args)
    })
    t.mock.method(Worker.prototype, 'terminate', function(this: Worker) { terminated++; return terminate.call(this) })
    t.mock.timers.enable({apis: ['setTimeout']})
    const writing = store.commit({generation: initial.generation, revision: 1, mutations: [{kind: 'append', item: item(1, 'durable receipt')}]})
    pending = Promise.all([writing, store.close()])
    t.mock.timers.tick(401)
    assert.equal(terminated, 0, 'close must not terminate an admitted commit before its RPC deadline')
    t.mock.timers.reset()
    assert.ok(release)
    release()
    release = undefined
    await pending
    assert.equal(terminated, 1)
  } finally {
    t.mock.timers.reset(); release?.(); await pending?.catch(() => undefined)
    await store.close().catch(() => undefined); await rm(directory, {recursive: true, force: true})
  }
})
