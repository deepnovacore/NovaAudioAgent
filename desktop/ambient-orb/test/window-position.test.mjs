import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  clampWindowPosition,
  loadWindowPosition,
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
