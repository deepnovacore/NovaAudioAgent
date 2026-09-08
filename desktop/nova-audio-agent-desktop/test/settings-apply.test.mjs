import assert from 'node:assert/strict'
import test from 'node:test'

import {createLifecycleCoordinator} from '../src/main/lifecycle-coordinator.mjs'
import {
  applySettingsTransaction,
  coordinateCodexRescan,
  sameBackendLaunchConfiguration,
} from '../src/main/settings-apply.mjs'
import {backendSettings, normalizeSettings} from '../src/main/settings-store.mjs'

function harness(overrides = {}) {
  const calls = []
  const statuses = []
  const coordinator = overrides.coordinator ?? createLifecycleCoordinator()
  return {
    calls,
    statuses,
    options: {
      coordinator,
      patch: Object.freeze({palette: 'ember'}),
      write: async () => {
        calls.push('write')
        return {rejectedSecrets: ['openaiApiKey']}
      },
      publishCommitted: () => calls.push('publish_committed'),
      rollback: async () => calls.push('rollback'),
      prepareConfiguration: async () => {
        calls.push('prepare_configuration')
        return Object.freeze({config: 'prepared'})
      },
      commitConfiguration: () => calls.push('commit_configuration'),
      discardConfiguration: () => calls.push('discard_configuration'),
      restartBackend: async () => calls.push('restart_backend'),
      publishStatus: status => statuses.push(status),
      ...overrides,
    },
  }
}

test('settings transaction durably writes, refreshes, and awaits exactly one restart', async () => {
  const {calls, statuses, options} = harness()
  assert.deepEqual(await applySettingsTransaction(options), {
    saved: true,
    operationStatus: 'applied',
    rejectedSecrets: ['openaiApiKey'],
    restarted: true,
  })
  assert.deepEqual(calls, [
    'write', 'publish_committed', 'prepare_configuration',
    'commit_configuration', 'restart_backend',
  ])
  assert.deepEqual(statuses, ['saving', 'refreshing', 'restarting', 'applied'])
})

test('write failure performs no refresh or restart', async () => {
  const {calls, statuses, options} = harness({
    write: async () => {
      calls.push('write')
      throw new Error('disk full')
    },
  })
  assert.deepEqual(await applySettingsTransaction(options), {
    saved: false,
    operationStatus: 'failed',
    rejectedSecrets: [],
    restarted: false,
  })
  assert.deepEqual(calls, ['write', 'rollback', 'publish_committed'])
  assert.deepEqual(statuses, ['saving', 'failed'])
})

test('configuration failure restores the previous durable settings without restarting', async () => {
  const {calls, statuses, options} = harness({
    prepareConfiguration: async () => {
      calls.push('prepare_configuration')
      throw new Error('invalid configuration')
    },
  })
  assert.deepEqual(await applySettingsTransaction(options), {
    saved: false,
    operationStatus: 'failed',
    rejectedSecrets: ['openaiApiKey'],
    restarted: false,
  })
  assert.deepEqual(calls, ['write', 'publish_committed', 'prepare_configuration', 'rollback', 'publish_committed'])
  assert.deepEqual(statuses, ['saving', 'refreshing', 'failed'])
})

test('an abandoned prepared configuration explicitly discards its maintenance owner', async () => {
  const maintenance = Object.freeze({
    close: async () => { calls.push('maintenance_close') },
  })
  const prepared = Object.freeze({config: 'prepared', maintenance})
  const {calls, statuses, options} = harness({
    prepareConfiguration: async () => {
      calls.push('prepare_configuration')
      return prepared
    },
    commitConfiguration: async value => {
      calls.push(`commit_configuration:${value === prepared}`)
      throw new Error('commit rejected')
    },
    discardConfiguration: async value => {
      calls.push(`discard_configuration:${value === prepared}`)
      await value.maintenance.close()
    },
  })
  assert.deepEqual(await applySettingsTransaction(options), {
    saved: false,
    operationStatus: 'failed',
    rejectedSecrets: ['openaiApiKey'],
    restarted: false,
  })
  assert.deepEqual(calls, [
    'write', 'publish_committed', 'prepare_configuration',
    'commit_configuration:true', 'discard_configuration:true', 'maintenance_close', 'rollback', 'publish_committed',
  ])
  assert.deepEqual(statuses, ['saving', 'refreshing', 'failed'])
})

test('restart failure is bounded and reported after the committed refresh', async () => {
  const {calls, statuses, options} = harness({
    restartBackend: async () => {
      calls.push('restart_backend')
      throw new Error('restart failed')
    },
  })
  assert.deepEqual(await applySettingsTransaction(options), {
    saved: false,
    operationStatus: 'restart_failed',
    rejectedSecrets: ['openaiApiKey'],
    restarted: false,
  })
  assert.deepEqual(calls, [
    'write', 'publish_committed', 'prepare_configuration',
    'commit_configuration', 'restart_backend', 'rollback', 'publish_committed',
  ])
  assert.deepEqual(calls.slice(-2), ['rollback', 'publish_committed'])
  assert.deepEqual(statuses.at(-1), 'restart_failed')
})

test('an occupied lifecycle returns busy without touching the patch', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const coordinator = createLifecycleCoordinator()
  const active = coordinator.run('codex_rescan', () => gate)
  const {calls, statuses, options} = harness({coordinator})
  assert.deepEqual(await applySettingsTransaction(options), {
    saved: false,
    operationStatus: 'busy',
    rejectedSecrets: [],
    restarted: false,
  })
  assert.deepEqual(calls, [])
  assert.deepEqual(statuses, [])
  release()
  await active
})

test('backend launch comparison is stable, structural, and credential-free', () => {
  const left = {
    config: {
      workspace: '/managed/alpha', stateRoot: '/state', managedRoot: '/managed',
      codexBinaryMode: 'auto', codexBinaryPath: '/bin/codex',
      codexConfigurationError: null, modelBaseUrl: 'https://models.example/v1',
      modelConfigurationError: null, startListeningOnLaunch: false,
    },
    codexStatus: {
      status: 'ready', path: '/bin/codex', prefixArgs: [], source: 'path', version: '1.2.3',
      invocation: {command: '/bin/codex', prefixArgs: []},
    },
  }
  assert.equal(sameBackendLaunchConfiguration(left, structuredClone(left)), true)
  const changed = structuredClone(left)
  changed.codexStatus.version = '1.2.4'
  assert.equal(sameBackendLaunchConfiguration(left, changed), false)
  assert.equal(sameBackendLaunchConfiguration(left, {...left, secret: 'ignored'}), true)
})

test('Codex refresh returns a view captured after lifecycle ownership is released', async () => {
  const coordinator = createLifecycleCoordinator()
  const previous = Object.freeze({config: {workspace: '/managed/alpha'}})
  const prepared = structuredClone(previous)
  let restarts = 0

  const view = await coordinateCodexRescan({
    coordinator,
    currentConfiguration: () => previous,
    prepareConfiguration: async () => prepared,
    commitConfiguration: async () => {},
    discardConfiguration: async () => {},
    restartBackend: async () => { restarts += 1 },
    recoverBackend: async () => { throw new Error('must not recover') },
    view: () => Object.freeze({
      managedWorkspaces: Object.freeze({lifecycleBusy: coordinator.busy}),
    }),
  })

  assert.equal(view.managedWorkspaces.lifecycleBusy, false)
  assert.equal(coordinator.busy, false)
  assert.equal(restarts, 0)
})

test('Codex refresh recovers once when external cleanup reset the active workspace', async () => {
  const coordinator = createLifecycleCoordinator()
  const previous = Object.freeze({config: {workspace: '/managed/alpha'}})
  const prepared = structuredClone(previous)
  const calls = []

  const view = await coordinateCodexRescan({
    coordinator,
    currentConfiguration: () => previous,
    prepareConfiguration: async () => prepared,
    commitConfiguration: async () => ({externalWorkspaceReset: true}),
    discardConfiguration: async () => {},
    restartBackend: async () => { calls.push('restart') },
    recoverBackend: async () => { calls.push('recover') },
    view: () => ({managedWorkspaces: {lifecycleBusy: coordinator.busy}}),
  })

  assert.deepEqual(calls, ['recover'])
  assert.equal(view.managedWorkspaces.lifecycleBusy, false)
})

test('settings save passes configuration reconciliation to its one backend activation', async () => {
  const marker = Object.freeze({externalWorkspaceReset: true})
  let received = null
  const {options} = harness({
    commitConfiguration: async () => marker,
    restartBackend: async result => { received = result },
  })

  assert.equal((await applySettingsTransaction(options)).operationStatus, 'applied')
  assert.equal(received, marker)
})

test('desktop-only settings commit without preparing or restarting the backend', async () => {
  const calls = []
  const result = await applySettingsTransaction({
    coordinator: {run: async (_name, fn) => ({status: 'completed', value: await fn()})},
    patch: {wakeWordEnabled: true},
    write: async () => { calls.push('write'); return {} },
    publishCommitted: () => calls.push('publish'),
    needsBackendRestart: () => false,
    prepareConfiguration: () => { throw new Error('must not prepare') },
    restartBackend: () => { throw new Error('must not restart') },
    publishStatus: () => {},
  })
  assert.equal(result.operationStatus, 'applied')
  assert.equal(result.restarted, false)
  assert.deepEqual(calls, ['write', 'publish'])
})

test('wake-only save ignores writer metadata when deciding whether to restart', async () => {
  const previous = normalizeSettings({palette: 'ember'})
  let current = previous
  const calls = []
  const result = await applySettingsTransaction({
    coordinator: {run: async (_name, fn) => ({status: 'completed', value: await fn()})},
    patch: {wakeWordEnabled: true},
    write: async () => {
      current = {...normalizeSettings({...previous, wakeWordEnabled: true}), rejectedSecrets: ['dashscopeApiKey']}
      return current
    },
    publishCommitted: () => calls.push('publish'),
    needsBackendRestart: () => JSON.stringify(backendSettings(previous)) !== JSON.stringify(backendSettings(current)),
    prepareConfiguration: () => { throw new Error('wake-only save must not prepare') },
    restartBackend: () => { throw new Error('wake-only save must not restart') },
    publishStatus: status => calls.push(status),
  })
  assert.equal(result.restarted, false)
  assert.deepEqual(calls, ['saving', 'publish', 'applied'])
})

test('failed rollback remains recoverable and never reports applied', async () => {
  const {options, statuses} = harness({
    restartBackend: async () => {throw Error('activation failed')},
    rollback: async () => {throw Error('recovery disk unavailable')},
  })
  const result = await applySettingsTransaction(options)
  assert.equal(result.saved, false)
  assert.equal(result.operationStatus, 'recovery_failed')
  assert.equal(statuses.includes('applied'), false)
})
