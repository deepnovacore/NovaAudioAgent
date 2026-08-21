import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { checkJavaScriptFiles } from './build-contract.mjs'
import { buildDependencyReport, inspectConfiguredPackage } from './inspect-package.mjs'
import { deriveLockedProductionClosure } from './release-dependency-closure.mjs'
import { buildProjectNativeAddon } from './build-project-native.mjs'

const root = resolve(import.meta.dirname, '..')

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
const targetId = process.platform === 'darwin'
  ? `darwin-${process.arch}`
  : process.platform === 'win32'
    ? `win32-${process.arch}`
    : `linux-${process.arch}-gnu`
await inspectConfiguredPackage({ packageRoot: root, targetId })
const closure = await deriveLockedProductionClosure({
  lockPath: resolve(root, '../../package-lock.json'),
  targetId,
})
const releaseBuildDirectory = resolve(root, 'build/release')
await mkdir(releaseBuildDirectory, { recursive: true })
const dependencyReport = await buildDependencyReport(resolve(root, '../..'), closure)
await writeFile(
  resolve(releaseBuildDirectory, 'production-dependencies-v1.json'),
  `${JSON.stringify(dependencyReport)}\n`,
  { encoding: 'utf8', mode: 0o600 },
)

await buildProjectNativeAddon({
  packageRoot: root,
  outputRoot: resolve(root, 'build'),
  platform: process.platform,
  arch: process.arch,
})

checkJavaScriptFiles(root)

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
