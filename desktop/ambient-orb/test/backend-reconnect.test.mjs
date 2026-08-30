import assert from 'node:assert/strict'
import test from 'node:test'

import {GenerationPlayback} from '../src/renderer/audio.mjs'
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

test('a new backend identity resets playback before runtime epoch one is opened', () => {
  const replacement = Object.freeze({
    endpoint: 'ws://127.0.0.1:32124',
    token: 'fedcba9876543210fedcba9876543210',
  })
  const playback = new GenerationPlayback()
  let epochOneAccepted = null
  const recovery = new BackendReconnectController({
    open: connection => {
      if (connection.token !== replacement.token) return
      epochOneAccepted = playback.accept({
        utteranceId: 'new-runtime',
        generationEpoch: 1,
        sequence: 0,
        pcm: new Uint8Array([0, 1]),
      })
    },
    onConnectionReplaced: () => { playback.backendExited() },
  })

  recovery.setConnection(CONNECTION)
  assert.equal(playback.accept({
    utteranceId: 'old-runtime',
    generationEpoch: 5,
    sequence: 0,
    pcm: new Uint8Array([0, 1]),
  }), true)

  recovery.setConnection(replacement)
  assert.equal(epochOneAccepted, true)
})

test('a new backend identity drops diagnostics queued for the former runtime', () => {
  const timer = timerHarness()
  const replacement = Object.freeze({
    endpoint: 'ws://127.0.0.1:32124',
    token: 'fedcba9876543210fedcba9876543210',
  })
  const delivered = []
  let writable = false
  const recovery = new BackendReconnectController({
    open: () => {},
    scheduleTimeout: timer.scheduleTimeout,
    cancelTimeout: timer.cancelTimeout,
    random: () => 0.5,
    sendDiagnostic: diagnostic => {
      if (!writable) return false
      delivered.push(diagnostic)
      return true
    },
  })

  recovery.setConnection(CONNECTION)
  recovery.socketClosed({code: 1006})
  recovery.setConnection(replacement)
  writable = true
  recovery.socketOpened()

  assert.deepEqual(delivered, [])
})

test('a socket that stays connecting is canceled and enters bounded retry', () => {
  const timer = timerHarness()
  const states = []
  const diagnostics = []
  let canceled = 0
  const recovery = new BackendReconnectController({
    open: () => () => { canceled += 1 },
    scheduleTimeout: timer.scheduleTimeout,
    cancelTimeout: timer.cancelTimeout,
    random: () => 0.5,
    onState: state => states.push(state),
    sendDiagnostic: diagnostic => { diagnostics.push(diagnostic); return true },
    connectTimeoutMs: 1_000,
  })

  recovery.setConnection(CONNECTION)
  const deadline = timer.runNext()

  assert.equal(deadline.delay, 1_000)
  assert.equal(canceled, 1)
  assert.equal(states.at(-1), 'reconnecting')
  assert.deepEqual(diagnostics, [{
    phase: 'reconnect_result', attempt: 0, result: 'open_failed',
  }, {
    phase: 'reconnect_attempt', attempt: 1, delay_ms: 250,
  }])
})

test('a canceled connect deadline cannot move an opened socket back into recovery', () => {
  const timer = timerHarness()
  const states = []
  const recovery = new BackendReconnectController({
    open: () => () => {},
    scheduleTimeout: timer.scheduleTimeout,
    cancelTimeout: timer.cancelTimeout,
    onState: state => states.push(state),
  })

  recovery.setConnection(CONNECTION)
  const staleDeadline = timer.timers[0]
  recovery.socketOpened()
  staleDeadline.callback()

  assert.deepEqual(states, ['connected'])
  assert.equal(timer.timers.filter(candidate => !candidate.cancelled).length, 0)
})

test('an old connect deadline cannot cancel the next retry attempt', () => {
  const timer = timerHarness()
  const canceledAttempts = []
  let attempt = -1
  const recovery = new BackendReconnectController({
    open: (_connection, context) => {
      attempt = context.attempt
      return () => { canceledAttempts.push(context.attempt) }
    },
    scheduleTimeout: timer.scheduleTimeout,
    cancelTimeout: timer.cancelTimeout,
    random: () => 0.5,
  })

  recovery.setConnection(CONNECTION)
  const staleDeadline = timer.timers[0]
  recovery.socketClosed({code: 1006})
  timer.runNext()
  assert.equal(attempt, 1)

  staleDeadline.callback()

  assert.deepEqual(canceledAttempts, [])
  assert.equal(timer.timers.filter(candidate => !candidate.cancelled).length, 1)
  assert.equal(timer.timers.find(candidate => !candidate.cancelled)?.delay, 5_000)
})
