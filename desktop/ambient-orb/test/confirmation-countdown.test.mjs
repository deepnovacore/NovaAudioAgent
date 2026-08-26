import assert from 'node:assert/strict'
import test from 'node:test'

import { ConfirmationCountdown } from '../src/renderer/confirmation-countdown.mjs'

function fakeTime() {
  let now = 1_000
  let sequence = 0
  const tasks = new Map()
  return {
    now: () => now,
    schedule(callback, delay) {
      const id = ++sequence
      tasks.set(id, {callback, due: now + delay})
      return id
    },
    cancel(id) {
      tasks.delete(id)
    },
    advance(milliseconds) {
      const target = now + milliseconds
      while (true) {
        const next = [...tasks.entries()]
          .filter(([, task]) => task.due <= target)
          .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0]
        if (!next) break
        const [id, task] = next
        tasks.delete(id)
        now = task.due
        task.callback()
      }
      now = target
    },
    pending: () => tasks.size,
  }
}

test('counts a relative confirmation snapshot down on second boundaries', () => {
  const time = fakeTime()
  const ticks = []
  const countdown = new ConfirmationCountdown({
    now: time.now,
    schedule: time.schedule,
    cancel: time.cancel,
    onTick: seconds => ticks.push(Math.ceil(seconds)),
  })

  countdown.start(2.4)
  assert.equal(time.pending(), 1)
  time.advance(399)
  assert.deepEqual(ticks, [])
  time.advance(1)
  assert.deepEqual(ticks, [2])
  time.advance(1_000)
  assert.deepEqual(ticks, [2, 1])
  time.advance(1_000)
  assert.deepEqual(ticks, [2, 1, 0])
  assert.equal(time.pending(), 0)
})

test('settlement clears the confirmation timer and stale callbacks cannot update the UI', () => {
  const time = fakeTime()
  const ticks = []
  const countdown = new ConfirmationCountdown({
    now: time.now,
    schedule: time.schedule,
    cancel: time.cancel,
    onTick: seconds => ticks.push(seconds),
  })

  countdown.start(90)
  countdown.stop()
  time.advance(90_000)

  assert.deepEqual(ticks, [])
  assert.equal(time.pending(), 0)
})
