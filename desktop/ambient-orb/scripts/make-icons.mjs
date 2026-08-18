// Icon generator for the ambient orb.
//
// The orb's identity is a field of amber embers, not a glyph, so its icon is
// drawn rather than drawn *from* something: one seeded particle layout is shared
// by the committed SVG and by a tiny software rasterizer here, and every raster
// artifact the platforms want — tray PNGs, a Windows .ico, a macOS .icns, the
// linux icon directory — comes out of that single description.
//
// Two constraints shape the implementation. It has no dependencies (node core
// only: zlib for the PNG IDAT stream, and iconutil, when macOS offers it, for
// the .icns container), and it is deterministic: the layout comes from a fixed
// mulberry32 seed, the PNGs carry no timestamp chunk, and two runs on one
// machine produce byte-identical files. That is what lets `resources/`
// artifacts be committed and reviewed as content instead of as opaque binaries
// that churn every build.
//
// The determinism stops at the compressor, deliberately. Node's bundled zlib
// deflates the same pixels to different bytes across releases (1.2.12 and 1.3.1
// disagree), so the committed PNGs are only byte-stable for a given zlib —
// which is why the test suite compares decoded pixels rather than files.

import { deflateSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { mulberry32 } from '../src/renderer/orb-visual.mjs'

const TAU = Math.PI * 2

// The full ladder every other artifact is cut from.
export const ICON_SIZES = Object.freeze([16, 22, 24, 32, 48, 64, 128, 256, 512])
// What Windows shells actually sample from an .ico.
export const ICO_SIZES = Object.freeze([16, 32, 48, 256])
// macOS menu bar, the GTK/Ayatana status area, and the Windows notification area.
export const TRAY_SIZES = Object.freeze([16, 22, 32])

// The mark is authored in a unit square so one description serves a 16px tray
// glyph and a 512px app icon without a second set of numbers.
const PLATE_COLOR = '#141005'
const PLATE_CORNER = 0.22

const EMBER_HIGHLIGHT = '#FFE3B3'
const EMBER_CORE = '#FFB454'
const EMBER_DEEP = '#C96F2B'
const CODEX_BAND = '#FFD9A0'

// Same seed the renderer's field uses, so the icon is a still of the same orb.
const LAYOUT_SEED = 0x6f7262
const FIELD_RADIUS = 0.335
const CORE_COUNT = 12
const MID_COUNT = 12
const OUTER_COUNT = 12

const BAND = Object.freeze({
  radius: 0.4,
  width: 0.021,
  startDeg: 118,
  endDeg: 238,
  color: CODEX_BAND,
})

// A dot thinner than this vanishes into a single faint subpixel, which is how a
// particle mark turns into an empty dark tile at tray sizes.
const MIN_DOT_PX = 0.75
const MIN_BAND_PX = 1
// Supersampling is the whole anti-aliasing story: 16 in/out samples per pixel,
// identical for discs, the rounded plate, and the arc's angular cut-offs, and
// free of the per-shape distance-field special cases an analytic version needs.
const SAMPLES_PER_AXIS = 4
const SAMPLE_COUNT = SAMPLES_PER_AXIS * SAMPLES_PER_AXIS
// Solid to 62% of the radius, then a smooth shoulder: an ember with an edge.
const DOT_SOLID = 0.62

function parseHex(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

function round(value, places = 2) {
  const factor = 10 ** places
  // `+ 0` collapses -0, which would otherwise reach the SVG as "-0".
  return Math.round(value * factor) / factor + 0
}

// The one place the layout exists. Everything downstream — SVG, rasterizer,
// every size — reads this, so the committed vector file and the committed tray
// PNGs cannot drift apart.
export function markShapes() {
  const random = mulberry32(LAYOUT_SEED)
  const dots = []

  // A denser, hotter core: the part that still reads as "lit" at 16px.
  for (let index = 0; index < CORE_COUNT; index += 1) {
    const radius = 0.34 * Math.sqrt(random()) * FIELD_RADIUS
    const angle = random() * TAU
    dots.push({
      tier: 0,
      x: 0.5 + Math.cos(angle) * radius,
      y: 0.5 + Math.sin(angle) * radius,
      r: 0.017 + 0.011 * random(),
      color: EMBER_HIGHLIGHT,
    })
  }

  // Two shells over it. Angles are stratified rather than uniform: twelve free
  // draws clump, and a clumped shell reads as a smear instead of a field.
  const shell = (count, tier, inner, span, sizeBase, sizeSpread, pick) => {
    for (let index = 0; index < count; index += 1) {
      const radius = (inner + span * random()) * FIELD_RADIUS
      const angle = ((index + random()) / count) * TAU
      dots.push({
        tier,
        x: 0.5 + Math.cos(angle) * radius,
        y: 0.5 + Math.sin(angle) * radius,
        r: sizeBase + sizeSpread * random(),
        color: pick(random()),
      })
    }
  }
  shell(MID_COUNT, 1, 0.46, 0.26, 0.021, 0.01, () => EMBER_CORE)
  // A quarter of the outer shell stays highlight-bright, so the shell is a mix
  // of all three ember tones rather than a flat brown ring.
  shell(OUTER_COUNT, 2, 0.78, 0.22, 0.016, 0.011, value => (
    value < 0.25 ? EMBER_HIGHLIGHT : EMBER_DEEP
  ))

  // Painted outer shell first, core last, so the brightest embers sit on top.
  dots.sort((a, b) => b.tier - a.tier)
  return { plate: { color: PLATE_COLOR, corner: PLATE_CORNER }, band: BAND, dots }
}

function insideRoundedSquare(x, y, size, corner) {
  const clampedX = Math.min(Math.max(x, corner), size - corner)
  const clampedY = Math.min(Math.max(y, corner), size - corner)
  const dx = x - clampedX
  const dy = y - clampedY
  return dx * dx + dy * dy <= corner * corner
}

// Angles run clockwise from +x with y down, matching how the SVG path is built.
function insideSector(angle, start, end) {
  const span = (end - start + TAU) % TAU
  const relative = (angle - start + TAU) % TAU
  return relative <= span
}

function smoothstep(value) {
  const t = Math.min(1, Math.max(0, value))
  return t * t * (3 - 2 * t)
}

// Non-premultiplied source-over, one pixel at a time. The buffer starts fully
// transparent, so the plate establishes the alpha and the embers land on it.
function composite(rgba, offset, red, green, blue, alpha) {
  if (alpha <= 0) return
  const destinationAlpha = rgba[offset + 3] / 255
  const outAlpha = alpha + destinationAlpha * (1 - alpha)
  if (outAlpha <= 0) return
  const weight = destinationAlpha * (1 - alpha)
  rgba[offset] = Math.round((red * alpha + rgba[offset] * weight) / outAlpha)
  rgba[offset + 1] = Math.round((green * alpha + rgba[offset + 1] * weight) / outAlpha)
  rgba[offset + 2] = Math.round((blue * alpha + rgba[offset + 2] * weight) / outAlpha)
  rgba[offset + 3] = Math.round(outAlpha * 255)
}

// `sample(x, y)` answers how much of one sub-pixel sample the shape covers, in
// 0..1; the caller only pays for pixels inside `box`.
function paint(rgba, size, box, color, sample) {
  const [red, green, blue] = parseHex(color)
  const minX = Math.max(0, Math.floor(box.minX))
  const maxX = Math.min(size - 1, Math.ceil(box.maxX))
  const minY = Math.max(0, Math.floor(box.minY))
  const maxY = Math.min(size - 1, Math.ceil(box.maxY))
  const step = 1 / SAMPLES_PER_AXIS
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let total = 0
      for (let sy = 0; sy < SAMPLES_PER_AXIS; sy += 1) {
        const py = y + (sy + 0.5) * step
        for (let sx = 0; sx < SAMPLES_PER_AXIS; sx += 1) {
          total += sample(x + (sx + 0.5) * step, py)
        }
      }
      if (total > 0) composite(rgba, (y * size + x) * 4, red, green, blue, total / SAMPLE_COUNT)
    }
  }
}

// The mark at one pixel size, as a raw RGBA buffer.
export function renderMark(size) {
  const { plate, band, dots } = markShapes()
  const rgba = Buffer.alloc(size * size * 4)
  const whole = { minX: 0, minY: 0, maxX: size, maxY: size }

  const corner = plate.corner * size
  paint(rgba, size, whole, plate.color, (x, y) => (
    insideRoundedSquare(x, y, size, corner) ? 1 : 0
  ))

  // The band sits under the particles, the way the renderer strokes its ring
  // beneath the field. Its bounding box is the outside of the annulus, which
  // also contains both round caps — they are centred on the circle itself.
  const bandRadius = band.radius * size
  const bandHalf = Math.max(band.width * size, MIN_BAND_PX) / 2
  const start = (band.startDeg / 360) * TAU
  const end = (band.endDeg / 360) * TAU
  const caps = [start, end].map(angle => ({
    x: size / 2 + Math.cos(angle) * bandRadius,
    y: size / 2 + Math.sin(angle) * bandRadius,
  }))
  const bandBox = bandRadius + bandHalf
  paint(rgba, size, {
    minX: size / 2 - bandBox,
    maxX: size / 2 + bandBox,
    minY: size / 2 - bandBox,
    maxY: size / 2 + bandBox,
  }, band.color, (x, y) => {
    const dx = x - size / 2
    const dy = y - size / 2
    const distance = Math.hypot(dx, dy)
    if (
      Math.abs(distance - bandRadius) <= bandHalf
      && insideSector(Math.atan2(dy, dx), start, end)
    ) return 1
    // Round caps, so the stroke ends the way the SVG's stroke-linecap does.
    for (const cap of caps) {
      if (Math.hypot(x - cap.x, y - cap.y) <= bandHalf) return 1
    }
    return 0
  })

  for (const dot of dots) {
    const centerX = dot.x * size
    const centerY = dot.y * size
    const radius = Math.max(dot.r * size, MIN_DOT_PX)
    paint(rgba, size, {
      minX: centerX - radius,
      maxX: centerX + radius,
      minY: centerY - radius,
      maxY: centerY + radius,
    }, dot.color, (x, y) => {
      const normalized = Math.hypot(x - centerX, y - centerY) / radius
      if (normalized <= DOT_SOLID) return 1
      if (normalized >= 1) return 0
      return smoothstep((1 - normalized) / (1 - DOT_SOLID))
    })
  }

  return rgba
}

// The committed vector source, emitted from the same layout so the SVG's
// coordinates are literals a reviewer can read while still being provably the
// same mark the rasters show.
export function markSvg(size = 512) {
  const { plate, band, dots } = markShapes()
  const center = size / 2
  const bandRadius = band.radius * size
  const point = degrees => {
    const angle = (degrees / 360) * TAU
    return `${round(center + Math.cos(angle) * bandRadius)} ${round(center + Math.sin(angle) * bandRadius)}`
  }
  const sweep = (band.endDeg - band.startDeg + 360) % 360
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Generated by scripts/make-icons.mjs. Run `npm run icons` to regenerate. -->',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Nova Audio Agent ambient orb">`,
    '  <title>Nova Audio Agent ambient orb</title>',
    `  <rect width="${size}" height="${size}" rx="${round(plate.corner * size)}" fill="${plate.color}"/>`,
    `  <path d="M${point(band.startDeg)} A${round(bandRadius)} ${round(bandRadius)} 0 ${sweep > 180 ? 1 : 0} 1 ${point(band.endDeg)}" fill="none" stroke="${band.color}" stroke-width="${round(band.width * size)}" stroke-linecap="round"/>`,
  ]
  // Grouped by colour: three short groups instead of a circle-per-fill wall.
  for (const color of [EMBER_DEEP, EMBER_CORE, EMBER_HIGHLIGHT]) {
    const group = dots.filter(dot => dot.color === color)
    if (group.length === 0) continue
    lines.push(`  <g fill="${color}">`)
    for (const dot of group) {
      lines.push(`    <circle cx="${round(dot.x * size)}" cy="${round(dot.y * size)}" r="${round(dot.r * size)}"/>`)
    }
    lines.push('  </g>')
  }
  lines.push('</svg>')
  return `${lines.join('\n')}\n`
}

let crcTable = null

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      crcTable[index] = value
    }
  }
  let crc = -1
  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}

// Signature, IHDR, one IDAT, IEND — and deliberately nothing else. A tIME or
// pHYs chunk would be the easiest way to lose reproducibility.
export function encodePng(size, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolour with alpha
  header[10] = 0 // deflate
  header[11] = 0 // adaptive filtering
  header[12] = 0 // no interlace

  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    // Filter type 0 (None) per row: the mark compresses well enough on its own
    // that a filter search would only cost determinism-review surface.
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ICONDIR, then one ICONDIRENTRY per image, then the PNG blobs. Windows reads
// PNG-format entries from Vista on, so there is no BMP/AND-mask path here.
export function encodeIco(entries) {
  const directory = Buffer.alloc(6 + entries.length * 16)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(entries.length, 4)
  let offset = directory.length
  for (const [index, entry] of entries.entries()) {
    const at = 6 + index * 16
    // 256 is stored as 0: the field is one byte, and 256 & 0xff is already 0,
    // but writing it explicitly is the difference between a documented
    // convention and an accident that happens to work.
    directory[at] = entry.size >= 256 ? 0 : entry.size
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size
    directory[at + 2] = 0 // no palette
    directory[at + 3] = 0 // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  }
  return Buffer.concat([directory, ...entries.map(entry => entry.png)])
}

// The .iconset layout iconutil expects. 512@2x would need a 1024px render that
// nothing else wants, so the ladder stops at a plain 512.
const ICONSET_ENTRIES = Object.freeze([
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
])

function defaultRunIconutil({ iconset, output }) {
  const result = spawnSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', output], {
    encoding: 'utf8',
  })
  if (result.error) return { ok: false, reason: result.error.message }
  if (result.status !== 0) return { ok: false, reason: (result.stderr || '').trim() || `exit ${result.status}` }
  return { ok: true }
}

function outputPaths(outputDir, { icns }) {
  return {
    svg: resolve(outputDir, 'resources/icon.svg'),
    tray: TRAY_SIZES.map(size => resolve(outputDir, `resources/tray/tray-${size}.png`)),
    icons: ICON_SIZES.map(size => resolve(outputDir, `build/icons/${size}x${size}.png`)),
    ico: resolve(outputDir, 'build/icon.ico'),
    icns: icns ? resolve(outputDir, 'build/icon.icns') : null,
  }
}

async function allPresent(paths) {
  const files = [paths.svg, ...paths.tray, ...paths.icons, paths.ico, paths.icns].filter(Boolean)
  for (const file of files) {
    // readFile, not existsSync: a zero-byte or unreadable leftover from an
    // interrupted run must count as missing, not as "already generated".
    try {
      const bytes = await readFile(file)
      if (bytes.length === 0) return false
    } catch {
      return false
    }
  }
  return true
}

export async function makeIcons({
  outputDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  icns = process.platform === 'darwin',
  ifMissing = false,
  runIconutil = defaultRunIconutil,
  log = line => process.stdout.write(`${line}\n`),
} = {}) {
  const paths = outputPaths(outputDir, { icns })
  if (ifMissing && await allPresent(paths)) {
    log('ambient-orb icons are already generated')
    return { skipped: true, written: [] }
  }

  const written = []
  const write = async (file, bytes) => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes)
    written.push(file)
  }

  // One render per size, reused by every container that wants it.
  const pngs = new Map(ICON_SIZES.map(size => [size, encodePng(size, renderMark(size))]))

  await write(paths.svg, markSvg())
  for (const [index, size] of TRAY_SIZES.entries()) await write(paths.tray[index], pngs.get(size))
  for (const [index, size] of ICON_SIZES.entries()) await write(paths.icons[index], pngs.get(size))
  await write(paths.ico, encodeIco(ICO_SIZES.map(size => ({ size, png: pngs.get(size) }))))

  if (paths.icns) {
    // The iconset is scratch: iconutil wants a directory of exactly-named PNGs,
    // and nothing downstream should ever find one sitting in build/. The
    // directory itself must end in `.iconset` or iconutil refuses it outright,
    // hence the nested name inside the temporary parent.
    const scratch = await mkdtemp(join(tmpdir(), 'nova-iconset-'))
    const iconset = join(scratch, 'icon.iconset')
    try {
      await mkdir(iconset)
      await Promise.all(ICONSET_ENTRIES.map(
        ([name, size]) => writeFile(join(iconset, name), pngs.get(size)),
      ))
      const result = await runIconutil({ iconset, output: paths.icns })
      if (result?.ok) written.push(paths.icns)
      else log(`ambient-orb icons: skipping icns (${result?.reason || 'iconutil failed'})`)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  log(`ambient-orb icons: wrote ${written.length} files`)
  return { skipped: false, written }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await makeIcons({ ifMissing: process.argv.includes('--if-missing') })
}
