import assert from 'node:assert/strict'
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

async function store(t: TestContext): Promise<KnowledgeStoreClient> {
  return (await storeWithPath(t)).client
}

async function storeWithPath(t: TestContext): Promise<{readonly client: KnowledgeStoreClient; readonly path: string}> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-knowledge-store-'))
  const path = join(directory, 'knowledge.sqlite')
  const client = new KnowledgeStoreClient({path})
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  await client.open()
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
  const client = await store(t)
  await client.replaceSource({
    source: source(),
    provider_id: 'embed-a',
    dims: 2,
    chunks: [
      {heading_path: 'Portable', text: 'portable lexical fallback result', token_estimate: 4, vector: [1, 0]},
      {heading_path: 'Other', text: 'unrelated document', token_estimate: 2, vector: [0, 1]},
    ],
  })
  const lexical = await client.recall('portable fallback', [0, 1], 'embed-b', 1)
  assert.equal(lexical[0]?.text, 'portable lexical fallback result')
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

test('reindex makes old chunk locators gone and detects wrong digests as stale', async t => {
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
  assert.equal((await client.getChunk(oldLocator)).status, 'gone')
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

test('close resolves only after a busy Worker has actually terminated', async t => {
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
