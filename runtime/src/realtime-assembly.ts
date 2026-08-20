import { randomUUID } from 'node:crypto'
import { AssemblyError, type Assembly } from './assembly.js'
import {
  PlaybackRegistry,
  type PlaybackCompletion,
  type PlaybackFrame,
} from './playback.js'
import type { CompiledTools } from './tool-schema.js'
import { RealtimeRuntimeBridge } from './realtime/bridge.js'
import type {
  ConfirmedProjectOperation,
  ProjectConfirmationController,
  ProjectConfirmationView,
} from './realtime/project-confirmation.js'
import type { RealtimeProvider } from './realtime/protocol.js'
import { RealtimeProviderSession } from './realtime/provider-session.js'
import { RealtimeService } from './realtime/service.js'
import type { CodexState, GuardHistoryRecovery } from './realtime/service-state.js'
import { RealtimeSession } from './realtime/session.js'
import type { CaptionFrame } from './realtime/session-state.js'
import type { RealtimeTelemetry } from './realtime/telemetry.js'

export const REALTIME_ASSEMBLY_SHUTDOWN_GRACE_MS = 1_000

export interface RealtimeAssemblyOptions {
  readonly core: Assembly
  readonly provider: RealtimeProvider
  readonly idFactory?: () => string
  readonly providerToolView?: (tools: CompiledTools) => CompiledTools
  readonly onAudioFrame?: (frame: PlaybackFrame) => void
  readonly onAudioClear?: (utteranceId: string, generationEpoch: number) => void
  readonly onAudioAlert?: (utteranceId: string | null, generationEpoch: number | null) => void
  readonly onAudioTerminal?: (utteranceId: string, generationEpoch: number) => void
  readonly onSpoken?: (text: string) => void
  readonly onDelivery?: (completion: PlaybackCompletion) => void
  readonly onCaption?: (frame: CaptionFrame) => void
  readonly onCodexState?: (state: CodexState) => void
  readonly onProjectView?: (view: ProjectConfirmationView) => void
  readonly telemetry?: RealtimeTelemetry
  readonly onDiagnostic?: (line: string) => void
  readonly controlledGuardReconnect?: boolean
  readonly guardHistoryRecovery?: GuardHistoryRecovery
  readonly guardHistoryPairs?: number
  readonly projectConfirmation?: ProjectConfirmationController
  readonly commitProjectOperation?: (
    operation: ConfirmedProjectOperation,
    originRef: string,
  ) => Promise<{readonly accepted: boolean; readonly code: string}>
  readonly projectExpiryStepTimeoutMs?: number
}

type LifecycleState = 'new' | 'starting' | 'started' | 'stopping' | 'stopped'

type CleanupResult =
  | {readonly kind: 'resolved'}
  | {readonly kind: 'rejected'; readonly error: unknown}
  | {readonly kind: 'abandoned'}

/**
 * One provider-neutral realtime object graph around one already-built core assembly.
 *
 * This owner is deliberately the only caller of `RealtimeService.start()`: the service in turn is
 * the only owner of `runtime.serve()`. Lifecycle state lives outside both resources because a
 * stopped `RealtimeProviderSession` and a served `CausalRuntime` are terminal even though their
 * lower-level classes expose individually idempotent methods.
 */
export class RealtimeAssembly {
  readonly core: Assembly
  readonly provider: RealtimeProvider
  readonly providerSession: RealtimeProviderSession
  readonly playback: PlaybackRegistry
  readonly session: RealtimeSession
  readonly bridge: RealtimeRuntimeBridge
  readonly service: RealtimeService
  readonly runtime: Assembly['runtime']
  readonly tools: CompiledTools

  readonly #onDiagnostic: (line: string) => void
  #state: LifecycleState = 'new'
  #startOperation: Promise<void> | null = null
  #stopOperation: Promise<void> | null = null

  constructor(input: {
    readonly core: Assembly
    readonly provider: RealtimeProvider
    readonly providerSession: RealtimeProviderSession
    readonly playback: PlaybackRegistry
    readonly session: RealtimeSession
    readonly bridge: RealtimeRuntimeBridge
    readonly service: RealtimeService
    readonly onDiagnostic: (line: string) => void
  }) {
    this.core = input.core
    this.provider = input.provider
    this.providerSession = input.providerSession
    this.playback = input.playback
    this.session = input.session
    this.bridge = input.bridge
    this.service = input.service
    this.runtime = input.core.runtime
    this.tools = input.core.tools
    this.#onDiagnostic = input.onDiagnostic
  }

  start(): Promise<void> {
    if (this.#state === 'stopped' || this.#state === 'stopping') {
      return Promise.reject(new AssemblyError('realtime assembly cannot restart after stop'))
    }
    if (this.#state === 'started') return Promise.resolve()
    if (this.#startOperation !== null) return this.#startOperation

    this.#state = 'starting'
    const operation = this.#startFresh()
    this.#startOperation = operation
    void operation.then(
      () => {
        if (this.#startOperation === operation) this.#startOperation = null
      },
      () => {
        if (this.#startOperation === operation) this.#startOperation = null
      },
    )
    return operation
  }

  stop(): Promise<void> {
    if (this.#state === 'stopped') return Promise.resolve()
    if (this.#stopOperation !== null) return this.#stopOperation

    const starting = this.#startOperation
    this.#state = 'stopping'
    const operation = this.#stopAfter(starting)
    this.#stopOperation = operation
    void operation.then(
      () => {
        if (this.#stopOperation === operation) this.#stopOperation = null
      },
      () => {
        if (this.#stopOperation === operation) this.#stopOperation = null
      },
    )
    return operation
  }

  async #startFresh(): Promise<void> {
    try {
      await this.core.start()
    } catch (error) {
      if (this.#state === 'starting') this.#state = 'new'
      throw error
    }
    try {
      await this.service.start()
    } catch (error) {
      await this.#cleanupWithinGrace(
        () => this.core.stop(),
        'assembly_core_stop_abandoned',
      )
      if (this.#state === 'starting') this.#state = 'new'
      throw error
    }
    if (this.#state === 'starting') this.#state = 'started'
  }

  async #stopAfter(starting: Promise<void> | null): Promise<void> {
    if (starting !== null) await starting.catch(() => undefined)

    let firstFailure: {readonly error: unknown} | null = null
    const service = await this.#cleanupWithinGrace(
      () => this.service.close(),
      'assembly_service_close_abandoned',
    )
    if (service.kind === 'rejected') firstFailure = {error: service.error}

    const core = await this.#cleanupWithinGrace(
      () => this.core.stop(),
      'assembly_core_stop_abandoned',
    )
    if (firstFailure === null && core.kind === 'rejected') firstFailure = {error: core.error}

    this.#state = 'stopped'
    if (firstFailure !== null) throw firstFailure.error
  }

  async #cleanupWithinGrace(
    cleanup: () => Promise<void>,
    abandonedDiagnostic: string,
  ): Promise<CleanupResult> {
    let work: Promise<void>
    try {
      work = cleanup()
    } catch (error) {
      return {kind: 'rejected', error}
    }
    const settled: Promise<CleanupResult> = work.then(
      () => ({kind: 'resolved'}),
      (error: unknown) => ({kind: 'rejected', error}),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<CleanupResult>(resolve => {
      timer = setTimeout(
        () => resolve({kind: 'abandoned'}),
        REALTIME_ASSEMBLY_SHUTDOWN_GRACE_MS,
      )
    })
    const result = await Promise.race([settled, deadline])
    if (timer !== undefined) clearTimeout(timer)
    if (result.kind === 'abandoned') {
      try {
        this.#onDiagnostic(`[realtime-diagnostic] ${abandonedDiagnostic}`)
      } catch {
        // Diagnostics are best-effort. Cleanup order must not depend on an observer.
      }
    }
    return result
  }
}

/** Build the provider-neutral realtime resources in their ownership order. */
export function buildRealtimeAssembly(options: RealtimeAssemblyOptions): RealtimeAssembly {
  const core = options.core
  const provider = options.provider
  const providerSession = new RealtimeProviderSession(provider)
  const providerTools = options.providerToolView?.(core.tools) ?? core.tools
  validateProviderToolView(core.tools, providerTools)
  const idFactory = options.idFactory ?? (() => `nova_${randomUUID().replaceAll('-', '')}`)
  const onDiagnostic = options.onDiagnostic ?? (line => { console.log(line) })
  const playback = new PlaybackRegistry({
    idFactory,
    onFrame: options.onAudioFrame ?? noop,
    onClear: options.onAudioClear ?? noop,
    ...(options.onAudioAlert === undefined ? {} : {onAlert: options.onAudioAlert}),
  })
  const session = new RealtimeSession({
    provider: providerSession,
    playback,
    idFactory,
    clock: core.runtime.clock,
    ...(options.onSpoken === undefined ? {} : {onSpoken: options.onSpoken}),
    ...(options.onDelivery === undefined ? {} : {onDelivery: options.onDelivery}),
    onDiagnostic,
  })
  const bridge = new RealtimeRuntimeBridge({
    runtime: core.runtime,
    tools: core.tools,
    idFactory,
  })
  const service = new RealtimeService({
    provider: providerSession,
    runtime: core.runtime,
    tools: core.tools,
    providerSchemas: providerTools.schemas,
    session,
    bridge,
    idFactory,
    onProviderTerminal: generation => {
      options.onAudioTerminal?.(generation.utterance_id, generation.generation_epoch)
    },
    ...(options.onCodexState === undefined ? {} : {onCodexState: options.onCodexState}),
    ...(options.onCaption === undefined ? {} : {onCaption: options.onCaption}),
    ...(options.telemetry === undefined ? {} : {telemetry: options.telemetry}),
    ...(options.controlledGuardReconnect === undefined
      ? {}
      : {controlledGuardReconnect: options.controlledGuardReconnect}),
    ...(options.guardHistoryRecovery === undefined
      ? {}
      : {guardHistoryRecovery: options.guardHistoryRecovery}),
    ...(options.guardHistoryPairs === undefined ? {} : {guardHistoryPairs: options.guardHistoryPairs}),
    ...(options.projectConfirmation === undefined
      ? {}
      : {projectConfirmation: options.projectConfirmation}),
    ...(options.commitProjectOperation === undefined
      ? {}
      : {commitProjectOperation: options.commitProjectOperation}),
    ...(options.onProjectView === undefined ? {} : {onProjectView: options.onProjectView}),
    ...(options.projectExpiryStepTimeoutMs === undefined
      ? {}
      : {projectExpiryStepTimeoutMs: options.projectExpiryStepTimeoutMs}),
    onDiagnostic,
  })
  return new RealtimeAssembly({
    core,
    provider,
    providerSession,
    playback,
    session,
    bridge,
    service,
    onDiagnostic,
  })
}

function validateProviderToolView(
  full: CompiledTools,
  provider: unknown,
): asserts provider is CompiledTools {
  if (!isUnknownObject(provider) || !('bindings' in provider) || !('schemas' in provider)) {
    throw new AssemblyError('provider tool view contains a malformed schema')
  }
  if (provider.bindings !== full.bindings) {
    throw new AssemblyError('provider tool view must reuse core tool bindings')
  }
  if (!Array.isArray(provider.schemas)) {
    throw new AssemblyError('provider tool view contains a malformed schema')
  }
  const fullNames = new Set<string>()
  for (const schema of full.schemas) {
    const name = validFunctionSchemaName(schema)
    if (name === null) throw new AssemblyError('core tool view contains a malformed schema')
    fullNames.add(name)
  }
  const providerNames = new Set<string>()
  for (const schema of provider.schemas) {
    const name = validFunctionSchemaName(schema)
    if (name === null || providerNames.has(name)) {
      throw new AssemblyError('provider tool view contains a malformed schema')
    }
    providerNames.add(name)
    if (!fullNames.has(name)) {
      throw new AssemblyError('provider tool view contains an unknown schema')
    }
  }
}

function validFunctionSchemaName(schema: unknown): string | null {
  if (!isUnknownObject(schema)) return null
  if (schema.type !== 'function') return null
  const declaration = schema.function
  if (!isUnknownObject(declaration)) return null
  const {name, description, parameters} = declaration
  if (typeof name !== 'string' || name.length === 0) return null
  if (typeof description !== 'string' || description.length === 0) return null
  if (!isUnknownObject(parameters) || parameters.type !== 'object') return null
  return name
}

function isUnknownObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function noop(): void {
  return
}
