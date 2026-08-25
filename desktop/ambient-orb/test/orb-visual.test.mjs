import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import { checkJavaScriptFiles } from '../scripts/build-contract.mjs'
import {
  createOrbVisual,
  createOrbVisualSafe,
  paletteColors,
  STATE_FPS,
  STATE_PARAMS,
} from '../src/renderer/orb-visual.mjs'
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
  // `pending` holds callbacks and `handles` their rAF handles at the same index,
  // so a cancel really drops the frame instead of only recording the handle.
  const pending = []
  const handles = []
  const cancelled = []
  let nextHandle = 0
  const visual = createOrbVisual(canvas, {
    devicePixelRatio: 2,
    seed: 0x5eed,
    // A zero-cost clock: the auto-degrade heuristic must be driven on purpose,
    // never by how fast the machine running the suite happens to be.
    now: () => 0,
    createCanvas: (width, height) => {
      const created = stubCanvas(width, height)
      offscreen.push(created)
      return created
    },
    raf: callback => {
      pending.push(callback)
      nextHandle += 1
      handles.push(nextHandle)
      return nextHandle
    },
    cancelRaf: handle => {
      cancelled.push(handle)
      const at = handles.indexOf(handle)
      if (at >= 0) {
        handles.splice(at, 1)
        pending.splice(at, 1)
      }
    },
    ...options,
  })
  const context = canvas.context
  const take = () => {
    handles.shift()
    return pending.shift()
  }
  // One tier frame by default: the tick throttles to the active state's rate,
  // so "advance a frame" means advancing past that state's interval.
  const step = advanceMs => {
    const callback = take()
    assert.ok(callback, 'expected a scheduled frame')
    step.clock += advanceMs ?? Math.max(16, 1000 / (visual.fps || 60) + 1)
    callback(step.clock)
  }
  step.clock = 1000
  // Runs the smoothing to steady state so per-state counts are comparable.
  const settle = (frames = 90) => { for (let index = 0; index < frames; index += 1) step() }
  return { visual, canvas, context, offscreen, pending, cancelled, take, step, settle }
}

// A matchMedia stub whose queries can be flipped and fired on demand. The visual
// arms one query per live preference — display density, reduced motion, and
// contrast — so a stub has to serve several queries at once.
function mediaStub() {
  const queries = []
  const matchMedia = query => {
    const media = {
      media: query,
      matches: false,
      handlers: [],
      addEventListener: (type, handler) => media.handlers.push(handler),
      removeEventListener: (type, handler) => {
        const at = media.handlers.indexOf(handler)
        if (at >= 0) media.handlers.splice(at, 1)
      },
    }
    queries.push(media)
    return media
  }
  // The newest query for a given string: the density query re-arms on change.
  const find = query => queries.filter(media => media.media === query).at(-1)
  const emit = (query, matches) => {
    const media = find(query)
    assert.ok(media, `no media query was armed for ${query}`)
    media.matches = matches
    for (const handler of [...media.handlers]) handler({ matches })
  }
  return { matchMedia, queries, find, emit }
}

// The atlas layout, mirrored from orb-visual.mjs, which keeps these private: four
// sprite sizes across, nine colour tiers down, each row SPRITE_MAX tall, and the
// plate region below all of them. Used only to reason about the atlas geometry —
// nothing here asserts a particular sprite size.
const SPRITE_COLUMNS = 4
const SPRITE_MAX = 15
const ROW_COUNT = 9

// Particle blits only. The plate is blitted from the same atlas at the top of
// every frame, under 'source-over', so the additive operation is what separates
// the field from its background here — and every helper below has to agree on
// that, or a plate counted as a particle would skew both the counts and the
// radius means.
function particleBlits(context) {
  return context.calls.drawImage.filter(call => call.operation === 'lighter')
}

// Sprites are drawn with the 9-argument form (atlas cell → destination box),
// so the on-screen centre of each particle lives in the destination rect.
function centres(context) {
  return particleBlits(context).map(call => ({
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
  return particleBlits(context).length
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
    [0.1, 0.02, 0.02, 0, 0.5, 0.45],
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
    [0.8, 0.1, 0.1, 0.45, 1, 1],
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

test('the three terminal states share the alert language but not the behaviour', () => {
  // Shared: all three are a collapsed, dimmed, alert-toned ring — the colour
  // semantics a grayscale viewer cannot tell apart anyway.
  for (const name of ['disconnected', 'error', 'permission-denied']) {
    const params = STATE_PARAMS[name]
    assert.equal(params.convergence, 0.9, `${name}.convergence`)
    assert.equal(params.alpha, 0.6, `${name}.alpha`)
    assert.equal(params.pulseGain, 0, `${name}.pulseGain`)
    assert.equal(params.tone, 'alert', `${name}.tone`)
    assert.ok(params.ringRadius > 0, `${name} collapses onto a ring`)
  }

  // Distinct: radius, density, and restlessness carry the difference, so the
  // three read apart in motion and in grayscale rather than only by colour.
  assert.deepEqual(
    ['ringRadius', 'countRatio', 'orbitSpeed', 'jitter'].map(key => STATE_PARAMS.disconnected[key]),
    [46, 0.5, 0.03, 0.04],
  )
  assert.deepEqual(
    ['ringRadius', 'countRatio', 'orbitSpeed', 'jitter'].map(key => STATE_PARAMS.error[key]),
    [38, 0.75, 0.06, 0.06],
  )
  assert.deepEqual(
    ['ringRadius', 'countRatio', 'orbitSpeed', 'jitter'].map(
      key => STATE_PARAMS['permission-denied'][key],
    ),
    [28, 0.35, 0.02, 0.04],
  )
})

test('muted is a deliberate dim ring, not an alert', () => {
  const params = STATE_PARAMS.muted
  assert.equal(params.tone, 'dim', 'user action, not an error')
  assert.deepEqual(
    ['convergence', 'orbitSpeed', 'jitter', 'pulseGain', 'alpha', 'countRatio', 'ringRadius'].map(
      key => params[key],
    ),
    [0.75, 0.03, 0.04, 0, 0.6, 0.6, 32],
  )
})

test('the terminal states render distinct geometry in animated mode too', () => {
  // Reduced motion folds the state name into the field seed, so its layouts
  // differ for free; animated mode keeps one continuous field, and the only
  // thing that can separate the three there is their own parameters.
  const mounted = mount()
  const shape = name => {
    resetDraws(mounted.context)
    mounted.visual.setState(name)
    // Every terminal state is a zero-fps tier: setState draws its single
    // snapped frame, which is the whole animated-mode appearance.
    return { count: drawnCount(mounted.context), radius: meanRadius(mounted.context) }
  }

  const disconnected = shape('disconnected')
  const error = shape('error')
  const denied = shape('permission-denied')

  for (const [left, right, label] of [
    [disconnected, error, 'disconnected vs error'],
    [error, denied, 'error vs permission-denied'],
    [disconnected, denied, 'disconnected vs permission-denied'],
  ]) {
    assert.notEqual(left.count, right.count, `${label}: particle density differs`)
    assert.ok(
      Math.abs(left.radius - right.radius) > 2,
      `${label}: ring radius differs (${left.radius} vs ${right.radius})`,
    )
  }
  mounted.visual.destroy()
})

test('paletteColors returns the exact ember table', () => {
  const ember = paletteColors('ember')

  assert.ok(Object.isFrozen(ember))
  assert.deepEqual({ ...ember }, {
    // The four sprite tiers are unchanged: make-icons.mjs keeps its own copy of
    // these three ember hexes, so the app icon tracks the orb's stars.
    core: '#FFB454',
    highlight: '#FFE3B3',
    deep: '#C96F2B',
    dust: '#8C5A2B',
    dustAlpha: 0.25,
    // The flat `plate` fill is gone: the disc is composited from these layers
    // instead, which is where its depth comes from.
    abyss: 'rgba(6, 5, 10, .95)',
    mantle: 'rgba(26, 17, 18, .9)',
    bloom: 'rgba(92, 51, 27, .78)',
    bloomOffset: 0.1,
    haze: [
      { x: -0.3, y: -0.26, radius: 0.62, color: '#8C4A1E', alpha: 0.2 },
      { x: 0.32, y: 0.2, radius: 0.55, color: '#6E3D5A', alpha: 0.16 },
      { x: 0.08, y: 0.38, radius: 0.44, color: '#2E4668', alpha: 0.13 },
    ],
    vignette: '#020205',
    rim: 'rgba(255, 214, 156, .12)',
    ring: 'rgba(255, 214, 156, .22)',
    codexBand: '#FFD9A0',
    error: '#FF5A5A',
    errorDeep: '#A8434F',
    inactive: '#938878',
    inactiveDeep: '#57524A',
    ringAlert: 'rgba(255, 106, 106, .3)',
  })
  // The haze list and its entries are frozen too: the plate is built from this
  // table on every atlas rebuild, so a mutable entry would let one palette swap
  // permanently alter how the disc composites.
  assert.ok(Object.isFrozen(ember.haze))
  for (const cloud of ember.haze) assert.ok(Object.isFrozen(cloud))
})

test('paletteColors returns the exact graphite table', () => {
  const graphite = paletteColors('graphite')

  assert.ok(Object.isFrozen(graphite))
  assert.deepEqual({ ...graphite }, {
    core: '#E8ECF2',
    mid: '#9AA3AF',
    shadow: '#3A404A',
    abyss: 'rgba(4, 6, 10, .95)',
    mantle: 'rgba(16, 20, 27, .9)',
    bloom: 'rgba(62, 74, 92, .72)',
    bloomOffset: 0.1,
    haze: [
      { x: -0.28, y: -0.28, radius: 0.6, color: '#4A5A72', alpha: 0.18 },
      { x: 0.3, y: 0.22, radius: 0.52, color: '#38506B', alpha: 0.14 },
      { x: 0.06, y: 0.36, radius: 0.42, color: '#2A3346', alpha: 0.12 },
    ],
    vignette: '#010204',
    rim: 'rgba(232, 236, 242, .1)',
    ring: 'rgba(232, 236, 242, .18)',
    accent: '#FFC978',
    error: '#FF6B6B',
    errorDeep: '#9E4757',
    inactive: '#98A0AB',
    inactiveDeep: '#5E6774',
    ringAlert: 'rgba(255, 128, 128, .26)',
  })
  assert.ok(Object.isFrozen(graphite.haze))
  for (const cloud of graphite.haze) assert.ok(Object.isFrozen(cloud))
})

// Both palettes feed the same renderPlate, so a field missing from one of them
// would surface as a silently broken gradient stop rather than a throw.
test('both palettes carry every layer renderPlate composites', () => {
  for (const name of ['ember', 'graphite']) {
    const colors = paletteColors(name)
    for (const field of ['abyss', 'mantle', 'bloom', 'vignette', 'rim']) {
      assert.equal(typeof colors[field], 'string', `${name}.${field} is a colour`)
    }
    assert.equal(typeof colors.bloomOffset, 'number', `${name}.bloomOffset is a number`)
    // The bloom is lifted off centre to give the disc a near side; dead centre
    // reads as a flat ring, and past a third of the radius it detaches.
    assert.ok(
      colors.bloomOffset > 0 && colors.bloomOffset < 0.35,
      `${name}.bloomOffset lifts the core glow without detaching it`,
    )
    assert.ok(colors.haze.length >= 2, `${name} carries haze clouds`)
    for (const cloud of colors.haze) {
      assert.ok(Math.hypot(cloud.x, cloud.y) + cloud.radius <= 1.05, 'a cloud stays on the plate')
      assert.ok(cloud.alpha > 0 && cloud.alpha < 0.5, 'a cloud stays a haze, not a blob')
      assert.match(cloud.color, /^#[0-9A-Fa-f]{6}$/)
    }
  }
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
  // The plate goes down first, under 'source-over': it is the background the
  // field is composited onto, so it is the one blit that must not be additive.
  assert.ok(draws.length > 1)
  assert.equal(draws[0].operation, 'source-over')
  assert.equal(draws[0].alpha, 1, 'the plate is blitted at full strength')

  const particles = draws.slice(1)
  assert.ok(particles.length > 0)
  for (const draw of particles) {
    assert.equal(draw.operation, 'lighter')
    assert.equal(draw.args.length, 9, 'atlas cell blit')
    assert.ok(draw.alpha > 0 && draw.alpha <= 1)
  }
  mounted.visual.destroy()
})

test('the plate is composited into the atlas once, then only blitted per frame', () => {
  const mounted = mount()

  // The plate shares the sprite atlas rather than taking a second texture, so
  // one palette or pixel-ratio rebuild keeps both in step.
  assert.equal(mounted.offscreen.length, 1, 'still a single offscreen texture')
  const atlas = mounted.offscreen[0]
  const gradientsAfterInit = atlas.calls.gradients
  // Four sprite sizes across nine tiers, plus the plate's own base, haze, and
  // vignette gradients: the plate's share is what the sprite grid cannot explain.
  assert.ok(
    gradientsAfterInit > SPRITE_COLUMNS * ROW_COUNT,
    `the plate contributes gradients of its own (${gradientsAfterInit})`,
  )
  // Layers are painted, and the rim light is the only stroke in the build.
  assert.ok(atlas.calls.fill > 0, 'the plate layers are filled')
  assert.ok(atlas.calls.stroke > 0, 'the rim light is stroked')

  mounted.step()
  // drawImage(image, sx, sy, sW, sH, dx, dy, dW, dH)
  const [image, sx, sy, sourceWidth, sourceHeight, ...destination] = mounted
    .context.calls.drawImage[0].args
  assert.equal(image, atlas, 'blitted from the atlas, not a second canvas')
  assert.deepEqual(destination, [0, 0, 116, 116], 'covers the full orb box')
  assert.equal(sx, 0)
  assert.equal(sourceWidth, sourceHeight, 'a square source region')
  assert.ok(sourceWidth > 0)
  // The plate region sits below every sprite row, so its source y clears them
  // and the region it names still fits inside the texture.
  assert.ok(sy >= SPRITE_MAX * 2 * ROW_COUNT, `the plate clears the sprite rows (sy ${sy})`)
  assert.equal(sy + sourceHeight, atlas.height, 'the plate closes out the texture')

  for (let index = 0; index < 5; index += 1) mounted.step()
  assert.equal(atlas.calls.gradients, gradientsAfterInit, 'no re-compositing per frame')
  assert.equal(mounted.context.calls.gradients, 0, 'nothing gradient-drawn on screen')
  assert.equal(mounted.offscreen.length, 1)
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

  // `inactive` is a static tier: it snaps to its parameters and draws exactly
  // one frame, so the thinning shows up in that snapshot rather than in a loop.
  resetDraws(mounted.context)
  mounted.visual.setState('inactive')
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

test('interrupt scatters the current field whatever state it is in', () => {
  // A real barge-in never reaches setState('interrupted'): the capture axis is
  // already 'listening' when the playback clear lands, so deriveOrbState keeps
  // saying 'listening' and the impulse has to apply over that field instead.
  const mounted = mount()
  mounted.visual.setState('listening')
  mounted.settle()
  resetDraws(mounted.context)
  mounted.step()
  const listeningRadius = meanRadius(mounted.context)

  mounted.visual.interrupt()
  resetDraws(mounted.context)
  mounted.step()
  const scatteredRadius = meanRadius(mounted.context)

  assert.ok(scatteredRadius > listeningRadius, 'the impulse throws the field outward')
  assert.equal(mounted.visual.state, 'listening', 'and never relabels the state')
  assert.equal(mounted.visual.params, STATE_PARAMS.listening)

  mounted.settle()
  resetDraws(mounted.context)
  mounted.step()
  const settledRadius = meanRadius(mounted.context)

  assert.ok(
    Math.abs(settledRadius - listeningRadius) < 1.5,
    `the impulse decays back to listening (${settledRadius} vs ${listeningRadius})`,
  )
  mounted.visual.destroy()
})

test('interrupt keeps the static layout a pure function of seed and state', () => {
  const mounted = mount({ reducedMotion: true, seed: 4242 })
  resetDraws(mounted.context)
  mounted.visual.setState('listening')
  const canonical = centres(mounted.context)
  assert.ok(canonical.length > 0)

  resetDraws(mounted.context)
  mounted.visual.interrupt()
  const frames = centres(mounted.context)

  // Reduced motion has no loop to decay an impulse, so the barge-in is one
  // scattered snapshot followed immediately by the state's own constellation.
  assert.equal(frames.length, canonical.length * 2, 'the impulse frame then the re-snap')
  assert.notDeepEqual(
    frames.slice(0, canonical.length),
    canonical,
    'the barge-in is still acknowledged',
  )
  assert.deepEqual(
    frames.slice(canonical.length),
    canonical,
    'and the layout returns to the state canonical constellation',
  )
  assert.equal(mounted.pending.length, 0, 'a static orb still schedules nothing')
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

  // A state whose tier stopped the loop has to be repainted in the new colours
  // right here, because no frame is coming to do it.
  mounted.visual.setState('error')
  const clears = mounted.context.calls.clearRect
  mounted.visual.setPalette('ember')
  assert.equal(mounted.context.calls.clearRect, clears + 1)
  assert.equal(mounted.pending.length, 0, 'and it stays stopped')
  mounted.visual.destroy()
})

test('setPalette rebuilds only the offscreen atlas, never the visible canvas', () => {
  const mounted = mount()
  const visibleGradientsBefore = mounted.context.calls.gradients

  mounted.visual.setPalette('graphite')

  assert.equal(mounted.context.calls.gradients, visibleGradientsBefore)
  assert.equal(mounted.context.calls.gradients, 0, 'sprites are blitted, never gradient-drawn live')
  const atlas = mounted.offscreen.at(-1)
  assert.ok(atlas.calls.gradients > 0, 'the rebuilt atlas cells are radial-gradient discs')
  mounted.visual.destroy()
})

test('setPalette repaints immediately in static (reduced-motion) mode', () => {
  const mounted = mount({ reducedMotion: true })
  const offscreenBefore = mounted.offscreen.length
  const clearsBefore = mounted.context.calls.clearRect

  mounted.visual.setPalette('graphite')

  assert.equal(mounted.offscreen.length, offscreenBefore + 1, 'the atlas is rebuilt for the new palette')
  assert.equal(mounted.context.calls.clearRect, clearsBefore + 1, 'the static frame repaints in place')
  assert.ok(drawnCount(mounted.context) > 0, 'the repaint still draws the constellation')
  assert.equal(mounted.pending.length, 0, 'a palette swap never starts the animation loop')
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

test('high contrast never schedules a frame, at construction or after', () => {
  let rafCalls = 0
  const mounted = mount({ highContrast: true, raf: () => { rafCalls += 1; return 1 } })

  // The CSS hides .orb-canvas under prefers-contrast, but the module itself
  // must not even ask for a frame: no rAF at construction, and none earned by
  // any subsequent state or level change either.
  assert.equal(rafCalls, 0, 'no animation loop scheduled at construction')
  assert.equal(mounted.visual.fps, 0)
  assert.ok(drawnCount(mounted.context) > 0, 'a static frame is still drawn to the hidden canvas')

  mounted.visual.setState('speaking')
  assert.equal(rafCalls, 0)
  mounted.visual.setLevel(1)
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

test('collapsed alert states carry their own parameters and render distinct constellations', () => {
  // These three used to share one frozen COLLAPSE object, which made them
  // pixel-identical wherever colour is unavailable. Each now varies radius,
  // density, and restlessness on its own.
  for (const [left, right] of [
    ['disconnected', 'error'],
    ['error', 'permission-denied'],
    ['disconnected', 'permission-denied'],
  ]) {
    for (const key of ['ringRadius', 'countRatio', 'orbitSpeed']) {
      assert.notEqual(
        STATE_PARAMS[left][key],
        STATE_PARAMS[right][key],
        `${left}.${key} must differ from ${right}.${key}`,
      )
    }
  }

  const mounted = mount({ reducedMotion: true, seed: 777 })
  resetDraws(mounted.context)
  mounted.visual.setState('disconnected')
  const disconnectedPoints = centres(mounted.context)

  resetDraws(mounted.context)
  mounted.visual.setState('error')
  const errorPoints = centres(mounted.context)

  resetDraws(mounted.context)
  mounted.visual.setState('permission-denied')
  const deniedPoints = centres(mounted.context)

  assert.ok(disconnectedPoints.length > 0)
  assert.notDeepEqual(errorPoints, disconnectedPoints, 'each terminal state gets its own layout')
  assert.notDeepEqual(deniedPoints, disconnectedPoints)
  assert.notDeepEqual(deniedPoints, errorPoints)

  // Revisiting a state reproduces its exact prior layout: the seed is a pure
  // function of (seed, state name), not a one-shot mutation.
  resetDraws(mounted.context)
  mounted.visual.setState('disconnected')
  assert.deepEqual(centres(mounted.context), disconnectedPoints)
  mounted.visual.destroy()
})

test('a static-mode scatter impulse decays across state snapshots instead of persisting', () => {
  const mounted = mount({ reducedMotion: true, seed: 4242 })

  // The construction-time snapshot draws the default "booting" state; drop
  // it so the capture below reflects only the "listening" redraw.
  resetDraws(mounted.context)
  mounted.visual.setState('listening')
  const before = centres(mounted.context)
  assert.ok(before.length > 0)

  // A barge-in leaves scatter=1 on the interrupted snapshot; routing back to
  // listening (scatter=0) must fully clear the impulse, not carry it forward.
  resetDraws(mounted.context)
  mounted.visual.setState('interrupted')
  resetDraws(mounted.context)
  mounted.visual.setState('listening')
  const after = centres(mounted.context)

  assert.deepEqual(after, before, 'the seeded layout must be a pure function of (seed, state)')
  mounted.visual.destroy()
})

// The guarded factory is expected to report a dead canvas exactly once, so the
// warning has to be captured rather than printed into the test output.
function captureWarnings(sink) {
  const original = console.warn
  console.warn = (...args) => sink.push(args.join(' '))
  return () => { console.warn = original }
}

const NOOP_API = ['setState', 'setLevel', 'setPalette', 'setAccessibility', 'interrupt', 'destroy']

test('a canvas that cannot be acquired yields a working no-op visual', () => {
  const warnings = []
  const restore = captureWarnings(warnings)
  try {
    // No 2D context is the real-world failure: a renderer whose socket, drag,
    // and label wiring must still come up around a dead orb.
    const visual = createOrbVisualSafe({ getContext: () => null })

    assert.ok(Object.isFrozen(visual), 'the fallback is frozen')
    for (const method of NOOP_API) {
      assert.equal(typeof visual[method], 'function', `${method} is still callable`)
    }
    visual.setState('listening')
    visual.setLevel(0.5)
    visual.setPalette('graphite')
    visual.setAccessibility({ reducedMotion: true })
    visual.interrupt()
    visual.destroy()

    assert.equal(visual.state, 'booting')
    assert.equal(visual.params, STATE_PARAMS.booting)
    assert.equal(visual.palette, 'ember')
    assert.equal(visual.level, 0)
    assert.equal(visual.smoothedLevel, 0)
    assert.equal(visual.fps, 0)
    assert.equal(visual.particleCount, 0)
    assert.equal(warnings.length, 1, 'the failure is reported exactly once')
  } finally {
    restore()
  }
})

test('the first draw failure disables the visual instead of reaching its caller', () => {
  const warnings = []
  const restore = captureWarnings(warnings)
  try {
    const canvas = stubCanvas()
    const clearRect = canvas.context.clearRect
    let broken = false
    canvas.context.clearRect = () => {
      if (broken) throw new Error('the canvas surface went away')
      clearRect()
    }
    const visual = createOrbVisualSafe(canvas, {
      reducedMotion: true,
      devicePixelRatio: 2,
      createCanvas: (width, height) => stubCanvas(width, height),
    })

    visual.setState('idle')
    assert.ok(drawnCount(canvas.context) > 0, 'a healthy visual still draws')

    broken = true
    visual.setState('listening')
    assert.equal(warnings.length, 1, 'the throw is logged, not rethrown')

    // From here the visual is permanently the no-op: no more canvas work, no
    // more log noise, and no exception can escape into the socket message tail.
    resetDraws(canvas.context)
    visual.setState('speaking')
    visual.setLevel(1)
    visual.interrupt()
    visual.setPalette('graphite')
    visual.setAccessibility({ reducedMotion: false })
    visual.destroy()

    assert.equal(drawnCount(canvas.context), 0, 'the dead visual stops touching the canvas')
    assert.equal(warnings.length, 1, 'and it complains only once')
    assert.equal(visual.fps, 0)
    assert.equal(visual.particleCount, 0)
  } finally {
    restore()
  }
})

test('destroy cancels the pending frame and stops the loop', () => {
  const mounted = mount()
  mounted.step()
  mounted.step()
  const scheduled = mounted.pending.length
  assert.equal(scheduled, 1, 'exactly one frame is ever in flight')

  const stale = mounted.take()
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

test('the orb rail carries the mute toggle and settings buttons', async () => {
  const html = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
  assert.match(html, /<nav id="orb-rail" aria-label="快捷操作">/)
  assert.match(html, /<button id="mute-toggle" type="button" aria-label="闭麦" aria-pressed="false" disabled>/)
  assert.match(html, /<button id="open-settings" type="button" aria-label="设置">/)

  const css = await readFile(new URL('../src/renderer/index.css', import.meta.url), 'utf8')
  assert.match(css, /#orb-rail \{/)
  // Keyboard focus keeps the rail open; plain click focus must not, or one
  // click would pin the rail visible after the pointer leaves.
  assert.match(css, /body:hover #orb-rail,\n#orb-rail:has\(:focus-visible\) \{/)
  const fixture = await readFile(new URL('./fixtures/orb-transparency.html', import.meta.url), 'utf8')
  assert.match(fixture, /id="orb-rail"/)
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

  // Construction goes through the guarded factory: a canvas that cannot be
  // acquired must not take the socket, drag, and label wiring down with it.
  assert.match(source, /import \{ createOrbVisualSafe \} from '\.\/orb-visual\.mjs'/)
  assert.match(source, /const visual = createOrbVisualSafe\(/)
  assert.doesNotMatch(source, /[^e]createOrbVisual\(/, 'never the unguarded factory')
  assert.match(source, /prefers-reduced-motion: reduce/)
  assert.match(source, /prefers-contrast: more/)
  assert.match(
    source,
    /visual\.setState\(state\.name, \{ codexWorking: axes\.codex === 'working' \}\)/,
  )
  // The data-state contract still drives the label and accessibility surface.
  assert.match(source, /shell\.dataset\.state = state\.name/)
})

test('the renderer applies the bootstrap palette and future settings pushes', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  // Construction always starts on the 'ember' default: bootstrap.settings does
  // not exist until a later task, and is not available synchronously anyway.
  assert.match(source, /palette: 'ember',/)
  // Once bootstrap resolves, the palette it carries (if any) is applied live;
  // optional chaining keeps this a no-op today instead of a throw.
  assert.match(source, /visual\.setPalette\(bootstrap\.settings\?\.palette\)/)
  // Future live pushes swap the palette the same way, guarded the same way.
  assert.match(
    source,
    /window\.novaAudioAgentDesktop\.settings\?\.onChanged\?\.\(next => visual\.setPalette\(next\.palette\)\)/,
  )
})

test('STATE_FPS covers every orb state and tiers them by how much they move', () => {
  assert.ok(Object.isFrozen(STATE_FPS))
  assert.deepEqual(Object.keys(STATE_FPS).sort(), [...ORB_STATE_NAMES].sort())
  assert.deepEqual(STATE_FPS, {
    speaking: 60,
    listening: 60,
    // A barge-in is a live listening field with a decaying impulse over it.
    interrupted: 60,
    candidate: 30,
    booting: 30,
    reconnecting: 30,
    idle: 15,
    // Zero means one static frame and no loop at all.
    inactive: 0,
    muted: 0,
    disconnected: 0,
    'configuration-required': 0,
    'authentication-failed': 0,
    'backend-unavailable': 0,
    error: 0,
    'permission-denied': 0,
    'microphone-restricted': 0,
    'microphone-no-device': 0,
    'microphone-busy': 0,
    'microphone-unavailable': 0,
    'audio-pipeline-error': 0,
  })
})

test('the tick tiers throttle the loop instead of drawing every animation frame', () => {
  const mounted = mount()

  mounted.visual.setState('idle')
  assert.equal(mounted.visual.fps, 15)
  mounted.step(16)
  const clears = mounted.context.calls.clearRect
  // 15 fps is one draw per 66.7 ms, so three 16 ms animation frames are skipped.
  for (let index = 0; index < 3; index += 1) mounted.step(16)
  assert.equal(mounted.context.calls.clearRect, clears, 'sub-interval frames draw nothing')
  assert.equal(mounted.pending.length, 1, 'skipped frames still reschedule')
  mounted.step(20)
  assert.equal(mounted.context.calls.clearRect, clears + 1, 'the frame past the interval draws')

  mounted.visual.setState('listening')
  assert.equal(mounted.visual.fps, 60)
  mounted.step(16)
  const live = mounted.context.calls.clearRect
  for (let index = 0; index < 3; index += 1) mounted.step(16)
  assert.equal(mounted.context.calls.clearRect, live + 3, '60 fps draws every frame')

  mounted.visual.setState('candidate')
  assert.equal(mounted.visual.fps, 30)
  mounted.step(16)
  const candidate = mounted.context.calls.clearRect
  mounted.step(16)
  assert.equal(mounted.context.calls.clearRect, candidate, '30 fps skips every other frame')
  mounted.step(18)
  assert.equal(mounted.context.calls.clearRect, candidate + 1)
  mounted.visual.destroy()
})

test('a static state draws one frame and stops the loop until a live state returns', () => {
  const mounted = mount()
  mounted.step()
  assert.equal(mounted.pending.length, 1)
  resetDraws(mounted.context)
  const clears = mounted.context.calls.clearRect

  mounted.visual.setState('error')

  assert.equal(mounted.visual.fps, 0)
  assert.equal(mounted.cancelled.length, 1, 'the in-flight frame is cancelled')
  assert.equal(mounted.pending.length, 0, 'a dead session schedules nothing at all')
  assert.equal(mounted.context.calls.clearRect, clears + 1, 'exactly one static frame')
  assert.ok(drawnCount(mounted.context) > 0, 'the collapsed ring is still drawn')

  // A repeat of the same static state must not cost another frame either.
  mounted.visual.setState('error')
  assert.equal(mounted.pending.length, 0)
  assert.equal(mounted.context.calls.clearRect, clears + 1)

  mounted.visual.setState('listening')
  assert.equal(mounted.pending.length, 1, 'a live state restarts the loop')
  mounted.step()
  assert.equal(mounted.context.calls.clearRect, clears + 2)
  mounted.visual.destroy()
})

test('a hidden document stops the loop and becoming visible resumes it', () => {
  const listeners = new Map()
  const documentStub = {
    visibilityState: 'visible',
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: type => listeners.delete(type),
  }
  const mounted = mount({ document: documentStub })
  mounted.step()
  assert.equal(mounted.pending.length, 1)

  documentStub.visibilityState = 'hidden'
  listeners.get('visibilitychange')()

  assert.equal(mounted.pending.length, 0, 'an off-screen orb costs nothing')
  const clears = mounted.context.calls.clearRect

  documentStub.visibilityState = 'visible'
  listeners.get('visibilitychange')()

  assert.equal(mounted.pending.length, 1, 'the loop resumes when the orb is visible again')
  mounted.step()
  assert.equal(mounted.context.calls.clearRect, clears + 1)

  mounted.visual.destroy()
  assert.equal(listeners.has('visibilitychange'), false, 'destroy unhooks the document')
})

// The speaking envelope is exponential with a 40 ms attack and a 220 ms decay
// time constant: one constant covers 1 - e^-1 = 63.2% of the remaining
// distance. Without an injected playback meter, speaking falls back to the mic
// level, which is what lets setLevel drive this test.
test('the speaking level envelope attacks over 40 ms and decays over 220 ms', () => {
  const mounted = mount()
  mounted.visual.setState('speaking')
  mounted.step()
  assert.equal(mounted.visual.smoothedLevel, 0)

  mounted.visual.setLevel(1)
  mounted.step(40)
  assert.ok(
    Math.abs(mounted.visual.smoothedLevel - 0.6321) < 0.005,
    `attack reaches 63% in 40 ms, got ${mounted.visual.smoothedLevel}`,
  )

  mounted.visual.setLevel(0)
  // 220 ms of decay, spread over frames the tick's per-frame budget accepts.
  for (let index = 0; index < 5; index += 1) mounted.step(44)
  assert.ok(
    Math.abs(mounted.visual.smoothedLevel - 0.2325) < 0.005,
    `decay falls to 36.8% by t=260 ms, got ${mounted.visual.smoothedLevel}`,
  )

  // Attack must be the faster of the two: a syllable has to land, not fade in.
  mounted.visual.setLevel(1)
  mounted.step(44)
  assert.ok(mounted.visual.smoothedLevel > 0.7, 'the same 44 ms climbs far further than it fell')
  mounted.visual.destroy()
})

// Listening is an acknowledgment, not a meter: its envelope is deliberately
// slower (140 ms attack, 480 ms decay), so the field holds a gentle
// contraction across word gaps instead of releasing at syllable rate.
test('the listening envelope is calmer: 140 ms attack, 480 ms decay', () => {
  const mounted = mount()
  mounted.visual.setState('listening')
  mounted.step()
  assert.equal(mounted.visual.smoothedLevel, 0)

  // Each step stays under the 50 ms per-frame budget; the totals land exactly
  // on one time constant each.
  mounted.visual.setLevel(1)
  for (let index = 0; index < 4; index += 1) mounted.step(35)
  assert.ok(
    Math.abs(mounted.visual.smoothedLevel - 0.6321) < 0.005,
    `attack reaches 63% in 140 ms, got ${mounted.visual.smoothedLevel}`,
  )

  mounted.visual.setLevel(0)
  for (let index = 0; index < 12; index += 1) mounted.step(40)
  assert.ok(
    Math.abs(mounted.visual.smoothedLevel - 0.2325) < 0.005,
    `decay falls to 36.8% after 480 ms, got ${mounted.visual.smoothedLevel}`,
  )

  // A single 40 ms step must not land the syllable the way speaking's attack
  // does: listening climbs only about a quarter of the remaining distance.
  mounted.visual.setLevel(1)
  mounted.step(40)
  assert.ok(
    mounted.visual.smoothedLevel < 0.45,
    `listening must not attack at speaking speed, got ${mounted.visual.smoothedLevel}`,
  )
  mounted.visual.destroy()
})

// A direction change is a crossfade, not a switch: the envelope pair follows
// the *rendered* pulse, which eases between directions over PARAM_TAU. After
// speaking→listening the residual outward pulse (~210 ms of easing) must
// drain at speaking's 220 ms decay — holding outward energy under the calm
// 480 ms constant would push the field the wrong way. Only once the pulse
// actually points inward does listening's decay take over.
test('a speaking-to-listening switch drains outward energy fast, then decays calm', () => {
  const mounted = mount()
  mounted.visual.setState('speaking')
  mounted.step()
  mounted.visual.setLevel(1)
  // 900 ms: the pulse eases to ~+1 and the level saturates.
  for (let index = 0; index < 20; index += 1) mounted.step(45)

  mounted.visual.setState('listening')
  mounted.visual.setLevel(0)
  // First 200 ms: the smoothed pulse is still outward (zero-crossing ~210 ms),
  // so every step here must decay at speaking's 220 ms constant.
  for (let index = 0; index < 4; index += 1) mounted.step(50)
  assert.ok(
    Math.abs(mounted.visual.smoothedLevel - 0.4029) < 0.005,
    `outward residue drains at speaking speed, got ${mounted.visual.smoothedLevel}`,
  )

  // Next 400 ms: the pulse has crossed inward, so the 480 ms decay owns the
  // release from here on.
  for (let index = 0; index < 8; index += 1) mounted.step(50)
  assert.ok(
    Math.abs(mounted.visual.smoothedLevel - 0.1751) < 0.005,
    `once inward the calm decay owns the release, got ${mounted.visual.smoothedLevel}`,
  )
  mounted.visual.destroy()
})

// The normal onset path is idle → candidate → listening, with the microphone
// already hot during candidate. Zero-pulse states absorb no amplitude, so the
// calm 140 ms attack actually plays from zero instead of arriving saturated.
test('candidate does not precharge the envelope: listening attacks calm from zero', () => {
  const mounted = mount()
  mounted.visual.setState('candidate')
  mounted.step()
  mounted.visual.setLevel(1)
  for (let index = 0; index < 6; index += 1) mounted.step(50)
  assert.equal(mounted.visual.smoothedLevel, 0, 'a pulseless state absorbs nothing')

  mounted.visual.setState('listening')
  for (let index = 0; index < 4; index += 1) mounted.step(35)
  assert.ok(
    Math.abs(mounted.visual.smoothedLevel - 0.6321) < 0.005,
    `listening attacks from zero over 140 ms, got ${mounted.visual.smoothedLevel}`,
  )
  mounted.visual.destroy()
})

test('while speaking the level is pulled from the injected playback source', () => {
  let playbackLevel = 0
  const mounted = mount({ getSpeakingLevel: () => playbackLevel })

  mounted.visual.setState('speaking')
  mounted.step()
  playbackLevel = 1
  mounted.step(40)

  assert.ok(
    Math.abs(mounted.visual.smoothedLevel - 0.6321) < 0.005,
    `speaking follows the playback meter, got ${mounted.visual.smoothedLevel}`,
  )
  assert.equal(mounted.visual.level, 0, 'the microphone level is untouched by the pull')

  // Listening reads the microphone instead: the playback meter must not leak
  // in. Its decay constant is 480 ms, so draining takes more frames here.
  mounted.visual.setState('listening')
  mounted.visual.setLevel(0)
  for (let index = 0; index < 40; index += 1) mounted.step(44)

  assert.ok(
    mounted.visual.smoothedLevel < 0.05,
    `the playback meter is not read while listening, got ${mounted.visual.smoothedLevel}`,
  )
  mounted.visual.destroy()
})

test('a slow rolling frame time halves the field once and never past the floor', () => {
  let elapsed = 0
  let phase = 0
  // Each frame is measured with two clock reads; the second one is 5 ms later.
  const now = () => {
    phase += 1
    if (phase % 2 === 1) return elapsed
    elapsed += 5
    return elapsed
  }
  const mounted = mount({ now, count: 200 })
  mounted.visual.setState('idle')

  for (let index = 0; index < 29; index += 1) mounted.step()
  assert.equal(mounted.visual.particleCount, 200, 'a partial window never degrades')

  mounted.step()
  // Half of 200 is under the 120-particle floor, so the floor wins.
  assert.equal(mounted.visual.particleCount, 120)
  resetDraws(mounted.context)
  mounted.step()
  assert.equal(drawnCount(mounted.context), 120, 'the thinned field is what gets drawn')

  for (let index = 0; index < 90; index += 1) mounted.step()
  assert.equal(mounted.visual.particleCount, 120, 'the field is halved at most once')
  mounted.visual.destroy()
})

test('a fast frame time leaves the full field alone', () => {
  let elapsed = 0
  let phase = 0
  const now = () => {
    phase += 1
    if (phase % 2 === 1) return elapsed
    elapsed += 1.5
    return elapsed
  }
  const mounted = mount({ now })
  mounted.visual.setState('listening')
  for (let index = 0; index < 120; index += 1) mounted.step()

  assert.equal(mounted.visual.particleCount, 240)
  mounted.visual.destroy()
})

test('a pixel-ratio change rebuilds the backing store and the sprite atlas', () => {
  let ratio = 1
  const media = mediaStub()
  const mounted = mount({ devicePixelRatio: () => ratio, matchMedia: media.matchMedia })
  const densities = () => media.queries.filter(query => query.media.startsWith('(resolution'))

  assert.deepEqual([mounted.canvas.width, mounted.canvas.height], [116, 116])
  assert.equal(densities().length, 1, 'the current density is watched')
  assert.equal(densities()[0].media, '(resolution: 1dppx)')
  assert.equal(mounted.offscreen.length, 1)

  ratio = 3
  densities()[0].handlers[0]()

  // The cap still holds: a 3x display is drawn at 2x.
  assert.deepEqual([mounted.canvas.width, mounted.canvas.height], [232, 232])
  assert.equal(mounted.offscreen.length, 2, 'the atlas is re-rendered at the new density')
  assert.equal(densities().length, 2, 'the listener re-arms on the new density')
  assert.equal(densities()[1].media, '(resolution: 3dppx)')
  assert.equal(densities()[0].handlers.length, 0, 'the stale query is released')

  mounted.step()
  assert.ok(drawnCount(mounted.context) > 0)
  mounted.visual.destroy()
  assert.equal(densities()[1].handlers.length, 0, 'destroy releases the density listener')
})

test('enabling reduce motion mid-session stops the loop and draws one still frame', () => {
  const media = mediaStub()
  const mounted = mount({ matchMedia: media.matchMedia, seed: 4242 })
  mounted.visual.setState('listening')
  mounted.step()
  assert.equal(mounted.pending.length, 1, 'the live tier is running')

  resetDraws(mounted.context)
  const clears = mounted.context.calls.clearRect
  media.emit('(prefers-reduced-motion: reduce)', true)

  assert.equal(mounted.pending.length, 0, 'the loop stops instead of animating on')
  assert.equal(mounted.visual.fps, 0)
  assert.equal(mounted.context.calls.clearRect, clears + 1, 'exactly one static frame')
  assert.ok(drawnCount(mounted.context) > 0, 'and it is a drawn constellation')

  // From here on the orb behaves exactly like one built in reduced motion: a
  // state change redraws in place and never schedules.
  resetDraws(mounted.context)
  mounted.visual.setState('idle')
  assert.equal(mounted.context.calls.clearRect, clears + 2)
  assert.equal(mounted.pending.length, 0)

  // Turning the preference back off resumes the tier the state is worth.
  media.emit('(prefers-reduced-motion: reduce)', false)
  assert.equal(mounted.pending.length, 1, 'the loop comes back')
  assert.equal(mounted.visual.fps, 15)
  const resumed = mounted.context.calls.clearRect
  mounted.step()
  assert.equal(mounted.context.calls.clearRect, resumed + 1, 'and it animates again')

  mounted.visual.destroy()
  assert.equal(
    media.find('(prefers-reduced-motion: reduce)').handlers.length,
    0,
    'destroy releases the preference listener',
  )
})

test('enabling high contrast mid-session stops scheduling entirely', () => {
  const media = mediaStub()
  const mounted = mount({ matchMedia: media.matchMedia })
  mounted.visual.setState('speaking')
  mounted.step()
  assert.equal(mounted.pending.length, 1)

  media.emit('(prefers-contrast: more)', true)

  // The stylesheet hides .orb-canvas under prefers-contrast, so a frame drawn
  // into it would be pure cost: nothing may be scheduled, then or later.
  assert.equal(mounted.pending.length, 0, 'the in-flight frame is dropped')
  assert.equal(mounted.visual.fps, 0)
  mounted.visual.setState('listening')
  mounted.visual.setLevel(1)
  assert.equal(mounted.pending.length, 0, 'and nothing later earns a frame either')

  media.emit('(prefers-contrast: more)', false)
  assert.equal(mounted.pending.length, 1, 'the visible canvas gets its tier back')
  assert.equal(mounted.visual.fps, 60)

  mounted.visual.destroy()
  assert.equal(media.find('(prefers-contrast: more)').handlers.length, 0)
})

test('setAccessibility keeps the orb static while either preference is on', () => {
  const mounted = mount()
  mounted.visual.setState('listening')
  mounted.step()
  assert.equal(mounted.pending.length, 1)

  mounted.visual.setAccessibility({ reducedMotion: true, highContrast: true })
  assert.equal(mounted.pending.length, 0)
  assert.equal(mounted.visual.fps, 0)

  mounted.visual.setAccessibility({ reducedMotion: false })
  assert.equal(mounted.pending.length, 0, 'high contrast alone still hides the canvas')

  mounted.visual.setAccessibility({ highContrast: false })
  assert.equal(mounted.pending.length, 1, 'with both off the tier returns')
  assert.equal(mounted.visual.fps, 60)
  mounted.visual.destroy()
})

test('the renderer feeds microphone and playback amplitude into the visual', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  // Both capture paths land in detectLocalOnset, so one call covers browser and
  // native microphones alike.
  assert.match(source, /visual\.setLevel\(measurePcmLevel\(pcm\)\)/)
  assert.match(source, /getSpeakingLevel: \(\) => getPlaybackLevel\(\)/)
  assert.match(source, /new PlaybackMeter\(/)
  assert.match(source, /new NativeLevelEnvelope\(/)
  assert.match(source, /nativeLevel\.push\(frame\.pcm/)
  // Playback is routed through the meter rather than straight at the speakers.
  assert.doesNotMatch(source, /node\.connect\(context\.destination\)/)
})

test('the renderer fires the barge-in impulse on the playback interrupted transition', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  // Every transition onto the interrupted playback axis goes through one door,
  // which is also the only place the axis is assigned.
  assert.match(
    source,
    /function markPlaybackInterrupted\(\) \{\n  if \(axes\.playback !== 'interrupted'\) visual\.interrupt\(\)\n  axes\.playback = 'interrupted'\n\}/,
  )
  assert.equal(
    source.match(/axes\.playback = 'interrupted'/g).length,
    1,
    'the interrupted axis is assigned only inside that door',
  )
  // Both clear paths — the plain playback.clear and the alert replacement —
  // walk through it, so the scatter is independent of what deriveOrbState says.
  assert.equal(source.match(/markPlaybackInterrupted\(\)/g).length, 3)
  assert.match(source, /if \(result\.cleared\) markPlaybackInterrupted\(\)/)
})

test('the renderer maps the onset attack window onto the candidate state', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  // 'candidate' is only reachable if the 50 ms attack window the tracker is
  // still inside reaches the axes; without it the orb jumps idle → listening.
  assert.match(
    source,
    /axes\.capture = onsetTracker\.active\n\s*\? 'listening'\n\s*: onsetTracker\.pending \? 'candidate' : 'idle'/,
  )
})

test('the build syntax-checks the visual module', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'nova-visual-build-check-'))
  try {
    await cp(new URL('../src', import.meta.url), resolve(temporary, 'src'), { recursive: true })
    await cp(new URL('../scripts', import.meta.url), resolve(temporary, 'scripts'), {
      recursive: true,
    })
    await writeFile(
      resolve(temporary, 'src/renderer/orb-visual.mjs'),
      'export const malformed =',
      'utf8',
    )
    assert.throws(
      () => checkJavaScriptFiles(temporary),
      /src\/renderer\/orb-visual\.mjs/u,
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
