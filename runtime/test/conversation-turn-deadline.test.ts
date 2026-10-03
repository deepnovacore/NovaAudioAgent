import assert from 'node:assert/strict'
import test from 'node:test'
import {VirtualClock} from '../src/core/clock.js'
import {createTurnDeadline} from '../src/personal-agent/turn-deadline.js'

function fixture(initialWaiting = false) {
  const clock = new VirtualClock()
  const parent = new AbortController()
  const listeners = new Set<() => void>()
  let waiting = initialWaiting
  const deadline = createTurnDeadline({clock, parent: parent.signal, isWaiting: () => waiting,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  return {clock, parent, listeners, deadline,
    notify: () => { for (const listener of listeners) listener() },
    setWaiting: (value: boolean) => { waiting = value; for (const listener of listeners) listener() },
    advance: async (seconds: number) => { clock.advanceTo(clock.now() + seconds); await Promise.resolve() },
  }
}

test('ordinary turns expire at 120 seconds; unrelated notifications cannot extend the deadline', async () => {
  const value = fixture()
  await value.advance(119)
  value.notify()
  assert.equal(value.deadline.signal.aborted, false)
  await value.advance(1)
  assert.equal(value.deadline.signal.aborted, true)
  assert.ok(value.deadline.signal.reason instanceof DOMException)
  assert.equal(value.deadline.signal.reason.name, 'TimeoutError')
  assert.equal(value.listeners.size, 0)
  assert.equal(value.clock.waiterCount(), 0)
})

test('human approval waits pause indefinitely and release restores a fresh 120 seconds', async () => {
  const value = fixture()
  await value.advance(119)
  value.setWaiting(true)
  assert.equal(value.clock.waiterCount(), 0)
  await value.advance(7200)
  assert.equal(value.deadline.signal.aborted, false)
  value.notify()
  value.setWaiting(false)
  await value.advance(119)
  assert.equal(value.deadline.signal.aborted, false)
  await value.advance(1)
  assert.ok(value.deadline.signal.reason instanceof DOMException)
  assert.equal(value.deadline.signal.reason.name, 'TimeoutError')
})

test('parent cancellation is immediate during human wait and preserves its reason', () => {
  const value = fixture(true)
  const reason = new Error('caller cancelled')
  value.parent.abort(reason)
  assert.equal(value.deadline.signal.reason, reason)
  assert.equal(value.listeners.size, 0)
  assert.equal(value.clock.waiterCount(), 0)
})

test('closing removes timers and subscriptions without aborting a completed response', async () => {
  const value = fixture()
  value.deadline.close()
  value.deadline.close()
  assert.equal(value.clock.waiterCount(), 0)
  assert.equal(value.listeners.size, 0)
  value.parent.abort()
  await value.advance(7200)
  assert.equal(value.deadline.signal.aborted, false)
})

test('a wait notification invalidates an already queued timeout callback', async () => {
  const value = fixture()
  value.clock.advanceTo(120)
  value.setWaiting(true)
  await Promise.resolve()
  assert.equal(value.deadline.signal.aborted, false)
  value.setWaiting(false)
  await value.advance(120)
  assert.ok(value.deadline.signal.reason instanceof DOMException)
  assert.equal(value.deadline.signal.reason.name, 'TimeoutError')
})

test('already aborted parent creates no timer or subscription', () => {
  const clock = new VirtualClock()
  const parent = new AbortController()
  parent.abort()
  const deadline = createTurnDeadline({clock, parent: parent.signal, isWaiting: () => false,
    subscribe: () => { assert.fail('must not subscribe after cancellation') },
  })
  assert.equal(deadline.signal.reason, parent.signal.reason)
  assert.equal(clock.waiterCount(), 0)
})
