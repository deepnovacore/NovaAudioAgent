import type {IntakeSession} from '../executors/coding/intake.js'
import type {ProjectProposal} from '../projects/project-confirmation.js'
import type {TaskToolHost} from '../core/task-tools.js'
import type {PromptLanguage} from './prompt-language.js'
import {
type AgentController
} from '../executors/agent-controller.js'
import type { ApprovalController as ExecutorApprovalController } from '../core/approval-port.js'
import type { ExecutorAdmission } from '../core/causal-runtime.js'
import type { Clock } from '../core/clock.js'
import type { CodingProgressNarrationState } from './coding-progress-narration.js'
import { type EventRecord,type JsonValue } from '../core/events.js'
import {
type IntakeEventPort,
type IntakeOptions,
} from '../executors/coding/intake.js'
import {
type MemoryItem
} from '../core/memory.js'
import type { PlaybackGeneration } from './playback.js'
import type { ExecutorRole } from '../core/ports.js'
import type {
ConfirmedProjectOperation,
ProjectConfirmationController,
ProjectConfirmationView,
} from '../projects/project-confirmation.js'
import type { CompiledTools } from '../core/tool-schema.js'
import type { RealtimeRuntimeBridge } from './bridge.js'
import type {
RealtimeProviderEvent
} from './protocol.js'
import type { PreemptiveAlert } from './service-state.js'
import {
type ExecutorState,
type HostItemOwner,
type PreemptiveAlertHistoryRecovery,
type UrgentHostResponseOwner
} from './service-state.js'
import {
type CaptionFrame
} from './session-state.js'
import { type RealtimeSession } from './session.js'
import type { RealtimeTelemetry } from './telemetry.js'

export interface DelegateLike {
  readonly request?: Readonly<Record<string, JsonValue>>
  readonly delegate_id: string
  readonly executor: string
  readonly op: string
  readonly origin_ref: string
  readonly routing_class: string
}

export interface ExecutorManifestLike {
  readonly name: string
  readonly display_name?: string | undefined
  readonly roles: readonly ExecutorRole[]
  readonly ops: readonly {readonly name: string; readonly sync_result?: boolean}[]
  readonly model_visibility?: 'direct' | 'hidden' | undefined
  readonly policy: {
    readonly priority: number
    readonly operation_class?: 'task' | 'monitor'
    readonly alert_delivery?: 'none' | 'deferred' | 'preemptive'
    readonly suggest?: boolean
    readonly progress_via_surrogate?: boolean
  }
}

export interface ServiceRuntime {
  readonly codingProgressNarration?: CodingProgressNarrationState
  readonly clock: Clock
  readonly executors: ReadonlyMap<string, {
    readonly manifest: ExecutorManifestLike
    admitRequest?(op: string, request: Readonly<Record<string, JsonValue>>): ExecutorAdmission | null
  }>
  observe(observer: (event: EventRecord, currentConversation?: boolean) => void): () => void
  serve(stop: AbortSignal): Promise<void>
  clearConversation?(): Promise<void>
  flushMemory?(maintenance?: boolean): Promise<void>
  /** The delegate a handoff claimed, if this exact event claimed one. */
  claimedHandoff(seq: number): DelegateLike | undefined
  /** Whether this exact deadline is the one that terminated its delegate. */
  terminatedByDeadline(seq: number, delegateId: string): boolean
  /** The delegate from either table, whether or not it is still in flight. */
  delegateFor(delegateId: string): DelegateLike | undefined
  /** The delegate only if it is still in flight. */
  inFlightDelegate(delegateId: string): DelegateLike | undefined
  /** A suggestion by id, for attributing a turn to what it was answering. Optional. */
  suggestionFor?: (suggestionId: string) => {
    readonly kind: string
    readonly evidence_refs: readonly string[]
  } | null
  /** Mark a suggestion as actually offered. Optional. */
  confirmSuggestionSpoken?: (suggestionId: string) => void
  /**
   * The blackboard, for the conversation history a replacement provider is seeded with.
   *
   * Optional because the history arms are off by default, and a runtime that never reconnects for a
   * preemptive alert
   * has no reason to expose it.
   */
  readonly memory?: {
    readonly policies: ReadonlyMap<string, {readonly progress_via_surrogate?: boolean}>
    readonly channels: ReadonlyMap<string, {readonly items: readonly MemoryItem[]}>
  }
}
export interface HostItemOptions {
      readonly stillWanted?:()=>boolean
  readonly onNotDelivered?:()=>Promise<void>
      readonly semanticEventId?: string | null
      readonly priority?: number
      readonly preemptive?: boolean
      /** A monitor policy has authorized this as a preemptive alert. */
      readonly preemptiveAlert?: boolean
      readonly preemptiveAlertDelegateId?: string | null
      readonly owner?: HostItemOwner | null
      readonly expiresAt?: number | null
    }

/** Detached observability at an awaited delivery/event boundary; reading never drives work. */
export interface DeliverySnapshot {
  readonly sessionEpoch: number
  readonly floor: RealtimeSession['floor']['state']
  readonly providerIdle: boolean
  readonly foregroundIdle: boolean
  readonly rendererPaused: boolean
  readonly activeResponseId: string | null
  readonly userResponseMode: RealtimeSession['userResponseMode']
  readonly urgentOwner: Pick<UrgentHostResponseOwner, 'session_epoch' | 'event_id' | 'response_id' | 'delivery_token'> | null
  readonly queuedEventIds: readonly string[]
  readonly armedPreemptPriority: number | null
  readonly preemptiveAlert: PreemptiveAlert | null
  readonly epochNeedingActivation: number | null
  readonly acknowledgementPhases: Readonly<Record<string, string>>
  readonly continuationOrder: readonly string[]
}

export interface BoundToolOrigin {
  readonly observedProviderResponseId: string | null
  readonly originItemId: string | null
  readonly originRef: string | null
}

export type ProviderReconnectReason =
  | 'project_confirmation_ui_retry'
  | 'uncertain_delivery'
  | 'recoverable_provider_error'
  | 'origin_resolution_overflow'
  | 'origin_binding_overflow'
  | 'refusal_ledger_overflow'
  | 'project_confirmation_carrier_recovery'
  | 'project_confirmation_expiry_cleanup'
  | 'client_disconnect'
  | 'test'

/** The provider surface the service uses directly: three calls, everything else via the session. */
export interface ServiceProvider {
  setLanguage?(language?: PromptLanguage): Promise<void>

  transcribeDraft?(pcm: Uint8Array, signal: AbortSignal): Promise<string>
  submitText?(text: string, signal: AbortSignal): Promise<void>
  sendAudio(pcm: Uint8Array, signal?: AbortSignal): Promise<void>
  /**
   * The event stream.
   *
   * Takes the stop signal because a parked stream is the normal case at shutdown: the provider has
   * nothing to say and the iterator is suspended. Without the signal, `close()` would wait on an
   * iteration that cannot be cancelled from outside.
   */
  events(signal: AbortSignal): AsyncIterable<RealtimeProviderEvent>
  close(): Promise<void>
}

export interface RealtimeServiceOptions {
  readonly onIntakePrepared?:(intake:Readonly<IntakeSession>,proposal:ProjectProposal)=>void
  readonly taskHost?: TaskToolHost
  readonly onProviderEvent?: (event: RealtimeProviderEvent) => void
  readonly intake?: Pick<
    IntakeOptions,
    'models' | 'settings' | 'roster' | 'running' | 'activeProject' | 'resolveTarget' | 'dispatch' | 'steer' | 'record'
  >
  /** Supplies the coding controller with host callbacks; the controller owns intake construction. */
  readonly agentControllerFactory?: AgentControllerFactory
  /** Additional host-owned controllers. */
  readonly agentControllers?: readonly AgentController[]
  readonly provider: ServiceProvider
  readonly runtime: ServiceRuntime
  readonly tools: CompiledTools
  readonly providerSchemas?: readonly Readonly<Record<string, JsonValue>>[]
  readonly session: RealtimeSession
  readonly bridge: RealtimeRuntimeBridge
  readonly idFactory?: () => string
  readonly onProviderTerminal?: (generation: PlaybackGeneration) => void
  readonly onExecutorState?: (state: ExecutorState) => void
  /** Fired when active delegate progress changes so provider context can refresh. */
  readonly onActiveWorkChanged?: () => void
  readonly onCaption?: (frame: CaptionFrame) => void
  /** Receives a user transcript only after the core accepted its evidence; it must not block audio. */
  readonly onUserTranscriptAccepted?: (turn: {
    readonly confirmed?: boolean
    readonly text: string
    readonly originRef: string
    readonly sessionEpoch: number
    readonly itemId: string
    readonly userInputRevision: number
  }) => void | Promise<void>
  readonly telemetry?: RealtimeTelemetry
  readonly controlledPreemptiveAlertReconnect?: boolean
  readonly preemptiveAlertHistoryRecovery?: PreemptiveAlertHistoryRecovery
  readonly preemptiveAlertHistoryPairs?: number
  /** Absent means project confirmation is off, and every branch of it is inert. */
  readonly projectConfirmation?: ProjectConfirmationController
  /** Independent one-shot Codex permission authority; absent on non-brokered transports. */
  readonly executorApproval?: ExecutorApprovalController
  readonly commitProjectOperation?: (
    operation: ConfirmedProjectOperation,
  ) => Promise<{
    readonly accepted: boolean
    readonly code: string
    readonly delegate_id?: string
  }>
  readonly onProjectView?: (view: ProjectConfirmationView) => void
  readonly projectViewProvider?: (pendingConfirmation: boolean) => ProjectConfirmationView
  /**
   * How long one expiry cleanup step may take before it is abandoned.
   *
   * Injectable because the default is five seconds of wall clock, and the behaviour that matters -- what
   * happens *after* a step is abandoned -- is otherwise only reachable by waiting that long.
   */
  readonly projectExpiryStepTimeoutMs?: number
  /** Where a diagnostic goes. Defaults to stdout, which is what the oracle captures. */
  readonly onDiagnostic?: (line: string) => void
}

export interface AgentControllerFactory {
  create(context: {
    readonly intake: IntakeOptions | undefined
  }): AgentController & {readonly intake?: IntakeEventPort | undefined}
}
