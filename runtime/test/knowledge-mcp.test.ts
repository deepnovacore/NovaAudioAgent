import assert from 'node:assert/strict'
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {KnowledgeService} from '../src/knowledge/service.js'
import {KnowledgeStoreClient} from '../src/knowledge/store-client.js'
import {request as httpRequest} from 'node:http'
import {test} from 'node:test'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js'
import type {ExecutorDispatchContext} from '../src/causal-runtime.js'
import {VirtualClock} from '../src/clock.js'
import {
  KnowledgeMcpAdapter,
  MCP_KNOWLEDGE_RECALL,
  createKnowledgeMcpServer,
  startKnowledgeMcpHttpServer,
  type KnowledgeRecallBackend,
} from '../src/knowledge/mcp.js'

function backend(): KnowledgeRecallBackend {
  return {
    recall: (query, k) => Promise.resolve([{
      locator: 'chunk:one', source_id: 'source:one', title: `Result for ${query}`,
      heading_path: 'Root', text: 'Safe result.', score: k,
    }]),
    getChunk: () => Promise.resolve({status: 'ok', text: 'Safe result.', title: 'Source', heading_path: 'Root', source_id: 'source:one'}),
  }
}

async function local(knowledge = backend()) {
  const server = createKnowledgeMcpServer(knowledge)
  const client = new Client({name: 'knowledge-test', version: '1'})
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {client, close: async () => { await Promise.allSettled([client.close(), server.close()]) }}
}

async function postStatus(url: string, headers: Record<string, string>): Promise<number> {
  const endpoint = new URL(url)
  return await new Promise((resolve, reject) => {
    const request = httpRequest(endpoint, {method: 'POST', headers}, response => {
      response.resume()
      response.once('end', () => { resolve(response.statusCode ?? 0) })
    })
    request.once('error', reject)
    request.end('{}')
  })
}

async function partialRequest(url: string, headers: Record<string, string>, body = '{', method = 'POST') {
  let request: ReturnType<typeof httpRequest> | undefined
  try {
    return await new Promise<{status: number; body: string; connection: string | undefined}>((resolve, reject) => {
      request = httpRequest(url, {method, headers}, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => {body += String(chunk)})
        response.once('error', reject)
        response.once('end', () => resolve({status: response.statusCode ?? 0, body, connection: response.headers.connection}))
      })
      request.once('error', reject)
      request.setTimeout(6500, () => request!.destroy(new Error('rejection did not arrive')))
      // Leave the body unfinished: rejection must reach the client before it stops uploading.
      request.write(body)
    })
  } finally {request?.destroy()}
}

function context(signal = new AbortController().signal): ExecutorDispatchContext {
  return {
    clock: new VirtualClock(), signal, progress: () => undefined,
    delegate: {
      delegate_id: 'knowledge-1', executor: 'mcp__nova_knowledge', op: MCP_KNOWLEDGE_RECALL,
      request: {query: 'where is the plan', k: 2}, origin_ref: 'conversation:1',
      deadline: 10, routing_class: 'user_awaited', dispatched_at: 0,
    },
  }
}

function structured(result: unknown): Record<string, unknown> {
  assert.equal(typeof result, 'object')
  assert.notEqual(result, null)
  const value = result as {readonly structuredContent?: unknown}
  assert.equal(typeof value.structuredContent, 'object')
  assert.notEqual(value.structuredContent, null)
  return value.structuredContent as Record<string, unknown>
}

test('knowledge adapter calls recall through its actual local MCP SDK client', async () => {
  const adapter = new KnowledgeMcpAdapter(backend())
  try {
    assert.equal(adapter.manifest.name, 'mcp__nova_knowledge')
    assert.deepEqual(adapter.manifest.ops.map(value => value.name), [MCP_KNOWLEDGE_RECALL])
    await adapter.connect()
    const handoff = await adapter.dispatch(MCP_KNOWLEDGE_RECALL, {query: 'where is the plan', k: 2}, context())
    assert.equal(handoff.outcome, 'ok')
    assert.equal(handoff.trust, 'untrusted_external')
    assert.deepEqual(handoff.content, {
      trust: 'untrusted_external',
      hits: [{locator: 'chunk:one', source_id: 'source:one', title: 'Result for where is the plan', heading_path: 'Root', text: 'Safe result.', score: 2}],
    })
  } finally { await adapter.close() }
})

test('knowledge MCP exposes only readonly tools and rejects invalid or unknown calls', async () => {
  const peer = await local()
  try {
    const listed = await peer.client.listTools()
    assert.deepEqual(listed.tools.map(tool => [tool.name, tool.annotations?.readOnlyHint]), [
      ['recall', true], ['get_chunk', true],
    ])
    assert.equal((await peer.client.callTool({name: 'write', arguments: {}})).isError, true)
    assert.equal((await peer.client.callTool({name: 'recall', arguments: {query: '', k: 1}})).isError, true)
    assert.equal((await peer.client.callTool({name: 'recall', arguments: {query: 'ok', k: 6}})).isError, true)
    assert.equal((await peer.client.callTool({name: 'recall', arguments: {query: 'ok', unexpected: true}})).isError, true)
    const chunk = await peer.client.callTool({name: 'get_chunk', arguments: {locator: 'chunk:one'}})
    assert.equal(chunk.isError, undefined)
    assert.ok(Array.isArray(chunk.content))
    assert.match((chunk.content[0] as {text: string}).text, /untrusted_external/u)
  } finally { await peer.close() }
})

test('get_chunk validates every status branch and stale carries current bounded text', async () => {
  const malicious = await local({
    recall: () => Promise.resolve([]),
    getChunk: () => Promise.resolve({status: 'token: private-value'} as never),
  })
  try { assert.equal((await malicious.client.callTool({name: 'get_chunk', arguments: {locator: 'chunk:one'}})).isError, true) }
  finally { await malicious.close() }
  const peer = await local({
    recall: () => Promise.resolve([]),
    getChunk: () => Promise.resolve({status: 'stale' as const, text: 'Current\ntext', title: 'Source', heading_path: 'Root', source_id: 'source:one'}),
  })
  try {
    const stale = structured(await peer.client.callTool({name: 'get_chunk', arguments: {locator: 'chunk:one'}}))
    assert.deepEqual(stale, {trust: 'untrusted_external', status: 'stale', locator: 'chunk:one', source_id: 'source:one', title: 'Source', heading_path: 'Root', text: 'Current\ntext', note: 'source_reindexed'})
  } finally { await peer.close() }
  const gone = await local({
    recall: () => Promise.resolve([]), getChunk: () => Promise.resolve({status: 'gone' as const, title: 'Retained source'}),
  })
  try { assert.deepEqual(structured(await gone.client.callTool({name: 'get_chunk', arguments: {locator: 'chunk:one'}})), {trust: 'untrusted_external', status: 'gone', title: 'Retained source'}) }
  finally { await gone.close() }
})

test('recall validates strict encoded SDK input but leaves sensitive query handling to its backend', async () => {
  let received = ''
  const adapter = new KnowledgeMcpAdapter({
    recall: query => { received = query; return Promise.resolve([{locator: 'chunk:one', source_id: 'source:one', title: 'Title', heading_path: 'Root', text: 'Line one\n\tLine two', score: 1}]) },
    getChunk: () => Promise.resolve({status: 'gone' as const}),
  })
  try {
    const handoff = await adapter.dispatch('recall', {query: '/etc/hosts'}, context())
    assert.equal(handoff.outcome, 'ok')
    assert.equal(received, '/etc/hosts')
    assert.deepEqual(handoff.content.hits, [{locator: 'chunk:one', source_id: 'source:one', title: 'Title', heading_path: 'Root', text: 'Line one\n\tLine two', score: 1}])
  } finally { await adapter.close() }
})

test('adapter refuses an empty direct recall request before backend dispatch', async () => {
  let calls = 0
  const adapter = new KnowledgeMcpAdapter({
    recall: () => { calls += 1; return Promise.resolve([]) }, getChunk: () => Promise.resolve({status: 'gone' as const}),
  })
  try {
    assert.equal((await adapter.dispatch('recall', {query: ''}, context())).outcome, 'refused')
    assert.equal(calls, 0)
  } finally { await adapter.close() }
})

test('loopback closes excess slow request bodies instead of leaving them outside its request bound', async () => {
  const loopback = await startKnowledgeMcpHttpServer(backend())
  const requests: ReturnType<typeof httpRequest>[] = []
  try {
    for (let index = 0; index < 8; index += 1) {
      const request = httpRequest(loopback.url, {method: 'POST', headers: {Authorization: `Bearer ${loopback.token}`, 'content-type': 'application/json'}})
      request.on('error', () => undefined)
      request.write('{')
      requests.push(request)
    }
    const excess = await partialRequest(loopback.url, {Authorization: `Bearer ${loopback.token}`})
    assert.deepEqual(excess, {status: 503, body: '{"error":"request_rejected"}', connection: 'close'})
  } finally {
    for (const request of requests) request.destroy()
    await loopback.close()
  }
})

test('a failed connect never replaces a successor opened after close', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Client.prototype, 'connect')
  assert.ok(descriptor !== undefined && typeof descriptor.value === 'function')
  const original = descriptor.value as Client['connect']
  let rejectFirst!: (error: Error) => void
  let first = true
  Object.defineProperty(Client.prototype, 'connect', {configurable: true, value: function (this: Client, ...args: Parameters<Client['connect']>) {
    if (first) { first = false; return new Promise<void>((_resolve, reject) => { rejectFirst = reject }) }
    return original.apply(this, args)
  }})
  const adapter = new KnowledgeMcpAdapter(backend())
  try {
    const initial = adapter.connect()
    await Promise.resolve()
    await adapter.close()
    const successor = adapter.connect()
    await Promise.resolve()
    const client = adapter.clientForTest()
    rejectFirst(new Error('initial failure'))
    await assert.rejects(initial)
    await successor
    assert.equal(adapter.clientForTest(), client)
  } finally {
    Object.defineProperty(Client.prototype, 'connect', {configurable: true, value: original})
    await adapter.close()
  }
})

test('loopback uses an absolute deadline for a continuously dripping request body', async () => {
  const loopback = await startKnowledgeMcpHttpServer(backend())
  try {
    await new Promise<void>((resolve, reject) => {
      const endpoint = new URL(loopback.url)
      const request = httpRequest(endpoint, {method: 'POST', headers: {
        Authorization: `Bearer ${loopback.token}`, 'content-type': 'application/json',
      }})
      const drip = setInterval(() => { if (!request.destroyed) request.write(' ') }, 100)
      const deadline = setTimeout(() => { request.destroy(); reject(new Error('absolute request deadline did not settle')) }, 6_500)
      request.once('error', error => { clearInterval(drip); clearTimeout(deadline); reject(error) })
      request.once('response', response => {
        clearInterval(drip); clearTimeout(deadline); response.resume()
        response.once('end', () => { assert.equal(response.statusCode, 408); resolve() })
      })
      request.write('{')
    })
  } finally { await loopback.close() }
})

test('HTTP rejects unfinished unauthorized, forbidden, and oversized bodies with complete responses', async () => {
  let calls = 0
  const loopback = await startKnowledgeMcpHttpServer({
    recall: () => {calls++; return Promise.resolve([])}, getChunk: () => {calls++; return Promise.resolve({status: 'gone'})},
  })
  const auth = {Authorization: `Bearer ${loopback.token}`}
  try {
    for (const [headers, method, body, status] of [
      [{}, 'POST', '{', 401],
      [{Authorization: 'Bearer wrong'}, 'POST', '{', 401],
      [{...auth, Host: 'evil.example'}, 'POST', '{', 403],
      [{...auth, Origin: 'http://evil.example'}, 'POST', '{', 403],
      [auth, 'PUT', '{', 405],
      [{...auth, 'content-length': '100'}, 'GET', '{', 413],
      [{...auth, 'content-length': '100'}, 'DELETE', '{', 413],
      [{...auth, 'content-length': '70000'}, 'POST', '{', 413],
      [{...auth, 'transfer-encoding': 'chunked'}, 'POST', 'x'.repeat(70000), 413],
    ] as const) {
      assert.deepEqual(await partialRequest(loopback.url, headers, body, method), {
        status, body: '{"error":"request_rejected"}', connection: 'close',
      })
    }
    assert.deepEqual(await partialRequest(`${loopback.url}/wrong`, auth), {
      status: 403, body: '{"error":"request_rejected"}', connection: 'close',
    })
    assert.equal(calls, 0)
  } finally {await loopback.close()}
})

test('knowledge adapter fails closed for malformed, oversized, secret-bearing, and aborted backend recall', async () => {
  const bad = (hit: unknown) => new KnowledgeMcpAdapter({
    recall: () => Promise.resolve([hit] as never),
    getChunk: () => Promise.resolve({status: 'gone' as const}),
  })
  for (const hit of [
    {locator: 'chunk:one', source_id: 'source:one', title: 'Title', heading_path: 'Root', text: 'x'.repeat(601), score: 1},
    {locator: 'chunk:one', source_id: 'source:one', title: 'Title', heading_path: 'Root', text: 'token: private-value', score: 1},
    {locator: 'chunk:one', source_id: 'source:one', title: '/Users/private/knowledge.md', heading_path: 'Root', text: 'Safe', score: 1},
    {locator: '/private/source', source_id: 'source:one', title: 'Title', heading_path: 'Root', text: 'Safe', score: 1},
    {locator: 'chunk:one', source_id: 'source:one', title: 'Title', heading_path: 'Root', text: 'Safe'},
  ]) {
    const adapter = bad(hit)
    try { assert.equal((await adapter.dispatch('recall', {query: 'ok'}, context())).outcome, 'failed') }
    finally { await adapter.close() }
  }
  const controller = new AbortController()
  const adapter = new KnowledgeMcpAdapter({
    recall: async (_query, _k, signal) => await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), {once: true})),
    getChunk: () => Promise.resolve({status: 'gone' as const}),
  })
  try {
    const pending = adapter.dispatch('recall', {query: 'ok'}, context(controller.signal))
    controller.abort()
    assert.equal((await pending).outcome, 'cancelled')
    assert.equal((await adapter.dispatch('write', {query: 'ok'}, context())).outcome, 'refused')
  } finally { await adapter.close() }
  const unavailable = new KnowledgeMcpAdapter({
    recall: () => Promise.reject(new Error('token: private-value')),
    getChunk: () => Promise.resolve({status: 'gone' as const}),
  })
  try {
    const handoff = await unavailable.dispatch('recall', {query: 'ok'}, context())
    assert.deepEqual(handoff.content, {error: 'knowledge_mcp_invalid_result'})
  } finally { await unavailable.close() }
})

test('knowledge HTTP loopback authenticates before parsing and serves actual SDK tools', async () => {
  const loopback = await startKnowledgeMcpHttpServer(backend())
  const auth = {Authorization: `Bearer ${loopback.token}`}
  const client = new Client({name: 'knowledge-http-test', version: '1'})
  const transport = new StreamableHTTPClientTransport(new URL(loopback.url), {requestInit: {headers: auth}})
  try {
    assert.equal((await fetch(loopback.url, {method: 'POST', headers: {'content-type': 'application/json'}, body: 'not-json'})).status, 401)
    assert.equal((await fetch(loopback.url, {method: 'POST', headers: {Authorization: 'Bearer wrong', 'content-type': 'application/json'}, body: '{}'})).status, 401)
    assert.equal(await postStatus(loopback.url, {...auth, Host: 'evil.example', 'content-type': 'application/json'}), 403)
    assert.equal((await fetch(loopback.url, {method: 'POST', headers: {...auth, Origin: 'http://evil.example'}, body: '{}'})).status, 403)
    assert.equal((await fetch(loopback.url, {method: 'POST', headers: {...auth, 'content-type': 'application/json'}, body: `{"x":"${'x'.repeat(70_000)}"}`})).status, 413)
    await client.connect(transport as Transport)
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['recall', 'get_chunk'])
    const recall = await client.callTool({name: 'recall', arguments: {query: 'where is the plan', k: 2}})
    assert.equal(recall.isError, undefined)
    const chunk = await client.callTool({name: 'get_chunk', arguments: {locator: 'chunk:one'}})
    assert.equal(chunk.isError, undefined)
  } finally {
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
    await loopback.close()
  }
})

test('real store stale chunks remain readable through MCP', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-knowledge-mcp-'))
  const store = new KnowledgeStoreClient({path: join(directory, 'knowledge.sqlite')})
  await store.open()
  const peer = await local({recall: (query, k) => store.recall(query, [1, 0], 'embed-a', k), getChunk: locator => store.getChunk(locator)})
  try {
    await store.replaceSource({source: {id: 'source-a', title: 'Source', kind: 'file', locator: '/tmp/notes.md', mime: 'text/plain', fingerprint: 'a', bytes: 10, created_at: 1, updated_at: 1, status: 'ready'}, provider_id: 'embed-a', dims: 2,
      chunks: [{heading_path: 'Root', text: 'Current text', token_estimate: 2, vector: [1, 0]}]})
    const [hit] = await store.recall('Current', [1, 0], 'embed-a', 1)
    assert.ok(hit)
    const locator = hit.locator.replace(/d=[^&]+/u, 'd=000000000000')
    const result = await peer.client.callTool({name: 'get_chunk', arguments: {locator}})
    assert.equal(result.isError, undefined)
    assert.deepEqual(structured(result), {trust: 'untrusted_external', status: 'stale', locator, source_id: 'source-a', title: 'Source', heading_path: 'Root', text: 'Current text', note: 'source_reindexed'})
  } finally {await peer.close(); await store.close(); await rm(directory, {recursive: true, force: true})}
})

test('real file reindex keeps the original MCP reference stale until source removal', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-knowledge-update-'))
  const file = join(directory, 'manual.md')
  const service = new KnowledgeService({store: new KnowledgeStoreClient({path: join(directory, 'knowledge.sqlite')}),
    embedding: {id: 'embed-a', dims: 2, embed: texts => Promise.resolve(texts.map(() => new Float32Array([1, 0])))}})
  await service.open()
  const peer = await local(service)
  try {
    await writeFile(file, '# Before\nOriginal content')
    await service.handle('knowledge.ingest', {kind: 'file', locator: file, consent: true})
    const hits = structured(await peer.client.callTool({name: 'recall', arguments: {query: 'Original'}})).hits as {locator: string; source_id: string}[]
    const hit = hits[0]!
    const before = (await service.listSources())[0]!
    await writeFile(file, '# After\nUpdated content')
    assert.deepEqual(await service.handle('knowledge.reindex', {id: hit.source_id, consent: true}), {ok: true, id: hit.source_id})
    const after = (await service.listSources())[0]!
    assert.equal(after.id, before.id)
    assert.notEqual(after.fingerprint, before.fingerprint)
    const current = structured(await peer.client.callTool({name: 'get_chunk', arguments: {locator: hit.locator}}))
    assert.equal(current.status, 'stale')
    assert.equal(current.title, 'manual.md')
    assert.equal(current.heading_path, 'After')
    assert.match(current.text as string, /Updated content/u)
    const next = structured(await peer.client.callTool({name: 'recall', arguments: {query: 'Updated'}})).hits as {locator: string}[]
    assert.notEqual(next[0]!.locator, hit.locator)
    assert.equal(structured(await peer.client.callTool({name: 'get_chunk', arguments: {locator: next[0]!.locator}})).status, 'ok')
    await service.handle('knowledge.remove', {id: hit.source_id})
    assert.equal(structured(await peer.client.callTool({name: 'get_chunk', arguments: {locator: hit.locator}})).status, 'gone')
  } finally {await peer.close(); await service.close(); await rm(directory, {recursive: true, force: true})}
})
