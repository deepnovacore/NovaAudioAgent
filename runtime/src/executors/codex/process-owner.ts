import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process'
import { closeSync,fstatSync,openSync,readSync,statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Readable,Writable } from 'node:stream'
import { managedMcpConfigToml,managedMcpEnvironment,type ManagedCodexMcp } from './managed-mcp.js'
import { apiKeyProviderOverrides,NOVA_API_KEY_ENV,validateCodexEnvironment } from './spawn-env.js'

import {
hostEphemeralHomeFromConfig,
hostHomeForTest,
hostHomeValue,
HostPathError,
hostPersistentHomeFromConfig,
hostWorkspaceForTest,
hostWorkspaceFromConfig,
hostWorkspacePath,
refreshEphemeralHomeIdentity,
requireCanonicalPath,
safeCanonicalPath,
type HostStateHome,
type HostWorkspace,
} from '../../projects/host-paths.js'
import {
codexAppServerArgv,
resolveCodexLaunchProfile,
type CodexLaunchProfile,
} from './launch-profile.js'

const hostBinaryBrand: unique symbol = Symbol('HostBinary')

export interface HostBinary { readonly [hostBinaryBrand]: true }
export type HostCodexHome = HostStateHome
export {
HostPathError as CodexProcessOwnerError,hostHomeForTest as hostCodexHomeForTest,
hostHomeValue as hostCodexHomeValue,hostEphemeralHomeFromConfig as hostEphemeralCodexHomeFromConfig,
hostPersistentHomeFromConfig as hostPersistentCodexHomeFromConfig,hostWorkspaceForTest,hostWorkspaceFromConfig,hostWorkspacePath,refreshEphemeralHomeIdentity as refreshEphemeralCodexHomeIdentity,
type HostWorkspace
}
const CodexProcessOwnerError = HostPathError
type CodexProcessOwnerError = HostPathError

const binaryValues = new WeakMap<HostBinary, string>()
const unconfirmedOwnerErrors = new WeakMap<CodexProcessOwnerError, OwnedCodexProcess>()

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

export function hostBinaryForTest(configured: string): HostBinary {
  return brandBinary(requireCanonicalRegularFile(configured, 'spawn_failed'))
}

export function hostBinaryPath(value: HostBinary): string {
  const path = binaryValues.get(value)
  if (path === undefined) throw new CodexProcessOwnerError('spawn_failed')
  return path
}

/** Native launch identity, scoped to one establish. Scripts cannot certify their downstream binary. */
export function nativeCodexBinaryIdentity(binary: HostBinary, prefixArgs: readonly string[]): string | null {
  if (prefixArgs.length !== 0) return null
  const path = hostBinaryPath(binary)
  const fd = openSync(path, 'r')
  try {
    const magic = Buffer.alloc(4)
    if (readSync(fd, magic, 0, 4, 0) !== 4) return null
    const signature = magic.toString('hex')
    if (!['7f454c46', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(signature)
      && magic.subarray(0, 2).toString() !== 'MZ') return null
    const info = fstatSync(fd, {bigint: true})
    return `${path}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  } finally { closeSync(fd) }
}

export interface CodexSpawnSpec {
  readonly binary: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly shell: false
  readonly detached: true
  readonly stdio: readonly ['pipe', 'pipe', 'pipe']
  readonly windowsHide: true
}

export function createCodexSpawnSpec(input: {
  readonly binary: HostBinary
  readonly prefixArgs?: readonly string[]
  readonly workspace: HostWorkspace
  readonly codexHome: HostCodexHome
  readonly environment: Readonly<Record<string, string>>
  readonly launchProfile?: CodexLaunchProfile
  readonly managedMcp?: ManagedCodexMcp
  readonly preserveHome?: boolean | undefined
  readonly sharedHomeOverrides?: readonly string[]
}): CodexSpawnSpec {
  const binary = hostBinaryPath(input.binary)
  const cwd = hostWorkspacePath(input.workspace)
  const home = hostHomeValue(input.codexHome)
  let environment: Readonly<Record<string, string>>
  try { environment = validateCodexEnvironment(input.environment, home.path, managedMcpEnvironment(input.managedMcp)) }
  catch { throw new CodexProcessOwnerError('spawn_failed') }
  return Object.freeze({
    binary,
    argv: Object.freeze([
      ...validateBinaryPrefixArgs(input.prefixArgs),
      ...(input.managedMcp ? ['-c', managedMcpConfigToml(input.managedMcp).trim()] : []),
      ...(input.sharedHomeOverrides ?? []),
      ...(environment[NOVA_API_KEY_ENV] === undefined ? [] : apiKeyProviderOverrides()),
      ...codexAppServerArgv(input.launchProfile ?? resolveCodexLaunchProfile({
        approvalMode: 'ask', project: false, foregroundBroker: false,
      }), input.managedMcp !== undefined || input.preserveHome === true),
    ]),
    cwd,
    environment,
    shell: false,
    detached: true,
    stdio: Object.freeze(['pipe', 'pipe', 'pipe'] as const),
    windowsHide: true,
  })
}

function validateBinaryPrefixArgs(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 1) {
    throw new CodexProcessOwnerError('spawn_failed')
  }
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !isAbsolute(item) || !item.toLowerCase().endsWith('.js')) {
      throw new CodexProcessOwnerError('spawn_failed')
    }
    result.push(requireCanonicalRegularFile(item, 'spawn_failed'))
  }
  return Object.freeze(result)
}

/**
 * Behavioral test seam: caller `argv` is deliberately absent from the accepted shape.
 * This never accepts renderer input in production code.
 */
export function createCodexSpawnSpecForTest(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const binary = hostBinaryForTest(requirePrimitiveString(input.binary))
  const workspace = hostWorkspaceForTest(requirePrimitiveString(input.workspace))
  const codexHome = hostHomeForTest(requirePrimitiveString(input.codexHome), {ephemeral: true})
  const environment = requireStringRecord(input.environment)
  const details = createCodexSpawnSpec({
    binary,
    workspace,
    codexHome,
    environment,
  })
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
  spawn(spec: CodexSpawnSpec, control: CodexProcessSpawnControl): Promise<OwnedCodexProcess>
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

  async spawn(spec: CodexSpawnSpec, control: CodexProcessSpawnControl): Promise<OwnedCodexProcess> {
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
    const details = spec
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
    const groupGone = await this.waitTreeGone(5000)
    if (!groupGone) throw new CodexProcessOwnerError('spawn_failed')
    await this.dispose()
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
  spawn(spec: CodexSpawnSpec, control: CodexProcessSpawnControl): Promise<OwnedCodexProcess> {
    void spec
    void control
    return Promise.reject(new CodexProcessOwnerError('spawn_failed'))
  }
}

function brandBinary(path: string): HostBinary {
  const value = Object.freeze({[hostBinaryBrand]: true as const})
  binaryValues.set(value, path)
  return value
}

function requireCanonicalRegularFile(
  configured: string,
  code: 'spawn_failed' | 'workspace_invalid',
): string {
  const canonical = requireCanonicalPath(configured, code)
  try {
    if (!statSync(canonical).isFile() || hasScriptSuffix(canonical)) throw new Error('not native')
  } catch {
    throw new CodexProcessOwnerError(code)
  }
  return canonical
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
