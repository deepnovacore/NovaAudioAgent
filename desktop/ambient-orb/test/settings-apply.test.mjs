import assert from 'node:assert/strict'
import test from 'node:test'

import {createLifecycleCoordinator} from '../src/main/lifecycle-coordinator.mjs'
import {
  applySettingsTransaction,
  sameBackendLaunchConfiguration,
} from '../src/main/settings-apply.mjs'

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
  })
  assert.deepEqual(calls, ['write'])
  assert.deepEqual(statuses, ['saving', 'failed'])
})

test('configuration failure retains the durable write without restarting', async () => {
  const {calls, statuses, options} = harness({
    prepareConfiguration: async () => {
      calls.push('prepare_configuration')
      throw new Error('invalid configuration')
    },
  })
  assert.deepEqual(await applySettingsTransaction(options), {
    saved: true,
    operationStatus: 'failed',
    rejectedSecrets: ['openaiApiKey'],
  })
  assert.deepEqual(calls, ['write', 'publish_committed', 'prepare_configuration'])
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
    saved: true,
    operationStatus: 'failed',
    rejectedSecrets: ['openaiApiKey'],
  })
  assert.deepEqual(calls, [
    'write', 'publish_committed', 'prepare_configuration',
    'commit_configuration:true', 'discard_configuration:true', 'maintenance_close',
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
    saved: true,
    operationStatus: 'restart_failed',
    rejectedSecrets: ['openaiApiKey'],
  })
  assert.deepEqual(calls, [
    'write', 'publish_committed', 'prepare_configuration',
    'commit_configuration', 'restart_backend',
  ])
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
