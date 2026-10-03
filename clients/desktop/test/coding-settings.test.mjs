import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {tmpdir} from 'node:os'
import vm from 'node:vm'
import test from 'node:test'
import {applySettingsTransaction} from '../src/main/settings-apply.mjs'
import {createLifecycleCoordinator} from '../src/main/desktop-startup.mjs'
import {backendSettings, publicSettings, normalizeSettings, createSettingsWriter} from '../src/main/settings-store.mjs'
import {codingBackendStatus, codingProfileRegistry} from '../src/main/coding-settings.mjs'
import {backendLaunchSpec} from '../src/main/backend.mjs'

const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

test('actual main applies a default-only change live without restarting, and rolls back failed delivery', async () => {
  for (const runtimeEnabled of [true, false]) for (const pendingRestart of [false, true]) for (const failDelivery of [false, true]) {
    let saved, runtimeBackend = 'codex', requestCount = 0, failComplete = false, savedCodingEnabled = runtimeEnabled
    const calls = []
    const context = vm.createContext({
      currentSettings: normalizeSettings({}), settingsRestartPending: false, settingsRecoveryAvailable: false,
      runtimeCapabilities: {modules: {coding: {enabled: runtimeEnabled}}},
      backendSettings, publicSettings, applySettingsTransaction, lifecycleCoordinator: createLifecycleCoordinator(),
      backendControl: {request: async (method, params) => {
        assert.equal(runtimeEnabled, true, 'a disabled coding module must not receive an update or rollback')
        assert.deepEqual(Object.keys(params), ['backend'], 'a live update cannot replace the active profile registry')
        assert.equal(method, 'coding.default.set'); calls.push(params.backend); runtimeBackend = params.backend
        if (failDelivery && requestCount++ === 0) throw new Error('ack lost')
        return {backend: params.backend}
      }},
      settingsFile: () => '/tmp/coding-settings.json', resolve, capabilityPath: () => '/tmp/capabilities.json',
      parseSettingsCommit: value => value, validatePreparedSettings: () => {}, accessCredentials: work => work(),
      readCapabilityDocument: () => ({version: 1, modules: {coding: {enabled: savedCodingEnabled}}}), decryptSecretsForSpawn: () => ({}), secretCodec: {},
      capabilityEnvironment: () => ({}), process: {env: {}},
      prepareCapabilityCommit: async ({beforeWrite, document}) => { await beforeWrite(); if (document) savedCodingEnabled = document.modules.coding.enabled; return {} },
      saveSettingsRecovery: async () => {}, clearSettingsRecovery: async () => { if (failComplete) { failComplete = false; throw new Error('journal cleanup failed') } },
      saveSettings: async (_file, value) => { saved = value },
      publishCommittedSettings: () => {}, publishSettingsApplyStatus: () => {}, refreshSettingsCapabilities: async () => {},
      rollbackSettings: () => { throw new Error('must not stop backend') },
      prepareDesktopConfiguration: () => { throw new Error('must not refresh backend') },
      commitDesktopConfiguration: () => {}, discardDesktopConfiguration: () => {},
      restartSettingsBackend: () => { throw new Error('must not restart backend') }, console,
    })
    context.settingsView = () => publicSettings(context.currentSettings)
    context.settingsWriter = createSettingsWriter({getCurrent: () => context.currentSettings,
      commit: next => { context.currentSettings = next }, save: async next => { saved = next }, codec: {available: () => false}})
    const live = source.slice(source.indexOf('async function applyLiveCodingBackend('), source.indexOf('async function restartSettingsBackend('))
    const apply = source.slice(source.indexOf('async function applyDesktopSettings('), source.indexOf('function showOrbMenu('))
    vm.runInContext(`${live}\n${apply}\nglobalThis.applyDesktopSettings = applyDesktopSettings`, context)
    if (pendingRestart) {
      const deferred = await context.applyDesktopSettings({settingsPatch: {
        plannerModel: 'new-planner', codingBackendPaths: {pi: {binaryPath: '/new/pi-acp'}},
      }, capabilitiesDocument: {version: 1, modules: {coding: {enabled: !runtimeEnabled}}}})
      assert.equal(deferred.operationStatus, 'pending_restart')
      assert.deepEqual(calls, [])
    }
    failComplete = failDelivery && !runtimeEnabled
    const result = await context.applyDesktopSettings({settingsPatch: {codingBackend: 'pi'}})
    assert.equal(result.restarted, false)
    assert.equal(result.saved, !failDelivery)
    assert.equal(saved.codingBackend, failDelivery ? 'codex' : 'pi')
    assert.equal(runtimeBackend, runtimeEnabled ? saved.codingBackend : 'codex')
    assert.deepEqual(calls, runtimeEnabled ? failDelivery ? ['pi', 'codex'] : ['pi'] : [])
    if (pendingRestart) {
      assert.equal(saved.plannerModel, 'new-planner')
      assert.equal(saved.codingBackendPaths.pi.binaryPath, '/new/pi-acp')
      if (!failDelivery) assert.equal(result.operationStatus, 'pending_restart')
    }
  }
})

test('spawn profile registry contains stable source ids without secret material', () => {
  const settings = normalizeSettings({codingBackend: 'opencode', codingBackendPaths: {opencode: {binaryPath: '/bin/opencode', configPath: '/config/open.json'}}})
  const registry = codingProfileRegistry(settings)
  assert.match(registry.defaults.opencode, /^opencode:[a-f0-9]{64}$/u)
  assert.equal(registry.defaults.pi, 'pi:default')
  assert.equal(Object.hasOwn(registry.defaults, 'codex'), false)
  const spec = backendLaunchSpec({backend: 'node', token: 'b'.repeat(32), readyEndpoint: '127.0.0.1:12345', settings,
    workspace: '/tmp', nodeEntry: '/tmp/runtime/desktop-entry.js', nodeResourcesPath: '/tmp/resources', parentEnv: {}})
  assert.equal(spec.env.CODING_BACKEND, 'opencode')
  assert.deepEqual(JSON.parse(spec.env.CODING_PROFILES), registry)
})

test('backend status distinguishes installed executables and missing source paths without claiming authentication', () => {
  const statuses = codingBackendStatus({codingBackendPaths: {
    opencode: {binaryPath: process.execPath, configPath: '/not-present/nova-coding-config.json'},
    pi: {configPath: tmpdir()},
  }}, {PATH: '', DEEPSEEK_API_KEY: 'must-not-appear'})
  assert.deepEqual(Object.keys(statuses), ['opencode', 'codebuddy', 'pi', 'deepseek'])
  assert.deepEqual(statuses.opencode, {binary: 'available', configuration: 'missing', authentication: 'unverified'})
  assert.deepEqual(statuses.pi, {binary: 'missing', configuration: 'available', authentication: 'unverified'})
  assert.equal(statuses.deepseek.binary, 'missing')
  assert.ok(!JSON.stringify(statuses).includes('must-not-appear'))
})
