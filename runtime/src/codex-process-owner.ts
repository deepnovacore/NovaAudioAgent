import {lstatSync, realpathSync, statSync} from 'node:fs'
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process'
import {isAbsolute} from 'node:path'
import type {Readable, Writable} from 'node:stream'

import {isWellFormed} from './python-text.js'

const hostBinaryBrand: unique symbol = Symbol('HostBinary')
const hostWorkspaceBrand: unique symbol = Symbol('HostWorkspace')
const hostCodexHomeBrand: unique symbol = Symbol('HostCodexHome')
const approvedSpawnBrand: unique symbol = Symbol('ApprovedSpawnSpec')

export interface HostBinary { readonly [hostBinaryBrand]: true }
export interface HostWorkspace { readonly [hostWorkspaceBrand]: true }
export interface HostCodexHome { readonly [hostCodexHomeBrand]: true }
export interface ApprovedSpawnSpec { readonly [approvedSpawnBrand]: true }

interface CodexHomeValue {
  readonly path: string
  readonly ephemeral: boolean
  identity: EphemeralHomeIdentity | null
  cleanupPath: string | null
}

interface EphemeralHomeIdentity {
  readonly device: bigint
  readonly inode: bigint
  readonly uid: number
}

const binaryValues = new WeakMap<HostBinary, string>()
const workspaceValues = new WeakMap<HostWorkspace, string>()
const homeValues = new WeakMap<HostCodexHome, CodexHomeValue>()
const spawnValues = new WeakMap<ApprovedSpawnSpec, ApprovedSpawnDetails>()
const unconfirmedOwnerErrors = new WeakMap<CodexProcessOwnerError, OwnedCodexProcess>()

export const CODEX_APP_SERVER_ARGV: readonly string[] = Object.freeze([
  '-a', 'never',
  '--disable', 'hooks',
  '--disable', 'multi_agent',
  '--disable', 'apps',
  '--disable', 'plugins',
  '--disable', 'remote_plugin',
  '--disable', 'plugin_sharing',
  '--disable', 'tool_suggest',
  '-c', 'web_search="disabled"',
  '-c', 'default_permissions="nova_audio_agent"',
  '-c', 'permissions.nova_audio_agent={ filesystem = { ":root" = "read", ":workspace_roots" = { "." = "write", ".git" = "read", ".agents" = "read", ".codex" = "read" } }, network = { enabled = false } }',
  '-c', 'shell_environment_policy.inherit="core"',
  '-c', 'shell_environment_policy.include_only=["PATH","LANG","LC_ALL","TERM"]',
  '-c', 'mcp_servers={}',
  'app-server', '--strict-config', '--stdio',
])

const CHILD_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'CODEX_HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'CODEX_API_KEY',
  'CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED',
])

export class CodexProcessOwnerError extends Error {
  readonly code: 'spawn_failed' | 'workspace_invalid'

  constructor(code: 'spawn_failed' | 'workspace_invalid') {
    super(code)
    this.name = 'CodexProcessOwnerError'
    this.code = code
  }
}

export function unconfirmedCodexProcessOwnerError(owner: OwnedCodexProcess): CodexProcessOwnerError {
  const error = new CodexProcessOwnerError('spawn_failed')
  unconfirmedOwnerErrors.set(error, owner)
  return error
}

export function takeUnconfirmedCodexProcessOwner(error: unknown): OwnedCodexProcess | null {
  if (!(error instanceof CodexProcessOwnerError)) return null
  const owner = unconfirmedOwnerErrors.get(error) ?? null
  unconfirmedOwnerErrors.delete(error)
  return owner
}

export function hostBinaryFromConfig(
  configured: string,
  allowlistedCanonicalBinaries: readonly string[],
): HostBinary {
  const canonical = requireCanonicalRegularFile(configured, 'spawn_failed')
  if (!allowlistedCanonicalBinaries.some(candidate => safeCanonicalPath(candidate) === canonical)) {
    throw new CodexProcessOwnerError('spawn_failed')
  }
  return brandBinary(canonical)
}

export function hostWorkspaceFromConfig(
  configured: string,
  allowlistedCanonicalWorkspaces: readonly string[],
): HostWorkspace {
  const canonical = requireCanonicalDirectory(configured, 'workspace_invalid')
  if (!allowlistedCanonicalWorkspaces.some(candidate => safeCanonicalPath(candidate) === canonical)) {
    throw new CodexProcessOwnerError('workspace_invalid')
  }
  return brandWorkspace(canonical)
}

export function hostEphemeralCodexHomeFromConfig(
  configured: string,
  allowlistedCanonicalHomes: readonly string[],
): HostCodexHome {
  const canonical = requireCanonicalDirectory(configured, 'workspace_invalid')
  if (!allowlistedCanonicalHomes.some(candidate => safeCanonicalPath(candidate) === canonical)) {
    throw new CodexProcessOwnerError('workspace_invalid')
  }
  return brandHome(canonical, true)
}

export function hostPersistentCodexHomeFromConfig(
  configured: string,
  allowlistedCanonicalHomes: readonly string[],
): HostCodexHome {
  const canonical = requireCanonicalDirectory(configured, 'workspace_invalid')
  if (!allowlistedCanonicalHomes.some(candidate => safeCanonicalPath(candidate) === canonical)) {
    throw new CodexProcessOwnerError('workspace_invalid')
  }
  return brandHome(canonical, false)
}

/** Test-only path constructors. They still enforce canonical absolute native paths. */
export function hostBinaryForTest(configured: string): HostBinary {
  return brandBinary(requireCanonicalRegularFile(configured, 'spawn_failed'))
}

export function hostWorkspaceForTest(configured: string): HostWorkspace {
  return brandWorkspace(requireCanonicalDirectory(configured, 'workspace_invalid'))
}

export function hostCodexHomeForTest(
  configured: string,
  options: {readonly ephemeral: boolean},
): HostCodexHome {
  return brandHome(requireCanonicalDirectory(configured, 'workspace_invalid'), options.ephemeral)
}

export function hostBinaryPath(value: HostBinary): string {
  const path = binaryValues.get(value)
  if (path === undefined) throw new CodexProcessOwnerError('spawn_failed')
  return path
}

export function hostWorkspacePath(value: HostWorkspace): string {
  const path = workspaceValues.get(value)
  if (path === undefined) throw new CodexProcessOwnerError('workspace_invalid')
  return path
}

export function hostCodexHomeValue(value: HostCodexHome): CodexHomeValue {
  const home = homeValues.get(value)
  if (home === undefined) throw new CodexProcessOwnerError('workspace_invalid')
  return home
}

/** Internal credential-cleanup capability refresh after creating an approved ephemeral home. */
export function refreshEphemeralCodexHomeIdentity(value: HostCodexHome): void {
  const home = homeValues.get(value)
  if (!home?.ephemeral) throw new CodexProcessOwnerError('workspace_invalid')
  home.identity = readEphemeralHomeIdentity(home.path)
  home.cleanupPath = null
}

interface ApprovedSpawnDetails {
  readonly binary: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly shell: false
  readonly detached: true
  readonly stdio: readonly ['pipe', 'pipe', 'pipe']
  readonly windowsHide: true
}

export function createApprovedCodexSpawnSpec(input: {
  readonly binary: HostBinary
  readonly workspace: HostWorkspace
  readonly codexHome: HostCodexHome
  readonly environment: Readonly<Record<string, string>>
}): ApprovedSpawnSpec {
  const binary = hostBinaryPath(input.binary)
  const cwd = hostWorkspacePath(input.workspace)
  const home = hostCodexHomeValue(input.codexHome)
  const environment = validateChildEnvironment(input.environment, home.path)
  const spec = Object.freeze({[approvedSpawnBrand]: true as const})
  spawnValues.set(spec, Object.freeze({
    binary,
    argv: CODEX_APP_SERVER_ARGV,
    cwd,
    environment,
    shell: false,
    detached: true,
    stdio: Object.freeze(['pipe', 'pipe', 'pipe'] as const),
    windowsHide: true,
  }))
  return spec
}

/** Visible only to host-side factories and deterministic launch-boundary tests. */
export function approvedCodexSpawnDetails(spec: ApprovedSpawnSpec): ApprovedSpawnDetails {
  const details = spawnValues.get(spec)
  if (details === undefined) throw new CodexProcessOwnerError('spawn_failed')
  return details
}

/**
 * Behavioral test seam: caller `argv` is deliberately absent from the accepted shape.
 * This never accepts renderer input in production code.
 */
export function createApprovedCodexSpawnSpecForTest(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const binary = hostBinaryForTest(requirePrimitiveString(input.binary))
  const workspace = hostWorkspaceForTest(requirePrimitiveString(input.workspace))
  const codexHome = hostCodexHomeForTest(requirePrimitiveString(input.codexHome), {ephemeral: true})
  const environment = requireStringRecord(input.environment)
  const details = approvedCodexSpawnDetails(createApprovedCodexSpawnSpec({
    binary,
    workspace,
    codexHome,
    environment,
  }))
  return {
    argv: [...details.argv],
    environment: {...details.environment},
    shell: details.shell,
    detached: details.detached,
    stdio: [...details.stdio],
    windowsHide: details.windowsHide,
  }
}

export interface OwnedCodexProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exit: Promise<number | null>
  readonly pid: number
  closeStdin(): Promise<void>
  waitTreeGone(graceMs: number): Promise<boolean>
  terminateTree(): Promise<void>
  killTree(): Promise<void>
  dispose(): Promise<void>
}

export interface CodexProcessOwnerFactory {
  spawn(spec: ApprovedSpawnSpec, control: CodexProcessSpawnControl): Promise<OwnedCodexProcess>
}

export interface CodexProcessSpawnControl {
  readonly signal: AbortSignal
  readonly expiresAtMs: number
}

interface ProcessGroupOperations {
  readonly signal: (processGroup: number, signal: NodeJS.Signals | 0) => void
  readonly wait: (milliseconds: number) => Promise<void>
  readonly now: () => number
}

const DEFAULT_GROUP_OPERATIONS: ProcessGroupOperations = {
  signal: (processGroup, signal) => { process.kill(processGroup, signal) },
  wait: async milliseconds => { await new Promise(resolve => setTimeout(resolve, milliseconds)) },
  now: () => Date.now(),
}

export class PosixCodexProcessOwnerFactory implements CodexProcessOwnerFactory {
  readonly #spawn: typeof spawn
  readonly #groupOperations: ProcessGroupOperations
  #failedSupervisionOwner: PosixOwnedCodexProcess | null = null

  constructor(options: {
    readonly spawn?: typeof spawn
    readonly groupOperations?: ProcessGroupOperations
  } = {}) {
    this.#spawn = options.spawn ?? spawn
    this.#groupOperations = options.groupOperations ?? DEFAULT_GROUP_OPERATIONS
  }

  async spawn(spec: ApprovedSpawnSpec, control: CodexProcessSpawnControl): Promise<OwnedCodexProcess> {
    if (process.platform === 'win32') throw new CodexProcessOwnerError('spawn_failed')
    if (control.signal.aborted || !Number.isFinite(control.expiresAtMs) || control.expiresAtMs <= Date.now()) {
      throw new CodexProcessOwnerError('spawn_failed')
    }
    const failedOwner = this.#failedSupervisionOwner
    if (failedOwner !== null) {
      try {
        await failedOwner.cleanupFailedSupervision()
        if (this.#failedSupervisionOwner === failedOwner) this.#failedSupervisionOwner = null
      } catch {
        throw unconfirmedCodexProcessOwnerError(failedOwner)
      }
    }
    const details = approvedCodexSpawnDetails(spec)
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.#spawn(details.binary, [...details.argv], {
        cwd: details.cwd,
        env: {...details.environment},
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      throw new CodexProcessOwnerError('spawn_failed')
    }
    if (!Number.isSafeInteger(child.pid) || child.pid === undefined || child.pid <= 0) {
      child.kill('SIGKILL')
      throw new CodexProcessOwnerError('spawn_failed')
    }
    const owner = new PosixOwnedCodexProcess(child, this.#groupOperations)
    if (!owner.verifyGroupSupervision()) {
      this.#failedSupervisionOwner = owner
      try {
        await owner.cleanupFailedSupervision()
        if (this.#failedSupervisionOwner === owner) this.#failedSupervisionOwner = null
      } catch {
        throw unconfirmedCodexProcessOwnerError(owner)
      }
      throw new CodexProcessOwnerError('spawn_failed')
    }
    return owner
  }
}

class PosixOwnedCodexProcess implements OwnedCodexProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exit: Promise<number | null>
  readonly pid: number
  readonly #groupOperations: ProcessGroupOperations
  readonly #killLeader: () => void
  #stdinClosed = false
  #disposed = false

  constructor(child: ChildProcessWithoutNullStreams, groupOperations: ProcessGroupOperations) {
    this.#groupOperations = groupOperations
    this.#killLeader = () => { child.kill('SIGKILL') }
    this.stdin = child.stdin
    this.stdout = child.stdout
    this.stderr = child.stderr
    const pid = child.pid
    if (pid === undefined) throw new CodexProcessOwnerError('spawn_failed')
    this.pid = pid
    this.exit = new Promise((resolve, reject) => {
      child.once('exit', code => { resolve(code) })
      child.once('error', () => { reject(new CodexProcessOwnerError('spawn_failed')) })
    })
    void this.exit.catch(() => undefined)
  }

  async closeStdin(): Promise<void> {
    if (this.#stdinClosed) return
    this.#stdinClosed = true
    await new Promise<void>(resolve => {
      this.stdin.end(() => { resolve() })
      this.stdin.once('error', () => { resolve() })
    })
  }

  async waitTreeGone(graceMs: number): Promise<boolean> {
    if (!Number.isFinite(graceMs) || graceMs < 0) return false
    const deadline = this.#groupOperations.now() + graceMs
    while (this.#groupAlive()) {
      if (this.#groupOperations.now() >= deadline) return false
      await this.#groupOperations.wait(Math.min(10, Math.max(0, deadline - this.#groupOperations.now())))
    }
    const remaining = Math.max(0, deadline - this.#groupOperations.now())
    return await settlesWithin(this.exit, remaining)
  }

  terminateTree(): Promise<void> {
    this.#signalGroup('SIGTERM')
    return Promise.resolve()
  }

  killTree(): Promise<void> {
    this.#signalGroup('SIGKILL')
    return Promise.resolve()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.stdin.destroy()
    this.stdout.destroy()
    this.stderr.destroy()
    await settlesWithin(this.exit, 100)
  }

  verifyGroupSupervision(): boolean {
    try {
      this.#groupOperations.signal(-this.pid, 0)
      return true
    } catch (error) {
      if (isErrno(error, 'EPERM')) return true
      if (isErrno(error, 'ESRCH')) return false
      return false
    }
  }

  async cleanupFailedSupervision(): Promise<void> {
    try {
      this.#groupOperations.signal(-this.pid, 'SIGKILL')
    } catch (error) {
      if (!isErrno(error, 'ESRCH')) {
        // Even when the supervision probe failed unexpectedly, still fall back to
        // closing the leader below. No positive-PID signal is used as a tree kill.
      }
    }
    try { this.#killLeader() } catch { /* best-effort after whole-group signal */ }
    this.stdin.destroy()
    this.stdout.destroy()
    this.stderr.destroy()
    let groupGone = false
    try {
      groupGone = await this.waitTreeGone(5000)
    } finally {
      await this.dispose()
    }
    if (!groupGone) throw new CodexProcessOwnerError('spawn_failed')
  }

  #groupAlive(): boolean {
    try {
      this.#groupOperations.signal(-this.pid, 0)
      return true
    } catch (error) {
      if (isErrno(error, 'EPERM')) return true
      if (isErrno(error, 'ESRCH')) return false
      throw new CodexProcessOwnerError('spawn_failed')
    }
  }

  #signalGroup(signal: NodeJS.Signals): void {
    try {
      this.#groupOperations.signal(-this.pid, signal)
    } catch (error) {
      if (!isErrno(error, 'ESRCH')) throw new CodexProcessOwnerError('spawn_failed')
    }
  }
}

export function createPlatformCodexProcessOwnerFactory(options: {
  readonly platform?: NodeJS.Platform
  readonly windowsGuardianFactory?: CodexProcessOwnerFactory
} = {}): CodexProcessOwnerFactory {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    return options.windowsGuardianFactory ?? new FailingWindowsCodexProcessOwnerFactory()
  }
  return new PosixCodexProcessOwnerFactory()
}

class FailingWindowsCodexProcessOwnerFactory implements CodexProcessOwnerFactory {
  spawn(spec: ApprovedSpawnSpec, control: CodexProcessSpawnControl): Promise<OwnedCodexProcess> {
    void spec
    void control
    return Promise.reject(new CodexProcessOwnerError('spawn_failed'))
  }
}

function validateChildEnvironment(
  value: Readonly<Record<string, string>>,
  expectedCodexHome: string,
): Readonly<Record<string, string>> {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const result: Record<string, string> = {}
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !CHILD_ENVIRONMENT_KEYS.has(key)) {
      throw new CodexProcessOwnerError('spawn_failed')
    }
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new CodexProcessOwnerError('spawn_failed')
    }
    const field = descriptor.value as unknown
    if (typeof field !== 'string' || !isWellFormed(field) || field.includes('\0')) {
      throw new CodexProcessOwnerError('spawn_failed')
    }
    Object.defineProperty(result, key, {value: field, enumerable: true})
  }
  if (
    result.PATH === undefined
    || result.HOME === undefined
    || result.CODEX_HOME !== expectedCodexHome
    || result.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED !== '1'
    || result.CODEX_API_KEY === ''
  ) throw new CodexProcessOwnerError('spawn_failed')
  return Object.freeze(result)
}

function brandBinary(path: string): HostBinary {
  const value = Object.freeze({[hostBinaryBrand]: true as const})
  binaryValues.set(value, path)
  return value
}

function brandWorkspace(path: string): HostWorkspace {
  const value = Object.freeze({[hostWorkspaceBrand]: true as const})
  workspaceValues.set(value, path)
  return value
}

function brandHome(path: string, ephemeral: boolean): HostCodexHome {
  const value = Object.freeze({[hostCodexHomeBrand]: true as const})
  homeValues.set(value, {
    path,
    ephemeral,
    identity: ephemeral ? readEphemeralHomeIdentity(path) : null,
    cleanupPath: null,
  })
  return value
}

function readEphemeralHomeIdentity(path: string): EphemeralHomeIdentity {
  try {
    const info = lstatSync(path, {bigint: true})
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('invalid home')
    return Object.freeze({device: info.dev, inode: info.ino, uid: Number(info.uid)})
  } catch {
    throw new CodexProcessOwnerError('workspace_invalid')
  }
}

function requireCanonicalRegularFile(
  configured: string,
  code: 'spawn_failed' | 'workspace_invalid',
): string {
  const canonical = requireCanonical(configured, code)
  try {
    if (!statSync(canonical).isFile() || hasScriptSuffix(canonical)) throw new Error('not native')
  } catch {
    throw new CodexProcessOwnerError(code)
  }
  return canonical
}

function requireCanonicalDirectory(
  configured: string,
  code: 'spawn_failed' | 'workspace_invalid',
): string {
  const canonical = requireCanonical(configured, code)
  try {
    if (!statSync(canonical).isDirectory()) throw new Error('not directory')
  } catch {
    throw new CodexProcessOwnerError(code)
  }
  return canonical
}

function requireCanonical(configured: string, code: 'spawn_failed' | 'workspace_invalid'): string {
  if (typeof configured !== 'string' || !isWellFormed(configured) || !isAbsolute(configured)) {
    throw new CodexProcessOwnerError(code)
  }
  let canonical: string
  try {
    canonical = realpathSync(configured)
  } catch {
    throw new CodexProcessOwnerError(code)
  }
  if (canonical !== configured) throw new CodexProcessOwnerError(code)
  return canonical
}

function safeCanonicalPath(candidate: string): string | null {
  try {
    return requireCanonical(candidate, 'workspace_invalid')
  } catch {
    return null
  }
}

function hasScriptSuffix(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1')
}

function requirePrimitiveString(value: unknown): string {
  if (typeof value !== 'string') throw new CodexProcessOwnerError('spawn_failed')
  return value
}

function requireStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodexProcessOwnerError('spawn_failed')
  }
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CodexProcessOwnerError('spawn_failed')
  }
  return value as Record<string, string>
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}

async function settlesWithin(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
  if (milliseconds <= 0) return false
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work.then(() => true, () => true),
      new Promise<false>(resolve => { timer = setTimeout(() => { resolve(false) }, milliseconds) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
