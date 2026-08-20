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
  'src/main/settings-store.mjs',
  'src/renderer/index.mjs',
  'src/renderer/camera.mjs',
  'src/renderer/audio.mjs',
  'src/renderer/state.mjs',
  'src/renderer/orb-visual.mjs',
  'src/renderer/settings.mjs',
  'scripts/utility-runtime-smoke.mjs',
]

const runtimeEntry = resolve(root, '../../runtime/dist/src/desktop-entry.js')
const npmCli = process.env.npm_execpath
assert.ok(npmCli, 'npm_execpath is required to build the runtime workspace')
const runtimeBuild = spawnSync(process.execPath, [
  npmCli,
  'run',
  'build',
  '--workspace',
  '@nova-audio-agent/runtime',
], {
  cwd: root,
  encoding: 'utf8',
})
assert.equal(runtimeBuild.status, 0, runtimeBuild.stderr)
await readFile(runtimeEntry, 'utf8')

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
