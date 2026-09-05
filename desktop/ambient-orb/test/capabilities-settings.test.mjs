import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createSettingsWriter, DEFAULT_SETTINGS as SETTINGS_DEFAULTS} from '../src/main/settings-store.mjs'
import {prepareCapabilityCommit, readCapabilityEditor, publicCapabilityProbe, capabilityEnvironment} from '../src/main/capabilities-settings.mjs'

const codec = {available: () => false}
const document = {version: 1, modules: {search: {enabled: false}}, mcpServers: {}}
const fixture = async t => {
  const root = await mkdtemp('/private/tmp/nova-capability-save-')
  t.after(() => rm(root, {recursive: true, force: true}))
  return root
}
test('prepared writer rolls back exact proposed-path bytes when settings save fails', async t => {
  const root = await fixture(t)
  const oldPath = join(root, 'old.json'), nextPath = join(root, 'next.json')
  await writeFile(oldPath, 'old path untouched')
  await writeFile(nextPath, '  {"version": 1} \n')
  let current = {...SETTINGS_DEFAULTS, capabilitiesConfigPath: oldPath}
  const writer = createSettingsWriter({getCurrent: () => current, codec, commit: next => {current = next}, save: async () => {throw Error('disk')}})
  await assert.rejects(writer({capabilitiesConfigPath: nextPath}, next => prepareCapabilityCommit({settings: next, document, environment: {}})))
  assert.equal(await readFile(nextPath, 'utf8'), '  {"version": 1} \n')
  assert.equal(await readFile(oldPath, 'utf8'), 'old path untouched')
  assert.equal(current.capabilitiesConfigPath, oldPath)
  const absent = join(root, 'absent.json')
  await assert.rejects(writer({capabilitiesConfigPath: absent}, next => prepareCapabilityCommit({settings: next, document, environment: {}})))
  await assert.rejects(readFile(absent), {code: 'ENOENT'})
})
test('registry validation uses persistable secrets, rejects failed servers before either write', async t => {
  const root = await fixture(t), path = join(root, 'next.json')
  let writes = 0
  const writer = createSettingsWriter({getCurrent: () => ({...SETTINGS_DEFAULTS, capabilitiesConfigPath: path}), codec, commit: () => {}, save: async () => {writes++}})
  const requiringKey = {version: 1, modules: {search: {provider: 'mcp'}}}
  await assert.rejects(writer({secrets: {dashscopeApiKey: 'dummy-key'}}, next => prepareCapabilityCommit({settings: next, document: requiringKey, environment: capabilityEnvironment(next, {}, {}, requiringKey)})), {code: 'invalid_settings_commit'})
  assert.equal(writes, 0)
  await assert.rejects(readFile(path), {code: 'ENOENT'})
})
test('editor refuses unsafe disabled entries and preserves literal environment references', async t => {
  const root = await fixture(t), path = join(root, 'cap.json')
  for (const server of [
    {enabled: false, transport: 'stdio', command: 'tool', args: ['--token', 'dummy-raw-secret']},
    {enabled: false, transport: 'streamable-http', url: 'https://example.com/mcp', headers: {authorization: 'Bearer dummy-raw-secret'}},
  ]) {
    await writeFile(path, JSON.stringify({...document, mcpServers: {demo: server}}))
    const view = readCapabilityEditor({capabilitiesConfigPath: path}, {})
    assert.equal(view.document, null)
    assert.ok(!JSON.stringify(view).includes('dummy-raw-secret'))
  }
  const safe = {...document, mcpServers: {demo: {enabled: false, transport: 'stdio', command: 'tool', args: [], env: {API_KEY: '${API_KEY}'}}}}
  await writeFile(path, JSON.stringify(safe))
  assert.deepEqual(readCapabilityEditor({capabilitiesConfigPath: path}, {}).document, safe)
})
test('public probe refuses secret-bearing tool names, redacts descriptions and keeps identity', async () => {
  const config = {env: {TOKEN: 'dummy-secret-012345'}, tools: {}}
  const run = tools => publicCapabilityProbe(config, async () => ({status: 'ok', tools}))
  assert.equal((await run([{name: 'dummy-secret-012345', description: ''}])).reason, 'metadata_rejected')
  const safe = await run([{name: 'lookup.raw', description: 'value dummy-secret-012345', readOnlyHint: true}])
  assert.equal(safe.tools[0].name, 'lookup.raw')
  assert.ok(!JSON.stringify(safe).includes('dummy-secret-012345'))
})
test('Ark plus enabled MCP or knowledge independently exports DashScope only when needed', () => {
  const settings = {...SETTINGS_DEFAULTS, pipelineMode: 'cascaded', cascadedLlmProvider: 'ark'}
  const secrets = {dashscopeApiKey: 'dummy-dashscope', arkApiKey: 'dummy-ark'}
  assert.equal(capabilityEnvironment(settings, secrets, {}, document).DASHSCOPE_API_KEY, undefined)
  for (const doc of [{version: 1, modules: {search: {provider: 'mcp'}}}, {version: 1, modules: {search: {enabled: false}, knowledge: {enabled: true}}}]) {
    const env = capabilityEnvironment(settings, secrets, {}, doc)
    assert.equal(env.DASHSCOPE_API_KEY, 'dummy-dashscope')
    assert.equal(env.ARK_API_KEY, 'dummy-ark')
  }
})

test('combined operation validates settings, returns invalid/busy unchanged and distinguishes saved failures', async t => {
  const {applySettingsTransaction} = await import('../src/main/settings-apply.mjs')
  const {createLifecycleCoordinator} = await import('../src/main/lifecycle-coordinator.mjs')
  const {parseSettingsCommit, validatePreparedSettings} = await import('../src/main/capabilities-settings.mjs')
  const root = await fixture(t), path = join(root, 'cap.json')
  await writeFile(path, JSON.stringify(document))
  let current = {...SETTINGS_DEFAULTS, capabilitiesConfigPath: path}, saved = 0, published = 0
  const coordinator = createLifecycleCoordinator()
  const writer = createSettingsWriter({getCurrent: () => current, codec, commit: next => {current = next}, save: async () => {saved++}})
  const commit = {settingsPatch: {capabilitiesConfigPath: path}, capabilitiesDocument: {...document, modules: {...document.modules, camera: {enabled: false}}}}
  const options = {coordinator, patch: commit, write: async payload => {
    const parsed = parseSettingsCommit(payload)
    return writer(parsed.settingsPatch, next => {
      validatePreparedSettings(parsed.settingsPatch, next)
      return prepareCapabilityCommit({settings: next, document: parsed.capabilitiesDocument, environment: {}})
    })
  }, publishCommitted: () => {published++}, prepareConfiguration: async () => ({}), commitConfiguration: async () => ({}), restartBackend: async () => {}, publishStatus: () => {}}
  for (const payload of [null, [], {secrets: {}}, {settingsPatch: []}, {capabilitiesDocument: null}, {settingsPatch: {pipelineMode: 'invalid'}, capabilitiesDocument: document}, {settingsPatch: {}, capabilitiesDocument: {...document, mcpServers: {bad: {transport: 'invalid'}}}}]) {
    const result = await applySettingsTransaction({...options, patch: payload})
    assert.equal(result.operationStatus, 'invalid')
    assert.equal(result.saved, false)
  }
  assert.equal(saved, 0)
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(document))
  let release
  const active = coordinator.run('knowledge_reindex', () => new Promise(resolve => {release = resolve}))
  assert.equal((await applySettingsTransaction(options)).operationStatus, 'busy')
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(document))
  release(); await active
  for (const [failure, operationStatus] of [['prepareConfiguration', 'failed'], ['restartBackend', 'restart_failed']]) {
    const result = await applySettingsTransaction({...options, [failure]: async () => {throw Error('failure')}})
    assert.equal(result.saved, true); assert.equal(result.operationStatus, operationStatus)
  }
  assert.equal((await applySettingsTransaction(options)).operationStatus, 'applied')
  assert.equal(saved, 3); assert.equal(published, 3)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), commit.capabilitiesDocument)
})
test('actual launch and validator share capability credentials and new registry generation', async t => {
  const {backendLaunchSpec} = await import('../src/main/backend.mjs')
  const {parseCapabilityRegistry} = await import('@nova-audio-agent/runtime/desktop')
  const root = await fixture(t)
  const settings = {...SETTINGS_DEFAULTS, pipelineMode: 'cascaded', cascadedLlmProvider: 'ark', capabilitiesConfigPath: join(root, 'generation.json')}
  const doc = {version: 1, modules: {search: {enabled: false}, coding: {enabled: false}, camera: {enabled: false}}, mcpServers: {docs: {enabled: true, transport: 'streamable-http', url: 'https://example.com/mcp', headers: {authorization: 'Bearer ${DASHSCOPE_API_KEY}'}, tools: {}, exposeTo: {frontbrain: false, codex: true}}}}
  const decryptedSecrets = {dashscopeApiKey: 'dummy-dashscope', arkApiKey: 'dummy-ark'}
  const validation = capabilityEnvironment(settings, decryptedSecrets, {}, doc)
  const spec = backendLaunchSpec({nodeEntry: '/private/tmp/runtime.js', nodeResourcesPath: root, workspace: root, token: 'a'.repeat(32), readyEndpoint: '127.0.0.1:12345', parentEnv: {}, settings, decryptedSecrets, capabilitiesDocument: doc})
  assert.equal(spec.env.DASHSCOPE_API_KEY, validation.DASHSCOPE_API_KEY)
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG, settings.capabilitiesConfigPath)
  const registry = parseCapabilityRegistry(doc, spec.env)
  assert.equal(registry.modules.coding.enabled, false)
  assert.equal(registry.modules.camera.enabled, false)
  assert.equal(registry.mcpServers.docs.headers.authorization, 'Bearer dummy-dashscope')
})
test('safe raw URL and headers preserve templates and environment overrides remain visible', async t => {
  const root = await fixture(t), path = join(root, 'cap.json')
  const doc = {version: 1, modules: {search: {enabled: false}}, mcpServers: {docs: {enabled: false, transport: 'streamable-http', url: 'https://example.com/mcp?token=${DOCS_TOKEN}', headers: {authorization: 'Bearer ${DOCS_TOKEN}'}, tools: {}}}}
  await writeFile(path, JSON.stringify(doc))
  const view = readCapabilityEditor({capabilitiesConfigPath: path}, {NOVA_AUDIO_AGENT_SEARCH_PROVIDER: 'mcp'})
  assert.deepEqual(view.document, doc)
  assert.equal(view.status.modules.search.provider, 'mcp')
  assert.deepEqual(view.status.overrides, ['NOVA_AUDIO_AGENT_SEARCH_PROVIDER'])
})

test('all capability settings reach the public form and proposed snapshot validator', async () => {
  const {publicSettings} = await import('../src/main/settings-store.mjs')
  const {validatePreparedSettings} = await import('../src/main/capabilities-settings.mjs')
  const view = publicSettings(SETTINGS_DEFAULTS)
  for (const key of ['embeddingProvider', 'embeddingModel', 'capabilitiesConfigPath', 'knowledgePath']) assert.equal(view[key], SETTINGS_DEFAULTS[key])
  assert.doesNotThrow(() => validatePreparedSettings({embeddingProvider: 'dashscope', capabilitiesConfigPath: ''}, view))
})

test('safeStorage preparation encrypts once and the same accepted key validates and persists', async t => {
  const {readSecret} = await import('../src/main/settings-store.mjs')
  const root = await fixture(t), path = join(root, 'cap.json')
  let encrypted = 0, persisted
  const codec = {available: () => true, encrypt: value => {assert.equal(++encrypted, 1); return Buffer.from(value)}, decrypt: value => value.toString()}
  const writer = createSettingsWriter({getCurrent: () => ({...SETTINGS_DEFAULTS, capabilitiesConfigPath: path, pipelineMode: 'cascaded', cascadedLlmProvider: 'ark'}), codec, commit: () => {}, save: async next => {persisted = next}})
  const doc = {version: 1, modules: {search: {provider: 'mcp', mcp: {tool: 'bailian_web_search'}}}}
  await writer({secrets: {dashscopeApiKey: 'dummy-key-once'}}, next => prepareCapabilityCommit({settings: next, document: doc, environment: capabilityEnvironment(next, {dashscopeApiKey: readSecret(next, 'dashscopeApiKey', codec)}, {}, doc)}))
  assert.equal(encrypted, 1)
  assert.equal(readSecret(persisted, 'dashscopeApiKey', codec), 'dummy-key-once')
  assert.ok(!(await readFile(path, 'utf8')).includes('dummy-key-once'))
})

test('relative registry paths resolve identically for main validation and a different child cwd', async () => {
  const {backendLaunchSpec} = await import('../src/main/backend.mjs')
  const {capabilityPath} = await import('../src/main/capabilities-settings.mjs')
  const settings = {...SETTINGS_DEFAULTS, capabilitiesConfigPath: 'config/capabilities.json'}
  const spec = backendLaunchSpec({nodeEntry: '/private/tmp/runtime.js', nodeResourcesPath: '/private/tmp', workspace: '/private/tmp/other-workspace', token: 'a'.repeat(32), readyEndpoint: '127.0.0.1:12345', parentEnv: {}, settings})
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG, capabilityPath(settings))
})
