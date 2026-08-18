import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createOrbVisual, paletteColors, STATE_PARAMS } from '../src/renderer/orb-visual.mjs'
import { ORB_STATE_NAMES } from '../src/renderer/state.mjs'

// A canvas stub, not jsdom: the visual only ever touches the 2D context surface
// exercised below, so the unit scope can record draw calls instead of pixels.
function stubCanvas(width = 0, height = 0) {
  const calls = { clearRect: 0, fill: 0, stroke: 0, gradients: 0, drawImage: [] }
  const context = {
    calls,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    setTransform() {},
    clearRect() { calls.clearRect += 1 },
    beginPath() {},
    arc() {},
    closePath() {},
    fill() { calls.fill += 1 },
    stroke() { calls.stroke += 1 },
    createRadialGradient() {
      calls.gradients += 1
      return { addColorStop() {} }
    },
    drawImage(...args) {
      calls.drawImage.push({
        args,
        alpha: context.globalAlpha,
        operation: context.globalCompositeOperation,
      })
    },
  }
  const canvas = { width, height, calls, context, getContext: () => context }
  return canvas
}

function mount(options = {}) {
  const canvas = stubCanvas()
  const offscreen = []
  const pending = []
  const cancelled = []
  let nextHandle = 0
  const visual = createOrbVisual(canvas, {
    devicePixelRatio: 2,
    seed: 0x5eed,
    createCanvas: (width, height) => {
      const created = stubCanvas(width, height)
      offscreen.push(created)
      return created
    },
    raf: callback => {
      pending.push(callback)
      nextHandle += 1
      return nextHandle
    },
    cancelRaf: handle => cancelled.push(handle),
    ...options,
  })
  const context = canvas.context
  const step = (advanceMs = 16) => {
    const callback = pending.shift()
    assert.ok(callback, 'expected a scheduled frame')
    step.clock += advanceMs
    callback(step.clock)
  }
  step.clock = 1000
  // Runs the smoothing to steady state so per-state counts are comparable.
  const settle = (frames = 90) => { for (let index = 0; index < frames; index += 1) step() }
  return { visual, canvas, context, offscreen, pending, cancelled, step, settle }
}

// Sprites are drawn with the 9-argument form (atlas cell → destination box),
// so the on-screen centre of each particle lives in the destination rect.
function centres(context) {
  return context.calls.drawImage.map(call => ({
    x: call.args[5] + call.args[7] / 2,
    y: call.args[6] + call.args[8] / 2,
  }))
}

function meanRadius(context) {
  const points = centres(context)
  if (!points.length) return 0
  let total = 0
  for (const point of points) total += Math.hypot(point.x - 58, point.y - 58)
  return total / points.length
}

function drawnCount(context) {
  return context.calls.drawImage.length
}

function resetDraws(context) {
  context.calls.drawImage.length = 0
}

test('STATE_PARAMS covers exactly the orb states derived by state.mjs', () => {
  assert.deepEqual(
    Object.keys(STATE_PARAMS).sort(),
    [...ORB_STATE_NAMES].sort(),
  )
  for (const name of ORB_STATE_NAMES) {
    const params = STATE_PARAMS[name]
    assert.ok(Object.isFrozen(params), `${name} params must be frozen`)
    for (const key of ['convergence', 'orbitSpeed', 'jitter', 'pulseGain', 'alpha', 'countRatio']) {
      assert.ok(Number.isFinite(params[key]), `${name}.${key} must be a finite number`)
    }
    assert.ok(params.alpha > 0 && params.alpha <= 1, `${name}.alpha in (0, 1]`)
    assert.ok(params.countRatio > 0 && params.countRatio <= 1, `${name}.countRatio in (0, 1]`)
  }
})

test('STATE_PARAMS carries the specified per-state behaviour values', () => {
  assert.deepEqual(
    ['convergence', 'orbitSpeed', 'jitter', 'pulseGain', 'alpha', 'countRatio'].map(
      key => STATE_PARAMS.booting[key],
    ),
    [0.4, 0.2, 0.3, 0, 0.7, 0.7],
  )
  assert.deepEqual(
    ['convergence', 'orbitSpeed', 'jitter', 'pulseGain', 'alpha', 'countRatio'].map(
      key => STATE_PARAMS.inactive[key],
    ),
    [0.1, 0.02, 0.02, 0, 0.35, 0.4],
  )
  assert.deepEqual(
    ['convergence', 'orbitSpeed', 'jitter', 'pulseGain', 'alpha', 'countRatio'].map(
      key => STATE_PARAMS.idle[key],
    ),
    [0.25, 0.06, 0.12, 0, 0.8, 1],
  )
  assert.deepEqual(
    ['convergence', 'orbitSpeed', 'jitter', 'pulseGain', 'alpha', 'countRatio'].map(
      key => STATE_PARAMS.candidate[key],
    ),
    [0.35, 0.08, 0.18, 0, 0.9, 1],
  )
  assert.deepEqual(
    ['convergence', 'orbitSpeed', 'jitter', 'pulseGain', 'alpha', 'countRatio'].map(
      key => STATE_PARAMS.listening[key],
    ),
    [0.8, 0.1, 0.1, 0.6, 1, 1],
  )
  assert.deepEqual(
    ['convergence', 'orbitSpeed', 'jitter', 'pulseGain', 'alpha', 'countRatio'].map(
      key => STATE_PARAMS.speaking[key],
    ),
    [0.3, 0.12, 0.2, 1, 1, 1],
  )
  // Listening pulls the pulse inward, speaking pushes it outward.
  assert.equal(STATE_PARAMS.listening.pulseDirection, -1)
  assert.equal(STATE_PARAMS.speaking.pulseDirection, 1)
})

test('interrupted is a one-shot scatter over the listening parameters', () => {
  const { interrupted, listening } = STATE_PARAMS
  assert.ok(interrupted.scatter > 0, 'interrupted carries a scatter impulse')
  assert.equal(listening.scatter, 0)
  for (const key of ['convergence', 'orbitSpeed', 'jitter', 'pulseGain', 'pulseDirection', 'alpha', 'countRatio']) {
    assert.equal(interrupted[key], listening[key], `interrupted.${key} matches listening`)
  }
})

test('disconnected error and permission-denied collapse to the same alert ring', () => {
  for (const name of ['disconnected', 'error', 'permission-denied']) {
    const params = STATE_PARAMS[name]
    assert.equal(params.convergence, 0.9, `${name}.convergence`)
    assert.equal(params.orbitSpeed, 0.03, `${name}.orbitSpeed`)
    assert.equal(params.alpha, 0.5, `${name}.alpha`)
    assert.equal(params.ringRadius, 46, `${name}.ringRadius`)
    assert.equal(params.tone, 'alert', `${name}.tone`)
  }
})

test('paletteColors returns the exact ember table', () => {
  const ember = paletteColors('ember')

  assert.ok(Object.isFrozen(ember))
  assert.deepEqual({ ...ember }, {
    core: '#FFB454',
    highlight: '#FFE3B3',
    deep: '#C96F2B',
    dust: '#8C5A2B',
    dustAlpha: 0.25,
    plate: 'rgba(20, 14, 8, .55)',
    ring: 'rgba(255, 214, 156, .22)',
    codexBand: '#FFD9A0',
    error: '#FF5A5A',
    inactive: '#6E6A63',
  })
})

test('paletteColors returns the exact graphite table', () => {
  const graphite = paletteColors('graphite')

  assert.ok(Object.isFrozen(graphite))
  assert.deepEqual({ ...graphite }, {
    core: '#E8ECF2',
    mid: '#9AA3AF',
    shadow: '#3A404A',
    plate: 'rgba(10, 12, 16, .6)',
    ring: 'rgba(232, 236, 242, .18)',
    accent: '#FFC978',
    error: '#FF6B6B',
  })
})

test('paletteColors falls back to ember for an unknown palette', () => {
  assert.equal(paletteColors('nonexistent'), paletteColors('ember'))
  assert.equal(paletteColors(), paletteColors('ember'))
})

test('sizes the backing store to the orb diameter times a capped pixel ratio', () => {
  const one = mount({ devicePixelRatio: 1 })
  const two = mount({ devicePixelRatio: 2 })
  // Ratios above 2 stop paying for themselves on a 116px disc.
  const three = mount({ devicePixelRatio: 3 })

  assert.deepEqual([one.canvas.width, one.canvas.height], [116, 116])
  assert.deepEqual([two.canvas.width, two.canvas.height], [232, 232])
  assert.deepEqual([three.canvas.width, three.canvas.height], [232, 232])
  for (const mounted of [one, two, three]) mounted.visual.destroy()
})

test('pre-renders the sprite atlas once and never rebuilds it per frame', () => {
  const mounted = mount()

  assert.equal(mounted.offscreen.length, 1, 'a single offscreen atlas')
  const gradientsAfterInit = mounted.offscreen[0].calls.gradients
  assert.ok(gradientsAfterInit > 0, 'atlas cells are radial-gradient discs')

  for (let index = 0; index < 5; index += 1) mounted.step()

  assert.equal(mounted.offscreen[0].calls.gradients, gradientsAfterInit)
  assert.equal(mounted.offscreen.length, 1)
  // Nothing is drawn on the visible canvas by gradient: only atlas blits.
  assert.equal(mounted.context.calls.gradients, 0)
  assert.ok(drawnCount(mounted.context) > 0)
  mounted.visual.destroy()
})

test('composites particles additively from the atlas', () => {
  const mounted = mount()
  mounted.step()

  const draws = mounted.context.calls.drawImage
  assert.ok(draws.length > 0)
  for (const draw of draws) {
    assert.equal(draw.operation, 'lighter')
    assert.equal(draw.args.length, 9, 'atlas cell blit')
    assert.ok(draw.alpha > 0 && draw.alpha <= 1)
  }
  mounted.visual.destroy()
})

test('setState switches the active parameter set and ignores unknown names', () => {
  const mounted = mount()

  assert.equal(mounted.visual.state, 'booting')
  assert.equal(mounted.visual.params, STATE_PARAMS.booting)

  mounted.visual.setState('speaking')
  assert.equal(mounted.visual.state, 'speaking')
  assert.equal(mounted.visual.params, STATE_PARAMS.speaking)

  mounted.visual.setState('listening')
  assert.equal(mounted.visual.params, STATE_PARAMS.listening)

  mounted.visual.setState('not-a-state')
  assert.equal(mounted.visual.state, 'listening', 'an unknown state keeps the last known one')
  mounted.visual.destroy()
})

test('countRatio thins the field for low-energy states', () => {
  const mounted = mount()

  mounted.visual.setState('idle')
  mounted.settle()
  resetDraws(mounted.context)
  mounted.step()
  const idleCount = drawnCount(mounted.context)

  mounted.visual.setState('inactive')
  mounted.settle()
  resetDraws(mounted.context)
  mounted.step()
  const inactiveCount = drawnCount(mounted.context)

  assert.ok(idleCount >= 230 && idleCount <= 240, `idle draws ~240 particles, got ${idleCount}`)
  assert.ok(inactiveCount < idleCount * 0.5, `inactive thins the field, got ${inactiveCount}`)
  mounted.visual.destroy()
})

test('the codex band adds fourteen orbiting particles on any base state', () => {
  const mounted = mount()
  mounted.visual.setState('idle')
  mounted.settle()

  resetDraws(mounted.context)
  mounted.step()
  const withoutCodex = drawnCount(mounted.context)

  mounted.visual.setState('idle', { codexWorking: true })
  resetDraws(mounted.context)
  mounted.step()
  const withCodex = drawnCount(mounted.context)

  assert.equal(withCodex - withoutCodex, 14)

  // The band rides its own radius, independent of the base state's convergence.
  const bandPoints = centres(mounted.context).slice(withoutCodex)
  for (const point of bandPoints) {
    const radius = Math.hypot(point.x - 58, point.y - 58)
    assert.ok(Math.abs(radius - 54) < 0.5, `codex particle sits at radius 54, got ${radius}`)
  }

  mounted.visual.setState('idle', { codexWorking: false })
  resetDraws(mounted.context)
  mounted.step()
  assert.equal(drawnCount(mounted.context), withoutCodex)
  mounted.visual.destroy()
})

test('the interrupted scatter impulse decays back toward the listening field', () => {
  const mounted = mount()
  mounted.visual.setState('listening')
  mounted.settle()
  resetDraws(mounted.context)
  mounted.step()
  const listeningRadius = meanRadius(mounted.context)

  mounted.visual.setState('interrupted')
  resetDraws(mounted.context)
  mounted.step()
  const scatteredRadius = meanRadius(mounted.context)

  mounted.settle()
  resetDraws(mounted.context)
  mounted.step()
  const settledRadius = meanRadius(mounted.context)

  assert.ok(scatteredRadius > listeningRadius, 'the impulse throws particles outward')
  assert.ok(
    Math.abs(settledRadius - listeningRadius) < 1.5,
    `the field returns to listening (${settledRadius} vs ${listeningRadius})`,
  )
  mounted.visual.destroy()
})

test('setLevel stores a clamped amplitude that the next frame reads', () => {
  const mounted = mount()
  mounted.visual.setState('speaking')
  mounted.settle()

  mounted.visual.setLevel(0)
  mounted.settle()
  resetDraws(mounted.context)
  mounted.step()
  const quiet = meanRadius(mounted.context)

  mounted.visual.setLevel(1)
  mounted.settle()
  resetDraws(mounted.context)
  mounted.step()
  const loud = meanRadius(mounted.context)

  assert.equal(mounted.visual.level, 1)
  assert.ok(loud > quiet, 'speaking pushes the field outward with level')

  mounted.visual.setLevel(4)
  assert.equal(mounted.visual.level, 1, 'clamped high')
  mounted.visual.setLevel(-2)
  assert.equal(mounted.visual.level, 0, 'clamped low')
  mounted.visual.setLevel(Number.NaN)
  assert.equal(mounted.visual.level, 0, 'a non-finite level reads as silence')
  mounted.visual.destroy()
})

test('setPalette re-renders the atlas and reports the active palette', () => {
  const mounted = mount()

  assert.equal(mounted.visual.palette, 'ember')
  mounted.visual.setPalette('graphite')

  assert.equal(mounted.visual.palette, 'graphite')
  assert.equal(mounted.offscreen.length, 2, 'the atlas is rebuilt for the new palette')

  mounted.visual.setPalette('graphite')
  assert.equal(mounted.offscreen.length, 2, 'an unchanged palette is a no-op')
  mounted.visual.destroy()
})

test('reduced motion never schedules a frame and redraws once per state change', () => {
  let rafCalls = 0
  const mounted = mount({
    reducedMotion: true,
    raf: () => { rafCalls += 1; return 1 },
  })

  assert.equal(rafCalls, 0, 'no animation loop in reduced motion')
  assert.equal(mounted.context.calls.clearRect, 1, 'one static draw at construction')
  assert.ok(drawnCount(mounted.context) > 0, 'the static constellation is drawn')

  mounted.visual.setState('listening')
  assert.equal(mounted.context.calls.clearRect, 2)
  mounted.visual.setState('listening')
  assert.equal(mounted.context.calls.clearRect, 2, 'an unchanged state does not redraw')
  mounted.visual.setLevel(0.9)
  assert.equal(mounted.context.calls.clearRect, 2, 'amplitude never animates a static field')

  assert.equal(rafCalls, 0)
  mounted.visual.destroy()
})

test('high contrast also stays static', () => {
  let rafCalls = 0
  const mounted = mount({ highContrast: true, raf: () => { rafCalls += 1; return 1 } })

  mounted.visual.setState('speaking')
  assert.equal(rafCalls, 0)
  mounted.visual.destroy()
})

test('the reduced-motion constellation is seeded: same seed same positions', () => {
  const first = mount({ reducedMotion: true, seed: 4242 })
  const second = mount({ reducedMotion: true, seed: 4242 })
  const other = mount({ reducedMotion: true, seed: 99 })
  for (const mounted of [first, second, other]) mounted.visual.setState('listening')

  const firstPoints = centres(first.context)
  assert.ok(firstPoints.length > 0)
  assert.deepEqual(firstPoints, centres(second.context))
  assert.notDeepEqual(firstPoints, centres(other.context))

  // Distinct states differ in convergence, so the constellation differs too.
  const third = mount({ reducedMotion: true, seed: 4242 })
  third.visual.setState('inactive')
  assert.notDeepEqual(centres(third.context), firstPoints)
  for (const mounted of [first, second, other, third]) mounted.visual.destroy()
})

test('destroy cancels the pending frame and stops the loop', () => {
  const mounted = mount()
  mounted.step()
  mounted.step()
  const scheduled = mounted.pending.length
  assert.equal(scheduled, 1, 'exactly one frame is ever in flight')

  const stale = mounted.pending.shift()
  mounted.visual.destroy()

  assert.equal(mounted.cancelled.length, 1)
  assert.ok(mounted.cancelled[0] > 0, 'the in-flight handle is cancelled')

  resetDraws(mounted.context)
  const clearsBefore = mounted.context.calls.clearRect
  stale(mounted.step.clock + 16)

  assert.equal(mounted.context.calls.clearRect, clearsBefore, 'a stale frame draws nothing')
  assert.equal(drawnCount(mounted.context), 0)
  assert.equal(mounted.pending.length, 0, 'the loop does not reschedule after destroy')

  mounted.visual.destroy()
  assert.equal(mounted.cancelled.length, 1, 'destroy is idempotent')
})

test('destroy is safe in static mode and blocks later redraws', () => {
  const mounted = mount({ reducedMotion: true })
  mounted.visual.destroy()
  const clears = mounted.context.calls.clearRect

  mounted.visual.setState('error')

  assert.equal(mounted.context.calls.clearRect, clears)
})

test('the frame loop avoids per-particle blur and filter work', async () => {
  const source = await readFile(new URL('../src/renderer/orb-visual.mjs', import.meta.url), 'utf8')

  // shadowBlur/filter per sprite is the classic canvas-particle performance trap.
  assert.doesNotMatch(source, /shadowBlur/)
  assert.doesNotMatch(source, /\.filter\s*=/)
  assert.match(source, /globalCompositeOperation = 'lighter'/)
})

test('the orb markup hosts the particle canvas instead of gradient spans', async () => {
  const html = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8')

  assert.match(html, /<canvas class="orb-canvas" aria-hidden="true"><\/canvas>/)
  assert.doesNotMatch(html, /class="halo"|class="core"/)
  // The tested contract around the button and its indicator is untouched.
  assert.match(html, /<main id="shell" data-state="booting"/)
  assert.match(html, /id="capture-indicator"/)
  assert.match(html, /id="state-label"/)
})

test('the stylesheet drops the gradient sphere but keeps the accessibility overrides', async () => {
  const css = await readFile(new URL('../src/renderer/index.css', import.meta.url), 'utf8')

  assert.doesNotMatch(css, /conic-gradient/)
  assert.doesNotMatch(css, /radial-gradient/)
  assert.doesNotMatch(css, /@keyframes (orbit|breathe)/)
  assert.doesNotMatch(css, /\.halo|\.core\b/)
  assert.match(css, /\.orb-canvas \{/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)

  // High contrast hides the nebula and shows a solid disc instead, keeping the
  // flat alert colour and the capture indicator that the old halo carried.
  const contrast = css.slice(css.indexOf('@media (prefers-contrast: more)'))
  assert.ok(contrast.length > 0, 'the contrast block survives the swap')
  assert.match(contrast, /\.orb-canvas \{ display: none/)
  assert.match(contrast, /#orb::after \{/)
  assert.match(contrast, /\[data-state="error"\] #orb::after/)
  assert.match(contrast, /\[data-state="permission-denied"\] #orb::after/)
  assert.match(contrast, /\.capture-indicator \{ z-index: 1/)
})

test('the renderer feeds the visual from the same render pass as data-state', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(source, /import \{ createOrbVisual \} from '\.\/orb-visual\.mjs'/)
  assert.match(source, /createOrbVisual\(/)
  assert.match(source, /prefers-reduced-motion: reduce/)
  assert.match(source, /prefers-contrast: more/)
  assert.match(
    source,
    /visual\.setState\(state\.name, \{ codexWorking: axes\.codex === 'working' \}\)/,
  )
  // The data-state contract still drives the label and accessibility surface.
  assert.match(source, /shell\.dataset\.state = state\.name/)
})

test('the build syntax-checks the visual module', async () => {
  const source = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8')

  assert.match(source, /'src\/renderer\/orb-visual\.mjs'/)
})
