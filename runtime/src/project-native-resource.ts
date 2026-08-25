import {createHash} from 'node:crypto'
import {constants as fsConstants} from 'node:fs'
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {isAbsolute, join, resolve, type PlatformPath} from 'node:path'

import type {NativeFileLockAuthority} from './native-file-lock.js'
import type {
  ProjectFileIdentity,
  ProjectRootFileAuthority,
  ProjectRootFileCreateResult,
  ProjectRootFileResult,
} from './project-root-file.js'

const PROJECT_ADDON_PATH = 'native/project-native/nova_project_native.node'
const PROJECT_ADDON_ID = 'project_native_addon'
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_ADDON_BYTES = 16 * 1024 * 1024
const MODULE_EXPORTS = Object.freeze([
  'acquire', 'createFileAt', 'lookupAt', 'matchesAt', 'mkdirAt', 'mkdirPrivateAt', 'probe', 'protectAt', 'protectDirectory',
  'renameAt', 'unlinkAt',
])

export interface ProjectNativeHost {
  readonly nativeLocks: NativeFileLockAuthority
  readonly rootFiles: ProjectRootFileAuthority
  /** Protects only a host-selected canonical application directory. */
  protectDirectory(path: string): boolean
  /** Protects a retained child selected descriptor-relatively by the host. */
  protectDirectoryAt(root: number, name: string, child: number): boolean
  /** Creates a protected private child below an owned, not-yet-private parent. */
  mkdirPrivateAt(root: number, name: string): unknown
}

export function protectDefaultProjectDirectories(
  host: ProjectNativeHost,
  paths: Readonly<{
    homeDirectory: string
    stateRoot: string | null
    managedRoot: string | null
    workspace: string | null
    pathApi?: PlatformPath
  }>,
): boolean {
  const joinPath = (...parts: string[]): string => paths.pathApi?.join(...parts) ?? join(...parts)
  const productRoot = joinPath(paths.homeDirectory, '.nova-audio-agent')
  const defaults = new Set([
    joinPath(productRoot, 'state'),
    joinPath(productRoot, 'workspaces'),
    joinPath(productRoot, 'workspaces', 'default'),
  ])
  for (const path of [paths.stateRoot, paths.managedRoot, paths.workspace]) {
    if (path !== null && defaults.has(path) && !host.protectDirectory(path)) return false
  }
  return true
}

interface ProjectNativeLoadOptions {
  readonly resourcesPath: string
  readonly platform: string
  readonly arch: string
  readonly electronAbi: string | undefined
  readonly moduleLoader?: (path: string) => unknown
}

interface FileSnapshot {
  readonly bytes: Buffer
  readonly device: bigint
  readonly inode: bigint
  readonly size: number
  readonly sha256: string
}

export function loadPackagedProjectNativeHost(): ProjectNativeHost | null {
  const resourcesPath = (process as NodeJS.Process & {readonly resourcesPath?: unknown}).resourcesPath
  if (typeof resourcesPath !== 'string' || resourcesPath === '') return null
  return loadProjectNativeHostFromResources({
    resourcesPath,
    platform: process.platform,
    arch: process.arch,
    electronAbi: process.versions.modules,
  })
}

/** Host-only seam. Renderer/model/work-order values never enter these options. */
export function loadProjectNativeHostFromResources(
  options: ProjectNativeLoadOptions,
): ProjectNativeHost | null {
  try {
    if (options.electronAbi !== '148') return null
    const target = supportedTarget(options.platform, options.arch)
    if (target === null || !isAbsolute(options.resourcesPath)) return null
    const resourcesRoot = resolve(options.resourcesPath)
    if (realpathSync(resourcesRoot) !== resourcesRoot) return null
    const manifestSnapshot = snapshotRegularFile(
      resolve(resourcesRoot, 'native-resources-v1.json'),
      MAX_MANIFEST_BYTES,
    )
    const manifest = JSON.parse(manifestSnapshot.bytes.toString('utf8')) as unknown
    const record = requireProjectRecord(manifest, target, options.platform, options.arch)
    const addonPath = resolve(resourcesRoot, PROJECT_ADDON_PATH)
    if (realpathSync(addonPath) !== addonPath) return null
    const before = snapshotRegularFile(addonPath, MAX_ADDON_BYTES)
    if (before.size !== record.byte_size || before.sha256 !== record.sha256) return null
    if (!validBinary(before.bytes, options.platform, options.arch)) return null
    const materialized = materializeAddonSnapshot(before)
    let addon: ProjectAddon | null
    try {
      addon = requireAddon((options.moduleLoader ?? defaultModuleLoader)(materialized.path))
      if (addon === null || !sameSnapshot(materialized.snapshot, snapshotRegularFile(
        materialized.path,
        MAX_ADDON_BYTES,
      ))) return null
    } finally {
      materialized.cleanup()
    }
    const after = snapshotRegularFile(addonPath, MAX_ADDON_BYTES)
    if (!sameSnapshot(before, after)) return null
    const nativeLocks: NativeFileLockAuthority = Object.freeze({
      acquire: (descriptor: number) => addon.acquire(descriptor),
    })
    const rootFiles: ProjectRootFileAuthority = Object.freeze({
      probe: (descriptor: number) => addon.probe(descriptor),
      matchesAt: (root: number, name: string, child: number) => addon.matchesAt(root, name, child),
      lookupAt: (root: number, name: string) => addon.lookupAt(root, name),
      createFileAt: (root: number, name: string, exclusive: boolean) => (
        addon.createFileAt(root, name, exclusive)
      ),
      mkdirAt: (root: number, name: string) => addon.mkdirAt(root, name),
      mkdirPrivateAt: (root: number, name: string) => addon.mkdirPrivateAt(root, name),
      protectAt: (root: number, name: string, child: number) => addon.protectAt(root, name, child),
      renameAt: (root: number, from: string, to: string) => addon.renameAt(root, from, to),
      unlinkAt: (
        root: number,
        name: string,
        identity: ProjectFileIdentity,
        kind: 'file' | 'directory',
      ) => addon.unlinkAt(root, name, identity, kind),
    })
    return Object.freeze({
      nativeLocks,
      rootFiles,
      protectDirectory: (path: string) => {
        const result: unknown = addon.protectDirectory(path)
        return isStatus(result, 'ok')
      },
      protectDirectoryAt: (root: number, name: string, child: number) => {
        const result: unknown = addon.protectAt(root, name, child)
        return isStatus(result, 'ok')
      },
      mkdirPrivateAt: (root: number, name: string) => addon.mkdirPrivateAt(root, name),
    })
  } catch {
    return null
  }
}

const defaultModuleLoader = (path: string): unknown => createRequire(import.meta.url)(path) as unknown

function materializeAddonSnapshot(snapshot: FileSnapshot): Readonly<{
  path: string
  snapshot: FileSnapshot
  cleanup(): void
}> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'nova-project-native-')))
  chmodSync(directory, 0o700)
  const path = join(directory, 'nova_project_native.node')
  try {
    writeFileSync(path, snapshot.bytes, {flag: 'wx', mode: 0o500})
    chmodSync(path, 0o500)
    const canonical = realpathSync(path)
    const copied = snapshotRegularFile(canonical, MAX_ADDON_BYTES)
    if (copied.size !== snapshot.size || copied.sha256 !== snapshot.sha256) throw new Error()
    return Object.freeze({
      path: canonical,
      snapshot: copied,
      cleanup: () => {
        try { rmSync(directory, {recursive: true, force: true}) } catch { /* loaded DLL cleanup is retried by OS temp cleanup */ }
      },
    })
  } catch (error) {
    try { rmSync(directory, {recursive: true, force: true}) } catch { /* best effort */ }
    throw error
  }
}

function supportedTarget(platform: string, arch: string): string | null {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `darwin-${arch}`
  if (platform === 'linux' && arch === 'x64') return 'linux-x64-gnu'
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  return null
}

function snapshotRegularFile(path: string, maximumBytes: number): FileSnapshot {
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(descriptor, {bigint: true})
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximumBytes)) {
      throw new Error('native resource rejected')
    }
    const size = Number(before.size)
    const bytes = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset)
      if (count === 0) throw new Error('native resource rejected')
      offset += count
    }
    const after = fstatSync(descriptor, {bigint: true})
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error('native resource rejected')
    }
    return Object.freeze({
      bytes,
      device: before.dev,
      inode: before.ino,
      size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  } finally {
    closeSync(descriptor)
  }
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.sha256 === right.sha256
}

interface ProjectRecord {
  readonly byte_size: number
  readonly sha256: string
}

function requireProjectRecord(
  manifest: unknown,
  target: string,
  platform: string,
  arch: string,
): ProjectRecord {
  requireExactRecord(manifest, ['schema_version', 'target', 'resources'])
  if (manifest.schema_version !== 1 || manifest.target !== target || !Array.isArray(manifest.resources)) {
    throw new Error('native resource rejected')
  }
  if (manifest.resources.length === 0 || manifest.resources.length > 256) {
    throw new Error('native resource rejected')
  }
  let selected: ProjectRecord | null = null
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const resource of manifest.resources) {
    requireExactRecord(resource, [
      'logical_id', 'relative_path', 'byte_size', 'sha256', 'kind', 'platform',
      'architecture', 'electron_abi', 'build_contract_version',
    ])
    if (
      typeof resource.logical_id !== 'string'
      || typeof resource.relative_path !== 'string'
      || ids.has(resource.logical_id)
      || paths.has(resource.relative_path)
    ) throw new Error('native resource rejected')
    ids.add(resource.logical_id)
    paths.add(resource.relative_path)
    if (resource.logical_id !== PROJECT_ADDON_ID) continue
    if (
      resource.relative_path !== PROJECT_ADDON_PATH
      || resource.kind !== 'node_addon'
      || resource.platform !== platform
      || resource.architecture !== arch
      || resource.electron_abi !== 148
      || resource.build_contract_version !== 1
      || typeof resource.byte_size !== 'number'
      || !Number.isSafeInteger(resource.byte_size)
      || resource.byte_size <= 0
      || typeof resource.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(resource.sha256)
      || selected !== null
    ) throw new Error('native resource rejected')
    selected = {byte_size: resource.byte_size, sha256: resource.sha256}
  }
  if (selected === null) throw new Error('native resource rejected')
  return selected
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')
  ) throw new Error('native resource rejected')
}

function validBinary(bytes: Buffer, platform: string, arch: string): boolean {
  if (platform === 'darwin') {
    const cpu = arch === 'arm64' ? 0x0100000c : 0x01000007
    return bytes.length >= 16
      && bytes.readUInt32LE(0) === 0xfeedfacf
      && bytes.readUInt32LE(4) === cpu
      && (bytes.readUInt32LE(12) === 8 || bytes.readUInt32LE(12) === 6)
  }
  if (platform === 'linux') {
    return bytes.length >= 20
      && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      && bytes[4] === 2
      && bytes[5] === 1
      && bytes.readUInt16LE(18) === 0x3e
  }
  if (bytes.length < 64 || bytes.subarray(0, 2).toString('ascii') !== 'MZ') return false
  const offset = bytes.readUInt32LE(0x3c)
  return offset + 24 <= bytes.length
    && bytes.subarray(offset, offset + 4).toString('binary') === 'PE\0\0'
    && bytes.readUInt16LE(offset + 4) === 0x8664
    && (bytes.readUInt16LE(offset + 22) & 0x2000) !== 0
}

interface ProjectAddon extends NativeFileLockAuthority, ProjectRootFileAuthority {
  protectDirectory(path: string): unknown
  protectAt(root: number, name: string, child: number): ProjectRootFileResult
  mkdirPrivateAt(root: number, name: string): ProjectRootFileCreateResult
}

function isStatus(value: unknown, status: string): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const descriptor = descriptors.status
  if (Object.keys(descriptors).length !== 1 || descriptor?.enumerable !== true) return false
  return Object.hasOwn(descriptor, 'value') && descriptor.value === status
}

function requireAddon(value: unknown): ProjectAddon | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(descriptors).sort().join('\0') !== MODULE_EXPORTS.join('\0')) return null
  const methods: Partial<Record<(typeof MODULE_EXPORTS)[number], (...args: never[]) => unknown>> = {}
  for (const name of MODULE_EXPORTS) {
    const descriptor = descriptors[name]
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function'
    ) return null
    methods[name] = descriptor.value as (...args: never[]) => unknown
  }
  return methods as unknown as ProjectAddon
}
