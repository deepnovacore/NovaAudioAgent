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
import type { RealtimeRuntimeBridge } from './bridge.js'
import type { HostContextItem, HostResponseIntent } from './protocol.js'
import { ItemDeliveryUncertainError } from './protocol.js'
import { RealtimeDeliveryError, type RealtimeSession } from './session.js'
import type { CaptionFrame } from './session-state.js'
import {
  MAX_UNCERTAIN_DELIVERY_RETRIES,
  PREEMPT_MIN_PRIORITY,
  USER_HOLD_MAX_S,
  compareQueuedHostResponses,
  type CodexState,
  type ContinuationBatch,
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
  readonly executors: ReadonlyMap<string, {readonly manifest: {readonly policy: {readonly priority: number; readonly suggest?: boolean}}}>
  observe(observer: (event: unknown, reason: WakeReason) => void): () => void
  serve(stop: {readonly aborted: boolean}): Promise<void>
}

/** The provider surface the service uses directly: three calls, everything else via the session. */
export interface ServiceProvider {
  sendAudio(pcm: Uint8Array): Promise<void>
  events(): AsyncIterable<{readonly session_epoch: number}>
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
  readonly #stop = new AbortSignalLike()

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
    return this.#stop.aborted
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
    this.#stop.reset()
    this.#tasks = [
      this.#guardTask(this.#receiveLoop()),
      this.#guardTask(this.#deliveryLoop()),
      this.#guardTask(this.#runtime.serve(this.#stop)),
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
    await Promise.allSettled(tasks)
    this.#connected = false
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
  async #receiveLoop(): Promise<void> {
    while (!this.#stop.aborted) {
      const streamEpoch = this.session.sessionEpoch
      let received = false
      for await (const event of this.#provider.events()) {
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
        if (this.#stop.aborted) return
      }
      if (this.#stop.aborted || this.#providerFailed) return
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
  async #deliveryLoop(): Promise<void> {
    while (!this.#stop.aborted) {
      await this.#deliveryReady.wait()
      this.#deliveryReady.clear()
      if (this.#stop.aborted) continue
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

  handleEvent(event: {readonly session_epoch: number}): Promise<void> {
    void event
    return Promise.reject(new NotYetPortedError('provider event ingestion'))
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
      if (!this.#stop.aborted) this.#taskFailed()
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

  async wait(): Promise<void> {
    if (this.#set) return
    await new Promise<void>(resolve => {
      this.#waiting.push(resolve)
    })
  }
}

/**
 * The stop flag, shaped like an abort signal so the runtime's `serve` can take it.
 *
 * Resettable, because `start` after a `close` has to be able to run again -- an `AbortController`
 * cannot be un-aborted.
 */
class AbortSignalLike {
  #aborted = false
  readonly #waiting: (() => void)[] = []

  get aborted(): boolean {
    return this.#aborted
  }

  abort(): void {
    this.#aborted = true
    const waiting = this.#waiting.splice(0, this.#waiting.length)
    for (const resolve of waiting) resolve()
  }

  reset(): void {
    this.#aborted = false
  }
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
