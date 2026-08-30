import assert from 'node:assert/strict'
import test from 'node:test'

import {createBackendSupervisor} from '../src/main/backend-supervisor.mjs'
import {createLifecycleCoordinator} from '../src/main/lifecycle-coordinator.mjs'
import * as workspaceActionModule from '../src/main/workspace-actions.mjs'

const {createWorkspaceActions} = workspaceActionModule

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

test('OS open errors remain an explicit open_failed result', async () => {
  const value = fixture({dependencies: {
    openPath: async path => {
      value.calls.push(`open:${path}`)
      return 'permission denied'
    },
  }})
  assert.deepEqual(await value.actions.openCurrent(), {status: 'open_failed'})
  assert.deepEqual(value.calls, ['resolve_open', 'open:/managed/alpha'])
})

test('public capabilities preserve maintenance health and independent current/all availability', () => {
  assert.equal(typeof workspaceActionModule.publicManagedWorkspaceCapabilities, 'function')
  const mapCapabilities = workspaceActionModule.publicManagedWorkspaceCapabilities
  assert.deepEqual(mapCapabilities({
    health: 'degraded',
    lifecycleBusy: false,
    current: {available: true, display_name: 'Alpha'},
    all: {available: false, count: 0},
  }), {
    health: 'degraded',
    current: {available: true, displayName: 'Alpha'},
    all: {available: false, count: 0},
  })
  assert.deepEqual(mapCapabilities(), {
    health: 'unavailable',
    current: {available: false, displayName: null},
    all: {available: false, count: 0},
  })
})

function recoveryFixture(overrides = {}) {
  const events = []
  let current = overrides.capabilities ?? {
    health: 'ready',
    current: {available: true, displayName: 'Alpha'},
    all: {available: true, count: 1},
  }
  const recovery = workspaceActionModule.createManagedWorkspaceBackendRecovery({
    getCapabilities: () => current,
    refreshCapabilities: async () => {
      events.push('refresh')
      return overrides.refreshCapabilities?.() ?? current
    },
    startBackend: async () => {
      events.push('start')
      return overrides.startBackend?.() ?? true
    },
    restartBackend: async () => {
      events.push('restart')
      return overrides.restartBackend?.() ?? true
    },
    retryBackend: async () => {
      events.push('retry')
      return overrides.retryBackend?.() ?? true
    },
    stopBackend: async () => {
      events.push('stop')
      return overrides.stopBackend?.() ?? true
    },
  })
  return {events, recovery, setCapabilities: value => { current = value }}
}

test('known rollback remains latched across passive ready refresh and fails closed on unavailable retry', async () => {
  assert.equal(typeof workspaceActionModule.createManagedWorkspaceBackendRecovery, 'function')
  const rollback = {
    health: 'rollback_pending',
    current: {available: false, displayName: null},
    all: {available: false, count: 0},
  }
  const ready = {
    health: 'ready',
    current: {available: true, displayName: 'Alpha'},
    all: {available: true, count: 1},
  }
  const unavailable = {
    health: 'unavailable',
    current: {available: false, displayName: null},
    all: {available: false, count: 0},
  }
  const value = recoveryFixture({
    capabilities: rollback,
    refreshCapabilities: () => unavailable,
  })

  assert.equal(typeof value.recovery.observe, 'function')
  assert.equal(typeof value.recovery.status, 'function')
  assert.deepEqual(await value.recovery.observe(rollback), {status: 'required'})
  assert.equal(value.recovery.status(), 'required')
  assert.deepEqual(value.events, ['stop'])

  value.setCapabilities(ready)
  assert.deepEqual(await value.recovery.observe(ready), {status: 'required'})
  assert.equal(value.recovery.status(), 'required')
  assert.deepEqual(await value.recovery.start(), {status: 'rollback_pending'})
  assert.deepEqual(await value.recovery.restart(), {status: 'rollback_pending'})
  assert.deepEqual(value.events, ['stop'])

  assert.deepEqual(await value.recovery.retry(), {status: 'recovery_failed'})
  assert.equal(value.recovery.status(), 'failed')
  assert.deepEqual(value.events, ['stop', 'refresh'])
})

test('explicit safe retry activates once and clears recovery only after success', async () => {
  const rollback = {health: 'rollback_pending'}
  const value = recoveryFixture({
    capabilities: rollback,
    refreshCapabilities: () => ({health: 'degraded'}),
  })

  assert.deepEqual(await value.recovery.observe(rollback), {status: 'required'})
  assert.deepEqual(await value.recovery.retry(), {status: 'retried'})
  assert.equal(value.recovery.status(), 'idle')
  assert.deepEqual(value.events, ['stop', 'refresh', 'retry'])
})

test('a newer rollback invalidates an in-flight safe retry and quiesces stale activation', async () => {
  const rollback = {health: 'rollback_pending'}
  let activationEntered
  const entered = new Promise(resolve => { activationEntered = resolve })
  let releaseActivation
  const activationGate = new Promise(resolve => { releaseActivation = resolve })
  let running = false
  const value = recoveryFixture({
    capabilities: rollback,
    refreshCapabilities: () => ({health: 'ready'}),
    retryBackend: async () => {
      running = true
      activationEntered()
      await activationGate
      running = true
      return true
    },
    stopBackend: () => {
      running = false
      return true
    },
  })

  assert.deepEqual(await value.recovery.observe(rollback), {status: 'required'})
  const retrying = value.recovery.retry()
  await entered
  assert.equal(running, true)

  const newerRollback = {health: 'rollback_pending', observation: 'newer'}
  value.setCapabilities(newerRollback)
  assert.deepEqual(await value.recovery.observe(newerRollback), {status: 'required'})
  assert.equal(running, false)

  releaseActivation()
  assert.deepEqual(await retrying, {status: 'recovery_failed'})
  assert.equal(value.recovery.status(), 'failed')
  assert.equal(running, false)
  assert.deepEqual(value.events, ['stop', 'refresh', 'retry', 'stop', 'stop'])
})

test('failed safe activation remains latched and blocks ordinary restart', async () => {
  const rollback = {health: 'rollback_pending'}
  const value = recoveryFixture({
    capabilities: rollback,
    refreshCapabilities: () => ({health: 'ready'}),
    retryBackend: () => false,
  })

  assert.deepEqual(await value.recovery.observe(rollback), {status: 'required'})
  assert.deepEqual(await value.recovery.retry(), {status: 'recovery_failed'})
  assert.equal(value.recovery.status(), 'failed')
  assert.deepEqual(value.events, ['stop', 'refresh', 'retry', 'stop'])
  assert.deepEqual(await value.recovery.restart(), {status: 'rollback_pending'})
  assert.deepEqual(value.events, ['stop', 'refresh', 'retry', 'stop', 'stop'])
})

test('unsupported maintenance remains distinct from known rollback and permits normal startup', async () => {
  const unavailable = workspaceActionModule.publicManagedWorkspaceCapabilities()
  const value = recoveryFixture({capabilities: unavailable})

  assert.deepEqual(await value.recovery.observe(unavailable), {status: 'idle'})
  assert.deepEqual(await value.recovery.start(), {status: 'started'})
  assert.equal(value.recovery.status(), 'idle')
  assert.deepEqual(value.events, ['start'])
})

test('observing rollback stops a connected supervisor and cancels an armed retry', async () => {
  const connectedStops = []
  const connected = createBackendSupervisor({
    start: async () => ({backend: {id: 'connected'}, connection: {port: 1234}}),
    stopBackend: async backend => { connectedStops.push(backend.id) },
    onStatus: () => {},
  })
  await connected.start()
  assert.equal(connected.status().state, 'connected')
  const connectedRecovery = recoveryFixture({
    stopBackend: async () => {
      await connected.stop()
      return connected.status().state === 'stopped'
    },
  })
  assert.deepEqual(await connectedRecovery.recovery.observe({health: 'rollback_pending'}), {
    status: 'required',
  })
  assert.equal(connected.status().state, 'stopped')
  assert.deepEqual(connectedStops, ['connected'])

  const scheduled = []
  const cancelled = []
  const retrying = createBackendSupervisor({
    start: async () => { throw {kind: 'recoverable', code: 'temporary'} },
    stopBackend: async () => {},
    onStatus: () => {},
    schedule: callback => {
      const token = {callback}
      scheduled.push(token)
      return token
    },
    cancel: token => { cancelled.push(token) },
    retryPolicy: {baseMs: 1, capMs: 1, jitterRatio: 0},
  })
  await retrying.start()
  assert.equal(retrying.status().state, 'reconnecting')
  const retryingRecovery = recoveryFixture({
    stopBackend: async () => {
      await retrying.stop()
      return retrying.status().state === 'stopped'
    },
  })
  assert.deepEqual(await retryingRecovery.recovery.observe({health: 'rollback_pending'}), {
    status: 'required',
  })
  assert.equal(retrying.status().state, 'stopped')
  assert.deepEqual(cancelled, scheduled)
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

test('an unresolved pre-commit rollback keeps the backend stopped', async () => {
  const fixtureValue = fixture({maintenance: {
    execute: async () => ({status: 'rollback_pending', committed: false, cleanup_pending: true}),
  }})
  assert.deepEqual(await fixtureValue.actions.clearAll(), {status: 'rollback_pending'})
  assert.equal(fixtureValue.calls.includes('restart'), false)
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
