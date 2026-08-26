import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { crc32 } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  ICO_SIZES,
  ICON_SIZES,
  TRAY_SIZES,
  encodeIco,
  makeIcons,
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

// Every chunk's CRC, checked with node's own zlib.crc32 rather than a second
// copy of the generator's table. This is the assertion that would catch a wrong
// polynomial or a CRC taken over the data without the type — mistakes that
// produce a file every real decoder rejects while the geometry assertions above
// stay perfectly happy.
function assertChunkCrcs(bytes, label) {
  let offset = 8
  let count = 0
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const covered = bytes.subarray(offset + 4, offset + 8 + length)
    const stored = bytes.readUInt32BE(offset + 8 + length)
    assert.equal(crc32(covered) >>> 0, stored, `${label}: ${covered.subarray(0, 4)} CRC`)
    offset += 12 + length
    count += 1
  }
  assert.equal(offset, bytes.length, `${label}: chunks tile the file exactly`)
  assert.ok(count >= 3, `${label}: IHDR, one or more IDAT chunks, IEND`)
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

async function sourcePngFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nova-icon-sources-'))
  const sizes = [16, 22, 24, 32, 44, 48, 64, 128, 256, 512]
  await Promise.all(sizes.map(size => (
    writeFile(resolve(directory, `${size}x${size}.png`), Buffer.from(`fixture-${size}`))
  )))
  return directory
}

test('packaging and tray PNGs come from the canonical size-specific sources', async t => {
  const sourceDir = await sourcePngFixture()
  const { directory } = await generate({ sourceDir })
  t.after(() => Promise.all([
    rm(sourceDir, { recursive: true, force: true }),
    rm(directory, { recursive: true, force: true }),
  ]))

  for (const size of ICON_SIZES) {
    assert.deepEqual(
      await readFile(resolve(directory, `build/icons/${size}x${size}.png`)),
      await readFile(resolve(sourceDir, `${size}x${size}.png`)),
      `${size}px linux icon uses its canonical source`,
    )
  }

  for (const size of TRAY_SIZES) {
    for (const [file, pixels] of [
      [`tray-${size}.png`, size],
      [`tray-${size}@2x.png`, size * 2],
    ]) {
      assert.deepEqual(
        await readFile(resolve(directory, 'resources/tray', file)),
        await readFile(resolve(sourceDir, `${pixels}x${pixels}.png`)),
        `${file} uses its canonical source`,
      )
    }
  }
})

test('source-based generation does not recreate the legacy SVG mark', async t => {
  const sourceDir = await sourcePngFixture()
  const { directory } = await generate({ sourceDir })
  t.after(() => Promise.all([
    rm(sourceDir, { recursive: true, force: true }),
    rm(directory, { recursive: true, force: true }),
  ]))

  assert.equal(existsSync(resolve(directory, 'resources/icon.svg')), false)
})

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
    const types = chunkTypes(bytes)
    assert.equal(types[0], 'IHDR')
    assert.equal(types.at(-1), 'IEND')
    assert.ok(types.slice(1, -1).every(type => type === 'IDAT'), `${size}px contains only image data`)
    assertChunkCrcs(bytes, `${size}px`)
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
    // The blob really is a whole, intact PNG and not a slice off by a few bytes.
    assertChunkCrcs(png, `ICO entry ${size}`)
    expectedOffset += bytesInRes
  }
  assert.equal(expectedOffset, ico.length, 'the entry table accounts for every byte')
})

test('an ICO entry larger than the format can describe is refused, not truncated', () => {
  // The width/height fields are single bytes. Writing `size & 0xff` would tell
  // Windows a 512px image is 256px — a wrong icon rather than a loud failure.
  assert.throws(
    () => encodeIco([{ size: 512, png: Buffer.alloc(8) }]),
    /cannot exceed 256px/,
  )
  // 256 itself is still fine, and still spelled 0.
  const ok = encodeIco([{ size: 256, png: Buffer.alloc(8) }])
  assert.equal(ok[6], 0)
  assert.equal(ok[7], 0)
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

test('the canonical source ladder covers every packaged size as transparent RGBA PNG', async () => {
  const root = resolve(import.meta.dirname, '..')
  const sizes = [16, 22, 24, 32, 44, 48, 64, 128, 256, 512, 1024]

  for (const size of sizes) {
    const bytes = await readFile(resolve(root, `resources/icon-source/${size}x${size}.png`))
    const header = readPngHeader(bytes)
    assert.equal(header.width, size, `${size}px width`)
    assert.equal(header.height, size, `${size}px height`)
    assert.equal(header.bitDepth, 8)
    assert.equal(header.colorType, 6, `${size}px keeps an alpha channel`)
    assertChunkCrcs(bytes, `${size}px source`)
  }
})

test('the icns step converts the canonical 1024px source with Electron Builder tooling', async t => {
  const calls = []
  const { directory } = await generate({
    icns: true,
    runIcnsTool: async ({ inputFile, outDir }) => {
      calls.push({ inputFile, outDir })
      await writeFile(resolve(outDir, 'icon.icns'), Buffer.from('fixture-icns'))
      return { ok: true }
    },
  })
  t.after(() => rm(directory, { recursive: true, force: true }))

  assert.equal(calls.length, 1)
  assert.equal(calls[0].inputFile, resolve(import.meta.dirname, '../resources/icon-source/1024x1024.png'))
  assert.equal(calls[0].outDir, resolve(directory, 'build'))
  assert.deepEqual(await readFile(resolve(directory, 'build/icon.icns')), Buffer.from('fixture-icns'))
})

test('a missing ICNS converter logs a skip instead of failing the build', async t => {
  const lines = []
  const { directory, result } = await generate({
    icns: true,
    log: line => lines.push(line),
    runIcnsTool: async () => ({ ok: false, reason: 'icon converter is unavailable' }),
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

test('the committed tray artifacts are the canonical sources the generator packages', async t => {
  const packageRoot = resolve(import.meta.dirname, '..')
  const { directory } = await generate()
  t.after(() => rm(directory, { recursive: true, force: true }))

  for (const size of TRAY_SIZES) {
    for (const file of [`resources/tray/tray-${size}.png`, `resources/tray/tray-${size}@2x.png`]) {
      const pixels = file.includes('@2x') ? size * 2 : size
      const [committed, fresh, source] = await Promise.all([
        readFile(resolve(packageRoot, file)),
        readFile(resolve(directory, file)),
        readFile(resolve(packageRoot, `resources/icon-source/${pixels}x${pixels}.png`)),
      ])
      assert.deepEqual(committed, source, `${file} matches its canonical source`)
      assert.deepEqual(fresh, source, `${file} regenerates from the same source`)
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
