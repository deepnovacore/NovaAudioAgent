import assert from 'node:assert/strict'
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
    const chunk = await peer.client.callTool({name: 'get_chunk', arguments: {locator: 'chunk:one'}})
    assert.equal(chunk.isError, undefined)
    assert.ok(Array.isArray(chunk.content))
    assert.match((chunk.content[0] as {text: string}).text, /untrusted_external/u)
  } finally { await peer.close() }
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
