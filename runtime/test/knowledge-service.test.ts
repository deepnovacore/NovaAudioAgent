import assert from 'node:assert/strict'
import {mkdtemp, writeFile, rm, realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {KnowledgeService} from '../src/knowledge/service.js'
import {KnowledgeStoreClient} from '../src/knowledge/store-client.js'

// close() bounds worker shutdown; Windows can retain the SQLite file lock
// briefly after that deadline. Retry cleanup without changing service assertions.

test('knowledge service ingests, retrieves evidence and emits only safe host status', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-service-'))
  const file = join(directory, 'manual.md')
  await writeFile(file, '# Setup\nThe blue lamp means the system is ready.')
  const service = new KnowledgeService({store: new KnowledgeStoreClient({path: join(directory, 'db', 'knowledge.sqlite')}),
    embedding: {id: 'fake-v1', dims: 2, embed: texts => Promise.resolve(texts.map(() => new Float32Array([1, 0])))}})
  try {
    await service.open()
    await assert.rejects(service.handle('knowledge.ingest', {kind: 'file', locator: file}), /invalid_request/)
    await service.handle('knowledge.ingest', {kind: 'file', locator: file, consent: true})
    const hits = await service.recall('blue lamp', 3)
    assert.equal(hits.length, 1)
    assert.match(hits[0]!.text, /blue lamp/)
    const status = await service.handle('knowledge.status', {})
    assert.ok(!JSON.stringify(status).includes(directory))
    assert.ok(!JSON.stringify(status).includes('blue lamp'))
    await service.handle('knowledge.remove', {id: hits[0]!.source_id})
    assert.deepEqual(await service.recall('blue lamp', 3), [])
  } finally {await service.close(); await rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})}
})

test('syncFile reports bounded document and store failures without losing prior index, and embedding never blocks it', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-codes-'))
  const file = join(directory, 'manual.md'), unsupported = join(directory, 'manual.bin')
  const store = new KnowledgeStoreClient({path: join(directory, 'db', 'knowledge.sqlite')})
  let failEmbedding = false, failStore = false
  const replace = store.replaceSource.bind(store)
  store.replaceSource = async input => {if (failStore) throw Error('store credential=private-value'); await replace(input)}
  const service = new KnowledgeService({store, embedding: {id: 'fake-v1', dims: 2, embed: texts => failEmbedding
    ? Promise.reject(Error('embedding credential=private-value'))
    : Promise.resolve(texts.map(() => new Float32Array([1, 0])))}})
  const sync = (path: string, id?: string) => service.syncFile(path, directory, new AbortController().signal, id,
    {revision: 1, scope_revision: 0, extraction_provider: 'fake-v1', embedding_provider: 'fake-v1'})
  try {
    await service.open()
    await writeFile(unsupported, 'Unsupported data')
    await assert.rejects(sync(unsupported), /^Error: unsupported_file$/u)
    const secret = 'token=credential-value-123456789'
    await writeFile(file, secret)
    await assert.rejects(sync(file), /^Error: screening_rejected$/u)
    await writeFile(file, 'Original durable text')
    const before = await sync(file)
    const fingerprint = (await service.listSources())[0]!.fingerprint
    await writeFile(file, 'Replacement text')
    failEmbedding = true
    const replaced = await sync(file, before.id)
    await service.vectorsSettled()
    const current = (await service.listSources())[0]!.fingerprint
    assert.notEqual(current, fingerprint, 'an embedding outage does not hold back the index')
    assert.deepEqual(await store.unembeddedSources('fake-v1', 2), [replaced.id])
    failEmbedding = false
    assert.match((await service.recall('Replacement', 3))[0]?.text ?? '', /Replacement/u, 'unembedded text stays searchable lexically')
    await writeFile(file, 'Third text')
    failStore = true
    await assert.rejects(sync(file, before.id), /^Error: store_failed$/u)
    assert.equal((await service.listSources())[0]!.fingerprint, current)
    const status = JSON.stringify(await service.handle('knowledge.status', {}))
    assert.ok(!status.includes(secret) && !status.includes('private-value'))
  } finally {await service.close(); await rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})}
})

test('syncFile bounds store failures before indexing and after commit', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-outer-errors-'))
  const file = join(directory, 'manual.md')
  await writeFile(file, 'Verified text')
  const store = new KnowledgeStoreClient({path: join(directory, 'db', 'knowledge.sqlite')})
  const service = new KnowledgeService({store, embedding: {id: 'fake-v1', dims: 2,
    embed: texts => Promise.resolve(texts.map(() => new Float32Array([1, 0])))}})
  try {
    await service.open()
    const list = store.listSources.bind(store)
    store.listSources = () => Promise.reject(Error('list credential=private-value'))
    await assert.rejects(service.syncFile(file, directory, new AbortController().signal), /^Error: store_failed$/u)
    store.listSources = list
    const first = await service.syncFile(file, directory, new AbortController().signal)
    const chunks = store.listChunks.bind(store)
    store.listChunks = () => Promise.reject(Error('chunks credential=private-value'))
    await assert.rejects(service.syncFile(file, directory, new AbortController().signal, first.id), /^Error: store_failed$/u)
    store.listChunks = chunks
  } finally {await service.close(); await rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})}
})

test('remove while reindex embedding waits cannot resurrect a source', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-race-'))
  const file = join(directory, 'manual.md')
  await writeFile(file, 'First revision')
  let blocking = false, release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => {entered = resolve})
  const gate = new Promise<void>(resolve => {release = resolve})
  const service = new KnowledgeService({store: new KnowledgeStoreClient({path: join(directory, 'db', 'knowledge.sqlite')}),
    embedding: {id: 'fake-v1', dims: 2, embed: async texts => {
      if (blocking) {entered(); await gate}
      return texts.map(() => new Float32Array([1, 0]))
    }}})
  try {
    await service.open()
    await service.handle('knowledge.ingest', {kind: 'file', locator: file, consent: true})
    const id = (await service.listSources())[0]!.id
    blocking = true
    const reindex = service.handle('knowledge.reindex', {id, consent: true})
    await started
    await service.handle('knowledge.remove', {id})
    release()
    await reindex
    assert.equal((await service.listSources()).length, 0)
  } finally {release?.(); await service.close(); await rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})}
})

test('failed reindex records a safe failure and preserves the prior source and chunk', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-reindex-failure-'))
  const file = join(directory, 'manual.md'), path = join(directory, 'db', 'knowledge.sqlite')
  await writeFile(file, 'Original durable evidence')
  let fail = false
  const service = new KnowledgeService({store: new KnowledgeStoreClient({path}),
    embedding: {id: 'fake-v1', dims: 2, embed: texts => fail
      ? Promise.reject(new Error('credential=private-value'))
      : Promise.resolve(texts.map(() => new Float32Array([1, 0])))}})
  try {
    await service.open()
    await service.handle('knowledge.ingest', {kind: 'file', locator: file, consent: true})
    const before = (await service.listSources())[0]!
    const hit = (await service.recall('durable evidence', 1))[0]!
    await writeFile(file, 'Replacement must not overwrite durable evidence')
    fail = true

    assert.deepEqual(await service.handle('knowledge.reindex', {id: before.id, consent: true}), {error: 'embedding_failed', id: before.id})
    assert.equal((await service.listSources())[0]!.fingerprint, before.fingerprint)
    assert.deepEqual(await service.getChunk(hit.locator), {
      status: 'ok', text: 'Original durable evidence', title: 'manual.md', heading_path: 'manual.md', source_id: before.id,
    })
    const status = await service.handle('knowledge.status', {}) as {readonly jobs: readonly {readonly source_id: string; readonly state: string; readonly error_code: string | null}[]}
    assert.ok(status.jobs.some(job => job.source_id === before.id && job.state === 'failed' && job.error_code === 'embedding_failed'))
    assert.ok(!JSON.stringify(status).includes('private-value'))
  } finally {await service.close(); await rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})}
})

test('close aborts deferred reindex and a late embedding release cannot overwrite the reopened store', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-close-reindex-'))
  const file = join(directory, 'manual.md'), path = join(directory, 'db', 'knowledge.sqlite')
  await writeFile(file, 'Original persisted evidence')
  let deferred = false, release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => {entered = resolve})
  const gate = new Promise<void>(resolve => {release = resolve})
  const service = new KnowledgeService({store: new KnowledgeStoreClient({path}),
    embedding: {id: 'fake-v1', dims: 2, embed: async texts => {
      if (deferred) {entered(); await gate}
      return texts.map(() => new Float32Array([1, 0]))
    }}})
  let reopened: KnowledgeStoreClient | undefined
  try {
    await service.open()
    await service.handle('knowledge.ingest', {kind: 'file', locator: file, consent: true})
    const before = (await service.listSources())[0]!
    const hit = (await service.recall('persisted evidence', 1))[0]!
    await writeFile(file, 'Late replacement must never persist')
    deferred = true
    const reindex = service.handle('knowledge.reindex', {id: before.id, consent: true})
    await started
    await service.close()
    release()
    assert.deepEqual(await reindex, {error: 'ingest_cancelled', id: before.id})

    reopened = new KnowledgeStoreClient({path})
    await reopened.open()
    assert.equal((await reopened.listSources())[0]!.fingerprint, before.fingerprint)
    assert.deepEqual(await reopened.getChunk(hit.locator), {
      status: 'ok', text: 'Original persisted evidence', title: 'manual.md', heading_path: 'manual.md', source_id: before.id,
    })
  } finally {
    release?.()
    await reopened?.close()
    await service.close()
    await rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})
  }
})

test('knowledge status exposes forced lexical fallback from the real worker', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-status-'))
  const service = new KnowledgeService({store: new KnowledgeStoreClient({path: join(directory, 'knowledge.sqlite'), forceLexical: true}),
    embedding: {id: 'fake-v1', dims: 2, embed: texts => Promise.resolve(texts.map(() => new Float32Array([1, 0])))}})
  try {
    await service.open()
    assert.deepEqual(await service.handle('knowledge.status', {}), {fts: false, sources: [], jobs: []})
  } finally {await service.close(); await rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})}
})

test('scan-time sync commits before embedding and a stale backfill cannot write over newer content', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-backfill-'))
  const file = join(directory, 'notes.md')
  const store = new KnowledgeStoreClient({path: join(directory, 'db', 'knowledge.sqlite')})
  const seen: string[][] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => {release = resolve})
  const service = new KnowledgeService({store, embedding: {id: 'fake-v1', dims: 2, embed: async texts => {
    seen.push([...texts]); if (seen.length === 1) await gate
    return texts.map(() => new Float32Array([1, 0]))}}})
  const grant = {revision: 1, scope_revision: 0, extraction_provider: 'fake-v1', embedding_provider: 'fake-v1'}
  try {
    await service.open()
    await writeFile(file, 'Old plan')
    const first = await service.syncFile(file, directory, new AbortController().signal, undefined, grant)
    assert.deepEqual(await store.unembeddedSources('fake-v1', 2), [first.id], 'sync returned while the embedding is still waiting')
    await writeFile(file, 'New plan')
    await service.syncFile(file, directory, new AbortController().signal, first.id, grant)
    release(); await service.vectorsSettled()
    assert.deepEqual(seen, [['Old plan'], ['New plan']])
    assert.deepEqual(await store.unembeddedSources('fake-v1', 2), [])
  } finally {release(); await service.close(); await rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})}
})

test('background embedding stops at the next provider batch once the source owner withdraws it', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-vector-gate-'))
  const file = join(directory, 'notes.md'), busy = join(directory, 'busy.md'), queued = join(directory, 'queued.md')
  const store = new KnowledgeStoreClient({path: join(directory, 'db', 'knowledge.sqlite')})
  const batches: string[][] = []
  let withdrawn = false, hold: Promise<void> | undefined
  const service = new KnowledgeService({store, embedding: {id: 'fake-v1', dims: 2, embed: async texts => {
    batches.push([...texts]); withdrawn = true; await hold
    return texts.map(() => new Float32Array([1, 0]))}}})
  const grant = {revision: 1, scope_revision: 0, extraction_provider: 'fake-v1', embedding_provider: 'fake-v1'}
  try {
    await service.open()
    service.setVectorGate(() => withdrawn ? null : undefined)
    await writeFile(file, Array.from({length: 14}, (_, n) => `# Section ${n}\nParagraph ${n} about the plan.`).join('\n\n'))
    const {id} = await service.syncFile(file, directory, new AbortController().signal, undefined, grant)
    await service.vectorsSettled()
    assert.deepEqual(batches.map(batch => batch.length), [10], 'no upload starts after the withdrawal that followed the first batch')
    assert.deepEqual(await store.unembeddedSources('fake-v1', 2), [id])
    service.setVectorGate(() => undefined); batches.length = 0
    let release!: () => void
    hold = new Promise<void>(resolve => {release = resolve})
    await writeFile(busy, 'Embedding while the pause arrives'); await writeFile(queued, 'Queued before the pause')
    await service.syncFile(busy, directory, new AbortController().signal, undefined, grant)
    const paused = new AbortController()
    await service.syncFile(queued, directory, new AbortController().signal, undefined, grant, paused.signal)
    paused.abort(); release(); await service.vectorsSettled()
    assert.ok(batches.length >= 1 && batches.every(batch => !batch.includes('Queued before the pause')), 'a file queued by a source that was then paused is never uploaded')
  } finally {await service.close(); await rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})}
})

test('vector writes require the embedded source fingerprint and chunk digest', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-set-vectors-'))
  const file = join(directory, 'notes.md')
  const store = new KnowledgeStoreClient({path: join(directory, 'db', 'knowledge.sqlite')})
  const service = new KnowledgeService({store, embedding: {id: 'fake-v1', dims: 2, embed: texts => Promise.resolve(texts.map(() => new Float32Array([1, 0])))}})
  try {
    await service.open(); await writeFile(file, 'A note')
    const {id} = await service.syncFile(file, directory, new AbortController().signal)
    const pending = await store.unembeddedChunks(id, 'fake-v1', 2), chunk = pending.chunks[0]!
    const write = (fingerprint: string, content_digest: string) => store.setVectors({source_id: id, fingerprint, provider_id: 'fake-v1', dims: 2, vectors: [{chunk_id: chunk.chunk_id, content_digest, vector: [1, 0]}]})
    assert.equal(await write('other', chunk.content_digest), 0)
    assert.equal(await write(pending.fingerprint!, 'other'), 0)
    assert.equal(await write(pending.fingerprint!, chunk.content_digest), 1)
    assert.deepEqual(await store.unembeddedSources('fake-v1', 2), [])
    assert.deepEqual(await store.unembeddedSources('fake-v2', 2), [id], 'a provider change makes the chunk pending again')
  } finally {await service.close(); await rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})}
})
