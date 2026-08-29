import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  clampWindowPosition,
  confirmationWindowLayout,
  createConfirmationWindowController,
  loadWindowPosition,
  naturalWindowPositionAfterTemporaryDrag,
  saveWindowPosition,
  validDragDelta,
} from '../src/main/window-position.mjs'

test('accepts only finite bounded drag deltas', () => {
  assert.equal(validDragDelta(12, -4), true)
  assert.equal(validDragDelta(2048, -2048), true)
  assert.equal(validDragDelta(2049, 0), false)
  assert.equal(validDragDelta(Number.NaN, 0), false)
})

test('clamps the entire window inside the work area', () => {
  assert.deepEqual(
    clampWindowPosition(
      { x: 1900, y: -40 },
      { width: 184, height: 184 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    ),
    { x: 1736, y: 0 },
  )
})

test('anchors a larger window to the work area top-left', () => {
  assert.deepEqual(
    clampWindowPosition(
      { x: 300, y: 400 },
      { width: 1921, height: 1081 },
      { x: 12, y: 34, width: 1920, height: 1080 },
    ),
    { x: 12, y: 34 },
  )
})

test('confirmation layout keeps 100% at 160 square and expands only height at 125% and 150%', () => {
  const normalBounds = {x: 600, y: 200, width: 160, height: 160}
  const workArea = {x: 0, y: 0, width: 1440, height: 900}
  const layouts = [1, 1.25, 1.5].map(zoomFactor => confirmationWindowLayout({
    normalBounds,
    zoomFactor,
    workArea,
  }))

  assert.deepEqual(layouts.map(layout => layout.bounds.width), [160, 160, 160])
  assert.deepEqual(layouts.map(layout => layout.bounds.height), [160, 200, 240])
  assert.deepEqual(layouts.map(layout => layout.placement), ['below', 'below', 'below'])
  for (const layout of layouts) {
    assert.deepEqual(layout.orbScreenCenter, {x: 680, y: 280})
    assert.ok(Math.abs(layout.renderedOrbScreenCenter.y - 280) <= 1)
  }
})

test('confirmation layout flips above near the bottom and preserves the orb screen center', () => {
  const layout = confirmationWindowLayout({
    normalBounds: {x: 600, y: 740, width: 160, height: 160},
    zoomFactor: 1.5,
    workArea: {x: 0, y: 0, width: 1440, height: 900},
  })

  assert.equal(layout.placement, 'above')
  assert.equal(layout.bounds.height, 240)
  assert.ok(layout.bounds.y >= 0)
  assert.ok(layout.bounds.y + layout.bounds.height <= 900)
  assert.ok(Math.abs(layout.renderedOrbScreenCenter.y - layout.orbScreenCenter.y) <= 1)
})

test('confirmation layout stays inside the selected negative-coordinate display work area', () => {
  const workArea = {x: -1920, y: 24, width: 1920, height: 1056}
  const layout = confirmationWindowLayout({
    normalBounds: {x: -1800, y: 800, width: 160, height: 160},
    zoomFactor: 1.25,
    workArea,
  })

  assert.ok(layout.bounds.x >= workArea.x)
  assert.ok(layout.bounds.x + layout.bounds.width <= workArea.x + workArea.width)
  assert.ok(layout.bounds.y >= workArea.y)
  assert.ok(layout.bounds.y + layout.bounds.height <= workArea.y + workArea.height)
})

test('a temporary confirmation drag persists the translated natural 160 square anchor', () => {
  const natural = naturalWindowPositionAfterTemporaryDrag({
    normalBounds: {x: 600, y: 740, width: 160, height: 160},
    temporaryBounds: {x: 600, y: 660, width: 160, height: 240},
    draggedPosition: {x: 500, y: 560},
    workArea: {x: 0, y: 0, width: 1440, height: 900},
  })

  assert.deepEqual(natural, {x: 500, y: 640})
})

test('confirmation window controller restores bounds and persists only a dragged natural anchor', () => {
  let bounds = {x: 600, y: 740, width: 160, height: 160}
  const applied = []
  const placements = []
  const controller = createConfirmationWindowController({
    getBounds: () => bounds,
    setBounds: next => {
      bounds = next
      applied.push(next)
    },
    getZoomFactor: () => 1.5,
    getWorkAreaForPoint: () => ({x: 0, y: 0, width: 1440, height: 900}),
    onPlacement: placement => placements.push(placement),
  })

  controller.setMode(true)
  assert.deepEqual(bounds, {x: 600, y: 659, width: 160, height: 240})
  const dragged = controller.finishDrag({x: 500, y: 559})
  assert.deepEqual(dragged, {x: 500, y: 640})
  assert.deepEqual(bounds, {x: 500, y: 640, width: 160, height: 240})
  controller.setMode(false)
  assert.deepEqual(bounds, {x: 500, y: 640, width: 160, height: 160})
  assert.deepEqual(placements, ['above', 'below', 'below'])
  assert.equal(applied.length, 3)
})

test('returns null for a missing position file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-orb-position-'))
  try {
    assert.equal(await loadWindowPosition(join(directory, 'missing.json')), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('round-trips a saved position and rejects corrupt data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-orb-position-'))
  const file = join(directory, 'ambient-orb-window-position.json')
  try {
    await saveWindowPosition(file, { x: 321, y: 45 })
    assert.deepEqual(await loadWindowPosition(file), { x: 321, y: 45 })
    await writeFile(file, '{broken', 'utf8')
    assert.equal(await loadWindowPosition(file), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects non-integer coordinates when saving or loading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-orb-position-'))
  const file = join(directory, 'ambient-orb-window-position.json')
  try {
    await assert.rejects(saveWindowPosition(file, { x: 1.5, y: 45 }), TypeError)
    await writeFile(file, JSON.stringify({ x: 321, y: 45.5 }), 'utf8')
    assert.equal(await loadWindowPosition(file), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
