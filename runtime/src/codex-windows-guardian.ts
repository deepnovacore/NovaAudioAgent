import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {constants as fsConstants} from 'node:fs'
import {closeSync, fstatSync, openSync, readSync, realpathSync, statSync} from 'node:fs'
import {isAbsolute, resolve} from 'node:path'
import type {Readable, Writable} from 'node:stream'

import {snapshotJsonRecord} from './codex-safe-json.js'
import {
  CodexProcessOwnerError,
  approvedCodexSpawnDetails,
  type ApprovedSpawnSpec,
  type CodexProcessOwnerFactory,
  type CodexProcessSpawnControl,
  type OwnedCodexProcess,
} from './codex-process-owner.js'

export const WINDOWS_GUARDIAN_FRAME_LIMIT = 4096
export const WINDOWS_GUARDIAN_READY_TIMEOUT_MS = 5000
const WINDOWS_GUARDIAN_ID = 'windows_job_guardian'
const WINDOWS_GUARDIAN_PATH = 'native/windows-job-guardian.exe'
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_HELPER_BYTES = 4 * 1024 * 1024

export type WindowsGuardianFrame = Readonly<
  | {type: 'ready'; version: 1; targetPid: number}
  | {type: 'exit'; version: 1; leaderExitCode: number | null; treeEmpty: true}
>

export interface WindowsGuardianCommand {
  readonly binary: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly stdoutLimit: number
  readonly stderrLimit: number
  readonly shell: false
}

export interface WindowsGuardianCommandResult {
  readonly status: number | null
  readonly stdout: Buffer
}

const fatalDecoder = new TextDecoder('utf-8', {fatal: true})
const encoder = new TextEncoder()
const windowsHelperBrand: unique symbol = Symbol('WindowsGuardianHelper')
export interface WindowsGuardianHelper { readonly [windowsHelperBrand]: true }
const helperPaths = new WeakMap<WindowsGuardianHelper, string>()

interface WindowsGuardianChild {
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly stdio: readonly unknown[]
  readonly pid?: number | undefined
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number | null) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

type WindowsGuardianLauncher = (
  binary: string,
  argv: readonly string[],
  options: Readonly<{
    cwd: string
    env: Readonly<Record<string, string>>
    shell: false
    detached: false
    stdio: readonly ['pipe', 'pipe', 'pipe', 'pipe']
    windowsHide: true
  }>,
) => WindowsGuardianChild

interface FileSnapshot {
  readonly device: bigint
  readonly inode: bigint
  readonly size: number
  readonly sha256: string
}

export class CodexWindowsGuardianError extends Error {
  readonly code = 'spawn_failed' as const

  constructor() {
    super('spawn_failed')
    this.name = 'CodexWindowsGuardianError'
  }
}

export class WindowsGuardianControlParser {
  #buffer = new Uint8Array(WINDOWS_GUARDIAN_FRAME_LIMIT + 1)
  #used = 0
  #state: 'waiting_ready' | 'waiting_exit' | 'complete' | 'failed' = 'waiting_ready'

  feed(chunk: Uint8Array): readonly WindowsGuardianFrame[] {
    try {
      if (this.#state === 'failed' || this.#state === 'complete') throw new CodexWindowsGuardianError()
      if (!isUint8Array(chunk)) throw new CodexWindowsGuardianError()
      const result: WindowsGuardianFrame[] = []
      for (const byte of chunk) {
        if (byte === 0x0a) {
          if (this.#used === 0) throw new CodexWindowsGuardianError()
          const line = this.#buffer.slice(0, this.#used)
          this.#used = 0
          const frame = this.#parseLine(line)
          result.push(frame)
          continue
        }
        if (this.#used === WINDOWS_GUARDIAN_FRAME_LIMIT) throw new CodexWindowsGuardianError()
        this.#buffer[this.#used] = byte
        this.#used += 1
      }
      return Object.freeze(result)
    } catch {
      this.#state = 'failed'
      this.#used = 0
      throw new CodexWindowsGuardianError()
    }
  }

  end(): void {
    if (this.#used !== 0 || this.#state !== 'complete') {
      this.#state = 'failed'
      this.#used = 0
      throw new CodexWindowsGuardianError()
    }
  }

  #parseLine(line: Uint8Array): WindowsGuardianFrame {
    let raw: string
    let parsed: Record<string, unknown>
    try {
      raw = fatalDecoder.decode(line)
      parsed = snapshotJsonRecord(JSON.parse(raw) as unknown)
    } catch {
      throw new CodexWindowsGuardianError()
    }
    if (topLevelColonCount(raw) !== Object.keys(parsed).length) {
      throw new CodexWindowsGuardianError()
    }
    if (this.#state === 'waiting_ready') {
      if (
        !exactKeys(parsed, ['type', 'version', 'targetPid'])
        || parsed.type !== 'ready'
        || parsed.version !== 1
        || typeof parsed.targetPid !== 'number'
        || !Number.isSafeInteger(parsed.targetPid)
        || parsed.targetPid <= 0
      ) throw new CodexWindowsGuardianError()
      this.#state = 'waiting_exit'
      return Object.freeze({type: 'ready', version: 1, targetPid: parsed.targetPid})
    }
    if (this.#state === 'waiting_exit') {
      if (
        !exactKeys(parsed, ['type', 'version', 'leaderExitCode', 'treeEmpty'])
        || parsed.type !== 'exit'
        || parsed.version !== 1
        || (
          parsed.leaderExitCode !== null
          && (typeof parsed.leaderExitCode !== 'number' || !Number.isSafeInteger(parsed.leaderExitCode))
        )
        || parsed.treeEmpty !== true
      ) throw new CodexWindowsGuardianError()
      this.#state = 'complete'
      return Object.freeze({
        type: 'exit',
        version: 1,
        leaderExitCode: parsed.leaderExitCode,
        treeEmpty: true,
      })
    }
    throw new CodexWindowsGuardianError()
  }
}

export function windowsGuardianForceFrame(): Uint8Array {
  return encoder.encode('{"type":"force","version":1}\n')
}

export function windowsGuardianHelperFromPackage(
  configuredPath: string,
  allowlistedCanonicalPaths: readonly string[],
  architecture: 'x64' | 'arm64' | 'ia32',
): WindowsGuardianHelper {
  try {
    if (
      typeof configuredPath !== 'string'
      || !isAbsolute(configuredPath)
      || !configuredPath.toLowerCase().endsWith('.exe')
      || realpathSync(configuredPath) !== configuredPath
      || !statSync(configuredPath).isFile()
      || !allowlistedCanonicalPaths.some(candidate => (
        isAbsolute(candidate) && realpathSync(candidate) === configuredPath
      ))
    ) throw new CodexWindowsGuardianError()
    validatePortableExecutable(configuredPath, architecture)
    const helper = Object.freeze({[windowsHelperBrand]: true as const})
    helperPaths.set(helper, configuredPath)
    return helper
  } catch {
    throw new CodexWindowsGuardianError()
  }
}

export function windowsGuardianHelperPath(helper: WindowsGuardianHelper): string {
  const path = helperPaths.get(helper)
  if (path === undefined) throw new CodexWindowsGuardianError()
  return path
}

/** Host-only packaged resolver. No renderer, model, work order, or setting selects this path. */
export function loadWindowsGuardianFactoryFromResources(options: {
  readonly resourcesPath: string
  readonly platform: string
  readonly arch: string
  readonly launcher?: WindowsGuardianLauncher
}): WindowsGuardianCodexProcessOwnerFactory | null {
  try {
    if (
      options.platform !== 'win32'
      || options.arch !== 'x64'
      || !isAbsolute(options.resourcesPath)
    ) return null
    const resourcesRoot = resolve(options.resourcesPath)
    if (realpathSync(resourcesRoot) !== resourcesRoot) return null
    const manifest = JSON.parse(readBoundedRegularFile(
      resolve(resourcesRoot, 'native-resources-v1.json'),
      MAX_MANIFEST_BYTES,
    ).toString('utf8')) as unknown
    const record = requireGuardianRecord(manifest)
    const helperPath = resolve(resourcesRoot, WINDOWS_GUARDIAN_PATH)
    if (realpathSync(helperPath) !== helperPath) return null
    const expected = snapshotRegularFile(helperPath, MAX_HELPER_BYTES)
    if (expected.size !== record.byteSize || expected.sha256 !== record.sha256) return null
    const helper = windowsGuardianHelperFromPackage(helperPath, [helperPath], 'x64')
    const validateHelper = (): boolean => {
      try {
        return sameSnapshot(expected, snapshotRegularFile(helperPath, MAX_HELPER_BYTES))
      } catch {
        return false
      }
    }
    return new WindowsGuardianCodexProcessOwnerFactory({
      helper,
      validateHelper,
      platform: options.platform,
      ...(options.launcher === undefined ? {} : {launcher: options.launcher}),
    })
  } catch {
    return null
  }
}

export class WindowsGuardianCodexProcessOwnerFactory implements CodexProcessOwnerFactory {
  readonly #helper: WindowsGuardianHelper
  readonly #validateHelper: () => boolean
  readonly #launch: WindowsGuardianLauncher
  readonly #platform: string

  constructor(options: {
    readonly helper: WindowsGuardianHelper
    readonly validateHelper?: () => boolean
    readonly launcher?: WindowsGuardianLauncher
    readonly platform?: string
  }) {
    this.#helper = options.helper
    this.#validateHelper = options.validateHelper ?? (() => true)
    this.#launch = options.launcher ?? launchWindowsGuardian
    this.#platform = options.platform ?? process.platform
  }

  async spawn(
    spec: ApprovedSpawnSpec,
    control: CodexProcessSpawnControl,
  ): Promise<OwnedCodexProcess> {
    if (
      this.#platform !== 'win32'
      || control.signal.aborted
      || !Number.isFinite(control.expiresAtMs)
      || control.expiresAtMs <= Date.now()
      || !this.#validateHelper()
    ) throw new CodexProcessOwnerError('spawn_failed')
    const details = approvedCodexSpawnDetails(spec)
    const guardian = this.#spawnGuardian(
      details.binary,
      details.argv,
      details.cwd,
      details.environment,
    )
    const remaining = Math.min(
      WINDOWS_GUARDIAN_READY_TIMEOUT_MS,
      Math.max(0, control.expiresAtMs - Date.now()),
    )
    const abort = (): void => { guardian.abandon() }
    control.signal.addEventListener('abort', abort, {once: true})
    try {
      await guardian.waitReady(remaining)
      if (!this.#validateHelper()) throw new CodexProcessOwnerError('spawn_failed')
      return guardian
    } catch {
      guardian.abandon()
      throw new CodexProcessOwnerError('spawn_failed')
    } finally {
      control.signal.removeEventListener('abort', abort)
    }
  }

  async runCommand(command: WindowsGuardianCommand): Promise<WindowsGuardianCommandResult> {
    if (
      this.#platform !== 'win32'
      || command.shell !== false
      || !isAbsolute(command.binary)
      || !isAbsolute(command.cwd)
      || !Number.isFinite(command.timeoutMs)
      || command.timeoutMs <= 0
      || !Number.isSafeInteger(command.stdoutLimit)
      || command.stdoutLimit <= 0
      || !Number.isSafeInteger(command.stderrLimit)
      || command.stderrLimit <= 0
      || !this.#validateHelper()
    ) throw new CodexProcessOwnerError('spawn_failed')
    const guardian = this.#spawnGuardian(
      command.binary,
      command.argv,
      command.cwd,
      command.environment,
    )
    let stdout = Buffer.alloc(0)
    let stderrBytes = 0
    let rejectOverflow!: (error: Error) => void
    const overflow = new Promise<never>((_resolve, reject) => { rejectOverflow = reject })
    const failOverflow = (): void => { rejectOverflow(new CodexProcessOwnerError('spawn_failed')) }
    guardian.stdout.on('data', (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array) || stdout.byteLength + chunk.byteLength > command.stdoutLimit) {
        failOverflow()
        return
      }
      stdout = Buffer.concat([stdout, Buffer.from(chunk)])
    })
    guardian.stderr.on('data', (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array)) {
        failOverflow()
        return
      }
      stderrBytes += chunk.byteLength
      if (stderrBytes > command.stderrLimit) failOverflow()
    })
    const deadline = Date.now() + command.timeoutMs
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        guardian.waitReady(Math.min(WINDOWS_GUARDIAN_READY_TIMEOUT_MS, command.timeoutMs)),
        overflow,
      ])
      if (!this.#validateHelper()) throw new CodexProcessOwnerError('spawn_failed')
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new CodexProcessOwnerError('spawn_failed')
      const status = await Promise.race([
        guardian.exit,
        overflow,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { reject(new CodexProcessOwnerError('spawn_failed')) }, remaining)
        }),
      ])
      await guardian.dispose()
      if (!this.#validateHelper()) throw new CodexProcessOwnerError('spawn_failed')
      return Object.freeze({status, stdout})
    } catch {
      await guardian.terminateTree().catch(() => { guardian.abandon() })
      throw new CodexProcessOwnerError('spawn_failed')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #spawnGuardian(
    target: string,
    argv: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
  ): WindowsGuardianOwnedCodexProcess {
    const helperPath = windowsGuardianHelperPath(this.#helper)
    let child: WindowsGuardianChild
    try {
      child = this.#launch(helperPath, Object.freeze([
        '--target', target,
        '--cwd', cwd,
        '--', target,
        ...argv,
      ]), Object.freeze({
        cwd,
        env: environment,
        shell: false,
        detached: false,
        stdio: Object.freeze(['pipe', 'pipe', 'pipe', 'pipe'] as const),
        windowsHide: true,
      }))
    } catch {
      throw new CodexProcessOwnerError('spawn_failed')
    }
    return WindowsGuardianOwnedCodexProcess.create(child)
  }
}

class WindowsGuardianOwnedCodexProcess implements OwnedCodexProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exit: Promise<number | null>
  pid = 0
  readonly #child: WindowsGuardianChild
  readonly #control: Readable & Writable
  readonly #ready: Promise<void>
  readonly #resolveReady: () => void
  readonly #rejectReady: (error: Error) => void
  readonly #resolveExit: (code: number | null) => void
  readonly #rejectExit: (error: Error) => void
  #readySeen = false
  #exitSeen = false
  #forceSent = false
  #disposed = false

  static create(child: WindowsGuardianChild): WindowsGuardianOwnedCodexProcess {
    return new WindowsGuardianOwnedCodexProcess(child)
  }

  private constructor(child: WindowsGuardianChild) {
    const control = child.stdio[3]
    if (
      child.stdin === null
      || child.stdout === null
      || child.stderr === null
      || !isReadableWritable(control)
    ) {
      try { child.kill('SIGKILL') } catch { /* gone */ }
      throw new CodexProcessOwnerError('spawn_failed')
    }
    this.#child = child
    this.stdin = child.stdin
    this.stdout = child.stdout
    this.stderr = child.stderr
    this.#control = control
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    this.#ready = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveReady = resolvePromise
      rejectReady = rejectPromise
    })
    this.#resolveReady = resolveReady
    this.#rejectReady = rejectReady
    let resolveExit!: (code: number | null) => void
    let rejectExit!: (error: Error) => void
    this.exit = new Promise<number | null>((resolvePromise, rejectPromise) => {
      resolveExit = resolvePromise
      rejectExit = rejectPromise
    })
    this.exit.catch(() => undefined)
    this.#resolveExit = resolveExit
    this.#rejectExit = rejectExit
    const parser = new WindowsGuardianControlParser()
    control.on('data', (chunk: unknown) => {
      try {
        if (!(chunk instanceof Uint8Array)) throw new CodexWindowsGuardianError()
        for (const frame of parser.feed(chunk)) this.#acceptFrame(frame)
      } catch {
        this.#fail()
      }
    })
    control.once('end', () => {
      try { parser.end() } catch { this.#fail() }
    })
    control.once('error', () => { this.#fail() })
    child.once('error', () => { this.#fail() })
    child.once('exit', code => {
      if (!this.#exitSeen || code !== 0) this.#fail()
    })
  }

  async waitReady(timeoutMs: number): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CodexProcessOwnerError('spawn_failed')
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.#ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { reject(new CodexProcessOwnerError('spawn_failed')) }, timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  closeStdin(): Promise<void> {
    if (!this.stdin.destroyed && !this.stdin.writableEnded) this.stdin.end()
    return Promise.resolve()
  }

  async waitTreeGone(graceMs: number): Promise<boolean> {
    if (!Number.isFinite(graceMs) || graceMs < 0) return false
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.exit.then(() => true),
        new Promise<false>(resolveWait => {
          timer = setTimeout(() => { resolveWait(false) }, graceMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async terminateTree(): Promise<void> {
    this.#requestForce()
    if (!await this.waitTreeGone(5000)) throw new CodexProcessOwnerError('spawn_failed')
  }

  killTree(): Promise<void> {
    return this.terminateTree()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    if (!this.#exitSeen) {
      this.#requestForce()
      if (!await this.waitTreeGone(5000)) throw new CodexProcessOwnerError('spawn_failed')
    }
    this.#disposed = true
    this.#control.destroy()
    this.stdin.destroy()
    this.stdout.destroy()
    this.stderr.destroy()
  }

  abandon(): void {
    if (this.#disposed) return
    try { this.#control.destroy() } catch { /* owner EOF */ }
    try { this.#child.kill('SIGKILL') } catch { /* gone */ }
    this.#disposed = true
  }

  #acceptFrame(frame: WindowsGuardianFrame): void {
    if (frame.type === 'ready') {
      if (this.#readySeen || this.#exitSeen) return this.#fail()
      this.#readySeen = true
      this.pid = frame.targetPid
      this.#resolveReady()
      return
    }
    if (!this.#readySeen || this.#exitSeen) return this.#fail()
    this.#exitSeen = true
    this.#resolveExit(frame.leaderExitCode)
  }

  #requestForce(): void {
    if (this.#forceSent || this.#exitSeen) return
    this.#forceSent = true
    try { this.#control.write(windowsGuardianForceFrame()) }
    catch { this.#control.destroy() }
  }

  #fail(): void {
    const error = new CodexProcessOwnerError('spawn_failed')
    if (!this.#readySeen) this.#rejectReady(error)
    if (!this.#exitSeen) this.#rejectExit(error)
    this.abandon()
  }
}

function launchWindowsGuardian(
  binary: string,
  argv: readonly string[],
  options: Parameters<WindowsGuardianLauncher>[2],
): WindowsGuardianChild {
  return spawn(binary, [...argv], {
    cwd: options.cwd,
    env: {...options.env},
    shell: false,
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function isReadableWritable(value: unknown): value is Readable & Writable {
  return value !== null
    && typeof value === 'object'
    && typeof Reflect.get(value, 'on') === 'function'
    && typeof Reflect.get(value, 'once') === 'function'
    && typeof Reflect.get(value, 'write') === 'function'
    && typeof Reflect.get(value, 'destroy') === 'function'
}

/** Test-only wrapper; production owners retain the opaque helper brand. */
export function windowsGuardianHelperForTest(
  configuredPath: string,
  allowlistedCanonicalPaths: readonly string[],
  architecture: string,
): string {
  if (architecture !== 'x64' && architecture !== 'arm64' && architecture !== 'ia32') {
    throw new CodexWindowsGuardianError()
  }
  return windowsGuardianHelperPath(windowsGuardianHelperFromPackage(
    configuredPath,
    allowlistedCanonicalPaths,
    architecture,
  ))
}

function requireGuardianRecord(manifest: unknown): {readonly byteSize: number; readonly sha256: string} {
  requireExactRecord(manifest, ['schema_version', 'target', 'resources'])
  if (
    manifest.schema_version !== 1
    || manifest.target !== 'win32-x64'
    || !Array.isArray(manifest.resources)
    || manifest.resources.length === 0
    || manifest.resources.length > 256
  ) throw new CodexWindowsGuardianError()
  const ids = new Set<string>()
  const paths = new Set<string>()
  let selected: {readonly byteSize: number; readonly sha256: string} | null = null
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
    ) throw new CodexWindowsGuardianError()
    ids.add(resource.logical_id)
    paths.add(resource.relative_path)
    if (resource.logical_id !== WINDOWS_GUARDIAN_ID) continue
    if (
      selected !== null
      || resource.relative_path !== WINDOWS_GUARDIAN_PATH
      || resource.kind !== 'executable'
      || resource.platform !== 'win32'
      || resource.architecture !== 'x64'
      || resource.electron_abi !== null
      || resource.build_contract_version !== 1
      || typeof resource.byte_size !== 'number'
      || !Number.isSafeInteger(resource.byte_size)
      || resource.byte_size <= 0
      || typeof resource.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(resource.sha256)
    ) throw new CodexWindowsGuardianError()
    selected = Object.freeze({byteSize: resource.byte_size, sha256: resource.sha256})
  }
  if (selected === null) throw new CodexWindowsGuardianError()
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
  ) throw new CodexWindowsGuardianError()
}

function readBoundedRegularFile(path: string, maximumBytes: number): Buffer {
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(descriptor, {bigint: true})
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximumBytes)) {
      throw new CodexWindowsGuardianError()
    }
    const size = Number(before.size)
    const bytes = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset)
      if (count === 0) throw new CodexWindowsGuardianError()
      offset += count
    }
    const after = fstatSync(descriptor, {bigint: true})
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new CodexWindowsGuardianError()
    }
    return bytes
  } finally {
    closeSync(descriptor)
  }
}

function snapshotRegularFile(path: string, maximumBytes: number): FileSnapshot {
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(descriptor, {bigint: true})
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximumBytes)) {
      throw new CodexWindowsGuardianError()
    }
    const size = Number(before.size)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(size, 64 * 1024))
    let offset = 0
    while (offset < size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, size - offset), offset)
      if (count === 0) throw new CodexWindowsGuardianError()
      hash.update(buffer.subarray(0, count))
      offset += count
    }
    const after = fstatSync(descriptor, {bigint: true})
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new CodexWindowsGuardianError()
    }
    return Object.freeze({
      device: before.dev,
      inode: before.ino,
      size,
      sha256: hash.digest('hex'),
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

function validatePortableExecutable(
  path: string,
  architecture: 'x64' | 'arm64' | 'ia32',
): void {
  const fileSize = statSync(path).size
  const buffer = new Uint8Array(4096)
  const descriptor = openSync(path, 'r')
  let bytesRead: number
  try {
    bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, 0)
  } finally {
    closeSync(descriptor)
  }
  if (bytesRead < 0x9a || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    throw new CodexWindowsGuardianError()
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, bytesRead)
  const peOffset = view.getUint32(0x3c, true)
  if (
    peOffset + 6 > bytesRead
    || buffer[peOffset] !== 0x50
    || buffer[peOffset + 1] !== 0x45
    || buffer[peOffset + 2] !== 0
    || buffer[peOffset + 3] !== 0
  ) throw new CodexWindowsGuardianError()
  const expected = architecture === 'x64' ? 0x8664 : architecture === 'arm64' ? 0xaa64 : 0x014c
  if (view.getUint16(peOffset + 4, true) !== expected) throw new CodexWindowsGuardianError()
  const numberOfSections = view.getUint16(peOffset + 6, true)
  const optionalHeaderBytes = view.getUint16(peOffset + 20, true)
  const characteristics = view.getUint16(peOffset + 22, true)
  const optionalHeaderOffset = peOffset + 24
  const expectedOptionalMagic = architecture === 'ia32' ? 0x010b : 0x020b
  if (
    numberOfSections === 0
    || numberOfSections > 96
    || optionalHeaderBytes < 2
    || optionalHeaderOffset + optionalHeaderBytes > bytesRead
    || (characteristics & 0x0002) === 0
    || (characteristics & 0x2000) !== 0
    || view.getUint16(optionalHeaderOffset, true) !== expectedOptionalMagic
  ) throw new CodexWindowsGuardianError()
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderBytes
  const sectionTableBytes = numberOfSections * 40
  if (
    !Number.isSafeInteger(fileSize)
    || fileSize <= 0
    || sectionTableOffset + sectionTableBytes > bytesRead
  ) throw new CodexWindowsGuardianError()
  let executableCodeSection = false
  for (let index = 0; index < numberOfSections; index += 1) {
    const offset = sectionTableOffset + index * 40
    const named = buffer.subarray(offset, offset + 8).some(byte => byte !== 0)
    const virtualSize = view.getUint32(offset + 8, true)
    const virtualAddress = view.getUint32(offset + 12, true)
    const rawSize = view.getUint32(offset + 16, true)
    const rawPointer = view.getUint32(offset + 20, true)
    const sectionCharacteristics = view.getUint32(offset + 36, true)
    if (
      !named
      || virtualAddress === 0
      || (virtualSize === 0 && rawSize === 0)
      || (rawSize > 0 && (rawPointer === 0 || rawPointer + rawSize > fileSize))
    ) throw new CodexWindowsGuardianError()
    executableCodeSection ||= (
      (sectionCharacteristics & 0x00000020) !== 0
      && (sectionCharacteristics & 0x20000000) !== 0
    )
  }
  if (!executableCodeSection) throw new CodexWindowsGuardianError()
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function topLevelColonCount(raw: string): number {
  let inString = false
  let escaped = false
  let depth = 0
  let count = 0
  for (const character of raw) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') depth -= 1
    else if (character === ':' && depth === 1) count += 1
  }
  if (inString || depth !== 0) throw new CodexWindowsGuardianError()
  return count
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && value instanceof Uint8Array
}
