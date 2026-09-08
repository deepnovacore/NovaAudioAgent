import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createSettingsWriter, DEFAULT_SETTINGS as SETTINGS_DEFAULTS} from '../src/main/settings-store.mjs'
import {prepareCapabilityCommit, readCapabilityDocument, readCapabilityEditor, publicCapabilityProbe, capabilityEnvironment, capabilityDocumentRevision} from '../src/main/capabilities-settings.mjs'

const codec = {available: () => false}
const document = {version: 1, modules: {search: {enabled: false}}, mcpServers: {}}
const fixture = async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-capability-save-'))
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
test('capability commit rejects a stale editor revision without replacing an external edit', async t => {
  const root = await fixture(t), path = join(root, 'cap.json')
  const base = {version: 1, frontbrainToolBudget: 4}
  const external = {version: 1, frontbrainToolBudget: 5}
  await writeFile(path, JSON.stringify(base))
  const revision = capabilityDocumentRevision({capabilitiesConfigPath: path})
  await writeFile(path, JSON.stringify(external))
  await assert.rejects(
    prepareCapabilityCommit({settings: {capabilitiesConfigPath: path}, document: {version: 1, frontbrainToolBudget: 6}, expectedRevision: revision}),
    error => error?.code === 'invalid_settings_commit' && error.problems?.includes('capabilities_document_changed'),
  )
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), external)
})
test('capability commit moves a displayed registry to a new missing path without overwriting an existing target', async t => {
  const root = await fixture(t)
  const sourcePath = join(root, 'source.json'), missingPath = join(root, 'missing.json'), existingPath = join(root, 'existing.json')
  const sourceSettings = {capabilitiesConfigPath: sourcePath}
  const document = {version: 1, modules: {search: {enabled: false}}, frontbrainToolBudget: 6}
  await writeFile(sourcePath, JSON.stringify({version: 1, modules: {search: {enabled: false}}, frontbrainToolBudget: 4}))
  const revision = capabilityDocumentRevision(sourceSettings)
  await prepareCapabilityCommit({settings: {capabilitiesConfigPath: missingPath}, sourceSettings, document, expectedRevision: revision})
  assert.deepEqual(JSON.parse(await readFile(missingPath, 'utf8')), document)
  assert.equal(JSON.parse(await readFile(sourcePath, 'utf8')).frontbrainToolBudget, 4)
  await writeFile(existingPath, JSON.stringify({version: 1, modules: {search: {enabled: false}}, frontbrainToolBudget: 5}))
  await assert.rejects(
    prepareCapabilityCommit({settings: {capabilitiesConfigPath: existingPath}, sourceSettings, document, expectedRevision: revision}),
    error => error?.code === 'invalid_settings_commit' && error.problems?.includes('capabilities_document_changed'),
  )
  assert.equal(JSON.parse(await readFile(existingPath, 'utf8')).frontbrainToolBudget, 5)
})
test('capability commit accepts a revision for malformed prior bytes and replaces them deliberately', async t => {
  const root = await fixture(t), path = join(root, 'cap.json')
  await writeFile(path, '{not json')
  const revision = capabilityDocumentRevision({capabilitiesConfigPath: path})
  const editor = readCapabilityEditor({capabilitiesConfigPath: path})
  assert.equal(editor.document, null)
  assert.equal(editor.revision, revision)
  await prepareCapabilityCommit({settings: {capabilitiesConfigPath: path}, document: {version: 1, modules: {search: {enabled: false}}}, expectedRevision: revision})
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {version: 1, modules: {search: {enabled: false}}})
})
test('capability commit screens referenced environment credentials before writing', async t => {
  const root = await fixture(t), path = join(root, 'cap.json')
  const environment = {TOKEN: 'unlabelled-credential-value'}
  await assert.rejects(
    prepareCapabilityCommit({settings: {capabilitiesConfigPath: path}, document: {version: 1, modules: {search: {enabled: false}}, mcpServers: {demo: {enabled: false, transport: 'stdio', command: 'tool', args: ['--key', '${TOKEN}', environment.TOKEN], tools: {}}}}, environment}),
    error => error?.code === 'invalid_settings_commit' && error.problems?.includes('inline_credentials_use_env'),
  )
})
test('capability commit writes compact bytes when pretty formatting would exceed the registry limit', async t => {
  const root = await fixture(t), path = join(root, 'cap.json')
  let document
  for (let length = 4000; length <= 4200; length++) {
    const candidate = {version: 1, modules: {search: {enabled: false}}, mcpServers: {demo: {enabled: false, transport: 'stdio', command: 'tool', args: Array.from({length: 64}, () => 'x'.repeat(length)), tools: {}}}}
    if (Buffer.byteLength(JSON.stringify(candidate)) <= 256 * 1024 && Buffer.byteLength(JSON.stringify(candidate, null, 2) + '\n') > 256 * 1024) { document = candidate; break }
  }
  assert.ok(document)
  await prepareCapabilityCommit({settings: {capabilitiesConfigPath: path}, document})
  assert.ok((await readFile(path)).byteLength <= 256 * 1024)
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
  const commit = {settingsPatch: {capabilitiesConfigPath: path}, capabilitiesDocument: {...document, modules: {...document.modules, camera: {enabled: false}}}, capabilitiesBaseRevision: capabilityDocumentRevision({capabilitiesConfigPath: path})}
  const options = {coordinator, patch: commit, write: async payload => {
    const parsed = parseSettingsCommit(payload)
    return writer(parsed.settingsPatch, next => {
      validatePreparedSettings(parsed.settingsPatch, next)
      return prepareCapabilityCommit({settings: next, document: parsed.capabilitiesDocument, expectedRevision: capabilityDocumentRevision(next), environment: {}})
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
    assert.equal(result.saved, false); assert.equal(result.operationStatus, operationStatus)
  }
  assert.equal((await applySettingsTransaction(options)).operationStatus, 'applied')
  assert.equal(saved, 3); assert.equal(published, 5)
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

test('literal harmless HTTP headers remain editable without admitting credential headers', async t => {
  const root = await fixture(t), path = join(root, 'cap.json')
  const doc = {...document, mcpServers: {local: {enabled: true, transport: 'streamable-http', url: 'http://127.0.0.1:9999/mcp', headers: {Accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Nova MCP'}, tools: {}}}}
  await writeFile(path, JSON.stringify(doc))
  assert.deepEqual(readCapabilityEditor({capabilitiesConfigPath: path}, {}).document, doc)
  await writeFile(path, JSON.stringify({...doc, mcpServers: {local: {...doc.mcpServers.local, headers: {authorization: 'Bearer inline-secret'}}}}))
  assert.equal(readCapabilityEditor({capabilitiesConfigPath: path}, {}).document, null)
})
test('HOME and USER references are ordinary data while arbitrary authentication references stay protected', async t => {
  const {referencedCapabilitySecrets} = await import('../src/main/capabilities-settings.mjs')
  const root = await fixture(t), path = join(root, 'cap.json')
  const environment = {HOME: '/home/alice', USER: 'alice', CUSTOM_AUTH: 'arbitrary-credential-value'}
  const doc = {...document, mcpServers: {local: {enabled: false, transport: 'stdio', command: '/home/alice/bin/mcp', args: ['--user', 'alice'], env: {HOME: '${HOME}', USER: '${USER}'}, tools: {}}, remote: {enabled: false, transport: 'streamable-http', url: 'https://example.com/mcp', headers: {authorization: 'Bearer ${CUSTOM_AUTH}'}, tools: {}}}}
  await writeFile(path, JSON.stringify(doc))
  assert.deepEqual(readCapabilityEditor({capabilitiesConfigPath: path}, environment).document, doc)
  const sensitive = referencedCapabilitySecrets(doc, environment)
  assert.ok(!sensitive.includes('/home/alice'))
  assert.ok(!sensitive.includes('alice'))
  assert.ok(sensitive.includes(environment.CUSTOM_AUTH))
  assert.deepEqual(referencedCapabilitySecrets({url: 'https://example.com/${HOME}'}, environment), [environment.HOME])
  assert.deepEqual(referencedCapabilitySecrets({headers: {authorization: 'Bearer ${USER}'}}, environment), [environment.USER])
  assert.deepEqual(referencedCapabilitySecrets({env: {CUSTOM_AUTH: '${HOME}', USER: '${CUSTOM_AUTH}'}}, environment), [environment.HOME, environment.CUSTOM_AUTH])
  const leak = {...doc, mcpServers: {...doc.mcpServers, local: {...doc.mcpServers.local, args: [environment.CUSTOM_AUTH]}}}
  await writeFile(path, JSON.stringify(leak))
  assert.equal(readCapabilityEditor({capabilitiesConfigPath: path}, environment).document, null)
  const result = await publicCapabilityProbe({env: {HOME: environment.HOME, USER: environment.USER}, headers: {Accept: 'application/json', authorization: 'Bearer ' + environment.CUSTOM_AUTH}}, async () => ({status: 'ok', tools: [{name: 'alice_lookup', description: 'Home /home/alice; application/json; ' + environment.CUSTOM_AUTH}]}), sensitive)
  assert.equal(result.status, 'ok')
  assert.equal(result.tools[0].name, 'alice_lookup')
  assert.ok(result.tools[0].description.includes('/home/alice'))
  assert.ok(result.tools[0].description.includes('application/json'))
  assert.ok(!JSON.stringify(result).includes(environment.CUSTOM_AUTH))
})

test('failed backend activation and interrupted saves restore settings, sealed secrets, and capability-only changes', async t => {
  const {applySettingsTransaction} = await import('../src/main/settings-apply.mjs')
  const {saveSettings, loadSettings, saveSettingsRecovery, restoreSettingsRecovery, clearSettingsRecovery,
    applySettingsUpdate} = await import('../src/main/settings-store.mjs')
  const {createLifecycleCoordinator} = await import('../src/main/lifecycle-coordinator.mjs')
  for (const capabilitiesOnly of [false, true]) {
    const root = await fixture(t), file = join(root, 'settings.json'), cap = join(root, 'cap.json')
    const originalBytes = ' {"version":1,"modules":{"search":{"enabled":false}}} \n'
    await writeFile(cap, originalBytes)
    // Stub the platform keyring to verify the stored snapshot carries ciphertext, not inbound keys.
    const sealedCodec = {available: () => true, encrypt: () => Buffer.from('sealed-old-key')}
    let current = await saveSettings(file, applySettingsUpdate({...SETTINGS_DEFAULTS, capabilitiesConfigPath: cap},
      {secrets: {dashscopeApiKey: 'original-key'}}, sealedCodec))
    const previous = structuredClone(current)
    const writer = createSettingsWriter({getCurrent: () => current, codec: sealedCodec,
      commit: next => { current = next }, save: next => saveSettings(file, next)})
    const options = {
      coordinator: createLifecycleCoordinator(), patch: capabilitiesOnly ? {} : {integratedModel: 'bad-model', secrets: {dashscopeApiKey: ''}},
      write: patch => writer(patch, next => prepareCapabilityCommit({settings: next, document,
        beforeWrite: capability => saveSettingsRecovery(file, current, capability)})),
      publishCommitted: () => {}, prepareConfiguration: async () => ({}), commitConfiguration: async () => ({}),
      restartBackend: async () => { throw Error('backend rejected configuration') },
      rollback: async () => { current = await restoreSettingsRecovery(file) },
      complete: () => clearSettingsRecovery(file), publishStatus: () => {},
    }
    const failed = await applySettingsTransaction(options)
    assert.equal(failed.saved, false)
    assert.equal(failed.operationStatus, 'restart_failed')
    assert.deepEqual(await loadSettings(file), previous)
    assert.deepEqual(current.secrets, previous.secrets)
    assert.equal(await readFile(cap, 'utf8'), originalBytes)
    assert.equal((await readFile(`${file}.recovery`, 'utf8')).includes('original-key'), false)
    // Simulate process death after both writes, before the transaction catches the failure.
    await options.write(options.patch)
    assert.notEqual(await readFile(cap, 'utf8'), originalBytes)
    current = await restoreSettingsRecovery(file)
    assert.deepEqual(current, previous)
    assert.equal(await readFile(cap, 'utf8'), originalBytes)
    // Explicit recovery activates restored settings and clears the persistent marker only afterward.
    const recovered = await applySettingsTransaction({...options, patch: null,
      write: async () => { current = await restoreSettingsRecovery(file); return current },
      restartBackend: async () => { assert.deepEqual(current, previous) },
    })
    assert.equal(recovered.operationStatus, 'applied')
    await assert.rejects(readFile(`${file}.recovery`), {code: 'ENOENT'})
  }
})

test('pending recovery preserves external capability edits after rollback, including an originally absent file', async t => {
  const {saveSettingsRecovery, restoreSettingsRecovery} = await import('../src/main/settings-store.mjs')
  for (const original of [' {"version":1}\n', null]) {
    const root = await fixture(t), file = join(root, 'settings.json'), cap = join(root, 'cap.json')
    if (original !== null) await writeFile(cap, original)
    await prepareCapabilityCommit({settings: {...SETTINGS_DEFAULTS, capabilitiesConfigPath: cap}, document,
      beforeWrite: capability => saveSettingsRecovery(file, SETTINGS_DEFAULTS, capability)})
    await restoreSettingsRecovery(file)
    const external = '{"version":1,"frontbrainToolBudget":5}\n'
    await writeFile(cap, external)
    const journal = await readFile(`${file}.recovery`, 'utf8')
    for (let retry = 0; retry < 2; retry++) {
      await assert.rejects(restoreSettingsRecovery(file), {code: 'settings_recovery_conflict'})
      assert.equal(await readFile(cap, 'utf8'), external)
      assert.equal(await readFile(`${file}.recovery`, 'utf8'), journal)
    }
  }
})
