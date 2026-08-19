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
import type { JsonValue } from '../events.js'
import { USER_PRIORITY } from '../memory.js'
import type { PlaybackCompletion, PlaybackGeneration } from '../playback.js'
import type { WakeReason } from '../slots.js'
import type { CompiledTools } from '../tool-schema.js'
import type { RealtimeRuntimeBridge, ToolAcceptance, ToolCallReady } from './bridge.js'
import type {
  HostContextItem,
  HostResponseIntent,
  RealtimeProviderEvent,
} from './protocol.js'
import { ItemDeliveryUncertainError } from './protocol.js'
import { RealtimeDeliveryError, type RealtimeSession } from './session.js'
import { MAX_CONTINUATION_TASK_SUMMARY, type CaptionFrame } from './session-state.js'
import {
  MAX_PENDING_TOOL_REFUSALS,
  MAX_TRACKED_SEMANTIC_ACKNOWLEDGEMENTS,
  MAX_TRACKED_TOOL_CALLS,
  MAX_UNCERTAIN_DELIVERY_RETRIES,
  PREEMPT_MIN_PRIORITY,
  USER_HOLD_MAX_S,
  callKey,
  compareQueuedHostResponses,
  continuationBatch,
  semanticAcknowledgement,
  toolCallState,
  type CodexState,
  type ContinuationBatch,
  type DeferredOriginToolCall,
  type GuardActivationAuthority,
  type GuardHistoryRecovery,
  type GuardPreemption,
  type QueuedHostResponse,
  type SemanticAcknowledgement,
  type ToolCallAcceptanceSnapshot,
  type ToolCallState,
  type UrgentHostResponseOwner,
} from './service-state.js'
import type { RealtimeTelemetry } from './telemetry.js'

/** The runtime surface the service reads. Thirteen call sites in the oracle, mostly reads. */
export interface ServiceRuntime {
  readonly clock: Clock
  readonly executors: ReadonlyMap<
    string,
    {readonly manifest: {readonly policy: {readonly priority: number; readonly suggest?: boolean}}}
  >
  observe(observer: (event: unknown, reason: WakeReason) => void): () => void
  serve(stop: AbortSignal): Promise<void>
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
  /** Where a diagnostic goes. Defaults to stdout, which is what the oracle captures. */
  readonly onDiagnostic?: (line: string) => void
}

/**
 * A boundary the port has not reached yet.
 *
 * Thrown rather than returning the inert answer, so a scenario that reaches Guard or project
 * confirmation fails with a name instead of quietly behaving as if the feature were off. Silence
 * there would be indistinguishable from correctness.
 */
/**
 * How long `close` waits for a task that is not responding to its abort signal.
 *
 * Short: every loop here checks the signal at its next suspension point, so a task still running
 * after this is stuck rather than slow, and waiting longer would only delay the diagnostic.
 */
const SHUTDOWN_GRACE_MS = 250

export class NotYetPortedError extends Error {
  constructor(surface: string) {
    super(`${surface} is not ported yet (service.py family L/I)`)
    this.name = 'NotYetPortedError'
  }
}

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
    this.#unsubscribe = this.#runtime.observe((event, reason) => {
      this.projectRuntimeEvent(event, reason)
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
    this.#stop = new AbortController()
    const signal = this.#stop.signal
    this.#tasks = [
      this.#guardTask(this.#receiveLoop(signal)),
      this.#guardTask(this.#deliveryLoop(signal)),
      this.#guardTask(this.#runtime.serve(signal)),
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
    try {
      await this.#provider.close()
    } catch (cause) {
      closeFailure = {cause}
    }
    const tasks = this.#tasks
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
  // The ported guards below are synchronous; the arbitration they gate is unported and throws
  // before any await. The signature stays async because the ported body will await the session.
  // eslint-disable-next-line @typescript-eslint/require-await
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
    // Reached only by a manifest whose policy priority is at or above the preemption band, which no
    // core-path scenario configures. Guard arbitration decides what happens next, and it is not
    // ported -- so this fails by name rather than silently declining to preempt.
    throw new NotYetPortedError('guard preemption arbitration')
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
        if (userActivation || preemptiveOverlap) {
          throw new NotYetPortedError('guard host-item delivery')
        }
        delivery = await this.session.deliverHostResponse(queued.intent)
      } catch (cause) {
        // Put it back before propagating: a delivery that threw has not been delivered, and dropping
        // it here would lose a fact the model was supposed to receive.
        heapPush(this.#hostItems, queued)
        throw cause
      }
      const delivered = delivery.accepted
      if (queued.preemptive) this.#recomputePreemptPriority()
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

  #driveContinuationsLocked(): Promise<void> {
    return Promise.reject(new NotYetPortedError('continuation drive'))
  }

  #reconnectProviderSession(options: {readonly expectedEpoch: number}): Promise<boolean> {
    void options
    return Promise.reject(new NotYetPortedError('provider reconnect'))
  }

  projectRuntimeEvent(event: unknown, reason: WakeReason): void {
    void event
    void reason
    throw new NotYetPortedError('runtime event projection')
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
      // Guard's to arbitrate: a rejected cancel means the provider kept speaking through a preemption.
      throw new NotYetPortedError('guard cancel rejection')
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

    const accepted = await this.session.accept(event)

    if (this.#guardPreemption !== null) throw new NotYetPortedError('guard turn tracking')
    if (this.#urgentHostResponseOwner !== null) throw new NotYetPortedError('urgent owner binding')

    if (event.kind === 'response_started' && accepted) {
      // Only for a response with no events yet: one that already has them has been bound, and
      // rebinding would take a second user turn for the same response.
      if (this.session.responseEventIds(event.response_id).length === 0) {
        this.#bindResponseUserOrigin(event.response_id)
      }
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
      // Qwen may finish its function call before emitting this turn's transcript final. Do not let
      // that call bind to provider-authored placeholder text or the previous user turn.
      this.#awaitingUserOrigin = true
      this.#userOriginPreexistingResponseId = this.session.activeProviderResponseId
      if (event.provider_item_id !== null) {
        this.#rememberUnboundUserOrigin(event.provider_item_id)
      }
    }

    if (event.kind === 'response_terminal' && accepted) {
      const generation = this.session.currentGeneration
      if (
        generation !== null
        && generation.session_epoch === event.session_epoch
        && generation.response_id === event.response_id
      ) {
        this.#onProviderTerminal(generation)
      }
      this.#finishContinuation(event)
      this.#finishOrigin(event.response_id)
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
        await this.#releaseDeferredOriginCalls(event.item_id, originRef)
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
        await this.#releaseDeferredOriginCalls(event.item_id, null)
      }
    } else if (event.kind === 'tool_call_ready') {
      if (!accepted) return
      await this.#routeToolCall(event)
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
        await this.#handleToolCall(event, {
          observedProviderResponseId: observedResponseId,
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
  async #guardTask(task: Promise<void>): Promise<void> {
    try {
      await task
      if (!this.#stop.signal.aborted) this.#taskFailed()
    } catch (cause) {
      this.#onDiagnostic(`[realtime-diagnostic] task_failure type=${diagnosticName(cause)}`)
      this.#taskFailed()
    }
  }

  #taskFailed(): void {
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

  /** Remember a user item whose transcript has not arrived, so a later response can claim it. */
  #rememberUnboundUserOrigin(itemId: string): void {
    if (this.#unboundUserOriginItems.includes(itemId)) return
    this.#unboundUserOriginItems.push(itemId)
    while (this.#unboundUserOriginItems.length > MAX_TRACKED_TOOL_CALLS) {
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
  #bindResponseUserOrigin(responseId: string): void {
    if (this.#unboundUserOriginItems.length === 0) return
    const key = callKey(this.session.sessionEpoch, responseId)
    if (this.#responseUserOriginItems.has(key)) return
    const itemId = this.#unboundUserOriginItems.shift()
    if (itemId === undefined) return
    this.#responseUserOriginItems.set(key, itemId)
    this.#awaitingUserOrigin = this.#unboundUserOriginItems.length > 0
    if (!this.#awaitingUserOrigin) this.#userOriginPreexistingResponseId = null
    while (this.#responseUserOriginItems.size > MAX_TRACKED_TOOL_CALLS) {
      const oldest = this.#responseUserOriginItems.keys().next()
      if (oldest.done === true) break
      this.#responseUserOriginItems.delete(oldest.value)
    }
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
      await this.#handleToolCall(entry.event, {
        observedProviderResponseId: entry.response_id,
        originRef,
      })
    }
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
    const requiresSemanticAcknowledgement = !superseded
      && binding?.kind === 'delegate'
      && binding.sync_result !== true
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
        if (acceptance.accepted && acceptance.delegate_id !== null) {
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
      const display = typeof summary === 'string' && summary.trim() !== ''
        ? summary
        : `${this.#executorDisplayName(acceptance.executor)} background task`
      this.session.registerDelegate(acceptance.delegate_id, {
        summary: [...display.trim()].slice(0, MAX_CONTINUATION_TASK_SUMMARY).join(''),
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

/** Wrap whatever was thrown so it can be re-thrown as an Error without losing the original. */
function asError(cause: unknown): Error {
  if (cause instanceof Error) return cause
  const wrapped = new Error(`provider close failed: ${String(cause)}`)
  wrapped.cause = cause
  return wrapped
}

function diagnosticName(cause: unknown): string {
  return cause instanceof Error ? cause.constructor.name : typeof cause
}

function randomHex(): string {
  // 32 hex characters, matching the oracle's `uuid4().hex`.
  return Array.from({length: 32}, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

export type { HostContextItem, PlaybackCompletion }
