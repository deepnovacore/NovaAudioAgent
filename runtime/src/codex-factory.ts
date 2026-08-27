import {
  OwnedCodexAppServerTransport,
  type CodexAppServerTransport,
  type CodexHostPreflightRunner,
  type CodexLiveSchemaProbe,
  type RunInput,
  type SafePreflightReport,
  type SteerInput,
  type SteerTransportResult,
  type TransportDeadline,
  type TransportObserver,
  type TransportOutcome,
} from './codex-app-server-transport.js'
import type {
  CodexCredentialProfile,
  ResolvedCodexHostConfig,
} from './codex-host-config.js'
import {codexCredentialApiKey} from './codex-host-config.js'
import type {CredentialSnapshotter} from './codex-credential-snapshot.js'
import type {PublicProjectView} from './codex-project-store.js'
import {
  CodexProjectStore,
  MAX_PROJECT_WORKSPACE_NAME,
  ProjectStateError,
} from './codex-project-store.js'
import type {NativeFileLockAuthority} from './native-file-lock.js'
import type {ProjectRootFileAuthority} from './project-root-file.js'
import {
  hostWorkspacePath,
  type CodexProcessOwnerFactory,
  type HostBinary,
  type HostCodexHome,
  type HostWorkspace,
} from './codex-process-owner.js'
import type {ExecutorAdapter} from './causal-runtime.js'
import type {Clock} from './clock.js'
import {CodexHostConfigurationError} from './codex-host-config.js'
import {ProjectCodexAdapter} from './executors/codex-project-live.js'
import {CodexAdapter} from './executors/codex.js'
import {ProjectConfirmationController} from './realtime/project-confirmation.js'
import {basename} from 'node:path'

export type CodexAssemblyMode = 'ordinary' | 'live' | 'project'

export interface CodexTransportBinding {
  readonly mode: CodexAssemblyMode
  readonly binary: HostBinary
  readonly binaryPrefixArgs: readonly string[]
  readonly workspace: HostWorkspace
  readonly codexHome: HostCodexHome | null
  readonly credential: CodexCredentialProfile
  readonly resumeThreadId: string | null
  readonly workingInterval: number
}

export interface CodexBackendTransportFactory {
  readonly available: boolean
  create(binding: CodexTransportBinding): CodexAppServerTransport
}

/** Host resources below the reviewed 6B transport. Task 8 supplies their packaged implementations. */
export interface OwnedCodexBackendTransportFactoryOptions {
  readonly processFactory: CodexProcessOwnerFactory
  readonly credentialSnapshotter: CredentialSnapshotter
  readonly preflightRunner: CodexHostPreflightRunner
  readonly schemaProbe: CodexLiveSchemaProbe
  readonly ephemeralHomeFactory: () => HostCodexHome
}

export class OwnedCodexBackendTransportFactory implements CodexBackendTransportFactory {
  readonly available = true
  readonly #options: OwnedCodexBackendTransportFactoryOptions

  constructor(options: OwnedCodexBackendTransportFactoryOptions) {
    this.#options = options
  }

  create(binding: CodexTransportBinding): CodexAppServerTransport {
    const project = binding.mode === 'project'
    const codexHome = project ? binding.codexHome : this.#options.ephemeralHomeFactory()
    if (codexHome === null) throw new CodexHostConfigurationError('codex_host_unavailable')
    const transport = new OwnedCodexAppServerTransport({
      config: {
        binary: binding.binary,
        prefixArgs: binding.binaryPrefixArgs,
        workspace: binding.workspace,
        codexHome,
        apiKey: codexCredentialApiKey(binding.credential),
        developerInstructions: null,
        resumeThreadId: binding.resumeThreadId,
        persistent: project,
        workingInterval: binding.workingInterval,
      },
      processFactory: this.#options.processFactory,
      credentialSnapshotter: this.#options.credentialSnapshotter,
      preflightRunner: this.#options.preflightRunner,
      schemaProbe: this.#options.schemaProbe,
    })
    return new CredentialHomeOwningTransport(
      transport,
      this.#options.credentialSnapshotter,
      codexHome,
    )
  }
}

class CredentialHomeOwningTransport implements CodexAppServerTransport {
  #closeOperation: Promise<void> | null = null

  constructor(
    readonly inner: CodexAppServerTransport,
    readonly credentials: CredentialSnapshotter,
    readonly codexHome: HostCodexHome,
  ) {}

  preflight(deadline: TransportDeadline): Promise<SafePreflightReport> {
    return this.inner.preflight(deadline)
  }

  prewarm(deadline: TransportDeadline): Promise<SafePreflightReport | null> {
    return this.inner.prewarm(deadline)
  }

  run(
    input: RunInput,
    observer: TransportObserver,
    deadline: TransportDeadline,
  ): Promise<TransportOutcome> {
    return this.inner.run(input, observer, deadline)
  }

  steer(input: SteerInput, deadline: TransportDeadline): Promise<SteerTransportResult> {
    return this.inner.steer(input, deadline)
  }

  close(reason?: 'shutdown' | 'cancel' | 'failure'): Promise<void> {
    if (this.#closeOperation !== null) return this.#closeOperation
    const work = this.#close(reason)
    const exposed = work.catch(error => {
      if (this.#closeOperation === exposed) this.#closeOperation = null
      throw error
    })
    this.#closeOperation = exposed
    return exposed
  }

  async #close(reason?: 'shutdown' | 'cancel' | 'failure'): Promise<void> {
    await this.inner.close(reason)
    await this.credentials.removeEphemeralHome(this.codexHome)
  }
}

export const unavailableCodexBackendTransportFactory: CodexBackendTransportFactory = Object.freeze({
  available: false,
  create: (): CodexAppServerTransport => {
    throw new CodexHostConfigurationError('codex_host_unavailable')
  },
})

export interface CodexAssemblyResource {
  readonly adapter: ExecutorAdapter
  readonly mode: CodexAssemblyMode
  readonly projectView: PublicProjectView | null
  start(): Promise<void>
  close(): Promise<void>
}

export interface CreateCodexAssemblyResourceOptions {
  readonly config: ResolvedCodexHostConfig
  readonly composition: 'ordinary' | 'realtime'
  readonly transportFactory: CodexBackendTransportFactory
  readonly clock: Clock
  readonly now?: () => number
  readonly idFactory: () => string
  readonly projectHost?: {
    readonly nativeLocks: NativeFileLockAuthority
    readonly rootFiles: ProjectRootFileAuthority
  }
  readonly onProjectView?: (view: PublicProjectView) => void
}

export async function createCodexAssemblyResource(
  options: CreateCodexAssemblyResourceOptions,
): Promise<CodexAssemblyResource> {
  let available = false
  try { available = options.transportFactory.available === true } catch { /* safe failure below */ }
  if (!available) {
    throw new CodexHostConfigurationError('codex_host_unavailable')
  }
  if (options.composition === 'realtime') {
    return await createProjectResource(options)
  }
  const binding: CodexTransportBinding = Object.freeze({
    mode: 'ordinary',
    binary: options.config.binary,
    binaryPrefixArgs: options.config.binaryPrefixArgs,
    workspace: options.config.workspace,
    codexHome: null,
    credential: options.config.credential,
    resumeThreadId: null,
    workingInterval: options.config.workingInterval,
  })
  let transport: CodexAppServerTransport
  try {
    transport = options.transportFactory.create(binding)
  } catch {
    throw new CodexHostConfigurationError('codex_host_unavailable')
  }
  if (!isCodexTransport(transport)) {
    throw new CodexHostConfigurationError('codex_host_unavailable')
  }
  return new BasicCodexAssemblyResource(
    new CodexAdapter(transport),
    transport,
  )
}

function isCodexTransport(value: unknown): value is CodexAppServerTransport {
  try {
    return typeof value === 'object'
      && value !== null
      && typeof (value as CodexAppServerTransport).preflight === 'function'
      && typeof (value as CodexAppServerTransport).prewarm === 'function'
      && typeof (value as CodexAppServerTransport).run === 'function'
      && typeof (value as CodexAppServerTransport).steer === 'function'
      && typeof (value as CodexAppServerTransport).close === 'function'
  } catch {
    return false
  }
}

async function createProjectResource(
  options: CreateCodexAssemblyResourceOptions,
): Promise<CodexAssemblyResource> {
  const host = options.projectHost
  const stateRoot = options.config.stateRoot
  const managedRoot = options.config.managedRoot
  if (host === undefined) {
    throw new CodexHostConfigurationError('codex_project_host_unsupported')
  }
  let store: CodexProjectStore | null = null
  let startupTransport: CodexAppServerTransport | null = null
  try {
    startupTransport = options.transportFactory.create(Object.freeze({
      mode: 'live',
      binary: options.config.binary,
      binaryPrefixArgs: options.config.binaryPrefixArgs,
      workspace: options.config.workspace,
      codexHome: null,
      credential: options.config.credential,
      resumeThreadId: null,
      workingInterval: options.config.workingInterval,
    }))
    if (!isCodexTransport(startupTransport)) {
      throw new CodexHostConfigurationError('codex_host_unavailable')
    }
    store = await CodexProjectStore.open({
      stateRoot,
      managedRoot,
      nativeLocks: host.nativeLocks,
      rootFiles: host.rootFiles,
      live: true,
      now: options.now ?? (() => Date.now() / 1_000),
    })
    const derivedName = basename(hostWorkspacePath(options.config.workspace)) || 'workspace'
    const displayName = [...derivedName].slice(0, MAX_PROJECT_WORKSPACE_NAME).join('')
    await store.ensureImported(displayName, options.config.workspace)
    const confirmation = new ProjectConfirmationController({
      clock: options.clock,
      idFactory: options.idFactory,
    })
    const adapter = new ProjectCodexAdapter({
      store,
      confirmation,
      transportFactory: {
        create: binding => {
          const transport = options.transportFactory.create(Object.freeze({
            mode: 'project',
            binary: options.config.binary,
            binaryPrefixArgs: options.config.binaryPrefixArgs,
            workspace: binding.workspace,
            codexHome: binding.codexHome,
            credential: options.config.credential,
            resumeThreadId: binding.resumeThreadId,
            workingInterval: options.config.workingInterval,
          }))
          if (!isCodexTransport(transport)) {
            throw new CodexHostConfigurationError('codex_host_unavailable')
          }
          return transport
        },
      },
      ...(options.onProjectView === undefined ? {} : {onProjectView: options.onProjectView}),
    })
    await adapter.initialize()
    return new ProjectCodexAssemblyResource(adapter, startupTransport)
  } catch (error) {
    await startupTransport?.close('failure').catch(() => undefined)
    await store?.close().catch(() => undefined)
    if (error instanceof CodexHostConfigurationError) throw error
    if (error instanceof ProjectStateError) {
      throw new CodexHostConfigurationError('codex_project_state_invalid')
    }
    throw new CodexHostConfigurationError('codex_host_unavailable')
  }
}

class BasicCodexAssemblyResource implements CodexAssemblyResource {
  readonly mode = 'ordinary'
  readonly projectView = null
  readonly #rawTransport: CodexAppServerTransport
  #startOperation: Promise<void> | null = null
  #closeOperation: Promise<void> | null = null

  constructor(
    readonly adapter: ExecutorAdapter,
    rawTransport: CodexAppServerTransport,
  ) {
    this.#rawTransport = rawTransport
  }

  start(): Promise<void> {
    if (this.#startOperation !== null) return this.#startOperation
    this.#startOperation = this.#startFresh()
    return this.#startOperation
  }

  async #startFresh(): Promise<void> {
    await this.#rawTransport.preflight({expiresAtMs: Date.now() + 20_000})
  }

  close(): Promise<void> {
    if (this.#closeOperation !== null) return this.#closeOperation
    const work = this.#closeWithRetainedTransportRetry()
    const exposed = work.catch(error => {
      if (this.#closeOperation === exposed) this.#closeOperation = null
      throw error
    })
    this.#closeOperation = exposed
    return exposed
  }

  async #closeWithRetainedTransportRetry(): Promise<void> {
    try {
      await this.#rawTransport.close('shutdown')
    } catch (firstFailure) {
      try {
        await this.#rawTransport.close('shutdown')
      } catch {
        throw firstFailure
      }
    }
  }
}

class ProjectCodexAssemblyResource implements CodexAssemblyResource {
  readonly mode = 'project'
  readonly #startupTransport: CodexAppServerTransport
  #startOperation: Promise<void> | null = null
  #closeOperation: Promise<void> | null = null

  constructor(
    readonly adapter: ProjectCodexAdapter,
    startupTransport: CodexAppServerTransport,
  ) {
    this.#startupTransport = startupTransport
  }

  get projectView(): PublicProjectView {
    return this.adapter.publicProjectView(this.adapter.confirmationController.pending)
  }

  start(): Promise<void> {
    if (this.#startOperation !== null) return this.#startOperation
    this.#startOperation = this.#startFresh()
    return this.#startOperation
  }

  async #startFresh(): Promise<void> {
    let failure: unknown = null
    try {
      await this.#startupTransport.preflight({expiresAtMs: Date.now() + 20_000})
    } catch (error) {
      failure = error
    }
    try {
      await this.#startupTransport.close(failure === null ? 'shutdown' : 'failure')
    } catch (error) {
      failure ??= error
    }
    if (failure instanceof Error) throw failure
    if (failure !== null) throw new Error('codex startup failed')
  }

  close(): Promise<void> {
    if (this.#closeOperation !== null) return this.#closeOperation
    const work = this.#close()
    const projectClose = work.catch(error => {
      if (this.#closeOperation === projectClose) this.#closeOperation = null
      throw error
    })
    this.#closeOperation = projectClose
    return projectClose
  }

  async #close(): Promise<void> {
    await this.#startupTransport.close('shutdown')
    await this.adapter.close()
  }
}
