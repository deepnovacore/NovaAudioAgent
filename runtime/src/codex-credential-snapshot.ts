import {constants as fsConstants, realpathSync, type BigIntStats} from 'node:fs'
import {
  chmod,
  lstat,
  open,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises'
import {createHash, randomUUID} from 'node:crypto'
import {basename, dirname, join, posix, win32} from 'node:path'

import {
  hostCodexHomeValue,
  refreshEphemeralCodexHomeIdentity,
  type HostCodexHome,
} from './codex-process-owner.js'
import {isWellFormed} from './python-text.js'

export const MAX_CREDENTIAL_BYTES = 1024 * 1024
export const MAX_CREDENTIAL_MARKER_BYTES = 4096
export const CODEX_CREDENTIAL_MARKER = '.nova-credential-source-v1.json'
export const CODEX_SAVED_LOGIN_FILES = Object.freeze(['auth.json', '.credentials.json'] as const)

export type CodexCredentialDiagnosticCode =
  | 'codex_credential_snapshot_private_home_failed'
  | 'codex_credential_snapshot_api_key_failed'
  | 'codex_credential_snapshot_saved_login_failed'
  | 'codex_credential_snapshot_environment_failed'

type CredentialPreparationPhase = 'private_home' | 'api_key' | 'saved_login' | 'environment'

const credentialSnapshotBrand: unique symbol = Symbol('CredentialSnapshot')
export interface CredentialSnapshot { readonly [credentialSnapshotBrand]: true }

interface SnapshotValue {
  readonly environment: Readonly<Record<string, string>>
}

interface OwnedFile {
  readonly content: Uint8Array
  readonly digest: string
  readonly mtimeNs: bigint
}

const snapshotValues = new WeakMap<CredentialSnapshot, SnapshotValue>()
const ENVIRONMENT_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
])
const fatalDecoder = new TextDecoder('utf-8', {fatal: true})

export class CodexCredentialError extends Error {
  readonly code = 'credential_missing' as const

  constructor() {
    super('credential_missing')
    this.name = 'CodexCredentialError'
  }
}

export class CredentialSnapshotter {
  readonly #environment: Readonly<Record<string, string>>
  readonly #platform: NodeJS.Platform
  readonly #sourceHome: string
  readonly #onDiagnostic: (code: CodexCredentialDiagnosticCode) => void

  constructor(options: {
    readonly environment: Readonly<Record<string, string | undefined>>
    readonly platform?: NodeJS.Platform
    readonly sourceHome?: string
    readonly onDiagnostic?: (code: CodexCredentialDiagnosticCode) => void
  }) {
    this.#environment = snapshotEnvironmentInput(options.environment)
    this.#platform = options.platform ?? process.platform
    this.#sourceHome = options.sourceHome
      ?? environmentValue(this.#environment, 'CODEX_HOME', this.#platform)
      ?? join(environmentValue(this.#environment, 'HOME', this.#platform) ?? '', '.codex')
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  async prepare(input: {
    readonly codexHome: HostCodexHome
    readonly apiKey: string | null
  }): Promise<CredentialSnapshot> {
    let phase: CredentialPreparationPhase = 'private_home'
    try {
      const home = hostCodexHomeValue(input.codexHome)
      if (home.ephemeral) await ensureEphemeralDirectory(input.codexHome)
      else await requirePrivateDirectory(home.path)
      phase = 'api_key'
      const apiKey = validateApiKey(input.apiKey)
      phase = 'saved_login'
      if (apiKey === null) await this.#syncSavedLogin(home.path)
      phase = 'environment'
      const environment = this.#childEnvironment(home.path, apiKey)
      const snapshot = Object.freeze({[credentialSnapshotBrand]: true as const})
      snapshotValues.set(snapshot, Object.freeze({environment}))
      return snapshot
    } catch {
      this.#emitDiagnostic(credentialDiagnosticForPhase(phase))
      throw new CodexCredentialError()
    }
  }

  #emitDiagnostic(code: CodexCredentialDiagnosticCode): void {
    try { this.#onDiagnostic(code) } catch { /* diagnostics must not affect credential handling */ }
  }

  async removeEphemeralHome(home: HostCodexHome): Promise<void> {
    await removeEphemeralHome(home)
  }

  environment(snapshot: CredentialSnapshot): Readonly<Record<string, string>> {
    return credentialSnapshotEnvironment(snapshot)
  }

  #childEnvironment(destinationHome: string, apiKey: string | null): Readonly<Record<string, string>> {
    const result: Record<string, string> = {}
    for (const name of ENVIRONMENT_ALLOWLIST) {
      const value = environmentValue(this.#environment, name, this.#platform)
      if (value !== undefined) defineString(result, name, value)
    }
    if (result.PATH === undefined || result.HOME === undefined) throw new CodexCredentialError()
    defineString(result, 'CODEX_HOME', destinationHome)
    defineString(result, 'CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED', '1')
    if (apiKey !== null) defineString(result, 'CODEX_API_KEY', apiKey)
    return Object.freeze(result)
  }

  async #syncSavedLogin(destinationHome: string): Promise<void> {
    if (this.#sourceHome === destinationHome) return
    const markerPath = join(destinationHome, CODEX_CREDENTIAL_MARKER)
    const marker = await readCredentialMarker(markerPath)
    let markerChanged = false
    for (const name of CODEX_SAVED_LOGIN_FILES) {
      const source = await readOwnedFile(join(this.#sourceHome, name), {
        maxBytes: MAX_CREDENTIAL_BYTES,
        requiredMode: null,
      })
      const destinationPath = join(destinationHome, name)
      const destination = await readOwnedFile(destinationPath, {
        maxBytes: MAX_CREDENTIAL_BYTES,
        requiredMode: 0o600,
      })
      if (source === null) continue
      const previousDigest = marker[name]
      let shouldReplace = destination === null
      if (destination !== null && previousDigest === undefined) {
        shouldReplace = !buffersEqual(destination.content, source.content)
          && source.mtimeNs > destination.mtimeNs
      } else if (destination !== null && previousDigest !== source.digest) {
        shouldReplace = true
      }
      if (shouldReplace) await atomicOwnerWrite(destinationPath, source.content)
      if (previousDigest !== source.digest) {
        marker[name] = source.digest
        markerChanged = true
      }
    }
    if (markerChanged) {
      const raw = encodeCredentialMarker(marker)
      if (raw.byteLength > MAX_CREDENTIAL_MARKER_BYTES) throw new CodexCredentialError()
      await atomicOwnerWrite(markerPath, raw)
    }
  }
}

export function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return environment[name]
  const normalizedName = name.toUpperCase()
  let result: string | undefined
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() !== normalizedName || value === undefined) continue
    if (result !== undefined && result !== value) throw new CodexCredentialError()
    result = value
  }
  if (result !== undefined || normalizedName !== 'HOME') return result
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() !== 'USERPROFILE' || value === undefined) continue
    if (result !== undefined && result !== value) throw new CodexCredentialError()
    result = value
  }
  return result
}

function credentialDiagnosticForPhase(
  phase: CredentialPreparationPhase,
): CodexCredentialDiagnosticCode {
  switch (phase) {
    case 'private_home': return 'codex_credential_snapshot_private_home_failed'
    case 'api_key': return 'codex_credential_snapshot_api_key_failed'
    case 'saved_login': return 'codex_credential_snapshot_saved_login_failed'
    case 'environment': return 'codex_credential_snapshot_environment_failed'
  }
}

/** Test-only scheduler seam for proving cleanup identity remains bound across a rename race. */
export async function removeEphemeralHomeWithRaceHookForTest(
  home: HostCodexHome,
  afterIdentityCheck: (path: string) => Promise<void>,
): Promise<void> {
  await removeEphemeralHome(home, afterIdentityCheck)
}

async function removeEphemeralHome(
  home: HostCodexHome,
  afterQuarantineRename?: (path: string) => Promise<void>,
): Promise<void> {
  try {
    const selected = hostCodexHomeValue(home)
    if (!selected.ephemeral) return
    const identity = selected.identity
    if (identity === null) throw new CodexCredentialError()
    let cleanupPath = selected.cleanupPath
    if (cleanupPath === null) {
      let linkInfo
      try { linkInfo = await lstat(selected.path, {bigint: true}) }
      catch (error) { if (isErrno(error, 'ENOENT')) return; throw error }
      requireCleanupIdentity(selected.path, linkInfo, identity)
      if (process.platform !== 'win32') await chmod(selected.path, 0o700)
      requireCleanupIdentity(
        selected.path,
        await lstat(selected.path, {bigint: true}),
        identity,
      )
      cleanupPath = join(
        dirname(selected.path),
        `.${basename(selected.path)}.nova-delete-${randomUUID().replaceAll('-', '')}`,
      )
      try {
        await lstat(cleanupPath)
        throw new CodexCredentialError()
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
      await rename(selected.path, cleanupPath)
      selected.cleanupPath = cleanupPath
      await afterQuarantineRename?.(cleanupPath)
    }
    const quarantined = await lstat(cleanupPath, {bigint: true})
    requireCleanupIdentity(cleanupPath, quarantined, identity)
    if (process.platform !== 'win32') await chmod(cleanupPath, 0o700)
    await requirePrivateDirectory(cleanupPath)
    requireCleanupIdentity(cleanupPath, await lstat(cleanupPath, {bigint: true}), identity)
    // Security precondition: the transport calls this only after the one owned app-server tree is
    // confirmed gone. Node has no fd-relative recursive removal API, so the private-parent,
    // quarantine rename, and device/inode capability bind the path once that sole actor is dead.
    await rm(cleanupPath, {recursive: true, force: false})
    selected.cleanupPath = null
  } catch {
    throw new CodexCredentialError()
  }
}

function requireCleanupIdentity(
  path: string,
  linkInfo: BigIntStats,
  identity: {readonly device: bigint; readonly inode: bigint; readonly uid: number},
): void {
  const invalid = linkInfo.isSymbolicLink()
    || !linkInfo.isDirectory()
    || linkInfo.dev !== identity.device
    || linkInfo.ino !== identity.inode
    || Number(linkInfo.uid) !== identity.uid
    || !ownerMatches(Number(linkInfo.uid))
    // Use the same sync canonicalization domain that minted the cleanup
    // capability. Windows async realpath can expand an 8.3 alias differently
    // from realpathSync even though the device/inode identity is unchanged.
    || realpathSync(path) !== path
  if (invalid) throw new CodexCredentialError()
}

export function credentialSnapshotEnvironment(snapshot: CredentialSnapshot): Readonly<Record<string, string>> {
  const value = snapshotValues.get(snapshot)
  if (value === undefined) throw new CodexCredentialError()
  return value.environment
}

/** Test-only integration seam. It does not expose credential bodies or marker digests. */
export async function prepareCodexCredentialSnapshotForTest(
  input: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const sourceHome = requireString(input.sourceHome)
  const destinationHome = requireString(input.destinationHome)
  const environment = requireEnvironmentInput(input.environment)
  const apiKey = input.apiKey === null ? null : requireString(input.apiKey)
  const {hostCodexHomeForTest} = await import('./codex-process-owner.js')
  const home = hostCodexHomeForTest(destinationHome, {ephemeral: true})
  const snapshotter = new CredentialSnapshotter({sourceHome, environment})
  const snapshot = await snapshotter.prepare({codexHome: home, apiKey})
  return {environment: {...credentialSnapshotEnvironment(snapshot)}}
}

async function requirePrivateDirectory(path: string): Promise<void> {
  const [linkInfo, fileInfo] = await Promise.all([
    lstat(path),
    stat(path),
  ])
  if (
    linkInfo.isSymbolicLink()
    || !fileInfo.isDirectory()
    || realpathSync(path) !== path
    || (!ownerMatches(fileInfo.uid))
    || (process.platform !== 'win32' && (fileInfo.mode & 0o777) !== 0o700)
  ) throw new CodexCredentialError()
}

async function ensureEphemeralDirectory(homeValue: HostCodexHome): Promise<void> {
  const {path} = hostCodexHomeValue(homeValue)
  try {
    await requirePrivateDirectory(path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
    const {mkdir} = await import('node:fs/promises')
    await mkdir(path, {mode: 0o700})
    await chmod(path, 0o700)
    await requirePrivateDirectory(path)
    refreshEphemeralCodexHomeIdentity(homeValue)
  }
}

async function readOwnedFile(
  path: string,
  options: {readonly maxBytes: number; readonly requiredMode: number | null},
): Promise<OwnedFile | null> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  let handle: FileHandle
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw error
  }
  try {
    const info = await handle.stat({bigint: true})
    const mode = Number(info.mode)
    if (
      !info.isFile()
      || !ownerMatches(Number(info.uid))
      || info.size > BigInt(options.maxBytes)
      || (process.platform !== 'win32' && (mode & 0o022) !== 0)
      || (
        process.platform !== 'win32'
        && options.requiredMode !== null
        && (mode & 0o777) !== options.requiredMode
      )
    ) throw new CodexCredentialError()
    const buffer = new Uint8Array(options.maxBytes + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const {bytesRead} = await handle.read(buffer, offset, buffer.byteLength - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > options.maxBytes) throw new CodexCredentialError()
    const content = buffer.slice(0, offset)
    return Object.freeze({
      content,
      digest: createHash('sha256').update(content).digest('hex'),
      mtimeNs: info.mtimeNs,
    })
  } finally {
    await handle.close()
  }
}

async function readCredentialMarker(path: string): Promise<Record<string, string>> {
  const snapshot = await readOwnedFile(path, {
    maxBytes: MAX_CREDENTIAL_MARKER_BYTES,
    requiredMode: 0o600,
  })
  if (snapshot === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(fatalDecoder.decode(snapshot.content)) as unknown
  } catch {
    throw new CodexCredentialError()
  }
  if (!isPlainRecord(parsed)) throw new CodexCredentialError()
  const result: Record<string, string> = {}
  for (const [name, digest] of Object.entries(parsed)) {
    if (!CODEX_SAVED_LOGIN_FILES.includes(name as typeof CODEX_SAVED_LOGIN_FILES[number])) {
      throw new CodexCredentialError()
    }
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)) {
      throw new CodexCredentialError()
    }
    defineString(result, name, digest)
  }
  return result
}

function encodeCredentialMarker(marker: Readonly<Record<string, string>>): Uint8Array {
  const fields: string[] = []
  for (const name of ['.credentials.json', 'auth.json'] as const) {
    const digest = marker[name]
    if (digest !== undefined) fields.push(`"${name}":"${digest}"`)
  }
  return new TextEncoder().encode(`{${fields.join(',')}}`)
}

async function atomicOwnerWrite(path: string, content: Uint8Array): Promise<void> {
  const {directory, filename} = splitAtomicTarget(path, process.platform)
  const temporary = join(directory, `.${filename}.${randomUUID().replaceAll('-', '')}.tmp`)
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  let handle: FileHandle | undefined
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    )
    await handle.chmod(0o600)
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await chmod(path, 0o600)
    if (process.platform !== 'win32') {
      const parent = await open(directory, fsConstants.O_RDONLY)
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    }
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined)
    await rm(temporary, {force: true}).catch(() => undefined)
  }
}

/** Test-only Windows path contract used before the native guardian ships. */
export function splitCredentialAtomicTargetForTest(
  path: string,
  platform: 'win32' | 'posix',
): Readonly<{directory: string; filename: string}> {
  return splitAtomicTarget(path, platform)
}

function splitAtomicTarget(
  path: string,
  platform: NodeJS.Platform | 'posix',
): Readonly<{directory: string; filename: string}> {
  const pathApi = platform === 'win32' ? win32 : posix
  return Object.freeze({directory: pathApi.dirname(path), filename: pathApi.basename(path)})
}

function snapshotEnvironmentInput(
  value: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const result: Record<string, string> = {}
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new CodexCredentialError()
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new CodexCredentialError()
    }
    const field = descriptor.value as unknown
    if (field === undefined) continue
    if (typeof field !== 'string' || !isWellFormed(field) || field.includes('\0')) {
      throw new CodexCredentialError()
    }
    defineString(result, key, field)
  }
  return Object.freeze(result)
}

function requireEnvironmentInput(value: unknown): Readonly<Record<string, string>> {
  if (!isPlainRecord(value)) throw new CodexCredentialError()
  return value as Record<string, string>
}

function validateApiKey(value: string | null): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value === '' || !isWellFormed(value) || value.includes('\0')) {
    throw new CodexCredentialError()
  }
  return value
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || !isWellFormed(value)) throw new CodexCredentialError()
  return value
}

function buffersEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function ownerMatches(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid()
}

function defineString(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
