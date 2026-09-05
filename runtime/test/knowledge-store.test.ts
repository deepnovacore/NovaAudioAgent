import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test, {type TestContext} from 'node:test'

import {KnowledgeStoreClient, KnowledgeStoreClientError} from '../src/knowledge/store-client.js'
import type {KnowledgeSource} from '../src/knowledge/types.js'

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
  const directory = await mkdtemp(join(tmpdir(), 'nova-knowledge-store-'))
  const client = new KnowledgeStoreClient({path: join(directory, 'knowledge.sqlite')})
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  await client.open()
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
