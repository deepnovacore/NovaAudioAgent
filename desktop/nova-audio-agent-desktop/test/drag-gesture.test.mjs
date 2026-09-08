import assert from 'node:assert/strict'
import test from 'node:test'

import { OrbDragGesture } from '../src/renderer/drag-gesture.mjs'

test('movement below six pixels remains a click', () => {
  const gesture = new OrbDragGesture()
  gesture.start(100, 100)
  assert.equal(gesture.move(103, 104), null)
  assert.deepEqual(gesture.finish(), { active: true, dragged: false })
  assert.equal(gesture.consumeClick(), true)
})

test('crossing six pixels emits accumulated then incremental deltas', () => {
  const gesture = new OrbDragGesture()
  gesture.start(100, 100)
  assert.equal(gesture.move(103, 104), null)
  assert.deepEqual(gesture.move(106, 100), { dx: 6, dy: 0 })
  assert.deepEqual(gesture.move(110, 103), { dx: 4, dy: 3 })
  assert.deepEqual(gesture.finish(), { active: true, dragged: true })
  assert.equal(gesture.consumeClick(), false)
  assert.equal(gesture.consumeClick(), true)
})

test('cancellation ends the active drag without poisoning the next click', () => {
  const gesture = new OrbDragGesture()
  gesture.start(0, 0)
  gesture.move(8, 0)
  assert.deepEqual(gesture.cancel(), { active: true, dragged: true })
  assert.equal(gesture.move(9, 0), null)
  assert.equal(gesture.consumeClick(), true)
})

test('stray move and finish events are inert without an active gesture', () => {
  const gesture = new OrbDragGesture()
  assert.equal(gesture.move(9, 0), null)
  assert.deepEqual(gesture.finish(), { active: false, dragged: false })
})

test('keeps returning a truthy zero delta while latched (cursor-poll ticks depend on it)', () => {
  const gesture = new OrbDragGesture()
  gesture.start(100, 100)
  assert.deepEqual(gesture.move(106, 100), { dx: 6, dy: 0 })
  const delta = gesture.move(106, 100)
  assert.ok(delta)
  assert.deepEqual(delta, { dx: 0, dy: 0 })
})
