import assert from 'node:assert/strict'
import test from 'node:test'

import {BackendReconnectController} from '../src/renderer/backend-reconnect.mjs'

const CONNECTION = Object.freeze({
  endpoint: 'ws://127.0.0.1:32123',
  token: '0123456789abcdef0123456789abcdef',
})

function timerHarness() {
  const timers = []
  return {
    timers,
    scheduleTimeout(callback, delay) {
      const timer = {callback, delay, cancelled: false}
      timers.push(timer)
      return timer
    },
    cancelTimeout(timer) {
      timer.cancelled = true
    },
    runNext() {
      const timer = timers.find(candidate => !candidate.cancelled)
      assert.ok(timer)
      timer.cancelled = true
      timer.callback()
      return timer
    },
  }
}

test('renderer reconnects with bounded backoff and flushes sanitized diagnostics after auth', () => {
  const timer = timerHarness()
  const opened = []
  const states = []
  const delivered = []
  let writable = false
  const recovery = new BackendReconnectController({
    open: (connection, context) => opened.push({connection, context}),
    scheduleTimeout: timer.scheduleTimeout,
    cancelTimeout: timer.cancelTimeout,
    random: () => 0.5,
    onState: state => states.push(state),
    sendDiagnostic: diagnostic => {
      if (!writable) return false
      delivered.push(diagnostic)
      return true
    },
  })

  recovery.setConnection(CONNECTION)
  assert.deepEqual(opened, [{connection: CONNECTION, context: {attempt: 0}}])
  recovery.socketClosed({code: 1009, reason: 'arbitrary peer text is never retained'})
  assert.equal(timer.timers[0].delay, 250)
  assert.equal(states.at(-1), 'reconnecting')

  timer.runNext()
  assert.deepEqual(opened.at(-1), {connection: CONNECTION, context: {attempt: 1}})
  writable = true
  recovery.socketOpened()
  assert.equal(states.at(-1), 'connected')
  assert.deepEqual(delivered, [{
    phase: 'closed', close_code: 1009, reason: 'message_too_big',
  }, {
    phase: 'reconnect_attempt', attempt: 1, delay_ms: 250,
  }, {
    phase: 'reconnect_result', attempt: 1, result: 'connected',
  }])
})

test('backend exit cancels local recovery and stale timer callbacks cannot reopen it', () => {
  const timer = timerHarness()
  const opened = []
  const recovery = new BackendReconnectController({
    open: connection => opened.push(connection),
    scheduleTimeout: timer.scheduleTimeout,
    cancelTimeout: timer.cancelTimeout,
    random: () => 0.5,
    onState: () => {},
    sendDiagnostic: () => false,
  })

  recovery.setConnection(CONNECTION)
  recovery.socketClosed({code: 1006})
  const pending = timer.timers[0]
  recovery.backendExited()
  pending.callback()
  assert.deepEqual(opened, [CONNECTION])
  assert.equal(pending.cancelled, true)
})
