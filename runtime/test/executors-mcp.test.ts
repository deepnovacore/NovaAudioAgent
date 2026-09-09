import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {parseCapabilityRegistry} from '../src/capability-registry.js'
import {executorManifestSchema} from '../src/ports.js'
import {compileToolSchema} from '../src/tool-schema.js'

const manifest = (name = 'mcp__external') => executorManifestSchema.parse({
  name, display_name: 'External', roles: [], approvals: false, model_visibility: 'direct', probe_policy: 'none',
  ops: [{name: 'write', description: 'Write', params: {type: 'object', properties: {}}}],
  policy: {channel: name, priority: 40, wake: 'surrogate', typical_latency: 1, compress_watermark: 1000},
})
test('MCP probe none permits honest nonreadonly operations but native manifests retain their probe contract', () => {
  const external = manifest()
  assert.equal(compileToolSchema([external]).schemas.length, 1)
  assert.throws(() => compileToolSchema([manifest('native')]))
})
test('only actual host-owned external server keys are reserved and fail individually', () => {
  const config = {transport: 'stdio', command: 'unused'}
  const registry = parseCapabilityRegistry({version: 1, mcpServers: {nova_camera: config, nova_knowledge: config, nova_other: config}})
  assert.deepEqual(registry.serverStatuses.map(value => [value.name, value.status]), [
    ['nova_camera', 'failed'], ['nova_knowledge', 'failed'], ['nova_other', 'configured'],
  ])
})

import {createServer} from 'node:http'
import {randomUUID} from 'node:crypto'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {ListToolsRequestSchema, CallToolRequestSchema, type Tool, type CallToolResult} from '@modelcontextprotocol/sdk/types.js'
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js'
import {McpExecutorAdapter, mcpToolAlias, prepareExternalMcp} from '../src/executors/mcp.js'
import {McpConnection, probeMcpServer} from '../src/mcp-client.js'
import {VirtualClock} from '../src/clock.js'
import type {ExecutorDispatchContext} from '../src/causal-runtime.js'
import {buildAssembly} from '../src/assembly.js'
import {loadSettings} from '../src/config.js'
import {buildRealtimeAssembly, filterDisabledCoding} from '../src/realtime-assembly.js'
import type {RealtimeProvider} from '../src/realtime/protocol.js'
import {Memory} from '../src/memory.js'
import {compileContextView} from '../src/context-view.js'

const tool = (name = 'lookup', readonly = true): Tool => ({name, inputSchema: {type: 'object', properties: {value: {type: 'string'}}, required: ['value']}, annotations: {readOnlyHint: readonly}})
const enabled = {enabled: true, timeoutMs: 1000, maxResultBytes: 4096, maxCallsPerTurn: 2}
function registry(url: string, tools: Record<string, unknown> = {lookup: enabled}, other = {}) {
  return parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}, coding: {enabled: false}, camera: {enabled: false}},
    mcpServers: {external: {transport: 'streamable-http', url, exposeTo: {frontbrain: true}, tools}, ...other}})
}
async function localMcp(tools: readonly Tool[], result: (name: string, args: unknown) => CallToolResult | Promise<CallToolResult> = () => ({content: [{type: 'text', text: 'done'}]})) {
  const server = new Server({name: 'external-fixture', version: '1'}, {capabilities: {tools: {}}})
  let listed = 0; let called = 0; let deleted = 0
  server.setRequestHandler(ListToolsRequestSchema, () => { listed += 1; return {tools} })
  server.setRequestHandler(CallToolRequestSchema, request => {called += 1; return result(request.params.name, request.params.arguments)})
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator: randomUUID, enableJsonResponse: true})
  await server.connect(transport as Transport)
  const http = createServer((request, response) => {
    if (request.method === 'DELETE') deleted += 1
    void transport.handleRequest(request, response).catch(() => { if (!response.writableEnded) response.end() })
  })
  await new Promise<void>((resolve, reject) => {http.once('error', reject); http.listen(0, '127.0.0.1', resolve)})
  const address = http.address(); assert.ok(address !== null && typeof address !== 'string')
  return {url: `http://127.0.0.1:${address.port}/mcp`, stats: () => ({listed, called, deleted}),
    close: async () => {await server.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()))}}
}
function context(op = 'lookup', origin = 'conversation:1'): ExecutorDispatchContext {
  return {clock: new VirtualClock(), delegate: {delegate_id: randomUUID(), executor: 'mcp__external', op, request: {}, origin_ref: origin,
    deadline: 10, routing_class: 'user_awaited', dispatched_at: 0}, signal: new AbortController().signal, progress: () => undefined}
}

test('real HTTP discovers exact frontend allowlist, calls original alias, classifies only explicit readonly and closes', async () => {
  const original = 'Find.Document'
  const local = await localMcp([{...tool(original), description: '  '}, tool('write', false), tool('omitted')], (name, args) => {
    assert.equal(name, original); assert.deepEqual(args, {value: 'query'}); return {content: [{type: 'text', text: 'done'}]}
  })
  const source = registry(local.url, {[original]: enabled, write: {...enabled, timeoutMs: 10001}, omitted: {enabled: false}})
  const prepared = await prepareExternalMcp(source)
  try {
    assert.deepEqual(prepared.capabilities.serverStatuses, [{name: 'external', status: 'ok'}])
    const adapter = prepared.adapters[0]!
    assert.equal(adapter.manifest.ops.length, 2)
    assert.equal(adapter.manifest.ops[0]?.description, `MCP tool ${original} from external`)
    assert.deepEqual(adapter.manifest.roles, [])
    assert.equal(adapter.manifest.approvals, false)
    assert.equal(adapter.manifest.probe_policy, 'none')
    assert.equal(adapter.manifest.policy.priority, 40)
    assert.equal(adapter.manifest.ops[1]?.readonly, false)
    assert.equal(adapter.manifest.ops[1]?.sync_result, false)
    const alias = mcpToolAlias('external', original)
    assert.equal(adapter.manifest.tool_aliases?.[alias], original)
    const result = await adapter.dispatch(alias, {value: 'query'}, context(alias))
    assert.equal(result.outcome, 'ok'); assert.equal(result.trust, 'untrusted_external')
    assert.deepEqual(local.stats(), {listed: 1, called: 1, deleted: 0})
    const core = buildAssembly({settings: loadSettings({NOVA_AUDIO_AGENT_MODEL_API_KEY: 'fixture'}), externalMcp: prepared})
    assert.deepEqual(core.tools.schemas.map(schema => (schema.function as {name: string}).name).sort(), ['memory__recall', 'mcp__external__write', `mcp__external__${alias}`].sort())
    await core.stop()
    assert.equal(local.stats().deleted, 1)
  } finally {await prepared.close(); await local.close()}
})

test('stable alias budget uses real SHA256 collisions and rejects the complete server', () => {
  const server = 's'.repeat(32)
  const originals = ['knowledge-document-search-for-contract-2994', 'knowledge-document-search-for-contract-6008']
  assert.equal(mcpToolAlias(server, 'plain_name'), 'plain_name')
  assert.equal(mcpToolAlias(server, originals[0]!), 'knowledge_document_f6f262')
  assert.equal(`mcp__${server}__${mcpToolAlias(server, originals[0]!)}`.length, 64)
  assert.equal(mcpToolAlias(server, originals[0]!), mcpToolAlias(server, originals[1]!))
  for (const name of ['', '汉字', 'X', 'a'.repeat(200)]) assert.ok(`mcp__${server}__${mcpToolAlias(server, name)}`.length <= 64)
  const config = registry('http://127.0.0.1/mcp', Object.fromEntries(originals.map(name => [name, enabled]))).mcpServers.external!
  const connection = new McpConnection(config)
  assert.throws(() => new McpExecutorAdapter(server, config, connection, originals.map(name => tool(name))), /alias_collision/u)
})

test('metadata-only probe lists but never calls; malformed allowlist server fails independently and releases session', async () => {
  const bad = await localMcp([tool('other')]); const good = await localMcp([tool()])
  const config = registry(bad.url, {lookup: enabled}, {
    good: {transport: 'streamable-http', url: good.url, exposeTo: {frontbrain: true}, tools: {lookup: enabled}},
    disabled: {enabled: false, transport: 'stdio', command: '/must-not-exist', exposeTo: {frontbrain: true}},
    codex_only: {transport: 'stdio', command: '/must-not-exist', tools: {lookup: enabled}},
  })
  const prepared = await prepareExternalMcp(config)
  try {
    assert.deepEqual(prepared.adapters.map(adapter => adapter.server), ['good'])
    assert.deepEqual(prepared.capabilities.serverStatuses.map(status => status.status), ['failed', 'ok', 'disabled', 'configured'])
    assert.equal(bad.stats().deleted, 1); assert.equal(bad.stats().called, 0)
    const probe = await probeMcpServer({...config.mcpServers.good!, url: bad.url})
    // Session was deleted; this fixture intentionally cannot initialize twice. Failure is redacted.
    assert.equal(probe.status, 'failed'); assert.equal(bad.stats().called, 0)
  } finally {await prepared.close(); await bad.close(); await good.close()}
  const fresh = await localMcp([tool()])
  try {
    const probe = await probeMcpServer(registry(fresh.url).mcpServers.external!)
    assert.equal(probe.status, 'ok'); assert.deepEqual(probe.tools, [{name: 'lookup', description: '', readOnlyHint: true}]); assert.deepEqual(fresh.stats(), {listed: 1, called: 0, deleted: 1})
  } finally {await fresh.close()}
})

test('unsupported schema keywords, bad roots, nested reserved origin and missing annotations fail honestly', async () => {
  const config = registry('http://127.0.0.1/mcp').mcpServers.external!
  const connection = new McpConnection(config)
  for (const schema of [
    {type: 'array'}, {type: 'object', properties: {origin_ref: {type: 'string'}}},
    {type: 'object', properties: {}, allOf: []}, {type: 'object', properties: {value: {$ref: '#'}}},
    {type: 'object', properties: {value: {type: 'string', minLength: -1}}},
    {type: 'object', properties: {value: {type: 'object', properties: {origin_ref: {type: 'string'}}}}},
  ]) assert.throws(() => new McpExecutorAdapter('external', config, connection, [{...tool(), inputSchema: schema as Tool['inputSchema']}]), /incompatible_tool/u)
  const unknown = {...tool()}; delete unknown.annotations
  assert.equal(new McpExecutorAdapter('external', config, connection, [unknown]).manifest.ops[0]?.readonly, false)
  await connection.close()
})

test('SDK schema validator enforces nested types and numeric/string bounds before remote calls', async () => {
  const local = await localMcp([{...tool(), inputSchema: {type: 'object', properties: {value: {type: 'object', properties: {count: {type: 'integer', minimum: 1, maximum: 3}, text: {type: 'string', maxLength: 3}}, required: ['count']}}, required: ['value']}}])
  const prepared = await prepareExternalMcp(registry(local.url))
  try {
    const adapter = prepared.adapters[0]!
    assert.equal((await adapter.dispatch('lookup', {value: {count: 4}}, context())).content.code, 'invalid_params')
    assert.equal((await adapter.dispatch('lookup', {value: {count: 1, text: 'long'}}, context())).content.code, 'invalid_params')
    assert.equal((await adapter.dispatch('lookup', {value: {count: 1}}, context())).outcome, 'ok')
    assert.equal(local.stats().called, 1)
  } finally {await prepared.close(); await local.close()}
})

for (const authorityFirst of [true, false]) {
  test(`readonly quota shares the same origin with authority ${authorityFirst ? 'first' : 'second'}`, async () => {
    const config = registry('http://127.0.0.1/mcp', {lookup: {...enabled, maxCallsPerTurn: 1}}).mcpServers.external!
    const connection = new McpConnection(config)
    let called = 0
    connection.call = () => {called += 1; return Promise.resolve({content: []})}
    const adapter = new McpExecutorAdapter('external', config, connection, [tool()])
    const unscoped = context()
    const authorized = {...unscoped, userTurn: {originRef: unscoped.delegate.origin_ref, sessionEpoch: 1, acceptedUserInputRevision: 1, stillWanted: () => true}}
    try {
      const first = await adapter.dispatch('lookup', {value: 'x'}, authorityFirst ? authorized : unscoped)
      const second = await adapter.dispatch('lookup', {value: 'x'}, authorityFirst ? unscoped : authorized)
      assert.equal(first.outcome, 'ok')
      assert.deepEqual({outcome: second.outcome, code: second.content.code, called}, {outcome: 'refused', code: 'max_calls_per_turn', called: 1})
    } finally {await connection.close()}
  })
}

test('readonly quota survives fresh authority retirement while bounded history admits a fresh user turn', async () => {
  const config = registry('http://127.0.0.1/mcp', {lookup: {...enabled, maxCallsPerTurn: 1}}).mcpServers.external!
  const connection = new McpConnection(config)
  let called = 0
  connection.call = () => {called += 1; return Promise.resolve({content: []})}
  const adapter = new McpExecutorAdapter('external', config, connection, [tool()])
  const authorized = (origin: string, revision: number): ExecutorDispatchContext => ({...context('lookup', origin),
    userTurn: {originRef: origin, sessionEpoch: 1, acceptedUserInputRevision: revision, stillWanted: () => true}})
  try {
    assert.equal((await adapter.dispatch('lookup', {value: 'x'}, authorized('conversation:old', 1))).outcome, 'ok')
    for (let index = 0; index < 1023; index += 1) {
      assert.equal((await adapter.dispatch('lookup', {value: 'x'}, context('lookup', `conversation:pending-${index}`))).outcome, 'ok')
    }
    assert.equal((await adapter.dispatch('lookup', {value: 'x'}, context('lookup', 'conversation:overflow'))).content.code, 'turn_history_full')
    const fresh = authorized('conversation:pending-1022', 2)
    const replay = await adapter.dispatch('lookup', {value: 'x'}, fresh)
    assert.deepEqual({outcome: replay.outcome, code: replay.content.code, called}, {outcome: 'refused', code: 'max_calls_per_turn', called: 1024})
    assert.equal((await adapter.dispatch('lookup', {value: 'x'}, context('lookup', fresh.delegate.origin_ref))).content.code, 'max_calls_per_turn')
    assert.equal((await adapter.dispatch('lookup', {value: 'x'}, authorized('conversation:fresh', 3))).outcome, 'ok')
    assert.equal((await adapter.dispatch('lookup', {value: 'x'}, context('lookup', 'conversation:fresh'))).content.code, 'max_calls_per_turn')
    assert.equal(called, 1025)
  } finally {await connection.close()}
})

test('per-turn quotas, call deadline, result bytes, errors and concurrent HTTP cancellation remain independent', async () => {
  const local = await localMcp([tool()], async (_name, args) => {
    const value = (args as {value: string}).value
    if (value === 'wait') {await delay(180); return {content: []}}
    if (value === 'error') return {isError: true, content: [{type: 'text', text: 'private-secret'}]}
    return {content: [{type: 'text', text: value === 'large' ? 'x'.repeat(5000) : value === 'wire-large' ? 'x'.repeat(100000) : 'done'}]}
  })
  const prepared = await prepareExternalMcp(registry(local.url, {lookup: {...enabled, timeoutMs: 80}}))
  try {
    const adapter = prepared.adapters[0]!
    const pending = adapter.dispatch('lookup', {value: 'wait'}, context())
    const concurrent = await adapter.dispatch('lookup', {value: 'ok'}, context())
    assert.equal(concurrent.outcome, 'ok')
    assert.equal((await pending).content.code, 'timeout')
    assert.equal((await adapter.dispatch('lookup', {value: 'ok'}, context())).content.code, 'max_calls_per_turn')
    assert.equal((await adapter.dispatch('lookup', {value: 'large'}, context('lookup', 'conversation:2'))).content.code, 'response_too_large')
    assert.equal((await adapter.dispatch('lookup', {value: 'wire-large'}, context('lookup', 'conversation:wire'))).content.code, 'response_too_large')
    const error = await adapter.dispatch('lookup', {value: 'error'}, context('lookup', 'conversation:3'))
    assert.equal(error.content.code, 'tool_failed'); assert.equal(JSON.stringify(error).includes('private-secret'), false)
    const expired = context('lookup', 'conversation:4')
    assert.equal((await adapter.dispatch('lookup', {value: 'ok'}, {...expired, delegate: {...expired.delegate, deadline: 0}})).content.code, 'timeout')
  } finally {await prepared.close(); await local.close()}
})

test('nonreadonly calls fail closed without host origin and recheck wanted immediately before remote send', async () => {
  const local = await localMcp([tool('lookup', false)])
  const prepared = await prepareExternalMcp(registry(local.url))
  try {
    const adapter = prepared.adapters[0]!
    assert.equal((await adapter.dispatch('lookup', {value: 'x'}, context())).content.code, 'stale_user_origin')
    let wanted = true
    const ctx = {...context(), userTurn: {originRef: 'conversation:1', sessionEpoch: 1, acceptedUserInputRevision: 1, stillWanted: () => wanted},
      progress: () => {wanted = false}}
    assert.equal((await adapter.dispatch('lookup', {value: 'x'}, ctx)).content.code, 'stale_user_origin')
    assert.equal(local.stats().called, 0)
    wanted = true
    assert.equal((await adapter.dispatch('lookup', {value: 'x'}, {...ctx, progress: () => undefined})).outcome, 'ok')
    assert.equal(local.stats().called, 1)
  } finally {await prepared.close(); await local.close()}
})

test('probe none advertises no affordance even after unknown result with a readonly op present', () => {
  const external = manifest()
  const readonly = {...external, ops: external.ops.map(op => ({...op, readonly: true}))}
  const memory = new Memory({policies: [external.policy]})
  memory.append(external.name, {ts: 0, trust: 'untrusted_external', priority: 40, outcome: 'unknown', content: {op: 'write'}, refs: []})
  assert.deepEqual(compileContextView(memory, 'idle', 1, {manifests: [readonly]}).affordances.filter(value => value.source === 'probe'), [])
})

const fixtureProvider = (): RealtimeProvider => ({
  connect: () => Promise.resolve({epoch: 1, provider_session_id: 'fixture'}),
  sendAudio: () => Promise.resolve(),
  injectHostItem: item => Promise.resolve({session_epoch: 1, host_item_id: item.host_item_id, provider_item_id: `provider-${item.host_item_id}`}),
  createResponse: () => Promise.resolve(), cancelResponse: () => Promise.resolve(), close: () => Promise.resolve(),
  events: async function* (signal) { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true})) },
})
async function userTurn(service: ReturnType<typeof buildRealtimeAssembly>['service'], id: string) {
  await service.handleEvent({kind: 'user_speech_started', session_epoch: 1, speech_id: `speech-${id}`, provider_item_id: `user-${id}`})
  await service.handleEvent({kind: 'user_speech_ended', session_epoch: 1, speech_id: `speech-${id}`, provider_item_id: `user-${id}`})
  await service.handleEvent({kind: 'user_transcript_final', session_epoch: 1, item_id: `user-${id}`, text: 'do the external operation'})
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: `response-${id}`})
}
async function toolCall(service: ReturnType<typeof buildRealtimeAssembly>['service'], id: string) {
  await service.handleEvent({kind: 'tool_call_ready', session_epoch: 1, call_id: `call-${id}`, item_id: `tool-${id}`, name: 'mcp__external__lookup', arguments: {value: id}, response_id: `response-${id}`})
}

test('real service carries private origin through queued dispatch; local onset during async delay prevents write and fresh transcript restores it', async () => {
  const local = await localMcp([tool('lookup', false)])
  const prepared = await prepareExternalMcp(registry(local.url))
  const adapter = prepared.adapters[0]!
  const originalDispatch = adapter.dispatch.bind(adapter)
  let release!: () => void; let entered!: () => void
  const started = new Promise<void>(resolve => {entered = resolve})
  const pending = new Promise<void>(resolve => {release = resolve})
  let captured: ExecutorDispatchContext | undefined
  adapter.dispatch = async (op, args, ctx) => {captured = ctx; entered(); await pending; return originalDispatch(op, args, ctx)}
  const core = buildAssembly({settings: loadSettings({NOVA_AUDIO_AGENT_MODEL_API_KEY: 'fixture'}), externalMcp: prepared})
  const assembly = buildRealtimeAssembly({core, provider: fixtureProvider(), onDiagnostic: () => undefined})
  try {
    await assembly.start()
    await userTurn(assembly.service, 'old')
    await toolCall(assembly.service, 'old')
    await Promise.race([started, delay(1000).then(() => {throw new Error('dispatch not started')})])
    assert.ok(captured?.userTurn?.stillWanted())
    await assembly.service.localSpeechOnset('new-local-onset')
    assert.equal(captured?.userTurn?.stillWanted(), false)
    release()
    await delay(25)
    assert.equal(local.stats().called, 0)
    assert.equal(JSON.stringify(captured.delegate).includes('stillWanted'), false)
    await assembly.service.handleEvent({kind: 'response_terminal', session_epoch: 1, response_id: 'response-old', status: 'cancelled', reason: ''})
    // Complete the host-created result continuation before the next user response.
    await assembly.service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'result-continuation'})
    await assembly.service.handleEvent({kind: 'response_terminal', session_epoch: 1, response_id: 'result-continuation', status: 'completed', reason: ''})
    adapter.dispatch = originalDispatch
    await userTurn(assembly.service, 'fresh')
    await toolCall(assembly.service, 'fresh')
    for (let i = 0; i < 30 && local.stats().called === 0; i += 1) await delay(10)
    assert.equal(local.stats().called, 1, JSON.stringify(assembly.service.toolCallAcceptances()))
  } finally {release(); await assembly.stop(); await prepared.close(); await local.close()}
})

async function stdioFixture(mode = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'nova-external-mcp-'))
  const path = join(directory, 'server.mjs')
  const marker = join(directory, 'pid')
  // dist/test is one level deeper; resolve from the repository path, never a user config or secret.
  const sdkRoot = new URL('../../../node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url).href
  await writeFile(path, `import {Server} from ${JSON.stringify(sdkRoot + 'server/index.js')};
    import {StdioServerTransport} from ${JSON.stringify(sdkRoot + 'server/stdio.js')};
    import {ListToolsRequestSchema, CallToolRequestSchema} from ${JSON.stringify(sdkRoot + 'types.js')};
    import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    process.stderr.write('private-secret\\n'.repeat(10000));
    const server = new Server({name:'stdio-fixture',version:'1'}, {capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema, () => ${JSON.stringify(mode)} === 'hang-list' ? new Promise(()=>{}) : ({tools:[{name:'lookup', inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},annotations:{readOnlyHint:true}}]}));
    server.setRequestHandler(CallToolRequestSchema, () => {
      if (${JSON.stringify(mode)} === 'overflow') {process.stdout.write('x'.repeat(2*1024*1024)); return new Promise(()=>{});}
      return {content:[],structuredContent:{hasAmbient:Object.hasOwn(process.env,'NOVA_MCP_TEST_AMBIENT_SECRET'), configured:process.env.FIXTURE_VALUE, hasPath:!!process.env.PATH}};
    });
    await server.connect(new StdioServerTransport());`)
  return {directory, path, marker, config: {transport: 'stdio', command: process.execPath, args: [path], env: {FIXTURE_VALUE: 'configured'}, exposeTo: {frontbrain: true}, tools: {lookup: enabled}}}
}

test('real SDK stdio lists/calls, safely inherits environment, drains stderr and terminates its child', async () => {
  const fixture = await stdioFixture()
  const before = process.env.NOVA_MCP_TEST_AMBIENT_SECRET
  process.env.NOVA_MCP_TEST_AMBIENT_SECRET = 'ambient-private'
  const prepared = await prepareExternalMcp(parseCapabilityRegistry({version: 1, mcpServers: {external: fixture.config}}))
  try {
    assert.equal(prepared.adapters.length, 1, JSON.stringify(prepared.capabilities.serverStatuses))
    const result = await prepared.adapters[0]!.dispatch('lookup', {value: 'x'}, context())
    assert.deepEqual((result.content.result as {structuredContent: unknown}).structuredContent, {hasAmbient: false, configured: 'configured', hasPath: true})
    const pid = Number(await readFile(fixture.marker, 'utf8'))
    await prepared.close()
    assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'})
  } finally {
    if (before === undefined) delete process.env.NOVA_MCP_TEST_AMBIENT_SECRET; else process.env.NOVA_MCP_TEST_AMBIENT_SECRET = before
    await prepared.close(); await rm(fixture.directory, {recursive: true, force: true})
  }
})

test('stdio protocol buffer overflow is bounded, redacted and child is cleaned up', async () => {
  const fixture = await stdioFixture('overflow')
  const prepared = await prepareExternalMcp(parseCapabilityRegistry({version: 1, mcpServers: {external: fixture.config}}))
  try {
    const result = await prepared.adapters[0]!.dispatch('lookup', {value: 'x'}, context())
    assert.notEqual(result.outcome, 'ok'); assert.equal(JSON.stringify(result).includes('private-secret'), false)
    assert.equal(prepared.capabilities.serverStatuses[0]?.status, 'failed')
    await prepared.close()
    const pid = Number(await readFile(fixture.marker, 'utf8'))
    for (let i = 0; i < 40; i += 1) {
      try {process.kill(pid, 0); await delay(10)} catch {break}
    }
    assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'})
  } finally {await prepared.close(); await rm(fixture.directory, {recursive: true, force: true})}
})

test('actual desktop entry awaits discovery and owns cleanup when final exact frontend budget rejects construction', async () => {
  const local = await localMcp([tool()])
  const configUrl = new URL('../src/config.js', import.meta.url).href
  const registryUrl = new URL('../src/capability-registry.js', import.meta.url).href
  const desktopUrl = new URL('../src/desktop-service.js', import.meta.url).href
  const document = {version: 1, frontbrainToolBudget: 1, modules: {search: {enabled: false}, coding: {enabled: false}, camera: {enabled: false}},
    mcpServers: {external: {transport: 'streamable-http', url: local.url, exposeTo: {frontbrain: true}, tools: {lookup: enabled}}}}
  const replacements = {
    './config.js': `import {loadSettings as load} from ${JSON.stringify(configUrl)}; export {requireIntegratedRealtime} from ${JSON.stringify(configUrl)}; export function loadSettings() {return {...load({NOVA_AUDIO_AGENT_MODEL_API_KEY:'fixture', DASHSCOPE_API_KEY:'fixture'}),executors:[]}}`,
    './capability-registry.js': `import {parseCapabilityRegistry} from ${JSON.stringify(registryUrl)}; export function loadCapabilityRegistry() {return parseCapabilityRegistry(${JSON.stringify(document)})}`,
    './desktop-service.js': `export {buildDesktopRealtimeComposition} from ${JSON.stringify(desktopUrl)};
      export async function runDesktopEntryWithStopSources({construct}) {
        const owned=[]; try {await construct({own:close=>owned.push(close)}); throw new Error('expected budget rejection');}
        catch(error) {if(error.code!=='frontbrain_tool_budget_exceeded'||error.toolCount!==2||error.toolBudget!==1) throw error; process.stdout.write('budget 2/1');}
        finally {for(const close of owned.reverse()) await close();} return 0;
      }`,
    './realtime/telemetry.js': `export function createRealtimeTelemetry() {return {close(){},record(){}}}`,
  }
  const hook = `export async function resolve(specifier,context,next) {
    const replacements=${JSON.stringify(replacements)};
    if(['/desktop-entry.js','/production-composition.js'].some(path=>context.parentURL?.endsWith(path))&&replacements[specifier]) return {url:'data:text/javascript,'+encodeURIComponent(replacements[specifier]),shortCircuit:true};
    return next(specifier,context);
  }`
  const script = `import {register} from 'node:module'; register('data:text/javascript,'+encodeURIComponent(${JSON.stringify(hook)}),import.meta.url); await import(${JSON.stringify(new URL('../src/desktop-entry.js', import.meta.url).href)});`
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'pipe'], env: {PATH: process.env.PATH!, NOVA_AUDIO_AGENT_DESKTOP_TOKEN: 'a'.repeat(32)}})
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => {stdout += String(chunk)}); child.stderr.on('data', chunk => {stderr += String(chunk)})
    const result = await new Promise<number | null>((resolve, reject) => {child.on('error', reject); child.on('exit', resolve)})
    assert.equal(result, 0, stderr); assert.equal(stdout, 'budget 2/1')
    assert.deepEqual(local.stats(), {listed: 1, called: 0, deleted: 1})
  } finally {await local.close()}
})

test('startup cancellation closes a real stdio child stuck in tools/list without executing any tool', {timeout: 20_000}, async () => {
  const fixture = await stdioFixture('hang-list')
  const abort = new AbortController()
  const pending = prepareExternalMcp(parseCapabilityRegistry({version: 1, mcpServers: {external: fixture.config}}), abort.signal)
  let discoverySettled = false
  void pending.finally(() => { discoverySettled = true }).catch(() => undefined)
  try {
    let pid = 0
    // Discovery already owns a bounded startup deadline; do not add a one-second cold-load race.
    while (pid === 0 && !discoverySettled) {
      try {pid = Number(await readFile(fixture.marker, 'utf8'))} catch {await delay(10)}
    }
    assert.ok(pid > 0, 'bounded discovery ended before the fixture started')
    abort.abort()
    const prepared = await pending
    assert.deepEqual(prepared.adapters, [])
    assert.equal(prepared.capabilities.serverStatuses[0]?.status, 'failed')
    assert.equal(prepared.capabilities.serverStatuses[0]?.reason, 'discovery_cancelled')
    assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'})
    await prepared.close()
  } finally {abort.abort(); await pending; await rm(fixture.directory, {recursive: true, force: true})}
})

test('enabled frontend servers require prepared discovery and prepared registry supplies module gates', async () => {
  const capabilities = registry('http://127.0.0.1/mcp')
  const settings = loadSettings({NOVA_AUDIO_AGENT_MODEL_API_KEY: 'fixture'})
  assert.throws(() => buildAssembly({settings, capabilities}), /external_mcp_discovery_required/u)
  const prepared = await prepareExternalMcp(parseCapabilityRegistry({version: 1, modules: {coding: {enabled: false}}}))
  try {
    const options: Parameters<typeof buildAssembly>[0] = filterDisabledCoding({settings, externalMcp: prepared})
    assert.equal(options.capabilities, prepared.capabilities)
    assert.equal(options.capabilities?.modules.coding.enabled, false)
  } finally {await prepared.close()}
})

test('unselected remote output schemas never compile or suppress a valid allowlisted tool', async () => {
  const local = await localMcp([tool(), {...tool('omitted'), outputSchema: {type: 'object', properties: {value: {type: 'string', pattern: '['}}}}])
  const prepared = await prepareExternalMcp(registry(local.url))
  try {
    assert.equal(prepared.adapters.length, 1, JSON.stringify(prepared.capabilities.serverStatuses))
    assert.equal((await prepared.adapters[0]!.dispatch('lookup', {value: 'ok'}, context())).outcome, 'ok')
    assert.equal(local.stats().called, 1)
  } finally {await prepared.close(); await local.close()}
})

test('discovery preserves redacted authentication failure instead of relabeling cleanup as timeout', async () => {
  const server = createServer((_request, response) => {response.writeHead(401); response.end('private-secret')})
  await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve)})
  const address = server.address(); assert.ok(address !== null && typeof address !== 'string')
  try {
    const prepared = await prepareExternalMcp(registry(`http://127.0.0.1:${address.port}/mcp`))
    assert.deepEqual(prepared.capabilities.serverStatuses, [{name: 'external', status: 'failed', reason: 'authentication'}])
    assert.deepEqual(prepared.adapters, [])
    await prepared.close()
  } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))}
})
