import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const scripts = [
  'src/main/main.mjs',
  'src/main/app-protocol.mjs',
  'src/main/backend.mjs',
  'src/main/security.mjs',
  'src/main/native-audio.mjs',
  'src/main/drag-controller.mjs',
  'src/renderer/index.mjs',
  'src/renderer/audio.mjs',
  'src/renderer/state.mjs',
]

for (const file of scripts) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, file)], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${file}: ${result.stderr}`)
}

const html = await readFile(resolve(root, 'src/renderer/index.html'), 'utf8')
assert.match(html, /Content-Security-Policy/)
assert.match(html, /connect-src ws:\/\/127\.0\.0\.1:\*/)
assert.doesNotMatch(html, /https?:\/\//)

const preload = await readFile(resolve(root, 'src/preload/preload.cjs'), 'utf8')
assert.doesNotMatch(preload, /nodeIntegration|require\(['"]node:/)

if (process.platform === 'darwin') {
  const buildDirectory = resolve(root, 'build')
  await mkdir(buildDirectory, { recursive: true })
  const native = spawnSync('/usr/bin/swiftc', [
    resolve(root, 'native/macos_voice_io.swift'),
    '-O',
    '-framework',
    'AudioToolbox',
    '-o',
    resolve(buildDirectory, 'macos_voice_io'),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: resolve(buildDirectory, 'clang-cache'),
      SWIFT_MODULECACHE_PATH: resolve(buildDirectory, 'swift-cache'),
    },
  })
  assert.equal(native.status, 0, native.stderr)
}

process.stdout.write('ambient-orb build validation passed\n')
