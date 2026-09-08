'use strict'

const assert = require('node:assert/strict')
const {spawnSync} = require('node:child_process')
const {chmodSync, lstatSync, realpathSync} = require('node:fs')
const {readFile, rename, writeFile} = require('node:fs/promises')
const {resolve} = require('node:path')

const {signAsync} = require('@electron/osx-sign')

const packageRoot = resolve(__dirname, '..')
const reportPath = resolve(packageRoot, 'build/release/production-dependencies-v1.json')
const inheritEntitlements = resolve(packageRoot, 'resources/entitlements.mac.inherit.plist')

/**
 * Electron-builder calls this only after it has selected a real signing identity. Native resources
 * are sealed first, the manifest hashes those sealed bytes, then osx-sign seals every remaining
 * nested component and the outer app while explicitly preserving the already-sealed resources.
 */
module.exports = async function signMacWithNativeManifest(options) {
  assert.equal(process.platform, 'darwin', 'mac_native_signing_rejected')
  assert.equal(typeof options?.app, 'string', 'mac_native_signing_rejected')
  assert.equal(typeof options?.identity, 'string', 'mac_native_signing_rejected')
  const app = realpathSync(options.app)
  assert.equal(app, resolve(options.app), 'mac_native_signing_rejected')
  const resourcesRoot = resolve(app, 'Contents/Resources')
  assert.equal(realpathSync(resourcesRoot), resourcesRoot, 'mac_native_signing_rejected')
  const [{generateNativeResourceManifest}, {parseStrictJson}] = await Promise.all([
    import('./native-resource-contract.mjs'),
    import('./strict-json.mjs'),
  ])
  const dependencyReport = parseStrictJson(await readFile(reportPath, 'utf8'))
  const targetId = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  const before = await generateNativeResourceManifest({resourcesRoot, targetId, dependencyReport})
  const sealedPaths = new Set()
  for (const resource of before.resources) {
    if (
      resource.platform !== 'darwin'
      || !['executable', 'node_addon', 'shared_library'].includes(resource.kind)
    ) continue
    const path = resolve(resourcesRoot, resource.relative_path)
    const link = lstatSync(path)
    assert.equal(link.isSymbolicLink(), false, 'mac_native_signing_rejected')
    assert.equal(link.isFile(), true, 'mac_native_signing_rejected')
    assert.equal(realpathSync(path), path, 'mac_native_signing_rejected')
    signNative(path, options)
    sealedPaths.add(path)
  }
  assert.ok(sealedPaths.size > 0, 'mac_native_signing_rejected')
  const manifest = await generateNativeResourceManifest({resourcesRoot, targetId, dependencyReport})
  const manifestPath = resolve(resourcesRoot, 'native-resources-v1.json')
  const temporary = resolve(resourcesRoot, '.native-resources-v1.json.signing')
  await writeFile(temporary, `${JSON.stringify(manifest)}\n`, {encoding: 'utf8', mode: 0o600})
  chmodSync(temporary, 0o600)
  await rename(temporary, manifestPath)

  const priorIgnore = options.ignore
  await signAsync({
    ...options,
    ignore: path => sealedPaths.has(resolve(path)) || ignoredBy(priorIgnore, path),
  })
  runCodesign(['--verify', '--deep', '--strict', '--verbose=2', app])
  const finalManifest = await generateNativeResourceManifest({resourcesRoot, targetId, dependencyReport})
  assert.deepEqual(finalManifest, manifest, 'mac_native_signing_rejected')
}

function signNative(path, options) {
  const args = ['--sign', options.identity, '--force', '--options', 'runtime']
  if (options.identity !== '-') args.push('--timestamp')
  if (typeof options.keychain === 'string' && options.keychain !== '') {
    args.push('--keychain', options.keychain)
  }
  args.push('--entitlements', inheritEntitlements, path)
  runCodesign(args)
  runCodesign(['--verify', '--strict', '--verbose=2', path])
}

function runCodesign(args) {
  const result = spawnSync('/usr/bin/codesign', args, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.equal(result.error, undefined, 'mac_native_signing_rejected')
  assert.equal(result.status, 0, 'mac_native_signing_rejected')
}

function ignoredBy(value, path) {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return entries.some(entry => (
    typeof entry === 'function' ? entry(path) : path.match(entry) !== null
  ))
}
