import assert from 'node:assert/strict'
import test from 'node:test'

import {createLifecycleCoordinator} from '../src/main/lifecycle-coordinator.mjs'
import {createWorkspaceActions} from '../src/main/workspace-actions.mjs'

function fixture(overrides = {}) {
  const calls = []
  const preparation = Object.freeze(Object.create(null))
  const authorization = Object.freeze(Object.create(null))
  const dialogs = [...(overrides.dialogs ?? [{response: 0}, {response: 0}])]
  const maintenance = {
    prepare: async scope => {
      calls.push(`prepare:${scope}`)
      return {
        status: 'ready', preparation,
        preview: {scope, display_name: scope === 'current_managed' ? 'Alpha' : null, count: 2},
      }
    },
    cancel: value => { calls.push(`cancel:${value === preparation}`); return true },
    authorize: value => {
      calls.push(`authorize:${value === preparation}`)
      return authorization
    },
    execute: async (prepared, authorized) => {
      calls.push(`execute:${prepared === preparation}:${authorized === authorization}`)
      return {status: 'cleared', committed: true, cleanup_pending: false}
    },
    withCurrentManagedPath: async callback => {
      calls.push('resolve_open')
      await callback('/managed/alpha')
      return {status: 'opened'}
    },
    ...overrides.maintenance,
  }
  const actions = createWorkspaceActions({
    coordinator: overrides.coordinator ?? createLifecycleCoordinator(),
    getMaintenance: () => maintenance,
    getWindow: () => ({kind: 'settings-window'}),
    showMessageBox: async (_window, options) => {
      calls.push(`dialog:${options.type === 'warning' ? 'destructive' : 'explain'}`)
      return dialogs.shift() ?? {response: 1}
    },
    openPath: async path => { calls.push(`open:${path}`); return '' },
    stopBackendCleanly: async () => { calls.push('stop'); return true },
    restartBackendBounded: async () => { calls.push('restart'); return true },
    ...overrides.dependencies,
  })
  return {actions, calls, maintenance, preparation}
}

test('open resolves the current managed path only inside the host callback', async () => {
  const {actions, calls} = fixture()
  assert.deepEqual(await actions.openCurrent(), {status: 'opened'})
  assert.deepEqual(calls, ['resolve_open', 'open:/managed/alpha'])
})

test('either confirmation cancellation consumes preparation without stopping', async () => {
  for (const dialogs of [[{response: 1}], [{response: 0}, {response: 1}]]) {
    const {actions, calls} = fixture({dialogs})
    assert.deepEqual(await actions.clearCurrent(), {status: 'cancelled'})
    assert.equal(calls.filter(call => call === 'stop').length, 0)
    assert.equal(calls.some(call => call.startsWith('execute:')), false)
    assert.equal(calls.at(-1), 'cancel:true')
  }
})

test('clear acquires lifecycle ownership only after both confirmations', async () => {
  const owners = []
  const coordinator = createLifecycleCoordinator({onChange: state => owners.push(state.owner)})
  const {actions, calls} = fixture({coordinator})
  assert.deepEqual(await actions.clearAll(), {status: 'cleared'})
  assert.deepEqual(owners, ['clear_all', null])
  assert.deepEqual(calls, [
    'prepare:all_managed', 'dialog:explain', 'dialog:destructive',
    'authorize:true', 'stop', 'execute:true:true', 'restart',
  ])
})

test('busy after confirmation consumes preparation and performs no stop', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const coordinator = createLifecycleCoordinator()
  const active = coordinator.run('settings_save', () => gate)
  const {actions, calls} = fixture({coordinator})
  assert.deepEqual(await actions.clearCurrent(), {status: 'busy'})
  assert.equal(calls.at(-1), 'cancel:true')
  assert.equal(calls.includes('stop'), false)
  release()
  await active
})

test('stale authorization and stop failure mutate nothing', async () => {
  const stale = fixture({maintenance: {authorize: () => { throw new Error('stale') }}})
  assert.deepEqual(await stale.actions.clearCurrent(), {status: 'clear_failed'})
  assert.equal(stale.calls.includes('stop'), false)

  const stopped = fixture({dependencies: {
    stopBackendCleanly: async () => { stopped.calls.push('stop'); return false },
  }})
  assert.deepEqual(await stopped.actions.clearCurrent(), {status: 'stop_failed'})
  assert.equal(stopped.calls.some(call => call.startsWith('execute:')), false)
  assert.equal(stopped.calls.includes('restart'), false)
})

test('every post-stop clear outcome makes one bounded recovery attempt', async () => {
  const partial = fixture({maintenance: {
    execute: async () => {
      partial.calls.push('execute:partial')
      return {status: 'clear_failed', committed: true, cleanup_pending: true}
    },
  }})
  assert.deepEqual(await partial.actions.clearAll(), {status: 'clear_failed'})
  assert.equal(partial.calls.filter(call => call === 'restart').length, 1)

  const failed = fixture({maintenance: {
    execute: async () => {
      failed.calls.push('execute:throw')
      throw new Error('clear failed')
    },
  }})
  assert.deepEqual(await failed.actions.clearCurrent(), {status: 'clear_failed'})
  assert.equal(failed.calls.filter(call => call === 'restart').length, 1)
})

test('restart failure takes precedence after a successful clear', async () => {
  const fixtureValue = fixture({dependencies: {
    restartBackendBounded: async () => {
      fixtureValue.calls.push('restart')
      return false
    },
  }})
  assert.deepEqual(await fixtureValue.actions.clearCurrent(), {status: 'restart_failed'})
})

test('cleanup and restart failures remain visible together', async () => {
  const fixtureValue = fixture({
    maintenance: {
      execute: async () => ({status: 'clear_failed', committed: true, cleanup_pending: true}),
    },
    dependencies: {
      restartBackendBounded: async () => {
        fixtureValue.calls.push('restart')
        return false
      },
    },
  })
  assert.deepEqual(await fixtureValue.actions.clearAll(), {status: 'clear_and_restart_failed'})
})

test('renderer closure after confirmation cannot revoke an authorized operation', async () => {
  let currentWindow = {kind: 'settings-window'}
  const value = fixture({dependencies: {getWindow: () => currentWindow}})
  value.actions = createWorkspaceActions({
    coordinator: createLifecycleCoordinator(),
    getMaintenance: () => value.maintenance,
    getWindow: () => currentWindow,
    showMessageBox: async () => {
      currentWindow = null
      return {response: 0}
    },
    openPath: async () => '',
    stopBackendCleanly: async () => { value.calls.push('stop'); return true },
    restartBackendBounded: async () => { value.calls.push('restart'); return true },
  })
  assert.deepEqual(await value.actions.clearCurrent(), {status: 'cleared'})
  assert.equal(value.calls.some(call => call.startsWith('execute:')), true)
})
