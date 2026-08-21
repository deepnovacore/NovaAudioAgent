import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'

const MAX_NATIVE_BYTES = 256 * 1024 * 1024
const TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({ platform: 'darwin', architecture: 'arm64', suffix: 'darwin-arm64' }),
  'darwin-x64': Object.freeze({ platform: 'darwin', architecture: 'x64', suffix: 'darwin-x64' }),
  'win32-x64': Object.freeze({ platform: 'win32', architecture: 'x64', suffix: 'win32-x64-msvc' }),
  'linux-x64-gnu': Object.freeze({ platform: 'linux', architecture: 'x64', suffix: 'linux-x64-gnu' }),
})

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
  )
  return Object.freeze(resources)
}

function assertBinaryHeader(header, target) {
  if (target.platform === 'darwin') {
    if (header.length < 8 || header.readUInt32LE(0) !== 0xfeedfacf) {
      throw new NativeResourceError('native_resource_format')
    }
    const expectedCpu = target.architecture === 'arm64' ? 0x0100000c : 0x01000007
    if (header.readUInt32LE(4) !== expectedCpu) throw new NativeResourceError('native_resource_arch')
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
}

async function hashNativeFile(path, target) {
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
    const header = Buffer.alloc(Math.min(4096, before.size))
    await handle.read(header, 0, header.length, 0)
    assertBinaryHeader(header, target)
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

export async function generateNativeResourceManifest({ resourcesRoot, targetId }) {
  if (typeof resourcesRoot !== 'string' || resourcesRoot === '') {
    throw new NativeResourceError('resources_root_invalid')
  }
  const target = TARGETS[targetId]
  if (!target) throw new NativeResourceError('unsupported_target')
  const entries = []
  for (const expected of expectedNativeResources(targetId)) {
    const identity = await hashNativeFile(resolve(resourcesRoot, expected.relative_path), target)
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
