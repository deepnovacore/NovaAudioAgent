import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { parseStrictJson } from './strict-json.mjs'

const MAX_NATIVE_BYTES = 256 * 1024 * 1024
const MAX_NATIVE_MANIFEST_BYTES = 1024 * 1024
const MAX_NATIVE_FILES = 256
const TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({ platform: 'darwin', architecture: 'arm64', suffix: 'darwin-arm64' }),
  'darwin-x64': Object.freeze({ platform: 'darwin', architecture: 'x64', suffix: 'darwin-x64' }),
  'win32-x64': Object.freeze({ platform: 'win32', architecture: 'x64', suffix: 'win32-x64-msvc' }),
  'linux-x64-gnu': Object.freeze({ platform: 'linux', architecture: 'x64', suffix: 'linux-x64-gnu' }),
})
const SOURCE_HOST_RESOURCE_IDS = new Set([
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

function assertBinaryHeader(header, target, kind) {
  if (target.platform === 'darwin') {
    if (header.length < 16 || header.readUInt32LE(0) !== 0xfeedfacf) {
      throw new NativeResourceError('native_resource_format')
    }
    const expectedCpu = target.architecture === 'arm64' ? 0x0100000c : 0x01000007
    if (header.readUInt32LE(4) !== expectedCpu) throw new NativeResourceError('native_resource_arch')
    const fileType = header.readUInt32LE(12)
    const kindMatches = kind === 'executable'
      ? fileType === 2
      : kind === 'node_addon'
        ? fileType === 8 || fileType === 6
        : fileType === 6
    if (!kindMatches) {
      throw new NativeResourceError('native_resource_kind')
    }
    if (kind === 'executable') assertMacMinimumVersion(header)
    return
  }
  if (target.platform === 'linux') {
    if (
      header.length < 20
      || header[0] !== 0x7f
      || header.subarray(1, 4).toString('ascii') !== 'ELF'
      || header[4] !== 2
      || header[5] !== 1
    ) throw new NativeResourceError('native_resource_format')
    if (header.readUInt16LE(18) !== 0x3e) throw new NativeResourceError('native_resource_arch')
    return
  }
  if (header.length < 64 || header.subarray(0, 2).toString('ascii') !== 'MZ') {
    throw new NativeResourceError('native_resource_format')
  }
  const peOffset = header.readUInt32LE(0x3c)
  if (
    peOffset + 6 > header.length
    || header.subarray(peOffset, peOffset + 4).toString('binary') !== 'PE\0\0'
  ) throw new NativeResourceError('native_resource_format')
  if (header.readUInt16LE(peOffset + 4) !== 0x8664) throw new NativeResourceError('native_resource_arch')
  const isDll = (header.readUInt16LE(peOffset + 22) & 0x2000) !== 0
  if ((kind === 'executable' && isDll) || (kind !== 'executable' && !isDll)) {
    throw new NativeResourceError('native_resource_kind')
  }
}

function assertMacMinimumVersion(header) {
  if (header.length < 32) throw new NativeResourceError('native_resource_min_os')
  const commands = header.readUInt32LE(16)
  const commandBytes = header.readUInt32LE(20)
  if (commands === 0 || commands > 64 || commandBytes > header.length - 32) {
    throw new NativeResourceError('native_resource_min_os')
  }
  let offset = 32
  let minimum = null
  for (let index = 0; index < commands; index += 1) {
    if (offset + 8 > 32 + commandBytes) throw new NativeResourceError('native_resource_min_os')
    const command = header.readUInt32LE(offset)
    const size = header.readUInt32LE(offset + 4)
    if (size < 8 || offset + size > 32 + commandBytes) {
      throw new NativeResourceError('native_resource_min_os')
    }
    if (command === 0x32 && size >= 16) minimum = header.readUInt32LE(offset + 12)
    if (command === 0x24 && size >= 12) minimum = header.readUInt32LE(offset + 8)
    offset += size
  }
  if (minimum !== 0x000c0000) throw new NativeResourceError('native_resource_min_os')
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
      && (before.mode & 0o111) === 0
    ) throw new NativeResourceError('native_resource_mode')
    const header = Buffer.alloc(Math.min(4096, before.size))
    await handle.read(header, 0, header.length, 0)
    if (kind !== 'data') assertBinaryHeader(header, target, kind)
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

function exactKeys(value, keys, code) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')
  ) throw new NativeResourceError(code)
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

function dependencyNativeResources(dependencyReport) {
  if (dependencyReport === undefined) return []
  exactKeys(dependencyReport, ['schema_version', 'target', 'packages'], 'dependency_report_invalid')
  if (dependencyReport.schema_version !== 1 || !Array.isArray(dependencyReport.packages)) {
    throw new NativeResourceError('dependency_report_invalid')
  }
  const results = []
  for (const record of dependencyReport.packages) {
    if (typeof record.install_key !== 'string' || !Array.isArray(record.files)) {
      throw new NativeResourceError('dependency_report_invalid')
    }
    for (const file of record.files) {
      if (typeof file?.path !== 'string' || !nativeFile(file.path)) continue
      const relativePath = `app.asar.unpacked/${record.install_key}/${file.path}`
      const digest = createHash('sha256').update(relativePath).digest('hex').slice(0, 24)
      results.push(resource(
        `dependency_native_${digest}`,
        relativePath,
        nativeKind(file.path),
      ))
    }
  }
  return results
}

function completeExpectedResources(targetId, dependencyReport) {
  const byPath = new Map()
  for (const expected of [
    ...expectedNativeResources(targetId),
    ...dependencyNativeResources(dependencyReport),
  ]) {
    const prior = byPath.get(expected.relative_path)
    if (prior && prior.kind !== expected.kind) throw new NativeResourceError('native_resource_kind')
    if (!prior) byPath.set(expected.relative_path, expected)
  }
  return [...byPath.values()].sort((left, right) => (
    left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0
  ))
}

export async function generateNativeResourceManifest({ resourcesRoot, targetId, dependencyReport }) {
  if (typeof resourcesRoot !== 'string' || resourcesRoot === '') {
    throw new NativeResourceError('resources_root_invalid')
  }
  const target = TARGETS[targetId]
  if (!target) throw new NativeResourceError('unsupported_target')
  const entries = []
  for (const expected of completeExpectedResources(targetId, dependencyReport)) {
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

async function readNativeManifest(resourcesRoot) {
  let handle
  try {
    handle = await open(
      resolve(resourcesRoot, 'native-resources-v1.json'),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    )
  } catch {
    throw new NativeResourceError('native_resource_manifest_missing')
  }
  try {
    const status = await handle.stat()
    if (!status.isFile() || status.size <= 0 || status.size > MAX_NATIVE_MANIFEST_BYTES) {
      throw new NativeResourceError('native_resource_manifest_invalid')
    }
    const body = Buffer.alloc(status.size)
    const { bytesRead } = await handle.read(body, 0, body.length, 0)
    if (bytesRead !== body.length) throw new NativeResourceError('native_resource_manifest_invalid')
    try {
      return parseStrictJson(body.toString('utf8'))
    } catch {
      throw new NativeResourceError('native_resource_manifest_invalid')
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

export async function verifyNativeResourceManifest({ resourcesRoot, targetId, dependencyReport }) {
  const target = TARGETS[targetId]
  if (!target) throw new NativeResourceError('unsupported_target')
  const manifest = await readNativeManifest(resourcesRoot)
  exactKeys(manifest, ['schema_version', 'target', 'resources'], 'native_resource_manifest_invalid')
  if (
    manifest.schema_version !== 1
    || manifest.target !== targetId
    || !Array.isArray(manifest.resources)
  ) throw new NativeResourceError('native_resource_manifest_invalid')
  const expected = completeExpectedResources(targetId, dependencyReport)
  if (manifest.resources.length !== expected.length) {
    throw new NativeResourceError('native_resource_manifest_invalid')
  }
  const ids = new Set()
  const paths = new Set()
  for (let index = 0; index < expected.length; index += 1) {
    const record = manifest.resources[index]
    const wanted = expected[index]
    exactKeys(record, [
      'logical_id', 'relative_path', 'byte_size', 'sha256', 'kind', 'platform',
      'architecture', 'electron_abi', 'build_contract_version',
    ], 'native_resource_manifest_invalid')
    if (
      record.logical_id !== wanted.id
      || record.relative_path !== wanted.relative_path
      || record.kind !== wanted.kind
      || record.platform !== target.platform
      || record.architecture !== target.architecture
      || record.electron_abi !== (wanted.kind === 'node_addon' ? 148 : null)
      || record.build_contract_version !== 1
      || !Number.isSafeInteger(record.byte_size)
      || record.byte_size <= 0
      || typeof record.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(record.sha256)
      || ids.has(record.logical_id)
      || paths.has(record.relative_path)
    ) throw new NativeResourceError('native_resource_manifest_invalid')
    ids.add(record.logical_id)
    paths.add(record.relative_path)
    const actual = await hashNativeFile(
      resolve(resourcesRoot, record.relative_path),
      target,
      record.kind,
    )
    if (actual.size !== record.byte_size || actual.sha256 !== record.sha256) {
      throw new NativeResourceError('native_resource_changed')
    }
  }
  const surface = await nativeSurface(resourcesRoot)
  if (
    surface.length !== paths.size
    || surface.some(path => !paths.has(path))
  ) throw new NativeResourceError('native_resource_orphan')
  return Object.freeze({
    target: targetId,
    resource_count: expected.length,
    manifest_sha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    resources: Object.freeze(manifest.resources.map(record => Object.freeze({
      logical_id: record.logical_id,
      relative_path: record.relative_path,
      sha256: record.sha256,
    }))),
  })
}
