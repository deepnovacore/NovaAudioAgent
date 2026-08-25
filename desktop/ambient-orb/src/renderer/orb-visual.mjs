// Particle nebula orb visual.
//
// The orb's appearance is a field of ~240 additively composited sprites, not a
// CSS gradient sphere. Every state named by state.mjs maps to a small set of
// behaviour parameters (how tightly the field converges, how fast it orbits,
// how much it trembles), and the renderer feeds those in from the same pass
// that writes `data-state`, so the accessibility contract stays authoritative
// and this module stays a pure presentation layer.
//
// Performance shape: sprite discs are pre-rendered once into an offscreen atlas
// and blitted with `drawImage` under `globalCompositeOperation = 'lighter'`.
// There is no per-particle gradient, blur, or filter, and the frame loop
// allocates nothing — all per-particle data lives in typed arrays reused
// across frames.

const TAU = Math.PI * 2

const ORB_SIZE = 116
const CENTER = ORB_SIZE / 2
const MAX_PIXEL_RATIO = 2
const PLATE_RADIUS = 57

const DEFAULT_COUNT = 240
const MIN_COUNT = 120
const FIELD_RADIUS = 44
const CORE_RADIUS = 12
const RING_RADIUS = 46
const MAX_RADIUS = 52
const MIN_RADIUS = 1.5

const CODEX_COUNT = 14
const CODEX_RADIUS = 54
const CODEX_ORBIT_SPEED = 0.04
const CODEX_ALPHA = 0.85

const JITTER_PX = 9
const JITTER_ARC = 0.22
const PULSE_PX = 12
const SCATTER_PX = 16

const PARAM_TAU = 180
const SCATTER_TAU = 260

// Amplitude envelope: a syllable has to land on the field immediately, but the
// field must not flicker back to nothing between two of them. Both numbers are
// exponential time constants — one constant covers 1 - e^-1 = 63.2% of the
// remaining distance — so the attack is fast and the release is slow.
const LEVEL_ATTACK_MS = 40
const LEVEL_DECAY_MS = 220

const MAX_FRAME_MS = 50
const FIRST_FRAME_MS = 16
// rAF timestamps never land exactly on a tier boundary; without this a 16.7 ms
// display would skip every other 30 fps frame and halve the tier.
const TICK_SLACK_MS = 1

// Auto-degrade: if our own advance+draw is costing this much per frame on
// average, the machine cannot afford the full field and the count is halved once.
const DEGRADE_FRAME_MS = 4
const DEGRADE_WINDOW = 30

// Sprite atlas: four disc sizes across, one row per colour tier. The 3px cell is
// what the far field is drawn with — the old smallest sprite was 5px, which at
// the rim reads as a nearby blob rather than a distant pinpoint.
const SPRITE_SIZES = Object.freeze([3, 5, 9, 15])
const SPRITE_MAX = 15
const ROW_HOT = 0
const ROW_WARM = 1
const ROW_COOL = 2
const ROW_DUST = 3
const ROW_CODEX = 4
const ROW_ALERT = 5
const ROW_DIM = 6
const ROW_COUNT = 7

// Plate composition. The plate used to be one flat translucent fill, which read
// as a coin: a disc of uniform brightness carries no depth cue at all, so the
// particles sat *on* it instead of *in* it. Each palette now names its layers
// instead — an abyss at the rim, a mantle across the mid-field, a bloom at the
// core, a short list of haze clouds, a vignette, and a faint rim light — and
// renderPlate composites them once into the atlas. None of it costs a frame.
//
// `bloomOffset` lifts the core glow above centre by that fraction of the plate
// radius: a perfectly centred glow reads as a flat ring, an offset one reads as
// depth, because the eye takes the brighter half as nearer. Haze coordinates and
// radii are fractions of the plate radius, so they survive any pixel ratio.
const EMBER = Object.freeze({
  core: '#FFB454',
  highlight: '#FFE3B3',
  deep: '#C96F2B',
  dust: '#8C5A2B',
  dustAlpha: 0.25,
  // Near-black with a violet cast rather than the old warm brown: warmth belongs
  // to the stars and the bloom, and a warm *rim* was half of why this read flat.
  abyss: 'rgba(6, 5, 10, .95)',
  mantle: 'rgba(26, 17, 18, .9)',
  bloom: 'rgba(92, 51, 27, .78)',
  bloomOffset: 0.1,
  haze: Object.freeze([
    Object.freeze({ x: -0.3, y: -0.26, radius: 0.62, color: '#8C4A1E', alpha: 0.2 }),
    Object.freeze({ x: 0.32, y: 0.2, radius: 0.55, color: '#6E3D5A', alpha: 0.16 }),
    Object.freeze({ x: 0.08, y: 0.38, radius: 0.44, color: '#2E4668', alpha: 0.13 }),
  ]),
  vignette: '#020205',
  rim: 'rgba(255, 214, 156, .12)',
  ring: 'rgba(255, 214, 156, .22)',
  codexBand: '#FFD9A0',
  error: '#FF5A5A',
  inactive: '#6E6A63',
})

const GRAPHITE = Object.freeze({
  core: '#E8ECF2',
  mid: '#9AA3AF',
  shadow: '#3A404A',
  abyss: 'rgba(4, 6, 10, .95)',
  mantle: 'rgba(16, 20, 27, .9)',
  bloom: 'rgba(62, 74, 92, .72)',
  bloomOffset: 0.1,
  haze: Object.freeze([
    Object.freeze({ x: -0.28, y: -0.28, radius: 0.6, color: '#4A5A72', alpha: 0.18 }),
    Object.freeze({ x: 0.3, y: 0.22, radius: 0.52, color: '#38506B', alpha: 0.14 }),
    Object.freeze({ x: 0.06, y: 0.36, radius: 0.42, color: '#2A3346', alpha: 0.12 }),
  ]),
  vignette: '#010204',
  rim: 'rgba(232, 236, 242, .1)',
  ring: 'rgba(232, 236, 242, .18)',
  accent: '#FFC978',
  error: '#FF6B6B',
})

const PALETTES = Object.freeze({ ember: EMBER, graphite: GRAPHITE })

export function paletteColors(name) {
  return PALETTES[name] || EMBER
}

function stateParams({
  convergence,
  orbitSpeed,
  jitter,
  pulseGain,
  pulseDirection = 0,
  alpha,
  countRatio,
  ringRadius = 0,
  scatter = 0,
  tone = 'base',
}) {
  return Object.freeze({
    convergence,
    orbitSpeed,
    jitter,
    pulseGain,
    pulseDirection,
    alpha,
    countRatio,
    ringRadius,
    scatter,
    tone,
  })
}

const LISTENING = stateParams({
  convergence: 0.8,
  orbitSpeed: 0.1,
  jitter: 0.1,
  pulseGain: 0.6,
  pulseDirection: -1,
  alpha: 1,
  countRatio: 1,
})

// A dead or refused session collapses the whole field onto one thin ring: the
// silhouette reads as "stopped" at a glance, without borrowing the live states'
// colour language. The three terminal states share that language — collapsed,
// dimmed, alert-toned — but they must not share one geometry: colour is the
// first thing a grayscale display, a colour-blind viewer, or a photo of a menu
// bar loses, so each varies its ring radius, density, and restlessness instead.
function collapseParams({ ringRadius, countRatio, orbitSpeed, jitter = 0.04 }) {
  return stateParams({
    convergence: 0.9,
    orbitSpeed,
    jitter,
    pulseGain: 0,
    alpha: 0.5,
    countRatio,
    ringRadius,
    tone: 'alert',
  })
}

export const STATE_PARAMS = Object.freeze({
  booting: stateParams({
    convergence: 0.4,
    orbitSpeed: 0.2,
    jitter: 0.3,
    pulseGain: 0,
    alpha: 0.7,
    countRatio: 0.7,
  }),
  inactive: stateParams({
    convergence: 0.1,
    orbitSpeed: 0.02,
    jitter: 0.02,
    pulseGain: 0,
    alpha: 0.35,
    countRatio: 0.4,
    tone: 'dim',
  }),
  idle: stateParams({
    convergence: 0.25,
    orbitSpeed: 0.06,
    jitter: 0.12,
    pulseGain: 0,
    alpha: 0.8,
    countRatio: 1,
  }),
  candidate: stateParams({
    convergence: 0.35,
    orbitSpeed: 0.08,
    jitter: 0.18,
    pulseGain: 0,
    alpha: 0.9,
    countRatio: 1,
  }),
  listening: LISTENING,
  speaking: stateParams({
    convergence: 0.3,
    orbitSpeed: 0.12,
    jitter: 0.2,
    pulseGain: 1,
    pulseDirection: 1,
    alpha: 1,
    countRatio: 1,
  }),
  // A barge-in is a one-shot outward impulse over the listening field: the
  // scatter decays away while the state itself stays "interrupted". This entry
  // covers the case the derived state can actually name — playback cleared
  // without the microphone taking over — and owns the impulse size that
  // interrupt() reuses for a barge-in over any other state.
  interrupted: Object.freeze({ ...LISTENING, scatter: 1 }),
  // A dropped backend: the widest, sparsest, slowest ring — the field simply
  // stopped where it was.
  disconnected: collapseParams({ ringRadius: RING_RADIUS, countRatio: 0.5, orbitSpeed: 0.03 }),
  reconnecting: stateParams({
    convergence: 0.45,
    orbitSpeed: 0.18,
    jitter: 0.15,
    pulseGain: 0,
    alpha: 0.65,
    countRatio: 0.6,
    tone: 'alert',
  }),
  'configuration-required': collapseParams({ ringRadius: 34, countRatio: 0.55, orbitSpeed: 0.02 }),
  'authentication-failed': collapseParams({ ringRadius: 30, countRatio: 0.45, orbitSpeed: 0.02 }),
  'backend-unavailable': collapseParams({ ringRadius: 44, countRatio: 0.45, orbitSpeed: 0.02 }),
  // A failure is restless: a tighter ring, denser, drifting faster and
  // trembling, so "something went wrong" reads differently from "nothing is
  // there" even with the colour thrown away.
  error: collapseParams({ ringRadius: 38, countRatio: 0.75, orbitSpeed: 0.06, jitter: 0.06 }),
  // A refusal is small and closed: the tightest, sparsest, near-still ring.
  'permission-denied': collapseParams({ ringRadius: 28, countRatio: 0.35, orbitSpeed: 0.02 }),
  'microphone-restricted': collapseParams({ ringRadius: 28, countRatio: 0.35, orbitSpeed: 0.02 }),
  'microphone-no-device': collapseParams({ ringRadius: 46, countRatio: 0.35, orbitSpeed: 0.02 }),
  'microphone-busy': collapseParams({ ringRadius: 34, countRatio: 0.55, orbitSpeed: 0.06 }),
  'microphone-unavailable': collapseParams({ ringRadius: 42, countRatio: 0.4, orbitSpeed: 0.02 }),
  'audio-pipeline-error': collapseParams({ ringRadius: 38, countRatio: 0.7, orbitSpeed: 0.06, jitter: 0.06 }),
})

// Tick tiers. A resting orb sits in the menu bar for hours, so it must not pay
// display rate for a field that is barely moving, and a dead session must not
// pay anything at all: zero means one static frame with the loop stopped.
export const STATE_FPS = Object.freeze({
  speaking: 60,
  listening: 60,
  interrupted: 60,
  candidate: 30,
  booting: 30,
  idle: 15,
  inactive: 0,
  disconnected: 0,
  reconnecting: 30,
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

const DEFAULT_STATE = 'booting'

// The two accessibility preferences that decide whether this module animates at
// all. Both are watched live: a viewer who turns Reduce Motion on mid-session
// must not keep getting animation, and one who turns high contrast on must not
// keep paying for frames drawn into a canvas the stylesheet has hidden.
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const HIGH_CONTRAST_QUERY = '(prefers-contrast: more)'

// Deterministic PRNG: the layout must be reproducible so a reduced-motion
// constellation is stable across redraws and assertable in tests.
export function mulberry32(seed) {
  let state = seed >>> 0
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

// FNV-1a: a small, well-distributed string hash used only to fold a state
// name into the numeric seed, so `stateSeed(base, name)` lands on a distinct
// mulberry32 stream per state instead of the same stream at every state.
function hashStateName(name) {
  let hash = 0x811c9dc5
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function approach(current, target, elapsedMs, tau) {
  return current + (target - current) * (1 - Math.exp(-elapsedMs / tau))
}

function rgba(hex, alpha) {
  const red = Number.parseInt(hex.slice(1, 3), 16)
  const green = Number.parseInt(hex.slice(3, 5), 16)
  const blue = Number.parseInt(hex.slice(5, 7), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function spriteRows(name) {
  const colors = paletteColors(name)
  if (colors === GRAPHITE) {
    return [
      [colors.core, 1],
      [colors.mid, 1],
      [colors.shadow, 1],
      [colors.shadow, 0.25],
      [colors.accent, 1],
      [colors.error, 1],
      // ROW_DIM (the 'inactive' tone) used to bake `shadow` (#3A404A, a dark
      // blue-grey) at full row alpha, then let the state's own 0.35 alpha and
      // 'lighter' compositing crush it further: over the dark plate that was
      // reliably unreadable. The exported GRAPHITE hex table stays untouched;
      // only this row swaps to the mid tone at a reduced baked alpha, closer
      // to how EMBER's own dim tier (`inactive`, a mid-brightness brown-grey)
      // already reads at the same state alpha.
      [colors.mid, 0.6],
    ]
  }
  return [
    [colors.highlight, 1],
    [colors.core, 1],
    [colors.deep, 1],
    [colors.dust, colors.dustAlpha],
    [colors.codexBand, 1],
    [colors.error, 1],
    [colors.inactive, 1],
  ]
}

function defaultCreateCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height)
  const canvas = globalThis.document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

// The plate, composited once at atlas build time. Every layer fills the same disc
// path — the gradients do the shaping, and painting the disc rather than each
// layer's own circle is what keeps a haze cloud from leaking past the rim without
// needing a clip. Depth is entirely in this falloff: a flat fill gives the eye
// nothing to read the disc's shape from, which is why the old plate read as a coin.
function renderPlate(context, colors, originY, plateSize, pixelRatio) {
  const centerX = plateSize / 2
  const centerY = originY + plateSize / 2
  const radius = PLATE_RADIUS * pixelRatio

  function fillDisc(style) {
    context.fillStyle = style
    context.beginPath()
    context.arc(centerX, centerY, radius, 0, TAU)
    context.fill()
  }

  // The bloom sits above centre, so the disc has a near side. Points past the
  // gradient's outer circle take its last stop, which sinks the lower rim into
  // the abyss colour for free.
  const bloomY = centerY - radius * colors.bloomOffset
  const base = context.createRadialGradient(centerX, bloomY, 0, centerX, bloomY, radius)
  base.addColorStop(0, colors.bloom)
  base.addColorStop(0.45, colors.mantle)
  base.addColorStop(1, colors.abyss)
  context.globalCompositeOperation = 'source-over'
  fillDisc(base)

  // Gas reads as light rather than paint, so the clouds are added, not laid over.
  context.globalCompositeOperation = 'lighter'
  for (const cloud of colors.haze) {
    const cloudX = centerX + cloud.x * radius
    const cloudY = centerY + cloud.y * radius
    const cloudRadius = cloud.radius * radius
    const gradient = context.createRadialGradient(cloudX, cloudY, 0, cloudX, cloudY, cloudRadius)
    gradient.addColorStop(0, rgba(cloud.color, cloud.alpha))
    gradient.addColorStop(0.5, rgba(cloud.color, cloud.alpha * 0.45))
    gradient.addColorStop(1, rgba(cloud.color, 0))
    fillDisc(gradient)
  }

  // Closing the rim down is what turns the disc from a coin into a well.
  context.globalCompositeOperation = 'source-over'
  const vignette = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius)
  vignette.addColorStop(0, rgba(colors.vignette, 0))
  vignette.addColorStop(0.55, rgba(colors.vignette, 0))
  vignette.addColorStop(0.85, rgba(colors.vignette, 0.45))
  vignette.addColorStop(1, rgba(colors.vignette, 0.92))
  fillDisc(vignette)

  // A hairline just inside the rim the vignette has now buried: without it the
  // disc loses its silhouette against a dark desktop.
  context.lineWidth = Math.max(1, pixelRatio * 0.75)
  context.strokeStyle = colors.rim
  context.beginPath()
  context.arc(centerX, centerY, radius - context.lineWidth / 2, 0, TAU)
  context.stroke()
}

// One texture for every particle plus the plate: four disc sizes by seven colour
// tiers, rendered at device resolution so the blits stay crisp without
// re-gradients. The plate shares this canvas rather than taking a second one —
// the atlas is already rebuilt on a palette or pixel-ratio change, and two
// textures would mean two rebuild paths to keep in step.
function renderAtlas(createCanvas, paletteName, pixelRatio) {
  const rows = spriteRows(paletteName)
  const columnWidths = SPRITE_SIZES.map(size => Math.ceil(size * pixelRatio))
  const columnOffsets = []
  let spriteWidth = 0
  for (const columnWidth of columnWidths) {
    columnOffsets.push(spriteWidth)
    spriteWidth += columnWidth
  }
  const rowHeight = Math.ceil(SPRITE_MAX * pixelRatio)
  const plateSize = Math.round(ORB_SIZE * pixelRatio)
  const plateTop = rowHeight * ROW_COUNT
  const canvas = createCanvas(Math.max(spriteWidth, plateSize), plateTop + plateSize)
  const context = canvas.getContext('2d')
  for (let row = 0; row < rows.length; row += 1) {
    const [hex, alpha] = rows[row]
    for (let column = 0; column < columnWidths.length; column += 1) {
      const box = columnWidths[column]
      const centerX = columnOffsets[column] + box / 2
      const centerY = row * rowHeight + box / 2
      const radius = box / 2
      const gradient = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius)
      // A hard core, a fast drop, then a long faint halo. The old ramp still held
      // 55% alpha at 40% of the radius, which made every particle a soft ball —
      // a field of blobs cannot read as stars however it is composited.
      gradient.addColorStop(0, rgba(hex, alpha))
      gradient.addColorStop(0.18, rgba(hex, alpha * 0.85))
      gradient.addColorStop(0.42, rgba(hex, alpha * 0.28))
      gradient.addColorStop(1, rgba(hex, 0))
      context.fillStyle = gradient
      context.beginPath()
      context.arc(centerX, centerY, radius, 0, TAU)
      context.fill()
    }
  }
  renderPlate(context, paletteColors(paletteName), plateTop, plateSize, pixelRatio)
  return { canvas, columnOffsets, columnWidths, rowHeight, plateTop, plateSize }
}

export function createOrbVisual(canvas, options = {}) {
  const {
    reducedMotion = false,
    highContrast = false,
    palette = 'ember',
    count = DEFAULT_COUNT,
    seed = 0x6f7262,
    devicePixelRatio: pixelRatioInput,
    createCanvas = defaultCreateCanvas,
    raf,
    cancelRaf,
    now,
    getSpeakingLevel = null,
    document: documentRef = globalThis.document,
    matchMedia: matchMediaRef = typeof globalThis.matchMedia === 'function'
      ? query => globalThis.matchMedia(query)
      : null,
  } = options

  const schedule = raf
    || (typeof globalThis.requestAnimationFrame === 'function'
      ? callback => globalThis.requestAnimationFrame(callback)
      : null)
  const unschedule = cancelRaf
    || (typeof globalThis.cancelAnimationFrame === 'function'
      ? handle => globalThis.cancelAnimationFrame(handle)
      : () => {})
  const clock = typeof now === 'function'
    ? now
    : () => (globalThis.performance?.now?.() ?? Date.now())

  // A high-contrast viewer sees the CSS solid disc instead of this canvas, and
  // a reduced-motion viewer gets one still constellation: neither runs a loop.
  // Both preferences can be toggled while the orb is on screen, so these are
  // live values rather than a construction-time snapshot.
  let reducedMotionOn = reducedMotion === true
  let highContrastOn = highContrast === true
  const computeStaticMode = () => reducedMotionOn || highContrastOn || !schedule
  let staticMode = computeStaticMode()

  // The raw device ratio drives the media query; the capped one drives the
  // backing store, because past 2x a 116px disc stops paying for the pixels.
  const readRawRatio = typeof pixelRatioInput === 'function'
    ? () => Number(pixelRatioInput()) || 1
    : () => Number(pixelRatioInput ?? globalThis.devicePixelRatio ?? 1) || 1
  const capRatio = raw => Math.min(MAX_PIXEL_RATIO, Math.max(1, raw))

  let rawPixelRatio = readRawRatio()
  let pixelRatio = capRatio(rawPixelRatio)
  const context = canvas?.getContext?.('2d')
  // A refused 2D context (a GPU process that just died, a canvas that is not
  // one) would otherwise surface as a TypeError from inside the first draw:
  // failing here is what lets createOrbVisualSafe below trade the whole visual
  // for a no-op instead of taking the renderer down with it.
  if (!context) throw new Error('the orb canvas has no 2D context')

  function applyBackingStore() {
    const backingSize = Math.round(ORB_SIZE * pixelRatio)
    canvas.width = backingSize
    canvas.height = backingSize
  }

  applyBackingStore()

  let paletteName = PALETTES[palette] ? palette : 'ember'
  let colors = paletteColors(paletteName)
  let atlas = renderAtlas(createCanvas, paletteName, pixelRatio)

  const total = Math.max(1, Math.round(count))
  const homeRadius = new Float32Array(total)
  // Angles advance in place and wrap per particle: a single shared phase
  // multiplied by per-particle rates cannot be wrapped without a visible jump.
  const angle = new Float32Array(total)
  const spin = new Float32Array(total)
  const wobbleFrequency = new Float32Array(total)
  const wobblePhase = new Float32Array(total)
  const twinkleFrequency = new Float32Array(total)
  const twinklePhase = new Float32Array(total)
  const sizeIndex = new Uint8Array(total)
  const tierRow = new Uint8Array(total)

  const codexAngle = new Float32Array(CODEX_COUNT)

  // Fills every typed array above from a single PRNG stream, in place: the
  // arrays are allocated once and reused, whether this runs once at
  // construction (the common, animated case) or again on every state change
  // in static mode (see `stateSeed` below).
  function fillField(fieldSeed) {
    const random = mulberry32(fieldSeed)
    for (let index = 0; index < total; index += 1) {
      // sqrt keeps the field area-uniform instead of clumping at the centre.
      const normalized = 0.16 + 0.84 * Math.sqrt(random())
      homeRadius[index] = normalized
      angle[index] = random() * TAU
      spin[index] = 0.7 + random() * 0.65
      wobbleFrequency[index] = 0.6 + random() * 1.2
      wobblePhase[index] = random() * TAU
      twinkleFrequency[index] = 0.5 + random() * 1.5
      twinklePhase[index] = random() * TAU
      // Size runs with depth, not against it: the far field is small and faint,
      // the near field is large and bright. This mapping used to be inverted —
      // the 15px sprite lived at the rim — which blurred the disc's edge and
      // handed the core the smallest cell, flattening the whole field.
      //
      // The tier draw is now taken in every branch rather than only in the
      // outermost one, so the stream advances by a fixed number of draws per
      // particle instead of depending on which branch that particle took. That
      // does shift the constellation relative to the old irregular stream; the
      // layout stays a pure function of (seed, state), which is what is actually
      // asserted, and an irregular stream was a latent trap for exactly the kind
      // of change being made here.
      // Two independent draws, because size and colour tier are independent: one
      // shared draw would make every dust particle the small one and every cool
      // particle the large one, a correlation that shows up as banding.
      const tint = random()
      const grade = random()
      if (normalized > 0.82) {
        sizeIndex[index] = grade < 0.4 ? 1 : 0
        tierRow[index] = tint < 0.55 ? ROW_DUST : ROW_COOL
      } else if (normalized > 0.5) {
        sizeIndex[index] = grade < 0.55 ? 1 : 0
        tierRow[index] = ROW_COOL
      } else if (normalized > 0.3) {
        sizeIndex[index] = grade < 0.3 ? 2 : 1
        tierRow[index] = ROW_WARM
      } else {
        // The brightest few near stars carry the 15px bloom; the rest sit at 9px.
        sizeIndex[index] = grade < 0.12 ? 3 : 2
        tierRow[index] = ROW_HOT
      }
    }
    for (let index = 0; index < CODEX_COUNT; index += 1) {
      codexAngle[index] = (index / CODEX_COUNT) * TAU + random() * 0.06
    }
  }

  // A reduced-motion or high-contrast viewer never sees particles ease
  // between states — each state change swaps directly to its own still
  // frame — so each state can and should get its own constellation instead
  // of the same field merely rescaled by that state's convergence. An
  // animated viewer keeps one continuous field: reseeding it on every state
  // change would jump the whole pattern instead of easing, which is exactly
  // what the live tiers are built to avoid.
  function stateSeed(name) {
    return staticMode ? (seed ^ hashStateName(name)) >>> 0 : seed
  }

  let stateName = DEFAULT_STATE
  fillField(stateSeed(stateName))
  let params = STATE_PARAMS[stateName]
  let codexWorking = false
  let level = 0

  // Live, smoothed values: state changes ease instead of snapping.
  let convergence = params.convergence
  let orbitSpeed = params.orbitSpeed
  let jitter = params.jitter
  let alpha = params.alpha
  let countRatio = params.countRatio
  let targetRadius = params.ringRadius || CORE_RADIUS
  let ringOpacity = params.ringRadius ? 1 : 0
  let pulse = params.pulseGain * params.pulseDirection
  let levelSmoothed = 0
  let scatter = 0

  let wobbleClock = 0
  let codexPhase = 0
  let frameHandle = null
  let lastTimestamp = -1
  let destroyed = false
  let hidden = documentRef?.visibilityState === 'hidden'

  // Rolling frame-cost window, allocated once: the tick must stay allocation-free.
  const frameCost = new Float32Array(DEGRADE_WINDOW)
  let frameCostIndex = 0
  let frameCostFilled = 0
  let frameCostTotal = 0
  let activeMax = total
  let degraded = false

  function sampleFrameCost(costMs) {
    if (degraded || !Number.isFinite(costMs)) return
    frameCostTotal += costMs - frameCost[frameCostIndex]
    frameCost[frameCostIndex] = costMs
    frameCostIndex = frameCostIndex + 1 === DEGRADE_WINDOW ? 0 : frameCostIndex + 1
    if (frameCostFilled < DEGRADE_WINDOW) {
      frameCostFilled += 1
      if (frameCostFilled < DEGRADE_WINDOW) return
    }
    if (frameCostTotal / DEGRADE_WINDOW <= DEGRADE_FRAME_MS) return
    // Halved once and never again: a field that keeps shrinking under its own
    // measurement noise would be worse than a slow one.
    degraded = true
    activeMax = Math.max(Math.min(total, MIN_COUNT), Math.floor(total / 2))
  }

  // Speaking follows what the speakers are doing; every other state follows the
  // microphone level pushed in by setLevel.
  function levelTarget() {
    if (stateName !== 'speaking' || typeof getSpeakingLevel !== 'function') return level
    const value = Number(getSpeakingLevel())
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  }

  function snapToTarget() {
    convergence = params.convergence
    orbitSpeed = params.orbitSpeed
    jitter = params.jitter
    alpha = params.alpha
    countRatio = params.countRatio
    targetRadius = params.ringRadius || CORE_RADIUS
    ringOpacity = params.ringRadius ? 1 : 0
    pulse = params.pulseGain * params.pulseDirection
    levelSmoothed = levelTarget()
    scatter = params.scatter
  }

  function advance(elapsedMs) {
    convergence = approach(convergence, params.convergence, elapsedMs, PARAM_TAU)
    orbitSpeed = approach(orbitSpeed, params.orbitSpeed, elapsedMs, PARAM_TAU)
    jitter = approach(jitter, params.jitter, elapsedMs, PARAM_TAU)
    alpha = approach(alpha, params.alpha, elapsedMs, PARAM_TAU)
    countRatio = approach(countRatio, params.countRatio, elapsedMs, PARAM_TAU)
    targetRadius = approach(targetRadius, params.ringRadius || CORE_RADIUS, elapsedMs, PARAM_TAU)
    ringOpacity = approach(ringOpacity, params.ringRadius ? 1 : 0, elapsedMs, PARAM_TAU)
    pulse = approach(pulse, params.pulseGain * params.pulseDirection, elapsedMs, PARAM_TAU)
    const nextLevel = levelTarget()
    levelSmoothed = approach(
      levelSmoothed,
      nextLevel,
      elapsedMs,
      nextLevel > levelSmoothed ? LEVEL_ATTACK_MS : LEVEL_DECAY_MS,
    )
    scatter *= Math.exp(-elapsedMs / SCATTER_TAU)
    if (scatter < 0.001) scatter = 0
    // Every particle advances, including the ones countRatio is currently
    // hiding, so a thinned field never re-enters with a stale angle.
    const step = orbitSpeed * (elapsedMs / 1000) * TAU
    for (let index = 0; index < total; index += 1) {
      const next = angle[index] + step * spin[index]
      angle[index] = next >= TAU ? next - TAU : next
    }
    wobbleClock += elapsedMs / 1000
    codexPhase += CODEX_ORBIT_SPEED * (elapsedMs / 1000) * TAU
    if (codexPhase > TAU) codexPhase -= TAU
  }

  function blit(row, size, x, y, spriteAlpha) {
    const half = SPRITE_SIZES[size] / 2
    context.globalAlpha = spriteAlpha
    context.drawImage(
      atlas.canvas,
      atlas.columnOffsets[size],
      row * atlas.rowHeight,
      atlas.columnWidths[size],
      atlas.columnWidths[size],
      x - half,
      y - half,
      SPRITE_SIZES[size],
      SPRITE_SIZES[size],
    )
  }

  function draw() {
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    context.globalCompositeOperation = 'source-over'
    context.globalAlpha = 1
    context.clearRect(0, 0, ORB_SIZE, ORB_SIZE)

    // The pre-composited plate: one blit instead of a flat fill, so the disc gets
    // its whole depth stack — bloom, haze, vignette, rim light — at the same
    // per-frame cost the single arc used to pay.
    context.drawImage(
      atlas.canvas,
      0,
      atlas.plateTop,
      atlas.plateSize,
      atlas.plateSize,
      0,
      0,
      ORB_SIZE,
      ORB_SIZE,
    )

    if (ringOpacity > 0.01) {
      context.globalAlpha = ringOpacity
      context.strokeStyle = colors.ring
      context.lineWidth = 1.5
      context.beginPath()
      // The smoothed target radius, not a constant: each terminal state
      // collapses onto its own ring, and the stroke has to sit under the
      // particles rather than at one fixed radius they no longer share.
      context.arc(CENTER, CENTER, targetRadius, 0, TAU)
      context.stroke()
      context.globalAlpha = 1
    }

    context.globalCompositeOperation = 'lighter'

    const tone = params.tone
    const overrideRow = tone === 'alert' ? ROW_ALERT : tone === 'dim' ? ROW_DIM : -1
    const active = Math.max(0, Math.min(activeMax, Math.round(total * countRatio)))
    const pulseOffset = levelSmoothed * pulse * PULSE_PX

    for (let index = 0; index < active; index += 1) {
      const home = homeRadius[index] * FIELD_RADIUS
      let radius = home + (targetRadius - home) * convergence
      radius += jitter * JITTER_PX * Math.sin(wobbleClock * wobbleFrequency[index] + wobblePhase[index])
      radius += pulseOffset
      radius += scatter * SCATTER_PX * (0.6 + 0.4 * homeRadius[index])
      if (radius < MIN_RADIUS) radius = MIN_RADIUS
      else if (radius > MAX_RADIUS) radius = MAX_RADIUS
      const heading = angle[index]
        + jitter * JITTER_ARC * Math.cos(wobbleClock * wobbleFrequency[index] + wobblePhase[index])
      const twinkle = 0.5
        + 0.5 * Math.sin(wobbleClock * twinkleFrequency[index] + twinklePhase[index])
      // Twinkle depth follows the particle's own depth: the far field flickers
      // hard and dim, the core holds steady and bright. Derived from homeRadius
      // rather than a fourth typed array, because this loop allocates nothing.
      //
      // The envelope sits above the flat 0.55 + 0.45 it replaced. A star is small
      // and bright, not large and dim, and the field's sprite area is now a
      // fraction of what it was — per-sprite alpha is what has to carry the
      // brightness that overlapping 15px blobs used to supply.
      const depth = homeRadius[index]
      const floor = 0.78 - 0.36 * depth
      const swing = 0.2 + 0.32 * depth
      blit(
        overrideRow >= 0 ? overrideRow : tierRow[index],
        sizeIndex[index],
        CENTER + Math.cos(heading) * radius,
        CENTER + Math.sin(heading) * radius,
        alpha * (floor + swing * twinkle),
      )
    }

    if (codexWorking) {
      for (let index = 0; index < CODEX_COUNT; index += 1) {
        const heading = codexAngle[index] + codexPhase
        blit(
          ROW_CODEX,
          0,
          CENTER + Math.cos(heading) * CODEX_RADIUS,
          CENTER + Math.sin(heading) * CODEX_RADIUS,
          CODEX_ALPHA,
        )
      }
    }

    context.globalAlpha = 1
    context.globalCompositeOperation = 'source-over'
  }

  function tickIntervalMs() {
    const fps = STATE_FPS[stateName]
    return fps > 0 ? 1000 / fps : 0
  }

  function tick(timestamp) {
    if (destroyed) return
    const interval = tickIntervalMs()
    // A state that went static between two frames stops here rather than
    // rescheduling; setState already drew its single frame.
    if (interval === 0) {
      frameHandle = null
      return
    }
    frameHandle = schedule(tick)
    if (lastTimestamp >= 0 && timestamp - lastTimestamp + TICK_SLACK_MS < interval) return
    const elapsedMs = lastTimestamp < 0
      ? FIRST_FRAME_MS
      // The stall guard has to leave room for the slowest tier's own interval,
      // or a 15 fps field would animate a quarter slower than wall clock.
      : Math.min(Math.max(MAX_FRAME_MS, interval * 2), Math.max(0, timestamp - lastTimestamp))
    lastTimestamp = timestamp
    const startedAt = clock()
    advance(elapsedMs)
    draw()
    sampleFrameCost(clock() - startedAt)
  }

  function stopLoop() {
    if (frameHandle === null) return
    unschedule(frameHandle)
    frameHandle = null
  }

  function startLoop() {
    if (destroyed || staticMode || hidden || frameHandle !== null) return
    if (tickIntervalMs() === 0) return
    // The gap since the last frame is not animation time: a resumed orb starts
    // from a nominal frame instead of jumping through the whole pause.
    lastTimestamp = -1
    frameHandle = schedule(tick)
  }

  function drawStaticFrame() {
    snapToTarget()
    draw()
  }

  function setState(name, { codexWorking: codexNext = false } = {}) {
    if (destroyed) return
    const known = Object.hasOwn(STATE_PARAMS, name)
    const nextName = known ? name : stateName
    const stateNameChanged = nextName !== stateName
    const changed = stateNameChanged || codexNext !== codexWorking
    if (stateNameChanged && STATE_PARAMS[nextName].scatter > 0) {
      scatter = STATE_PARAMS[nextName].scatter
    }
    stateName = nextName
    params = STATE_PARAMS[nextName]
    codexWorking = codexNext
    if (!changed) return
    if (staticMode) {
      // Two states can share the exact same STATE_PARAMS object (disconnected,
      // error, and permission-denied all point at the same frozen COLLAPSE), so
      // the constellation swap has to be keyed on the state *name*, not on
      // whether any parameter actually moved.
      if (stateNameChanged) fillField(stateSeed(stateName))
      drawStaticFrame()
    } else if (tickIntervalMs() === 0) {
      // Nothing here moves, so there is nothing to ease into: snap, draw the one
      // frame this state is worth, and give the loop back.
      stopLoop()
      drawStaticFrame()
    } else {
      startLoop()
    }
  }

  // The one place the mode decides what the field should be doing right now,
  // shared by construction and by a live preference change.
  function applyMode() {
    stopLoop()
    if (staticMode || tickIntervalMs() === 0) drawStaticFrame()
    else startLoop()
  }

  // Reduce Motion or high contrast can be switched on and off while the orb is
  // on screen. Entering either one stops the loop and leaves a single still
  // frame; leaving both hands the state's tier back.
  function setAccessibility(preferences = {}) {
    if (destroyed) return
    const nextReduced = typeof preferences.reducedMotion === 'boolean'
      ? preferences.reducedMotion
      : reducedMotionOn
    const nextContrast = typeof preferences.highContrast === 'boolean'
      ? preferences.highContrast
      : highContrastOn
    if (nextReduced === reducedMotionOn && nextContrast === highContrastOn) return
    reducedMotionOn = nextReduced
    highContrastOn = nextContrast
    const nextStatic = computeStaticMode()
    // Dropping one preference while the other still holds changes nothing on
    // screen: the orb was static and stays static.
    if (nextStatic === staticMode) return
    staticMode = nextStatic
    // The mode is folded into the field seed — static mode gives every state its
    // own constellation, animated mode keeps one continuous field — so crossing
    // the boundary has to refill the field for the mode it is now in.
    fillField(stateSeed(stateName))
    applyMode()
  }

  // A one-shot barge-in impulse over whatever field is on screen.
  //
  // The 'interrupted' *state* is only reachable when playback is cleared without
  // the microphone having taken over, and a real barge-in is the opposite case:
  // the user talks over playback, the capture axis is already 'listening' when
  // the clear lands, and deriveOrbState keeps saying 'listening' — correctly, as
  // that is what the orb is doing. So the renderer calls this instead, and the
  // scatter rides the current state rather than replacing it.
  function interrupt() {
    if (destroyed) return
    scatter = STATE_PARAMS.interrupted.scatter
    if (!staticMode && tickIntervalMs() > 0) {
      // A running loop decays the impulse; a hidden orb picks it up on resume.
      startLoop()
      return
    }
    // Nothing is coming to decay it here — reduced motion, high contrast, or a
    // zero-fps tier — so the impulse gets a single frame and is then released
    // back to the state's canonical constellation, which is what keeps a static
    // layout a pure function of (seed, state).
    draw()
    scatter = 0
    drawStaticFrame()
  }

  function handleVisibilityChange() {
    const nextHidden = documentRef?.visibilityState === 'hidden'
    if (nextHidden === hidden) return
    hidden = nextHidden
    if (hidden) stopLoop()
    else startLoop()
  }

  let ratioQuery = null
  let reducedMotionQuery = null
  let highContrastQuery = null

  // A stub may fire its listeners with no event at all, so the query object is
  // the fallback source of truth for what the preference now reads as.
  function queryMatches(event, query) {
    if (typeof event?.matches === 'boolean') return event.matches
    return query?.matches === true
  }

  function handleReducedMotionChange(event) {
    setAccessibility({ reducedMotion: queryMatches(event, reducedMotionQuery) })
  }

  function handleHighContrastChange(event) {
    setAccessibility({ highContrast: queryMatches(event, highContrastQuery) })
  }

  // The initial values arrive as constructor options (the renderer reads them in
  // the same pass that builds the orb); these listeners only carry later
  // changes, so a preference flipped at runtime lands like one set at boot.
  function armAccessibilityQueries() {
    if (!matchMediaRef) return
    reducedMotionQuery = matchMediaRef(REDUCED_MOTION_QUERY)
    reducedMotionQuery?.addEventListener?.('change', handleReducedMotionChange)
    highContrastQuery = matchMediaRef(HIGH_CONTRAST_QUERY)
    highContrastQuery?.addEventListener?.('change', handleHighContrastChange)
  }

  function armRatioQuery() {
    if (!matchMediaRef) return
    ratioQuery?.removeEventListener?.('change', handleRatioChange)
    ratioQuery = matchMediaRef(`(resolution: ${rawPixelRatio}dppx)`)
    ratioQuery?.addEventListener?.('change', handleRatioChange)
  }

  // Dragging the orb between a Retina and an external display changes the ratio
  // without resizing anything, so the backing store has to be rebuilt here.
  function handleRatioChange() {
    if (destroyed) return
    const nextRaw = readRawRatio()
    if (nextRaw === rawPixelRatio) return
    rawPixelRatio = nextRaw
    armRatioQuery()
    const nextRatio = capRatio(nextRaw)
    if (nextRatio === pixelRatio) return
    pixelRatio = nextRatio
    applyBackingStore()
    atlas = renderAtlas(createCanvas, paletteName, pixelRatio)
    // Resizing a canvas clears it, so a frame nobody else will draw is drawn
    // here: static mode, a static tier, and a hidden orb all have no loop.
    if (frameHandle === null) draw()
  }

  function setLevel(rms) {
    if (destroyed) return
    const value = Number(rms)
    level = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  }

  function setPalette(name) {
    if (destroyed) return
    const next = PALETTES[name] ? name : 'ember'
    if (next === paletteName) return
    paletteName = next
    colors = paletteColors(next)
    atlas = renderAtlas(createCanvas, next, pixelRatio)
    // A state whose tier stopped the loop has nobody else to repaint it.
    if (frameHandle === null) draw()
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    stopLoop()
    documentRef?.removeEventListener?.('visibilitychange', handleVisibilityChange)
    ratioQuery?.removeEventListener?.('change', handleRatioChange)
    ratioQuery = null
    reducedMotionQuery?.removeEventListener?.('change', handleReducedMotionChange)
    reducedMotionQuery = null
    highContrastQuery?.removeEventListener?.('change', handleHighContrastChange)
    highContrastQuery = null
  }

  armRatioQuery()
  armAccessibilityQueries()
  // Hooked up in either mode: a static orb can become animated mid-session, and
  // the handler is a no-op while nothing is scheduled anyway.
  documentRef?.addEventListener?.('visibilitychange', handleVisibilityChange)
  applyMode()

  return {
    setState,
    setLevel,
    setPalette,
    setAccessibility,
    interrupt,
    destroy,
    get state() { return stateName },
    get params() { return params },
    get palette() { return paletteName },
    get level() { return level },
    get smoothedLevel() { return levelSmoothed },
    get fps() { return staticMode ? 0 : STATE_FPS[stateName] },
    get particleCount() { return Math.min(activeMax, total) },
  }
}

// Every method of the real API, doing nothing: the orb is decoration, and a
// renderer whose canvas is unusable still has a socket, a drag handle, a state
// label, and an aria contract to keep serving.
function createNoopVisual() {
  return Object.freeze({
    setState() {},
    setLevel() {},
    setPalette() {},
    setAccessibility() {},
    interrupt() {},
    destroy() {},
    get state() { return DEFAULT_STATE },
    get params() { return STATE_PARAMS[DEFAULT_STATE] },
    get palette() { return 'ember' },
    get level() { return 0 },
    get smoothedLevel() { return 0 },
    get fps() { return 0 },
    get particleCount() { return 0 },
  })
}

// The constructor the renderer actually uses. Two failures are contained here:
// a visual that cannot be built at all, and a live one whose first throw would
// otherwise escape into a caller that has no business handling it — render(), or
// the awaited socket-message tail, where one exception poisons the queue.
//
// The trade is deliberately total and one-way: the orb goes away, permanently,
// and the renderer keeps running. A canvas that threw once will throw again
// every frame, so retrying it would only turn one warning into a flood.
export function createOrbVisualSafe(canvas, options = {}) {
  const noop = createNoopVisual()
  let warned = false
  function warn(error) {
    if (warned) return
    warned = true
    globalThis.console?.warn?.(
      `nova orb: the particle visual is disabled (${error?.message || error})`,
    )
  }

  let target
  try {
    target = createOrbVisual(canvas, options)
  } catch (error) {
    warn(error)
    return noop
  }

  function disable(error) {
    if (target === noop) return
    const broken = target
    target = noop
    warn(error)
    // Tear the broken visual down so its loop and listeners stop too.
    try { broken.destroy() } catch { /* it is already past helping */ }
  }

  function guard(name) {
    return (...args) => {
      try {
        return target[name](...args)
      } catch (error) {
        disable(error)
        return undefined
      }
    }
  }

  return Object.freeze({
    setState: guard('setState'),
    setLevel: guard('setLevel'),
    setPalette: guard('setPalette'),
    setAccessibility: guard('setAccessibility'),
    interrupt: guard('interrupt'),
    destroy: guard('destroy'),
    get state() { return target.state },
    get params() { return target.params },
    get palette() { return target.palette },
    get level() { return target.level },
    get smoothedLevel() { return target.smoothedLevel },
    get fps() { return target.fps },
    get particleCount() { return target.particleCount },
  })
}
