import {snapshotRegularFile, sameSnapshot, type FileSnapshot} from '../storage/native-resource-snapshot.js'
import {createProjectNodeFiles} from './project-node-files.js'
import {constants as fsConstants} from 'node:fs'
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {basename, dirname, isAbsolute, join, resolve, type PlatformPath} from 'node:path'

import type {NativeFileLockAuthority} from '../storage/native-file-lock.js'
import type {
  ProjectRootFileAuthority,
} from './project-root-file.js'

const PROJECT_ADDON_PATH = 'native/project-native/nova_project_native.node'
const PROJECT_ADDON_ID = 'project_native_addon'
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_ADDON_BYTES = 16 * 1024 * 1024
const MODULE_EXPORTS = Object.freeze(['acquire', 'syncDirectory'] as const)

export interface ProjectDirectoryHandle {
  readonly fd: number
  close(): void
}

export interface ProjectNativeHost {
  readonly nativeLocks: NativeFileLockAuthority
  readonly rootFiles: ProjectRootFileAuthority
  readonly directoryHandles: Readonly<{
    open(path: string): ProjectDirectoryHandle
  }>
  /** Protects a retained child selected by the host and verified against its parent. */
  protectDirectoryAt(root: number, name: string, child: number): boolean
  /** Prepares a retained managed container without blocking inherited traversal access. */
  prepareManagedDirectoryAt(root: number, name: string, child: number): boolean
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
    directoryHandles?: Readonly<{open(path: string): ProjectDirectoryHandle}>
  }>,
): boolean {
  const joinPath = (...parts: string[]): string => paths.pathApi?.join(...parts) ?? join(...parts)
  const dirnamePath = (path: string): string => paths.pathApi?.dirname(path) ?? dirname(path)
  const basenamePath = (path: string): string => paths.pathApi?.basename(path) ?? basename(path)
  const handles = paths.directoryHandles ?? host.directoryHandles
  const productRoot = joinPath(paths.homeDirectory, '.nova-audio-agent')
  const defaultManagedRoot = joinPath(productRoot, 'workspaces')
  const defaults = new Set([
    joinPath(productRoot, 'state'),
    defaultManagedRoot,
    joinPath(productRoot, 'workspaces', 'default'),
  ])
  for (const path of [paths.stateRoot, paths.managedRoot, paths.workspace]) {
    if (path !== null && defaults.has(path) && !protectDefaultDirectory(
      host,
      dirnamePath(path),
      basenamePath(path),
      path,
      handles,
      path === defaultManagedRoot,
    )) return false
  }
  return true
}

function protectDefaultDirectory(
  host: ProjectNativeHost,
  parentPath: string,
  name: string,
  path: string,
  handles: Readonly<{open(path: string): ProjectDirectoryHandle}>,
  managed: boolean,
): boolean {
  let parent: ProjectDirectoryHandle | null = null
  let child: ProjectDirectoryHandle | null = null
  let protectedDirectory = false
  let closed = true
  try {
    parent = handles.open(parentPath)
    child = handles.open(path)
    if (
      !Number.isSafeInteger(parent.fd) || parent.fd < 0
      || !Number.isSafeInteger(child.fd) || child.fd < 0
    ) return false
    protectedDirectory = managed
      ? host.prepareManagedDirectoryAt(parent.fd, name, child.fd)
      : host.protectDirectoryAt(parent.fd, name, child.fd)
  } catch {
    protectedDirectory = false
  } finally {
    if (child !== null) {
      try { child.close() } catch { closed = false }
    }
    if (parent !== null) {
      try { parent.close() } catch { closed = false }
    }
  }
  return protectedDirectory && closed
}

interface ProjectNativeLoadOptions {
  readonly resourcesPath: string
  readonly platform: string
  readonly arch: string
  readonly electronAbi: string | undefined
  readonly moduleLoader?: (path: string) => unknown
}

export type ProjectNativeHostLoadResult =
  | Readonly<{readonly status: 'absent'; readonly host: null}>
  | Readonly<{readonly status: 'present_failure'; readonly host: null}>
  | Readonly<{readonly status: 'loaded'; readonly host: ProjectNativeHost}>

/** Host-only seam. Renderer/model/work-order values never enter these options. */
export function loadProjectNativeHostFromResources(
  options: ProjectNativeLoadOptions,
): ProjectNativeHost | null {
  return inspectProjectNativeHostFromResources(options).host
}

/** Preserves whether a supported native authority failed validation or is unsupported. */
export function inspectProjectNativeHostFromResources(
  options: ProjectNativeLoadOptions,
): ProjectNativeHostLoadResult {
  if (supportedTarget(options.platform, options.arch) === null) {
    return Object.freeze({status: 'absent', host: null})
  }
  const host = loadSupportedProjectNativeHostFromResources(options)
  return host === null
    ? Object.freeze({status: 'present_failure', host: null})
    : Object.freeze({status: 'loaded', host})
}

function loadSupportedProjectNativeHostFromResources(
  options: ProjectNativeLoadOptions,
): ProjectNativeHost | null {
  try {
    const target = supportedTarget(options.platform, options.arch)
    if (target === null || !isAbsolute(options.resourcesPath)) return null
    const resourcesRoot = resolve(options.resourcesPath)
    if (realpathSync(resourcesRoot) !== resourcesRoot) return null
    const manifestSnapshot = snapshotRegularFile(
      resolve(resourcesRoot, 'native-resources-v1.json'),
      MAX_MANIFEST_BYTES,
    )
    const manifest = JSON.parse(manifestSnapshot.bytes.toString('utf8')) as unknown
    const record = requireProjectRecord(manifest, target, options.platform, options.arch, options.electronAbi)
    const addonPath = resolve(resourcesRoot, PROJECT_ADDON_PATH)
    if (realpathSync(addonPath) !== addonPath) return null
    const before = snapshotRegularFile(addonPath, MAX_ADDON_BYTES)
    if (before.size !== record.byte_size || before.sha256 !== record.sha256) return null
    if (!validBinary(before.bytes, options.platform, options.arch)) return null
    const materialized = materializeAddonSnapshot(before)
    let addon: ProjectAddon | null
    try {
      addon = requireAddon(
        (options.moduleLoader ?? defaultModuleLoader)(materialized.path), options.platform,
      )
      if (addon === null || !sameSnapshot(materialized.snapshot, snapshotRegularFile(
        materialized.path,
        MAX_ADDON_BYTES,
      ))) return null
    } finally {
      materialized.cleanup()
    }
    const after = snapshotRegularFile(addonPath, MAX_ADDON_BYTES)
    if (!sameSnapshot(before, after)) return null
    const rootFiles = createProjectNodeFiles(options.platform === 'win32' ? addon.syncDirectory : undefined)
    const directoryHandles = {
      open(path: string): ProjectDirectoryHandle {
        const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
        try { rootFiles.bindDirectory!(fd, path) }
        catch (error) { closeSync(fd); throw error }
        let closed = false
        return {fd, close() { if (!closed) { closed = true; rootFiles.unbindDirectory!(fd); closeSync(fd) } }}
      },
    }
    return {
      nativeLocks: {acquire: descriptor => addon.acquire(descriptor)},
      rootFiles,
      directoryHandles,
      protectDirectoryAt: (root, name, child) => rootFiles.protectAt!(root, name, child).status === 'ok',
      prepareManagedDirectoryAt: (root, name, child) => rootFiles.matchesAt(root, name, child).status === 'ok',
      mkdirPrivateAt: (root, name) => rootFiles.mkdirAt(root, name),
    }
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

interface ProjectRecord {
  readonly byte_size: number
  readonly sha256: string
}

function requireProjectRecord(
  manifest: unknown,
  target: string,
  platform: string,
  arch: string,
  electronAbi: string | undefined,
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
  for (const resource of manifest.resources as readonly unknown[]) {
    requireExactRecord(resource, [
      'logical_id', 'relative_path', 'byte_size', 'sha256', 'kind', 'platform',
      'architecture', 'electron_abi', 'build_contract_version',
      ...(typeof resource === 'object' && resource !== null && 'kind' in resource && resource.kind === 'node_addon' && Object.hasOwn(resource, 'node_api_version') ? ['node_api_version'] : []),
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
      || (Object.hasOwn(resource, 'node_api_version')
        ? resource.node_api_version !== 10 || resource.electron_abi !== null || Number(process.versions.napi ?? 0) < 10
        : resource.electron_abi !== 148 || electronAbi !== '148')
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

type ProjectAddon = NativeFileLockAuthority & {syncDirectory?: (fd: number) => {status: 'ok' | 'failed'}}

function requireAddon(value: unknown, platform: string): ProjectAddon | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const expected = platform === 'win32' ? MODULE_EXPORTS : ['acquire'] as const
  if (Object.keys(descriptors).sort().join('\0') !== expected.join('\0')) return null
  const methods: Partial<Record<(typeof MODULE_EXPORTS)[number], (...args: never[]) => unknown>> = {}
  for (const name of expected) {
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
