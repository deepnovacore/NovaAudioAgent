/**
 * Production orchestration between a realtime FrontBrain and the existing Runtime.
 *
 * Ported from `src/nova_audio_agent/realtime/service.py`. The session below it owns *provider*
 * state -- turns, fences, playback generations -- and this layer owns everything that has to be
 * decided across turns: which host fact gets the floor next, which tool calls belong to the same
 * continuation, and what happens to all of it when the provider session is replaced underneath.
 *
 * Two structural facts shape the whole file.
 *
 * **Almost every ledger is keyed on `(session_epoch, id)`.** That is the reconnect contract, not
 * defensive prefixing: after a reconnect the provider may reuse an item or response id, and a ledger
 * keyed on the id alone would let the new session's item answer the old session's question.
 *
 * **The two locks have a fixed order and one of them must never be held across a public call.**
 * `_reconnect_lock` is taken before `_delivery_lock`, never the reverse. And the reconnect path calls
 * the private `#deliveryPass` rather than the public `flushHostItems`, because the public wrapper
 * would re-enter reconnect and deadlock against the lock already held.
 *
 * Guard behavior (controlled reconnect, preemption arbitration, clear deadlines) and project
 * confirmation are gated behind `controlledGuardReconnect` and a supplied controller. They are not
 * ported yet; where the core path touches them it reaches an explicit boundary that throws rather
 * than silently taking the inert branch, so a test that gets there fails loudly.
 */

import type { Clock } from '../clock.js'
import { validProgressSummary, type EventRecord, type JsonValue } from '../events.js'
import { USER_PRIORITY, type MemoryItem } from '../memory.js'
import type { PlaybackCompletion, PlaybackGeneration } from '../playback.js'
import type { CompiledTools } from '../tool-schema.js'
import {requiresSynchronousResult} from './bridge.js'
import type { RealtimeRuntimeBridge, ToolAcceptance, ToolCallReady } from './bridge.js'
import type {
  ConfirmedProjectOperation,
  ProjectConfirmationController,
  ProjectConfirmationView,
} from './project-confirmation.js'
import type {
  HostContextItem,
  HostResponseIntent,
  RealtimeProviderEvent,
} from './protocol.js'
import { ItemDeliveryUncertainError } from './protocol.js'
import { packRecoveryTurns, projectRecoveryTurns, type RecoveryTurn } from './history.js'
import { RealtimeDeliveryError, type RealtimeSession } from './session.js'
import { MAX_CONTINUATION_TASK_SUMMARY, type CaptionFrame } from './session-state.js'
import {codePointLengthLikePython, stripLikePython} from '../python-text.js'
import {
  GUARD_ALERT_DEADLINE_S,
  GUARD_CLEAR_ACK_DEADLINE_S,
  HIT_ALERT_MIN_PRIORITY,
  MAX_HOST_FACT_CHARS,
  MAX_LATE_SYNC_RESULTS,
  MAX_PENDING_TOOL_REFUSALS,
  MAX_TRACKED_ORIGIN_DELIVERY_PROOFS,
  MAX_TRACKED_SEMANTIC_ACKNOWLEDGEMENTS,
  MAX_TRACKED_TOOL_CALLS,
  MAX_UNCERTAIN_DELIVERY_RETRIES,
  PROJECT_EXPIRY_STEP_TIMEOUT_S,
  PREEMPT_MIN_PRIORITY,
  SYNC_RESULT_SNIPPET_CHARS,
  SYNC_RESULT_TITLE_CHARS,
  USER_HOLD_MAX_S,
  callKey,
  compareQueuedHostResponses,
  parseCallKey,
  continuationBatch,
  projectCommitFailureText,
  semanticAcknowledgement,
  toolCallState,
  type CodexState,
  type ContinuationBatch,
  type DeferredOriginToolCall,
  type GuardActivationAuthority,
  type GuardHistoryRecovery,
  type GuardPreemption,
  type ProjectExpiryBatch,
  type QueuedHostResponse,
  type SemanticAcknowledgement,
  type ToolCallAcceptanceSnapshot,
  type ToolCallState,
  type UrgentHostResponseOwner,
} from './service-state.js'
import { finalSpeechView, genericFinalSpeechView } from './evidence.js'
import { SPEECH_FINAL_LIMIT, prepareForSpeech } from './speech-prep.js'
import type { RealtimeTelemetry } from './telemetry.js'

const PROJECT_CONFIRMATION_TOOL = 'codex__confirm_project_action'

interface BoundToolOrigin {
  readonly observedProviderResponseId: string | null
  readonly originItemId: string | null
  readonly originRef: string | null
}

function projectConfirmationDecisionArguments(
  value: unknown,
): {readonly proposalId: string; readonly confirmed: boolean} | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (Object.getPrototypeOf(value) !== Object.prototype) return null
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== 2
    || !keys.includes('proposal_id')
    || !keys.includes('confirmed')
  ) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const proposal = descriptors.proposal_id
  const confirmed = descriptors.confirmed
  if (
    proposal === undefined
    || confirmed === undefined
    || !('value' in proposal)
    || !('value' in confirmed)
    || typeof proposal.value !== 'string'
    || proposal.value === ''
    || codePointLengthLikePython(proposal.value) > 128
    || typeof confirmed.value !== 'boolean'
  ) return null
  return {proposalId: proposal.value, confirmed: confirmed.value}
}

/** The runtime surface the service reads. Thirteen call sites in the oracle, mostly reads. */
/** What the projection needs to know about one dispatched delegate. */
export interface DelegateLike {
  readonly delegate_id: string
  readonly executor: string
  readonly op: string
  readonly origin_ref: string
  readonly routing_class: string
}

/** What the projection needs from an executor's manifest. */
export interface ExecutorManifestLike {
  readonly ops: readonly {readonly name: string; readonly sync_result?: boolean}[]
  readonly policy: {
    readonly priority: number
    readonly suggest?: boolean
    readonly progress_via_surrogate?: boolean
  }
}

export interface ServiceRuntime {
  readonly clock: Clock
  readonly executors: ReadonlyMap<string, {readonly manifest: ExecutorManifestLike}>
  observe(observer: (event: EventRecord) => void): () => void
  serve(stop: AbortSignal): Promise<void>
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
   * Optional because the history arms are off by default, and a runtime that never reconnects a Guard
   * has no reason to expose it.
   */
  readonly memory?: {
    readonly channels: ReadonlyMap<string, {readonly items: readonly MemoryItem[]}>
  }
}

/** The provider surface the service uses directly: three calls, everything else via the session. */
export interface ServiceProvider {
  sendAudio(pcm: Uint8Array): Promise<void>
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
  readonly provider: ServiceProvider
  readonly runtime: ServiceRuntime
  readonly tools: CompiledTools
  readonly providerSchemas?: readonly Readonly<Record<string, JsonValue>>[]
  readonly session: RealtimeSession
  readonly bridge: RealtimeRuntimeBridge
  readonly idFactory?: () => string
  readonly onProviderTerminal?: (generation: PlaybackGeneration) => void
  readonly onCodexState?: (state: CodexState) => void
  readonly onCaption?: (frame: CaptionFrame) => void
  readonly telemetry?: RealtimeTelemetry
  readonly controlledGuardReconnect?: boolean
  readonly guardHistoryRecovery?: GuardHistoryRecovery
  readonly guardHistoryPairs?: number
  /** Absent means project confirmation is off, and every branch of it is inert. */
  readonly projectConfirmation?: ProjectConfirmationController
  readonly commitProjectOperation?: (
    operation: ConfirmedProjectOperation,
    originRef: string,
  ) => Promise<{readonly accepted: boolean; readonly code: string}>
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

/**
 * How long `close` waits for a task that is not responding to its abort signal.
 *
 * Short: every loop here checks the signal at its next suspension point, so a task still running after
 * this is stuck rather than slow, and waiting longer would only delay the diagnostic.
 */
const SHUTDOWN_GRACE_MS = 250

export class RealtimeService {
  readonly session: RealtimeSession

  readonly #provider: ServiceProvider
  readonly #runtime: ServiceRuntime
  readonly #clock: Clock
  readonly #tools: CompiledTools
  readonly #providerSchemas: readonly Readonly<Record<string, JsonValue>>[]
  readonly #bridge: RealtimeRuntimeBridge
  readonly #idFactory: () => string
  readonly #onProviderTerminal: (generation: PlaybackGeneration) => void
  readonly #onCodexState: (state: CodexState) => void
  readonly #onCaption: ((frame: CaptionFrame) => void) | undefined
  readonly #telemetry: RealtimeTelemetry | undefined
  readonly #onDiagnostic: (line: string) => void
  readonly #controlledGuardReconnect: boolean
  readonly #guardHistoryRecovery: GuardHistoryRecovery
  readonly #guardHistoryPairs: number
  readonly #projectConfirmation: ProjectConfirmationController | undefined
  readonly #commitProjectOperation:
    | ((operation: ConfirmedProjectOperation, originRef: string) => Promise<{
      readonly accepted: boolean
      readonly code: string
    }>)
    | undefined
  readonly #onProjectView: ((view: ProjectConfirmationView) => void) | undefined
  readonly #projectViewProvider:
    | ((pendingConfirmation: boolean) => ProjectConfirmationView)
    | undefined
  readonly #projectExpiryStepTimeoutMs: number

  /** A binary min-heap ordered by `compareQueuedHostResponses`, matching the oracle's `heapq`. */
  #hostItems: QueuedHostResponse[] = []
  #hostItemSeq = 0
  #pendingPreemptPriority: number | null = null
  #urgentDeliveryToken = 0
  #urgentHostResponseOwner: UrgentHostResponseOwner | null = null
  #providerEpochNeedingActivation: number | null = null
  #providerReconnectSourceEpoch: number | null = null
  #guardPreemptionToken = 0
  #guardPreemption: GuardPreemption | null = null
  /** The in-flight cancel deadline for the current preemption, if one is armed. */
  #guardAlertAbort: AbortController | null = null
  /** Per-generation waits for the renderer to confirm a clear, keyed `utterance:epoch`. */
  readonly #guardClearDeadlines = new Map<string, AbortController>()

  readonly #deliveryLock = new Mutex()
  readonly #reconnectLock = new Mutex()
  /**
   * CP3: serializes the continuation pass across its two entry points -- provider events and the
   * delivery loop. Never held together with the delivery lock.
   */
  readonly #continuationDriveLock = new Mutex()
  readonly #deliveryReady = new Signal()
  /**
   * The stop flag, as a real `AbortController`.
   *
   * Not a look-alike carrying only `aborted`: the runtime's `serve` registers an abort listener on
   * whatever it is handed, so anything less than the real thing throws on the first `start()`.
   * Replaced on each `start()` rather than reset, because an `AbortController` cannot be un-aborted.
   */
  #stop = new AbortController()

  #unsubscribe: (() => void) | null = null
  #tasks: Promise<void>[] = []
  #connected = false
  #providerFailed = false
  #codexState: CodexState = 'idle'

  /** Insertion-ordered, oldest evicted: a retry already attempted must not be attempted again. */
  readonly #uncertainDeliveryRetries = new Map<string, null>()
  readonly #toolCalls = new Map<string, ToolCallState>()
  readonly #overflowToolCalls = new Map<string, ToolCallState>()
  readonly #continuationBatches = new Map<string, ContinuationBatch>()
  readonly #continuationFifo: string[] = []
  readonly #semanticAcknowledgements = new Map<string, SemanticAcknowledgement>()
  readonly #audioStarted = new Set<string>()
  /**
   * Slots promised to calls admitted but not yet acknowledged.
   *
   * Counted against the same bound as the acknowledgements themselves, so two calls admitted back to
   * back cannot both be promised a slot only one of them can have.
   */
  #semanticAcknowledgementReservations = 0
  /** User items whose transcript has not arrived, oldest first. */
  readonly #unboundUserOriginItems: string[] = []
  /** `(epoch, response)` -> the user item that response is answering. */
  readonly #responseUserOriginItems = new Map<string, string>()
  /** User item -> the memory ref its transcript produced. LRU by touch. */
  readonly #userOriginRefs = new Map<string, string>()
  /** Tool calls waiting for the transcript that would justify them. */
  readonly #originDeferredToolCalls: DeferredOriginToolCall[] = []
  /** R105: delegate id -> the call key waiting on its synchronous result. */
  readonly #pendingSync = new Map<string, string>()
  /** A timed-out sync call whose first real late handoff should become one host fact. */
  readonly #lateSync = new Map<string, string>()
  /** Reserved user items answering a proposal, keyed `epoch:item`. */
  readonly #projectConfirmationItems = new Set<string>()
  /** Items mid-close: no longer answerable, still blocking tool calls. */
  readonly #projectConfirmationClosingItems = new Set<string>()
  /** Responses a confirmation has blocked, so the block sticks for the whole turn. */
  readonly #projectConfirmationResponses = new Set<string>()
  readonly #projectConfirmationClosingCalls = new Set<string>()
  /** Insertion-ordered so the oldest closed call is the one evicted. */
  readonly #projectConfirmationClosedCalls = new Map<string, null>()
  #projectConfirmationBlocking = false
  #projectConfirmationFencePending = false
  readonly #projectExpiryBatches: ProjectExpiryBatch[] = []
  #projectExpiryDraining: Promise<void> | null = null
  #unsubscribeProjectExpiry: (() => void) | null = null
  /**
   * The last progress summary spoken for each delegate.
   *
   * The same-summary skip is what stops an executor that reports identical progress every few seconds
   * from making the agent repeat itself. Cleared when the delegate settles, so a later run of the same
   * id does not inherit a summary it never produced.
   */
  readonly #lastProgressSummary = new Map<string, string>()
  /**
   * `(epoch, response)` keys whose playback the user demonstrably heard.
   *
   * Proof rather than assumption: an acknowledgement is only suppressed as already-said when there is
   * a record of the turn carrying it having actually been played.
   */
  readonly #originDeliveryProofs = new Map<string, null>()
  #awaitingUserOrigin = false
  #userOriginPreexistingResponseId: string | null = null

  constructor(options: RealtimeServiceOptions) {
    const recovery = options.guardHistoryRecovery ?? 'none'
    if (recovery !== 'none' && recovery !== 'packed') {
      throw new TypeError('unknown Guard history recovery arm')
    }
    const pairs = options.guardHistoryPairs ?? 4
    // 1, 2, or 4 rather than any positive number: these are the arms the recovery experiment has,
    // and an unlisted value would silently be a fifth arm nobody measured.
    if (pairs !== 1 && pairs !== 2 && pairs !== 4) {
      throw new TypeError('Guard history pair budget must be 1, 2, or 4')
    }
    this.#provider = options.provider
    this.#runtime = options.runtime
    this.#clock = options.runtime.clock
    this.#tools = options.tools
    // Deep-copied at construction: the provider is handed these on every connect, including after a
    // reconnect, and a caller that mutated its own array afterwards would change what the model is
    // told its tools are, mid-session.
    this.#providerSchemas = structuredClone(options.providerSchemas ?? options.tools.schemas)
    this.session = options.session
    this.#bridge = options.bridge
    this.#idFactory = options.idFactory ?? (() => `host_${randomHex()}`)
    this.#onProviderTerminal = options.onProviderTerminal ?? noop
    this.#onCodexState = options.onCodexState ?? noop
    this.#onCaption = options.onCaption
    this.#telemetry = options.telemetry
    this.#onDiagnostic = options.onDiagnostic ?? ((line: string): void => {
      console.log(line)
    })
    this.#controlledGuardReconnect = options.controlledGuardReconnect ?? false
    this.#guardHistoryRecovery = recovery
    this.#guardHistoryPairs = pairs
    this.#projectConfirmation = options.projectConfirmation
    this.#commitProjectOperation = options.commitProjectOperation
    this.#onProjectView = options.onProjectView
    this.#projectViewProvider = options.projectViewProvider
    this.#projectExpiryStepTimeoutMs = options.projectExpiryStepTimeoutMs
      ?? PROJECT_EXPIRY_STEP_TIMEOUT_S * 1_000
    // Subscribed at construction: a proposal can expire before anything else happens, and the observer
    // is the only notice of it.
    this.#unsubscribeProjectExpiry = options.projectConfirmation?.observeExpiry(() => {
      this.#projectConfirmationExpired()
    }) ?? null
  }

  get codexState(): CodexState {
    return this.#codexState
  }

  get stopped(): boolean {
    return this.#stop.signal.aborted
  }

  /** What the host told the provider about each live tool call, in admission order. */
  toolCallAcceptances(): readonly ToolCallAcceptanceSnapshot[] {
    return [...this.#toolCalls.entries()].map(([key, state]) => {
      const separator = key.indexOf(':')
      return {
        session_epoch: Number(key.slice(0, separator)),
        call_id: key.slice(separator + 1),
        provider_response_id: state.provider_response_id,
        acceptance: state.acceptance,
      }
    })
  }

  /** The acknowledgement bound to one provider response, if it is the one being spoken. */
  semanticAcknowledgementFor(responseId: string): string | null {
    for (const current of this.#semanticAcknowledgements.values()) {
      if (current.phase === 'bound' && current.response_id === responseId) return current.event_id
    }
    return null
  }

  async connect(): Promise<void> {
    if (this.#connected) return
    await this.session.connect({tools: structuredClone(this.#providerSchemas)})
    this.#unsubscribe = this.#runtime.observe(event => {
      this.projectRuntimeEvent(event)
    })
    this.#connected = true
  }

  /**
   * Start the three long-lived loops.
   *
   * Idempotent by design: `start` is called from more than one place during bring-up, and a second
   * set of loops would consume the same provider stream twice.
   */
  async start(): Promise<void> {
    await this.connect()
    if (this.#tasks.length > 0) return
    // A fresh controller: an aborted one cannot be reused, and `start` after `close` has to work.
    // Each guard is handed the controller it belongs to, so a task abandoned by an earlier close
    // cannot report a failure against the run that replaced it.
    const run = new AbortController()
    this.#stop = run
    const signal = run.signal
    this.#tasks = [
      this.#guardTask(this.#receiveLoop(signal), run),
      this.#guardTask(this.#deliveryLoop(signal), run),
      this.#guardTask(this.#runtime.serve(signal), run),
    ]
  }

  /**
   * Stop everything, and surface a provider close failure rather than swallowing it.
   *
   * The order matters. State that could authorize new work is cleared *before* awaiting anything, so
   * a task still running during the await cannot act on it. The provider close is attempted even if
   * that clearing threw, and its own failure is held and re-raised after every task has been
   * cancelled -- a close that failed still has to leave the service stopped.
   */
  async close(): Promise<void> {
    this.#stop.abort()
    this.#invalidateProjectConfirmation('service_closed')
    if (this.#unsubscribeProjectExpiry !== null) {
      this.#unsubscribeProjectExpiry()
      this.#unsubscribeProjectExpiry = null
    }
    this.#projectExpiryBatches.length = 0
    // The drain is shutdown-owned work. A promise cannot be cancelled, so its continuations check the
    // signal instead -- and this waits, bounded, so a reconnect cannot land after `close` returned.
    const draining = this.#projectExpiryDraining
    this.#providerEpochNeedingActivation = null
    this.#providerReconnectSourceEpoch = null
    this.#urgentHostResponseOwner = null
    this.#guardPreemption = null
    this.#deliveryReady.set()
    if (this.#unsubscribe !== null) {
      this.#unsubscribe()
      this.#unsubscribe = null
    }
    // Held rather than propagated immediately: a close that failed still has to leave every task
    // cancelled and the service marked disconnected, so the failure is re-raised only after that.
    let closeFailure: {readonly cause: unknown} | null = null
    let closeAbandoned = false
    try {
      // Bounded like the loops are. A transport that never finishes closing would otherwise block
      // application shutdown forever, which is exactly the failure mode a degraded transport has.
      closeAbandoned = !await resolvedWithin(this.#provider.close(), SHUTDOWN_GRACE_MS)
    } catch (cause) {
      closeFailure = {cause}
    }
    if (closeAbandoned) {
      this.#onDiagnostic('[realtime-diagnostic] shutdown_provider_close_abandoned')
    }
    const tasks = draining === null ? this.#tasks : [...this.#tasks, draining]
    this.#tasks = []
    // Bounded. A promise cannot be cancelled from outside the way an asyncio task can, so a loop that
    // ignores the abort would make `close` wait forever -- and a service that never finishes closing
    // is worse than one that reports a task it could not stop. The loops all observe the signal, so
    // reaching the timeout means one of them is genuinely stuck.
    const abandoned = await settleWithin(tasks, SHUTDOWN_GRACE_MS)
    this.#connected = false
    if (abandoned > 0) {
      this.#onDiagnostic(
        `[realtime-diagnostic] shutdown_tasks_abandoned count=${abandoned}`,
      )
    }
    if (closeFailure !== null) throw asError(closeFailure.cause)
  }

  async sendAudio(pcm: Uint8Array): Promise<void> {
    await this.#provider.sendAudio(pcm)
  }

  async localSpeechOnset(speechId: string): Promise<void> {
    await this.session.localSpeechOnset(speechId)
  }

  async waitStopped(): Promise<void> {
    await Promise.allSettled(this.#tasks)
  }

  /**
   * Queue one host fact for delivery when the floor allows it.
   *
   * The priority is clamped below `USER_PRIORITY`: nothing the host says may outrank the user, and a
   * caller that passes a higher number is expressing urgency rather than claiming precedence over the
   * person in the room.
   */
  queueHostItem(
    intent: HostResponseIntent,
    options: {
      readonly semanticEventId?: string | null
      readonly priority?: number
      readonly preemptive?: boolean
      readonly guardDelegateId?: string | null
    } = {},
  ): void {
    const priority = options.priority ?? 50
    const preemptive = options.preemptive ?? false
    const effectivePriority = Math.min(priority, USER_PRIORITY - 1)
    const guardDelegateId = options.guardDelegateId ?? null
    const guardActivation: GuardActivationAuthority | null = guardDelegateId === null
      ? null
      : {
        delegate_id: guardDelegateId,
        event_id: intent.item.event_id,
        source_epoch: this.session.sessionEpoch,
      }
    this.#telemetry?.record('hostitem.queued', {event_id: intent.item.event_id})
    this.#hostItemSeq += 1
    const queued: QueuedHostResponse = {
      sortKey: [-effectivePriority, preemptive ? -1 : 0, this.#hostItemSeq],
      intent,
      priority: effectivePriority,
      preemptive,
      seq: this.#hostItemSeq,
      queued_at: this.#clock.now(),
      semantic_event_id: options.semanticEventId ?? null,
      guard_activation: guardActivation,
    }
    heapPush(this.#hostItems, queued)
    if (preemptive) this.#armPreempt(effectivePriority)
    this.#deliveryReady.set()
  }

  #requeueHostItem(queued: QueuedHostResponse): void {
    this.#telemetry?.record('hostitem.queued', {event_id: queued.intent.item.event_id})
    heapPush(this.#hostItems, queued)
    if (queued.preemptive) this.#armPreempt(queued.priority)
    this.#deliveryReady.set()
  }

  #armPreempt(priority: number): void {
    const pending = this.#pendingPreemptPriority
    this.#pendingPreemptPriority = pending === null ? priority : Math.max(priority, pending)
  }

  /** Recompute the armed preempt priority from what is actually still queued. */
  #recomputePreemptPriority(): void {
    const priorities = this.#hostItems
      .filter(candidate => candidate.preemptive)
      .map(candidate => candidate.priority)
    this.#pendingPreemptPriority = priorities.length === 0 ? null : Math.max(...priorities)
  }

  /**
   * Deliver everything the floor currently allows.
   *
   * The public entry point. It exists to translate an uncertain delivery into a reconnect attempt;
   * the reconnect path itself must call `#deliveryPass` instead, or it would re-enter here while
   * holding the reconnect lock.
   */
  async flushHostItems(): Promise<void> {
    try {
      await this.#deliveryPass()
    } catch (cause) {
      if (cause instanceof ItemDeliveryUncertainError) {
        await this.#recoverUncertainDelivery(cause)
        return
      }
      throw cause
    }
  }

  /**
   * An injection whose outcome the provider never confirmed.
   *
   * Retried exactly once per item, and never for a recovery item -- a recovery injection is what a
   * reconnect *is*, so retrying it through another reconnect would recurse. A second uncertainty for
   * the same item means the transport cannot be trusted to report anything, and the service stops
   * rather than guessing whether the model has seen a fact.
   */
  async #recoverUncertainDelivery(failure: ItemDeliveryUncertainError): Promise<void> {
    if (failure.item_kind === 'recovery') {
      this.#failUncertainDelivery()
      return
    }
    if (this.#uncertainDeliveryRetries.has(failure.host_item_id)) {
      this.#failUncertainDelivery()
      return
    }
    this.#uncertainDeliveryRetries.delete(failure.host_item_id)
    this.#uncertainDeliveryRetries.set(failure.host_item_id, null)
    while (this.#uncertainDeliveryRetries.size > MAX_UNCERTAIN_DELIVERY_RETRIES) {
      const oldest = this.#uncertainDeliveryRetries.keys().next()
      if (oldest.done === true) break
      this.#uncertainDeliveryRetries.delete(oldest.value)
    }
    try {
      const reconnected = await this.#reconnectProviderSession({expectedEpoch: failure.session_epoch})
      if (!reconnected) await this.#deliveryPass()
    } catch (cause) {
      if (cause instanceof ItemDeliveryUncertainError) {
        this.#failUncertainDelivery()
        return
      }
      throw cause
    }
  }

  #failUncertainDelivery(): void {
    this.#onDiagnostic('[realtime-diagnostic] uncertain_delivery_exhausted')
    this.#providerFailed = true
    this.#urgentHostResponseOwner = null
    this.#guardPreemption = null
    this.#stop.abort()
    this.#deliveryReady.set()
  }

  /**
   * One pass over the queue, under the delivery lock.
   *
   * The stale-hold release happens first and unconditionally: a user hold that has outlived its
   * window blocks every delivery, so checking it after the floor test would let one abandoned hold
   * stall the queue indefinitely.
   *
   * The continuation re-drive at the end is the subtle part. A preempt that was armed and is no
   * longer armed means the thing blocking continuations has cleared, and nothing else will notice --
   * so this pass has to hand off. It happens *outside* the lock because the continuation drive takes
   * its own, and CP3 says the two are never held together.
   */
  async #deliveryPass(): Promise<void> {
    let shouldRedriveContinuations = false
    await this.#deliveryLock.run(async () => {
      if (this.session.releaseStaleUserHold(USER_HOLD_MAX_S)) {
        this.#onDiagnostic('[realtime-diagnostic] floor_stale_hold_released')
      }
      const eligiblePreemptWasArmed = this.#pendingPreemptPriority !== null
        && this.#pendingPreemptPriority >= PREEMPT_MIN_PRIORITY
      await this.#maybePreemptLocked()
      await this.#flushHostItemsLocked()
      shouldRedriveContinuations = eligiblePreemptWasArmed
        && (
          this.#pendingPreemptPriority === null
          || this.#pendingPreemptPriority < PREEMPT_MIN_PRIORITY
        )
        && this.session.foregroundIdle
        && this.session.floor.state !== 'user_speaking'
    })
    if (shouldRedriveContinuations) await this.driveContinuations()
  }

  /**
   * Arbitrate a preemptive host item against whatever the agent is saying.
   *
   * Every early return here is a reason *not* to interrupt, and they are checked before any Guard
   * state is touched so the ordinary path never reaches the unported arbitration.
   */
  async #maybePreemptLocked(): Promise<void> {
    const priority = this.#pendingPreemptPriority
    if (priority === null || priority < PREEMPT_MIN_PRIORITY) return
    if (this.session.floor.state === 'user_speaking') return
    if (this.session.foregroundIdle) return
    if (this.#urgentHostResponseOwner !== null) return
    if (this.#guardPreemption !== null) return
    const queued = this.#hostItems
      .filter(candidate => candidate.preemptive && candidate.priority >= PREEMPT_MIN_PRIORITY)
      .sort(compareQueuedHostResponses)
      .at(0)
    if (queued === undefined) return

    this.#guardPreemptionToken += 1
    const preemption: GuardPreemption = {
      token: this.#guardPreemptionToken,
      session_epoch: this.session.sessionEpoch,
      event_id: queued.intent.item.event_id,
      old_response_id: this.session.activeProviderResponseId,
      old_generation: this.session.currentGeneration,
      queued_at: queued.queued_at,
      cancel_sent: false,
      deadline_fired: false,
      replacement_terminal: false,
      reconnect_permit_consumed: false,
      reconnect_disallowed: false,
      reconnect_aborted: false,
    }
    this.#guardPreemption = preemption
    // Armed before the await: the provider may never confirm the cancel, and the deadline is what
    // stops the alert waiting behind a turn that will not stop.
    const abort = new AbortController()
    this.#guardAlertAbort = abort
    void this.#fireGuardAlertDeadline(preemption)
    this.#telemetry?.record('guard.preempt_started', {})
    let preempted: boolean
    try {
      preempted = await this.session.hostPreempt()
    } catch (cause) {
      // The preemption never happened, so its deadline must not fire against a session that is still
      // speaking normally.
      this.#clearGuardPreemption(preemption.token)
      throw cause
    }
    if (!preempted) {
      this.#clearGuardPreemption(preemption.token)
      return
    }
    // The session may have learned the response id only while preempting -- a turn that was still
    // starting when the alert arrived.
    const responseId = this.session.activeProviderResponseId
    const current = this.#guardPreemption
    if (
      responseId !== null
      && current !== null
      && current.token === preemption.token
      && this.session.providerTurnPhase(responseId) === 'cancel_requested'
    ) {
      if (current.old_response_id === null) {
        this.#guardPreemption = {...current, old_response_id: responseId}
      }
      this.#recordGuardCancelSent(responseId)
    }
  }

  /**
   * Deliver from the head of the queue while the floor allows it.
   *
   * Stops at the first item that cannot go now rather than scanning past it: the heap order *is* the
   * delivery order, and skipping a blocked head to deliver a lower-priority item behind it would
   * reorder what the user hears.
   */
  async #flushHostItemsLocked(): Promise<void> {
    while (this.#hostItems.length > 0) {
      const queued = this.#hostItems[0]!
      const preemptiveOverlap = this.#guardOverlapAllowed(queued)
      const ordinaryDelivery = this.session.foregroundIdle && this.session.floor.state === 'idle'
      if (!preemptiveOverlap && !ordinaryDelivery) break
      heapPop(this.#hostItems)
      const userActivation = this.#guardActivationRequired(queued)
      let delivery
      try {
        if (userActivation) {
          // A reconnected session will not speak until something user-shaped arrives, so a Guard fact
          // crossing a reconnect has to carry that activation or it lands in a session that never
          // responds.
          delivery = await this.session.deliverHostResponse(queued.intent, {asUserActivation: true})
        } else if (preemptiveOverlap) {
          const preemption = this.#guardPreemption
          // Only a permit-consuming preemption gets a confirmation timeout: it is speaking into a
          // session created for it, where waiting indefinitely would strand the alert.
          const confirmationTimeout = preemption !== null
            && preemption.reconnect_permit_consumed
            && preemption.event_id === queued.intent.item.event_id
            ? 0.5
            : null
          delivery = confirmationTimeout === null
            ? await this.session.deliverPreemptiveHostResponse(queued.intent)
            : await this.session.deliverPreemptiveHostResponse(queued.intent, {confirmationTimeout})
        } else {
          delivery = await this.session.deliverHostResponse(queued.intent)
        }
      } catch (cause) {
        // Put it back before propagating: a delivery that threw has not been delivered, and dropping
        // it here would lose a fact the model was supposed to receive.
        heapPush(this.#hostItems, queued)
        throw cause
      }
      const delivered = delivery.accepted
      if (delivered && userActivation) {
        this.#providerEpochNeedingActivation = null
        this.#providerReconnectSourceEpoch = null
      }
      if (queued.preemptive) this.#recomputePreemptPriority()
      if (
        delivered
        && queued.preemptive
        && !this.#stop.signal.aborted
        && !this.#providerFailed
        && delivery.injectionEpoch === this.session.sessionEpoch
      ) {
        // The owner is what makes the alert's audio attributable until it is played or cleared.
        this.#urgentDeliveryToken += 1
        this.#urgentHostResponseOwner = {
          delivery_token: this.#urgentDeliveryToken,
          session_epoch: delivery.injectionEpoch,
          event_id: queued.intent.item.event_id,
          queued,
          response_id: null,
          generation: null,
        }
      }
      if (delivered && queued.semantic_event_id !== null) {
        const acknowledgement = this.#semanticAcknowledgements.get(queued.semantic_event_id)
        if (acknowledgement?.phase === 'queued') acknowledgement.phase = 'requested'
      }
      if (delivered) {
        this.#telemetry?.record('hostitem.injected', {event_id: queued.intent.item.event_id})
        // One delivery per pass: the floor state this loop tested is now stale, and the next pass
        // re-reads it rather than assuming the item just injected left the floor unchanged.
        break
      }
    }
  }

  /** Whether this queued item is the captured Guard the current preemption is waiting to deliver. */
  #guardOverlapAllowed(queued: QueuedHostResponse): boolean {
    const preemption = this.#guardPreemption
    return preemption !== null
      && queued.preemptive
      && queued.intent.item.event_id === preemption.event_id
      && preemption.session_epoch === this.session.sessionEpoch
      && this.session.providerIdle
      && this.session.floor.state !== 'user_speaking'
  }

  /**
   * Whether this item has to be injected as a user activation.
   *
   * A reconnected provider session will not speak until something user-shaped arrives, so a Guard
   * fact that crosses a reconnect has to carry that activation or it is delivered into a session
   * that never responds.
   */
  #guardActivationRequired(queued: QueuedHostResponse): boolean {
    const authority = queued.guard_activation
    if (authority?.event_id !== queued.intent.item.event_id) return false
    const authorized = queued.intent.item.event_id === `final:${authority.delegate_id}`
      || queued.intent.item.event_id.startsWith(`observation:${authority.delegate_id}:`)
    if (!authorized) return false
    return this.#providerEpochNeedingActivation === this.session.sessionEpoch
      || (
        this.#providerReconnectSourceEpoch !== null
        && this.#providerReconnectSourceEpoch !== this.session.sessionEpoch
      )
  }

  /** Blank dead-epoch speculative text on both roles after a reconnect. */
  #clearCaptions(): void {
    this.session.resetCaptions()
    if (this.#onCaption !== undefined) {
      this.#onCaption({role: 'assistant', text: '', final: true})
      this.#onCaption({role: 'user', text: '', final: true})
    }
  }

  /**
   * CP3: both the provider stream and the delivery loop drive continuations.
   *
   * The phase check inside cannot stop a second entrant on its own, because the pass awaits the
   * provider partway through -- so the whole pass is serialized instead.
   */
  async driveContinuations(): Promise<void> {
    await this.#continuationDriveLock.run(async () => {
      await this.#driveContinuationsLocked()
    })
  }

  /**
   * Whether a continuation may be requested right now.
   *
   * Two reasons not to. The user speaking outranks anything the agent wants to say. And an armed
   * preemption means something urgent is about to interrupt, so starting a turn now would produce one
   * that is immediately cut off.
   */
  #continuationRequestIsBlocked(): boolean {
    return this.session.floor.state === 'user_speaking'
      || (
        this.#pendingPreemptPriority !== null
        && this.#pendingPreemptPriority >= PREEMPT_MIN_PRIORITY
      )
  }

  /**
   * Give the model a turn to speak about finished tool work, one batch at a time.
   *
   * Strictly FIFO and strictly one in flight. The FIFO is why the agent narrates work in the order it
   * was asked for rather than the order it finished; the single-flight check is why it does not talk
   * over itself. Both are enforced by looking only at the head of the queue -- a batch that is not
   * ready blocks the ones behind it deliberately, because speaking about later work first would
   * describe a sequence the user did not ask for.
   *
   * Every `return` here leaves the batch where it is, to be retried when something changes. Every
   * `continue` has popped a batch that will never speak.
   */
  async #driveContinuationsLocked(): Promise<void> {
    if (
      this.#pendingPreemptPriority !== null
      && this.#pendingPreemptPriority >= PREEMPT_MIN_PRIORITY
    ) {
      return
    }
    // One turn in flight at a time. Checked across all batches rather than just the head, because a
    // batch can still be speaking after its own key left the front of the queue.
    for (const batch of this.#continuationBatches.values()) {
      if (batch.phase === 'requested' || batch.phase === 'bound') return
    }

    while (this.#continuationFifo.length > 0) {
      const head = this.#continuationFifo[0]!
      const batch = this.#continuationBatches.get(head)
      if (batch === undefined) {
        this.#continuationFifo.shift()
        continue
      }
      if (batch.phase === 'terminal' || batch.phase === 'abandoned') {
        this.#continuationFifo.shift()
        continue
      }
      if (batch.phase !== 'ready') return

      const abandoning = batch.origin_status === 'cancelled' || batch.origin_status === 'failed'
      if (!abandoning) {
        // R105: a sync member is still awaiting its Handoff or Deadline. The batch stays unready
        // without popping or requesting -- speaking now would describe a result that does not exist.
        for (const key of batch.call_keys) {
          if (this.#toolCallState(key)?.sync === 'pending') return
        }
      }

      // The provider is holding a slot for every tool result in this batch. They are injected before
      // the turn is requested, and before the abandon path too: an abandoned batch still owes the
      // provider its results, or the protocol stalls waiting for them.
      const intents: HostResponseIntent[] = []
      for (const key of batch.call_keys) {
        const state = this.#toolCallState(key)
        if (state === undefined) continue
        if (state.output === 'pending') {
          await this.session.injectToolOutput(state.acceptance.host_item)
          state.output = 'confirmed'
        }
        intents.push(state.acceptance.response_intent)
      }

      if (abandoning) {
        this.#abandonBatch(batch)
        this.#continuationFifo.shift()
        continue
      }
      if (intents.length === 0) {
        // Every member has been pruned out from under the batch, so there is nothing to speak about.
        batch.phase = 'abandoned'
        this.#continuationFifo.shift()
        continue
      }
      if (this.#continuationRequestIsBlocked()) return

      const requestResult = await this.session.requestToolContinuation(intents, {
        originSpoken: this.#batchOriginWasDelivered(batch),
      })
      // Retryable means the provider could not take it *now*: the batch keeps its place and the next
      // pass tries again. Rejected means it never will.
      if (requestResult === 'retryable') return
      if (requestResult === 'rejected') {
        this.#abandonBatch(batch)
        this.#continuationFifo.shift()
        continue
      }
      batch.phase = 'requested'
      for (const key of batch.call_keys) {
        const state = this.#toolCallState(key)
        if (state !== undefined) state.continuation = 'requested'
      }
      return
    }
  }

  /**
   * Give up on a batch, and settle what each member is owed.
   *
   * The final disposition distinguishes three things a caller cares about: work that was never
   * dispatched is `superseded`, work the bridge refused is `refused`, and work that ran but will not
   * be spoken about is `abandoned` -- and only that last kind gets a background acknowledgement,
   * because it is the only one where something actually happened that the user has not heard about.
   */
  #abandonBatch(batch: ContinuationBatch): void {
    for (const key of batch.call_keys) {
      const state = this.#toolCallState(key)
      if (state === undefined) continue
      state.continuation = 'abandoned'
      if (state.sync === 'pending') {
        // R105: an abandoned batch converts the pending sync wait to the announce path; the result
        // becomes a host fact instead of part of a turn that is no longer happening.
        state.sync = 'announce'
      } else if (state.sync === 'resolved') {
        // CP3: resolved while collecting. The output injection above landed in a dead turn and no
        // continuation will speak it, so it is downgraded to one announce host fact.
        this.#announceResolvedSyncState(state)
      }
      if (state.dispatch === 'not_dispatched') {
        state.final_disposition = 'superseded'
      } else if (!state.acceptance.accepted) {
        state.final_disposition = 'refused'
      } else {
        state.final_disposition = 'abandoned'
        this.#queueBackgroundAcknowledgement(state)
      }
    }
    batch.phase = 'abandoned'
  }

  /**
   * Whether the user has already heard the acknowledgement this batch would repeat.
   *
   * Only meaningful for a single-call batch: with more than one there is no single origin to have been
   * delivered. The revision check is what makes it safe -- a proof from before the user spoke again
   * says nothing about whether they have heard about *this* turn.
   */
  #batchOriginWasDelivered(batch: ContinuationBatch): boolean {
    if (batch.call_keys.length !== 1) return false
    const state = this.#toolCallState(batch.call_keys[0]!)
    if (state === undefined || !this.#refreshOriginDelivery(state, batch)) return false
    const acknowledgement = this.#semanticAcknowledgement(state)
    return acknowledgement !== null
      && acknowledgement.origin_delivered
      && acknowledgement.origin_user_input_revision === this.session.userInputRevision
  }

  /**
   * Mark an acknowledgement as already spoken, if there is proof its turn was played.
   *
   * A proof only counts for a lone asynchronous call: with several in a batch, or with a synchronous
   * result, the turn that played was not the acknowledgement.
   */
  #refreshOriginDelivery(state: ToolCallState, batch?: ContinuationBatch): boolean {
    const key = callKey(state.provider_session_epoch, state.provider_response_id)
    const resolved = batch ?? this.#continuationBatches.get(key)
    const singleAsync = resolved?.call_keys.length === 1
      && this.#toolCallState(resolved.call_keys[0]!) === state
      && state.acceptance.response_intent.kind === 'delegation_acknowledgement'
    if (!singleAsync || !this.#originDeliveryProofs.has(key)) return false
    const acknowledgement = this.#semanticAcknowledgement(state)
    if (acknowledgement === null) return false
    acknowledgement.origin_delivered = true
    return true
  }

  /**
   * Queue the acknowledgement for work that ran but will not be spoken about in its own turn.
   *
   * If the user already heard it, it is marked delivered instead of queued: saying it twice is worse
   * than not saying it again.
   */
  #queueBackgroundAcknowledgement(state: ToolCallState): void {
    const acknowledgement = this.#semanticAcknowledgement(state)
    if (acknowledgement === null) return
    this.#refreshOriginDelivery(state)
    if (acknowledgement.origin_delivered) {
      acknowledgement.phase = 'delivered'
      acknowledgement.response_id = null
      acknowledgement.binding = null
      return
    }
    this.#queueSemanticAcknowledgement(acknowledgement)
  }

  /** Queue one acknowledgement as a host fact, unless it is already queued or already said. */
  #queueSemanticAcknowledgement(acknowledgement: SemanticAcknowledgement): void {
    if (
      acknowledgement.phase === 'requested'
      || acknowledgement.phase === 'bound'
      || acknowledgement.phase === 'delivered'
    ) {
      return
    }
    if (this.#hostItems.some(queued => queued.semantic_event_id === acknowledgement.event_id)) {
      // Already waiting its turn. Marked queued rather than queued again, so the user hears it once.
      acknowledgement.phase = 'queued'
      return
    }
    const priority = this.#executorPriority(acknowledgement.channel)
    this.queueHostItem({
      kind: 'host_fact',
      item: {
        kind: 'progress',
        host_item_id: this.#idFactory(),
        event_id: acknowledgement.event_id,
        content: `${this.#executorDisplayName(acknowledgement.channel)} 已提交，正在启动：${acknowledgement.summary}`,
        call_id: null,
      },
      task_summary: null,
      origin_spoken: false,
    }, {semanticEventId: acknowledgement.event_id, priority})
    acknowledgement.phase = 'queued'
  }

  /**
   * CP3: a resolved-but-undelivered sync result of an abandoned batch keeps its compact view.
   *
   * Requeued as the one announce host fact, rather than discarded: the work ran and produced a result
   * the model was going to ground itself on, and losing it silently is worse than saying it plainly.
   */
  #announceResolvedSyncState(state: ToolCallState): void {
    const delegateId = state.acceptance.delegate_id
    if (delegateId === null) return
    state.sync = 'announce'
    this.queueHostItem({
      kind: 'host_fact',
      item: {
        kind: 'final',
        host_item_id: this.#idFactory(),
        event_id: `sync:${delegateId}`,
        content: state.acceptance.host_item.content,
        call_id: null,
      },
      task_summary: null,
      origin_spoken: false,
    }, {priority: this.#executorPriority(state.acceptance.executor)})
  }

  /** A channel's manifest priority, or the default when there is no manifest for it. */
  #executorPriority(channel: string | null): number {
    if (channel === null) return 50
    return this.#runtime.executors.get(channel)?.manifest.policy.priority ?? 50
  }

  /**
   * Settle the acknowledgements the response that just ended was carrying.
   *
   * Three outcomes, and the distinction is what stops the agent both repeating itself and going quiet.
   * A completed response said it, so the acknowledgement is delivered and never mentioned again. A
   * *fallback* binding that did not complete gets one more attempt -- it was a host fact of its own, and
   * losing it would lose the only notice the user gets. A *continuation* binding that did not complete
   * goes back to pending without re-queueing, because the batch it belonged to will drive it again.
   *
   * An origin already proven delivered is delivered regardless of the status: the user heard it, and a
   * retry would be the second telling.
   */
  #finishSemanticAcknowledgement(event: {
    readonly response_id: string
    readonly status: string
  }): void {
    const bound = [...this.#semanticAcknowledgements.values()]
      .filter(current => current.phase === 'bound' && current.response_id === event.response_id)
    for (const acknowledgement of bound) {
      if (acknowledgement.origin_delivered) {
        this.#markAcknowledgementDelivered(acknowledgement)
        continue
      }
      if (event.status === 'completed') {
        this.#markAcknowledgementDelivered(acknowledgement)
      } else if (acknowledgement.binding === 'fallback') {
        acknowledgement.phase = 'pending'
        acknowledgement.response_id = null
        acknowledgement.binding = null
        if (event.status === 'failed') {
          // One retry after a failure, and only one: a provider failing the same fact repeatedly would
          // otherwise have the host queue it forever.
          if (acknowledgement.failed_retry_consumed) continue
          acknowledgement.failed_retry_consumed = true
        }
        this.#queueSemanticAcknowledgement(acknowledgement)
      } else if (acknowledgement.binding === 'continuation') {
        acknowledgement.phase = 'pending'
        acknowledgement.response_id = null
        acknowledgement.binding = null
      }
    }
  }

  #markAcknowledgementDelivered(acknowledgement: SemanticAcknowledgement): void {
    acknowledgement.phase = 'delivered'
    acknowledgement.response_id = null
    acknowledgement.binding = null
  }

  /** Bind the one acknowledgement that asked for a turn to the response that will speak it. */
  #bindRequestedSemanticAcknowledgement(responseId: string): void {
    for (const acknowledgement of this.#semanticAcknowledgements.values()) {
      if (acknowledgement.phase !== 'requested') continue
      acknowledgement.phase = 'bound'
      acknowledgement.response_id = responseId
      acknowledgement.binding = 'fallback'
      return
    }
  }

  /**
   * Replace the provider session, and reconcile everything that referred to the old one.
   *
   * Ported from `_reconnect_provider_session`. The whole method runs under `#reconnectLock`, and the
   * two things that look like implementation detail are both load-bearing:
   *
   * The source epoch is armed *before* the await, so a Guard already waiting on the session's
   * response-request lock can see that the provider identity advanced even if it runs before this
   * resumes. Arming it after would let that Guard act against a session that no longer exists.
   *
   * The tail calls the private `#deliveryPass` rather than the public `flushHostItems`. The public
   * wrapper turns an uncertain delivery into a reconnect, and reconnecting while already holding the
   * lock would deadlock. Confirmation uncertainty is meant to escape to the caller here.
   *
   * Returns false when the epoch moved while waiting for the lock: someone else already replaced the
   * session, and doing it again would discard a *live* one.
   */
  async #reconnectProviderSession(
    options: {readonly expectedEpoch?: number} = {},
  ): Promise<boolean> {
    const requestedEpoch = options.expectedEpoch ?? this.session.sessionEpoch
    return this.#reconnectLock.run(async () => {
      if (this.session.sessionEpoch !== requestedEpoch) return false
      const oldEpoch = this.session.sessionEpoch
      this.#invalidateProjectConfirmation('provider_replaced')
      this.#guardPreemption = null
      this.#providerReconnectSourceEpoch = oldEpoch
      await this.session.reconnect({tools: structuredClone(this.#providerSchemas)})
      // Only if nothing cleared it while we were awaiting. A user who started speaking during the
      // reconnect has already activated the new session, so demanding an activation would be wrong.
      if (this.#providerReconnectSourceEpoch === oldEpoch) {
        this.#providerEpochNeedingActivation = this.session.sessionEpoch
        this.#providerReconnectSourceEpoch = null
      }
      const retryOwner = this.#urgentHostResponseOwner

      // Every origin binding named items in a session that is gone. Keeping any of it would let a
      // tool call cite evidence the new provider has never seen.
      this.#awaitingUserOrigin = false
      this.#userOriginPreexistingResponseId = null
      this.#unboundUserOriginItems.length = 0
      this.#responseUserOriginItems.clear()
      this.#userOriginRefs.clear()
      this.#originDeferredToolCalls.length = 0

      this.#releaseUrgentHostResponseForEpoch(oldEpoch)
      // An urgent item that was injected but never got a response is the one case worth retrying: it
      // was delivered into a session that died before speaking it, so the user heard nothing. One that
      // *did* get a response was taken up by the provider, and re-queueing would say it twice.
      if (retryOwner?.session_epoch === oldEpoch && retryOwner.response_id === null) {
        this.#requeueHostItem(retryOwner.queued)
      }
      this.#clearCaptions()
      this.#audioStarted.clear()
      this.#reconcileToolStateAfterReconnect(oldEpoch)
      this.#reopenFailedSemanticAcknowledgements()
      this.#reconcileSemanticAcknowledgementsAfterReconnect()
      await this.driveContinuations()
      await this.#deliveryPass()
      return true
    })
  }

  /**
   * Settle every tool call that belonged to the dead epoch.
   *
   * The dead epoch cannot receive a continuation, so nothing in it will ever be spoken about in its own
   * turn. Each call therefore gets a final disposition here rather than waiting for a terminal that
   * cannot arrive -- and the ones that actually ran get a background acknowledgement, because the work
   * happened and the user has not heard about it.
   */
  #reconcileToolStateAfterReconnect(oldEpoch: number): void {
    for (const callKeyValue of this.#pendingSync.values()) {
      if (parseCallKey(callKeyValue).sessionEpoch !== oldEpoch) continue
      const state = this.#toolCallState(callKeyValue)
      // R105: the dead epoch cannot receive a continuation; the result, when it arrives, becomes a
      // host fact in the new epoch.
      if (state?.sync === 'pending') state.sync = 'announce'
    }
    for (const [batchKey, batch] of this.#continuationBatches.entries()) {
      if (parseCallKey(batchKey).sessionEpoch !== oldEpoch) continue
      for (const key of batch.call_keys) {
        const state = this.#toolCallState(key)
        if (state === undefined) continue
        // Captured before the disposition is written, because that is what decides whether anything
        // actually ran -- and only work that ran is worth telling the user about.
        const needsSemanticAcknowledgement = state.dispatch === 'dispatched'
          && state.acceptance.accepted
        if (state.continuation !== 'terminal') {
          state.continuation = 'abandoned'
          state.continuation_response_id = null
          if (state.sync === 'resolved') {
            // CP3: resolved but its continuation never became terminal. Re-delivered as one announce
            // host fact in the new epoch, matching the at-least-once posture of the acknowledgements.
            this.#announceResolvedSyncState(state)
          }
        }
        if (state.final_disposition === null) {
          if (state.dispatch === 'not_dispatched') {
            state.final_disposition = 'superseded'
          } else if (!state.acceptance.accepted) {
            state.final_disposition = 'refused'
          } else {
            state.final_disposition = 'abandoned'
          }
        }
        if (needsSemanticAcknowledgement) this.#queueBackgroundAcknowledgement(state)
      }
      // A batch already terminal was spoken before the session died, so it keeps that.
      if (batch.phase !== 'terminal') {
        batch.phase = 'abandoned'
        batch.continuation_response_id = null
      }
    }
    const surviving = this.#continuationFifo
      .filter(key => parseCallKey(key).sessionEpoch !== oldEpoch)
    this.#continuationFifo.length = 0
    this.#continuationFifo.push(...surviving)
  }

  /**
   * Re-queue acknowledgements whose turn died with the old session.
   *
   * One that was requested or bound to a continuation was never actually spoken -- the turn carrying it
   * belonged to a provider session that is gone -- so it goes back to pending and is queued again. A
   * `delivered` one stays delivered: the user heard it, and repeating it would be worse than silence.
   */
  #reconcileSemanticAcknowledgementsAfterReconnect(): void {
    for (const acknowledgement of this.#semanticAcknowledgements.values()) {
      if (
        acknowledgement.phase === 'requested'
        || (acknowledgement.phase === 'bound' && acknowledgement.binding === 'continuation')
      ) {
        acknowledgement.phase = 'pending'
        acknowledgement.response_id = null
        acknowledgement.binding = null
      }
      if (acknowledgement.phase === 'pending' || acknowledgement.phase === 'queued') {
        this.#queueSemanticAcknowledgement(acknowledgement)
      }
    }
  }

  /**
   * Give a once-failed acknowledgement another chance after a reconnect.
   *
   * Its single retry was spent on a session that then died, which is not the same as having been tried
   * and refused -- so the new session gets to attempt it once.
   */
  #reopenFailedSemanticAcknowledgements(): void {
    for (const acknowledgement of this.#semanticAcknowledgements.values()) {
      if (!acknowledgement.failed_retry_consumed) continue
      if (acknowledgement.phase === 'pending') {
        this.#queueSemanticAcknowledgement(acknowledgement)
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Family O: projecting reducer events back to the provider.
  //
  // The runtime decides what happened; this decides what the model gets told about it, and the answer
  // is usually "less than everything". A progress event that repeats the last summary, a suggestion
  // handoff nobody selected, a monitor stop whose tool continuation already said it -- each is real in
  // Memory and deliberately silent here, because the failure mode of a voice agent is not missing a
  // fact, it is narrating its own bookkeeping.
  //
  // Two revalidations look redundant and are not. Observers receive events *unconditionally*,
  // including ones the runtime's own validator dropped from Memory (CP1), and they receive a clone
  // rather than the applied object -- so shape and delegate identity are both re-checked here.
  // ---------------------------------------------------------------------------------------------

  /**
   * Project one reducer event to the provider, or decide it says nothing worth saying.
   *
   * Ordering matters at the top: the R105 sync resolution is a delegate-keyed lookup that has to run
   * before the channel projections, because a synchronous result belongs to the tool call that is
   * waiting on it rather than to the narration stream.
   */
  projectRuntimeEvent(event: EventRecord): void {
    if (event.kind === 'handoff' && this.#resolveSyncResult(event)) return
    if (event.kind === 'deadline') {
      if (this.#expireSyncResult(event)) return
      this.#projectDeadline(event)
      return
    }
    if (event.kind !== 'progress' && event.kind !== 'observation' && event.kind !== 'handoff') {
      return
    }
    const manifest = this.#runtime.executors.get(event.payload.channel)?.manifest
    if (manifest === undefined) return

    if (event.payload.channel === 'codex' && this.#telemetry !== undefined) {
      if (event.kind === 'progress') {
        this.#telemetry.record('codex.progress', {
          delegate_id: event.payload.delegate_id,
          phase: event.payload.phase,
          internal_activity: event.payload.internal_activity,
        })
      } else if (event.kind === 'handoff') {
        this.#telemetry.record('codex.handoff', {
          delegate_id: event.payload.delegate_id,
          outcome: event.payload.outcome,
        })
      }
    }

    if (event.kind === 'observation') {
      this.#projectObservation(event, manifest)
    } else if (event.kind === 'progress') {
      this.#projectProgress(event, manifest)
    } else {
      this.#projectHandoff(event, manifest)
    }
  }

  /** Resolve a synchronous tool result before ordinary channel projection can consume it. */
  #resolveSyncResult(event: Extract<EventRecord, {kind: 'handoff'}>): boolean {
    const callKeyValue = this.#pendingSync.get(event.payload.delegate_id)
    if (callKeyValue === undefined) {
      if (!this.#lateSync.has(event.payload.delegate_id)) return false
      this.#lateSync.delete(event.payload.delegate_id)
      this.#queueSyncAnnouncement(event)
      return true
    }
    this.#pendingSync.delete(event.payload.delegate_id)
    const state = this.#toolCallState(callKeyValue)
    if (state === undefined) {
      this.#queueSyncAnnouncement(event)
      return true
    }
    if (state.sync === 'pending') {
      this.#confirmSyncOutput(state, this.#syncResultContent(event))
      state.sync = 'resolved'
      this.#deliveryReady.set()
    } else if (state.sync === 'announce') {
      this.#queueSyncAnnouncement(event)
    }
    return true
  }

  /** Resolve a synchronous timeout without narrating it; one real late handoff may still be announced. */
  #expireSyncResult(event: Extract<EventRecord, {kind: 'deadline'}>): boolean {
    const callKeyValue = this.#pendingSync.get(event.payload.delegate_id)
    if (callKeyValue === undefined) return false
    this.#pendingSync.delete(event.payload.delegate_id)
    const state = this.#toolCallState(callKeyValue)
    if (state !== undefined) {
      if (state.sync === 'pending') {
        this.#confirmSyncOutput(state, '{"state":"timeout"}')
        this.#deliveryReady.set()
      } else if (state.sync !== 'announce') {
        return true
      }
      state.sync = 'announce'
    }
    this.#lateSync.delete(event.payload.delegate_id)
    this.#lateSync.set(event.payload.delegate_id, callKeyValue)
    while (this.#lateSync.size > MAX_LATE_SYNC_RESULTS) {
      const oldest = this.#lateSync.keys().next()
      if (oldest.done) break
      this.#lateSync.delete(oldest.value)
    }
    return true
  }

  #confirmSyncOutput(state: ToolCallState, content: string): void {
    const previous = state.acceptance.host_item
    if (previous.call_id === null) return
    const hostItem: HostContextItem = {...previous, content}
    state.acceptance = {
      ...state.acceptance,
      host_item: hostItem,
      response_intent: {
        kind: 'tool_result', item: hostItem, task_summary: null, origin_spoken: false,
      },
    }
  }

  #queueSyncAnnouncement(event: Extract<EventRecord, {kind: 'handoff'}>): void {
    this.queueHostItem(hostFactIntent({
      kind: 'final',
      host_item_id: this.#idFactory(),
      event_id: `sync:${event.payload.delegate_id}`,
      content: this.#syncResultContent(event),
    }), {priority: this.#executorPriority(event.payload.channel)})
  }

  /** Compact, closed sync result for the model; status remains intact and private refs stay excluded. */
  #syncResultContent(event: Extract<EventRecord, {kind: 'handoff'}>): string {
    const content = event.payload.content
    if (event.payload.channel === 'search' && event.payload.outcome === 'ok') {
      const results = Array.isArray(content.results)
        ? content.results.flatMap(raw => {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
          const title = typeof raw.title === 'string'
            ? [...raw.title].slice(0, SYNC_RESULT_TITLE_CHARS).join('')
            : ''
          const snippet = typeof raw.snippet === 'string'
            ? [...raw.snippet].slice(0, SYNC_RESULT_SNIPPET_CHARS).join('')
            : ''
          let source = ''
          if (typeof raw.canonical_url === 'string') {
            try { source = new URL(raw.canonical_url).hostname } catch { /* invalid source stays empty */ }
          }
          return [{title, snippet, source}]
        })
        : []
      const query = typeof content.query === 'string'
        ? [...content.query].slice(0, 512).join('')
        : null
      let encoded = JSON.stringify({state: 'ok', query, results})
      while ([...encoded].length > MAX_HOST_FACT_CHARS && results.length > 0) {
        const longest = Math.max(...results.map(result => [...result.snippet].length))
        if (longest > 50) {
          for (const result of results) {
            result.snippet = [...result.snippet].slice(0, Math.max(50, Math.floor(longest / 2))).join('')
          }
        } else results.pop()
        encoded = JSON.stringify({state: 'ok', query, results})
      }
      return encoded
    }
    const responseInstruction = content.code === 'confirmation_required'
      ? [
        '该项目操作尚未执行。请用自然口语说明目标操作尚未执行，',
        '并依据 confirmation_prompt 明确询问用户确认或取消；',
        '不得声称已提交、已创建、已切换或已开始任务，也不要朗读 proposal_id。',
      ].join('')
      : null
    const encoded = JSON.stringify({
      state: event.payload.outcome,
      content,
      ...(responseInstruction === null ? {} : {response_instruction: responseInstruction}),
    })
    return [...encoded].length <= MAX_HOST_FACT_CHARS
      ? encoded
      : JSON.stringify({state: event.payload.outcome, error: 'result_too_large'})
  }

  /**
   * A delegate that ran out of time.
   *
   * The state goes to `unknown`, not `failed`: a deadline says nobody knows what happened, and telling
   * the model it failed would be a claim the host cannot support. `sync_result` ops are skipped
   * because their waiting tool call resolves the timeout itself.
   */
  #projectDeadline(event: Extract<EventRecord, {kind: 'deadline'}>): void {
    const delegateId = event.payload.delegate_id
    // This exact event, not "was terminated by a deadline at some point": a second deadline for the
    // same delegate would otherwise announce the same timeout twice.
    if (!this.#runtime.terminatedByDeadline(event.seq, delegateId)) return
    const delegate = this.#runtime.delegateFor(delegateId)
    if (delegate === undefined) return
    const manifest = this.#runtime.executors.get(delegate.executor)?.manifest
    const operation = manifest?.ops.find(candidate => candidate.name === delegate.op)
    if (manifest === undefined || operation === undefined || operation.sync_result === true) return
    const displayName = this.#executorDisplayName(delegate.executor)
    this.session.registerDelegate(delegateId, {
      summary: this.#delegateSummary(delegateId, displayName),
      state: 'unknown',
      channel: delegate.executor,
      progress_summary: null,
      internal_activity: 0,
      elapsed: 0,
    })
    // A settled delegate leaves no dedup residue behind, or a later run of the same delegate id would
    // inherit a summary it never produced.
    this.#lastProgressSummary.delete(delegateId)
    this.#publishCodexState()
    this.queueHostItem(hostFactIntent({
      kind: 'final',
      host_item_id: this.#idFactory(),
      event_id: `deadline:${delegateId}`,
      content: `${displayName} 的委派任务超时，未能确认结果。`,
    }), {priority: manifest.policy.priority})
  }

  /**
   * Something an executor noticed while running.
   *
   * Only a *hit* is worth interrupting for. A heartbeat or a miss registers delegate state and stops
   * there, and an ambient hit is the Surrogate's to arbitrate rather than something to announce.
   */
  #projectObservation(
    event: Extract<EventRecord, {kind: 'observation'}>,
    manifest: ExecutorManifestLike,
  ): void {
    const delegate = this.#observationDelegate(event)
    if (delegate === undefined) return
    const displayName = this.#executorDisplayName(event.payload.channel)
    this.session.registerDelegate(event.payload.delegate_id, {
      summary: this.#delegateSummary(event.payload.delegate_id, displayName),
      state: 'running',
      channel: event.payload.channel,
    })
    this.#publishCodexState()
    if (event.payload.content.hit !== true) return
    if (manifest.policy.suggest === true && delegate.routing_class === 'ambient') return
    const content = [...genericFinalSpeechView(displayName, 'ok', event.payload.content)]
      .slice(0, MAX_HOST_FACT_CHARS)
      .join('')
    this.queueHostItem(hostFactIntent({
      kind: 'final',
      host_item_id: this.#idFactory(),
      event_id: `observation:${event.payload.delegate_id}:${event.seq}`,
      content,
    }), {
      // A monitoring hit outranks routine executor announcements without reaching the preemption band.
      priority: Math.max(manifest.policy.priority, HIT_ALERT_MIN_PRIORITY),
      preemptive: manifest.policy.priority >= PREEMPT_MIN_PRIORITY,
      guardDelegateId: event.payload.channel === 'guard' ? event.payload.delegate_id : null,
    })
  }

  /**
   * Resolve an observation to the exact live executor run it belongs to.
   *
   * All four fields have to match, not just the delegate id: an observation whose channel, op, or
   * origin differs describes a different run, and projecting it would attribute one executor's finding
   * to another's task.
   */
  #observationDelegate(
    event: Extract<EventRecord, {kind: 'observation'}>,
  ): DelegateLike | undefined {
    const delegate = this.#runtime.inFlightDelegate(event.payload.delegate_id)
    if (delegate === undefined) return undefined
    if (
      event.payload.channel !== delegate.executor
      || event.payload.op !== delegate.op
      || event.payload.origin_ref !== delegate.origin_ref
    ) {
      return undefined
    }
    return delegate
  }

  /**
   * How far along a running executor is.
   *
   * The shape is revalidated here even though the runtime already did it, because observers receive
   * events the runtime's validator dropped from Memory (CP1). And the delegate identity is rechecked
   * against the in-flight table, because a progress event for a settled delegate describes a run that
   * is over.
   */
  #projectProgress(
    event: Extract<EventRecord, {kind: 'progress'}>,
    manifest: ExecutorManifestLike,
  ): void {
    const payload = event.payload
    if (
      payload.op === ''
      || !Number.isInteger(payload.internal_activity)
      || !Number.isFinite(payload.elapsed)
      || payload.elapsed < 0
      || (payload.phase === 'started' && payload.internal_activity !== 0)
      || (
        payload.phase === 'working'
        && !(payload.internal_activity >= 1 && payload.internal_activity <= 1_048_576)
      )
    ) {
      return
    }
    const delegate = this.#runtime.inFlightDelegate(payload.delegate_id)
    if (delegate?.executor !== payload.channel || delegate.op !== payload.op) return
    const displayName = this.#executorDisplayName(payload.channel)
    let summary: string | null = payload.summary
    if (!validProgressSummary(summary, payload.phase)) summary = null
    if (summary !== null) {
      // CP2: prepared once at the storage boundary, so the recovery frame the session renders never
      // carries raw markdown either.
      summary = prepareForSpeech(summary, {limit: SPEECH_FINAL_LIMIT}).text || null
    }
    this.session.registerDelegate(payload.delegate_id, {
      summary: this.#delegateSummary(payload.delegate_id, displayName),
      state: 'running',
      channel: payload.channel,
      progress_summary: summary,
      internal_activity: payload.internal_activity,
      elapsed: payload.elapsed,
    })
    this.#publishCodexState()
    if (manifest.policy.progress_via_surrogate === true && payload.phase === 'working') return

    let content: string
    if (payload.phase === 'started') {
      content = `${displayName} 已开始处理这个任务。`
    } else if (summary !== null) {
      // Same-summary skip: state registration already happened, only the host injection is
      // suppressed. A summary-less event keeps the field template and is never deduped this way.
      if (this.#lastProgressSummary.get(payload.delegate_id) === summary) return
      this.#lastProgressSummary.set(payload.delegate_id, summary)
      content = `${displayName} 正在执行：${summary}（已进行${formatSeconds(payload.elapsed)}秒）`
    } else {
      content = `${displayName} 仍在处理这个任务，目前已推进 ${payload.internal_activity} 个步骤。`
    }
    this.queueHostItem(hostFactIntent({
      kind: 'progress',
      host_item_id: this.#idFactory(),
      event_id: `progress:${payload.delegate_id}:${payload.phase}:${payload.internal_activity}`,
      content,
    }), {priority: manifest.policy.priority})
  }

  /**
   * An executor finished.
   *
   * Two silences here are deliberate and were both learned from hearing the agent say too much. An
   * unselected suggestion handoff is a proposal the Surrogate never chose, so announcing it would tell
   * the user about something they were not offered. And a successful monitor stop already has its
   * spoken confirmation in the stop tool's own continuation -- both terminal handoffs stay
   * authoritative in Memory, but projecting either duplicates that acknowledgement, and projecting
   * both produced three lines.
   */
  #projectHandoff(
    event: Extract<EventRecord, {kind: 'handoff'}>,
    manifest: ExecutorManifestLike,
  ): void {
    // Only the delegate *this* handoff claimed. A duplicate, or one for an already-settled delegate,
    // claims nothing and must not be projected against whatever the previous one claimed.
    const claimed = this.#runtime.claimedHandoff(event.seq)
    if (claimed?.executor !== event.payload.channel) return
    const payload = event.payload
    const displayName = this.#executorDisplayName(payload.channel)
    const directSuggestionHandoff = manifest.policy.suggest === true
      && payload.outcome === 'ok'
      && claimed.routing_class === 'user_awaited'
    const suppressUnselectedSuggestion = manifest.policy.suggest === true
      && payload.outcome === 'ok'
      && !directSuggestionHandoff
    this.session.registerDelegate(payload.delegate_id, {
      summary: this.#delegateSummary(payload.delegate_id, displayName),
      state: payload.outcome === 'ok' ? 'completed' : 'failed',
      channel: payload.channel,
    })
    // CP1: a settled delegate leaves no dedup residue behind.
    this.#lastProgressSummary.delete(payload.delegate_id)
    this.#publishCodexState()
    if (suppressUnselectedSuggestion) return

    const successfulMonitorStop = (payload.channel === 'watch' || payload.channel === 'guard')
      && payload.outcome === 'ok'
      && (
        (claimed.op === 'stop' && payload.content.stopped === true)
        || (claimed.op === 'start' && payload.content.state === 'stopped')
      )
    if (successfulMonitorStop) return

    const finalView = payload.channel === 'codex'
      ? finalSpeechView(payload.outcome, payload.content)
      : genericFinalSpeechView(displayName, payload.outcome, payload.content)
    const content = [...finalView].slice(0, MAX_HOST_FACT_CHARS).join('')
    const hit = payload.outcome === 'ok' && payload.content.hit === true
    this.queueHostItem(hostFactIntent({
      kind: 'final',
      host_item_id: this.#idFactory(),
      event_id: `final:${payload.delegate_id}`,
      content,
    }), {
      priority: hit
        ? Math.max(manifest.policy.priority, HIT_ALERT_MIN_PRIORITY)
        : manifest.policy.priority,
      preemptive: manifest.policy.priority >= PREEMPT_MIN_PRIORITY && hit,
      guardDelegateId: payload.channel === 'guard' && hit ? payload.delegate_id : null,
    })
  }

  /** The summary the session already holds for a delegate, or a plain stand-in. */
  #delegateSummary(delegateId: string, displayName: string): string {
    for (const [currentId, record] of this.session.snapshot().active_delegates) {
      if (currentId === delegateId) return record.summary
    }
    return `${displayName} background task`
  }

  /**
   * Consume the provider stream until it ends or the service stops.
   *
   * The epoch filter is the first thing in the loop and it is not redundant with the session's own:
   * `events()` already drops mismatched events, and dropping them again here is what makes a
   * reconnect that happens *while* an event is in flight safe.
   *
   * The outer loop distinguishes three endings. A stopped service or a failed provider returns. An
   * epoch that changed means a reconnect replaced the stream, so it re-subscribes. A stream that
   * ended having yielded nothing is a provider that is simply gone.
   */
  async #receiveLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const streamEpoch = this.session.sessionEpoch
      let received = false
      // The signal goes to the provider: at shutdown the stream is normally parked with nothing to
      // say, and an iterator suspended in `await` cannot be stopped from out here.
      for await (const event of this.#provider.events(signal)) {
        if (signal.aborted) return
        if (event.session_epoch !== this.session.sessionEpoch) continue
        received = true
        try {
          await this.handleEvent(event)
        } catch (cause) {
          if (cause instanceof ItemDeliveryUncertainError) {
            await this.#recoverUncertainDelivery(cause)
          } else if (cause instanceof RealtimeDeliveryError) {
            this.#reportDeliveryFailure(cause)
          } else {
            throw cause
          }
        }
        if (this.#stop.signal.aborted) return
      }
      if (this.#stop.signal.aborted || this.#providerFailed) return
      if (this.session.sessionEpoch !== streamEpoch) continue
      if (!received) return
    }
  }

  /**
   * Deliver queued host items whenever something signals there may be work.
   *
   * A delivery failure is reported and the loop continues: one item the provider refused must not
   * take down the loop that would deliver the next one.
   */
  async #deliveryLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      // Raced against the signal, not just checked after: the wait is where this loop spends almost
      // all of its time, and a latch nobody sets again would hold it past shutdown.
      await this.#deliveryReady.wait(signal)
      this.#deliveryReady.clear()
      if (signal.aborted) return
      try {
        await this.flushHostItems()
        // R105: a sync resolution may have made a held batch ready. The drive is reentrancy-safe --
        // it early-returns while a batch is requested or bound.
        await this.driveContinuations()
      } catch (cause) {
        if (cause instanceof RealtimeDeliveryError) {
          this.#reportDeliveryFailure(cause)
        } else {
          throw cause
        }
      }
    }
  }

  /**
   * Ingest one provider event.
   *
   * The shape is a sequence of `if isinstance` blocks in the oracle and stays one here, deliberately:
   * a single event can be several things at once to this layer -- a `ResponseStarted` binds a user
   * origin *and* a semantic acknowledgement *and* a continuation -- so a switch that ran one arm per
   * event would have to duplicate the shared tail.
   *
   * Two events never reach the session at all. A cancel rejection is Guard's to arbitrate, and a
   * provider error is about the transport rather than the conversation.
   *
   * The tail is the part worth reading twice: after everything an event implies has been recorded,
   * continuations are driven (only if the session accepted it -- a rejected event changed nothing to
   * speak about) and then a delivery pass runs unconditionally, because the floor may have opened even
   * for an event the session refused.
   */
  async handleEvent(event: RealtimeProviderEvent): Promise<void> {
    if (event.kind === 'response_cancel_rejected') {
      // The provider kept speaking through a preemption. Guard's to arbitrate, and it does not reach
      // the session at all: this is about the transport, not the conversation.
      await this.#handleGuardCancelRejected(event)
      return
    }
    if (event.kind === 'provider_error') {
      this.#onDiagnostic(
        `[realtime-diagnostic] provider_error code=${event.code} recoverable=${event.recoverable}`,
      )
      if (event.recoverable) {
        await this.#reconnectProviderSession({expectedEpoch: this.session.sessionEpoch})
        this.#clearCaptions()
      } else {
        this.#providerFailed = true
        this.#urgentHostResponseOwner = null
        this.#guardPreemption = null
        this.#stop.abort()
      }
      return
    }

    if (this.#telemetry !== undefined) {
      if (event.kind === 'response_started') {
        this.#telemetry.record('provider.response_started', {response_id: event.response_id})
      } else if (event.kind === 'response_audio_delta') {
        // First delta only: the metric is time-to-first-audio, and recording every delta would make
        // it a throughput counter instead.
        if (!this.#audioStarted.has(event.response_id)) {
          this.#audioStarted.add(event.response_id)
          this.#telemetry.record('provider.first_audio_delta', {response_id: event.response_id})
        }
      } else if (event.kind === 'response_terminal') {
        this.#audioStarted.delete(event.response_id)
      }
    }

    // Captured before `accept`, because a terminal is what *removes* the owner's response and the
    // release below needs to know which owner this terminal belonged to.
    const terminalOwner = event.kind === 'response_terminal'
      ? this.#urgentOwnerForResponse(event.session_epoch, event.response_id)
      : null

    // A tool call in a turn that is meant to be waiting for a confirmation is refused before the
    // session sees it: letting it through would have the model acting inside the very turn whose answer
    // it is supposed to be waiting for.
    const isConfirmationDecision = event.kind === 'tool_call_ready'
      && event.name === PROJECT_CONFIRMATION_TOOL
    const blockedConfirmationTool = event.kind === 'tool_call_ready'
      && this.#blocksProjectConfirmationTool(event)
      && !isConfirmationDecision
    const accepted = blockedConfirmationTool ? false : await this.session.accept(event)

    if (
      event.kind === 'response_started'
      && event.session_epoch === this.session.sessionEpoch
      && this.#projectConfirmationBlocking
    ) {
      // A fenced pre-start response is the stale question the user interrupted, not the response to
      // their answer. It spends the one-shot fence but must not bind or release the reserved item.
      if (accepted) {
        this.#projectConfirmationResponses.add(callKey(event.session_epoch, event.response_id))
        if (!this.#responseUserOriginItems.has(callKey(event.session_epoch, event.response_id))) {
          this.#bindResponseUserOrigin(event.session_epoch, event.response_id)
        }
      }
      // The armed fence has been spent by this response, so it no longer holds the block open.
      this.#projectConfirmationFencePending = false
      this.#projectConfirmationBlocking = this.#projectConfirmationItems.size > 0
        || this.#projectConfirmationClosingItems.size > 0
    }
    if (event.kind === 'response_started' || event.kind === 'response_audio_delta') {
      const preemption = this.#guardPreemption
      // A turn that was still starting when the alert arrived has only now revealed its id, so the
      // preemption learns which response it is cancelling here rather than at arbitration time.
      if (
        preemption !== null
        && preemption.session_epoch === event.session_epoch
        && preemption.old_response_id === null
        && this.session.activeProviderResponseId === event.response_id
        && this.session.providerTurnPhase(event.response_id) === 'cancel_requested'
        && this.session.providerTurnWasFenced(event.response_id)
      ) {
        this.#guardPreemption = {...preemption, old_response_id: event.response_id}
      }
      this.#recordGuardCancelSent(event.response_id)
    }
    // Unconditional, and before the accepted-only work: a fence receipt is destructive to read, so it
    // has to be consumed on every event or a later one would see a stale interruption.
    this.#retireFencedPrestartUrgent()
    if (accepted && (event.kind === 'response_started' || event.kind === 'response_audio_delta')) {
      this.#bindUrgentHostResponse(event)
      this.#finishGuardFirstAudio(event)
    }

    if (event.kind === 'response_started' && accepted) {
      // Only for a response with no events yet: one that already has them has been bound, and
      // rebinding would take a second user turn for the same response.
      if (this.session.responseEventIds(event.response_id).length === 0) {
        this.#bindResponseUserOrigin(event.session_epoch, event.response_id)
      }
      this.#bindRequestedSemanticAcknowledgement(event.response_id)
      this.#bindContinuation(event.response_id)
    }

    if (this.#onCaption !== undefined) {
      const caption = this.session.captionFor(
        event,
        event.kind === 'user_transcript_final' ? {accepted} : undefined,
      )
      if (caption !== null) this.#onCaption(caption)
    }

    if (event.kind === 'user_speech_started' && accepted) {
      if (this.#providerEpochNeedingActivation === event.session_epoch) {
        this.#providerEpochNeedingActivation = null
      }
      this.#providerReconnectSourceEpoch = null
      const preemption = this.#guardPreemption
      if (preemption !== null) {
        // The user speaking is the authority the preemption was borrowing. A permit not yet spent is
        // now disallowed; one already spent means a reconnect is in flight and has to be abandoned.
        this.#guardPreemption = {
          ...preemption,
          reconnect_disallowed: !preemption.reconnect_permit_consumed,
          reconnect_aborted: preemption.reconnect_permit_consumed,
        }
      }
      // Qwen may finish its function call before emitting this turn's transcript final. Do not let
      // that call bind to provider-authored placeholder text or the previous user turn.
      this.#awaitingUserOrigin = true
      this.#userOriginPreexistingResponseId = this.session.activeProviderResponseId
      if (event.provider_item_id !== null) {
        this.#rememberUnboundUserOrigin(event.provider_item_id)
      }
      this.#reserveProjectConfirmation(event)
    }

    if (event.kind === 'response_terminal' && accepted) {
      this.#recordGuardCancelTerminal(event)
      const generation = this.session.currentGeneration
      if (
        generation !== null
        && generation.session_epoch === event.session_epoch
        && generation.response_id === event.response_id
      ) {
        this.#onProviderTerminal(generation)
      }
      this.#finishSemanticAcknowledgement(event)
      this.#finishContinuation(event)
      this.#finishOrigin(event.response_id)
      const itemId = this.#responseUserOriginItems.get(
        callKey(event.session_epoch, event.response_id),
      )
      if (
        itemId !== undefined
        && this.#isProjectConfirmationItem(event.session_epoch, itemId)
      ) {
        const controller = this.#projectConfirmation
        const released = controller?.releaseUndecided({
          epoch: event.session_epoch,
          itemId,
        }) === true
        if (
          released
          && controller?.pending === true
          && !this.session.responseHasSpoken(event.response_id)
        ) {
          this.#queueProjectConfirmationRetryFact()
        }
        this.#endProjectConfirmationItem(event.session_epoch, itemId)
      }
      // Released only when the terminal is *not* the current generation: if it is, playback is still
      // running and the owner is what keeps the alert's audio attributable.
      if (
        generation?.session_epoch !== event.session_epoch
        || generation.response_id !== event.response_id
      ) {
        this.#releaseUrgentHostResponse(terminalOwner)
      }
      this.#markGuardReplacementTerminal(terminalOwner)
    }

    if (event.kind === 'user_transcript_final') {
      if (accepted) {
        if (this.#providerEpochNeedingActivation === event.session_epoch) {
          this.#providerEpochNeedingActivation = null
        }
        this.#providerReconnectSourceEpoch = null
        const originRef = await this.#bridge.acceptUserTranscript(event.text)
        this.#rememberUserOriginRef(event.item_id, originRef)
        this.#awaitingUserOrigin = this.#unboundUserOriginItems.length > 0
        if (!this.#awaitingUserOrigin) this.#userOriginPreexistingResponseId = null
        if (
          this.#isProjectConfirmationItem(event.session_epoch, event.item_id)
          && this.#projectConfirmation?.pending !== true
        ) {
          await this.#closeConfirmationDeferredCalls(event.item_id)
        } else {
          await this.#releaseDeferredOriginCalls(event.item_id, originRef)
        }
      }
    } else if (event.kind === 'user_transcript_failed') {
      if (accepted) {
        // The transcript will never arrive, so anything waiting on it is waiting forever. Released
        // with a null ref: the calls still need an answer, and the bridge refuses them for want of
        // evidence rather than this layer dropping them silently.
        const index = this.#unboundUserOriginItems.indexOf(event.item_id)
        if (index !== -1) this.#unboundUserOriginItems.splice(index, 1)
        for (const [key, itemId] of [...this.#responseUserOriginItems.entries()]) {
          if (itemId === event.item_id) this.#responseUserOriginItems.delete(key)
        }
        this.#awaitingUserOrigin = this.#unboundUserOriginItems.length > 0
        if (!this.#awaitingUserOrigin) this.#userOriginPreexistingResponseId = null
        if (this.#isProjectConfirmationItem(event.session_epoch, event.item_id)) {
          await this.#failProjectConfirmation(event.session_epoch, event.item_id)
        } else {
          await this.#releaseDeferredOriginCalls(event.item_id, null)
        }
      }
    } else if (event.kind === 'tool_call_ready') {
      if (!accepted) {
        // A refused confirmation tool still owes the provider a terminal result, or the protocol stalls
        // waiting for one that will never come.
        if (blockedConfirmationTool) await this.#closeProjectConfirmationTool(event)
        return
      }
      await this.#routeToolCall(event)
    }
    if (event.kind === 'response_terminal') {
      this.#projectConfirmationResponses.delete(callKey(event.session_epoch, event.response_id))
    }

    if (accepted) await this.driveContinuations()
    await this.#deliveryPass()
  }

  /**
   * Decide whether a tool call can be handled now, or has to wait for its evidence.
   *
   * Three cases, in the order the oracle checks them. If the response already has a bound user item,
   * the call has its evidence -- unless the transcript for that item has not landed, in which case it
   * waits. If no item is bound but a user turn is in flight, the call may belong to *that* turn, and
   * the question becomes whether the response it names is the one that turn will answer. If nothing is
   * pending at all, the call has whatever evidence it is going to get.
   *
   * The deferral queue is bounded. Full means the provider is producing calls faster than transcripts
   * arrive, and no amount of waiting will fix it -- reconnecting is the way back to a session whose
   * state can be reasoned about.
   */
  async #routeToolCall(event: ToolCallReady): Promise<void> {
    const activeResponseId = this.session.activeProviderResponseId
    const observedResponseId = event.response_id ?? activeResponseId
    const originItemId = observedResponseId === null
      ? undefined
      : this.#responseUserOriginItems.get(callKey(event.session_epoch, observedResponseId))

    if (originItemId !== undefined) {
      const originRef = this.#userOriginRefs.get(originItemId)
      if (originRef !== undefined) {
        await this.#handleBoundToolCall(event, {
          observedProviderResponseId: observedResponseId,
          originItemId,
          originRef,
        })
      } else if (this.#originDeferredToolCalls.length >= MAX_PENDING_TOOL_REFUSALS) {
        await this.#reconnectProviderSession({expectedEpoch: this.session.sessionEpoch})
      } else {
        this.#originDeferredToolCalls.push({
          event,
          response_id: observedResponseId!,
          user_item_id: originItemId,
        })
      }
      return
    }

    if (event.name === PROJECT_CONFIRMATION_TOOL) {
      await this.#handleProjectConfirmationDecision(event, {
        observedProviderResponseId: observedResponseId,
        originItemId: null,
        originRef: null,
      })
      return
    }

    if (this.#awaitingUserOrigin) {
      // Whether the response this call names is the one the in-flight user turn will answer. If it is
      // not -- a different response, a finished one, or one already fenced -- the call is not waiting
      // on that turn and holding it back would delay it for evidence it was never going to get.
      const originIsActive = observedResponseId !== null
        && activeResponseId === observedResponseId
        && this.session.providerTurnPhase(observedResponseId) === 'active'
        && !this.session.providerTurnWasFenced(observedResponseId)
      if (observedResponseId === this.#userOriginPreexistingResponseId) {
        // The response was already running when the user started speaking, so it cannot be answering
        // them: handle it now with whatever evidence it has.
        await this.#handleToolCall(event)
      } else if (!originIsActive) {
        await this.#handleToolCall(event)
      } else if (this.#originDeferredToolCalls.length >= MAX_PENDING_TOOL_REFUSALS) {
        await this.#reconnectProviderSession({expectedEpoch: this.session.sessionEpoch})
      } else {
        // Non-null by construction: `originIsActive` above required it.
        this.#originDeferredToolCalls.push({
          event,
          response_id: observedResponseId,
          user_item_id: null,
        })
      }
      return
    }

    await this.#handleToolCall(event)
  }

  /**
   * Wrap a loop so its failure stops the service instead of vanishing.
   *
   * An unobserved rejection in one of three long-lived loops is the worst outcome available: the
   * service would look alive while no longer consuming its provider. A loop that ends *at all*
   * without the service being asked to stop is treated as a failure for the same reason.
   */
  async #guardTask(task: Promise<void>, run: AbortController): Promise<void> {
    try {
      await task
      if (!run.signal.aborted) this.#taskFailed(run)
    } catch (cause) {
      this.#onDiagnostic(`[realtime-diagnostic] task_failure type=${diagnosticName(cause)}`)
      this.#taskFailed(run)
    }
  }

  /**
   * Stop the service because one of its loops ended when it should not have.
   *
   * Scoped to the run that started the task, not to whatever run is current. A task abandoned by an
   * earlier `close` can still resolve later, and without this check it would read the *replacement*
   * controller, find it un-aborted, and take down a service that had already been restarted.
   */
  #taskFailed(run: AbortController): void {
    if (run !== this.#stop) {
      // From a run that is already over. Its outcome cannot bear on the current one.
      this.#onDiagnostic('[realtime-diagnostic] task_failure_from_previous_run')
      return
    }
    this.#providerFailed = true
    this.#urgentHostResponseOwner = null
    this.#guardPreemption = null
    this.#stop.abort()
    this.#deliveryReady.set()
  }

  #reportDeliveryFailure(failure: RealtimeDeliveryError): void {
    this.#onDiagnostic(`[realtime-diagnostic] delivery_failure type=${diagnosticName(failure)}`)
  }


  // ---------------------------------------------------------------------------------------------
  // Family H: binding a tool call to the user turn that justifies it.
  //
  // A tool proposal needs evidence, and the evidence is the user transcript of the turn the model was
  // responding to. The provider does not hand those over together -- Qwen can finish a function call
  // before emitting the turn's transcript final -- so the binding is built here from two streams that
  // arrive out of order. Getting it wrong does not fail loudly; it attaches a proposal to the
  // *previous* user turn, which is precisely the kind of citation the origin check exists to stop.
  // ---------------------------------------------------------------------------------------------

  /**
   * Remember a user item whose transcript has not arrived, so a later response can claim it.
   *
   * Three ways an item is already accounted for, and all three have to be refused. Still waiting is
   * the obvious one. Already having a transcript means the item is *spent* -- a replayed
   * `user_speech_started` would otherwise put it back in the queue and let a future response bind to
   * a turn the user has moved past, admitting a tool call on stale evidence. And already bound to a
   * response is the same problem one step later.
   *
   * The bound is the refusal budget, not the tool-call budget: these are items waiting on a
   * transcript, and a provider that has produced thirty-two of them without delivering one is not
   * going to be fixed by remembering more.
   */
  #rememberUnboundUserOrigin(itemId: string): void {
    if (this.#unboundUserOriginItems.includes(itemId)) return
    if (this.#userOriginRefs.has(itemId)) return
    for (const bound of this.#responseUserOriginItems.values()) {
      if (bound === itemId) return
    }
    this.#unboundUserOriginItems.push(itemId)
    while (this.#unboundUserOriginItems.length > MAX_PENDING_TOOL_REFUSALS) {
      this.#unboundUserOriginItems.shift()
    }
  }

  /**
   * Claim the oldest unbound user item for this response.
   *
   * Oldest first, and only once per response: responses and user turns pair up in order, and a
   * response that grabbed a newer item would leave the older one to be claimed by a later response
   * that did not cause it.
   */
  #bindResponseUserOrigin(epoch: number, responseId: string): boolean {
    if (epoch !== this.session.sessionEpoch) return false
    if (this.#unboundUserOriginItems.length === 0) return false
    const key = callKey(epoch, responseId)
    if (this.#responseUserOriginItems.has(key)) return false
    const itemId = this.#unboundUserOriginItems.shift()
    if (itemId === undefined) return false
    this.#responseUserOriginItems.set(key, itemId)
    this.#awaitingUserOrigin = this.#unboundUserOriginItems.length > 0
    if (!this.#awaitingUserOrigin) this.#userOriginPreexistingResponseId = null
    while (this.#responseUserOriginItems.size > MAX_TRACKED_TOOL_CALLS) {
      const oldest = this.#responseUserOriginItems.keys().next()
      if (oldest.done === true) break
      this.#responseUserOriginItems.delete(oldest.value)
    }
    return true
  }

  /** Record the memory ref a transcript produced, LRU by touch. */
  #rememberUserOriginRef(itemId: string, originRef: string): void {
    this.#userOriginRefs.delete(itemId)
    this.#userOriginRefs.set(itemId, originRef)
    while (this.#userOriginRefs.size > MAX_TRACKED_TOOL_CALLS) {
      const oldest = this.#userOriginRefs.keys().next()
      if (oldest.done === true) break
      this.#userOriginRefs.delete(oldest.value)
    }
  }

  /**
   * Run the tool calls that were waiting for this transcript.
   *
   * Two kinds of waiter. One names the user item it needs, and is released when that item arrives.
   * The other could not be keyed at all -- it arrived before any item was known -- and those are
   * released as a batch, all from the same response, but only if no keyed waiter matched: a keyed
   * match means the transcript belongs to a specific call, and releasing the unkeyed batch alongside
   * it would hand them evidence that is not theirs.
   *
   * The epoch is re-read each iteration. Handling one call can reconnect, and every remaining call
   * belongs to a session that no longer exists.
   */
  async #releaseDeferredOriginCalls(itemId: string, originRef: string | null): Promise<void> {
    const releaseEpoch = this.session.sessionEpoch
    const deferred = [...this.#originDeferredToolCalls]
    this.#originDeferredToolCalls.length = 0
    const hasKeyedMatch = deferred.some(entry => entry.user_item_id === itemId)
    const unkeyedResponseId = hasKeyedMatch
      ? null
      : deferred.find(entry => entry.user_item_id === null)?.response_id ?? null
    for (const entry of deferred) {
      if (this.session.sessionEpoch !== releaseEpoch) return
      const matchesKeyed = entry.user_item_id === itemId
      const matchesUnkeyedBatch = entry.user_item_id === null
        && entry.response_id === unkeyedResponseId
      if (!matchesKeyed && !matchesUnkeyedBatch) {
        this.#originDeferredToolCalls.push(entry)
        continue
      }
      await this.#handleBoundToolCall(entry.event, {
        observedProviderResponseId: entry.response_id,
        originItemId: entry.user_item_id,
        originRef,
      })
    }
  }

  async #handleBoundToolCall(event: ToolCallReady, origin: BoundToolOrigin): Promise<void> {
    if (event.name === PROJECT_CONFIRMATION_TOOL) {
      await this.#handleProjectConfirmationDecision(event, origin)
      return
    }
    await this.#handleToolCall(event, {
      observedProviderResponseId: origin.observedProviderResponseId,
      originRef: origin.originRef,
    })
  }

  /** Where a batch's originating response ended up, collapsed to the four states a batch tracks. */
  #originStatus(responseId: string): ContinuationBatch['origin_status'] {
    const phase = this.session.providerTurnPhase(responseId)
    // `cancel_requested` is still active: the cancel has been asked for, not observed, and treating
    // it as cancelled would abandon a batch whose response may yet complete normally.
    if (phase === 'active' || phase === 'cancel_requested') return 'active'
    if (phase === 'failed') return 'failed'
    if (phase === 'cancelled' || this.session.providerTurnWasFenced(responseId)) return 'cancelled'
    return 'completed'
  }

  // ---------------------------------------------------------------------------------------------
  // Family J: admitting one tool call.
  // ---------------------------------------------------------------------------------------------

  #toolCallState(key: string): ToolCallState | undefined {
    return this.#toolCalls.get(key) ?? this.#overflowToolCalls.get(key)
  }

  /**
   * Admit one tool call, or record why it could not be.
   *
   * The long branch is first-sighting; the short one at the end handles a repeat of a call already
   * known. Three things can stop an admission and they are genuinely different: *superseded* means
   * the turn that proposed it is gone, so running it would act on an intention the user has moved
   * past; *over capacity* means the ledgers are full and admitting more would grow without bound;
   * and a bridge refusal means the proposal itself was not admissible.
   */
  async #handleToolCall(
    event: ToolCallReady,
    options: {
      readonly observedProviderResponseId?: string | null
      readonly originRef?: string | null
    } = {},
  ): Promise<void> {
    const key = callKey(event.session_epoch, event.call_id)
    const existing = this.#toolCallState(key)
    if (existing !== undefined) {
      // A repeat. Touch it so the LRU keeps it, and finish the one piece of work a repeat can carry:
      // a superseded call whose output was never confirmed still owes the provider a result.
      const ledger = this.#toolCalls.has(key) ? this.#toolCalls : this.#overflowToolCalls
      ledger.delete(key)
      ledger.set(key, existing)
      if (
        existing.observation === 'superseded'
        && existing.continuation === 'abandoned'
        && existing.output === 'pending'
      ) {
        await this.#confirmSupersededOutput(existing)
      }
      return
    }

    const observedProviderResponseId = options.observedProviderResponseId ?? null
    const originRef = options.originRef ?? null
    const activeResponseId = this.session.activeProviderResponseId
    // The item id is the last resort: a call with no response at all still needs a batch key, and its
    // own item is the only identifier that is certainly unique.
    const providerResponseId = observedProviderResponseId
      ?? event.response_id
      ?? activeResponseId
      ?? event.item_id
    const originUserInputRevision = this.session.providerTurnUserInputRevision(providerResponseId)
      ?? this.session.userInputRevision
    const originPhase = this.session.providerTurnPhase(providerResponseId)
    const hasProviderOrigin = event.response_id !== null || activeResponseId !== null

    // Two different questions. When the caller already resolved which response this belongs to, the
    // only thing left to ask is whether that response survived. When it did not, the call has to be
    // matched against the provider's current turn first -- and a call naming a response that is not
    // the active one is describing a turn that has already been replaced.
    const superseded = observedProviderResponseId !== null
      ? (
        originPhase === 'cancelled'
        || originPhase === 'failed'
        || this.session.providerTurnWasFenced(providerResponseId)
      )
      : (
        (event.response_id === null && activeResponseId === null)
        || (
          event.response_id !== null
          && activeResponseId !== null
          && activeResponseId !== event.response_id
        )
        || (
          hasProviderOrigin
          && (
            (originPhase !== null && originPhase !== 'active')
            || this.session.providerTurnWasFenced(providerResponseId)
          )
        )
      )

    if (
      this.#toolCalls.size >= MAX_TRACKED_TOOL_CALLS
      || this.#overflowToolCalls.size >= MAX_PENDING_TOOL_REFUSALS
    ) {
      this.#pruneTerminalToolState()
    }
    const callOverCapacity = this.#toolCalls.size >= MAX_TRACKED_TOOL_CALLS
    const binding = this.#tools.bindings.get(event.name)
    // A delegated call will eventually need to be spoken about, so its acknowledgement slot is
    // reserved *before* admission -- admitting work the agent could never mention is worse than
    // refusing it.
    const synchronousDelegateCall = binding?.kind === 'delegate'
      && typeof binding.executor === 'string'
      && typeof binding.op === 'string'
      && requiresSynchronousResult(
        binding.executor,
        binding.op,
        event.arguments,
        binding.sync_result === true,
      )
    const requiresSemanticAcknowledgement = !superseded
      && binding?.kind === 'delegate'
      && !synchronousDelegateCall
    let semanticReserved = false
    if (!callOverCapacity && requiresSemanticAcknowledgement) {
      semanticReserved = this.#reserveSemanticAcknowledgement()
    }
    const overCapacity = callOverCapacity
      || (requiresSemanticAcknowledgement && !semanticReserved)
    if (overCapacity && this.#overflowToolCalls.size >= MAX_PENDING_TOOL_REFUSALS) {
      // Both ledgers full of refusals the provider has not acknowledged. The session is no longer
      // tracking reality, and reconnecting is the only way back to a state that can be reasoned about.
      await this.#reconnectProviderSession({expectedEpoch: this.session.sessionEpoch})
      return
    }

    let acceptance: ToolAcceptance
    if (superseded) {
      acceptance = this.#supersededAcceptance(event)
    } else if (overCapacity) {
      acceptance = this.#overCapacityAcceptance(event)
    } else {
      try {
        acceptance = originRef === null
          ? this.#bridge.acceptToolCall(event)
          : this.#bridge.acceptToolCall(event, {originRef})
      } catch (cause) {
        // The reservation was taken on the assumption the admission would happen. It did not, and a
        // reservation nobody releases is a slot permanently unavailable to every later call.
        if (semanticReserved) this.#semanticAcknowledgementReservations -= 1
        throw cause
      }
    }

    this.#recordToolAdmission({
      logicalName: binding?.logical_name ?? null,
      acceptance,
      superseded,
    })
    const state: ToolCallState = toolCallState({
      acceptance,
      logical_name: binding?.logical_name ?? null,
      provider_response_id: providerResponseId,
      provider_session_epoch: event.session_epoch,
      origin_user_input_revision: originUserInputRevision,
      observation: superseded ? 'superseded' : 'observed',
      dispatch: superseded
        ? 'not_dispatched'
        : overCapacity
          ? 'rejected'
          : acceptance.inline_fulfilled
            ? 'fulfilled'
            : acceptance.accepted
              ? 'dispatched'
              : 'rejected',
    })
    if (acceptance.inline_fulfilled && acceptance.telemetry !== null) {
      this.#telemetry?.record('memory.recall', acceptance.telemetry)
    }
    if (acceptance.sync_result && acceptance.accepted && acceptance.delegate_id !== null) {
      state.sync = 'pending'
      this.#pendingSync.set(acceptance.delegate_id, key)
    }
    if (semanticReserved) {
      try {
        if (
          acceptance.accepted
          && acceptance.delegate_id !== null
          && !acceptance.sync_result
        ) {
          if (this.#semanticAcknowledgement(state) === null) {
            throw new Error('reserved semantic acknowledgement is unavailable')
          }
        }
      } finally {
        this.#semanticAcknowledgementReservations -= 1
      }
    }
    if (overCapacity) {
      this.#overflowToolCalls.set(key, state)
    } else {
      this.#toolCalls.set(key, state)
    }

    const batchKey = callKey(event.session_epoch, providerResponseId)
    let batch = this.#continuationBatches.get(batchKey)
    if (
      superseded
      && batch !== undefined
      && (
        batch.phase === 'requested'
        || batch.phase === 'bound'
        || batch.phase === 'terminal'
        || batch.phase === 'abandoned'
      )
    ) {
      // The batch has already spoken or given up. A superseded latecomer cannot join it, and the only
      // thing left owed is the tool result the provider is still holding a slot for.
      state.continuation = 'abandoned'
      await this.#confirmSupersededOutput(state)
      return
    }
    if (batch === undefined) {
      batch = continuationBatch(providerResponseId)
      this.#continuationBatches.set(batchKey, batch)
      this.#continuationFifo.push(batchKey)
    }
    batch.call_keys.push(key)
    const originStatus = this.#originStatus(providerResponseId)
    if (superseded) {
      batch.origin_status = 'cancelled'
      // A cancel that has been requested but not observed leaves the batch collecting: the response
      // may still deliver more calls, and closing the batch now would strand them.
      if (originPhase !== 'cancel_requested') batch.phase = 'ready'
    } else if (originStatus !== 'active') {
      batch.origin_status = originStatus
      batch.phase = 'ready'
    }

    if (
      acceptance.accepted
      && acceptance.delegate_id !== null
      && acceptance.executor !== null
      && !acceptance.sync_result
    ) {
      const summary = acceptance.response_intent.task_summary
      const display = typeof summary === 'string' && stripLikePython(summary) !== ''
        ? summary
        : `${this.#executorDisplayName(acceptance.executor)} background task`
      this.session.registerDelegate(acceptance.delegate_id, {
        summary: [...stripLikePython(display)].slice(0, MAX_CONTINUATION_TASK_SUMMARY).join(''),
        state: 'running',
        channel: acceptance.executor,
      })
      if (acceptance.executor === 'codex') {
        this.#telemetry?.record('codex.dispatch', {delegate_id: acceptance.delegate_id})
      }
      this.#publishCodexState()
    }
  }

  /**
   * Drop everything that has reached a terminal state.
   *
   * Called when a ledger is about to overflow rather than on a timer: what makes an entry droppable
   * is that nothing can still refer to it, and that is a property of its state, not its age.
   */
  #pruneTerminalToolState(): void {
    for (const ledger of [this.#toolCalls, this.#overflowToolCalls]) {
      for (const [key, state] of [...ledger.entries()]) {
        if (state.final_disposition !== null) ledger.delete(key)
      }
    }
    for (const [key, batch] of [...this.#continuationBatches.entries()]) {
      if (batch.phase === 'terminal' || batch.phase === 'abandoned') {
        this.#continuationBatches.delete(key)
      }
    }
    const surviving = this.#continuationFifo.filter(key => this.#continuationBatches.has(key))
    this.#continuationFifo.length = 0
    this.#continuationFifo.push(...surviving)
  }

  #supersededAcceptance(event: ToolCallReady): ToolAcceptance {
    return this.#refusalAcceptance(event, 'superseded', '{"state":"superseded"}')
  }

  #overCapacityAcceptance(event: ToolCallReady): ToolAcceptance {
    return this.#refusalAcceptance(
      event,
      'over_capacity',
      '{"code":"over_capacity","state":"refused"}',
    )
  }

  /** A refusal the service authors itself, rather than one the bridge produced. */
  #refusalAcceptance(event: ToolCallReady, code: string, content: string): ToolAcceptance {
    const hostItem: HostContextItem = {
      kind: 'tool_output',
      host_item_id: this.#idFactory(),
      event_id: this.#idFactory(),
      call_id: event.call_id,
      content,
    }
    return {
      accepted: false,
      code,
      host_item: hostItem,
      response_intent: {kind: 'tool_result', item: hostItem, task_summary: null, origin_spoken: false},
      delegate_id: null,
      sync_result: false,
      executor: null,
      op: null,
      inline_fulfilled: false,
      telemetry: null,
    }
  }

  #recordToolAdmission(input: {
    readonly logicalName: string | null
    readonly acceptance: ToolAcceptance
    readonly superseded: boolean
  }): void {
    if (this.#telemetry === undefined || input.logicalName === null) return
    const outcome = input.superseded
      ? 'superseded'
      : !input.acceptance.accepted
        ? 'rejected'
        : input.acceptance.inline_fulfilled
          ? 'inline'
          : input.acceptance.sync_result
            ? 'sync'
            : 'delegated'
    this.#telemetry.record('tool.admission', {logical_name: input.logicalName, outcome})
  }

  /** Give the provider the result it is holding a slot for, once. */
  async #confirmSupersededOutput(state: ToolCallState): Promise<void> {
    if (state.output === 'confirmed') return
    await this.session.injectToolOutput(state.acceptance.host_item)
    state.output = 'confirmed'
    state.final_disposition = 'superseded'
  }

  #executorDisplayName(channel: string): string {
    if (channel === 'codex') return 'Codex'
    return this.#runtime.executors.has(channel) ? channel : channel
  }

  /**
   * Tell the renderer whether Codex is working, when that changes.
   *
   * Derived from the session's live delegates rather than counted here: the session is what knows
   * when one finishes, and a separate counter would drift the moment a delegate ended by any route
   * this layer does not see.
   */
  #publishCodexState(): void {
    const next: CodexState = this.session.snapshot().active_delegates
      .some(([, record]) => record.channel === 'codex')
      ? 'running'
      : 'idle'
    if (next === this.#codexState) return
    this.#codexState = next
    try {
      this.#onCodexState(next)
    } catch (cause) {
      // A renderer that cannot accept the state must not stop the service that produced it.
      this.#onDiagnostic(`[realtime-diagnostic] codex_state_observer_failed type=${diagnosticName(cause)}`)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Family N: the acknowledgement a delegated call owes the user.
  // ---------------------------------------------------------------------------------------------

  /**
   * The acknowledgement for one delegated call, creating it if the ledger has room.
   *
   * Returns null rather than evicting something live: an acknowledgement still waiting to be spoken
   * is a promise to the user, and dropping one to make room for another would silently break it. Only
   * already-delivered entries are reclaimed.
   */
  #semanticAcknowledgement(state: ToolCallState): SemanticAcknowledgement | null {
    const summary = state.acceptance.response_intent.task_summary
    const delegateId = state.acceptance.delegate_id
    if (delegateId === null || summary === null) return null
    const eventId = `background:${delegateId}`
    const existing = this.#semanticAcknowledgements.get(eventId)
    if (existing !== undefined) {
      this.#semanticAcknowledgements.delete(eventId)
      this.#semanticAcknowledgements.set(eventId, existing)
      return existing
    }
    while (this.#semanticAcknowledgements.size >= MAX_TRACKED_SEMANTIC_ACKNOWLEDGEMENTS) {
      const deliveredId = [...this.#semanticAcknowledgements.entries()]
        .find(([, current]) => current.phase === 'delivered')?.[0]
      if (deliveredId === undefined) return null
      this.#semanticAcknowledgements.delete(deliveredId)
    }
    const channel = state.acceptance.executor
    if (channel === null) return null
    const created = semanticAcknowledgement({
      event_id: eventId,
      summary: [...summary].slice(0, MAX_CONTINUATION_TASK_SUMMARY).join(''),
      channel,
    })
    created.origin_session_epoch = state.provider_session_epoch
    created.origin_response_id = state.provider_response_id
    created.origin_user_input_revision = state.origin_user_input_revision
    this.#semanticAcknowledgements.set(eventId, created)
    return created
  }

  /**
   * Hold a slot before admitting a call that will need one.
   *
   * The reservation counts against the same bound as the acknowledgements themselves, so two calls
   * admitted back to back cannot both be promised a slot only one of them can have.
   */
  #reserveSemanticAcknowledgement(): boolean {
    while (
      this.#semanticAcknowledgements.size + this.#semanticAcknowledgementReservations
      >= MAX_TRACKED_SEMANTIC_ACKNOWLEDGEMENTS
    ) {
      const deliveredId = [...this.#semanticAcknowledgements.entries()]
        .find(([, current]) => current.phase === 'delivered')?.[0]
      if (deliveredId === undefined) return false
      this.#semanticAcknowledgements.delete(deliveredId)
    }
    this.#semanticAcknowledgementReservations += 1
    return true
  }

  // ---------------------------------------------------------------------------------------------
  // Family M: batching tool results into one turn.
  // ---------------------------------------------------------------------------------------------

  /** Bind the head batch to the response that will speak it. */
  #bindContinuation(responseId: string): void {
    const head = this.#continuationFifo[0]
    if (head === undefined) return
    const batch = this.#continuationBatches.get(head)
    if (batch?.phase !== 'requested') return
    batch.phase = 'bound'
    batch.continuation_response_id = responseId
    for (const key of batch.call_keys) {
      const state = this.#toolCallState(key)
      if (state === undefined) continue
      state.continuation = 'bound'
      state.continuation_response_id = responseId
      const acknowledgement = this.#semanticAcknowledgement(state)
      if (acknowledgement?.phase === 'pending') {
        acknowledgement.phase = 'bound'
        acknowledgement.response_id = responseId
        acknowledgement.binding = 'continuation'
      }
    }
  }

  /**
   * Close the head batch when the response that was speaking it ends.
   *
   * Only the head, and only if this is the response it was bound to: a terminal for some other
   * response says nothing about whether this batch was spoken.
   */
  #finishContinuation(event: {readonly response_id: string; readonly status: string}): void {
    const head = this.#continuationFifo[0]
    if (head === undefined) return
    const batch = this.#continuationBatches.get(head)
    if (batch === undefined) return
    if (batch.phase !== 'bound' || batch.continuation_response_id !== event.response_id) return
    batch.phase = 'terminal'
    for (const key of batch.call_keys) {
      const state = this.#toolCallState(key)
      if (state === undefined) continue
      state.continuation = 'terminal'
      state.final_disposition = !state.acceptance.accepted
        ? 'refused'
        : event.status === 'completed'
          ? 'completed'
          : 'abandoned'
    }
    this.#continuationFifo.shift()
  }

  /** A collecting batch whose originating response has ended is ready to speak. */
  #finishOrigin(responseId: string): void {
    const batch = this.#continuationBatches.get(callKey(this.session.sessionEpoch, responseId))
    if (batch?.phase !== 'collecting') return
    batch.origin_status = this.#originStatus(responseId)
    batch.phase = 'ready'
  }

  // ---------------------------------------------------------------------------------------------
  // Family I: project confirmation.
  //
  // Changing which workspace the agent operates in needs the user to say yes out loud, and this is the
  // machinery that makes that answer trustworthy in a conversation that keeps moving. The controller
  // owns the decision; this owns the *isolation* around it.
  //
  // Three overlapping guards, because the failure modes are different. The reserved item makes one
  // transcript the answer and nothing else. The response block permits only the dedicated decision
  // function. And the pending-only fence cancels an old host-requested question without cancelling the
  // model response that must produce that function. Each closes a hole the other two leave open.
  // ---------------------------------------------------------------------------------------------

  /**
   * Claim the user's next utterance as the answer to a pending proposal.
   *
   * An utterance with no provider item id cannot be reserved, and an unreservable one cannot be
   * answered -- so the proposal is cancelled outright rather than left waiting for a reply that can
   * never be attributed to it.
   */
  #reserveProjectConfirmation(event: {
    readonly session_epoch: number
    readonly provider_item_id: string | null
  }): void {
    if (this.#projectConfirmation?.pending !== true) return
    const itemId = event.provider_item_id
    if (itemId === null) {
      this.#invalidateProjectConfirmation('missing_item_correlation')
      this.#queueProjectConfirmationFact('缺少语音确认关联，本次操作已取消。')
      return
    }
    if (!this.#projectConfirmation.reserveUserItem({epoch: event.session_epoch, itemId})) return
    this.#projectConfirmationItems.add(callKey(event.session_epoch, itemId))
    this.#projectConfirmationBlocking = true
    // Cancel only a confirmation question whose host-requested response has not started yet. The
    // response created from this user answer must remain alive so Qwen can emit the structured
    // confirmation function after `response.created`.
    this.#projectConfirmationFencePending = this.session.armPendingResponseFence()
    this.#publishProjectView()
  }

  /**
   * Whether this tool call arrives in a turn that is supposed to be waiting for a confirmation.
   *
   * Blocked by *epoch* as well as by response, because a reconnect renumbers responses and a
   * confirmation spanning one would otherwise stop blocking. Recording the response id on the way
   * through is what makes the block stick for the rest of that turn.
   */
  #blocksProjectConfirmationTool(event: {
    readonly session_epoch: number
    readonly response_id: string | null
  }): boolean {
    for (const key of this.#projectConfirmationResponses) {
      if (parseCallKey(key).sessionEpoch === event.session_epoch) return true
    }
    const effectiveResponseId = event.response_id ?? this.session.activeProviderResponseId
    if (
      effectiveResponseId !== null
      && this.#projectConfirmationResponses.has(callKey(event.session_epoch, effectiveResponseId))
    ) {
      return true
    }
    if (this.#projectConfirmationBlocking) {
      if (event.response_id !== null) {
        this.#projectConfirmationResponses.add(callKey(event.session_epoch, event.response_id))
      }
      return true
    }
    return false
  }

  #isProjectConfirmationItem(epoch: number, itemId: string): boolean {
    const key = callKey(epoch, itemId)
    return this.#projectConfirmationItems.has(key)
      || this.#projectConfirmationClosingItems.has(key)
  }

  /**
   * Move an item from reserved to closing.
   *
   * A separate set rather than a flag, because closing involves provider I/O: during it the item is no
   * longer accepting an answer but still has to block tool calls, and a single set could not say both.
   */
  #beginProjectConfirmationClose(epoch: number, itemId: string): void {
    const key = callKey(epoch, itemId)
    this.#projectConfirmationItems.delete(key)
    this.#projectConfirmationClosingItems.add(key)
    this.#projectConfirmationBlocking = true
  }

  #endProjectConfirmationClose(epoch: number, itemId: string): void {
    this.#projectConfirmationClosingItems.delete(callKey(epoch, itemId))
    this.#projectConfirmationBlocking = this.#projectConfirmationItems.size > 0
      || this.#projectConfirmationClosingItems.size > 0
      || this.#projectConfirmationFencePending
  }

  #endProjectConfirmationItem(epoch: number, itemId: string): void {
    this.#projectConfirmationItems.delete(callKey(epoch, itemId))
    this.#projectConfirmationBlocking = this.#projectConfirmationItems.size > 0
      || this.#projectConfirmationClosingItems.size > 0
      || this.#projectConfirmationFencePending
  }

  async #handleProjectConfirmationDecision(
    event: ToolCallReady,
    origin: BoundToolOrigin,
  ): Promise<void> {
    const call = callKey(event.session_epoch, event.call_id)
    if (
      this.#projectConfirmationClosingCalls.has(call)
      || this.#projectConfirmationClosedCalls.has(call)
    ) return
    this.#projectConfirmationClosingCalls.add(call)

    let code = 'confirmation_not_pending'
    let state = 'refused'
    try {
      const itemId = origin.originItemId
      const controller = this.#projectConfirmation
      if (
        controller !== undefined
        && itemId !== null
        && origin.originRef !== null
        && origin.observedProviderResponseId !== null
        && event.response_id === origin.observedProviderResponseId
        && this.#isProjectConfirmationItem(event.session_epoch, itemId)
      ) {
        let text: string | null = null
        const decision = projectConfirmationDecisionArguments(event.arguments)
        if (decision === null) {
          code = 'confirmation_invalid'
          text = '确认请求无效，操作尚未执行。'
        } else {
          const outcome = controller.acceptDecision({
            epoch: event.session_epoch,
            itemId,
            proposalId: decision.proposalId,
            confirmed: decision.confirmed,
          })
          code = outcome.kind === 'ignored' ? 'confirmation_not_pending' : outcome.kind
          state = outcome.kind === 'confirmed' ? 'accepted' : 'refused'
          text = outcome.response_text
          if (outcome.kind !== 'invalid' && outcome.kind !== 'ignored') {
            this.#beginProjectConfirmationClose(event.session_epoch, itemId)
            try {
              await this.#closeConfirmationDeferredCalls(itemId)
              if (outcome.kind === 'confirmed' && outcome.operation !== null) {
                const callback = this.#commitProjectOperation
                if (callback === undefined) {
                  state = 'failed'
                  text = '确认处理不可用，本次操作未执行。'
                } else {
                  try {
                    const result = await callback(outcome.operation, origin.originRef)
                    state = result.accepted ? 'accepted' : 'failed'
                    text = result.accepted
                      ? projectCommitSuccessText(outcome.operation, result.code)
                      : projectCommitFailureText(result.code)
                  } catch (failure) {
                    if (isAbort(failure)) throw failure
                    state = 'failed'
                    text = '已确认，但操作未执行。'
                  }
                }
              }
            } finally {
              this.#endProjectConfirmationClose(event.session_epoch, itemId)
            }
          }
        }
        if (text !== null && text !== '') this.#queueProjectConfirmationFact(text)
        this.#publishProjectView()
      }
      const item: HostContextItem = {
        kind: 'tool_output',
        host_item_id: this.#idFactory(),
        event_id: this.#idFactory(),
        call_id: event.call_id,
        content: JSON.stringify({code, state}),
      }
      await this.session.injectToolOutput(item)
    } catch (cause) {
      this.#projectConfirmationClosingCalls.delete(call)
      throw cause
    }
    this.#projectConfirmationClosingCalls.delete(call)
    this.#rememberClosedProjectConfirmationCall(call)
  }

  /** Transcription failed, so the answer is unknowable and the proposal is cancelled. */
  async #failProjectConfirmation(epoch: number, itemId: string): Promise<void> {
    if (this.#projectConfirmationClosingItems.has(callKey(epoch, itemId))) {
      await this.#closeConfirmationDeferredCalls(itemId)
      return
    }
    this.#beginProjectConfirmationClose(epoch, itemId)
    try {
      await this.#closeConfirmationDeferredCalls(itemId)
    } finally {
      this.#endProjectConfirmationClose(epoch, itemId)
    }
    const controller = this.#projectConfirmation
    if (controller === undefined) return
    const outcome = controller.failTranscript({epoch, itemId})
    if (outcome.response_text !== null && outcome.response_text !== '') {
      this.#queueProjectConfirmationFact(outcome.response_text)
    }
    this.#publishProjectView()
  }

  /**
   * Give the provider a terminal result for a tool call the confirmation refused.
   *
   * Reserved *before* the first await: expiry cleanup and a provider event can both reach the same
   * call, and two terminal outputs for one function call is a protocol violation. Cleared on failure so
   * a retry is possible; recorded on success so a later attempt is a no-op.
   */
  async #closeProjectConfirmationTool(event: ToolCallReady): Promise<void> {
    const key = callKey(event.session_epoch, event.call_id)
    if (
      this.#projectConfirmationClosingCalls.has(key)
      || this.#projectConfirmationClosedCalls.has(key)
    ) {
      return
    }
    this.#projectConfirmationClosingCalls.add(key)
    const item: HostContextItem = {
      kind: 'tool_output',
      host_item_id: this.#idFactory(),
      event_id: this.#idFactory(),
      call_id: event.call_id,
      content: '{"code":"confirmation_reserved","state":"superseded"}',
    }
    try {
      await this.session.injectToolOutput(item)
    } catch (cause) {
      this.#projectConfirmationClosingCalls.delete(key)
      throw cause
    }
    this.#projectConfirmationClosingCalls.delete(key)
    this.#rememberClosedProjectConfirmationCall(key)
  }

  #rememberClosedProjectConfirmationCall(key: string): void {
    this.#projectConfirmationClosedCalls.delete(key)
    this.#projectConfirmationClosedCalls.set(key, null)
    while (this.#projectConfirmationClosedCalls.size > MAX_TRACKED_TOOL_CALLS) {
      const oldest = this.#projectConfirmationClosedCalls.keys().next()
      if (oldest.done === true) break
      this.#projectConfirmationClosedCalls.delete(oldest.value)
    }
  }

  /**
   * Refuse the tool calls that were waiting on this transcript.
   *
   * Detached before awaiting: rebuilding the queue from a snapshot after provider I/O would overwrite
   * calls a concurrent event appended in the meantime.
   */
  async #closeConfirmationDeferredCalls(itemId: string): Promise<void> {
    const matching: DeferredOriginToolCall[] = []
    const retained: DeferredOriginToolCall[] = []
    for (const call of this.#originDeferredToolCalls) {
      (call.user_item_id === itemId ? matching : retained).push(call)
    }
    this.#originDeferredToolCalls.length = 0
    this.#originDeferredToolCalls.push(...retained)
    for (const call of matching) {
      await this.#closeProjectConfirmationTool(call.event)
    }
  }

  /** Say something to the user about the confirmation. Just below user priority: urgent, not louder. */
  #queueProjectConfirmationFact(text: string): void {
    this.queueHostItem(hostFactIntent({
      kind: 'final',
      host_item_id: this.#idFactory(),
      event_id: `project-confirmation:${this.#idFactory()}`,
      content: [...text].slice(0, MAX_HOST_FACT_CHARS).join(''),
    }), {priority: USER_PRIORITY - 1, preemptive: false})
    this.#deliveryReady.set()
  }

  /** Retry guidance remains truthful even if expiry wins after the item has already been injected. */
  #queueProjectConfirmationRetryFact(): void {
    this.queueHostItem(hostFactIntent({
      kind: 'final',
      host_item_id: this.#idFactory(),
      event_id: `project-confirmation-retry:${this.#idFactory()}`,
      content: '我没有确认清楚；若界面仍显示等待确认，请明确说“确认”或“取消”。',
    }), {priority: USER_PRIORITY - 1, preemptive: false})
    this.#deliveryReady.set()
  }

  /** Expiry makes a not-yet-injected retry ineligible; retain all unrelated host facts in heap order. */
  #discardQueuedProjectConfirmationRetries(): void {
    const retained = this.#hostItems.filter(queued => (
      !queued.intent.item.event_id.startsWith('project-confirmation-retry:')
    ))
    if (retained.length === this.#hostItems.length) return
    retained.sort(compareQueuedHostResponses)
    this.#hostItems.length = 0
    this.#hostItems.push(...retained)
  }

  /**
   * The proposal timed out on its own.
   *
   * Batched and drained by one task rather than handled inline, because cleanup involves provider I/O
   * and possibly a reconnect -- and the expiry observer is called from a timer that must not be left
   * awaiting either. A second expiry while one is draining joins the queue instead of racing it.
   */
  #projectConfirmationExpired(): void {
    this.#discardQueuedProjectConfirmationRetries()
    const itemKeys = [...this.#projectConfirmationItems]
    const sourceEpoch = this.session.sessionEpoch
    // A reconnect is needed when the confirmation armed a fence or blocked a response in this epoch:
    // either leaves provider state the next turn would otherwise inherit.
    const reconnect = this.#projectConfirmationFencePending
      || [...this.#projectConfirmationResponses]
        .some(key => parseCallKey(key).sessionEpoch === sourceEpoch)
    for (const key of itemKeys) {
      const {sessionEpoch, id} = parseCallKey(key)
      this.#beginProjectConfirmationClose(sessionEpoch, id)
    }
    this.#projectExpiryBatches.push({item_keys: itemKeys, source_epoch: sourceEpoch, reconnect})
    if (this.#projectExpiryDraining === null) {
      const signal = this.#stop.signal
      this.#projectExpiryDraining = this.#drainProjectConfirmationExpiries(signal)
        .catch((failure: unknown) => {
          this.#onDiagnostic(
            `[realtime-diagnostic] project_expiry_failure type=${diagnosticName(failure)}`,
          )
        })
        .finally(() => {
          this.#projectExpiryDraining = null
        })
    }
    this.#publishProjectView()
  }

  async #drainProjectConfirmationExpiries(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return
      const batch = this.#projectExpiryBatches.shift()
      if (batch === undefined) return
      await this.#finishProjectConfirmationExpiry(batch, signal)
    }
  }

  /**
   * Clean up after one expired proposal.
   *
   * Every step is deadlined, because each one talks to a provider that may not answer and an expiry
   * that hangs leaves the confirmation state blocking every later turn. A step that times out is
   * treated as a failure of that step, not of the expiry: the loop carries on and the user is still
   * told the proposal lapsed.
   *
   * The re-drain loop matters: closing a call awaits, and a provider event during that await can defer
   * another call for the same epoch. Taking the queue once would leave it behind.
   */
  async #finishProjectConfirmationExpiry(
    batch: ProjectExpiryBatch,
    signal: AbortSignal,
  ): Promise<void> {
    let closeFailed = false
    for (;;) {
      // Checked at every resumption point, not just on entry: each close awaits the provider, and the
      // service can be closed during any of them. Reconnecting or injecting after that would be a
      // stopped service talking to a provider it has already released.
      if (signal.aborted) return
      const deferred = this.#takeConfirmationDeferredCalls(batch.source_epoch)
      if (deferred.length === 0) break
      for (const call of deferred) {
        try {
          const completed = await this.#runProjectExpiryStep(
            this.#closeProjectConfirmationTool(call.event),
          )
          closeFailed = closeFailed || !completed
        } catch {
          closeFailed = true
        }
      }
    }
    if (signal.aborted) return
    if (batch.reconnect || closeFailed) {
      try {
        await this.#runProjectExpiryStep(
          this.#reconnectProviderSession({expectedEpoch: batch.source_epoch}),
        )
      } catch (failure) {
        this.#onDiagnostic(
          `[realtime-diagnostic] project_expiry_reconnect_failure type=${diagnosticName(failure)}`,
        )
      }
    }
    // The items are released even at shutdown: leaving one closing would block a service that is
    // restarted. Only the provider-facing half below is skipped.
    for (const key of batch.item_keys) {
      const {sessionEpoch, id} = parseCallKey(key)
      this.#endProjectConfirmationClose(sessionEpoch, id)
    }
    if (signal.aborted) return
    this.#queueProjectConfirmationFact('确认已过期，本次操作已取消。')
    try {
      await this.#runProjectExpiryStep(this.#deliveryPass())
    } catch (failure) {
      this.#onDiagnostic(
        `[realtime-diagnostic] project_expiry_delivery_failure type=${diagnosticName(failure)}`,
      )
    }
    this.#publishProjectView()
  }

  /** Take the deferred calls belonging to one epoch, leaving the rest queued in order. */
  #takeConfirmationDeferredCalls(sourceEpoch: number): readonly DeferredOriginToolCall[] {
    const matching: DeferredOriginToolCall[] = []
    const retained: DeferredOriginToolCall[] = []
    for (const deferred of this.#originDeferredToolCalls) {
      (deferred.event.session_epoch === sourceEpoch ? matching : retained).push(deferred)
    }
    this.#originDeferredToolCalls.length = 0
    this.#originDeferredToolCalls.push(...retained)
    return matching
  }

  /**
   * Run one cleanup step, or give up on it.
   *
   * Returns whether it finished. A step that did not is abandoned rather than awaited: the work may
   * still complete in the background, and the alternative is an expiry that never ends.
   */
  async #runProjectExpiryStep(work: Promise<unknown>): Promise<boolean> {
    // Attached now so a rejection after the deadline is not an unhandled one.
    const settled = work.then(() => true, () => false)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), this.#projectExpiryStepTimeoutMs)
    })
    try {
      return await Promise.race([settled, deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #publishProjectView(): void {
    const controller = this.#projectConfirmation
    if (controller === undefined) return
    try {
      this.#onProjectView?.(
        this.#projectViewProvider?.(controller.pending) ?? controller.view,
      )
    } catch {
      // A renderer that cannot accept the view must not prevent the state change that produced it.
    }
  }

  /**
   * Drop the proposal and every trace of its isolation.
   *
   * Called when the world the proposal described has changed underneath it -- a reconnect, a new
   * provider session -- so confirming it would commit against a context the user never saw.
   */
  #invalidateProjectConfirmation(reason: string): void {
    this.#projectConfirmation?.invalidate(reason)
    this.#projectConfirmationItems.clear()
    this.#projectConfirmationClosingItems.clear()
    this.#projectConfirmationResponses.clear()
    this.#projectConfirmationBlocking = false
    this.#projectConfirmationFencePending = false
    this.#publishProjectView()
  }

  // ---------------------------------------------------------------------------------------------
  // Family E: playback acknowledgement.
  //
  // The renderer is the only thing that knows whether audio actually reached a person. Everything here
  // turns its reports into facts the rest of the system can rely on -- and refuses to turn them into
  // more than that. "The renderer said it played 0 ms" is not evidence the user heard anything.
  // ---------------------------------------------------------------------------------------------

  playbackStarted(utteranceId: string, generationEpoch: number): boolean {
    // Read before the call, because starting playback is what makes it current.
    const generation = this.session.currentGeneration
    const started = this.session.playbackStarted(utteranceId, generationEpoch)
    if (
      started
      && generation !== null
      && generation.utterance_id === utteranceId
      && generation.generation_epoch === generationEpoch
      && this.#telemetry !== undefined
    ) {
      const attribution = this.#playbackAttribution(generation.response_id)
      if (attribution !== null) this.#telemetry.record('playback.attribution', attribution)
    }
    return started
  }

  /**
   * What this turn was speaking *about*, when that is unambiguous.
   *
   * Only a single suggestion counts: a turn carrying two is answering neither one in particular, and
   * attributing it to either would be a guess recorded as a fact.
   */
  #playbackAttribution(responseId: string): Readonly<Record<string, JsonValue>> | null {
    const suggestionEvents = this.session.responseEventIds(responseId)
      .filter(eventId => eventId.startsWith('suggestion:'))
    if (suggestionEvents.length === 1) {
      const suggestionId = suggestionEvents[0]!.slice('suggestion:'.length)
      const suggestion = this.#runtime.suggestionFor?.(suggestionId) ?? null
      if (suggestion !== null && suggestion.kind === 'selected_progress') {
        const memoryRef = suggestion.evidence_refs[0]
        if (memoryRef !== undefined) {
          return {target: 'selected_progress', memory_ref: memoryRef}
        }
      }
    }
    for (const state of this.#toolCalls.values()) {
      if (
        state.logical_name === 'memory.recall'
        && state.acceptance.inline_fulfilled
        && state.continuation_response_id === responseId
      ) {
        return {target: 'memory_recall'}
      }
    }
    return null
  }

  /**
   * The renderer finished playing a generation.
   *
   * The event ids are captured *before* completing, because completion is what clears the generation --
   * and the suggestion confirmations below need to know what it was carrying.
   */
  playbackDone(utteranceId: string, generationEpoch: number, playedMs: number | null): boolean {
    const generation = this.session.currentGeneration
    const urgentOwner = this.#urgentOwnerForGeneration(utteranceId, generationEpoch)
    const eventIds = generation === null
      ? []
      : this.session.responseEventIds(generation.response_id)
    const completion = this.session.completePlayback(utteranceId, generationEpoch, playedMs)
    if (completion === null) return false
    this.#recordOriginDeliveryProof(completion)
    this.#cancelGuardClearDeadline(utteranceId, generationEpoch)
    for (const eventId of eventIds) {
      // Confirmed only if it was actually spoken: a suggestion in a turn that was cut off has not been
      // offered, and marking it fired would stop it ever being offered again.
      if (eventId.startsWith('suggestion:') && this.session.eventWasSpoken(eventId)) {
        this.#runtime.confirmSuggestionSpoken?.(eventId.slice('suggestion:'.length))
      }
    }
    this.#releaseUrgentHostResponse(urgentOwner)
    this.#deliveryReady.set()
    return true
  }

  /** The renderer dropped a generation on request. */
  playbackCleared(utteranceId: string, generationEpoch: number, playedMs: number | null): boolean {
    const urgentOwner = this.#urgentOwnerForGeneration(utteranceId, generationEpoch)
    const cleared = this.session.playbackCleared(utteranceId, generationEpoch, playedMs)
    if (!cleared) return false
    // The acknowledgement arrived, so the deadline waiting for it has nothing left to retire.
    this.#cancelGuardClearDeadline(utteranceId, generationEpoch)
    this.#releaseUrgentHostResponse(urgentOwner)
    this.#deliveryReady.set()
    return true
  }

  /** The renderer stopped playback without being asked -- a device change, or a closed window. */
  async playbackStopped(
    utteranceId: string,
    generationEpoch: number,
    playedMs: number | null,
  ): Promise<boolean> {
    const urgentOwner = this.#urgentOwnerForGeneration(utteranceId, generationEpoch)
    const stopped = await this.session.playbackStopped(utteranceId, generationEpoch, playedMs)
    if (!stopped) return false
    this.#cancelGuardClearDeadline(utteranceId, generationEpoch)
    this.#releaseUrgentHostResponse(urgentOwner)
    this.#deliveryReady.set()
    return true
  }

  /**
   * Record that a turn was audibly delivered, if it was.
   *
   * `played_ms > 0` when the renderer reported a duration, and otherwise whether it started at all.
   * Zero milliseconds is not audible: the renderer began and produced no sound, which is exactly the
   * case where assuming delivery would suppress an acknowledgement the user never heard.
   *
   * Only kept when something can still refer to it, and evicted oldest-first among the entries nothing
   * live points at -- so a bounded ledger never drops the proof a pending acknowledgement is waiting on.
   */
  #recordOriginDeliveryProof(completion: PlaybackCompletion): void {
    const audible = completion.played_ms === null
      ? completion.started
      : completion.played_ms > 0
    if (completion.disposition !== 'spoken' || !audible) return
    const key = callKey(completion.session_epoch, completion.response_id)
    if (!this.#originCanReferenceProof(key)) return
    this.#originDeliveryProofs.delete(key)
    this.#originDeliveryProofs.set(key, null)
    this.#pruneOriginDeliveryProofs()
  }

  /** Whether anything at all refers to this turn. A proof nothing can cite is not worth keeping. */
  #originCanReferenceProof(key: string): boolean {
    const {sessionEpoch, id: responseId} = parseCallKey(key)
    if (this.#originDeferredToolCalls.some(deferred => (
      deferred.event.session_epoch === sessionEpoch && deferred.response_id === responseId
    ))) {
      return true
    }
    for (const ledger of [this.#toolCalls, this.#overflowToolCalls]) {
      for (const state of ledger.values()) {
        if (
          state.provider_session_epoch === sessionEpoch
          && state.provider_response_id === responseId
        ) {
          return true
        }
      }
    }
    if (this.#continuationBatches.has(key)) return true
    for (const acknowledgement of this.#semanticAcknowledgements.values()) {
      if (
        acknowledgement.origin_session_epoch === sessionEpoch
        && acknowledgement.origin_response_id === responseId
      ) {
        return true
      }
    }
    return false
  }

  /** Whether anything *unfinished* refers to it, which is what makes it unsafe to evict. */
  #originHasNonterminalReference(key: string): boolean {
    const {sessionEpoch, id: responseId} = parseCallKey(key)
    if (this.#originDeferredToolCalls.some(deferred => (
      deferred.event.session_epoch === sessionEpoch && deferred.response_id === responseId
    ))) {
      return true
    }
    for (const ledger of [this.#toolCalls, this.#overflowToolCalls]) {
      for (const state of ledger.values()) {
        if (
          state.provider_session_epoch === sessionEpoch
          && state.provider_response_id === responseId
          && state.final_disposition === null
        ) {
          return true
        }
      }
    }
    const batch = this.#continuationBatches.get(key)
    if (batch !== undefined && batch.phase !== 'terminal' && batch.phase !== 'abandoned') return true
    for (const acknowledgement of this.#semanticAcknowledgements.values()) {
      if (
        acknowledgement.origin_session_epoch === sessionEpoch
        && acknowledgement.origin_response_id === responseId
        && acknowledgement.phase !== 'delivered'
      ) {
        return true
      }
    }
    return false
  }

  /**
   * Keep the ledger bounded, evicting what nothing unfinished depends on.
   *
   * When *everything* is still referenced there is no safe choice, so the newest goes: the older
   * proofs have waited longer and are likelier to be the one something is about to ask for.
   */
  #pruneOriginDeliveryProofs(): void {
    while (this.#originDeliveryProofs.size > MAX_TRACKED_ORIGIN_DELIVERY_PROOFS) {
      let evictable: string | undefined
      for (const key of this.#originDeliveryProofs.keys()) {
        if (!this.#originHasNonterminalReference(key)) {
          evictable = key
          break
        }
      }
      if (evictable === undefined) {
        const newest = [...this.#originDeliveryProofs.keys()].at(-1)
        if (newest !== undefined) this.#originDeliveryProofs.delete(newest)
        return
      }
      this.#originDeliveryProofs.delete(evictable)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Family L: Guard preemption.
  //
  // A Guard alert is the one thing allowed to interrupt the agent mid-sentence, and interrupting is
  // the hard part. The provider has to be told to stop, the renderer has to be told to drop the audio
  // already in flight, and the replacement has to start speaking -- with no guarantee any of the three
  // acknowledges. So every step is deadlined: if the provider does not confirm the cancel, the host
  // stops waiting and speaks anyway; if the renderer does not confirm the clear, the generation is
  // retired as unknown rather than left pending forever.
  //
  // The token is what makes that safe. Each preemption carries one, and every deferred callback checks
  // it before acting -- so a deadline belonging to a preemption that has already resolved does
  // nothing, instead of tearing down the one that replaced it.
  // ---------------------------------------------------------------------------------------------

  /**
   * The provider refused to cancel, so take the session away from it.
   *
   * The last resort. The provider was asked to stop, said it would not, and the alert is still waiting
   * -- so the whole provider session is replaced under the preemption rather than letting the old turn
   * run to completion. Gated behind `controlledGuardReconnect` because it is a heavy remedy for a case
   * that should not happen.
   *
   * `#reconnectLock` before `#deliveryLock`, never the reverse: that order is fixed across this layer,
   * and this is the one method that holds both.
   *
   * Seven conditions have to hold before the permit is spent. Together they say: this rejection is
   * about *this* preemption, in the current session, for a turn that is still trying to cancel and has
   * not produced anything yet. Anything else and a reconnect would be discarding a session that is
   * working.
   */
  async #handleGuardCancelRejected(event: {
    readonly session_epoch: number
    readonly response_id: string
  }): Promise<void> {
    if (!this.#controlledGuardReconnect) return
    await this.#reconnectLock.run(async () => {
      await this.#deliveryLock.run(async () => {
        const preemption = this.#guardPreemption
        if (
          preemption?.session_epoch !== event.session_epoch
          || preemption.session_epoch !== this.session.sessionEpoch
          || preemption.old_response_id !== event.response_id
          || preemption.reconnect_permit_consumed
          || preemption.reconnect_disallowed
          || this.session.providerTurnPhase(event.response_id) !== 'cancel_requested'
          // A turn that has already produced events has said something to the user; replacing the
          // session under it would lose whatever that was.
          || this.session.responseEventIds(event.response_id).length > 0
        ) {
          return
        }
        const queued = this.#hostItems
          .find(candidate => candidate.intent.item.event_id === preemption.event_id)
        const oldGeneration = preemption.old_generation
        if (queued === undefined || oldGeneration === null) return

        const spent: GuardPreemption = {
          ...preemption,
          cancel_sent: true,
          reconnect_permit_consumed: true,
        }
        this.#guardPreemption = spent
        if (spent.deadline_fired) {
          // The alert already fenced the retained renderer generation. Anchor its uncertainty bound
          // now, before a slow reconnect; ordinary Guard alerts never consume this permit.
          this.#startGuardClearDeadline(oldGeneration)
        }
        const oldEpoch = this.session.sessionEpoch
        const history = this.#guardRecoveryHistory()
        try {
          const historyOutcome = await this.session.reconnectForGuard({
            tools: structuredClone(this.#providerSchemas),
            oldGeneration,
            confirmationTimeout: 0.5,
            history,
            historyMode: this.#guardHistoryRecovery,
          })
          this.#providerEpochNeedingActivation = this.session.sessionEpoch
          if (this.#guardHistoryRecovery !== 'none') {
            this.#telemetry?.record('guard.history_recovery', {
              arm: this.#guardHistoryRecovery,
              outcome: historyOutcome,
              item_count: history.length,
              pair_count: Math.floor(history.length / 2),
              character_count: history.reduce(
                (total, turn) => total + codePointLengthLikePython(turn.text),
                0,
              ),
            })
          }
          this.#awaitingUserOrigin = false
          this.#userOriginPreexistingResponseId = null
          this.#unboundUserOriginItems.length = 0
          this.#responseUserOriginItems.clear()
          this.#userOriginRefs.clear()
          this.#originDeferredToolCalls.length = 0
          this.#releaseUrgentHostResponseForEpoch(oldEpoch)
          this.#clearCaptions()
          this.#audioStarted.clear()
          this.#reconcileToolStateAfterReconnect(oldEpoch)
          this.#reopenFailedSemanticAcknowledgements()
          this.#reconcileSemanticAcknowledgementsAfterReconnect()
          const current = this.#guardPreemption
          // The world may have moved while reconnecting: a replacement preemption, or a user who
          // started speaking and revoked the authority this was borrowing.
          if (current?.token !== spent.token) return
          if (current.reconnect_aborted) {
            this.#clearGuardPreemption(current.token)
            return
          }
          this.#guardPreemption = {
            ...current,
            session_epoch: this.session.sessionEpoch,
            old_response_id: null,
          }
          await this.#deliverCapturedGuardLocked(queued)
        } catch (failure) {
          this.#telemetry?.record('guard.history_recovery_failure', {
            arm: this.#guardHistoryRecovery,
            reason: diagnosticName(failure),
          })
          this.#onDiagnostic(
            `[realtime-diagnostic] guard_reconnect_failure type=${diagnosticName(failure)}`,
          )
          // A failed reconnect leaves no working provider and no way to speak the alert. Stopping is
          // the only honest outcome.
          this.#providerFailed = true
          this.#stop.abort()
          this.#deliveryReady.set()
        }
      })
    })
  }

  /** Recent conversation to hand a replacement provider, so it does not start blank. */
  #guardRecoveryHistory(): readonly RecoveryTurn[] {
    if (this.#guardHistoryRecovery === 'none') return []
    const channel = this.#runtime.memory?.channels.get('conversation')
    if (channel === undefined) return []
    const history = projectRecoveryTurns(channel.items, {maxPairs: this.#guardHistoryPairs})
    if (this.#guardHistoryRecovery === 'packed') return packRecoveryTurns(history).turns
    return history
  }

  /**
   * Deliver the exact Guard captured before the reconnect, independent of heap order.
   *
   * Not through the ordinary flush: the item was chosen before the session was replaced, and re-running
   * the priority comparison now could deliver something else into a session that exists solely to
   * carry this one. Removed from the heap by identity and re-heapified, rather than popped.
   */
  async #deliverCapturedGuardLocked(queued: QueuedHostResponse): Promise<void> {
    const index = this.#hostItems.indexOf(queued)
    if (index === -1) return
    this.#hostItems.splice(index, 1)
    this.#hostItems.sort(compareQueuedHostResponses)
    const userActivation = this.#guardActivationRequired(queued)
    let delivery
    try {
      delivery = await this.session.deliverPreemptiveHostResponse(queued.intent, {
        confirmationTimeout: 0.5,
        responseAllowed: () => this.#guardResponseIsAllowed(queued.intent.item.event_id),
        asUserActivation: userActivation,
      })
    } catch (cause) {
      this.#requeueHostItem(queued)
      throw cause
    }
    if (!delivery.accepted) {
      this.#requeueHostItem(queued)
      this.#recomputePreemptPriority()
      return
    }
    if (userActivation) {
      this.#providerEpochNeedingActivation = null
      this.#providerReconnectSourceEpoch = null
    }
    this.#recomputePreemptPriority()
    if (queued.semantic_event_id !== null) {
      const acknowledgement = this.#semanticAcknowledgements.get(queued.semantic_event_id)
      if (acknowledgement?.phase === 'queued') acknowledgement.phase = 'requested'
    }
    if (
      !this.#stop.signal.aborted
      && !this.#providerFailed
      && delivery.injectionEpoch === this.session.sessionEpoch
    ) {
      this.#urgentDeliveryToken += 1
      this.#urgentHostResponseOwner = {
        delivery_token: this.#urgentDeliveryToken,
        session_epoch: delivery.injectionEpoch,
        event_id: queued.intent.item.event_id,
        queued,
        response_id: null,
        generation: null,
      }
    }
    this.#telemetry?.record('hostitem.injected', {event_id: queued.intent.item.event_id})
  }

  /**
   * Whether the replacement turn may still speak.
   *
   * Checked at the moment the provider is about to create it, not when it was requested: a user who
   * started talking in between has revoked the authority, and an aborted reconnect means the session
   * this was for is gone.
   */
  #guardResponseIsAllowed(eventId: string): boolean {
    const preemption = this.#guardPreemption
    return preemption !== null
      && preemption.event_id === eventId
      && !preemption.reconnect_aborted
      && this.session.floor.state !== 'user_speaking'
  }

  /**
   * Bind the urgent item to the response now speaking it.
   *
   * The owner is created at delivery, before any response exists, so this is where it learns which one
   * it became. Matched by *event id within the response*, not by timing: another response could start
   * in the same instant, and binding to the wrong one would mean the alert is later considered spoken
   * when something else was.
   */
  #bindUrgentHostResponse(event: {
    readonly kind: string
    readonly session_epoch: number
    readonly response_id: string
  }): void {
    const owner = this.#urgentHostResponseOwner
    if (owner?.session_epoch !== event.session_epoch) return
    let bound = owner
    if (owner.response_id === null) {
      if (event.kind !== 'response_started') return
      if (!this.session.responseEventIds(event.response_id).includes(owner.event_id)) return
      bound = {...owner, response_id: event.response_id}
    } else if (owner.response_id !== event.response_id) {
      return
    }
    const generation = this.session.currentGeneration
    if (
      generation !== null
      && generation.session_epoch === event.session_epoch
      && generation.response_id === event.response_id
    ) {
      bound = {...bound, generation}
    }
    // The token guards against a replacement owner having appeared while this was being computed.
    if (this.#urgentHostResponseOwner?.delivery_token === bound.delivery_token) {
      this.#urgentHostResponseOwner = bound
    }
  }

  /**
   * The replacement is audibly speaking, so the preemption is over.
   *
   * This is the success path, and it is deliberately the *only* one that reports the switch latency:
   * the deadline path fires when the provider did not cooperate, and timing that would measure the
   * timeout rather than the handover.
   */
  #finishGuardFirstAudio(event: {
    readonly session_epoch: number
    readonly response_id: string
  }): void {
    const preemption = this.#guardPreemption
    const owner = this.#urgentHostResponseOwner
    const generation = this.session.currentGeneration
    if (
      preemption === null
      || owner === null
      || generation === null
      || preemption.event_id !== owner.event_id
      || preemption.session_epoch !== event.session_epoch
      || owner.response_id !== event.response_id
      || generation.session_epoch !== event.session_epoch
      || generation.response_id !== event.response_id
    ) {
      return
    }
    const token = preemption.token
    this.#clearGuardPreemption(token)
    if (
      this.#controlledGuardReconnect
      && preemption.reconnect_permit_consumed
      && preemption.old_generation !== null
    ) {
      this.#startGuardClearDeadline(preemption.old_generation)
    }
    this.#telemetry?.record('guard.first_audio_switch', {
      elapsed_ms: Math.max(0, Math.round((this.#clock.now() - preemption.queued_at) * 1_000)),
    })
  }

  /**
   * Stop waiting for the provider to confirm the cancel.
   *
   * The provider was asked to stop and has not said it did. Past the deadline the host acts as though
   * it had -- the alternative is the user hearing the old turn continue while an urgent alert waits
   * behind it, which is the failure preemption exists to prevent.
   */
  async #fireGuardAlertDeadline(preemption: GuardPreemption): Promise<void> {
    try {
      const delay = Math.max(
        0,
        preemption.queued_at + GUARD_ALERT_DEADLINE_S - this.#clock.now(),
      )
      await this.#clock.sleep(delay, this.#guardAlertAbort?.signal)
      const current = this.#guardPreemption
      // Re-read, never trusted: the preemption this timer belongs to may have resolved, been replaced,
      // or already fired while this was sleeping.
      if (current?.token !== preemption.token || current.deadline_fired) return
      if (current.reconnect_aborted) {
        this.#clearGuardPreemption(current.token)
        return
      }
      const controlledHandoff = current.reconnect_permit_consumed
      const expired = controlledHandoff && current.old_generation !== null
        ? this.session.alertGuardHandoff(current.old_generation)
        : this.session.expireHostPreempt(current.old_generation)
      if (!expired) return
      this.#guardPreemption = {...current, deadline_fired: true}
      if (
        this.#controlledGuardReconnect
        && current.reconnect_permit_consumed
        && current.old_generation !== null
      ) {
        this.#startGuardClearDeadline(current.old_generation)
      }
      this.#telemetry?.record('guard.alert_deadline_fired', {})
      // Both halves are done, so nothing is left to wait for.
      if (current.replacement_terminal) this.#clearGuardPreemption(current.token)
      this.#deliveryReady.set()
    } catch (failure) {
      if (isAbort(failure)) return
      this.#onDiagnostic(`[realtime-diagnostic] guard_alert_failure type=${diagnosticName(failure)}`)
    }
  }

  /**
   * End a preemption, cancelling its deadline.
   *
   * The token argument is how a caller says "only if this is still the one I mean" -- without it, a
   * late callback would clear a preemption that started after the one it belonged to.
   */
  #clearGuardPreemption(token?: number): void {
    const current = this.#guardPreemption
    if (current === null || (token !== undefined && current.token !== token)) return
    this.#guardPreemption = null
    const abort = this.#guardAlertAbort
    this.#guardAlertAbort = null
    abort?.abort()
  }

  /**
   * Wait for the renderer to confirm it dropped the cleared audio.
   *
   * Keyed by generation and idempotent: the clear can be re-sent, and a second deadline for the same
   * generation would retire it twice.
   */
  #startGuardClearDeadline(generation: PlaybackGeneration): void {
    const key = `${generation.utterance_id}:${generation.generation_epoch}`
    if (this.#guardClearDeadlines.has(key)) return
    const abort = new AbortController()
    this.#guardClearDeadlines.set(key, abort)
    void this.#retireGuardClearUnknown(generation, key, abort.signal)
  }

  /**
   * Give up on the renderer's clear acknowledgement.
   *
   * Retiring the generation as *unknown* rather than cleared is the honest answer: the host does not
   * know how much of it the user heard, and recording either extreme would be a claim it cannot
   * support.
   */
  async #retireGuardClearUnknown(
    generation: PlaybackGeneration,
    key: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.#clock.sleep(GUARD_CLEAR_ACK_DEADLINE_S, signal)
      if (!this.session.retirePlaybackClearUnknown(generation)) return
      this.#telemetry?.record('renderer_clear_unknown', {
        session_epoch: generation.session_epoch,
        generation_epoch: generation.generation_epoch,
      })
      this.#deliveryReady.set()
    } catch (failure) {
      if (!isAbort(failure)) throw failure
    } finally {
      if (this.#guardClearDeadlines.get(key)?.signal === signal) {
        this.#guardClearDeadlines.delete(key)
      }
    }
  }

  #cancelGuardClearDeadline(utteranceId: string, generationEpoch: number): void {
    const key = `${utteranceId}:${generationEpoch}`
    const abort = this.#guardClearDeadlines.get(key)
    if (abort === undefined) return
    this.#guardClearDeadlines.delete(key)
    abort.abort()
  }

  /** Record how the cancelled turn actually ended, which is the only measure of whether it worked. */
  #recordGuardCancelTerminal(event: {
    readonly session_epoch: number
    readonly response_id: string
    readonly status: string
    readonly reason: string
  }): void {
    const preemption = this.#guardPreemption
    if (
      preemption?.session_epoch !== event.session_epoch
      || preemption.old_response_id !== event.response_id
    ) {
      return
    }
    // Only a client-requested cancellation means the preemption did it. A turn that ended by itself in
    // the same moment looks identical from outside and is not the same event.
    const success = event.status === 'cancelled' && event.reason === 'client_cancelled'
    const reasonCategory = event.status === 'cancelled'
      ? (success ? 'client_cancelled' : 'other_cancelled')
      : event.status
    this.#telemetry?.record('provider.cancel_terminal', {
      status: event.status,
      reason_category: reasonCategory,
      success,
      elapsed_ms: Math.max(0, Math.round((this.#clock.now() - preemption.queued_at) * 1_000)),
    })
  }

  /** Note that the cancel actually reached the provider. Once per preemption. */
  #recordGuardCancelSent(responseId: string): void {
    const preemption = this.#guardPreemption
    if (
      preemption?.session_epoch !== this.session.sessionEpoch
      || preemption.old_response_id !== responseId
      || preemption.cancel_sent
    ) {
      return
    }
    this.#guardPreemption = {...preemption, cancel_sent: true}
    this.#telemetry?.record('provider.cancel_sent', {
      elapsed_ms: Math.max(0, Math.round((this.#clock.now() - preemption.queued_at) * 1_000)),
    })
  }

  /**
   * The replacement turn has ended.
   *
   * Half of the two-sided finish: the preemption is over when the replacement has finished *and* the
   * old turn has been dealt with. Whichever arrives second does the clearing.
   */
  #markGuardReplacementTerminal(owner: UrgentHostResponseOwner | null): void {
    const preemption = this.#guardPreemption
    if (
      owner === null
      || preemption?.event_id !== owner.event_id
      || preemption.session_epoch !== owner.session_epoch
    ) {
      return
    }
    const marked = {...preemption, replacement_terminal: true}
    this.#guardPreemption = marked
    if (marked.deadline_fired) this.#clearGuardPreemption(marked.token)
  }

  /**
   * Release an urgent item that was fenced before it ever started.
   *
   * A fence receipt naming it means the provider never began the response carrying it. Holding the
   * owner would block every later preemption behind one that is never going to speak.
   */
  #retireFencedPrestartUrgent(): void {
    const receipt = this.session.takeFenceInterruption()
    const owner = this.#urgentHostResponseOwner
    if (
      receipt === null
      || owner?.response_id !== null
      || owner.session_epoch !== receipt.session_epoch
      || !receipt.event_ids.includes(owner.event_id)
    ) {
      return
    }
    this.#releaseUrgentHostResponse(owner)
  }

  #urgentOwnerForResponse(sessionEpoch: number, responseId: string): UrgentHostResponseOwner | null {
    const owner = this.#urgentHostResponseOwner
    if (owner?.session_epoch !== sessionEpoch || owner.response_id !== responseId) return null
    return owner
  }

  #urgentOwnerForGeneration(
    utteranceId: string,
    generationEpoch: number,
  ): UrgentHostResponseOwner | null {
    const generation = this.#urgentHostResponseOwner?.generation
    if (
      generation?.utterance_id !== utteranceId
      || generation.generation_epoch !== generationEpoch
    ) {
      return null
    }
    return this.#urgentHostResponseOwner
  }

  /** Release this exact owner. The token is what stops a stale caller releasing its replacement. */
  #releaseUrgentHostResponse(owner: UrgentHostResponseOwner | null): void {
    const current = this.#urgentHostResponseOwner
    if (
      owner !== null
      && current !== null
      && current.delivery_token === owner.delivery_token
    ) {
      this.#urgentHostResponseOwner = null
    }
  }

  #releaseUrgentHostResponseForEpoch(sessionEpoch: number): void {
    if (this.#urgentHostResponseOwner?.session_epoch === sessionEpoch) {
      this.#urgentHostResponseOwner = null
    }
  }

  /** Read-only views the tests and the desktop layer use. */
  get pendingHostItemCount(): number {
    return this.#hostItems.length
  }

  get armedPreemptPriority(): number | null {
    return this.#pendingPreemptPriority
  }

  /** The queued items in delivery order, for assertions. A copy: the heap is not the caller's. */
  queuedHostItems(): readonly QueuedHostResponse[] {
    return [...this.#hostItems].sort(compareQueuedHostResponses)
  }

  /**
   * Take the next item the queue would deliver, without delivering it.
   *
   * The ordering is a contract the oracle pins, and the delivery path around it is not ported yet, so
   * the two have to be separable: this is how the ordering is exercised on its own. It keeps the
   * armed-preempt bookkeeping in step, which is the part a caller would otherwise get wrong.
   */
  takeNextQueuedHostItem(): QueuedHostResponse | undefined {
    const queued = heapPop(this.#hostItems)
    if (queued?.preemptive === true) this.#recomputePreemptPriority()
    return queued
  }

  /**
   * Drive the uncertain-delivery recovery directly.
   *
   * The path that normally reaches it runs inside the provider loop, which needs the unported event
   * pipeline. Exposed so the recovery policy -- one retry per item, never for a recovery item -- can be
   * tested on its own rather than waiting for the pipeline that would reach it.
   */
  reportUncertainDeliveryForTest(failure: ItemDeliveryUncertainError): Promise<void> {
    return this.#recoverUncertainDelivery(failure)
  }

  /**
   * How many user items are waiting for a response to claim them.
   *
   * The evidence boundary is invisible from outside otherwise: a spent item wrongly re-queued only
   * shows up later, as a tool call admitted against a turn the user has moved past.
   */
  get unboundUserOriginCountForTest(): number {
    return this.#unboundUserOriginItems.length
  }

  /**
   * Drive a reconnect directly.
   *
   * The paths that normally reach it -- a recoverable provider error, an uncertain delivery, a full
   * refusal ledger -- each need their own setup, and the reconciliation this performs is worth testing
   * on its own rather than only through one of them.
   */
  reconnectForTest(expectedEpoch?: number): Promise<boolean> {
    return this.#reconnectProviderSession(
      expectedEpoch === undefined ? {} : {expectedEpoch},
    )
  }

  /** Stand in for the Guard delivery that would normally create an urgent owner. */
  seedUrgentOwnerForTest(input: {
    readonly sessionEpoch: number
    readonly eventId: string
    readonly responseId: string | null
  }): void {
    this.#urgentDeliveryToken += 1
    this.#urgentHostResponseOwner = {
      delivery_token: this.#urgentDeliveryToken,
      session_epoch: input.sessionEpoch,
      event_id: input.eventId,
      queued: {
        sortKey: [-90, -1, 0],
        intent: hostFactIntent({
          kind: 'final',
          host_item_id: 'urgent-host-1',
          event_id: input.eventId,
          content: 'urgent',
        }),
        priority: 90,
        preemptive: true,
        seq: 0,
        queued_at: 0,
        semantic_event_id: null,
        guard_activation: null,
      },
      response_id: input.responseId,
      generation: null,
    }
  }

  get urgentOwnerForTest(): UrgentHostResponseOwner | null {
    return this.#urgentHostResponseOwner
  }

  get epochNeedingActivationForTest(): number | null {
    return this.#providerEpochNeedingActivation
  }

  /** Each acknowledgement's phase, by event id. The phase is the whole state machine. */
  get acknowledgementPhasesForTest(): Readonly<Record<string, string>> {
    return Object.fromEntries(
      [...this.#semanticAcknowledgements.entries()]
        .map(([eventId, acknowledgement]) => [eventId, acknowledgement.phase]),
    )
  }

  /** Each tracked tool call's final disposition, in admission order. */
  get toolCallDispositionsForTest(): readonly (string | null)[] {
    return [...this.#toolCalls.values()].map(state => state.final_disposition)
  }

  /**
   * The preemption in flight, if any.
   *
   * Its flags are the whole state machine -- whether the cancel was sent, whether the deadline fired,
   * whether the reconnect permit was spent -- and none of that is visible from outside otherwise.
   */
  get guardPreemptionForTest(): GuardPreemption | null {
    return this.#guardPreemption
  }

  /** Which responses a confirmation has blocked. The block outliving its turn is the failure mode. */
  get confirmationResponsesForTest(): readonly string[] {
    return [...this.#projectConfirmationResponses]
  }

  /** Items reserved as the answer to a proposal. One left here blocks every later turn. */
  get confirmationItemsForTest(): readonly string[] {
    return [...this.#projectConfirmationItems]
  }

  /** Items mid-close. One left here after an expiry would block every later turn. */
  get confirmationClosingItemsForTest(): readonly string[] {
    return [...this.#projectConfirmationClosingItems]
  }

  /** Drive invalidation directly, for the observer-failure case. */
  invalidateProjectConfirmationForTest(reason: string): void {
    this.#invalidateProjectConfirmation(reason)
  }

  /** Whether a confirmation is currently refusing tool calls. Invisible from outside otherwise. */
  get projectConfirmationBlockingForTest(): boolean {
    return this.#projectConfirmationBlocking
  }

  /** Which response holds which user turn, in binding order. */
  get boundOriginsForTest(): readonly (readonly [string, string])[] {
    return [...this.#responseUserOriginItems.entries()]
  }

  /** The continuation queue, head first. Order is the contract, so it has to be observable. */
  get continuationOrderForTest(): readonly string[] {
    return [...this.#continuationFifo]
  }

  /** The runtime's delegate lookups, for a projection test that needs one to be in flight. */
  get sessionForTest(): RealtimeSession {
    return this.session
  }

  /** How many responses hold a user turn as their evidence. */
  get boundOriginCountForTest(): number {
    return this.#responseUserOriginItems.size
  }

  /** What the provider was handed at connect. Exposed so the copy can be checked, not assumed. */
  get providerSchemasForTest(): readonly Readonly<Record<string, JsonValue>>[] {
    return this.#providerSchemas
  }

  /** Wiring the unported families will need; exposed now so their absence is visible, not implied. */
  get guardConfiguration(): {
    readonly controlledReconnect: boolean
    readonly historyRecovery: GuardHistoryRecovery
    readonly historyPairs: number
  } {
    return {
      controlledReconnect: this.#controlledGuardReconnect,
      historyRecovery: this.#guardHistoryRecovery,
      historyPairs: this.#guardHistoryPairs,
    }
  }

  /**
   * State the unported families own, reachable without re-threading the constructor.
   *
   * Exposed deliberately rather than left private-and-unused: these are the seams families L, I, and
   * the event pipeline attach to, and naming them here is what makes the shape of what is missing
   * legible instead of implied.
   */
  get internals(): {
    readonly reconnectLock: Mutex
    readonly requeueHostItem: (queued: QueuedHostResponse) => void
    readonly nextUrgentDeliveryToken: () => number
    readonly nextGuardPreemptionToken: () => number
    readonly bridge: RealtimeRuntimeBridge
    readonly tools: CompiledTools
    readonly runtime: ServiceRuntime
    readonly idFactory: () => string
    readonly toolCalls: ReadonlyMap<string, ToolCallState>
    readonly overflowToolCalls: ReadonlyMap<string, ToolCallState>
    readonly continuationBatches: ReadonlyMap<string, ContinuationBatch>
    readonly continuationFifo: readonly string[]
    readonly semanticAcknowledgements: ReadonlyMap<string, SemanticAcknowledgement>
    readonly audioStarted: ReadonlySet<string>
    readonly onProviderTerminal: (generation: PlaybackGeneration) => void
    readonly onCodexState: (state: CodexState) => void
    readonly clearCaptions: () => void
    readonly setCodexState: (state: CodexState) => void
  } {
    return {
      reconnectLock: this.#reconnectLock,
      requeueHostItem: (queued: QueuedHostResponse) => {
        this.#requeueHostItem(queued)
      },
      nextUrgentDeliveryToken: () => {
        this.#urgentDeliveryToken += 1
        return this.#urgentDeliveryToken
      },
      nextGuardPreemptionToken: () => {
        this.#guardPreemptionToken += 1
        return this.#guardPreemptionToken
      },
      bridge: this.#bridge,
      tools: this.#tools,
      runtime: this.#runtime,
      idFactory: this.#idFactory,
      toolCalls: this.#toolCalls,
      overflowToolCalls: this.#overflowToolCalls,
      continuationBatches: this.#continuationBatches,
      continuationFifo: this.#continuationFifo,
      semanticAcknowledgements: this.#semanticAcknowledgements,
      audioStarted: this.#audioStarted,
      onProviderTerminal: this.#onProviderTerminal,
      onCodexState: this.#onCodexState,
      clearCaptions: () => {
        this.#clearCaptions()
      },
      setCodexState: (state: CodexState) => {
        this.#codexState = state
        this.#onCodexState(state)
      },
    }
  }
}

/**
 * A binary min-heap, matching the oracle's `heapq` sift order exactly.
 *
 * Not a sorted array: `heapq` is not a stable sort, and two items comparing equal can come out in an
 * order a sort would not produce. The comparison keys here are unique by construction (the sequence
 * number is the last field), so the orders coincide -- but implementing the same structure means that
 * remains true if a future key stops being unique.
 */
function heapPush<T>(heap: T[], item: T): void {
  heap.push(item)
  let index = heap.length - 1
  while (index > 0) {
    const parent = (index - 1) >> 1
    if (compareHeap(heap[index]!, heap[parent]!) >= 0) break
    ;[heap[index], heap[parent]] = [heap[parent]!, heap[index]!]
    index = parent
  }
}

function heapPop<T>(heap: T[]): T | undefined {
  const top = heap[0]
  const last = heap.pop()
  if (heap.length === 0 || last === undefined) return top
  heap[0] = last
  let index = 0
  for (;;) {
    const left = index * 2 + 1
    const right = left + 1
    let smallest = index
    if (left < heap.length && compareHeap(heap[left]!, heap[smallest]!) < 0) smallest = left
    if (right < heap.length && compareHeap(heap[right]!, heap[smallest]!) < 0) smallest = right
    if (smallest === index) break
    ;[heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!]
    index = smallest
  }
  return top
}

function compareHeap(left: unknown, right: unknown): number {
  return compareQueuedHostResponses(left as QueuedHostResponse, right as QueuedHostResponse)
}

/**
 * A mutual exclusion lock with FIFO ordering.
 *
 * FIFO rather than whoever-wins, because the delivery lock decides the order host facts reach the
 * provider: a waiter that jumped the queue would reorder what the user hears.
 */
class Mutex {
  #locked = false
  readonly #waiting: (() => void)[] = []

  async run<T>(body: () => Promise<T>): Promise<T> {
    await this.#acquire()
    try {
      return await body()
    } finally {
      this.#release()
    }
  }

  get locked(): boolean {
    return this.#locked
  }

  async #acquire(): Promise<void> {
    if (!this.#locked) {
      this.#locked = true
      return
    }
    await new Promise<void>(resolve => {
      this.#waiting.push(resolve)
    })
  }

  #release(): void {
    const next = this.#waiting.shift()
    if (next === undefined) {
      this.#locked = false
      return
    }
    // Handed straight to the next waiter rather than unlocked and re-acquired, so nothing that
    // arrives in between can take the lock ahead of someone already waiting.
    next()
  }
}

/** A latch that stays set until cleared, matching `asyncio.Event`. */
class Signal {
  #set = false
  readonly #waiting: (() => void)[] = []

  set(): void {
    this.#set = true
    const waiting = this.#waiting.splice(0, this.#waiting.length)
    for (const resolve of waiting) resolve()
  }

  clear(): void {
    this.#set = false
  }

  async wait(signal?: AbortSignal): Promise<void> {
    if (this.#set) return
    if (signal?.aborted === true) return
    await new Promise<void>(resolve => {
      this.#waiting.push(resolve)
      // Resolves rather than rejects: an interrupted wait is a normal shutdown, and the caller
      // re-reads the signal immediately afterwards.
      signal?.addEventListener('abort', () => resolve(), {once: true})
    })
  }
}

/**
 * Whether a promise settled inside the grace period.
 *
 * Rejections propagate -- a provider that refused to close reported something the caller has to see --
 * while a promise that never settles at all resolves to `false` so the caller can say so and move on.
 */
async function resolvedWithin(work: Promise<unknown>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), graceMs)
  })
  try {
    return await Promise.race([work.then(() => true), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Wait for every task, but not forever.
 *
 * Returns how many were still running when the grace period ran out. A JavaScript promise cannot be
 * cancelled the way an asyncio task can, so a loop that ignored its abort signal would make `close`
 * hang -- and a service that never finishes closing is worse than one that names a task it could not
 * stop. Every loop here observes the signal, so reaching the timeout means one is genuinely stuck.
 */
async function settleWithin(tasks: readonly Promise<void>[], graceMs: number): Promise<number> {
  if (tasks.length === 0) return 0
  let outstanding = tasks.length
  const settled = tasks.map(task => task.then(
    () => {
      outstanding -= 1
    },
    () => {
      outstanding -= 1
    },
  ))
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(resolve, graceMs)
  })
  await Promise.race([Promise.all(settled), deadline])
  if (timer !== undefined) clearTimeout(timer)
  return outstanding
}

/** A callback that was not supplied. Named so two of them are not two anonymous empty functions. */
function noop(): void {
  // Intentionally empty: an absent observer is not an error.
}

function projectCommitSuccessText(
  operation: ConfirmedProjectOperation,
  code: string,
): string {
  if (code !== 'committed') return '已确认，已提交并正在启动。'
  if (operation.action === 'create') {
    return `已确认，已创建并切换到工作区 ${operation.workspace_display_name}。`
  }
  if (operation.action === 'select') {
    return `已确认，已切换到工作区 ${operation.workspace_display_name}。`
  }
  return '已确认，项目操作已完成。'
}

/** Wrap whatever was thrown so it can be re-thrown as an Error without losing the original. */
function asError(cause: unknown): Error {
  if (cause instanceof Error) return cause
  const wrapped = new Error(`provider close failed: ${String(cause)}`)
  wrapped.cause = cause
  return wrapped
}

/** A host fact carrying one context item. The shape is the same at every projection site. */
function hostFactIntent(item: {
  readonly kind: 'progress' | 'final' | 'recovery' | 'dialogue_context'
  readonly host_item_id: string
  readonly event_id: string
  readonly content: string
}): HostResponseIntent {
  // `call_id` belongs to tool output alone, and a host fact is never that.
  return {
    kind: 'host_fact',
    item: {...item, call_id: null},
    task_summary: null,
    origin_spoken: false,
  }
}

/**
 * Seconds as the oracle's `f"{value:.0f}"` renders them.
 *
 * Python rounds half to even and JavaScript's `toFixed` rounds half away from zero, so 0.5 renders as
 * "0" there and "1" here. Reproduced explicitly because this string is spoken to the user.
 */
export function formatSeconds(value: number): string {
  const floor = Math.floor(value)
  const remainder = value - floor
  if (remainder > 0.5) return `${floor + 1}`
  if (remainder < 0.5) return `${floor}`
  return `${floor % 2 === 0 ? floor : floor + 1}`
}

/** Whether this rejection is an abort, which is an ordinary cancellation rather than a failure. */
function isAbort(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError')
}

function diagnosticName(cause: unknown): string {
  return cause instanceof Error ? cause.constructor.name : typeof cause
}

function randomHex(): string {
  // 32 hex characters, matching the oracle's `uuid4().hex`.
  return Array.from({length: 32}, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

export type { HostContextItem, PlaybackCompletion }
