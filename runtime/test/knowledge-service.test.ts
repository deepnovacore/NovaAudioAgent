import assert from 'node:assert/strict'
import {mkdtemp, writeFile, rm, realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {KnowledgeService} from '../src/knowledge/service.js'
import {KnowledgeStoreClient} from '../src/knowledge/store-client.js'

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
  } finally {await service.close(); await rm(directory, {recursive: true, force: true})}
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
  } finally {release?.(); await service.close(); await rm(directory, {recursive: true, force: true})}
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

    assert.deepEqual(await service.handle('knowledge.reindex', {id: before.id, consent: true}), {error: 'ingest_failed', id: before.id})
    assert.equal((await service.listSources())[0]!.fingerprint, before.fingerprint)
    assert.deepEqual(await service.getChunk(hit.locator), {
      status: 'ok', text: 'Original durable evidence', title: 'manual.md', heading_path: 'manual.md', source_id: before.id,
    })
    const status = await service.handle('knowledge.status', {}) as {readonly jobs: readonly {readonly source_id: string; readonly state: string; readonly error_code: string | null}[]}
    assert.ok(status.jobs.some(job => job.source_id === before.id && job.state === 'failed' && job.error_code === 'ingest_failed'))
    assert.ok(!JSON.stringify(status).includes('private-value'))
  } finally {await service.close(); await rm(directory, {recursive: true, force: true})}
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
    await rm(directory, {recursive: true, force: true})
  }
})
