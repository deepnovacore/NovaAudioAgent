// Cross-platform icon packager for the ambient orb.
//
// The approved raster mark is committed as a size-specific PNG ladder under
// resources/icon-source. Keeping the resampling step outside the build makes
// packaging deterministic without adding a native image dependency: Node only
// copies the exact PNG for Linux and the tray, wraps the Windows sizes in an
// ICO container, and lets macOS iconutil assemble the same pixels into ICNS.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { runIconsTool } = require('app-builder-lib/out/toolsets/icons.js')

export const ICON_SIZES = Object.freeze([16, 22, 24, 32, 48, 64, 128, 256, 512])
export const ICO_SIZES = Object.freeze([16, 32, 48, 256])
export const TRAY_SIZES = Object.freeze([16, 22, 32])

// ICONDIR, then one ICONDIRENTRY per image, then the PNG blobs. Windows reads
// PNG-format entries from Vista on, so no BMP/AND-mask path is necessary.
export function encodeIco(entries) {
  const directory = Buffer.alloc(6 + entries.length * 16)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(entries.length, 4)
  let offset = directory.length
  for (const [index, entry] of entries.entries()) {
    const at = 6 + index * 16
    if (entry.size > 256) {
      throw new RangeError(`an ICO entry cannot exceed 256px, got ${entry.size}`)
    }
    const declared = entry.size === 256 ? 0 : entry.size
    directory[at] = declared
    directory[at + 1] = declared
    directory[at + 2] = 0
    directory[at + 3] = 0
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  }
  return Buffer.concat([directory, ...entries.map(entry => entry.png)])
}

async function defaultRunIcnsTool({ inputFile, outDir }) {
  try {
    await runIconsTool({ inputFile, outputFormat: 'icns', outDir })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function trayFiles(outputDir) {
  return TRAY_SIZES.flatMap(size => [
    { file: resolve(outputDir, `resources/tray/tray-${size}.png`), size },
    { file: resolve(outputDir, `resources/tray/tray-${size}@2x.png`), size: size * 2 },
  ])
}

function outputPaths(outputDir, { icns }) {
  return {
    tray: trayFiles(outputDir),
    icons: ICON_SIZES.map(size => resolve(outputDir, `build/icons/${size}x${size}.png`)),
    ico: resolve(outputDir, 'build/icon.ico'),
    icns: icns ? resolve(outputDir, 'build/icon.icns') : null,
  }
}

async function allPresent(paths) {
  const files = [
    ...paths.tray.map(entry => entry.file),
    ...paths.icons,
    paths.ico,
    paths.icns,
  ].filter(Boolean)
  for (const file of files) {
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
  sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '../resources/icon-source'),
  icns = process.platform === 'darwin',
  ifMissing = false,
  runIcnsTool = defaultRunIcnsTool,
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

  const cache = new Map()
  const pngFor = size => {
    if (!cache.has(size)) {
      cache.set(size, readFile(resolve(sourceDir, `${size}x${size}.png`)))
    }
    return cache.get(size)
  }

  for (const { file, size } of paths.tray) await write(file, await pngFor(size))
  for (const [index, size] of ICON_SIZES.entries()) await write(paths.icons[index], await pngFor(size))
  await write(paths.ico, encodeIco(await Promise.all(
    ICO_SIZES.map(async size => ({ size, png: await pngFor(size) })),
  )))

  if (paths.icns) {
    const outDir = dirname(paths.icns)
    await mkdir(outDir, { recursive: true })
    const result = await runIcnsTool({
      inputFile: resolve(sourceDir, '1024x1024.png'),
      outDir,
    })
    if (result?.ok) written.push(paths.icns)
    else log(`ambient-orb icons: skipping icns (${result?.reason || 'conversion failed'})`)
  }

  log(`ambient-orb icons: wrote ${written.length} files`)
  return { skipped: false, written }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await makeIcons({ ifMissing: process.argv.includes('--if-missing') })
}
