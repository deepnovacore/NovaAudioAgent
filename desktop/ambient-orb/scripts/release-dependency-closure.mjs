import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseStrictJson } from './strict-json.mjs'

const RUNTIME_PACKAGE = '@nova-audio-agent/runtime'
const { satisfies: semverSatisfies } = createRequire(import.meta.url)('semver')
const REQUIRED_RUNTIME_VERSIONS = Object.freeze({
  '@livekit/agents': '1.6.4',
  '@livekit/rtc-node': '0.13.33',
})
const CANONICAL_TARGETS = Object.freeze([
  Object.freeze({
    id: 'darwin-arm64', platform: 'darwin', architecture: 'arm64', libc: 'none',
    installers: Object.freeze(['dmg', 'app']),
    native_resources: Object.freeze([
      'project_native_addon', 'codex_sandbox_probe', 'macos_voice_io',
      'livekit_local_inference', 'livekit_rtc',
    ]),
  }),
  Object.freeze({
    id: 'darwin-x64', platform: 'darwin', architecture: 'x64', libc: 'none',
    installers: Object.freeze(['dmg', 'app']),
    native_resources: Object.freeze([
      'project_native_addon', 'codex_sandbox_probe', 'macos_voice_io',
      'livekit_local_inference', 'livekit_rtc',
    ]),
  }),
  Object.freeze({
    id: 'win32-x64', platform: 'win32', architecture: 'x64', libc: 'none',
    installers: Object.freeze(['nsis']),
    native_resources: Object.freeze([
      'windows_job_guardian', 'project_native_addon', 'codex_sandbox_probe',
      'livekit_local_inference', 'livekit_rtc',
    ]),
  }),
  Object.freeze({
    id: 'linux-x64-gnu', platform: 'linux', architecture: 'x64', libc: 'glibc',
    installers: Object.freeze(['appimage', 'deb']),
    native_resources: Object.freeze([
      'project_native_addon', 'codex_sandbox_probe',
      'livekit_local_inference', 'livekit_rtc',
    ]),
  }),
])

export class ReleaseDependencyError extends Error {
  constructor(code) {
    super(`release dependency closure rejected: ${code}`)
    this.name = 'ReleaseDependencyError'
    this.code = code
  }
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys, code) {
  if (!plain(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new ReleaseDependencyError(code)
  }
}

export async function readReleaseTargets(path = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../release/release-targets-v1.json',
)) {
  let parsed
  try {
    parsed = parseStrictJson(await readFile(path, 'utf8'))
  } catch {
    throw new ReleaseDependencyError('target_manifest_invalid')
  }
  exactKeys(parsed, ['schema_version', 'electron', 'targets'], 'target_manifest_invalid')
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.targets) || parsed.targets.length !== 4) {
    throw new ReleaseDependencyError('target_manifest_invalid')
  }
  exactKeys(parsed.electron, ['version', 'module_abi'], 'target_manifest_invalid')
  if (parsed.electron.version !== '43.2.0' || parsed.electron.module_abi !== 148) {
    throw new ReleaseDependencyError('target_manifest_invalid')
  }
  for (const target of parsed.targets) {
    exactKeys(target, [
      'id', 'platform', 'architecture', 'libc', 'installers', 'native_resources',
    ], 'target_manifest_invalid')
    if (
      typeof target.id !== 'string'
      || !['darwin', 'win32', 'linux'].includes(target.platform)
      || !['arm64', 'x64'].includes(target.architecture)
      || !['none', 'glibc'].includes(target.libc)
      || !Array.isArray(target.installers)
      || target.installers.some(value => typeof value !== 'string')
      || !Array.isArray(target.native_resources)
      || target.native_resources.some(value => typeof value !== 'string')
    ) throw new ReleaseDependencyError('target_manifest_invalid')
  }
  if (JSON.stringify(parsed.targets) !== JSON.stringify(CANONICAL_TARGETS)) {
    throw new ReleaseDependencyError('target_manifest_invalid')
  }
  return Object.freeze({
    schema_version: 1,
    electron: Object.freeze({ ...parsed.electron }),
    targets: Object.freeze(parsed.targets.map(target => Object.freeze({
      ...target,
      installers: Object.freeze([...target.installers]),
      native_resources: Object.freeze([...target.native_resources]),
    }))),
  })
}

function packageApplicable(meta, target) {
  if (Array.isArray(meta.os) && !meta.os.includes(target.platform)) return false
  if (Array.isArray(meta.cpu) && !meta.cpu.includes(target.architecture)) return false
  if (Array.isArray(meta.libc)) {
    const wanted = target.libc === 'glibc' ? 'glibc' : target.libc
    if (!meta.libc.includes(wanted)) return false
  }
  if (target.platform === 'linux') {
    if (/-musl(?:$|-)/u.test(meta.name ?? '')) return false
    if (/-gnu(?:$|-)/u.test(meta.name ?? '') && target.libc !== 'glibc') return false
  }
  return true
}

function rootPackageKey(name) {
  return `node_modules/${name}`
}

function resolveDependencyKey(packages, parentInstallKey, name) {
  let parent = parentInstallKey.includes('/node_modules/') || parentInstallKey.startsWith('node_modules/')
    ? parentInstallKey
    : ''
  while (true) {
    const candidate = parent === ''
      ? rootPackageKey(name)
      : `${parent}/node_modules/${name}`
    if (plain(packages[candidate])) return candidate
    if (parent === '') break
    const marker = parent.lastIndexOf('/node_modules/')
    parent = marker < 0 ? '' : parent.slice(0, marker)
  }
  throw new ReleaseDependencyError('locked_dependency_missing')
}

function dereference(packages, installKey) {
  const entry = packages[installKey]
  if (!plain(entry)) throw new ReleaseDependencyError('locked_dependency_missing')
  if (entry.link !== true) return { installKey, manifestKey: installKey, manifest: entry }
  if (typeof entry.resolved !== 'string' || !plain(packages[entry.resolved])) {
    throw new ReleaseDependencyError('locked_dependency_missing')
  }
  return { installKey, manifestKey: entry.resolved, manifest: packages[entry.resolved] }
}

function omitForbiddenOptional(parentName, dependencyName) {
  // The public Agents root imports @livekit/av's JS resolver, but Nova never ships or executes
  // LiveKit's optional ffmpeg program. Missing optional binaries are the package's supported state.
  return parentName === '@livekit/av' && dependencyName.startsWith('@livekit/av-')
}

function lockedIdentity(name, installKey, manifest) {
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new ReleaseDependencyError('locked_dependency_invalid')
  }
  const identity = JSON.stringify({
    integrity: manifest.integrity ?? null,
    name,
    version: manifest.version,
  })
  return Object.freeze({
    name,
    version: manifest.version,
    installKey,
    content_sha256: createHash('sha256').update(identity).digest('hex'),
  })
}

export async function deriveLockedProductionClosure({
  lockPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../package-lock.json'),
  targetId,
} = {}) {
  const targets = await readReleaseTargets()
  const target = targets.targets.find(candidate => candidate.id === targetId)
  if (!target) throw new ReleaseDependencyError('unsupported_target')
  let lock
  try {
    lock = parseStrictJson(await readFile(lockPath, 'utf8'))
  } catch {
    throw new ReleaseDependencyError('lock_invalid')
  }
  if (lock.lockfileVersion !== 3 || !plain(lock.packages)) {
    throw new ReleaseDependencyError('lock_invalid')
  }
  const packages = lock.packages
  const desktop = packages['desktop/ambient-orb']
  if (!plain(desktop) || desktop.name !== '@nova-audio-agent/ambient-orb') {
    throw new ReleaseDependencyError('lock_invalid')
  }
  const desktopDependencies = Object.keys(desktop.dependencies ?? {})
  if (desktopDependencies.length !== 1 || desktopDependencies[0] !== RUNTIME_PACKAGE) {
    throw new ReleaseDependencyError('desktop_dependency_invalid')
  }

  const queue = desktopDependencies.map(name => ({
    name,
    ...dereference(packages, resolveDependencyKey(packages, 'desktop/ambient-orb', name)),
    ancestry: ['@nova-audio-agent/ambient-orb'],
  }))
  const selected = new Map()
  const peerRequirements = []
  while (queue.length > 0) {
    const item = queue.shift()
    if (selected.has(item.installKey)) continue
    const manifest = item.manifest
    if (!packageApplicable({ ...manifest, name: item.name }, target)) {
      throw new ReleaseDependencyError('required_dependency_wrong_target')
    }
    if (
      item.name === '@livekit/local-inference'
      && !item.ancestry.includes('@livekit/agents')
    ) throw new ReleaseDependencyError('direct_local_inference_forbidden')
    selected.set(item.installKey, {
      ...lockedIdentity(item.name, item.installKey, manifest),
      manifestKey: item.manifestKey,
    })

    const dependencies = plain(manifest.dependencies) ? manifest.dependencies : {}
    const optional = plain(manifest.optionalDependencies) ? manifest.optionalDependencies : {}
    for (const [name, range] of Object.entries({ ...dependencies, ...optional })) {
      if (typeof range !== 'string' || range === '') throw new ReleaseDependencyError('lock_invalid')
      if (Object.hasOwn(optional, name) && omitForbiddenOptional(item.name, name)) continue
      const installKey = resolveDependencyKey(packages, item.installKey, name)
      const resolved = dereference(packages, installKey)
      if (Object.hasOwn(optional, name) && !packageApplicable({ ...resolved.manifest, name }, target)) {
        continue
      }
      queue.push({
        name,
        ...resolved,
        ancestry: [...item.ancestry, item.name],
      })
    }
    if (plain(manifest.peerDependencies)) {
      for (const [name, range] of Object.entries(manifest.peerDependencies)) {
        if (typeof range !== 'string') throw new ReleaseDependencyError('lock_invalid')
        peerRequirements.push({ parentInstallKey: item.installKey, name, range })
      }
    }
  }

  for (const requirement of peerRequirements) {
    let installKey
    try {
      installKey = resolveDependencyKey(packages, requirement.parentInstallKey, requirement.name)
    } catch {
      continue
    }
    const peer = selected.get(installKey)
    if (!peer) continue
    if (!semverSatisfies(peer.version, requirement.range, { includePrerelease: false })) {
      throw new ReleaseDependencyError('peer_dependency_unsatisfied')
    }
  }
  for (const [name, version] of Object.entries(REQUIRED_RUNTIME_VERSIONS)) {
    const match = [...selected.values()].find(value => value.name === name)
    if (!match || match.version !== version) throw new ReleaseDependencyError('livekit_version_invalid')
  }

  return Object.freeze({
    schema_version: 1,
    target: target.id,
    packages: Object.freeze([...selected.values()]
      .sort((left, right) => left.installKey < right.installKey ? -1 : left.installKey > right.installKey ? 1 : 0)
      .map(value => Object.freeze(value))),
  })
}
