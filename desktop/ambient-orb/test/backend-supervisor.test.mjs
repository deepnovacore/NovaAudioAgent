import assert from 'node:assert/strict'
import test from 'node:test'

import {createBackendSupervisor} from '../src/main/backend-supervisor.mjs'

function deferred() {
  let resolve
  const promise = new Promise(next => { resolve = next })
  return {promise, resolve}
}

test('supervisor retries failed starts with bounded backoff and publishes readiness', async () => {
  const scheduled = []
  const statuses = []
  let attempts = 0
  const supervisor = createBackendSupervisor({
    start: async onExit => {
      attempts += 1
      if (attempts < 2) throw new Error('private startup detail')
      return {backend: {id: attempts}, connection: {endpoint: 'ws://127.0.0.1:7/', token: 'a'.repeat(32)}, onExit}
    },
    stopBackend: async () => {},
    schedule: (callback, delay) => {
      scheduled.push({callback, delay})
      return callback
    },
    cancel: () => {},
    onStatus: status => statuses.push(status),
    retryDelays: [1000, 2000],
  })
  await supervisor.start()
  assert.equal(attempts, 1)
  assert.equal(scheduled[0].delay, 1000)
  await scheduled.shift().callback()
  assert.equal(attempts, 2)
  assert.equal(supervisor.status().state, 'ready')
  assert.equal(statuses.some(status => status.state === 'retry_wait'), true)
  assert.equal(statuses.at(-1).connection.endpoint, 'ws://127.0.0.1:7/')
})

test('backend exit retries, manual restart cancels delay, and stop fences stale starts', async () => {
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
      return {backend: {id: startCount}, connection: {endpoint: 'ws://127.0.0.1:8/', token: 'b'.repeat(32)}}
    },
    stopBackend: async backend => { stopped.push(backend.id) },
    schedule: (callback, delay) => {
      const handle = {callback, delay, canceled: false}
      scheduled.push(handle)
      return handle
    },
    cancel: handle => { handle.canceled = true },
    onStatus: () => {},
    retryDelays: [1000],
  })
  await supervisor.start()
  exit('backend_exit')
  assert.equal(scheduled.at(-1).delay, 1000)
  await supervisor.restart()
  assert.equal(scheduled[0].canceled, true)
  assert.equal(startCount, 2)
  const third = supervisor.restart()
  while (startCount < 3) await Promise.resolve()
  await supervisor.stop()
  pending.resolve({backend: {id: 3}, connection: {endpoint: 'ws://127.0.0.1:9/', token: 'c'.repeat(32)}})
  await third
  assert.deepEqual(stopped, [2, 3])
  assert.equal(supervisor.status().state, 'stopped')
})
