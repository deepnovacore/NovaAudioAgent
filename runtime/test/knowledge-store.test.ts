import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test, {type TestContext} from 'node:test'
import {Worker} from 'node:worker_threads'

import {KnowledgeStoreClient, KnowledgeStoreClientError} from '../src/knowledge/store-client.js'
import type {KnowledgeSource} from '../src/knowledge/types.js'

async function settlesWithin<T>(label: string, promise: Promise<T>, milliseconds = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle`)), milliseconds)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function source(id = 'source-a'): KnowledgeSource {
  return {
    id,
    title: 'Runtime notes',
    kind: 'file',
    locator: '/tmp/runtime-notes.md',
    mime: 'text/markdown',
    fingerprint: 'a'.repeat(64),
    bytes: 120,
    created_at: 1,
    updated_at: 1,
    status: 'ready',
  }
}

async function store(t: TestContext, forceLexical = false): Promise<KnowledgeStoreClient> {
  return (await storeWithPath(t, forceLexical)).client
}

async function storeWithPath(t: TestContext, forceLexical = false): Promise<{readonly client: KnowledgeStoreClient; readonly path: string}> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-knowledge-store-'))
  const path = join(directory, 'knowledge.sqlite')
  const client = new KnowledgeStoreClient({path, forceLexical})
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  const opened = await client.open()
  if (forceLexical) assert.deepEqual(opened, {fts: false})
  return {client, path}
}

async function holdWriteLock(path: string): Promise<{readonly release: () => Promise<void>}> {
  const worker = new Worker(new URL('./fixtures/workspace-graph-sqlite-worker.js', import.meta.url), {
    workerData: {mode: 'lock', path},
  })
  await new Promise<void>((resolve, reject) => {
    worker.once('error', reject)
    worker.once('message', message => {
      if ((message as {readonly kind?: unknown}).kind === 'locked') resolve()
      else reject(new Error('fixture did not acquire lock'))
    })
  })
  let released = false
  return {
    release: () => {
      if (released) return Promise.resolve()
      released = true
      return new Promise((resolve, reject) => {
      worker.once('error', reject)
      worker.once('message', message => {
        if ((message as {readonly kind?: unknown}).kind !== 'released') {
          reject(new Error('fixture did not release lock'))
          return
        }
        void worker.terminate().then(() => resolve(), reject)
      })
      worker.postMessage('release')
      })
    },
  }
}

function temporaryClient(
  t: TestContext,
  path: string,
): KnowledgeStoreClient {
  const client = new KnowledgeStoreClient({path})
  t.after(() => client.close())
  return client
}

test('empty corpus recalls no hits', async t => {
  const client = await store(t)
  assert.deepEqual(await client.recall('runtime', [1, 0], 'embed-a', 3), [])
})

test('recall combines lexical FTS and vector hits without exposing source locator', async t => {
  const client = await store(t)
  await client.replaceSource({
    source: source(),
    provider_id: 'embed-a',
    dims: 2,
    chunks: [
      {heading_path: 'Runtime', text: 'orb playback lifecycle', token_estimate: 3, vector: [1, 0]},
      {heading_path: 'Search', text: 'mcp retrieval protocol', token_estimate: 3, vector: [0, 1]},
    ],
  })

  const lexical = await client.recall('retrieval', [1, 0], 'embed-a', 1)
  assert.equal(lexical[0]?.text, 'mcp retrieval protocol')
  assert.match(lexical[0]?.locator ?? '', /^knowledge:\/\/source-a\//u)
  assert.notEqual(lexical[0]?.locator, source().locator)

  const vector = await client.recall('nothing lexical', [1, 0], 'embed-a', 1)
  assert.equal(vector[0]?.text, 'orb playback lifecycle')
})

test('recall falls back to bounded lexical matching without FTS5', async t => {
  const client = await store(t, true)
  await client.replaceSource({
    source: source(),
    provider_id: 'embed-a',
    dims: 2,
    chunks: [
      {heading_path: 'Portable', text: 'portable lexical fallback_under result', token_estimate: 4, vector: [1, 0]},
      {heading_path: 'Other', text: 'fallbackXunder unrelated document', token_estimate: 2, vector: [0, 1]},
    ],
  })
  const lexical = await client.recall('portable fallback', [0, 1], 'embed-b', 1)
  assert.equal(lexical[0]?.text, 'portable lexical fallback_under result')
  assert.equal((await client.recall('ortable', [0, 1], 'embed-b', 1))[0]?.text, lexical[0]?.text)
  assert.deepEqual((await client.recall('fallback_under', [0, 1], 'embed-b', 5)).map(hit => hit.text), [lexical[0]?.text])
})

test('invalid replacement rolls back and leaves the prior source recallable', async t => {
  const client = await store(t)
  await client.replaceSource({
    source: source(),
    provider_id: 'embed-a',
    dims: 2,
    chunks: [{heading_path: 'Old', text: 'durable old chunk', token_estimate: 3, vector: [1, 0]}],
  })

  await assert.rejects(
    client.replaceSource({
      source: source(),
      provider_id: 'embed-a',
      dims: 2,
      chunks: [{heading_path: 'Bad', text: 'replacement', token_estimate: 1, vector: [1]}],
    }),
    (error: unknown) => error instanceof KnowledgeStoreClientError && error.code === 'STORE_INVALID_INPUT',
  )
  assert.equal((await client.recall('durable', [1, 0], 'embed-a', 1))[0]?.text, 'durable old chunk')
})

test('source byte cap rejects replacement without changing stored chunks', async t => {
  const client = await store(t)
  await client.replaceSource({
    source: source(),
    provider_id: 'embed-a',
    dims: 2,
    chunks: [{heading_path: 'Old', text: 'original chunk', token_estimate: 2, vector: [1, 0]}],
  })
  await assert.rejects(
    client.replaceSource({
      source: {...source(), bytes: 10 * 1024 * 1024 + 1},
      provider_id: 'embed-a',
      dims: 2,
      chunks: [{heading_path: 'New', text: 'too large', token_estimate: 2, vector: [0, 1]}],
    }),
    (error: unknown) => error instanceof KnowledgeStoreClientError && error.code === 'STORE_INVALID_INPUT',
  )
  assert.equal((await client.recall('original', [1, 0], 'embed-a', 1))[0]?.text, 'original chunk')
})

test('maxSources refuses a second source but permits reindexing the existing source', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-knowledge-max-sources-'))
  const client = new KnowledgeStoreClient({path: join(directory, 'knowledge.sqlite'), maxSources: 1})
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  await client.open()
  await client.replaceSource({
    source: source(), provider_id: 'embed-a', dims: 2,
    chunks: [{heading_path: 'First', text: 'first durable result', token_estimate: 3, vector: [1, 0]}],
  })
  await assert.rejects(client.replaceSource({
    source: source('source-b'), provider_id: 'embed-a', dims: 2,
    chunks: [{heading_path: 'Second', text: 'second refused result', token_estimate: 3, vector: [0, 1]}],
  }), (error: unknown) => error instanceof KnowledgeStoreClientError && error.code === 'STORE_CAPACITY')
  await client.replaceSource({
    source: {...source(), updated_at: 2}, provider_id: 'embed-a', dims: 2,
    chunks: [{heading_path: 'Updated', text: 'updated durable result', token_estimate: 3, vector: [0, 1]}],
  })
  assert.deepEqual((await client.listSources()).map(item => item.id), ['source-a'])
  assert.equal((await client.recall('updated', [0, 1], 'embed-a', 1))[0]?.text, 'updated durable result')
})

test('reindex preserves chunk identity and detects content changes as stale', async t => {
  const client = await store(t)
  await client.replaceSource({
    source: source(),
    provider_id: 'embed-a',
    dims: 2,
    chunks: [{heading_path: 'Old', text: 'old version', token_estimate: 2, vector: [1, 0]}],
  })
  const oldLocator = (await client.recall('old', [1, 0], 'embed-a', 1))[0]?.locator
  assert.ok(oldLocator)
  const wrongLocator = oldLocator.endsWith('d=000000000000')
    ? `${oldLocator.slice(0, -1)}1`
    : `${oldLocator.slice(0, -12)}000000000000`
  assert.equal((await client.getChunk(wrongLocator)).status, 'stale')

  await client.replaceSource({
    source: {...source(), updated_at: 2},
    provider_id: 'embed-a',
    dims: 2,
    chunks: [{heading_path: 'New', text: 'new version', token_estimate: 2, vector: [0, 1]}],
  })
  assert.deepEqual(await client.getChunk(oldLocator), {status: 'stale', text: 'new version', title: 'Runtime notes', heading_path: 'New', source_id: 'source-a'})
  await client.removeSource('source-a')
  assert.equal((await client.getChunk(oldLocator)).status, 'gone')
})

test('jobs are retained and close rejects further calls', async t => {
  const client = await store(t)
  await client.recordJob({id: 'job-a', source_id: 'source-a', state: 'running', error_code: null, updated_at: 1})
  assert.deepEqual(await client.listJobs(), [
    {id: 'job-a', source_id: 'source-a', state: 'running', error_code: null, updated_at: 1},
  ])
  await client.close()
  await assert.rejects(client.listSources(), (error: unknown) => (
    error instanceof KnowledgeStoreClientError && error.code === 'CLIENT_CLOSED'
  ))
})

test('close immediately rejects an in-flight Worker write instead of queueing behind it', async t => {
  const client = await store(t)
  const pending = client.replaceSource({
    source: source(),
    provider_id: 'embed-a',
    dims: 2,
    chunks: Array.from({length: 20_000}, (_item, index) => ({
      heading_path: 'Bulk', text: `chunk ${index}`, token_estimate: 1, vector: [1, 0],
    })),
  })
  const rejected = assert.rejects(pending, (error: unknown) => (
    error instanceof KnowledgeStoreClientError && error.code === 'CLIENT_CLOSED'
  ))
  const closing = client.close()
  await rejected
  await closing
})

test('graceful close waits for a busy Worker and the same database can reopen', async t => {
  const {client, path} = await storeWithPath(t)
  const lock = await holdWriteLock(path)
  t.after(() => lock.release().catch(() => undefined))
  const pending = client.replaceSource({
    source: source(), provider_id: 'embed-a', dims: 2,
    chunks: [{heading_path: 'Busy', text: 'blocked write', token_estimate: 2, vector: [1, 0]}],
  })
  const rejected = assert.rejects(pending, (error: unknown) => (
    error instanceof KnowledgeStoreClientError && error.code === 'CLIENT_CLOSED'
  ))
  await new Promise(resolve => setTimeout(resolve, 50))
  let closed = false
  const closing = client.close().then(() => { closed = true })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(closed, false)
  await lock.release()
  await closing
  await rejected
  const reopened = temporaryClient(t, path)
  await reopened.open()
  await reopened.recordJob({id: 'after-close', source_id: 'source-a', state: 'complete', error_code: null, updated_at: 2})
  assert.equal((await reopened.listJobs())[0]?.id, 'after-close')
  await reopened.close()
})

test('close settles after a Worker has already failed during bootstrap', async () => {
  const client = new KnowledgeStoreClient({path: undefined as unknown as string})
  await assert.rejects(client.open(), (error: unknown) => (
    error instanceof KnowledgeStoreClientError && error.code === 'WORKER_ERROR'
  ))
  await new Promise(resolve => setTimeout(resolve, 50))
  await settlesWithin('close after worker exit', client.close())
})

test('unsafe existing parent and database symlink are rejected without permission repair', async t => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-knowledge-unsafe-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const broadParent = join(root, 'broad')
  await mkdir(broadParent, {mode: 0o755})
  await chmod(broadParent, 0o755)
  const broad = temporaryClient(t, join(broadParent, 'knowledge.sqlite'))
  await assert.rejects(broad.open(), (error: unknown) => (
    error instanceof KnowledgeStoreClientError && error.code === 'STORE_WRITE_FAILED'
  ))
  assert.equal((await lstat(broadParent)).mode & 0o7777, 0o755)

  const privateParent = join(root, 'private')
  await mkdir(privateParent, {mode: 0o700})
  const target = join(root, 'target.sqlite')
  await symlink(target, join(privateParent, 'knowledge.sqlite'))
  const linked = temporaryClient(t, join(privateParent, 'knowledge.sqlite'))
  await assert.rejects(linked.open(), (error: unknown) => (
    error instanceof KnowledgeStoreClientError && error.code === 'STORE_WRITE_FAILED'
  ))
})

test('new private database parent and SQLite sidecars stay owner-only', async t => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-knowledge-private-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const path = join(root, 'new-private', 'knowledge.sqlite')
  const client = temporaryClient(t, path)
  await client.open()
  await client.replaceSource({
    source: source(), provider_id: 'embed-a', dims: 2,
    chunks: [{heading_path: 'One', text: 'durable sidecar', token_estimate: 2, vector: [1, 0]}],
  })
  assert.equal((await lstat(join(root, 'new-private'))).mode & 0o7777, 0o700)
  assert.equal((await lstat(path)).mode & 0o7777, 0o600)
  assert.equal((await lstat(`${path}-wal`)).mode & 0o7777, 0o600)
  assert.equal((await lstat(`${path}-shm`)).mode & 0o7777, 0o600)
})

test('Windows admission does not enforce POSIX file-mode equality', async t => {
  if (process.platform !== 'win32') return
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-knowledge-windows-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const client = temporaryClient(t, join(root, 'knowledge.sqlite'))
  await client.open()
  assert.deepEqual(await client.listSources(), [])
})

test('Float32 overflow rejects before replacement and leaves prior data intact', async t => {
  const client = await store(t)
  await client.replaceSource({
    source: source(), provider_id: 'embed-a', dims: 2,
    chunks: [{heading_path: 'Old', text: 'float durable', token_estimate: 2, vector: [1, 0]}],
  })
  await assert.rejects(client.replaceSource({
    source: source(), provider_id: 'embed-a', dims: 2,
    chunks: [{heading_path: 'Bad', text: 'overflow', token_estimate: 1, vector: [Number.MAX_VALUE, 0]}],
  }), (error: unknown) => error instanceof KnowledgeStoreClientError && error.code === 'STORE_INVALID_INPUT')
  assert.equal((await client.recall('durable', [1, 0], 'embed-a', 1))[0]?.text, 'float durable')
})

test('recall and getChunk redact document paths while keeping lexical matches across providers', async t => {
  const client = await store(t)
  const headingUnc = String.raw`\\server\share\heading.md`
  const documentUnc = String.raw`\\server\share\document.md`
  await client.replaceSource({
    source: {...source(), title: 'Plan https://example.com/a and /Users/example/private/plan.md'},
    provider_id: 'embed-a', dims: 2,
    chunks: [{
      heading_path: `见/Users/example/private/heading.md and ${headingUnc}`,
      text: `URL https://example.com/a; 见/Users/example/private/document.md; ${documentUnc} lexical retention`,
      token_estimate: 4,
      vector: [1, 0],
    }],
  })
  const hit = (await client.recall('lexical', [0, 1], 'embed-b', 1))[0]
  assert.ok(hit)
  assert.equal(hit.locator.includes('/tmp/runtime-notes.md'), false)
  assert.equal(hit.title.includes('/Users/example/private'), false)
  assert.equal(hit.heading_path.includes('/Users/example/private'), false)
  assert.equal(hit.text.includes('/Users/example/private'), false)
  assert.equal(hit.title.includes('https://example.com/a'), true)
  assert.equal(hit.text.includes('https://example.com/a'), true)
  assert.equal(hit.heading_path.includes(headingUnc), false)
  assert.equal(hit.text.includes(documentUnc), false)
  const chunk = await client.getChunk(hit.locator)
  assert.equal(chunk.status, 'ok')
  assert.equal(chunk.text?.includes('/Users/example/private'), false)
  assert.equal(chunk.text?.includes('https://example.com/a'), true)
  assert.equal(chunk.text?.includes(documentUnc), false)
  const privateSource = (await client.listSources())[0]
  assert.equal(privateSource?.locator, '/tmp/runtime-notes.md')
  assert.equal(privateSource?.title.includes('/Users/example/private'), false)
  await client.removeSource('source-a')
  assert.equal((await client.getChunk(hit.locator)).status, 'gone')
})

test('close resolves at its deadline even when worker termination never settles', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-knowledge-close-'))
  const client = new KnowledgeStoreClient({path: join(directory, 'knowledge.sqlite')})
  t.after(async () => { await client.close().catch(() => undefined); await rm(directory, {recursive: true, force: true}) })
  await client.open()
  const workers: Worker[] = []
  const original = Object.getOwnPropertyDescriptor(Worker.prototype, 'postMessage')!.value as Worker['postMessage']
  const post = t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, value: unknown) {
    workers.push(this)
    if (['list_sources', 'close'].includes((value as {operation: string}).operation)) return
    original.call(this, value)
  })
  const pending = client.listSources()
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof KnowledgeStoreClientError && error.code === 'CLIENT_CLOSED')
  const terminate = t.mock.method(Worker.prototype, 'terminate', () => new Promise<number>(() => undefined))
  const closing = client.close()
  assert.equal(client.close(), closing)
  try {
    await rejected
    await settlesWithin('bounded close', closing, 3000)
    assert.equal(terminate.mock.callCount(), 1)
    assert.notEqual(workers[0]?.threadId, -1)
    await assert.rejects(client.listJobs(), (error: unknown) => error instanceof KnowledgeStoreClientError && error.code === 'CLIENT_CLOSED')
  } finally {post.mock.restore(); terminate.mock.restore(); await workers[0]?.terminate(); await closing.catch(() => undefined)}
})

test('forced close permits immediate reopen and writes to the same real SQLite database', async t => {
  const {client, path} = await storeWithPath(t)
  await client.replaceSource({source: source(), provider_id: 'embed-a', dims: 2,
    chunks: [{heading_path: 'Saved', text: 'persisted before force close', token_estimate: 4, vector: [1, 0]}]})
  const hit = (await client.recall('persisted', [1, 0], 'embed-a', 1))[0]!
  const original = Object.getOwnPropertyDescriptor(Worker.prototype, 'postMessage')!.value as Worker['postMessage']
  const workers: Worker[] = []
  const post = t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, value: unknown) {
    if ((value as {operation: string}).operation === 'close') {workers.push(this); return}
    original.call(this, value)
  })
  try {
    const closing = client.close()
    const worker = workers[0]
    assert.ok(worker)
    const exited = new Promise<number>(resolve => worker.once('exit', resolve))
    await settlesWithin('forced close', closing, 3000)
    post.mock.restore()
    const reopened = temporaryClient(t, path)
    await reopened.open()
    assert.equal((await reopened.getChunk(hit.locator)).status, 'ok')
    await reopened.removeSource('source-a')
    assert.deepEqual(await reopened.listSources(), [])
    await reopened.close()
    // Observe real termination separately; close() itself only promises bounded detachment.
    assert.equal(await settlesWithin('real worker exit', exited), 1)
  } finally {post.mock.restore(); await workers[0]?.terminate()}
})

test('forced close during a native SQLite lock keeps reopening fail-closed until the lock clears', async t => {
  const {client, path} = await storeWithPath(t)
  await client.recordJob({id: 'saved', source_id: 'source-a', state: 'complete', error_code: null, updated_at: 1})
  const lock = await holdWriteLock(path)
  const pending = client.recordJob({id: 'blocked', source_id: 'source-a', state: 'running', error_code: null, updated_at: 2})
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof KnowledgeStoreClientError && error.code === 'CLIENT_CLOSED')
  await new Promise(resolve => setTimeout(resolve, 50))
  // Observe the real termination promise; do not replace Worker.terminate or pretend it has settled.
  const terminate = t.mock.method(Worker.prototype, 'terminate')
  const reopened = temporaryClient(t, path)
  try {
    await settlesWithin('close during SQLite busy wait', client.close(), 900)
    await rejected
    const termination = terminate.mock.calls[0]?.result
    assert.ok(termination)
    await assert.rejects(reopened.open(), (error: unknown) => error instanceof KnowledgeStoreClientError && error.code === 'STORE_WRITE_FAILED')
    await lock.release()
    await termination
    await reopened.open()
    assert.deepEqual((await reopened.listJobs()).map(job => job.id), ['saved'])
    await reopened.recordJob({id: 'recovered', source_id: 'source-a', state: 'complete', error_code: null, updated_at: 3})
    assert.deepEqual((await reopened.listJobs()).map(job => job.id), ['recovered', 'saved'])
  } finally {
    terminate.mock.restore()
    await lock.release()
    await reopened.close()
    await client.close()
  }
})

async function fixtureSql(path: string, sql: string, mode = 'exec'): Promise<unknown> {
  const worker = new Worker(new URL('./fixtures/workspace-graph-sqlite-worker.js', import.meta.url), {workerData: {path, sql, mode}})
  try {return await new Promise((resolve, reject) => {worker.once('message', resolve); worker.once('error', reject)})}
  finally {await worker.terminate()}
}

test('legacy database migration preserves data and old references across unchanged and changed reindex', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-knowledge-legacy-'))
  const path = join(directory, 'knowledge.sqlite')
  t.after(() => rm(directory, {recursive: true, force: true}))
  await fixtureSql(path, `
    CREATE TABLE sources(id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, locator TEXT NOT NULL, mime TEXT NOT NULL, fingerprint TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE TABLE chunks(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, heading_path TEXT NOT NULL, text TEXT NOT NULL, token_estimate INTEGER NOT NULL);
    CREATE TABLE embeddings(chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE, provider_id TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL);
    CREATE TABLE jobs(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, state TEXT NOT NULL, error_code TEXT, updated_at INTEGER NOT NULL);
    INSERT INTO sources VALUES ('source-a', 'Runtime notes', 'file', '/tmp/runtime-notes.md', 'text/markdown', '${'a'.repeat(64)}', 120, 1, 1, 'ready');
    INSERT INTO chunks VALUES ('old-chunk', 'source-a', 'Old', 'old version', 2);
    INSERT INTO embeddings VALUES ('old-chunk', 'embed-a', 2, X'0000803F00000000');
    INSERT INTO jobs VALUES ('job-a', 'source-a', 'complete', NULL, 1);
  `)
  await chmod(path, 0o600)
  const client = temporaryClient(t, path)
  const legacy = `knowledge://source-a/old-chunk?d=${createHash('sha256').update('source-a:old-chunk').digest('hex').slice(0, 12)}`
  await client.open()
  assert.deepEqual(await client.listSources(), [source()])
  assert.equal((await client.listJobs())[0]?.id, 'job-a')
  assert.equal((await client.getChunk(legacy)).status, 'ok')
  const input = {source: source(), provider_id: 'embed-a', dims: 2, chunks: [{heading_path: 'Old', text: 'old version', token_estimate: 2, vector: [1, 0]}]}
  const hit = (await client.recall('old', [1, 0], 'embed-a', 1))[0]!
  assert.notEqual(hit.locator, legacy)
  assert.match(hit.locator, /\/old-chunk\?d=/u)
  await client.replaceSource(input)
  assert.equal((await client.getChunk(legacy)).status, 'ok')
  assert.equal((await client.recall('old', [1, 0], 'embed-a', 1))[0]?.locator, hit.locator)
  await client.replaceSource({...input, source: {...source(), title: 'Updated title'}})
  assert.equal((await client.getChunk(legacy)).status, 'stale')
  assert.equal((await client.getChunk(hit.locator)).status, 'stale')
  await client.close()
  const reopened = temporaryClient(t, path)
  await reopened.open()
  assert.equal((await reopened.getChunk(legacy)).status, 'stale')
  assert.equal((await reopened.getChunk(hit.locator)).title, 'Updated title')
  await reopened.removeSource('source-a')
  assert.deepEqual(await reopened.getChunk(legacy), {status: 'gone'})
})

test('ordinal correspondence preserves unchanged chunks and removes surplus references', async t => {
  const client = await store(t)
  const chunks = [
    {heading_path: 'First', text: 'first chunk', token_estimate: 2, vector: [1, 0]},
    {heading_path: 'Last', text: 'last chunk', token_estimate: 2, vector: [0, 1]},
  ]
  const input = {source: source(), provider_id: 'embed-a', dims: 2, chunks}
  await client.replaceSource(input)
  const first = (await client.recall('first', [1, 0], 'embed-a', 1))[0]!.locator
  const last = (await client.recall('last', [0, 1], 'embed-a', 1))[0]!.locator
  await client.replaceSource({...input, chunks: chunks.slice(0, 1)})
  assert.equal((await client.getChunk(first)).status, 'ok')
  assert.deepEqual(await client.getChunk(last), {status: 'gone'})
  await client.replaceSource({...input, chunks: [{...chunks[0]!, heading_path: 'Renamed'}]})
  assert.equal((await client.getChunk(first)).status, 'stale')
})

test('FTS opens reuse a clean index and rebuild after lexical-only mutations', async t => {
  const {client, path} = await storeWithPath(t)
  await client.close()
  const initial = temporaryClient(t, path)
  const opened = await initial.open()
  // Some Node builds lack FTS5; forced fallback is tested independently on every runtime.
  if (opened.fts === false) return t.skip('FTS5 unavailable')
  assert.deepEqual(opened, {fts: true})
  const input = {source: source(), provider_id: 'embed-a', dims: 2,
    chunks: [{heading_path: 'Old', text: 'original evidence', token_estimate: 2, vector: [1, 0]}]}
  await initial.replaceSource(input)
  await initial.close()
  // A harmless rowid change observes physical index reuse without timing assertions.
  await fixtureSql(path, 'UPDATE chunks_fts SET rowid = 99')
  const clean = temporaryClient(t, path)
  assert.deepEqual(await clean.open(), {fts: true})
  assert.deepEqual(await fixtureSql(path, 'SELECT rowid FROM chunks_fts', 'query'), {kind: 'rows', rows: [{rowid: 99}]})
  await clean.close()
  const fallback = new KnowledgeStoreClient({path, forceLexical: true})
  t.after(() => fallback.close())
  assert.deepEqual(await fallback.open(), {fts: false})
  await fallback.replaceSource({...input, chunks: [{...input.chunks[0]!, text: 'updated evidence'}]})
  await fallback.replaceSource({...input, source: source('removed')})
  await fallback.removeSource('removed')
  await fallback.close()
  const rebuilt = temporaryClient(t, path)
  assert.deepEqual(await rebuilt.open(), {fts: true})
  assert.equal((await rebuilt.recall('updated', [0, 1], 'embed-b', 5))[0]?.text, 'updated evidence')
  assert.deepEqual(await rebuilt.recall('original', [0, 1], 'embed-b', 5), [])
  assert.deepEqual(await fixtureSql(path, 'SELECT text FROM chunks_fts', 'query'), {kind: 'rows', rows: [{text: 'updated evidence'}]})
  await rebuilt.close()
  const removing = new KnowledgeStoreClient({path, forceLexical: true})
  t.after(() => removing.close())
  await removing.open()
  await removing.removeSource('source-a')
  await removing.close()
  const empty = temporaryClient(t, path)
  await empty.open()
  assert.deepEqual(await fixtureSql(path, 'SELECT text FROM chunks_fts', 'query'), {kind: 'rows', rows: []})
})
