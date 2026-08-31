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

// Amplitude envelopes, one pair per pulse direction. All four numbers are
// exponential time constants — one constant covers 1 - e^-1 = 63.2% of the
// remaining distance. Speaking (outward) keeps the fast pair: a syllable has
// to land on the field immediately, but must not flicker back to nothing
// before the next one. Listening (inward) is an acknowledgment, not a meter:
// the slow pair holds a gentle contraction across word gaps (200-400 ms)
// instead of releasing at syllable rate, and relaxes over ~1.5 s of silence.
const LEVEL_ATTACK_MS = 40
const LEVEL_DECAY_MS = 220
const LISTEN_ATTACK_MS = 140
const LISTEN_DECAY_MS = 480

const MAX_FRAME_MS = 50
const FIRST_FRAME_MS = 16
// rAF timestamps never land exactly on a tier boundary; without this a 16.7 ms
// display would skip every other 30 fps frame and halve the tier.
const TICK_SLACK_MS = 1

// Slow tiers sleep out their whole interval on a cancelable timer and only
// then take a rAF to align the draw with the compositor: rescheduling rAF
// every display refresh would wake JavaScript 60-120 times a second to draw
// ten frames, which is exactly the cost the low tiers exist to avoid. Timers
// fire at-or-after their delay, so the aligning rAF lands past the deadline
// and draws first try; the cadence runs about half a display frame slow,
// which a ten-fps nebula cannot show. Tiers under this interval stay on pure
// rAF — there the sleep would be shorter than a display frame anyway.
const TIMER_TIER_MS = 40

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
const ROW_ALERT_DEEP = 7
const ROW_DIM_DEEP = 8
const ROW_COUNT = 9

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
  errorDeep: '#A8434F',
  inactive: '#938878',
  inactiveDeep: '#57524A',
  ringAlert: 'rgba(255, 106, 106, .3)',
})

const H_ALPHA = Object.freeze({
  core: '#C87986',
  highlight: '#E7B5BE',
  deep: '#874857',
  dust: '#6B4055',
  dustAlpha: 0.24,
  abyss: 'rgba(7, 5, 10, .95)',
  mantle: 'rgba(29, 15, 23, .9)',
  bloom: 'rgba(86, 39, 52, .74)',
  bloomOffset: 0.1,
  haze: Object.freeze([
    Object.freeze({ x: -0.28, y: -0.25, radius: 0.6, color: '#9C5362', alpha: 0.18 }),
    Object.freeze({ x: 0.3, y: 0.2, radius: 0.53, color: '#68465F', alpha: 0.14 }),
    Object.freeze({ x: 0.08, y: 0.36, radius: 0.42, color: '#35465E', alpha: 0.1 }),
  ]),
  vignette: '#020205',
  rim: 'rgba(231, 181, 190, .11)',
  ring: 'rgba(231, 181, 190, .2)',
  codexBand: '#DCADB6',
  error: '#FF5A5A',
  errorDeep: '#A8434F',
  inactive: '#93878D',
  inactiveDeep: '#595057',
  ringAlert: 'rgba(255, 106, 106, .3)',
})

const ION = Object.freeze({
  core: '#7F9FC5',
  highlight: '#C5D8EE',
  deep: '#456487',
  dust: '#40526C',
  dustAlpha: 0.24,
  abyss: 'rgba(4, 6, 11, .95)',
  mantle: 'rgba(13, 21, 34, .9)',
  bloom: 'rgba(42, 66, 94, .74)',
  bloomOffset: 0.1,
  haze: Object.freeze([
    Object.freeze({ x: -0.29, y: -0.25, radius: 0.61, color: '#52769D', alpha: 0.18 }),
    Object.freeze({ x: 0.31, y: 0.2, radius: 0.53, color: '#405A78', alpha: 0.15 }),
    Object.freeze({ x: 0.07, y: 0.37, radius: 0.43, color: '#51536E', alpha: 0.1 }),
  ]),
  vignette: '#010205',
  rim: 'rgba(197, 216, 238, .11)',
  ring: 'rgba(197, 216, 238, .2)',
  codexBand: '#AFC8E2',
  error: '#FF5A5A',
  errorDeep: '#A8434F',
  inactive: '#87919E',
  inactiveDeep: '#505965',
  ringAlert: 'rgba(255, 106, 106, .3)',
})

const VIOLET = Object.freeze({
  core: '#9181A7',
  highlight: '#D3C7DF',
  deep: '#5F5079',
  dust: '#514560',
  dustAlpha: 0.24,
  abyss: 'rgba(6, 5, 11, .95)',
  mantle: 'rgba(21, 17, 31, .9)',
  bloom: 'rgba(59, 48, 79, .74)',
  bloomOffset: 0.1,
  haze: Object.freeze([
    Object.freeze({ x: -0.29, y: -0.25, radius: 0.61, color: '#6F5F88', alpha: 0.18 }),
    Object.freeze({ x: 0.31, y: 0.21, radius: 0.53, color: '#584A70', alpha: 0.14 }),
    Object.freeze({ x: 0.07, y: 0.37, radius: 0.43, color: '#3D506B', alpha: 0.1 }),
  ]),
  vignette: '#020105',
  rim: 'rgba(211, 199, 223, .11)',
  ring: 'rgba(211, 199, 223, .2)',
  codexBand: '#C2B4D1',
  error: '#FF5A5A',
  errorDeep: '#A8434F',
  inactive: '#8C8794',
  inactiveDeep: '#55515C',
  ringAlert: 'rgba(255, 106, 106, .3)',
})

const GRAPHITE = Object.freeze({
  core: '#C7CED8',
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
  error: '#FF5A5A',
  errorDeep: '#A8434F',
  inactive: '#98A0AB',
  inactiveDeep: '#5E6774',
  ringAlert: 'rgba(255, 106, 106, .3)',
})

const PALETTES = Object.freeze({
  ember: EMBER,
  halpha: H_ALPHA,
  ion: ION,
  violet: VIOLET,
  graphite: GRAPHITE,
})

export const ORB_PALETTE_NAMES = Object.freeze(Object.keys(PALETTES))

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
  // Multiplier on the twinkle phase advance only. Orbit and wobble already
  // scale per state through orbitSpeed and jitter; twinkle is the one motion
  // that would otherwise shimmer at full rate in any live tier.
  twinkleSpeed = 1,
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
    twinkleSpeed,
  })
}

const LISTENING = stateParams({
  convergence: 0.8,
  orbitSpeed: 0.1,
  jitter: 0.1,
  pulseGain: 0.45,
  pulseDirection: -1,
  alpha: 1,
  countRatio: 1,
})

const BARGE_IN_SCATTER = 1

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
    alpha: 0.6,
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
    alpha: 0.5,
    // Must stay below 0.5: the resting field is defined as visibly thinner
    // than half of idle's.
    countRatio: 0.45,
    tone: 'dim',
    // The resting nebula drifts: a 50 s orbit with an occasional faint glint,
    // not idle's live sparkle — slow enough to read as asleep, alive enough
    // not to read as a screenshot.
    twinkleSpeed: 0.35,
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
  // A deliberate mute: collapsed like the terminal family so it reads as
  // "not receiving", but dim-toned and mid-sized — the user chose this, so it
  // must not borrow the alert red. It keeps moving at the tier it resumes
  // into: a muted session is still a live session, only unfed.
  muted: stateParams({
    convergence: 0.75,
    orbitSpeed: 0.03,
    jitter: 0.04,
    pulseGain: 0,
    alpha: 0.6,
    countRatio: 0.6,
    ringRadius: 32,
    tone: 'dim',
  }),
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
// display rate for a field that is barely moving — inactive gets its own low
// tier for a 50 s orbit — and a dead session must not pay anything at all:
// zero means one static frame with the loop stopped.
export const STATE_FPS = Object.freeze({
  speaking: 60,
  listening: 60,
  candidate: 30,
  booting: 30,
  idle: 15,
  // A muted session is live, only unfed: it keeps the tier it resumes into.
  muted: 15,
  inactive: 10,
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
      // Toned states draw from explicit dim/alert hexes in two depth tiers
      // (ROW_ALERT/ROW_DIM plus the _DEEP rows): the hexes are picked bright
      // enough to survive the state's own alpha over the dark plate, and the
      // deep tier keeps the far field from collapsing into one flat colour.
      [colors.inactive, 1],
      [colors.errorDeep, 1],
      [colors.inactiveDeep, 1],
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
    [colors.errorDeep, 1],
    [colors.inactiveDeep, 1],
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
    timer,
    cancelTimer,
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
  const wait = timer
    || ((callback, delayMs) => globalThis.setTimeout(callback, delayMs))
  const cancelWait = cancelTimer
    || (handle => globalThis.clearTimeout(handle))
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
  let paletteTransition = null

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
  let twinkleClock = 0
  let codexPhase = 0
  let frameHandle = null
  let timerHandle = null
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
    // States without a pulse absorb no amplitude: while idle/candidate watch
    // the microphone the envelope drains instead of precharging at speaking
    // speed, so listening's calm attack actually plays on the normal onset
    // path (idle → candidate → listening) rather than starting saturated.
    const nextLevel = params.pulseGain === 0 ? 0 : levelTarget()
    // Inward listening pulses take the calm envelope; outward speaking pulses
    // keep the fast one. Keyed off the
    // *smoothed* pulse, not the target state: during a speaking→listening
    // transition the rendered pulse stays outward for ~200 ms, and leftover
    // outward energy must drain at speaking speed rather than be held by the
    // slow envelope in the wrong direction.
    const calm = pulse < 0
    levelSmoothed = approach(
      levelSmoothed,
      nextLevel,
      elapsedMs,
      nextLevel > levelSmoothed
        ? (calm ? LISTEN_ATTACK_MS : LEVEL_ATTACK_MS)
        : (calm ? LISTEN_DECAY_MS : LEVEL_DECAY_MS),
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
    // Twinkle keeps its own clock so a state can slow the shimmer without
    // touching the wobble. A rate change is continuous in the output — the
    // clock keeps its value and only advances slower — so unlike the eased
    // parameters above it can read the target state directly.
    twinkleClock += (elapsedMs / 1000) * params.twinkleSpeed
    codexPhase += CODEX_ORBIT_SPEED * (elapsedMs / 1000) * TAU
    if (codexPhase > TAU) codexPhase -= TAU
  }

  function blitFrom(sourceAtlas, row, size, x, y, spriteAlpha) {
    const half = SPRITE_SIZES[size] / 2
    context.globalAlpha = spriteAlpha
    context.drawImage(
      sourceAtlas.canvas,
      sourceAtlas.columnOffsets[size],
      row * sourceAtlas.rowHeight,
      sourceAtlas.columnWidths[size],
      sourceAtlas.columnWidths[size],
      x - half,
      y - half,
      SPRITE_SIZES[size],
      SPRITE_SIZES[size],
    )
  }

  function blit(row, size, x, y, spriteAlpha) {
    if (!paletteTransition) {
      blitFrom(atlas, row, size, x, y, spriteAlpha)
      return
    }
    const progress = paletteTransition.progress
    blitFrom(atlas, row, size, x, y, spriteAlpha * (1 - progress))
    blitFrom(paletteTransition.atlas, row, size, x, y, spriteAlpha * progress)
  }

  function drawPlate(sourceAtlas, opacity) {
    context.globalAlpha = opacity
    context.drawImage(
      sourceAtlas.canvas,
      0,
      sourceAtlas.plateTop,
      sourceAtlas.plateSize,
      sourceAtlas.plateSize,
      0,
      0,
      ORB_SIZE,
      ORB_SIZE,
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
    if (paletteTransition) {
      drawPlate(atlas, 1 - paletteTransition.progress)
      drawPlate(paletteTransition.atlas, paletteTransition.progress)
    } else {
      drawPlate(atlas, 1)
    }

    if (ringOpacity > 0.01) {
      const strokeRing = (ringColors, opacity) => {
        context.globalAlpha = opacity
        context.strokeStyle = params.tone === 'alert' ? ringColors.ringAlert : ringColors.ring
        context.lineWidth = 1.5
        context.beginPath()
        // The smoothed target radius, not a constant: each terminal state
        // collapses onto its own ring, and the stroke has to sit under the
        // particles rather than at one fixed radius they no longer share.
        context.arc(CENTER, CENTER, targetRadius, 0, TAU)
        context.stroke()
      }
      if (paletteTransition) {
        strokeRing(colors, ringOpacity * (1 - paletteTransition.progress))
        strokeRing(paletteTransition.colors, ringOpacity * paletteTransition.progress)
      } else {
        strokeRing(colors, ringOpacity)
      }
      context.globalAlpha = 1
    }

    context.globalCompositeOperation = 'lighter'

    const tone = params.tone
    // A toned state (alert/dim) keeps a near/far split instead of one flat
    // colour: the far field (homeRadius past 0.55) drops to the deep tier.
    const overrideRow = tone === 'alert' ? ROW_ALERT : tone === 'dim' ? ROW_DIM : -1
    const overrideDeepRow = tone === 'alert' ? ROW_ALERT_DEEP : tone === 'dim' ? ROW_DIM_DEEP : -1
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
        + 0.5 * Math.sin(twinkleClock * twinkleFrequency[index] + twinklePhase[index])
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
        overrideRow >= 0
          ? (homeRadius[index] > 0.55 ? overrideDeepRow : overrideRow)
          : tierRow[index],
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
    const effectiveFps = paletteTransition ? Math.max(15, fps) : fps
    return effectiveFps > 0 ? 1000 / effectiveFps : 0
  }

  function advancePaletteTransition(elapsedMs) {
    if (!paletteTransition) return
    paletteTransition.elapsedMs += elapsedMs
    paletteTransition.progress = Math.min(
      1,
      paletteTransition.elapsedMs / paletteTransition.durationMs,
    )
    if (paletteTransition.progress < 1) return
    const completed = paletteTransition
    paletteName = completed.name
    colors = completed.colors
    atlas = completed.atlas
    paletteTransition = null
    completed.onComplete?.()
  }

  function tick(timestamp) {
    if (destroyed) return
    const interval = tickIntervalMs()
    // A state that went static between two frames stops here rather than
    // rescheduling; setState already drew its single frame.
    if (interval === 0) {
      stopLoop()
      return
    }
    if (lastTimestamp >= 0 && timestamp - lastTimestamp + TICK_SLACK_MS < interval) {
      // An early landing on a slow tier goes back to sleep for the remainder
      // rather than hopping vsync to vsync until the deadline passes — on a
      // 144 Hz display those hops would triple the wakeups the sleep exists
      // to avoid.
      if (interval >= TIMER_TIER_MS) armWait(Math.max(1, interval - (timestamp - lastTimestamp)))
      else frameHandle = schedule(tick)
      return
    }
    const rawElapsedMs = lastTimestamp < 0 ? FIRST_FRAME_MS : Math.max(0, timestamp - lastTimestamp)
    const elapsedMs = lastTimestamp < 0
      ? FIRST_FRAME_MS
      // The stall guard has to leave room for the slowest tier's own interval,
      // or a 15 fps field would animate a quarter slower than wall clock.
      : Math.min(Math.max(MAX_FRAME_MS, interval * 2), Math.max(0, timestamp - lastTimestamp))
    lastTimestamp = timestamp
    const startedAt = clock()
    advancePaletteTransition(rawElapsedMs)
    advance(elapsedMs)
    draw()
    sampleFrameCost(clock() - startedAt)
    if (interval >= TIMER_TIER_MS) armWait(interval)
    else frameHandle = schedule(tick)
  }

  // Sleep off-rAF, then take one frame to align the next draw with the
  // compositor.
  function armWait(delayMs) {
    frameHandle = null
    let firedInline = false
    const handle = wait(() => {
      firedInline = true
      timerHandle = null
      if (destroyed) return
      frameHandle = schedule(tick)
    }, delayMs)
    // An injected test timer may run its callback synchronously; a handle
    // stored after that would outlive the wait it names.
    if (!firedInline) timerHandle = handle
  }

  function stopLoop() {
    if (timerHandle !== null) {
      cancelWait(timerHandle)
      timerHandle = null
    }
    if (frameHandle === null) return
    unschedule(frameHandle)
    frameHandle = null
  }

  function startLoop() {
    if (destroyed || staticMode || hidden) return
    if (frameHandle !== null || timerHandle !== null) return
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
      // A state change must not sit out a slow tier's pending wait: activating
      // from inactive expects its first frame now, not up to 100 ms from now.
      if (timerHandle !== null) stopLoop()
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

  // A one-shot barge-in impulse over whatever truthful state is on screen.
  // It never changes the state vocabulary; the renderer owns the playback clear
  // and this visual owns only its short-lived acknowledgement.
  function interrupt() {
    if (destroyed) return
    scatter = BARGE_IN_SCATTER
    if (!staticMode && tickIntervalMs() > 0) {
      // A running loop decays the impulse; a hidden orb picks it up on resume.
      // A slow tier's pending wait is cancelled first — a barge-in impulse
      // that lands 84 ms late is not an impulse.
      if (timerHandle !== null) stopLoop()
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
    if (paletteTransition) {
      paletteTransition.atlas = renderAtlas(createCanvas, paletteTransition.name, pixelRatio)
    }
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
    if (next === paletteName && !paletteTransition) return
    paletteTransition = null
    paletteName = next
    colors = paletteColors(next)
    atlas = renderAtlas(createCanvas, next, pixelRatio)
    // A state whose tier stopped the loop has nobody else to repaint it.
    if (frameHandle === null) draw()
  }

  function transitionPalette(name, { durationMs = 6000, onComplete } = {}) {
    if (destroyed) return
    const next = PALETTES[name] ? name : 'ember'
    if (staticMode || next === paletteName || !Number.isFinite(durationMs) || durationMs <= 0) {
      setPalette(next)
      onComplete?.()
      return
    }
    paletteTransition = {
      name: next,
      colors: paletteColors(next),
      atlas: renderAtlas(createCanvas, next, pixelRatio),
      durationMs,
      elapsedMs: 0,
      progress: 0,
      onComplete,
    }
    if (timerHandle !== null) stopLoop()
    startLoop()
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    paletteTransition = null
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
    transitionPalette,
    setAccessibility,
    interrupt,
    destroy,
    get state() { return stateName },
    get params() { return params },
    get palette() { return paletteName },
    get transitioning() { return paletteTransition !== null },
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
    transitionPalette(name, { onComplete } = {}) { onComplete?.() },
    setAccessibility() {},
    interrupt() {},
    destroy() {},
    get state() { return DEFAULT_STATE },
    get params() { return STATE_PARAMS[DEFAULT_STATE] },
    get palette() { return 'ember' },
    get transitioning() { return false },
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
    transitionPalette: guard('transitionPalette'),
    setAccessibility: guard('setAccessibility'),
    interrupt: guard('interrupt'),
    destroy: guard('destroy'),
    get state() { return target.state },
    get params() { return target.params },
    get palette() { return target.palette },
    get transitioning() { return target.transitioning },
    get level() { return target.level },
    get smoothedLevel() { return target.smoothedLevel },
    get fps() { return target.fps },
    get particleCount() { return target.particleCount },
  })
}
