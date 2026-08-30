import assert from 'node:assert/strict'
import test from 'node:test'

import {createBackendSupervisor} from '../src/main/backend-supervisor.mjs'

function deferred() {
  let resolve
  const promise = new Promise(next => { resolve = next })
  return {promise, resolve}
}

test('recoverable starts reconnect with deterministic jitter and then connect', async () => {
  const scheduled = []
  const statuses = []
  let attempts = 0
  const supervisor = createBackendSupervisor({
    start: async () => {
      attempts += 1
      if (attempts === 1) throw {kind: 'recoverable', code: 'transport_lost'}
      return {backend: {id: attempts}, connection: {endpoint: 'ws://127.0.0.1:7/'}}
    },
    stopBackend: async () => {},
    schedule: (callback, delay) => {
      const handle = {callback, delay, canceled: false}
      scheduled.push(handle)
      return handle
    },
    cancel: handle => { handle.canceled = true },
    random: () => 1,
    retryPolicy: {baseMs: 1000, capMs: 30_000, jitterRatio: 0.2},
    onStatus: status => statuses.push(status),
  })
  await supervisor.start()
  assert.equal(supervisor.status().state, 'reconnecting')
  assert.equal(scheduled[0].delay, 1200)
  await scheduled[0].callback()
  assert.equal(supervisor.status().state, 'connected')
  assert.equal(statuses.at(-1).connection.endpoint, 'ws://127.0.0.1:7/')
})

test('configuration, authentication, and unavailable failures never arm a timer', async () => {
  for (const kind of ['configuration_required', 'authentication_failed', 'unavailable']) {
    const scheduled = []
    const supervisor = createBackendSupervisor({
      start: async () => { throw {kind, code: `${kind}_test`} },
      stopBackend: async () => {},
      schedule: (callback, delay) => { scheduled.push({callback, delay}); return callback },
      onStatus: () => {},
    })
    await supervisor.start()
    assert.equal(supervisor.status().state, kind)
    assert.equal(supervisor.status().diagnostic, `${kind}_test`)
    assert.equal(scheduled.length, 0)
  }
})

test('exit reconnects, explicit retry cancels delay, and stop fences a stale start', async () => {
  const scheduled = []
  const stopped = []
  const pending = deferred()
  let startCount = 0
  let exit
  const supervisor = createBackendSupervisor({
    start: async onExit => {
      startCount += 1
      exit = onExit
      if (startCount === 3) return await pending.promise
      return {backend: {id: startCount}, connection: {endpoint: 'ws://127.0.0.1:8/'}}
    },
    stopBackend: async backend => { stopped.push(backend.id) },
    schedule: (callback, delay) => {
      const handle = {callback, delay, canceled: false}
      scheduled.push(handle)
      return handle
    },
    cancel: handle => { handle.canceled = true },
    random: () => 0.5,
    retryPolicy: {baseMs: 1000, capMs: 30_000, jitterRatio: 0.2},
    onStatus: () => {},
  })
  await supervisor.start()
  exit({kind: 'recoverable', code: 'backend_exit'})
  assert.equal(supervisor.status().state, 'reconnecting')
  assert.equal(scheduled.at(-1).delay, 1000)
  await supervisor.retry()
  assert.equal(scheduled[0].canceled, true)
  assert.equal(startCount, 2)
  const third = supervisor.restart()
  while (startCount < 3) await Promise.resolve()
  const stopping = supervisor.stop()
  pending.resolve({backend: {id: 3}, connection: {endpoint: 'ws://127.0.0.1:9/'}})
  await stopping
  await third
  assert.deepEqual(stopped, [2, 3])
  assert.equal(supervisor.status().state, 'stopped')
})

test('an unconfirmed stop is explicit and restart never starts a replacement backend', async () => {
  const starts = []
  const statuses = []
  const supervisor = createBackendSupervisor({
    start: async () => {
      const backend = {id: starts.length + 1}
      starts.push(backend)
      return {backend, connection: {endpoint: 'ws://127.0.0.1:10/'}}
    },
    stopBackend: async () => { throw new Error('backend termination unconfirmed') },
    onStatus: status => statuses.push(status),
  })
  await supervisor.start()

  await assert.rejects(supervisor.restart(), /termination unconfirmed/u)

  assert.equal(starts.length, 1)
  assert.notEqual(supervisor.status().state, 'stopped')
  assert.equal(statuses.some(status => status.state === 'stopped'), false)
})
