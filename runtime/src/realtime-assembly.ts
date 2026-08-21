import { randomUUID } from 'node:crypto'
import { AssemblyError, type Assembly } from './assembly.js'
import type {CodexAssemblyResource} from './codex-factory.js'
import { canonicalJson } from './canonical-json.js'
import type { JsonValue } from './events.js'
import type {ProjectCodexAdapter} from './executors/codex-project-live.js'
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
  readonly projectAdapter?: ProjectCodexAdapter
  readonly commitProjectOperation?: (
    operation: ConfirmedProjectOperation,
    originRef: string,
  ) => Promise<{readonly accepted: boolean; readonly code: string}>
  readonly projectExpiryStepTimeoutMs?: number
  readonly codexResource?: CodexAssemblyResource
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
  readonly #projectAdapter: ProjectCodexAdapter | undefined
  readonly #codexResource: CodexAssemblyResource | undefined
  readonly #unsubscribeProjectView: (() => void) | undefined
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
    readonly projectAdapter?: ProjectCodexAdapter
    readonly onProjectView?: (view: ProjectConfirmationView) => void
    readonly codexResource?: CodexAssemblyResource
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
    this.#projectAdapter = input.projectAdapter
    this.#codexResource = input.codexResource
    this.#unsubscribeProjectView = input.projectAdapter === undefined || input.onProjectView === undefined
      ? undefined
      : input.projectAdapter.observeProjectView(input.onProjectView)
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
      if (this.#projectAdapter !== undefined) {
        await this.#projectAdapter.initialize()
      }
      await this.core.start()
    } catch (error) {
      if (this.#state === 'starting') this.#state = 'new'
      throw error
    }
    if (this.#state !== 'starting') {
      throw new AssemblyError('realtime assembly start was abandoned by stop')
    }
    try {
      await this.service.start()
    } catch (error) {
      if (this.#state === 'starting') {
        await this.#cleanupWithinGrace(
          () => this.core.stop(),
          'assembly_core_stop_abandoned',
        )
        if (this.#state === 'starting') this.#state = 'new'
      }
      throw error
    }
    if (this.#state === 'starting') {
      this.#state = 'started'
      if (this.#codexResource !== undefined) {
        try {
          void this.#codexResource.start().catch(() => undefined)
        } catch {
          // A live prewarm is advisory. A real launch remains lazy on first delegation.
        }
      }
    }
  }

  async #stopAfter(starting: Promise<void> | null): Promise<void> {
    if (starting !== null) {
      await this.#settleWithinGrace(starting, 'assembly_start_abandoned')
    }

    let firstFailure: {readonly error: unknown} | null = null
    let cleanupComplete = true
    const service = await this.#cleanupWithinGrace(
      () => this.service.close(),
      'assembly_service_close_abandoned',
    )
    if (service.kind !== 'resolved') cleanupComplete = false
    if (service.kind === 'rejected') firstFailure = {error: service.error}

    const core = await this.#cleanupWithinGrace(
      () => this.core.stop(),
      'assembly_core_stop_abandoned',
    )
    if (core.kind !== 'resolved') cleanupComplete = false
    if (firstFailure === null && core.kind === 'rejected') firstFailure = {error: core.error}

    if (this.#codexResource !== undefined) {
      const codex = await this.#cleanupWithinGrace(
        () => this.#codexResource!.close(),
        'codex_close_abandoned',
      )
      if (codex.kind !== 'resolved') cleanupComplete = false
      if (firstFailure === null && codex.kind === 'rejected') firstFailure = {error: codex.error}
    } else if (this.#projectAdapter !== undefined) {
      const project = await this.#cleanupWithinGrace(
        () => this.#projectAdapter!.close(),
        'assembly_project_adapter_close_abandoned',
      )
      if (project.kind !== 'resolved') cleanupComplete = false
      if (firstFailure === null && project.kind === 'rejected') firstFailure = {error: project.error}
    }
    this.#unsubscribeProjectView?.()

    if (cleanupComplete) this.#state = 'stopped'
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
    return this.#settleWithinGrace(work, abandonedDiagnostic)
  }

  async #settleWithinGrace(
    work: Promise<void>,
    abandonedDiagnostic: string,
  ): Promise<CleanupResult> {
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
  const resourceAdapter = options.codexResource?.adapter
  if (
    options.codexResource !== undefined
    && core.runtime.executors.get('codex') !== resourceAdapter
  ) throw new AssemblyError('Codex resource must be the registered codex executor')
  if (options.projectAdapter !== undefined && options.codexResource !== undefined) {
    throw new AssemblyError('manual project adapter cannot be combined with Codex resource')
  }
  const projectAdapter = options.codexResource?.mode === 'project'
    ? asProjectAdapter(resourceAdapter)
    : options.projectAdapter
  if (projectAdapter !== undefined) {
    if (options.projectConfirmation !== undefined || options.commitProjectOperation !== undefined) {
      throw new AssemblyError('project adapter cannot be combined with manual project wiring')
    }
    if (core.runtime.executors.get('codex') !== projectAdapter) {
      throw new AssemblyError('project adapter must be the registered codex executor')
    }
  }
  const projectConfirmation = projectAdapter?.confirmationController ?? options.projectConfirmation
  const commitProjectOperation = projectAdapter === undefined
    ? options.commitProjectOperation
    : ((operation: ConfirmedProjectOperation, originRef: string) => projectAdapter.commitConfirmed(
        operation,
        originRef,
        (request, reason, capability) => core.runtime.dispatchExternal(
          request,
          reason,
          capability,
        ),
      ))
  const provider = options.provider
  const providerSession = new RealtimeProviderSession(provider)
  const providerTools = options.providerToolView?.(core.tools) ?? core.tools
  const providerSchemas = validateProviderToolView(core.tools, providerTools)
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
    providerSchemas,
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
    ...(projectConfirmation === undefined
      ? {}
      : {projectConfirmation}),
    ...(commitProjectOperation === undefined
      ? {}
      : {commitProjectOperation}),
    ...(projectAdapter === undefined
      ? {}
      : {projectViewProvider: (pending: boolean) => projectAdapter.publicProjectView(pending)}),
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
    ...(projectAdapter === undefined ? {} : {projectAdapter}),
    ...(options.onProjectView === undefined ? {} : {onProjectView: options.onProjectView}),
    ...(options.codexResource === undefined ? {} : {codexResource: options.codexResource}),
  })
}

function asProjectAdapter(adapter: unknown): ProjectCodexAdapter {
  if (
    typeof adapter !== 'object'
    || adapter === null
    || !('confirmationController' in adapter)
    || !('commitConfirmed' in adapter)
    || !('publicProjectView' in adapter)
  ) throw new AssemblyError('project Codex resource has an invalid adapter')
  return adapter as ProjectCodexAdapter
}

function validateProviderToolView(
  full: CompiledTools,
  provider: unknown,
): readonly Readonly<Record<string, JsonValue>>[] {
  if (!isUnknownObject(provider) || !('bindings' in provider) || !('schemas' in provider)) {
    throw new AssemblyError('provider tool view contains a malformed schema')
  }
  if (provider.bindings !== full.bindings) {
    throw new AssemblyError('provider tool view must reuse core tool bindings')
  }
  if (!Array.isArray(provider.schemas)) {
    throw new AssemblyError('provider tool view contains a malformed schema')
  }
  const fullByName = new Map<string, string>()
  for (const schema of full.schemas) {
    const snapshot = snapshotJsonObject(schema)
    if (snapshot === null) throw new AssemblyError('core tool view contains a malformed schema')
    const name = validFunctionSchemaName(snapshot)
    if (name === null || fullByName.has(name)) {
      throw new AssemblyError('core tool view contains a malformed schema')
    }
    let canonical: string
    try {
      canonical = canonicalJson(snapshot)
    } catch {
      throw new AssemblyError('core tool view contains a malformed schema')
    }
    fullByName.set(name, canonical)
  }
  const providerNames = new Set<string>()
  const providerSchemas: Readonly<Record<string, JsonValue>>[] = []
  for (const schema of provider.schemas) {
    const snapshot = snapshotJsonObject(schema)
    if (snapshot === null) {
      throw new AssemblyError('provider tool view contains a malformed schema')
    }
    const name = validFunctionSchemaName(snapshot)
    if (name === null || providerNames.has(name)) {
      throw new AssemblyError('provider tool view contains a malformed schema')
    }
    providerNames.add(name)
    const fullCanonical = fullByName.get(name)
    if (fullCanonical === undefined) {
      throw new AssemblyError('provider tool view contains an unknown schema')
    }
    let providerCanonical: string
    try {
      providerCanonical = canonicalJson(snapshot)
    } catch {
      throw new AssemblyError('provider tool view contains a malformed schema')
    }
    if (providerCanonical !== fullCanonical) {
      throw new AssemblyError('provider tool view schema must match core schema')
    }
    providerSchemas.push(snapshot)
  }
  return providerSchemas
}

function validFunctionSchemaName(schema: unknown): string | null {
  if (!isUnknownObject(schema)) return null
  if (schema.type !== 'function') return null
  const declaration = schema.function
  if (!isUnknownObject(declaration)) return null
  const {name, description, parameters} = declaration
  if (typeof name !== 'string' || name === '') return null
  if (typeof description !== 'string' || description === '') return null
  if (!isUnknownObject(parameters) || parameters.type !== 'object') return null
  if (!isUnknownObject(parameters.properties)) return null
  return name
}

function isUnknownObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function snapshotJsonObject(value: unknown): Readonly<Record<string, JsonValue>> | null {
  const snapshot = snapshotJsonValue(value, new Set<object>())
  return isJsonObject(snapshot) ? snapshot : null
}

function snapshotJsonValue(value: unknown, ancestors: Set<object>): JsonValue | undefined {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) return value
  if (typeof value !== 'object' || ancestors.has(value)) return undefined

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      if (keys.some(key => key !== 'length' && (
        typeof key !== 'string' || !isCanonicalArrayIndex(key, value.length)
      ))) return undefined
      const snapshot: JsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined || !('value' in descriptor)) return undefined
        const item = snapshotJsonValue(descriptor.value, ancestors)
        if (item === undefined) return undefined
        snapshot.push(item)
      }
      return snapshot
    }

    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const snapshot: Record<string, JsonValue> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return undefined
      }
      const field = snapshotJsonValue(descriptor.value, ancestors)
      if (field === undefined) return undefined
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: field,
        writable: true,
      })
    }
    return snapshot
  } catch {
    return undefined
  } finally {
    ancestors.delete(value)
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return false
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

function isJsonObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function noop(): void {
  return
}
