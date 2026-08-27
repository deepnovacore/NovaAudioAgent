import { randomUUID } from 'node:crypto'
import { AssemblyError, type Assembly } from './assembly.js'
import type {CodexAssemblyResource} from './codex-factory.js'
import { canonicalJson } from './canonical-json.js'
import type {PublicProjectContext} from './codex-project-store.js'
import type { JsonValue } from './events.js'
import type {
  CommittedWorkspaceEvent,
  ProjectCodexAdapter,
  TerminalWorkOrderEvent,
} from './executors/codex-project-live.js'
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
import {renderActiveProjectContext} from './realtime/qwen.js'
import type {
  OpenWorkspaceInput,
  TaskCompletionInput,
  TurnContextInput,
} from './workspace-graph/service.js'
import type {WorkspaceResolutionDecision} from './workspace-graph/identity.js'
import type {PublishedGraphSnapshot} from './workspace-graph/store.js'
import type {GraphContext} from './workspace-graph/context.js'
import type {Suggestion} from './suggestions.js'
import type {WakeReason} from './slots.js'

export interface RealtimeWorkspaceGraph {
  readonly publishedSnapshot: PublishedGraphSnapshot
  readonly degraded?: boolean
  open(): Promise<void>
  revokeCurrentWorkspaceScope(): number
  breakWorkspaceTransitionAdjacency(): void
  openWorkspace(
    input: OpenWorkspaceInput,
    admittedScopeGeneration?: number,
  ): Promise<WorkspaceResolutionDecision>
  recordTaskCompletion(input: TaskCompletionInput): Promise<void>
  contextForTurn(input: TurnContextInput): GraphContext | null
  close(): Promise<void>
}

export const REALTIME_ASSEMBLY_SHUTDOWN_GRACE_MS = 1_000
const MAX_GRAPH_LIFECYCLE_OPERATIONS = 64
const MAX_GRAPH_TERMINAL_OPERATIONS = MAX_GRAPH_LIFECYCLE_OPERATIONS - 1
const MAX_COMMITTED_WORKSPACE_EVENTS = 64
const WORKSPACE_SWITCH_RETRY_MS = 10

interface AdmittedCommittedWorkspace {
  readonly event: CommittedWorkspaceEvent
  readonly scopeGeneration: number
}

export interface RealtimeAssemblyOptions {
  readonly core: Assembly
  readonly provider: RealtimeProvider
  readonly idFactory?: () => string
  readonly wallClockNow?: () => number
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
  readonly workspaceGraph?: RealtimeWorkspaceGraph
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
  readonly workspaceGraph: RealtimeWorkspaceGraph | undefined

  readonly #onDiagnostic: (line: string) => void
  readonly #projectAdapter: ProjectCodexAdapter | undefined
  readonly #codexResource: CodexAssemblyResource | undefined
  readonly #unsubscribeProjectView: (() => void) | undefined
  readonly #unsubscribeProjectContext: (() => void) | undefined
  readonly #unsubscribeCommittedWorkspace: (() => void) | undefined
  readonly #unsubscribeTerminalWorkOrder: (() => void) | undefined
  readonly #unsubscribeProviderConnected: (() => void) | undefined
  readonly #idFactory: () => string
  readonly #wallClockNow: () => number
  readonly #unbindGraphContext: (() => void) | undefined
  readonly #unbindSuggestionSelected: (() => void) | undefined
  #workspaceGraphOpen = false
  #currentWorkspaceInstanceId: string | null = null
  #currentHostWorkspaceId: string | null = null
  #latestProjectView: ProjectConfirmationView | null = null
  #projectContextRevision = 0
  #lastProjectContextKey: string | null = null
  #projectContextOwnershipUncertain = false
  #providerConnectionObserved = false
  #projectContextTail: Promise<void> = Promise.resolve()
  readonly #workspaceInstancesByHostId = new Map<string, string>()
  #graphLifecycleTail: Promise<void> = Promise.resolve()
  #graphLifecyclePending = 0
  readonly #committedWorkspaceQueue: AdmittedCommittedWorkspace[] = []
  #committedWorkspaceScheduled = false
  #committedWorkspaceAdmissionFailed = false
  #latestWorkspaceScopeGeneration = 0
  #graphHooksClosed = false
  #graphOpenOperation: Promise<void> | null = null
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
    readonly workspaceGraph?: RealtimeWorkspaceGraph
    readonly idFactory: () => string
    readonly wallClockNow: () => number
    readonly unbindSuggestionSelected?: () => void
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
    this.workspaceGraph = input.workspaceGraph
    this.#onDiagnostic = input.onDiagnostic
    this.#projectAdapter = input.projectAdapter
    this.#codexResource = input.codexResource
    this.#idFactory = input.idFactory
    this.#wallClockNow = input.wallClockNow
    this.#unbindSuggestionSelected = input.unbindSuggestionSelected
    this.#unbindGraphContext = input.workspaceGraph === undefined
      ? undefined
      : input.core.runtime.bindGraphContextProvider(({latest_user_text: utterance}) => {
        if (!this.#workspaceGraphOpen || this.#currentWorkspaceInstanceId === null) return null
        const identity = this.providerSession.identity
        if (identity === null) return null
        return input.workspaceGraph!.contextForTurn({
          session_epoch: identity.epoch,
          workspace_instance_id: this.#currentWorkspaceInstanceId,
          utterance,
          preferences: [],
        })
      })
    this.#unsubscribeProjectView = input.projectAdapter === undefined
      ? undefined
      : input.projectAdapter.observeProjectView(view => {
        input.onProjectView?.(view)
      })
    this.#unsubscribeProjectContext = input.projectAdapter === undefined
      ? undefined
      : input.projectAdapter.observeProjectContext(async context => {
        this.#acceptProjectContext(context)
        await this.#enqueueProjectContextPublication(true)
      })
    this.#unsubscribeCommittedWorkspace = input.projectAdapter === undefined
      ? undefined
      : input.projectAdapter.observeCommittedWorkspace(event => {
        if (input.workspaceGraph !== undefined) this.#enqueueCommittedWorkspace(event)
      })
    this.#unsubscribeTerminalWorkOrder = input.projectAdapter === undefined
      || input.workspaceGraph === undefined
      ? undefined
      : input.projectAdapter.observeTerminalWorkOrder(event => {
        this.#enqueueGraphLifecycle(() => this.#onTerminalWorkOrder(event))
      })
    this.#unsubscribeProviderConnected = input.projectAdapter === undefined
      ? undefined
      : input.providerSession.observeConnected(async () => {
        // Initial delivery is owned by #startFresh's bounded publication step.
        // Lifecycle observation owns only fresh reconnect epochs.
        if (!this.#providerConnectionObserved) {
          this.#providerConnectionObserved = true
          return
        }
        await this.#enqueueProjectContextPublication()
      })
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
    if (this.#projectAdapter !== undefined
      && typeof this.provider.injectWorkspaceContext !== 'function') {
      if (this.#state === 'starting') this.#state = 'new'
      throw new AssemblyError('selected realtime provider cannot deliver active project context')
    }
    if (this.workspaceGraph !== undefined) {
      const openOperation = Promise.resolve().then(async () => { await this.workspaceGraph!.open() })
      this.#graphOpenOperation = openOperation
      void openOperation.then(
        () => { if (this.#graphOpenOperation === openOperation) this.#graphOpenOperation = null },
        () => { if (this.#graphOpenOperation === openOperation) this.#graphOpenOperation = null },
      )
      const graphOpen = await this.#cleanupWithinGrace(
        () => openOperation,
        'workspace_graph_open_abandoned',
      )
      if (graphOpen.kind === 'resolved') {
        this.#workspaceGraphOpen = true
      } else {
        this.#workspaceGraphOpen = false
        if (graphOpen.kind === 'rejected') this.#diagnose('workspace_graph_open_failed')
      }
    }
    try {
      if (this.#projectAdapter !== undefined) {
        await this.#projectAdapter.initialize()
        const context = this.#projectAdapter.publicProjectContext(
          this.#projectAdapter.confirmationController.pending,
        )
        this.#acceptProjectContext(context)
        const activeWorkspace = await this.#projectAdapter.activeCommittedWorkspace()
        if (activeWorkspace?.workspace_id === context.workspace_id) {
          if (this.#workspaceGraphOpen) {
            this.#enqueueCommittedWorkspace({workspace: activeWorkspace})
          }
        }
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
    const initialPublication = await this.#cleanupWithinGrace(
      () => this.#enqueueProjectContextPublication(),
      'workspace_graph_header_delivery_abandoned',
    )
    if (initialPublication.kind === 'rejected') {
      this.#diagnose('workspace_graph_header_delivery_failed')
      void this.#enqueueProjectContextPublication().catch(() => {
        this.#diagnose('workspace_graph_header_delivery_failed')
      })
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

    this.#unbindGraphContext?.()
    this.#unbindSuggestionSelected?.()

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
    this.#unsubscribeProjectContext?.()
    this.#unsubscribeCommittedWorkspace?.()
    this.#unsubscribeTerminalWorkOrder?.()
    this.#unsubscribeProviderConnected?.()
    this.#graphHooksClosed = true

    if (this.workspaceGraph !== undefined) {
      const graphOpenOperation = this.#graphOpenOperation
      if (graphOpenOperation !== null) {
        const graphOpen = await this.#cleanupWithinGrace(
          () => graphOpenOperation,
          'workspace_graph_open_abandoned',
        )
        if (graphOpen.kind !== 'resolved') cleanupComplete = false
      }
      const lifecycle = await this.#cleanupWithinGrace(
        () => this.#graphLifecycleTail,
        'workspace_graph_lifecycle_abandoned',
      )
      if (lifecycle.kind !== 'resolved') cleanupComplete = false
      const graph = await this.#cleanupWithinGrace(
        () => this.workspaceGraph!.close(),
        'workspace_graph_close_abandoned',
      )
      if (graph.kind !== 'resolved') cleanupComplete = false
      if (graph.kind === 'rejected') this.#diagnose('workspace_graph_close_failed')
    }

    if (cleanupComplete) this.#state = 'stopped'
    if (firstFailure !== null) throw firstFailure.error
  }

  async #onCommittedWorkspace(admitted: AdmittedCommittedWorkspace): Promise<void> {
    if (!this.#workspaceGraphOpen || this.workspaceGraph === undefined) return
    const {event, scopeGeneration} = admitted
    try {
      let decision: WorkspaceResolutionDecision
      let queueFullDiagnosed = false
      for (;;) {
        try {
          decision = await this.workspaceGraph.openWorkspace({
            path: event.workspace.canonical_path,
            repository_fingerprint: event.workspace.workspace_id,
            now: event.workspace.last_used_at,
          }, scopeGeneration)
          break
        } catch (error) {
          if (!isWorkspaceGraphQueueFull(error) || this.#graphHooksClosed) throw error
          if (!queueFullDiagnosed) {
            queueFullDiagnosed = true
            this.#diagnose('workspace_graph_lifecycle_queue_full')
          }
          await new Promise<void>(resolve => { setTimeout(resolve, WORKSPACE_SWITCH_RETRY_MS) })
        }
      }
      if (decision.kind !== 'resolved') {
        this.workspaceGraph.breakWorkspaceTransitionAdjacency()
        return
      }
      // Every resolved host identity remains authoritative for terminal events, even if a newer
      // committed workspace was admitted while this durable open was queued. Only model/provider
      // current scope and Header delivery are latest-generation concerns.
      this.#workspaceInstancesByHostId.set(
        event.workspace.workspace_id,
        decision.instance.instance_id,
      )
      if (
        this.#committedWorkspaceAdmissionFailed
        || scopeGeneration !== this.#latestWorkspaceScopeGeneration
      ) return
      if (event.workspace.workspace_id !== this.#currentHostWorkspaceId) return
      this.#currentWorkspaceInstanceId = decision.instance.instance_id
      await this.#enqueueProjectContextPublication()
    } catch {
      // This authoritative event was admitted but could not become graph state. The next successful
      // event may become the new anchor, but it must not bridge relation inference across this gap.
      this.workspaceGraph.breakWorkspaceTransitionAdjacency()
      this.#diagnose('workspace_graph_lifecycle_failed')
    }
  }

  async #onTerminalWorkOrder(event: TerminalWorkOrderEvent): Promise<void> {
    if (
      !this.#workspaceGraphOpen
      || this.workspaceGraph === undefined
    ) return
    const workspaceInstanceId = this.#workspaceInstancesByHostId.get(event.workspace.workspace_id)
    if (workspaceInstanceId === undefined) return
    try {
      await this.workspaceGraph.recordTaskCompletion({
        workspace_instance_id: workspaceInstanceId,
        summary: boundedTaskCompletionSummary(event.work_order),
        outcome: event.handoff.outcome,
        now: this.#wallClockNow(),
        relation_cue: null,
      })
    } catch {
      this.#diagnose('workspace_graph_lifecycle_failed')
    }
  }

  #enqueueCommittedWorkspace(event: CommittedWorkspaceEvent): void {
    if (
      this.#graphHooksClosed
      || !this.#workspaceGraphOpen
      || this.workspaceGraph === undefined
      || this.#committedWorkspaceAdmissionFailed
    ) return
    // Admission is synchronous: neither model-call context nor explicit provider enrichment may
    // keep using A once the authoritative host has committed a switch away from A.
    this.#currentWorkspaceInstanceId = null
    let scopeGeneration: number
    try {
      scopeGeneration = this.workspaceGraph.revokeCurrentWorkspaceScope()
    } catch {
      this.#committedWorkspaceAdmissionFailed = true
      this.#diagnose('workspace_graph_lifecycle_failed')
      return
    }
    this.#latestWorkspaceScopeGeneration = scopeGeneration
    if (this.#committedWorkspaceQueue.length >= MAX_COMMITTED_WORKSPACE_EVENTS) {
      // A dropped transition would make the next edge ambiguous. Fail closed for the rest of this
      // assembly instead of ever inferring across that gap; already-admitted events may still drain.
      this.#committedWorkspaceAdmissionFailed = true
      this.#diagnose('workspace_graph_lifecycle_queue_full')
      return
    }
    this.#committedWorkspaceQueue.push({event, scopeGeneration})
    if (this.#committedWorkspaceScheduled) return
    this.#committedWorkspaceScheduled = true
    const admitted = this.#enqueueGraphLifecycle(
      () => this.#drainCommittedWorkspaces(),
      true,
    )
    if (!admitted) {
      this.#committedWorkspaceScheduled = false
      this.#committedWorkspaceAdmissionFailed = true
      this.#committedWorkspaceQueue.length = 0
    }
  }

  async #drainCommittedWorkspaces(): Promise<void> {
    try {
      while (!this.#graphHooksClosed) {
        const admitted = this.#committedWorkspaceQueue.shift()
        if (admitted === undefined) return
        await this.#onCommittedWorkspace(admitted)
      }
    } finally {
      this.#committedWorkspaceScheduled = false
    }
  }

  #enqueueGraphLifecycle(operation: () => Promise<void>, workspacePriority = false): boolean {
    if (this.#graphHooksClosed || !this.#workspaceGraphOpen) return false
    const capacity = workspacePriority
      ? MAX_GRAPH_LIFECYCLE_OPERATIONS
      : MAX_GRAPH_TERMINAL_OPERATIONS
    if (this.#graphLifecyclePending >= capacity) {
      this.#diagnose('workspace_graph_lifecycle_queue_full')
      return false
    }
    this.#graphLifecyclePending += 1
    const pending = this.#graphLifecycleTail.then(operation)
    this.#graphLifecycleTail = pending.then(
      () => { this.#graphLifecyclePending -= 1 },
      () => { this.#graphLifecyclePending -= 1 },
    )
    return true
  }

  #acceptProjectContext(context: PublicProjectContext): void {
    this.#latestProjectView = Object.freeze({...context.view})
    this.#currentHostWorkspaceId = context.workspace_id
    this.#currentWorkspaceInstanceId = context.workspace_id === null
      ? null : this.#workspaceInstancesByHostId.get(context.workspace_id) ?? null
  }

  #enqueueProjectContextPublication(requireDelivery = false): Promise<void> {
    const view = this.#latestProjectView
    const hostWorkspaceId = this.#currentHostWorkspaceId
    const workspaceInstanceId = hostWorkspaceId === null
      ? null : this.#workspaceInstancesByHostId.get(hostWorkspaceId) ?? null
    const operation = this.#projectContextTail.then(async () => {
      await this.#injectCurrentProjectContext(
        view,
        hostWorkspaceId,
        workspaceInstanceId,
        requireDelivery,
      )
    })
    this.#projectContextTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  async #injectCurrentProjectContext(
    view: ProjectConfirmationView | null,
    hostWorkspaceId: string | null,
    workspaceInstanceId: string | null,
    requireDelivery: boolean,
  ): Promise<void> {
    if (
      view === null
      || hostWorkspaceId === null
    ) return
    if (this.provider.injectWorkspaceContext === undefined) {
      if (requireDelivery) throw new AssemblyError('active project context delivery is unavailable')
      return
    }
    const identity = this.providerSession.identity
    if (identity === null) {
      if (requireDelivery) throw new AssemblyError('active project context provider is disconnected')
      return
    }
    let graphHeader: string | null = null
    if (
      this.#workspaceGraphOpen
      && this.workspaceGraph !== undefined
      && workspaceInstanceId !== null
    ) {
      try {
        graphHeader = this.workspaceGraph.contextForTurn({
          session_epoch: identity.epoch,
          workspace_instance_id: workspaceInstanceId,
          utterance: '',
          preferences: [],
        })?.header ?? null
      } catch {
        this.#diagnose('workspace_graph_header_delivery_failed')
      }
    }
    const content = [
      renderActiveProjectContext(view),
      graphHeader === null
        ? null
        : `<workspace_graph_context>\n${graphHeader}\n</workspace_graph_context>`,
    ].filter((part): part is string => part !== null).join('\n')
    const contextKey = canonicalJson({
      session_epoch: identity.epoch,
      workspace_instance_id: hostWorkspaceId,
      content,
    })
    if (!this.#projectContextOwnershipUncertain && contextKey === this.#lastProjectContextKey) return
    this.#projectContextRevision += 1
    try {
      await this.providerSession.injectWorkspaceContext({
        kind: 'workspace_context',
        host_item_id: this.#idFactory(),
        event_id: this.#idFactory(),
        content,
        call_id: null,
        session_epoch: identity.epoch,
        workspace_instance_id: hostWorkspaceId,
        revision: this.#projectContextRevision,
      })
    } catch (error) {
      this.#projectContextOwnershipUncertain = true
      this.#lastProjectContextKey = null
      throw error
    }
    this.#lastProjectContextKey = contextKey
    this.#projectContextOwnershipUncertain = false
  }

  #diagnose(code: string): void {
    try {
      this.#onDiagnostic(`[realtime-diagnostic] ${code}`)
    } catch {
      // Graph diagnostics are best-effort and never change voice/project outcomes.
    }
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

function boundedTaskCompletionSummary(value: string): string | null {
  let bounded = ''
  for (const character of value) {
    if (bounded.length + character.length > 239) break
    bounded += character
  }
  return /\S/u.test(bounded) ? bounded : null
}

function isWorkspaceGraphQueueFull(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor !== undefined
    && 'value' in descriptor
    && descriptor.value === 'GRAPH_SERVICE_QUEUE_FULL'
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
  const wallClockNow = options.wallClockNow ?? (() => Date.now() / 1_000)
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
  const unbindSuggestionSelected = core.runtime.bindSuggestionSelected(
    (suggestion: Suggestion, reason: WakeReason) => {
      service.onSuggestionSelected(suggestion, reason)
    },
  )
  return new RealtimeAssembly({
    core,
    provider,
    providerSession,
    playback,
    session,
    bridge,
    service,
    onDiagnostic,
    idFactory,
    wallClockNow,
    unbindSuggestionSelected,
    ...(projectAdapter === undefined ? {} : {projectAdapter}),
    ...(options.onProjectView === undefined ? {} : {onProjectView: options.onProjectView}),
    ...(options.codexResource === undefined ? {} : {codexResource: options.codexResource}),
    ...(options.workspaceGraph === undefined ? {} : {workspaceGraph: options.workspaceGraph}),
  })
}

function asProjectAdapter(adapter: unknown): ProjectCodexAdapter {
  if (
    typeof adapter !== 'object'
    || adapter === null
    || !('confirmationController' in adapter)
    || !('commitConfirmed' in adapter)
    || !('publicProjectView' in adapter)
    || !('publicProjectContext' in adapter)
    || !('activeCommittedWorkspace' in adapter)
    || !('observeProjectView' in adapter)
    || !('observeProjectContext' in adapter)
    || !('observeCommittedWorkspace' in adapter)
    || !('observeTerminalWorkOrder' in adapter)
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
