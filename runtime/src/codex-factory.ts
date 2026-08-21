import {
  OwnedCodexAppServerTransport,
  type CodexAppServerTransport,
  type CodexHostPreflightRunner,
  type CodexLiveSchemaProbe,
} from './codex-app-server-transport.js'
import type {
  CodexCredentialProfile,
  ResolvedCodexHostConfig,
} from './codex-host-config.js'
import {codexCredentialApiKey} from './codex-host-config.js'
import type {CredentialSnapshotter} from './codex-credential-snapshot.js'
import type {PublicProjectView} from './codex-project-store.js'
import {CodexProjectStore, ProjectStateError} from './codex-project-store.js'
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
import {CodexLiveAdapter} from './executors/codex-live.js'
import {ProjectCodexAdapter} from './executors/codex-project-live.js'
import {CodexAdapter} from './executors/codex.js'
import {ProjectConfirmationController} from './realtime/project-confirmation.js'
import {basename} from 'node:path'

export type CodexAssemblyMode = 'ordinary' | 'live' | 'project'

export interface CodexTransportBinding {
  readonly mode: CodexAssemblyMode
  readonly binary: HostBinary
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
    return new OwnedCodexAppServerTransport({
      config: {
        binary: binding.binary,
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
  if (options.composition === 'realtime' && options.config.projectsEnabled) {
    return await createProjectResource(options)
  }
  const mode = options.composition === 'ordinary' ? 'ordinary' : 'live'
  const binding: CodexTransportBinding = Object.freeze({
    mode,
    binary: options.config.binary,
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
  if (mode === 'ordinary') {
    return new BasicCodexAssemblyResource(
      new CodexAdapter(transport),
      transport,
      transport,
      false,
    )
  }
  const adapter = new CodexLiveAdapter(transport)
  return new BasicCodexAssemblyResource(
    adapter,
    adapter,
    transport,
    options.config.prewarm,
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
  if (host === undefined || stateRoot === null || managedRoot === null) {
    throw new CodexHostConfigurationError('codex_project_host_unsupported')
  }
  let store: CodexProjectStore | null = null
  try {
    store = await CodexProjectStore.open({
      stateRoot,
      managedRoot,
      nativeLocks: host.nativeLocks,
      rootFiles: host.rootFiles,
      live: true,
      now: options.now ?? (() => Date.now() / 1_000),
    })
    const displayName = basename(hostWorkspacePath(options.config.workspace)) || 'workspace'
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
    return new ProjectCodexAssemblyResource(adapter)
  } catch (error) {
    await store?.close().catch(() => undefined)
    if (error instanceof CodexHostConfigurationError) throw error
    if (error instanceof ProjectStateError) {
      throw new CodexHostConfigurationError('codex_project_state_invalid')
    }
    throw new CodexHostConfigurationError('codex_host_unavailable')
  }
}

interface ClosableCodexResource {
  close(reason?: 'shutdown' | 'cancel' | 'failure'): Promise<void>
}

class BasicCodexAssemblyResource implements CodexAssemblyResource {
  readonly mode: 'ordinary' | 'live'
  readonly projectView = null
  readonly #closeTarget: ClosableCodexResource
  readonly #rawTransport: CodexAppServerTransport
  readonly #prewarm: (() => Promise<void>) | null
  #startOperation: Promise<void> | null = null
  #closeOperation: Promise<void> | null = null

  constructor(
    readonly adapter: ExecutorAdapter,
    closeTarget: ClosableCodexResource,
    rawTransport: CodexAppServerTransport,
    prewarm: boolean,
  ) {
    this.mode = prewarm || adapter instanceof CodexLiveAdapter ? 'live' : 'ordinary'
    this.#closeTarget = closeTarget
    this.#rawTransport = rawTransport
    this.#prewarm = prewarm && adapter instanceof CodexLiveAdapter
      ? () => adapter.prewarm()
      : null
  }

  start(): Promise<void> {
    if (this.#startOperation !== null) return this.#startOperation
    this.#startOperation = this.#prewarm?.() ?? Promise.resolve()
    return this.#startOperation
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
      await this.#closeTarget.close('shutdown')
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
  readonly #startOperation = Promise.resolve()
  #closeOperation: Promise<void> | null = null

  constructor(readonly adapter: ProjectCodexAdapter) {}

  get projectView(): PublicProjectView {
    return this.adapter.publicProjectView(this.adapter.confirmationController.pending)
  }

  start(): Promise<void> { return this.#startOperation }

  close(): Promise<void> {
    if (this.#closeOperation !== null) return this.#closeOperation
    const work = this.adapter.close()
    const projectClose = work.catch(error => {
      if (this.#closeOperation === projectClose) this.#closeOperation = null
      throw error
    })
    this.#closeOperation = projectClose
    return projectClose
  }
}
