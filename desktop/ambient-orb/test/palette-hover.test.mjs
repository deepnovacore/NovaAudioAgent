import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HOVER_DELAY_MS,
  PALETTE_HOLD_MS,
  PALETTE_TRANSITION_MS,
  OrbPaletteHoverController,
} from '../src/renderer/palette-hover.mjs'

function harness(initialPalette = 'ember') {
  let nextId = 0
  const timers = new Map()
  const cancelled = []
  const transitions = []
  const textPalettes = []
  const immediate = []
  const controller = new OrbPaletteHoverController({
    initialPalette,
    schedule: (callback, delayMs) => {
      nextId += 1
      timers.set(nextId, { callback, delayMs })
      return nextId
    },
    cancel: id => {
      cancelled.push(id)
      timers.delete(id)
    },
    transition: (palette, options) => transitions.push({ palette, ...options }),
    setPalette: palette => immediate.push(palette),
    setTextPalette: (palette, durationMs) => textPalettes.push({ palette, durationMs }),
  })
  const takeTimer = delayMs => {
    const entry = [...timers.entries()].find(([, timer]) => timer.delayMs === delayMs)
    assert.ok(entry, `expected a ${delayMs}ms timer`)
    timers.delete(entry[0])
    entry[1].callback()
  }
  return { controller, timers, cancelled, transitions, textPalettes, immediate, takeTimer }
}

test('hover must remain continuous for three seconds before the first palette transition', () => {
  const mounted = harness()

  mounted.controller.enter()
  assert.equal(mounted.transitions.length, 0)
  assert.equal([...mounted.timers.values()][0].delayMs, HOVER_DELAY_MS)

  mounted.controller.leave()
  assert.equal(mounted.transitions.length, 0, 'leaving at 2999ms-equivalent cancels the dwell')
  assert.equal(mounted.timers.size, 0)

  mounted.controller.enter()
  mounted.takeTimer(HOVER_DELAY_MS)
  assert.equal(mounted.transitions.length, 1)
  assert.equal(mounted.transitions[0].palette, 'halpha')
  assert.equal(mounted.transitions[0].durationMs, PALETTE_TRANSITION_MS)
  assert.deepEqual(mounted.textPalettes, [{ palette: 'halpha', durationMs: PALETTE_TRANSITION_MS }])
})

test('continuous hover holds for four seconds between slow palette transitions', () => {
  const mounted = harness()

  mounted.controller.enter()
  mounted.takeTimer(HOVER_DELAY_MS)
  mounted.transitions[0].onComplete()

  assert.equal([...mounted.timers.values()][0].delayMs, PALETTE_HOLD_MS)
  mounted.takeTimer(PALETTE_HOLD_MS)
  assert.equal(mounted.transitions[1].palette, 'ion')
})

test('leaving during a transition completes the target and freezes until another long hover', () => {
  const mounted = harness()

  mounted.controller.enter()
  mounted.takeTimer(HOVER_DELAY_MS)
  mounted.controller.leave()
  mounted.transitions[0].onComplete()
  assert.equal(mounted.timers.size, 0, 'no hold or next transition is armed after leave')

  mounted.controller.enter()
  mounted.takeTimer(HOVER_DELAY_MS)
  assert.equal(mounted.transitions[1].palette, 'ion', 'the next visit continues after the frozen target')
})

test('settings reset and accessibility disable cancel all automatic palette timing', () => {
  const mounted = harness()

  mounted.controller.enter()
  mounted.controller.reset('graphite')
  assert.deepEqual(mounted.immediate, ['graphite'])
  assert.equal([...mounted.timers.values()][0].delayMs, HOVER_DELAY_MS, 'an active hover starts a fresh dwell')

  mounted.controller.setDisabled(true)
  assert.equal(mounted.timers.size, 0)
  mounted.controller.enter()
  assert.equal(mounted.timers.size, 0)

  mounted.controller.setDisabled(false)
  assert.equal([...mounted.timers.values()][0].delayMs, HOVER_DELAY_MS, 'reenabling under the pointer starts fresh')
  mounted.controller.destroy()
  assert.equal(mounted.timers.size, 0)
})

test('browser timer functions keep their required global receiver', () => {
  let scheduled = null
  const schedule = function (callback, delayMs) {
    assert.equal(this, globalThis)
    scheduled = { callback, delayMs }
    return 41
  }
  const cancel = function (id) {
    assert.equal(this, globalThis)
    assert.equal(id, 41)
  }
  const controller = new OrbPaletteHoverController({
    transition() {},
    setPalette() {},
    setTextPalette() {},
    schedule,
    cancel,
  })

  controller.enter()
  assert.equal(scheduled.delayMs, HOVER_DELAY_MS)
  controller.leave()
})
