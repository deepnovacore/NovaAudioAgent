import assert from 'node:assert/strict'
import {test} from 'node:test'
import {parseCapabilityRegistry, mcpBackendAuthorized} from '../src/config/capability-registry.js'
import {CODING_BACKEND_IDS} from '../src/config/coding-backends.js'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js'
import {startLoopbackMcpServer} from '../src/mcp/http-server.js'
import {prepareAcpMcp} from '../src/executors/acp/mcp.js'
import {McpConnection} from '../src/executors/mcp-client.js'

test('legacy Codex grants never authorize another backend; explicit backend grants stay scoped', () => {
  const server = {transport: 'stdio', command: 'node', tools: {lookup: {enabled: true}}, exposeTo: {codex: true}}
  const legacy = parseCapabilityRegistry({version: 1, mcpServers: {lookup: server}}).mcpServers.lookup!
  assert.deepEqual(CODING_BACKEND_IDS.filter(id => mcpBackendAuthorized(legacy, id)), ['codex'])
  const registry = parseCapabilityRegistry({version: 1, mcpServers: {lookup: {
    ...server, exposeTo: {codex: false, backends: {opencode: true, deepseek: true}},
  }}})
  assert.deepEqual(CODING_BACKEND_IDS.filter(id => mcpBackendAuthorized(registry.mcpServers.lookup!, id)), ['opencode', 'deepseek'])
  const invalid = parseCapabilityRegistry({version: 1, mcpServers: {lookup: {
    ...server, exposeTo: {backends: {unknown: true}},
  }}})
  assert.equal(invalid.serverStatuses[0]?.status, 'failed')
  const malformedLegacy = parseCapabilityRegistry({version: 1, mcpServers: {lookup: {
    ...server, exposeTo: {codex: 'yes', backends: {codex: true}},
  }}})
  assert.equal(malformedLegacy.serverStatuses[0]?.status, 'failed')
  assert.throws(() => parseCapabilityRegistry({version: 1, modules: {knowledge: {
    exposeToCodex: 'yes', exposeToBackends: {codex: true},
  }}}))
})

test('ACP MCP proxy lists and executes only granted tools, and Pi refuses injection', async () => {
  const calls: string[] = []
  const upstream = await startLoopbackMcpServer(() => {
    const server = new Server({name: 'grant-test', version: '1'}, {capabilities: {tools: {}}})
    server.setRequestHandler(ListToolsRequestSchema, () => ({tools: ['allowed', 'secret'].map(name => ({
      name, inputSchema: {type: 'object', properties: {value: {type: 'string'}}, required: ['value'], additionalProperties: false},
    }))}))
    server.setRequestHandler(CallToolRequestSchema, request => {
      calls.push(request.params.name)
      return {content: [{type: 'text', text: 'called'}]}
    })
    return server
  })
  const registry = parseCapabilityRegistry({version: 1, mcpServers: {source: {
    transport: 'streamable-http', url: upstream.url,
    exposeTo: {codex: false, backends: {opencode: true, pi: true}}, tools: {allowed: {enabled: true}},
  }}})
  assert.ok(registry.mcpServers.source)
  const trusted = {source: {...registry.mcpServers.source, headers: {authorization: `Bearer ${upstream.token}`}}}
  let proxy: Awaited<ReturnType<typeof prepareAcpMcp>> | undefined
  let client: McpConnection | undefined
  try {
    await assert.rejects(prepareAcpMcp('pi', registry, trusted), /mcp_tools_not_isolated/u)
    proxy = await prepareAcpMcp('opencode', registry, trusted)
    const endpoint = proxy.servers[0]!
    assert.ok('type' in endpoint && endpoint.type === 'http')
    client = new McpConnection({...registry.mcpServers.source, url: endpoint.url,
      headers: Object.fromEntries(endpoint.headers.map(header => [header.name, header.value]))}, undefined, {trustedLoopback: true})
    assert.deepEqual((await client.discover()).map(tool => tool.name), ['allowed'])
    const options = {signal: new AbortController().signal, timeoutMs: 2000, maxBytes: 10000}
    await assert.rejects(client.call('secret', {value: 'x'}, options))
    await assert.rejects(client.call('allowed', {value: 1}, options))
    await client.call('allowed', {value: 'x'}, options)
    assert.deepEqual(calls, ['allowed'])
    const none = await prepareAcpMcp('deepseek', registry)
    assert.deepEqual(none.servers, [])
    await none.close()
  } finally {
    await client?.close()
    await proxy?.close()
    await upstream.close()
  }
})

test('knowledge grants are per backend; the legacy Codex grant stays Codex-only', () => {
  const legacy = parseCapabilityRegistry({version: 1, modules: {knowledge: {enabled: true, exposeToCodex: true}}})
  assert.equal(legacy.modules.knowledge.exposeToCodex, true)
  assert.equal(legacy.modules.knowledge.exposeToBackends, undefined)
  const scoped = parseCapabilityRegistry({version: 1, modules: {knowledge: {enabled: true, exposeToBackends: {opencode: true}}}})
  assert.equal(scoped.modules.knowledge.exposeToCodex, false)
  assert.deepEqual(scoped.modules.knowledge.exposeToBackends, {opencode: true})
  const entry = {enabled: true, transport: 'streamable-http' as const, url: 'http://127.0.0.1:1/mcp', tools: {},
    exposeTo: {frontbrain: false, codex: scoped.modules.knowledge.exposeToCodex, backends: scoped.modules.knowledge.exposeToBackends}}
  assert.deepEqual(CODING_BACKEND_IDS.filter(id => mcpBackendAuthorized(entry, id)), ['opencode'])
})
