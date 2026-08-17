import assert from 'node:assert/strict'
import test from 'node:test'

import { createDragController } from '../src/main/drag-controller.mjs'

function identityClamp(position) {
  return position
}

test('same-DPI move: cursor delta translates one-to-one into the window position', () => {
  let cursor = { x: 500, y: 500 }
  const windowStart = { x: 100, y: 200 }
  const positions = []
  const controller = createDragController({
    getCursor: () => cursor,
    getWindowPosition: () => windowStart,
    setWindowPosition: position => positions.push(position),
    clamp: identityClamp,
  })

  controller.start()
  cursor = { x: 530, y: 540 }
  controller.tick()

  assert.deepEqual(positions, [{ x: 130, y: 240 }])
})

test('clamped move: the clamp function caps the candidate before it reaches setWindowPosition', () => {
  let cursor = { x: 0, y: 0 }
  const windowStart = { x: 10, y: 10 }
  const positions = []
  const controller = createDragController({
    getCursor: () => cursor,
    getWindowPosition: () => windowStart,
    setWindowPosition: position => positions.push(position),
    clamp: position => ({ x: Math.min(position.x, 20), y: Math.min(position.y, 20) }),
  })

  controller.start()
  cursor = { x: 100, y: 100 } // uncapped candidate would be { x: 110, y: 110 }
  controller.tick()

  assert.deepEqual(positions, [{ x: 20, y: 20 }])
})

test('no-move click: start immediately followed by end reports no movement', () => {
  const windowStart = { x: 50, y: 60 }
  const controller = createDragController({
    getCursor: () => ({ x: 1, y: 1 }),
    getWindowPosition: () => windowStart,
    setWindowPosition: () => assert.fail('setWindowPosition must not be called without a tick'),
    clamp: identityClamp,
  })

  controller.start()
  const result = controller.end()

  assert.deepEqual(result, { moved: false, position: windowStart })
})

test('a tick whose clamped result equals windowStart does not count as movement', () => {
  let cursor = { x: 0, y: 0 }
  const windowStart = { x: 10, y: 10 }
  const controller = createDragController({
    getCursor: () => cursor,
    getWindowPosition: () => windowStart,
    setWindowPosition: () => {},
    // Clamp snaps everything back to the starting corner, e.g. a fully
    // occluded work area edge.
    clamp: () => ({ x: 10, y: 10 }),
  })

  controller.start()
  cursor = { x: 40, y: 40 }
  controller.tick()
  const result = controller.end()

  assert.deepEqual(result, { moved: false, position: { x: 10, y: 10 } })
})

test('tick and end before start are no-ops', () => {
  const controller = createDragController({
    getCursor: () => ({ x: 999, y: 999 }),
    getWindowPosition: () => assert.fail('getWindowPosition must not be read before start'),
    setWindowPosition: () => assert.fail('setWindowPosition must not be called before start'),
    clamp: identityClamp,
  })

  assert.doesNotThrow(() => controller.tick())
  assert.deepEqual(controller.end(), { moved: false, position: null })
})

test('end returns the final clamped position after multiple ticks', () => {
  let cursor = { x: 0, y: 0 }
  const windowStart = { x: 100, y: 100 }
  const positions = []
  const controller = createDragController({
    getCursor: () => cursor,
    getWindowPosition: () => windowStart,
    setWindowPosition: position => positions.push(position),
    clamp: identityClamp,
  })

  controller.start()
  cursor = { x: 10, y: 5 }
  controller.tick()
  cursor = { x: 25, y: -5 }
  controller.tick()
  const result = controller.end()

  assert.deepEqual(positions, [{ x: 110, y: 105 }, { x: 125, y: 95 }])
  assert.deepEqual(result, { moved: true, position: { x: 125, y: 95 } })
})

test('starting a new drag resets cursor and window anchors', () => {
  let cursor = { x: 0, y: 0 }
  let windowPosition = { x: 100, y: 100 }
  const controller = createDragController({
    getCursor: () => cursor,
    getWindowPosition: () => windowPosition,
    setWindowPosition: position => { windowPosition = position },
    clamp: identityClamp,
  })

  controller.start()
  cursor = { x: 30, y: 0 }
  controller.tick()
  controller.end()
  assert.deepEqual(windowPosition, { x: 130, y: 100 })

  controller.start()
  cursor = { x: 40, y: 0 }
  controller.tick()
  const result = controller.end()

  assert.deepEqual(result, { moved: true, position: { x: 140, y: 100 } })
})
