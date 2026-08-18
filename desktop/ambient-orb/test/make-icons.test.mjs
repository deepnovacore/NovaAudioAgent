import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  ICO_SIZES,
  ICON_SIZES,
  TRAY_SIZES,
  makeIcons,
  markSvg,
} from '../scripts/make-icons.mjs'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// A PNG is only "valid" here if the bytes say so: signature, then an IHDR whose
// declared geometry and colour type are the ones the generator promised. The
// generator writes its own encoder, so nothing else in the suite would catch a
// truncated chunk or a byte-order slip.
function readPngHeader(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE, 'PNG signature')
  assert.equal(bytes.readUInt32BE(8), 13, 'IHDR length')
  assert.equal(bytes.subarray(12, 16).toString('latin1'), 'IHDR')
  const header = {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    compression: bytes[26],
    filter: bytes[27],
    interlace: bytes[28],
  }
  // IEND is a whole chunk: zero-length, its type, and its (constant) CRC.
  assert.equal(bytes.subarray(bytes.length - 12).toString('latin1'), '\0\0\0\0IEND\xae\x42\x60\x82', 'IEND terminator')
  return header
}

// The pixels, recovered from the container. Every row is written with filter
// type 0, so undoing the encoding is inflate plus dropping one byte per row —
// which is exactly what lets the committed-artifact test below compare the
// *image* instead of the compressor's output.
function decodePng(bytes) {
  const header = readPngHeader(bytes)
  const parts = []
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    if (bytes.subarray(offset + 4, offset + 8).toString('latin1') === 'IDAT') {
      parts.push(bytes.subarray(offset + 8, offset + 8 + length))
    }
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(parts))
  const stride = header.width * 4
  assert.equal(raw.length, (stride + 1) * header.height, 'decompressed scanline count')
  const rgba = Buffer.alloc(stride * header.height)
  for (let y = 0; y < header.height; y += 1) {
    assert.equal(raw[y * (stride + 1)], 0, `row ${y} uses filter type 0`)
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { ...header, rgba }
}

function chunkTypes(bytes) {
  const types = []
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    types.push(bytes.subarray(offset + 4, offset + 8).toString('latin1'))
    offset += 12 + length
  }
  return types
}

async function generate(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nova-icons-'))
  const result = await makeIcons({
    outputDir: directory,
    icns: false,
    log: () => {},
    ...options,
  })
  return { directory, result }
}

test('every generated PNG carries a valid signature and its declared size', async t => {
  const { directory } = await generate()
  t.after(() => rm(directory, { recursive: true, force: true }))

  assert.deepEqual([...ICON_SIZES], [16, 22, 24, 32, 48, 64, 128, 256, 512])

  for (const size of ICON_SIZES) {
    const file = resolve(directory, `build/icons/${size}x${size}.png`)
    const bytes = await readFile(file)
    const header = readPngHeader(bytes)
    assert.equal(header.width, size, `${size}px width`)
    assert.equal(header.height, size, `${size}px height`)
    assert.equal(header.bitDepth, 8)
    assert.equal(header.colorType, 6, 'RGBA truecolour with alpha')
    assert.equal(header.compression, 0)
    assert.equal(header.filter, 0)
    assert.equal(header.interlace, 0)
    assert.deepEqual(chunkTypes(bytes), ['IHDR', 'IDAT', 'IEND'])
  }
})

test('electron-builder linux picks up the two sizes it needs', async t => {
  const { directory } = await generate()
  t.after(() => rm(directory, { recursive: true, force: true }))

  for (const size of [256, 512]) {
    const bytes = await readFile(resolve(directory, `build/icons/${size}x${size}.png`))
    assert.equal(readPngHeader(bytes).width, size)
  }
})

test('the ICO container indexes one PNG entry per windows size', async t => {
  const { directory } = await generate()
  t.after(() => rm(directory, { recursive: true, force: true }))

  assert.deepEqual([...ICO_SIZES], [16, 32, 48, 256])
  const ico = await readFile(resolve(directory, 'build/icon.ico'))

  assert.equal(ico.readUInt16LE(0), 0, 'ICONDIR reserved')
  assert.equal(ico.readUInt16LE(2), 1, 'ICONDIR type is icon')
  assert.equal(ico.readUInt16LE(4), ICO_SIZES.length, 'ICONDIR entry count')

  let expectedOffset = 6 + ICO_SIZES.length * 16
  for (const [index, size] of ICO_SIZES.entries()) {
    const entry = 6 + index * 16
    // 256 does not fit in a byte, so the format spells it 0 — the classic
    // way a hand-rolled ICO ends up with a 0x0 entry Windows refuses.
    const declared = size === 256 ? 0 : size
    assert.equal(ico[entry], declared, `entry ${size} width byte`)
    assert.equal(ico[entry + 1], declared, `entry ${size} height byte`)
    assert.equal(ico[entry + 2], 0, `entry ${size} palette size`)
    assert.equal(ico[entry + 3], 0, `entry ${size} reserved`)
    assert.equal(ico.readUInt16LE(entry + 4), 1, `entry ${size} colour planes`)
    assert.equal(ico.readUInt16LE(entry + 6), 32, `entry ${size} bit depth`)

    const bytesInRes = ico.readUInt32LE(entry + 8)
    const imageOffset = ico.readUInt32LE(entry + 12)
    assert.equal(imageOffset, expectedOffset, `entry ${size} image offset`)
    const png = ico.subarray(imageOffset, imageOffset + bytesInRes)
    const header = readPngHeader(png)
    assert.equal(header.width, size, `entry ${size} embedded PNG width`)
    assert.equal(header.height, size, `entry ${size} embedded PNG height`)
    expectedOffset += bytesInRes
  }
  assert.equal(expectedOffset, ico.length, 'the entry table accounts for every byte')
})

test('tray PNGs land at the three per-platform sizes, each with its retina double', async t => {
  const { directory } = await generate()
  t.after(() => rm(directory, { recursive: true, force: true }))

  assert.deepEqual([...TRAY_SIZES], [16, 22, 32])
  const trayDirectory = resolve(directory, 'resources/tray')
  assert.deepEqual(
    (await readdir(trayDirectory)).sort(),
    [
      'tray-16.png', 'tray-16@2x.png',
      'tray-22.png', 'tray-22@2x.png',
      'tray-32.png', 'tray-32@2x.png',
    ].sort(),
  )
  for (const size of TRAY_SIZES) {
    const base = readPngHeader(await readFile(resolve(trayDirectory, `tray-${size}.png`)))
    assert.equal(base.width, size)
    assert.equal(base.height, size)
    // Electron picks the @2x file up on its own from the base name, so it has
    // to be exactly double or a Retina menu bar gets a scaled, blurry icon.
    const retina = readPngHeader(await readFile(resolve(trayDirectory, `tray-${size}@2x.png`)))
    assert.equal(retina.width, size * 2)
    assert.equal(retina.height, size * 2)
  }
})

test('two generations are byte-identical', async t => {
  const first = await generate()
  const second = await generate()
  t.after(() => Promise.all([
    rm(first.directory, { recursive: true, force: true }),
    rm(second.directory, { recursive: true, force: true }),
  ]))

  const relative = first.result.written.map(file => file.slice(first.directory.length + 1)).sort()
  assert.deepEqual(
    second.result.written.map(file => file.slice(second.directory.length + 1)).sort(),
    relative,
  )
  assert.ok(relative.length > 0, 'the generator wrote something')
  for (const file of relative) {
    const [a, b] = await Promise.all([
      readFile(resolve(first.directory, file)),
      readFile(resolve(second.directory, file)),
    ])
    assert.deepEqual(a, b, `${file} is reproducible`)
  }
})

test('the mark renders as amber particles over a dark plate, not a gradient sphere', async t => {
  const { directory } = await generate()
  t.after(() => rm(directory, { recursive: true, force: true }))

  const svg = await readFile(resolve(directory, 'resources/icon.svg'), 'utf8')
  assert.equal(svg, markSvg(), 'the committed SVG is the generator output')
  assert.match(svg, /viewBox="0 0 512 512"/)
  assert.match(svg, /fill="#141005"/)
  for (const color of ['#FFB454', '#FFE3B3', '#C96F2B']) {
    assert.ok(svg.includes(color), `${color} particles are present`)
  }
  // Exactly one arc band, stroked — the codex-band motif, not a ring echo.
  const strokes = svg.match(/stroke="#FFD9A0"/g) || []
  assert.equal(strokes.length, 1, 'one arc band')
  assert.match(svg, /<path d="M[^"]*A[^"]*" fill="none" stroke="#FFD9A0"/)
  // No gradient sphere and no concentric-ring motif.
  assert.doesNotMatch(svg, /Gradient|<circle[^>]*fill="none"/)
  const dots = svg.match(/<circle /g) || []
  assert.ok(dots.length >= 24 && dots.length <= 40, `24-40 particle dots, got ${dots.length}`)
})

test('the raster mark keeps the plate opaque and the corners transparent', async t => {
  const { renderMark } = await import('../scripts/make-icons.mjs')
  const size = 64
  const rgba = renderMark(size)
  assert.equal(rgba.length, size * size * 4)

  const at = (x, y) => rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)
  assert.equal(at(0, 0)[3], 0, 'top-left corner is cut away by the rounded square')
  assert.equal(at(size - 1, size - 1)[3], 0, 'bottom-right corner too')
  assert.equal(at(size / 2, 2)[3], 255, 'the plate itself is opaque')

  // Somewhere in the core there must be a pixel far brighter than the plate.
  let brightest = 0
  for (let index = 0; index < rgba.length; index += 4) {
    brightest = Math.max(brightest, rgba[index])
  }
  assert.ok(brightest > 200, `amber particles light the field, got ${brightest}`)
})

test('the icns step drives iconutil over a full iconset and is skippable', async t => {
  const calls = []
  const { directory } = await generate({
    icns: true,
    runIconutil: async ({ iconset, output }) => {
      calls.push({ iconset, output })
      assert.deepEqual((await readdir(iconset)).sort(), [
        'icon_128x128.png',
        'icon_128x128@2x.png',
        'icon_16x16.png',
        'icon_16x16@2x.png',
        'icon_256x256.png',
        'icon_256x256@2x.png',
        'icon_32x32.png',
        'icon_32x32@2x.png',
        'icon_512x512.png',
      ])
      return { ok: true }
    },
  })
  t.after(() => rm(directory, { recursive: true, force: true }))

  assert.equal(calls.length, 1)
  assert.equal(calls[0].output, resolve(directory, 'build/icon.icns'))
  // The scratch iconset is not left behind next to the real outputs.
  assert.equal(existsSync(calls[0].iconset), false)
})

test('a missing iconutil logs a skip instead of failing the build', async t => {
  const lines = []
  const { directory, result } = await generate({
    icns: true,
    log: line => lines.push(line),
    runIconutil: async () => ({ ok: false, reason: 'iconutil is unavailable' }),
  })
  t.after(() => rm(directory, { recursive: true, force: true }))

  assert.ok(lines.some(line => /icns/.test(line) && /skip/i.test(line)), lines.join('\n'))
  assert.equal(result.written.some(file => file.endsWith('.icns')), false)
  assert.equal(existsSync(resolve(directory, 'build/icon.icns')), false)
})

test('--if-missing regenerates nothing once every output is present', async t => {
  const { directory } = await generate()
  t.after(() => rm(directory, { recursive: true, force: true }))

  const again = await makeIcons({ outputDir: directory, icns: false, ifMissing: true, log: () => {} })
  assert.equal(again.skipped, true)
  assert.deepEqual(again.written, [])

  await rm(resolve(directory, 'resources/tray/tray-22.png'))
  const third = await makeIcons({ outputDir: directory, icns: false, ifMissing: true, log: () => {} })
  assert.equal(third.skipped, false)
  assert.ok(third.written.length > 0)
})

test('the committed icon artifacts are the ones the generator produces', async t => {
  const packageRoot = resolve(import.meta.dirname, '..')
  const { directory } = await generate()
  t.after(() => rm(directory, { recursive: true, force: true }))

  // The SVG is text the generator emits verbatim, so it is compared byte for byte.
  assert.equal(
    await readFile(resolve(packageRoot, 'resources/icon.svg'), 'utf8'),
    await readFile(resolve(directory, 'resources/icon.svg'), 'utf8'),
    'resources/icon.svg is checked in up to date',
  )
  // The PNGs are compared as pixels, not as files. Node's bundled zlib changes
  // between releases (1.2.12 and 1.3.1 deflate the same mark to different
  // bytes), so a byte comparison here would fail on a node upgrade that changed
  // nothing about the icon. Pixels still catch the case that matters: a layout
  // edit committed without rerunning `npm run icons`.
  for (const size of TRAY_SIZES) {
    for (const file of [`resources/tray/tray-${size}.png`, `resources/tray/tray-${size}@2x.png`]) {
      const [committed, fresh] = await Promise.all([
        readFile(resolve(packageRoot, file)),
        readFile(resolve(directory, file)),
      ])
      assert.deepEqual(decodePng(committed).rgba, decodePng(fresh).rgba, `${file} is checked in up to date`)
    }
  }
})

test('the tray uses the per-platform PNG and keeps the blank pixel only as a fallback', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /darwin: 'tray-16\.png'/)
  assert.match(source, /linux: 'tray-22\.png'/)
  assert.match(source, /win32: 'tray-32\.png'/)
  assert.match(source, /nativeImage\.createFromPath\(/)
  // Packaged vs dev resolution mirrors the native binary: extraResources on one
  // side, the in-repo resources/ tree on the other.
  const resolver = source.slice(source.indexOf('function trayIconFile()'))
  const body = resolver.slice(0, resolver.indexOf('\n}\n'))
  assert.match(body, /app\.isPackaged/)
  assert.match(body, /resolve\(process\.resourcesPath, 'tray', file\)/)
  assert.match(body, /resolve\(packageRoot, 'resources\/tray', file\)/)
  // An unreadable file yields an empty nativeImage rather than throwing, so the
  // fallback has to be guarded on isEmpty(), not merely on existsSync.
  const image = source.slice(source.indexOf('function trayImage()'))
  const imageBody = image.slice(0, image.indexOf('\n}\n'))
  assert.match(imageBody, /isEmpty\(\)/)
  assert.match(imageBody, /createFromDataURL/)
  assert.match(source, /const next = new Tray\(trayImage\(\)\)/)
})

test('packaging ships the tray icons and the generator runs before the build', async () => {
  const root = resolve(import.meta.dirname, '..')
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts.icons, 'node scripts/make-icons.mjs')
  assert.match(manifest.scripts.build, /make-icons\.mjs --if-missing/)
  assert.ok(
    manifest.scripts.build.indexOf('make-icons.mjs') < manifest.scripts.build.indexOf('build.mjs'),
    'icons are generated before the build validation runs',
  )

  const builder = await readFile(resolve(root, 'electron-builder.yml'), 'utf8')
  assert.match(builder, /from: resources\/tray\n\s*to: tray/)
})
