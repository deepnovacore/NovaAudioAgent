import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  clampWindowPosition,
  confirmationWindowLayout,
  createOrbWindowController,
  DORMANT_ORB_WINDOW_SIZE,
  dormantWindowLayout,
  loadWindowPosition,
  saveWindowPosition,
  validDragDelta,
} from '../src/main/window-position.mjs'

const dormantWorkArea = {x: 0, y: 0, width: 1440, height: 900}
const dormantNormalBounds = {x: 600, y: 300, width: 160, height: 160}

test('the dormant surface shrinks around the anchor centre, not its origin', () => {
  const layout = dormantWindowLayout({
    normalBounds: dormantNormalBounds,
    workArea: dormantWorkArea,
  })

  // The orb is drawn centred in its window, so the centre is the only point
  // that may not move: anchoring anywhere else would fling the bubble across
  // the screen on every sleep and wake.
  //
  // Concentricity is also what keeps the hover lift from oscillating. The
  // resting window sits entirely inside the natural one, so entering the
  // bubble means the pointer is already inside the larger window it grows
  // into, and the shrink only ever happens because the pointer just left.
  // Anchor this anywhere but the centre and the two windows stop nesting:
  // growing could then move an edge past the cursor and flap the bounds.
  assert.deepEqual(layout.bounds, {x: 648, y: 348, width: 64, height: 64})
  assert.deepEqual(layout.renderedOrbScreenCenter, {x: 680, y: 380})
  assert.deepEqual(layout.renderedOrbScreenCenter, {x: 600 + 80, y: 300 + 80})

  // Stated as nesting, not just as a shared centre, because nesting is the
  // property the hover lift depends on.
  const natural = dormantNormalBounds
  assert.ok(layout.bounds.x >= natural.x, 'resting window nests horizontally')
  assert.ok(layout.bounds.y >= natural.y, 'resting window nests vertically')
  assert.ok(layout.bounds.x + layout.bounds.width <= natural.x + natural.width)
  assert.ok(layout.bounds.y + layout.bounds.height <= natural.y + natural.height)
})

test('the dormant surface stays inside the work area and rejects bad geometry', () => {
  const layout = dormantWindowLayout({
    normalBounds: {x: 1400, y: 870, width: 160, height: 160},
    workArea: dormantWorkArea,
  })
  assert.equal(layout.bounds.x + layout.bounds.width, dormantWorkArea.width)
  assert.equal(layout.bounds.y + layout.bounds.height, dormantWorkArea.height)

  assert.throws(
    () => dormantWindowLayout({normalBounds: null, workArea: dormantWorkArea}),
    TypeError,
  )
})

test('dormancy shrinks the window and yields to every larger surface', () => {
  let bounds = {...dormantNormalBounds}
  const controller = createOrbWindowController({
    getBounds: () => bounds,
    setBounds: next => { bounds = next },
    getZoomFactor: () => 1,
    getScaleFactor: () => 2,
    getWorkAreaForPoint: () => dormantWorkArea,
    onConfirmationPlacement: () => {},
  })

  controller.setDormant(true)
  assert.equal(controller.dormant, true)
  assert.equal(bounds.width, DORMANT_ORB_WINDOW_SIZE.width)
  assert.equal(bounds.height, DORMANT_ORB_WINDOW_SIZE.height)

  // A confirmation card cannot be shown on a 64px window, and its arrival is
  // the opposite of resting, so it takes the bounds back while dormancy waits.
  controller.setConfirmationMode(true)
  assert.ok(bounds.width >= 160, `confirmation reclaimed the window: ${bounds.width}`)
  controller.setConfirmationMode(false)
  assert.equal(bounds.width, DORMANT_ORB_WINDOW_SIZE.width, 'dormancy resumes afterwards')

  // Same for a stack of progress bubbles.
  controller.reserveBubbleArea(2)
  assert.ok(bounds.height > DORMANT_ORB_WINDOW_SIZE.height)
  controller.reserveBubbleArea(0)
  assert.equal(bounds.height, DORMANT_ORB_WINDOW_SIZE.height)

  // Waking restores the natural anchor exactly, centre included.
  controller.setDormant(false)
  assert.deepEqual(bounds, dormantNormalBounds)
})

test('dragging the bubble moves the natural anchor with it', () => {
  let bounds = {...dormantNormalBounds}
  const controller = createOrbWindowController({
    getBounds: () => bounds,
    setBounds: next => { bounds = next },
    getZoomFactor: () => 1,
    getScaleFactor: () => 2,
    getWorkAreaForPoint: () => dormantWorkArea,
    onConfirmationPlacement: () => {},
  })

  controller.setDormant(true)
  const restingOrigin = {...bounds}

  // Drag clamps against the 64px surface, not the natural 160px one: clamping
  // the small window as if it were large would refuse positions that fit.
  const clamped = controller.clampDragPosition({x: 1370, y: 300})
  assert.equal(clamped.x, 1370, 'a bubble still fits where a full orb would not')
  // Proof that the surface, not the anchor, drove that: a 160px window would
  // have been pulled back to 1280, and an over-far bubble stops at 1376.
  assert.equal(controller.clampDragPosition({x: 1439, y: 300}).x, 1440 - 64)

  controller.finishDrag({x: restingOrigin.x + 100, y: restingOrigin.y + 40})

  // Waking must land where the user left the bubble. If the drag only moved
  // the temporary surface, the orb would snap back on every wake and creep
  // across the screen over repeated sleep/wake cycles.
  const restingCentre = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2}
  controller.setDormant(false)
  const awakeCentre = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2}
  assert.deepEqual(awakeCentre, restingCentre, 'the centre survives the wake')
  assert.deepEqual(bounds, {
    x: dormantNormalBounds.x + 100,
    y: dormantNormalBounds.y + 40,
    width: 160,
    height: 160,
  })
})

test('dormancy is idempotent and rejects a non-boolean', () => {
  let bounds = {...dormantNormalBounds}
  let writes = 0
  const controller = createOrbWindowController({
    getBounds: () => bounds,
    setBounds: next => { bounds = next; writes += 1 },
    getZoomFactor: () => 1,
    getScaleFactor: () => 2,
    getWorkAreaForPoint: () => dormantWorkArea,
    onConfirmationPlacement: () => {},
  })

  controller.setDormant(true)
  const afterFirst = writes
  // Hover flapping across the orb and its rail must not restate the bounds.
  controller.setDormant(true)
  assert.equal(writes, afterFirst, 'a repeated request writes nothing')

  assert.throws(() => controller.setDormant('yes'), TypeError)
})

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

test('confirmation layout retains a 160 CSS-pixel surface at elevated zoom and preserves the orb anchor', () => {
  const normalBounds = {x: 600, y: 200, width: 160, height: 160}
  const workArea = {x: 0, y: 0, width: 1440, height: 900}
  const layouts = [1, 1.25, 1.5].map(zoomFactor => confirmationWindowLayout({
    normalBounds,
    zoomFactor,
    workArea,
  }))

  assert.deepEqual(layouts.map(layout => layout.bounds.width), [160, 200, 240])
  assert.deepEqual(layouts.map(layout => layout.bounds.height), [160, 200, 240])
  assert.deepEqual(layouts.map(layout => layout.placement), ['below', 'below', 'below'])
  for (const layout of layouts) {
    assert.ok(layout.bounds.width / [1, 1.25, 1.5][layouts.indexOf(layout)] >= 160)
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
  const file = join(directory, 'nova-audio-agent-desktop-window-position.json')
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
  const file = join(directory, 'nova-audio-agent-desktop-window-position.json')
  try {
    await assert.rejects(saveWindowPosition(file, { x: 1.5, y: 45 }), TypeError)
    await writeFile(file, JSON.stringify({ x: 321, y: 45.5 }), 'utf8')
    assert.equal(await loadWindowPosition(file), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
