import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp, realpath, rm, stat, symlink} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import test from 'node:test'
import {createMem0PersonalMemory} from '../src/mem0/resource.js'

async function provider(failDerived = false) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let fail = true
  const calls: string[] = []
  let embeddingFailures = 0
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const input = JSON.parse(body) as {input?: string | string[]; messages?: {content: string}[]}
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/embeddings') {
        const entries = Array.isArray(input.input) ? input.input : [input.input]
        if (failDerived && fail && entries.includes('likes apples')) { embeddingFailures++; response.statusCode = 400; response.end('{}'); return }
        response.end(JSON.stringify({data: entries.map((_, index) => ({index, embedding: [1, 0]}))}))
        return
      }
      const prompt = input.messages?.[1]?.content ?? ''
      calls.push(prompt)
      if (prompt.includes('slow kiwi')) await gate
      if (prompt.includes('retry mango') && fail) { response.statusCode = 400; response.end('{}'); return }
      const text = prompt.includes('retry mango') ? 'retry mango' : prompt.includes('slow kiwi') ? 'slow kiwi' : 'likes apples'
      response.end(JSON.stringify({choices: [{message: {content: JSON.stringify({memory: [{id: '0', text, attributed_to: 'user'}]})}}]}))
    })().catch(() => {response.statusCode = 500; response.end('{}')})
  })
  await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve)})
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  return {baseUrl: `http://127.0.0.1:${address.port}/v1`, calls, release, get embeddingFailures() {return embeddingFailures}, recover() {fail = false}, async close() {
    release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }}
}
async function eventually(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20))}
  assert.fail('condition did not become true')
}
const turn = (sourceId: string, text = sourceId) => ({sourceId, sessionId: 'session', sequence: 1, text, occurredAt: null})
const userDirectory = (path: string, user = 'host-user') => `${path}.mem0/${createHash('sha256').update(user).digest('hex')}`

test('real mem0 persists admissions before inference, preserves provenance and isolation, tombstones in-flight learning', {timeout: 20000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-'))
  const endpoint = await provider()
  const path = join(directory, 'personal.sqlite')
  const options = {path, userId: 'host-user', embedding: {baseUrl: endpoint.baseUrl, apiKey: 'test-key', model: 'embedding', dimensions: 2}, extractionModel: 'extract'}
  let store = createMem0PersonalMemory(options)
  const other = createMem0PersonalMemory({...options, userId: 'other-user'})
  t.after(async () => {await store.close(); await other.close(); await endpoint.close(); await rm(directory, {recursive: true, force: true})})
  await store.open()
  assert.equal(store.responseAdaptation, undefined)
  assert.deepEqual(await store.remember!(turn('slow', 'slow kiwi')), {state: 'stored', sourceId: 'slow'})
  await eventually(() => endpoint.calls.some(prompt => prompt.includes('slow kiwi')))
  assert.deepEqual(await store.remember!(turn('slow', 'slow kiwi')), {state: 'stored', sourceId: 'slow'})
  await assert.rejects(store.remember!(turn('slow', 'different source')))
  assert.equal((await store.recall('kiwi', {scope: 'any'})).state, 'empty')
  assert.equal((await store.recall('kiwi', {scope: 'any'})).degraded, true)
  assert.deepEqual(await store.forget!('slow'), {state: 'deleted', sourceId: 'slow'})
  endpoint.release()
  await store.remember!({...turn('apples', 'likes apples'), previousAssistantReply: 'Assistant context, never a new user claim'})
  await eventually(async () => (await store.recall('apples', {scope: 'any'})).hits.some(hit => hit.text === 'likes apples'))
  const hit = (await store.recall('apples', {scope: 'any'})).hits[0]!
  assert.deepEqual(hit.evidenceIds, ['apples'])
  assert.equal(hit.subject, 'host-user')
  assert.equal((await store.recall('kiwi', {scope: 'any'})).hits.some(hit => hit.text === 'slow kiwi'), false)
  for (const name of ['ledger.db', 'vectors.db', 'vectors_entities.db']) assert.equal((await stat(join(userDirectory(path), name))).mode & 0o777, 0o600)
  await store.close()
  store = createMem0PersonalMemory(options)
  await store.open()
  assert.ok((await store.recall('apples', {scope: 'any'})).hits.some(hit => hit.text === 'likes apples'))
  assert.deepEqual(await store.remember!(turn('slow', 'slow kiwi')), {state: 'deleted', sourceId: 'slow'})
  await other.open()
  assert.equal((await other.recall('apples', {scope: 'any'})).state, 'empty')
  await store.forget!('apples')
  assert.equal((await store.recall('apples', {scope: 'any'})).state, 'empty')
})

test('real mem0 retries durable pending sources on reopen without a retry spin', {timeout: 20000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-retry-'))
  const endpoint = await provider()
  const path = join(directory, 'personal.sqlite')
  const options = {path, userId: 'host-user', embedding: {baseUrl: endpoint.baseUrl, apiKey: 'test-key', model: 'embedding', dimensions: 2}, extractionModel: 'extract'}
  let store = createMem0PersonalMemory(options)
  t.after(async () => {await store.close(); await endpoint.close(); await rm(directory, {recursive: true, force: true})})
  await store.open()
  await store.remember!(turn('retry', 'retry mango'))
  await eventually(() => endpoint.calls.length === 1)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(endpoint.calls.length, 1)
  const ledger = new DatabaseSync(join(userDirectory(path), 'ledger.db'), {readOnly: true})
  assert.equal((ledger.prepare('SELECT state FROM sources WHERE id = ?').get('retry') as {state: string}).state, 'pending')
  ledger.close()
  await store.close(); endpoint.recover()
  store = createMem0PersonalMemory(options); await store.open()
  await eventually(async () => (await store.recall('mango', {scope: 'any'})).hits.length === 1)
  assert.equal(endpoint.calls.length, 2)
  await store.close(); store = createMem0PersonalMemory(options); await store.open()
  assert.equal((await store.recall('mango', {scope: 'any'})).hits.length, 1)
})

test('mem0 keeps swallowed embedding failures pending and recovers on reopen', {timeout: 20000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-embedding-'))
  const endpoint = await provider(true)
  const path = join(directory, 'personal.sqlite')
  const options = {path, userId: 'host-user', embedding: {baseUrl: endpoint.baseUrl, apiKey: 'test-key', model: 'embedding', dimensions: 2}, extractionModel: 'extract'}
  let store = createMem0PersonalMemory(options)
  t.after(async () => {await store.close(); await endpoint.close(); await rm(directory, {recursive: true, force: true})})
  await store.open()
  await store.remember!(turn('embedding-failure', 'I enjoy apples'))
  await eventually(() => endpoint.embeddingFailures >= 2)
  await new Promise(resolve => setTimeout(resolve, 100))
  const ledger = new DatabaseSync(join(userDirectory(path), 'ledger.db'), {readOnly: true})
  try {assert.equal(ledger.prepare('SELECT state FROM sources WHERE id=?').get('embedding-failure')?.state, 'pending')} finally {ledger.close()}
  assert.equal((await store.recall('apples', {scope: 'any'})).degraded, true)
  await store.close(); endpoint.recover()
  store = createMem0PersonalMemory(options); await store.open()
  await eventually(async () => (await store.recall('apples', {scope: 'any'})).hits.length === 1)
})

test('mem0 refuses symlink database files', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-link-'))
  const path = join(directory, 'personal.sqlite')
  const {mkdir, writeFile} = await import('node:fs/promises')
  await mkdir(userDirectory(path), {recursive: true, mode: 0o700})
  const target = join(directory, 'target'); await writeFile(target, '', {mode: 0o600})
  await symlink(target, join(userDirectory(path), 'vectors.db'))
  const store = createMem0PersonalMemory({path, userId: 'host-user', embedding: {baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'embedding', dimensions: 2}})
  t.after(async () => {await store.close(); await rm(directory, {recursive: true, force: true})})
  await assert.rejects(store.open())
})

test('recent mem0 recall restricts candidates before ranking and validates source boundaries', {timeout: 20000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-recent-'))
  const endpoint = await provider()
  const path = join(directory, 'personal.sqlite')
  const store = createMem0PersonalMemory({path, userId: 'host-user', embedding: {baseUrl: endpoint.baseUrl, apiKey: 'test-key', model: 'embedding', dimensions: 2}, extractionModel: 'extract'})
  t.after(async () => {await store.close(); await endpoint.close(); await rm(directory, {recursive: true, force: true})})
  await store.open()
  for (let index = 0; index < 7; index++) {
    const id = `source-${index}`
    await store.remember!(turn(id, 'likes apples'))
    const ledger = new DatabaseSync(join(userDirectory(path), 'ledger.db'), {readOnly: true})
    try {await eventually(() => ledger.prepare('SELECT state FROM sources WHERE id=?').get(id)?.state === 'learned')}
    finally {ledger.close()}
  }
  const recent = await store.recall('apples', {scope: 'recent', limit: 5})
  assert.equal(recent.hits.length, 5)
  assert.ok(recent.hits.every(hit => !hit.evidenceIds.includes('source-0') && !hit.evidenceIds.includes('source-1')))
  const all = await store.recall('apples', {scope: 'any', limit: 5})
  assert.ok(all.hits.some(hit => hit.evidenceIds.includes('source-0') || hit.evidenceIds.includes('source-1')))
  await assert.rejects(async () => store.remember!({...turn('invalid'), sequence: Number.MAX_SAFE_INTEGER + 1}))
  await assert.rejects(async () => store.remember!(turn('invalid', 'a'.repeat(40_001))))
  await assert.rejects(async () => store.remember!({...turn('invalid'), previousAssistantReply: '\0'}))
  await store.remember!(turn('*', 'likes apples'))
  const ledger = new DatabaseSync(join(userDirectory(path), 'ledger.db'), {readOnly: true})
  try {await eventually(() => ledger.prepare('SELECT state FROM sources WHERE id=?').get('*')?.state === 'learned')}
  finally {ledger.close()}
  await store.forget!('*')
  await eventually(async () => (await store.recall('apples', {scope: 'any', limit: 5})).hits.length === 5)
  await store.forget!('future')
  assert.deepEqual(await store.remember!(turn('future')), {sourceId: 'future', state: 'deleted'})
})

test('mem0 rejects SDK wildcard identities before opening storage', () => {
  assert.throws(() => createMem0PersonalMemory({path:'/private/tmp/mem0-wildcard',userId:'*',
    embedding:{baseUrl:'https://example.invalid/v1',apiKey:'test',model:'embedding'}}))
})
