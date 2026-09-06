import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises'
import {statSync} from 'node:fs'
import {join} from 'node:path'
import {createBackendSupervisor} from '../src/main/backend-supervisor.mjs'
import {classifyBackendFailure} from '../src/main/backend-diagnostics.mjs'
import {capabilityPath, readCapabilityDocument} from '../src/main/capabilities-settings.mjs'

const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
const launch = source.slice(source.indexOf('async function launchBackend('), source.indexOf('function initializeDesktopBootstrap('))
const view = source.slice(source.indexOf('function settingsView()'), source.indexOf('async function loadMemoryBoardExport()'))

test('actual main prelaunch registry failures stop the supervisor without scheduling reconnect', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-task4-prelaunch-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const path = join(root, 'cap.json')
  for (const bytes of ['invalid json', ' '.repeat(256 * 1024 + 1), null]) {
    if (bytes === null) await rm(path)
    else await writeFile(path, bytes)
    const context = vm.createContext({readCapabilityDocument, classifyBackendFailure, currentSettings: {capabilitiesConfigPath: path}, process: {env: {}}, desktopConfig: {}, codexStatus: {status: 'ready'}})
    vm.runInContext(launch, context)
    let retries = 0
    const supervisor = createBackendSupervisor({start: () => context.launchBackend(), stopBackend: async () => {}, onStatus: () => {}, schedule: () => {retries++; return 1}})
    await supervisor.start()
    assert.equal(supervisor.status().state, 'configuration_required')
    assert.equal(supervisor.status().diagnostic, 'configuration_required')
    assert.equal(retries, 0)
    await supervisor.stop()
  }
})
test('actual main keeps invalid model configuration visible when Coding is disabled', async () => {
  const context = vm.createContext({readCapabilityDocument: () => ({modules: {coding: {enabled: false}}}), classifyBackendFailure,
    currentSettings: {}, process: {env: {}}, desktopConfig: {modelConfigurationError: 'model_base_url_invalid', codexConfigurationError: 'manual_path_required'}, codexStatus: {status: 'unavailable'}})
  vm.runInContext(launch, context)
  await assert.rejects(context.launchBackend(), error => error.kind === 'configuration_required' && error.code === 'model_base_url_invalid')
})
test('actual settings view decrypts only for an open panel and caches the public generation', () => {
  let decrypts = 0
  const context = vm.createContext({wakeWord: null, settingsWindow: null, capabilityEditorCache: null, settingsGeneration: 0, currentSettings: {}, process: {env: {}},
    readCapabilityDocument: () => ({version: 1}), decryptSecretsForSpawn: () => {decrypts++; return {}},
    readCapabilityEditor: () => ({document: {version: 1}, revision: 'test-revision', problems: []}), capabilityEnvironment: () => ({}), capabilityPath, statSync,
    runtimeCapabilities: null, publicSettings: () => ({}), codexStatus: {}, backendStatus: {}, settingsApplyStatus: 'idle', managedWorkspacesView: () => ({}),
    microphoneStatus: 'unknown', desktopConfig: null, secretsPresent: () => ({}), secretCodec: {available: () => true}, hasPlaintextSecret: () => false})
  vm.runInContext(view, context)
  context.settingsView(); context.settingsView()
  assert.equal(decrypts, 0)
  context.settingsWindow = {}
  context.settingsView(); context.settingsView()
  assert.equal(decrypts, 1)
  context.settingsGeneration++
  context.settingsView()
  assert.equal(decrypts, 2)
  context.settingsWindow = null
  context.settingsView()
  assert.equal(decrypts, 2)
})

test('actual main refreshes a hand-edited registry while the panel is open and on backend launch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-task4-cache-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const path = join(root, 'capabilities.json')
  const context = vm.createContext({wakeWord: null, settingsWindow: {show() {}, focus() {}}, refreshManagedWorkspaceCapabilities: () => Promise.resolve(), sendToSettings: () => {}, capabilityEditorCache: null, settingsGeneration: 0,
    currentSettings: {capabilitiesConfigPath: path}, process: {env: {}}, readCapabilityDocument, classifyBackendFailure,
    decryptSecretsForSpawn: () => ({}), capabilityEnvironment: () => ({}),
    readCapabilityEditor: settings => ({document: readCapabilityDocument(settings, {}), revision: 'test-revision', problems: []}), capabilityPath, statSync,
    runtimeCapabilities: null, publicSettings: () => ({}), codexStatus: {}, backendStatus: {}, settingsApplyStatus: 'idle', managedWorkspacesView: () => ({}),
    microphoneStatus: 'unknown', desktopConfig: {modelConfigurationError: 'model_base_url_invalid'},
    secretsPresent: () => ({}), secretCodec: {available: () => true}, hasPlaintextSecret: () => false})
  const open = source.slice(source.indexOf('function openSettingsWindow('), source.indexOf('function createTray('))
  vm.runInContext(view + '\n' + launch + '\n' + open, context)
  await writeFile(path, JSON.stringify({version: 1, frontbrainToolBudget: 4}))
  assert.equal(context.settingsView().capabilitiesDocument.frontbrainToolBudget, 4)
  await writeFile(path, JSON.stringify({version: 1, frontbrainToolBudget: 5}))
  context.openSettingsWindow()
  assert.equal(context.settingsView().capabilitiesDocument.frontbrainToolBudget, 5)
  await writeFile(path, JSON.stringify({version: 1, frontbrainToolBudget: 6}))
  assert.equal(context.settingsView().capabilitiesDocument.frontbrainToolBudget, 6)
  await assert.rejects(context.launchBackend(), error => error.code === 'model_base_url_invalid')
  assert.equal(context.settingsView().capabilitiesDocument.frontbrainToolBudget, 6)
})
