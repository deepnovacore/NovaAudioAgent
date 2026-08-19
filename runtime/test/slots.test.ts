import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SLOTS,
  SlotSet,
  higherWakeReason,
  wakeReasonSchema,
  type Slot,
  type WakeReason,
} from '../src/slots.js'

const userWake = wakeReasonSchema.parse({
  kind: 'user_input',
  priority: 100,
  routing_class: 'user_awaited',
})
const handoffWake = wakeReasonSchema.parse({kind: 'handoff', priority: 50})
const compressWake = wakeReasonSchema.parse({kind: 'compress', priority: 0})

test('watch and compress have independent single-flight slots', () => {
  assert.deepEqual(SLOTS, ['fast', 'surrogate.watch', 'compress'])
  const spawned: Slot[] = []
  const slots = new SlotSet(slot => {
    spawned.push(slot)
    return `job-${spawned.length}`
  })
  slots.wake('surrogate.watch', handoffWake)
  slots.wake('compress', compressWake)
  assert.deepEqual(spawned, ['surrogate.watch', 'compress'])
})

test('pending wakes merge by priority and routing without a ghost rerun', () => {
  const spawned: WakeReason[] = []
  const slots = new SlotSet((_slot, reason) => {
    spawned.push(reason)
    return `job-${spawned.length}`
  })
  slots.wake('fast', handoffWake)
  slots.wake('fast', userWake)
  slots.wake('fast', compressWake)
  assert.equal(spawned.length, 1)
  assert.deepEqual(slots.pending.fast, userWake)

  slots.onDone('fast', 'job-1', () => undefined)
  slots.onDone('fast', 'job-2', () => undefined)
  assert.deepEqual(spawned, [handoffWake, userWake])
  assert.equal(slots.pending.fast, null)
  assert.equal(slots.inflight.fast, false)
})

test('a wake raised while consuming output is retained', () => {
  const spawned: WakeReason[] = []
  const slots = new SlotSet((_slot, reason) => {
    spawned.push(reason)
    return `job-${spawned.length}`
  })
  slots.wake('fast', handoffWake)
  slots.onDone('fast', 'job-1', () => slots.wake('fast', userWake))
  assert.deepEqual(spawned, [handoffWake, userWake])
  assert.equal(slots.inflight.fast, true)
})

test('a stale or wrong-slot completion cannot consume the active job', () => {
  const slots = new SlotSet(slot => `job-${slot}`)
  slots.wake('fast', userWake)

  assert.throws(() => slots.onDone('fast', 'job-old', () => undefined), /stale model completion/u)
  assert.throws(
    () => slots.onDone('surrogate.watch', 'job-fast', () => undefined),
    /stale model completion/u,
  )
  assert.equal(slots.activeJobId.fast, 'job-fast')
  assert.equal(slots.inflight.fast, true)
})

test('routing can escalate but never downgrade when priorities merge', () => {
  const urgentAmbient = wakeReasonSchema.parse({kind: 'handoff', priority: 150})
  const merged = higherWakeReason(userWake, urgentAmbient)
  assert.equal(merged.priority, 150)
  assert.equal(merged.kind, 'handoff')
  assert.equal(merged.routing_class, 'user_awaited')
  assert.equal(higherWakeReason(urgentAmbient, userWake).routing_class, 'user_awaited')
})
