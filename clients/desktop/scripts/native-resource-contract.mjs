import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'


const MAX_NATIVE_BYTES = 256 * 1024 * 1024
const MAX_NATIVE_FILES = 256
const TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({ platform: 'darwin', architecture: 'arm64', suffix: 'darwin-arm64' }),
  'darwin-x64': Object.freeze({ platform: 'darwin', architecture: 'x64', suffix: 'darwin-x64' }),
  'win32-x64': Object.freeze({ platform: 'win32', architecture: 'x64', suffix: 'win32-x64-msvc' }),
  'linux-x64-gnu': Object.freeze({ platform: 'linux', architecture: 'x64', suffix: 'linux-x64-gnu' }),
})
const SOURCE_HOST_RESOURCE_IDS = new Set([
  'macos_calendar',
  'macos_mail',
  'windows_job_guardian',
  'project_native_addon',
  'codex_sandbox_probe',
])

export class NativeResourceError extends Error {
  constructor(code) {
    super(`native resource contract rejected: ${code}`)
    this.name = 'NativeResourceError'
    this.code = code
  }
}

function resource(id, relativePath, kind) {
  return Object.freeze({ id, relative_path: relativePath, kind })
}

export function expectedNativeResources(targetId) {
  const target = TARGETS[targetId]
  if (!target) throw new NativeResourceError('unsupported_target')
  const executableSuffix = target.platform === 'win32' ? '.exe' : ''
  const localName = target.platform === 'win32'
    ? 'local-inference.win32-x64-msvc.node'
    : target.platform === 'linux'
      ? 'local-inference.linux-x64-gnu.node'
      : `local-inference.${target.suffix}.node`
  const rtcName = target.platform === 'win32'
    ? 'rtc-node.win32-x64-msvc.node'
    : target.platform === 'linux'
      ? 'rtc-node.linux-x64-gnu.node'
      : `rtc-node.${target.suffix}.node`
  const resources = []
  if (target.platform === 'win32') {
    resources.push(resource(
      'windows_job_guardian',
      'native/windows-job-guardian.exe',
      'executable',
    ))
  }
  resources.push(
    resource('project_native_addon', 'native/project-native/nova_project_native.node', 'node_addon'),
    resource('codex_sandbox_probe', `native/codex-sandbox-probe${executableSuffix}`, 'executable'),
  )
  if (target.platform === 'darwin') {
    resources.push(resource('macos_mail', 'native/macos_mail', 'executable'))
    resources.push(resource('macos_calendar', 'native/macos_calendar', 'executable'))
    resources.push(resource('macos_voice_io', 'native/macos_voice_io', 'executable'))
  }
  resources.push(
    resource(
      'livekit_local_inference',
      `app.asar.unpacked/node_modules/@livekit/local-inference-${target.suffix}/${localName}`,
      'node_addon',
    ),
    resource(
      'livekit_rtc',
      `app.asar.unpacked/node_modules/@livekit/rtc-ffi-bindings-${target.suffix}/${rtcName}`,
      'node_addon',
    ),
    resource('livekit_probe_manifest', 'endpointing/volcengine-v1/MANIFEST.json', 'data'),
    resource('livekit_probe_license', 'endpointing/volcengine-v1/LICENSE.silero-vad.txt', 'data'),
    resource('livekit_probe_silence', 'endpointing/volcengine-v1/silence-16k-s16le.pcm', 'data'),
    resource('livekit_probe_speech', 'endpointing/volcengine-v1/speech-16k-s16le.pcm', 'data'),
  )
  return Object.freeze(resources)
}

async function hashNativeFile(path, target, kind) {
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch {
    throw new NativeResourceError('native_resource_missing')
  }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size <= 0 || before.size > MAX_NATIVE_BYTES) {
      throw new NativeResourceError('native_resource_invalid')
    }
    if (
      kind === 'executable'
      && target.platform !== 'win32'
      && process.platform !== 'win32'
      && (before.mode & 0o111) === 0
    ) throw new NativeResourceError('native_resource_mode')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (position < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      )
      if (bytesRead === 0) throw new NativeResourceError('native_resource_changed')
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat()
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new NativeResourceError('native_resource_changed')
    }
    return { size: before.size, sha256: hash.digest('hex') }
  } finally {
    await handle.close().catch(() => {})
  }
}

function nativeKind(path) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.node')) return 'node_addon'
  if (
    lower.endsWith('.dylib')
    || /\.so(?:\.\d+)*$/u.test(lower)
    || lower.endsWith('.dll')
  ) return 'shared_library'
  return null
}

function nativeFile(path) {
  return nativeKind(path) !== null
}

async function completeExpectedResources(resourcesRoot, targetId) {
  const byPath = new Map(expectedNativeResources(targetId).map(item => [item.relative_path, item]))
  for (const path of await nativeSurface(resourcesRoot)) {
    if (byPath.has(path) || nativeKind(path) === null) continue
    const digest = createHash('sha256').update(path).digest('hex').slice(0, 24)
    byPath.set(path, resource(`dependency_native_${digest}`, path, nativeKind(path)))
  }
  return [...byPath.values()].sort((a, b) => a.relative_path.localeCompare(b.relative_path))
}

export async function generateNativeResourceManifest({ resourcesRoot, targetId }) {
  if (typeof resourcesRoot !== 'string' || resourcesRoot === '') {
    throw new NativeResourceError('resources_root_invalid')
  }
  const target = TARGETS[targetId]
  if (!target) throw new NativeResourceError('unsupported_target')
  const entries = []
  for (const expected of await completeExpectedResources(resourcesRoot, targetId)) {
    const identity = await hashNativeFile(
      resolve(resourcesRoot, expected.relative_path),
      target,
      expected.kind,
    )
    entries.push(Object.freeze({
      logical_id: expected.id,
      relative_path: expected.relative_path,
      byte_size: identity.size,
      sha256: identity.sha256,
      kind: expected.kind,
      platform: target.platform,
      architecture: target.architecture,
      electron_abi: expected.kind === 'node_addon' ? 148 : null,
      build_contract_version: 1,
    }))
  }
  return Object.freeze({
    schema_version: 1,
    target: targetId,
    resources: Object.freeze(entries),
  })
}

/** Bind only the fixed native resources the unpackaged desktop host executes. */
export async function generateSourceHostResourceManifest({ resourcesRoot, targetId }) {
  if (typeof resourcesRoot !== 'string' || resourcesRoot === '') {
    throw new NativeResourceError('resources_root_invalid')
  }
  const target = TARGETS[targetId]
  if (!target) throw new NativeResourceError('unsupported_target')
  const expected = expectedNativeResources(targetId)
    .filter(candidate => SOURCE_HOST_RESOURCE_IDS.has(candidate.id))
    .sort((left, right) => (
      left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0
    ))
  const entries = []
  for (const candidate of expected) {
    const identity = await hashNativeFile(
      resolve(resourcesRoot, candidate.relative_path),
      target,
      candidate.kind,
    )
    entries.push(Object.freeze({
      logical_id: candidate.id,
      relative_path: candidate.relative_path,
      byte_size: identity.size,
      sha256: identity.sha256,
      kind: candidate.kind,
      platform: target.platform,
      architecture: target.architecture,
      electron_abi: candidate.kind === 'node_addon' ? 148 : null,
      build_contract_version: 1,
    }))
  }
  return Object.freeze({
    schema_version: 1,
    target: targetId,
    resources: Object.freeze(entries),
  })
}

async function nativeSurface(resourcesRoot) {
  const found = []
  const roots = [
    { root: resolve(resourcesRoot, 'native'), prefix: 'native', everyFile: true },
    {
      root: resolve(resourcesRoot, 'app.asar.unpacked'),
      prefix: 'app.asar.unpacked',
      everyFile: false,
    },
    {
      root: resolve(resourcesRoot, 'endpointing/volcengine-v1'),
      prefix: 'endpointing/volcengine-v1',
      everyFile: true,
    },
  ]
  const visit = async (root, directory, prefix, everyFile, depth) => {
    if (depth > 32) throw new NativeResourceError('native_resource_orphan')
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw new NativeResourceError('native_resource_invalid')
    }
    for (const entry of entries) {
      const relativePath = `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) throw new NativeResourceError('native_resource_invalid')
      if (entry.isDirectory()) {
        await visit(root, resolve(directory, entry.name), relativePath, everyFile, depth + 1)
      } else if (!entry.isFile()) throw new NativeResourceError('native_resource_invalid')
      else if (everyFile || nativeFile(relativePath)) found.push(relativePath)
      if (found.length > MAX_NATIVE_FILES) throw new NativeResourceError('native_resource_orphan')
    }
  }
  for (const candidate of roots) {
    await visit(candidate.root, candidate.root, candidate.prefix, candidate.everyFile, 0)
  }
  return found.sort()
}
