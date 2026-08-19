import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VirtualClock } from '../src/clock.js'

test('virtual sleep resumes only after the clock advances', async () => {
  const clock = new VirtualClock()
  const wokeAt: number[] = []
  const sleeper = clock.sleep(5).then(() => wokeAt.push(clock.now()))

  await Promise.resolve()
  assert.deepEqual(wokeAt, [])
  assert.equal(clock.waiterCount(), 1)
  assert.equal(clock.nextTimerTimestamp(), 5)

  clock.advanceTo(5)
  await sleeper
  assert.deepEqual(wokeAt, [5])
  assert.equal(clock.waiterCount(), 0)
  assert.equal(clock.nextTimerTimestamp(), undefined)
})

test('virtual clock wakes same-time sleepers in insertion order', async () => {
  const clock = new VirtualClock()
  const order: string[] = []
  const first = clock.sleep(1).then(() => order.push('first'))
  const second = clock.sleep(1).then(() => order.push('second'))

  clock.advanceTo(1)
  await Promise.all([first, second])
  assert.deepEqual(order, ['first', 'second'])
})

test('infinite sleep has no next advance target', () => {
  const clock = new VirtualClock()
  void clock.sleep(Number.POSITIVE_INFINITY)
  assert.equal(clock.waiterCount(), 1)
  assert.equal(clock.nextTimerTimestamp(), undefined)
})

test('virtual clock rejects NaN, negative sleep, and backwards time', () => {
  const clock = new VirtualClock(3)
  assert.throws(() => clock.sleep(Number.NaN), /cannot be NaN/u)
  assert.throws(() => clock.sleep(-1), /cannot be negative/u)
  clock.advanceTo(4)
  assert.throws(() => clock.advanceTo(3.5), /cannot move backwards/u)
})

test('aborting a finite virtual sleep removes its waiter', async () => {
  const clock = new VirtualClock()
  const controller = new AbortController()
  const sleeper = clock.sleep(5, controller.signal)

  controller.abort()

  await assert.rejects(sleeper, {name: 'AbortError'})
  assert.equal(clock.waiterCount(), 0)
  assert.equal(clock.nextTimerTimestamp(), undefined)
})

test('aborting an infinite virtual sleep cannot pin quiescence', async () => {
  const clock = new VirtualClock()
  const controller = new AbortController()
  const sleeper = clock.sleep(Number.POSITIVE_INFINITY, controller.signal)

  controller.abort()

  await assert.rejects(sleeper, {name: 'AbortError'})
  assert.equal(clock.waiterCount(), 0)
  assert.equal(clock.nextTimerTimestamp(), undefined)
})
