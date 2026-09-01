import {spawn} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {constants as fsConstants} from 'node:fs'
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {createServer} from 'node:net'
import {dirname, isAbsolute, join, resolve, sep} from 'node:path'
import {homedir, tmpdir} from 'node:os'

import {
  CodexTransportError,
  type CodexAppServerLaunchConfig,
  type CodexHostPreflightRunner,
  type CodexLiveSchemaProbe,
} from './codex-app-server-transport.js'
import {APP_SERVER_INBOUND_SCHEMAS, APP_SERVER_METHOD_SCHEMAS} from './codex-app-server-schema.js'
import {hostBinaryPath, hostWorkspacePath} from './codex-process-owner.js'
import {
  createPlatformCodexProcessOwnerFactory,
  hostEphemeralCodexHomeFromConfig,
} from './codex-process-owner.js'
import {loadWindowsGuardianFactoryFromResources} from './codex-windows-guardian.js'
import {
  OwnedCodexBackendTransportFactory,
  unavailableCodexBackendTransportFactory,
  type CodexBackendTransportFactory,
} from './codex-factory.js'
import {
  CredentialSnapshotter,
  environmentValue,
  type CodexCredentialDiagnosticCode,
} from './codex-credential-snapshot.js'
import {expandUserPath, type CodexHostCatalog} from './codex-host-config.js'
import type {Settings} from './config.js'
import {
  loadProjectNativeHostFromResources,
  protectDefaultProjectDirectories,
  type ProjectNativeHost,
} from './project-native-resource.js'
import {stripLikePython} from './python-text.js'

const PROBE_ID = 'codex_sandbox_probe'
const PROBE_PATH = 'native/codex-sandbox-probe'
const PROBE_PATH_WINDOWS = 'native/codex-sandbox-probe.exe'
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_PROBE_BYTES = 4 * 1024 * 1024
const MAX_COMMAND_STDOUT = 8192
const MAX_COMMAND_STDERR = 64 * 1024
const MAX_SCHEMA_BYTES = 1024 * 1024
const PERMISSION_PROFILE = '{ filesystem = { ":root" = "read", ":workspace_roots" = { "." = "write", ".git" = "read", ".agents" = "read", ".codex" = "read" } }, network = { enabled = false } }'
const ENVIRONMENT_ALLOWLIST = new Set([
  'PATH', 'HOME', 'CODEX_HOME', 'LANG', 'LC_ALL', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
])
const PROBE_BOOLEAN_FIELDS = Object.freeze([
  'cwd_matches', 'inside_write', 'inside_remove', 'outside_write_denied',
  'child_outside_write_denied', 'network_denied',
] as const)
const LIMIT_NAMES = Object.freeze(['cpu', 'as', 'nofile'] as const)
const LIMIT_CLASSES = new Set(['finite', 'unbounded', 'unavailable'])

export interface BoundedCodexCommand {
  readonly binary: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly stdoutLimit: number
  readonly stderrLimit: number
  readonly shell: false
}

export interface BoundedCodexCommandResult {
  readonly status: number | null
  readonly stdout: Buffer
  readonly stderr?: Buffer
}

export type BoundedCodexCommandRunner = (
  command: BoundedCodexCommand,
) => Promise<BoundedCodexCommandResult>

interface ProbeLoadOptions {
  readonly resourcesPath: string
  readonly platform: string
  readonly arch: string
}

const sandboxProbeBrand: unique symbol = Symbol('ManifestBoundCodexSandboxProbe')
export interface ManifestBoundCodexSandboxProbe { readonly [sandboxProbeBrand]: true }
const sandboxProbeValues = new WeakMap<ManifestBoundCodexSandboxProbe, Readonly<{
  path: string
  snapshot: FileSnapshot
  platform: string
  arch: string
}>>()

export interface ProductionCodexHost {
  readonly catalog: CodexHostCatalog
  readonly transportFactory: CodexBackendTransportFactory
  readonly projectHost: ProjectNativeHost | null
}

interface ProductionCodexHostOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly resourcesPath?: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly electronAbi?: string
  readonly homeDirectory?: string
  readonly temporaryDirectory?: string
  readonly onDiagnostic?: (code: CodexHostDiagnosticCode) => void
}

export type CodexHostDiagnosticCode =
  | CodexCredentialDiagnosticCode
  | 'codex_login_status_nonzero'
  | 'codex_login_status_no_output'
  | 'codex_login_status_multiple_streams'
  | 'codex_login_status_unrecognized'

interface FileSnapshot {
  readonly bytes: Buffer
  readonly device: bigint
  readonly inode: bigint
  readonly mode: bigint
  readonly size: number
  readonly sha256: string
}

export function loadPackagedCodexSandboxProbe(): ManifestBoundCodexSandboxProbe | null {
  const resourcesPath = (process as NodeJS.Process & {readonly resourcesPath?: unknown}).resourcesPath
  if (typeof resourcesPath !== 'string' || resourcesPath === '') return null
  return loadCodexSandboxProbeFromResources({
    resourcesPath,
    platform: process.platform,
    arch: process.arch,
  })
}

/** Build the one host-owned Codex catalog/resource graph used by the desktop entry. */
export function createProductionCodexHost(
  settings: Settings,
  options: ProductionCodexHostOptions = {},
): ProductionCodexHost {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const homeDirectory = canonicalDirectory(options.homeDirectory ?? homedir())
  const workspace = homeDirectory === null
    ? null
    : canonicalDirectory(expandUserPath(settings.codex_workspace ?? '', homeDirectory))
  const configuredBinary = stripLikePython(settings.codex_bin)
  const binary = configuredBinary === 'codex' ? null : canonicalRegularExecutable(configuredBinary)
  const catalog: CodexHostCatalog = Object.freeze({
    canonicalBinaries: Object.freeze(binary === null ? [] : [binary]),
    canonicalWorkspaces: Object.freeze(workspace === null ? [] : [workspace]),
    defaultBinary: null,
    homeDirectory: homeDirectory ?? resolve(options.homeDirectory ?? homedir()),
  })
  const resourcesPath = options.resourcesPath ?? packagedResourcesPath()
  if (
    resourcesPath === null
    || workspace === null
    || binary === null
    || homeDirectory === null
  ) return Object.freeze({
    catalog,
    transportFactory: unavailableCodexBackendTransportFactory,
    projectHost: null,
  })
  const probe = loadCodexSandboxProbeFromResources({resourcesPath, platform, arch})
  if (probe === null) return Object.freeze({
    catalog,
    transportFactory: unavailableCodexBackendTransportFactory,
    projectHost: null,
  })
  const windowsGuardianFactory = platform === 'win32'
    ? loadWindowsGuardianFactoryFromResources({resourcesPath, platform, arch})
    : null
  if (platform === 'win32' && windowsGuardianFactory === null) return Object.freeze({
    catalog,
    transportFactory: unavailableCodexBackendTransportFactory,
    projectHost: null,
  })
  let projectHost = loadProjectNativeHostFromResources({
    resourcesPath,
    platform,
    arch,
    electronAbi: options.electronAbi ?? process.versions.modules,
  })
  if (projectHost !== null && !protectDefaultProjectDirectories(projectHost, {
    homeDirectory,
    stateRoot: canonicalDirectory(stripLikePython(settings.codex_project_state_root)),
    managedRoot: canonicalDirectory(stripLikePython(settings.codex_managed_root)),
    workspace,
  })) projectHost = null
  const temporaryDirectory = options.temporaryDirectory === undefined
    ? canonicalSystemTemporaryDirectoryForTest(tmpdir())
    : canonicalDirectory(options.temporaryDirectory)
  if (temporaryDirectory === null) return Object.freeze({
    catalog,
    transportFactory: unavailableCodexBackendTransportFactory,
    projectHost,
  })
  const credentialSnapshotter = new CredentialSnapshotter({
    environment,
    platform,
    ...(options.onDiagnostic === undefined ? {} : {onDiagnostic: options.onDiagnostic}),
    ...(typeof environment.CODEX_HOME === 'string' && environment.CODEX_HOME !== ''
      ? {sourceHome: environment.CODEX_HOME}
      : {}),
  })
  const transportFactory = new OwnedCodexBackendTransportFactory({
    processFactory: createPlatformCodexProcessOwnerFactory({
      platform,
      ...(windowsGuardianFactory === null ? {} : {windowsGuardianFactory}),
    }),
    credentialSnapshotter,
    preflightRunner: new NativeCodexHostPreflightRunner({
      probe,
      environment,
      platform,
      hasApiKey: settings.codex_api_key !== null,
      ...(options.onDiagnostic === undefined ? {} : {onDiagnostic: options.onDiagnostic}),
      ...(windowsGuardianFactory === null
        ? {}
        : {commandRunner: command => windowsGuardianFactory.runCommand(command)}),
    }),
    schemaProbe: new NativeCodexLiveSchemaProbe({
      environment,
      platform,
      ...(windowsGuardianFactory === null
        ? {}
        : {commandRunner: command => windowsGuardianFactory.runCommand(command)}),
    }),
    ephemeralHomeFactory: () => {
      const path = realpathSync(mkdtempSync(join(temporaryDirectory, 'nova-codex-home-')))
      chmodSync(path, 0o700)
      return hostEphemeralCodexHomeFromConfig(path, [path])
    },
  })
  return Object.freeze({catalog, transportFactory, projectHost})
}

/** Host-only seam. Renderer, model, work order, and settings values cannot select this path. */
export function loadCodexSandboxProbeFromResources(
  options: ProbeLoadOptions,
): ManifestBoundCodexSandboxProbe | null {
  try {
    const target = supportedTarget(options.platform, options.arch)
    if (target === null || !isAbsolute(options.resourcesPath)) return null
    const resourcesRoot = resolve(options.resourcesPath)
    if (realpathSync(resourcesRoot) !== resourcesRoot) return null
    const manifest = JSON.parse(snapshotRegularFile(
      resolve(resourcesRoot, 'native-resources-v1.json'),
      MAX_MANIFEST_BYTES,
    ).bytes.toString('utf8')) as unknown
    const expectedPath = options.platform === 'win32' ? PROBE_PATH_WINDOWS : PROBE_PATH
    const record = requireProbeRecord(
      manifest,
      target,
      expectedPath,
      options.platform,
      options.arch,
    )
    const probePath = resolve(resourcesRoot, expectedPath)
    if (realpathSync(probePath) !== probePath) return null
    const before = snapshotRegularFile(probePath, MAX_PROBE_BYTES)
    if (
      before.size !== record.byteSize
      || before.sha256 !== record.sha256
      || !validExecutable(before.bytes, options.platform, options.arch)
      || (
        process.platform !== 'win32'
        && options.platform !== 'win32'
        && (before.mode & 0o111n) !== 0o111n
      )
    ) return null
    const after = snapshotRegularFile(probePath, MAX_PROBE_BYTES)
    if (!sameSnapshot(before, after)) return null
    const capability = Object.freeze({[sandboxProbeBrand]: true as const})
    sandboxProbeValues.set(capability, Object.freeze({
      path: probePath,
      snapshot: before,
      platform: options.platform,
      arch: options.arch,
    }))
    return capability
  } catch {
    return null
  }
}

/** Test-only projection; production execution retains the opaque capability. */
export function codexSandboxProbePathForTest(probe: ManifestBoundCodexSandboxProbe): string {
  const value = sandboxProbeValues.get(probe)
  if (value === undefined) throw new CodexTransportError('sandbox_failed')
  return value.path
}

export class NativeCodexHostPreflightRunner implements CodexHostPreflightRunner {
  readonly #probe: ManifestBoundCodexSandboxProbe | null
  readonly #testProbe: Readonly<{path: string; snapshot: FileSnapshot}> | null
  readonly #environment: Readonly<Record<string, string>>
  readonly #hasApiKey: boolean
  readonly #runCommand: BoundedCodexCommandRunner
  readonly #onDiagnostic: (code: CodexHostDiagnosticCode) => void

  constructor(options: {
    readonly probe?: ManifestBoundCodexSandboxProbe
    readonly probePath?: string
    readonly environment: Readonly<Record<string, string | undefined>>
    readonly platform?: NodeJS.Platform
    readonly hasApiKey: boolean
    readonly commandRunner?: BoundedCodexCommandRunner
    readonly onDiagnostic?: (code: CodexHostDiagnosticCode) => void
  }) {
    if ((options.probe === undefined) === (options.probePath === undefined)) {
      throw new CodexTransportError('sandbox_failed')
    }
    if (options.probe !== undefined) {
      if (sandboxProbeValues.get(options.probe) === undefined) {
        throw new CodexTransportError('sandbox_failed')
      }
      this.#probe = options.probe
      this.#testProbe = null
    } else {
      const path = options.probePath!
      if (!isAbsolute(path) || realpathSync(path) !== path) {
        throw new CodexTransportError('sandbox_failed')
      }
      this.#probe = null
      this.#testProbe = Object.freeze({path, snapshot: snapshotRegularFile(path, MAX_PROBE_BYTES)})
    }
    this.#environment = filteredEnvironment(options.environment, options.platform ?? process.platform)
    this.#hasApiKey = options.hasApiKey
    this.#runCommand = options.commandRunner ?? runBoundedCodexCommand
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  async run(config: CodexAppServerLaunchConfig, timeoutMs: number): Promise<unknown> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new CodexTransportError('preflight_timeout')
    }
    const deadline = Date.now() + Math.min(timeoutMs, 20_000)
    try {
      const binary = hostBinaryPath(config.binary)
      const prefixArgs = config.prefixArgs ?? []
      const workspace = hostWorkspacePath(config.workspace)
      requireWorkspaceRoot(workspace)
      const versionResult = await this.#command(
        binary, [...prefixArgs, '--version'], workspace, deadline, 4096,
      )
      const version = parseVersion(versionResult)
      let credential
      if (this.#hasApiKey) {
        credential = Object.freeze({present: true, identity: 'api_key', policy: 'process_only'})
      } else {
        const loginResult = await this.#command(
          binary,
          [...prefixArgs, 'login', 'status'],
          workspace,
          deadline,
          4096,
        )
        let identity: 'chatgpt' | 'api_key'
        try {
          identity = parseLogin(loginResult)
        } catch (error) {
          this.#emitDiagnostic(loginDiagnostic(loginResult))
          throw error
        }
        credential = Object.freeze({present: true, identity, policy: 'saved_login'})
      }
      const limits = await this.#runSandboxProbe(binary, prefixArgs, workspace, deadline)
      return Object.freeze({
        version,
        root_matches: true,
        mount: 'workspace_only',
        subprocess: 'contained',
        network: 'blocked',
        credential,
        limits,
      })
    } catch (error) {
      if (error instanceof CodexTransportError) throw new CodexTransportError(error.code)
      throw new CodexTransportError('preflight_failed')
    }
  }

  #emitDiagnostic(code: CodexHostDiagnosticCode): void {
    try { this.#onDiagnostic(code) } catch { /* diagnostics are advisory */ }
  }

  async #runSandboxProbe(
    binary: string,
    prefixArgs: readonly string[],
    workspace: string,
    deadline: number,
  ): Promise<Readonly<Record<string, string>>> {
    const materialized = this.#materializeProbe()
    const parent = dirname(workspace)
    const sibling = mkdtempSync(join(parent, '.nova-audio-agent-codex-preflight-'))
    const canary = join(sibling, 'canary')
    const marker = join(
      workspace,
      `.nova-audio-agent-codex-preflight-${randomUUID().replaceAll('-', '')}`,
    )
    chmodSync(sibling, 0o700)
    writeFileSync(canary, 'host-created-canary', {encoding: 'utf8', mode: 0o600, flag: 'wx'})
    const canonicalCanary = realpathSync(canary)
    const server = createServer(socket => socket.end())
    try {
      const port = await listenLoopback(server, Math.max(1, deadline - Date.now()))
      const result = await this.#command(binary, [...prefixArgs,
        'sandbox', '-P', 'nova_audio_agent', '-C', workspace,
        '-c', `permissions.nova_audio_agent=${PERMISSION_PROFILE}`,
        '-c', 'shell_environment_policy.inherit="core"',
        '-c', 'shell_environment_policy.include_only=["PATH","LANG","LC_ALL","TERM"]',
        materialized.path,
        '--main', workspace, canonicalCanary, marker, String(port),
      ], workspace, deadline, MAX_COMMAND_STDOUT)
      const limits = parseProbe(result)
      if (readFileSync(canary, 'utf8') !== 'host-created-canary') {
        throw new CodexTransportError('sandbox_failed')
      }
      try {
        lstatSync(marker)
        throw new CodexTransportError('sandbox_failed')
      } catch (error) {
        if (error instanceof CodexTransportError) throw error
        if (!isErrno(error, 'ENOENT')) throw new CodexTransportError('sandbox_failed')
      }
      materialized.verify()
      return limits
    } finally {
      await closeServer(server)
      rmSync(sibling, {recursive: true, force: true})
      materialized.cleanup()
    }
  }

  #materializeProbe(): Readonly<{path: string; verify(): void; cleanup(): void}> {
    const production = this.#probe === null ? undefined : sandboxProbeValues.get(this.#probe)
    const source = production ?? this.#testProbe
    if (source === null || source === undefined) throw new CodexTransportError('sandbox_failed')
    if (!sameSnapshot(source.snapshot, snapshotRegularFile(source.path, MAX_PROBE_BYTES))) {
      throw new CodexTransportError('sandbox_failed')
    }
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'nova-codex-probe-')))
    chmodSync(directory, 0o700)
    const suffix = production?.platform === 'win32' ? '.exe' : ''
    const destination = join(directory, `sandbox-probe${suffix}`)
    try {
      writeFileSync(destination, source.snapshot.bytes, {flag: 'wx', mode: 0o700})
      chmodSync(destination, 0o700)
      const canonical = realpathSync(destination)
      const copied = snapshotRegularFile(canonical, MAX_PROBE_BYTES)
      if (
        copied.size !== source.snapshot.size
        || copied.sha256 !== source.snapshot.sha256
        || (production !== undefined && !validExecutable(
          copied.bytes,
          production.platform,
          production.arch,
        ))
      ) throw new CodexTransportError('sandbox_failed')
      return Object.freeze({
        path: canonical,
        verify: () => {
          if (!sameSnapshot(copied, snapshotRegularFile(canonical, MAX_PROBE_BYTES))) {
            throw new CodexTransportError('sandbox_failed')
          }
        },
        cleanup: () => { rmSync(directory, {recursive: true, force: true}) },
      })
    } catch (error) {
      rmSync(directory, {recursive: true, force: true})
      if (error instanceof CodexTransportError) throw error
      throw new CodexTransportError('sandbox_failed')
    }
  }

  #command(
    binary: string,
    argv: readonly string[],
    cwd: string,
    deadline: number,
    stdoutLimit: number,
  ): Promise<BoundedCodexCommandResult> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new CodexTransportError('preflight_timeout')
    return this.#runCommand(Object.freeze({
      binary,
      argv: Object.freeze([...argv]),
      cwd,
      environment: this.#environment,
      timeoutMs: remaining,
      stdoutLimit,
      stderrLimit: MAX_COMMAND_STDERR,
      shell: false as const,
    }))
  }
}

export class NativeCodexLiveSchemaProbe implements CodexLiveSchemaProbe {
  readonly #environment: Readonly<Record<string, string>>
  readonly #runCommand: BoundedCodexCommandRunner

  constructor(options: {
    readonly environment: Readonly<Record<string, string | undefined>>
    readonly platform?: NodeJS.Platform
    readonly commandRunner?: BoundedCodexCommandRunner
  }) {
    this.#environment = filteredEnvironment(options.environment, options.platform ?? process.platform)
    this.#runCommand = options.commandRunner ?? runBoundedCodexCommand
  }

  async generate(
    config: CodexAppServerLaunchConfig,
    timeoutMs: number,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new CodexTransportError('preflight_timeout')
    }
    const directory = mkdtempSync(join(dirname(hostWorkspacePath(config.workspace)), '.nova-codex-schema-'))
    chmodSync(directory, 0o700)
    try {
      const result = await this.#runCommand(Object.freeze({
        binary: hostBinaryPath(config.binary),
        argv: Object.freeze([
          ...(config.prefixArgs ?? []),
          'app-server', 'generate-json-schema', '--out', directory,
        ]),
        cwd: hostWorkspacePath(config.workspace),
        environment: this.#environment,
        timeoutMs: Math.min(timeoutMs, 20_000),
        stdoutLimit: MAX_COMMAND_STDERR,
        stderrLimit: MAX_COMMAND_STDERR,
        shell: false as const,
      }))
      if (result.status !== 0) throw new CodexTransportError('unsupported_protocol')
      const files = new Set<string>(['ClientRequest.json'])
      for (const spec of Object.values(APP_SERVER_METHOD_SCHEMAS)) files.add(spec.file)
      for (const spec of APP_SERVER_INBOUND_SCHEMAS) files.add(spec.file)
      const bundle: Record<string, unknown> = {}
      for (const name of files) {
        const path = resolve(directory, name)
        if (!path.startsWith(`${directory}${sep}`)) {
          throw new CodexTransportError('unsupported_protocol')
        }
        const snapshot = snapshotRegularFile(path, MAX_SCHEMA_BYTES)
        try { bundle[name] = JSON.parse(snapshot.bytes.toString('utf8')) as unknown }
        catch { throw new CodexTransportError('unsupported_protocol') }
      }
      return Object.freeze(bundle)
    } catch (error) {
      if (error instanceof CodexTransportError) throw new CodexTransportError(error.code)
      throw new CodexTransportError('unsupported_protocol')
    } finally {
      rmSync(directory, {recursive: true, force: true})
    }
  }
}

export async function runBoundedCodexCommand(
  command: BoundedCodexCommand,
): Promise<BoundedCodexCommandResult> {
  if (
    !isAbsolute(command.binary)
    || !isAbsolute(command.cwd)
    || !Number.isFinite(command.timeoutMs)
    || command.timeoutMs <= 0
  ) throw new CodexTransportError('preflight_failed')
  let child
  try {
    child = spawn(command.binary, [...command.argv], {
      cwd: command.cwd,
      env: {...command.environment},
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch {
    throw new CodexTransportError('binary_missing')
  }
  let stdout = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  let rejectBoundary!: (error: Error) => void
  const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject })
  let boundaryFailed = false
  const fail = (code: 'preflight_failed' | 'preflight_timeout' | 'binary_missing'): void => {
    if (boundaryFailed) return
    boundaryFailed = true
    rejectBoundary(new CodexTransportError(code))
  }
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.byteLength + chunk.byteLength > command.stdoutLimit) {
      fail('preflight_failed')
      return
    }
    stdout = Buffer.concat([stdout, chunk])
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.byteLength + chunk.byteLength > command.stderrLimit) {
      fail('preflight_failed')
      return
    }
    stderr = Buffer.concat([stderr, chunk])
  })
  const exit = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', () => { rejectExit(new CodexTransportError('binary_missing')) })
    child.once('exit', status => { resolveExit(status) })
  })
  exit.catch(() => undefined)
  const stdoutClosed = streamClosed(child.stdout)
  const stderrClosed = streamClosed(child.stderr)
  const deadline = Date.now() + command.timeoutMs
  const timeout = setTimeout(() => { fail('preflight_timeout') }, command.timeoutMs)
  try {
    const status = await Promise.race([exit, boundary])
    await settleBefore(
      Promise.race([Promise.all([stdoutClosed, stderrClosed]), boundary]),
      deadline,
      'preflight_timeout',
    )
    if (process.platform !== 'win32' && processGroupAlive(child.pid)) {
      throw new CodexTransportError('preflight_failed')
    }
    return Object.freeze({
      status,
      stdout,
      ...(stderr.byteLength === 0 ? {} : {stderr}),
    })
  } catch (error) {
    await stopAndReapCommandTree(child.pid, exit, stdoutClosed, stderrClosed)
    if (error instanceof CodexTransportError) throw error
    throw new CodexTransportError('preflight_failed')
  } finally {
    clearTimeout(timeout)
  }
}

function streamClosed(stream: NodeJS.ReadableStream): Promise<void> {
  if (Reflect.get(stream, 'closed') === true || Reflect.get(stream, 'destroyed') === true) {
    return Promise.resolve()
  }
  return new Promise(resolveClose => { stream.once('close', () => { resolveClose() }) })
}

async function settleBefore<T>(
  operation: Promise<T>,
  deadline: number,
  code: 'preflight_timeout' | 'preflight_failed',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new CodexTransportError(code))
        }, Math.max(0, deadline - Date.now()))
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function stopAndReapCommandTree(
  pid: number | undefined,
  exit: Promise<number | null>,
  stdoutClosed: Promise<void>,
  stderrClosed: Promise<void>,
): Promise<void> {
  signalCommandTree(pid)
  const deadline = Date.now() + 5000
  try {
    await settleBefore(
      Promise.allSettled([exit, stdoutClosed, stderrClosed]),
      deadline,
      'preflight_failed',
    )
  } catch {
    throw new CodexTransportError('preflight_failed')
  }
  while (process.platform !== 'win32' && processGroupAlive(pid)) {
    if (Date.now() >= deadline) throw new CodexTransportError('preflight_failed')
    await new Promise(resolveWait => { setTimeout(resolveWait, 25) })
  }
}

function signalCommandTree(pid: number | undefined): void {
  if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 0) return
  try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL') } catch (error) {
    if (!isErrno(error, 'ESRCH')) throw new CodexTransportError('preflight_failed')
  }
}

function processGroupAlive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 0) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false
    if (isErrno(error, 'EPERM')) return true
    throw new CodexTransportError('preflight_failed')
  }
}

function parseVersion(result: BoundedCodexCommandResult): string {
  const value = decodeSuccessful(result, 'unsupported_version')
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)$/u.exec(value)
  if (match === null) throw new CodexTransportError('unsupported_version')
  const version = match.slice(1).map(Number)
  if (!version.every(Number.isSafeInteger) || compareVersion(version, [0, 145, 0]) < 0) {
    throw new CodexTransportError('unsupported_version')
  }
  return version.join('.')
}

function parseLogin(result: BoundedCodexCommandResult): 'chatgpt' | 'api_key' {
  const lines = decodeSuccessfulLogin(result)
    .split(/\r?\n/u)
    .map(value => value.trim().replaceAll(/\s+/gu, ' '))
    .filter(Boolean)
  const identities = lines.flatMap(line => {
    if (line === 'Logged in using ChatGPT') return ['chatgpt' as const]
    if (line === 'Logged in using API key' || /^Logged in using an API key - (?:\*\*\*|\S{8}\*\*\*\S{5})$/u.test(line)) {
      return ['api_key' as const]
    }
    if (/logged in|chatgpt|api key/iu.test(line)) throw new CodexTransportError('credential_missing')
    return []
  })
  if (identities.length !== 1) throw new CodexTransportError('credential_missing')
  return identities[0]!
}

function loginDiagnostic(result: BoundedCodexCommandResult): CodexHostDiagnosticCode {
  if (result.status !== 0) return 'codex_login_status_nonzero'
  const streams = [result.stdout, result.stderr]
    .filter((value): value is Buffer => Buffer.isBuffer(value) && value.byteLength > 0)
  if (streams.length === 0) return 'codex_login_status_no_output'
  if (streams.length > 1) return 'codex_login_status_multiple_streams'
  return 'codex_login_status_unrecognized'
}

function decodeSuccessfulLogin(result: BoundedCodexCommandResult): string {
  const streams = [result.stdout, result.stderr]
    .filter((value): value is Buffer => Buffer.isBuffer(value) && value.byteLength > 0)
  if (result.status !== 0 || streams.length !== 1) {
    throw new CodexTransportError('credential_missing')
  }
  try { return stripLikePython(new TextDecoder('utf-8', {fatal: true}).decode(streams[0])) }
  catch { throw new CodexTransportError('credential_missing') }
}

function parseProbe(result: BoundedCodexCommandResult): Readonly<Record<string, string>> {
  const value = decodeSuccessful(result, 'sandbox_failed')
  let document: unknown
  try { document = JSON.parse(value) as unknown }
  catch { throw new CodexTransportError('sandbox_failed') }
  if (!isPlainRecord(document)) throw new CodexTransportError('sandbox_failed')
  if (!exactKeys(document, [...PROBE_BOOLEAN_FIELDS, 'limits'])) {
    throw new CodexTransportError('sandbox_failed')
  }
  if (PROBE_BOOLEAN_FIELDS.some(name => document[name] !== true)) {
    throw new CodexTransportError('sandbox_failed')
  }
  const rawLimits = document.limits
  if (!isPlainRecord(rawLimits) || !exactKeys(rawLimits, LIMIT_NAMES)) {
    throw new CodexTransportError('sandbox_failed')
  }
  const limits: Record<string, string> = {}
  for (const name of LIMIT_NAMES) {
    const candidate = rawLimits[name]
    if (typeof candidate !== 'string' || !LIMIT_CLASSES.has(candidate)) {
      throw new CodexTransportError('sandbox_failed')
    }
    limits[name] = candidate
  }
  return Object.freeze(limits)
}

function decodeSuccessful(
  result: BoundedCodexCommandResult,
  code: 'unsupported_version' | 'credential_missing' | 'sandbox_failed',
): string {
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new CodexTransportError(code)
  try { return new TextDecoder('utf-8', {fatal: true}).decode(result.stdout).trim() }
  catch { throw new CodexTransportError(code) }
}

function filteredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  try {
    for (const name of ENVIRONMENT_ALLOWLIST) {
      const value = environmentValue(environment, name, platform)
      if (typeof value === 'string' && value !== '' && !value.includes('\0')) result[name] = value
    }
  } catch {
    throw new CodexTransportError('preflight_failed')
  }
  if (result.PATH === undefined || result.HOME === undefined) {
    throw new CodexTransportError('preflight_failed')
  }
  return Object.freeze(result)
}

function requireWorkspaceRoot(workspace: string): void {
  try {
    if (realpathSync(workspace) !== workspace || !statSync(workspace).isDirectory()) throw new Error()
    try {
      const marker = lstatSync(join(workspace, '.git'))
      if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) throw new Error()
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
  } catch {
    throw new CodexTransportError('workspace_root_mismatch')
  }
}

async function listenLoopback(server: ReturnType<typeof createServer>, timeoutMs: number): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const timer = setTimeout(() => {
      server.close()
      rejectPort(new CodexTransportError('preflight_timeout'))
    }, timeoutMs)
    server.once('error', () => {
      clearTimeout(timer)
      rejectPort(new CodexTransportError('sandbox_failed'))
    })
    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timer)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        rejectPort(new CodexTransportError('sandbox_failed'))
        return
      }
      resolvePort(address.port)
    })
  })
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return
  await new Promise<void>(resolveClose => { server.close(() => { resolveClose() }) })
}

function requireProbeRecord(
  manifest: unknown,
  target: string,
  expectedPath: string,
  platform: string,
  arch: string,
): {readonly byteSize: number; readonly sha256: string} {
  requireExactRecord(manifest, ['schema_version', 'target', 'resources'])
  if (
    manifest.schema_version !== 1
    || manifest.target !== target
    || !Array.isArray(manifest.resources)
    || manifest.resources.length === 0
    || manifest.resources.length > 256
  ) {
    throw new Error('native resource rejected')
  }
  let selected: {readonly byteSize: number; readonly sha256: string} | null = null
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
    if (resource.logical_id !== PROBE_ID) continue
    if (
      resource.relative_path !== expectedPath
      || resource.kind !== 'executable'
      || resource.platform !== platform
      || resource.architecture !== arch
      || resource.electron_abi !== null
      || resource.build_contract_version !== 1
      || typeof resource.byte_size !== 'number'
      || !Number.isSafeInteger(resource.byte_size)
      || resource.byte_size <= 0
      || typeof resource.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(resource.sha256)
      || selected !== null
    ) throw new Error('native resource rejected')
    selected = {byteSize: resource.byte_size, sha256: resource.sha256}
  }
  if (selected === null) throw new Error('native resource rejected')
  return selected
}

function snapshotRegularFile(path: string, maximumBytes: number): FileSnapshot {
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(descriptor, {bigint: true})
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximumBytes)) throw new Error()
    const size = Number(before.size)
    const bytes = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset)
      if (count === 0) throw new Error()
      offset += count
    }
    const after = fstatSync(descriptor, {bigint: true})
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw new Error()
    return Object.freeze({
      bytes,
      device: before.dev,
      inode: before.ino,
      mode: before.mode,
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
    && left.mode === right.mode
    && left.size === right.size
    && left.sha256 === right.sha256
}

function validExecutable(bytes: Buffer, platform: string, arch: string): boolean {
  if (platform === 'darwin') {
    const cpu = arch === 'arm64' ? 0x0100000c : 0x01000007
    return bytes.length >= 16
      && bytes.readUInt32LE(0) === 0xfeedfacf
      && bytes.readUInt32LE(4) === cpu
      && bytes.readUInt32LE(12) === 2
  }
  if (platform === 'linux') {
    return bytes.length >= 20
      && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      && bytes[4] === 2
      && bytes[5] === 1
      && bytes.readUInt16LE(16) === 3
      && bytes.readUInt16LE(18) === 0x3e
  }
  if (bytes.length < 64 || bytes.subarray(0, 2).toString('ascii') !== 'MZ') return false
  const offset = bytes.readUInt32LE(0x3c)
  return offset + 24 <= bytes.length
    && bytes.subarray(offset, offset + 4).toString('binary') === 'PE\0\0'
    && bytes.readUInt16LE(offset + 4) === 0x8664
    && (bytes.readUInt16LE(offset + 22) & 0x2000) === 0
}

function supportedTarget(platform: string, arch: string): string | null {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `darwin-${arch}`
  if (platform === 'linux' && arch === 'x64') return 'linux-x64-gnu'
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  return null
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error('native resource rejected')
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}

function packagedResourcesPath(): string | null {
  const value = (process as NodeJS.Process & {readonly resourcesPath?: unknown}).resourcesPath
  return typeof value === 'string' && value !== '' ? value : null
}

function canonicalDirectory(candidate: string): string | null {
  try {
    if (!isAbsolute(candidate)) return null
    const link = lstatSync(candidate)
    const canonical = realpathSync(candidate)
    if (link.isSymbolicLink() || !link.isDirectory() || canonical !== resolve(candidate)) return null
    return canonical
  } catch {
    return null
  }
}

/** Test seam for the host-owned OS temp alias; caller-configured paths stay lexically canonical. */
export function canonicalSystemTemporaryDirectoryForTest(candidate: string): string | null {
  try {
    return canonicalDirectory(realpathSync(candidate))
  } catch {
    return null
  }
}

function canonicalRegularExecutable(candidate: string): string | null {
  try {
    if (!isAbsolute(candidate)) return null
    const link = lstatSync(candidate)
    const canonical = realpathSync(candidate)
    const info = statSync(canonical)
    if (
      link.isSymbolicLink()
      || !info.isFile()
      || canonical !== resolve(candidate)
      || (process.platform !== 'win32' && (info.mode & 0o111) === 0)
    ) return null
    return canonical
  } catch {
    return null
  }
}
