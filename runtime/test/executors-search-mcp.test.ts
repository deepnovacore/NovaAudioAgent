import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {randomUUID} from 'node:crypto'
import {test} from 'node:test'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult} from '@modelcontextprotocol/sdk/types.js'
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js'
import {McpSearchTransport} from '../src/executors/search-mcp.js'
import {SearchAdapter} from '../src/executors/search.js'
import {VirtualClock} from '../src/clock.js'
import type {ExecutorDispatchContext} from '../src/causal-runtime.js'

async function localMcp(result: (args: unknown) => CallToolResult | Promise<CallToolResult>, name = 'web_search', hangDelete = false) {
  const server = new Server({name: 'local-search-test', version: '1'}, {capabilities: {tools: {}}})
  let listed = 0
  let called = 0
  let deleted = 0
  server.setRequestHandler(ListToolsRequestSchema, () => {
    listed += 1
    return {tools: [{name, inputSchema: {type: 'object', properties: {search_query: {type: 'string'}, top_k: {type: 'integer'}}, required: ['search_query']}}]}
  })
  server.setRequestHandler(CallToolRequestSchema, request => { called += 1; return result(request.params.arguments) })
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator: randomUUID, enableJsonResponse: true})
  await server.connect(transport as Transport)
  const http = createServer((request, response) => {
    if (request.method === 'DELETE') {
      deleted += 1
      if (hangDelete) return
    }
    void transport.handleRequest(request, response).catch(() => { if (!response.writableEnded) response.end() })
  })
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  const address = http.address()
  assert.ok(address !== null && typeof address !== 'string')
  return {url: `http://127.0.0.1:${address.port}/mcp`, stats: () => ({listed, called, deleted}),
    close: async () => { await server.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())) }}
}
function transport(url: string, overrides = {}) { return new McpSearchTransport({url, tool: 'web_search', headers: {}, timeoutMs: 1000, maxResultBytes: 16384, ...overrides}) }

test('real local MCP tools/list and tools/call infer parameters, preserve canonical evidence and cleanup', async () => {
  const local = await localMcp(args => {
    assert.deepEqual(args, {search_query: 'Nova', top_k: 3})
    return {content: [], structuredContent: {data: {search_results: [{title: 'Nova', link: 'https://www.example.com/news#fragment', description: 'Nova evidence'}]}}}
  })
  try {
    const search = transport(local.url)
    const ctx = {clock: new VirtualClock(), delegate: {delegate_id: 'search-test', executor: 'search', op: 'search', request: {query: 'Nova', k: 3}, origin_ref: 'user-test', deadline: 10, routing_class: 'user_awaited', dispatched_at: 0}, signal: new AbortController().signal, progress: () => undefined} as ExecutorDispatchContext
    const result = await new SearchAdapter(search).dispatch('search', {query: 'Nova', k: 3}, ctx)
    assert.equal(result.outcome, 'ok')
    assert.equal(result.trust, 'untrusted_external')
    assert.equal(result.content.provider, 'mcp')
    const results = result.content.results as {canonical_url: string; content_digest: string; evidence_ref: string}[]
    assert.equal(results[0]?.canonical_url, 'https://www.example.com/news')
    assert.match(results[0].content_digest, /^[a-f0-9]{64}$/u)
    assert.match(results[0].evidence_ref, /^web\.search:\/\/evidence\//u)
    assert.deepEqual(local.stats(), {listed: 1, called: 1, deleted: 1})
    await search.close()
    await assert.rejects(search.search('Nova', {maxResults: 1}), /transport_closed/u)
  } finally { await local.close() }
})

test('MCP text JSON and text links normalize through the existing SearchAdapter shape', async () => {
  for (const body of ['[Source](https://example.com/source) describes Nova.', JSON.stringify({results: [{name: 'Source', href: 'https://example.com/source', text: 'Nova description'}]})]) {
    const local = await localMcp(() => ({content: [{type: 'text', text: body}]}))
    try {
      const value = await transport(local.url).search('Nova', {maxResults: 1})
      assert.equal((value.results as {url: string}[])[0]?.url, 'https://example.com/source')
      assert.equal(local.stats().deleted, 1)
    } finally { await local.close() }
  }
})

test('missing tools and tool errors fail redacted and release MCP sessions', async () => {
  for (const missing of [false, true]) {
    const local = await localMcp(() => ({isError: true, content: [{type: 'text', text: 'private-secret'}]}), missing ? 'other' : 'web_search')
    try {
      await assert.rejects(transport(local.url).search('Nova', {maxResults: 1}), error => {
        assert.match(String(error), missing ? /search_tool_missing/u : /search_tool_failed/u)
        assert.equal(String(error).includes('private-secret'), false)
        return true
      })
      assert.equal(local.stats().called, missing ? 0 : 1)
      assert.equal(local.stats().deleted, 1)
    } finally { await local.close() }
  }
})

test('MCP response bytes and total request time are bounded; shutdown aborts active work', async () => {
  const large = await localMcp(() => ({content: [{type: 'text', text: 'x'.repeat(4096)}]}))
  try { await assert.rejects(transport(large.url, {maxResultBytes: 2048}).search('Nova', {maxResults: 1}), /response_too_large/u) }
  finally { await large.close() }
  for (const shutdown of [false, true]) {
    const local = await localMcp(() => new Promise<CallToolResult>(() => undefined))
    const search = transport(local.url, {timeoutMs: 80})
    try {
      const pending = search.search('Nova', {maxResults: 1})
      if (shutdown) setTimeout(() => { void search.close() }, 20)
      await assert.rejects(pending, /timeout/u)
      await search.close()
      assert.equal(local.stats().deleted, 1)
    } finally { await local.close() }
  }
})

test('remote session termination has its own bound and never masks the primary search failure', async () => {
  const local = await localMcp(() => ({isError: true, content: [{type: 'text', text: 'private-secret'}]}), 'web_search', true)
  try {
    const started = Date.now()
    await assert.rejects(transport(local.url).search('Nova', {maxResults: 1}), /search_tool_failed/u)
    assert.ok(Date.now() - started < 1500)
    assert.equal(local.stats().deleted, 1)
  } finally { await local.close() }
})
