import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {test} from 'node:test'
import {loadCapabilityRegistry, parseCapabilityRegistry, capabilityStatus, inspectCapabilities} from '../src/capability-registry.js'
import {settingsSchema} from '../src/config.js'
import {buildAssembly} from '../src/assembly.js'
import {buildProductionRealtimeAssembly} from '../src/production-realtime-assembly.js'
import {buildQwenRealtimeAssembly} from '../src/qwen-realtime-assembly.js'
import {frontendInstructions} from '../src/realtime/qwen.js'
import {CODEX_PROJECT_MANIFEST} from '../src/executors/codex/contract.js'

const settings = () => settingsSchema.parse({executors: [], model_api_key: 'test-only', dashscope_api_key: 'test-only'})
const server = {transport: 'streamable-http', url: 'https://example.test/mcp', tools: {lookup: {enabled: true}}}

test('registry default file absent is optional; explicit unreadable, malformed and invalid envelope fail redacted', () => {
  const home = mkdtempSync('/private/tmp/nova-capabilities-')
  try {
    const defaults = loadCapabilityRegistry({home, environment: {}})
    assert.deepEqual(defaults.modules, {search: {enabled: true, provider: 'tavily', tavily: {apiKeyEnv: 'TAVILY_API_KEY'}}, camera: {enabled: true}, coding: {enabled: true}, knowledge: {enabled: false, exposeToCodex: false}})
    assert.equal(defaults.frontbrainToolBudget, 24)
    assert.throws(() => loadCapabilityRegistry({home, path: join(home, 'private-secret'), environment: {}}), /file_unreadable_or_invalid_json/u)
    const path = join(home, 'config.json')
    writeFileSync(path, '{"secret": "not valid')
    assert.throws(() => loadCapabilityRegistry({path, environment: {}}), error => !String(error).includes('secret'))
    for (const document of [{}, {version: 2}, {version: 1, modules: {search: {enabled: 'false'}}}, {version: 1, modules: {extra: {}}}, {version: 1, extra: 'private-secret'}]) {
      assert.throws(() => parseCapabilityRegistry(document), /invalid capabilities configuration/u)
    }
  } finally { rmSync(home, {recursive: true, force: true}) }
})

test('registry module settings beat defaults and explicit env overrides beat registry without leaking secrets', () => {
  const registry = parseCapabilityRegistry({version: 1, modules: {camera: {enabled: false}, search: {provider: 'mcp', mcp: {
    url: 'https://example.test/${ENDPOINT}', tool: 'search', headers: {authorization: 'Bearer ${TOKEN}'},
  }}}}, {ENDPOINT: 'mcp', TOKEN: 'private-secret', NOVA_AUDIO_AGENT_CAMERA_MODULE_ENABLED: 'true', NOVA_AUDIO_AGENT_SEARCH_MCP_TOOL: 'lookup', NOVA_AUDIO_AGENT_SEARCH_MCP_URL: 'https://override.test/mcp'})
  assert.equal(registry.modules.camera.enabled, true)
  assert.equal(registry.modules.search.provider, 'mcp')
  assert.equal(registry.modules.search.mcp?.tool, 'lookup')
  assert.equal(registry.modules.search.mcp?.url, 'https://override.test/mcp')
  assert.equal(registry.modules.search.mcp?.headers.authorization, 'Bearer private-secret')
  assert.equal(JSON.stringify(capabilityStatus(registry)).includes('private-secret'), false)
  const tavily = parseCapabilityRegistry({version: 1, modules: {search: {provider: 'mcp'}}}, {NOVA_AUDIO_AGENT_SEARCH_PROVIDER: 'tavily'})
  assert.equal(tavily.modules.search.provider, 'tavily')
})

test('registry isolates malformed servers, enforces limits and defaults to explicit allowlists', () => {
  const registry = parseCapabilityRegistry({version: 1, mcpServers: {
    good: server, bad: {...server, tools: {lookup: {enabled: 'yes'}}}, 'invalid-secret-key!': server,
    dormant: {...server, enabled: false, headers: {authorization: '${MISSING}'}},
  }})
  assert.deepEqual(Object.keys(registry.mcpServers), ['good', 'dormant'])
  assert.deepEqual(registry.mcpServers.good?.exposeTo, {frontbrain: false, codex: true})
  assert.equal(registry.serverStatuses.filter(server => server.status === 'failed').length, 2)
  assert.equal(JSON.stringify(capabilityStatus(registry)).includes('invalid-secret-key!'), false)
  assert.throws(() => parseCapabilityRegistry({version: 1, mcpServers: Object.fromEntries(Array.from({length: 9}, (_, index) => [`s${index}`, server]))}), /max_8/u)
  const tooMany = parseCapabilityRegistry({version: 1, mcpServers: {many: {...server, tools: Object.fromEntries(Array.from({length: 33}, (_, index) => [`t${index}`, {enabled: true}]))}}})
  assert.equal(tooMany.serverStatuses[0]?.reason, 'server.tools:max_32')
  const explicit = parseCapabilityRegistry({version: 1, mcpServers: {good: {...server, tools: {lookup: {}}}}})
  assert.equal(explicit.mcpServers.good?.tools.lookup?.enabled, false)
})

test('interpolation, HTTPS and loopback auth policies fail closed without echoing values', () => {
  for (const url of ['http://remote.test/mcp', 'https://user:password@remote.test/mcp', 'https://remote.test/mcp#fragment']) {
    const registry = parseCapabilityRegistry({version: 1, mcpServers: {bad: {...server, url}}})
    assert.equal(registry.serverStatuses[0]?.status, 'failed')
  }
  for (const url of ['http://127.0.0.1/mcp', 'http://[::1]/mcp', 'http://localhost/mcp']) {
    assert.equal(parseCapabilityRegistry({version: 1, mcpServers: {local: {...server, url}}}).serverStatuses[0]?.status, 'configured')
    assert.equal(parseCapabilityRegistry({version: 1, mcpServers: {local: {...server, url, headers: {'x-api-key': 'private-secret'}}}}).serverStatuses[0]?.status, 'failed')
  }
  const missing = parseCapabilityRegistry({version: 1, mcpServers: {bad: {...server, headers: {authorization: '${TOKEN}'}}}})
  assert.equal(missing.serverStatuses[0]?.reason, 'missing_environment:TOKEN')
  const stdio = parseCapabilityRegistry({version: 1, mcpServers: {local: {transport: 'stdio', command: 'node', env: {TOKEN: '${TOKEN}'}}}}, {TOKEN: 'private-secret'})
  assert.equal(stdio.mcpServers.local?.env?.TOKEN, 'private-secret')
  assert.throws(() => parseCapabilityRegistry({version: 1, modules: {search: {provider: 'mcp'}}}), /missing_environment:DASHSCOPE_API_KEY/u)
})

test('disabled search and MCP search do not require Tavily; supplied settings never read ambient registry', async () => {
  const disabled = parseCapabilityRegistry({version: 1, modules: {search: {enabled: false, provider: 'mcp'}, camera: {enabled: false}}})
  const core = buildAssembly({settings: settings(), capabilities: disabled})
  assert.equal(core.runtime.executors.has('search'), false)
  assert.equal(core.tools.bindings.has('search__search'), false)
  assert.equal(core.visionController, undefined)
  await core.stop()
  const mcp = parseCapabilityRegistry({version: 1, modules: {search: {provider: 'mcp', mcp: {url: 'http://localhost/mcp'}}, camera: {enabled: false}}})
  const enabled = buildAssembly({settings: settings(), capabilities: mcp})
  assert.equal(enabled.runtime.executors.has('search'), true)
  await enabled.stop()
  const environment = process.env.NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG
  process.env.NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG = '/must-not-read'
  try {
    const injected = buildAssembly({settings: {...settings(), tavily_api_key: 'test-only'}, cameraModuleEnabled: false})
    assert.equal(injected.capabilities.modules.search.provider, 'tavily')
    await injected.stop()
  } finally {
    if (environment === undefined) delete process.env.NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG
    else process.env.NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG = environment
  }
})

test('production disables Coding by role and preserves Vision host tools; all controllers off leaves direct recall', async () => {
  for (const camera of [false, true]) {
    const capabilities = parseCapabilityRegistry({version: 1, modules: {coding: {enabled: false}, camera: {enabled: camera}, search: {enabled: false}}})
    const assembly = buildProductionRealtimeAssembly({settings: {...settings(), executors: ['codex']}, capabilities,
      codexResource: {adapter: {manifest: CODEX_PROJECT_MANIFEST}, mode: 'project', close: () => Promise.resolve()} as never,
    })
    assert.equal(assembly.runtime.executors.has('codex'), false)
    assert.equal(assembly.core.visionController !== undefined, camera)
    for (const tool of ['dispatch', 'cancel', 'confirm']) assert.equal(assembly.tools.bindings.has(tool), camera)
    assert.equal(assembly.tools.schemas.length, camera ? 5 : 1)
    await assembly.core.stop()
  }
})

test('final provider tool composition enforces exact N/B without partial exposure', () => {
  const capabilities = parseCapabilityRegistry({version: 1, frontbrainToolBudget: 1, modules: {search: {enabled: false}}})
  assert.throws(() => buildQwenRealtimeAssembly({settings: settings(), capabilities}), error => {
    assert.equal((error as {code: string}).code, 'frontbrain_tool_budget_exceeded')
    assert.match(String(error), /5\/1/u)
    return true
  })
  assert.throws(() => parseCapabilityRegistry({version: 1, frontbrainToolBudget: 0}), /frontbrainToolBudget/u)
})

test('disabled capability instruction sections are absent and doctor shares redacted validation', () => {
  const instructions = frontendInstructions({search: false, camera: false, coding: false})
  for (const phrase of ['搜索结果', 'Vision', 'Coding intake', '编程请求', '监控摄像头']) assert.equal(instructions.includes(phrase), false)
  const status = inspectCapabilities({environment: {NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG: '/private-secret/missing'}})
  assert.equal(status.ok, false)
  assert.equal(JSON.stringify(status).includes('private-secret'), false)
})

test('explicit null never restores registry defaults and malformed null servers remain isolated', () => {
  const invalid = [
    {modules: null}, {mcpServers: null}, {frontbrainToolBudget: null},
    ...['search', 'camera', 'coding', 'knowledge'].map(name => ({modules: {[name]: null}})),
    ...['provider', 'mcp', 'tavily', 'enabled'].map(field => ({modules: {search: {[field]: null}}})),
    ...['url', 'tool', 'headers', 'timeoutMs', 'maxResultBytes'].map(field => ({modules: {search: {mcp: {[field]: null}}}})),
    {modules: {search: {tavily: {apiKeyEnv: null}}}},
    {modules: {knowledge: {exposeToCodex: null}}},
  ]
  for (const document of invalid) {
    assert.throws(() => parseCapabilityRegistry({version: 1, ...document}), /invalid capabilities configuration/u, JSON.stringify(document))
    assert.throws(() => parseCapabilityRegistry({version: 1, ...document}, {
      NOVA_AUDIO_AGENT_SEARCH_PROVIDER: 'mcp',
      NOVA_AUDIO_AGENT_SEARCH_MCP_URL: 'https://example.test/mcp',
      NOVA_AUDIO_AGENT_SEARCH_MCP_TOOL: 'lookup',
    }), /invalid capabilities configuration/u, JSON.stringify(document))
  }
  for (const config of [
    ...['exposeTo', 'tools', 'headers', 'enabled'].map(field => ({...server, [field]: null})),
    ...['args', 'env'].map(field => ({transport: 'stdio', command: 'node', [field]: null})),
  ]) {
    const parsed = parseCapabilityRegistry({version: 1, mcpServers: {good: server, bad: config}})
    assert.equal(parsed.serverStatuses[1]?.status, 'failed', JSON.stringify(config))
    assert.deepEqual(Object.keys(parsed.mcpServers), ['good'])
  }
  assert.equal(parseCapabilityRegistry({version: 1}).modules.camera.enabled, true)
})
