import type {ApprovalHost} from '../core/approval.js'
import type {Clock} from '../core/clock.js'
import type {JsonValue} from '../core/events.js'
import {
  USER_PRIORITY
} from '../core/memory.js'
import type {PlaybackCompletion, PlaybackGeneration} from './playback.js'
import type {
  HostResponseIntent
} from './protocol.js'
import type {DeliverySnapshot, HostItemOptions, ServiceRuntime} from './service-ports.js'
import {
  MAX_TRACKED_ORIGIN_DELIVERY_PROOFS,
  MAX_TRACKED_SEMANTIC_ACKNOWLEDGEMENTS, MAX_UNCERTAIN_DELIVERY_RETRIES, PREEMPTIVE_ALERT_CLEAR_ACK_DEADLINE_S,
  PREEMPTIVE_ALERT_DEADLINE_S,
  PREEMPT_MIN_PRIORITY, USER_HOLD_MAX_S, callKey,
  compareQueuedHostResponses,
  hostFactIntent,
  semanticAcknowledgement,
  type PreemptiveAlert,
  type PreemptiveAlertActivationAuthority,
  type QueuedHostResponse,
  type SemanticAcknowledgement,
  type ToolCallState,
  type UrgentHostResponseOwner
} from './service-state.js'
import {
  MAX_CONTINUATION_TASK_SUMMARY,
  MAX_PENDING_HOST_EVENTS
} from './session-state.js'
import {RealtimeDeliveryError, ResponseRequestUncertainError, type RealtimeSession} from './session.js'
import type {RealtimeTelemetry} from './telemetry.js'

import {Mutex, diagnosticName, isAbort} from './service-state.js'

interface HostDeliveryPorts {
  readonly responseCarriesPersonalRecall: (responseId: string) => boolean
  readonly session: RealtimeSession
  readonly runtime: ServiceRuntime
  readonly clock: Clock
  readonly telemetry: RealtimeTelemetry | undefined
  readonly approvalHost: ApprovalHost
  readonly controlledPreemptiveAlertReconnect: boolean
  readonly clearingConversation: () => boolean
  readonly stopped: () => boolean
  readonly providerFailed: () => boolean
  readonly wake: () => void
  readonly intakeFactEligible: (id: string, epoch: number) => boolean | undefined
  readonly executorPriority: (channel: string | null) => number
  readonly executorDisplayName: (channel: string) => string
  readonly idFactory: () => string
  readonly onDiagnostic: (line: string) => void
  readonly reportDeliveryFailure: (failure: RealtimeDeliveryError) => void
  readonly originCanReferenceProof: (key: string) => boolean
  readonly originHasNonterminalReference: (key: string) => boolean
}

export class HostDelivery {

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
      const suggestion = this.#ports.runtime.suggestionFor?.(suggestionId) ?? null
      if (suggestion !== null && suggestion.kind === 'selected_progress') {
        const memoryRef = suggestion.evidence_refs[0]
        if (memoryRef !== undefined) {
          return {target: 'selected_progress', memory_ref: memoryRef}
        }
      }
    }
    if (this.#ports.responseCarriesPersonalRecall(responseId)) return {target: 'memory_recall'}
    return null
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
      && this.#ports.telemetry !== undefined
    ) {
      this.#ports.telemetry.record('playback.started', {session_epoch: generation.session_epoch,
        response_id: generation.response_id, utterance_id: utteranceId, generation_epoch: generationEpoch})
      const attribution = this.#playbackAttribution(generation.response_id)
      if (attribution !== null) this.#ports.telemetry.record('playback.attribution', attribution)
    }
    return started
  }

  semanticAcknowledgement(state: ToolCallState): Readonly<SemanticAcknowledgement> | null {
    return this.#ensureSemanticAcknowledgement(state)
  }
  markOriginDelivered(state: ToolCallState): boolean {
    const acknowledgement = this.#ensureSemanticAcknowledgement(state)
    if (acknowledgement === null) return false
    acknowledgement.origin_delivered = true
    return true
  }
  settleBackgroundAcknowledgement(eventId: string): void {
    const acknowledgement = this.#semanticAcknowledgements.get(eventId) ?? null
    if (acknowledgement === null) return
    if (acknowledgement.origin_delivered || acknowledgement.heard) {
      acknowledgement.phase = 'delivered'
      acknowledgement.response_id = null
      acknowledgement.response_session_epoch = null
      acknowledgement.binding = null
      return
    }
    this.#queueSemanticAcknowledgement(acknowledgement)
  }
  bindContinuationAcknowledgement(state: ToolCallState, responseId: string): void {
    const acknowledgement = this.#ensureSemanticAcknowledgement(state)
    if (acknowledgement?.phase === 'pending') {
      acknowledgement.phase = 'bound'
      acknowledgement.response_id = responseId
      acknowledgement.response_session_epoch = this.session.sessionEpoch
      // The continuation is carried by the tool output itself. That item is protocol state for the
      // function call, not a provider-visible semantic acknowledgement fact, so the acknowledgement
      // must never acquire authority to retire or reopen it.
      acknowledgement.provider_event_id = null
      acknowledgement.binding = 'continuation'
    }
  }
  originCanReferenceProof(sessionEpoch: number, responseId: string): boolean {
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
  originHasNonterminalReference(sessionEpoch: number, responseId: string): boolean {
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

  /** Insertion-ordered, oldest evicted: a retry already attempted must not be attempted again. */
  readonly #uncertainDeliveryRetries = new Map<string, null>()
  resetUncertainDeliveryRetries(): void {this.#uncertainDeliveryRetries.clear()}
  admitUncertainDeliveryRetry(itemId: string): boolean {
    if (this.#uncertainDeliveryRetries.has(itemId)) return false
    this.#uncertainDeliveryRetries.delete(itemId)
    this.#uncertainDeliveryRetries.set(itemId, null)
    while (this.#uncertainDeliveryRetries.size > MAX_UNCERTAIN_DELIVERY_RETRIES) {
      const oldest = this.#uncertainDeliveryRetries.keys().next()
      if (oldest.done === true) break
      this.#uncertainDeliveryRetries.delete(oldest.value)
    }
    return true
  }

  async deliveryPass(): Promise<boolean> {
    let shouldRedriveContinuations = false
    await this.withDeliveryLock(async () => {
      if (this.session.releaseStaleUserHold(USER_HOLD_MAX_S)) {
        this.#ports.onDiagnostic('[realtime-diagnostic] floor_stale_hold_released')
      }
      if (this.#rendererHostDeliveryPaused) return
      const eligiblePreemptWasArmed = this.hasEligiblePreempt()
      await this.#maybePreemptLocked()
      if (this.session.userResponseMode === 'requested') {
        await this.session.requestPendingUserResponse()
      }
      await this.#flushHostItemsLocked()
      if (this.#hostItems.length === 0 && !this.#ports.approvalHost.pending) {
        await this.session.requestDeliveryRecovery()
      }
      shouldRedriveContinuations = eligiblePreemptWasArmed
        && (
          !this.hasEligiblePreempt()
        )
        && this.session.foregroundIdle
        && this.session.floor.state !== 'user_speaking'
    })
    return shouldRedriveContinuations
  }

  snapshot(): Omit<DeliverySnapshot, 'continuationOrder'> {
    const alert = this.#preemptiveAlert
    return {
      sessionEpoch: this.session.sessionEpoch,
      floor: this.session.floor.state,
      providerIdle: this.session.providerIdle,
      foregroundIdle: this.session.foregroundIdle,
      rendererPaused: this.#rendererHostDeliveryPaused,
      activeResponseId: this.session.activeProviderResponseId,
      userResponseMode: this.session.userResponseMode,
      urgentOwner: this.#urgentHostResponseOwner === null ? null : {
        session_epoch: this.#urgentHostResponseOwner.session_epoch,
        event_id: this.#urgentHostResponseOwner.event_id,
        response_id: this.#urgentHostResponseOwner.response_id,
        delivery_token: this.#urgentHostResponseOwner.delivery_token,
      },
      queuedEventIds: this.queuedHostItems().map(queued => queued.intent.item.event_id),
      armedPreemptPriority: this.#pendingPreemptPriority,
      preemptiveAlert: alert === null ? null : {
        ...alert,
        old_generation: alert.old_generation === null ? null : {...alert.old_generation}
      },
      epochNeedingActivation: this.#providerEpochNeedingActivation,
      acknowledgementPhases: Object.fromEntries([...this.#semanticAcknowledgements.entries()]
        .map(([eventId, acknowledgement]) => [eventId, acknowledgement.phase])),
    }
  }

  withDeliveryLock<T>(body: () => Promise<T>): Promise<T> {return this.#deliveryLock.run(body)}
  get rendererPaused(): boolean {return this.#rendererHostDeliveryPaused}
  get currentUrgentOwner(): UrgentHostResponseOwner | null {return this.#urgentHostResponseOwner}
  get currentPreemption(): PreemptiveAlert | null {return this.#preemptiveAlert}
  releasePreemptionAfterFailure(): void {this.#preemptiveAlert = null}
  releaseUrgentOwner(): void {this.#urgentHostResponseOwner = null}
  resetOriginProofs(): void {this.#originDeliveryProofs.clear()}
  hasOriginDeliveryProof(key: string): boolean {return this.#originDeliveryProofs.has(key)}
  releaseAcknowledgementReservation(): void {this.#semanticAcknowledgementReservations -= 1}
  hasSemanticAcknowledgement(id: string): boolean {return this.#semanticAcknowledgements.has(id)}
  retirementTasks(): readonly Promise<void>[] {return [...this.#providerRetirementTasks]}
  acknowledgementReleaseTasks(): readonly Promise<void>[] {return [...this.#semanticAcknowledgementReleaseTasks]}
  acceptUserActivation(epoch: number): void {
    if (this.#providerEpochNeedingActivation === epoch) this.#providerEpochNeedingActivation = null
    this.#providerReconnectSourceEpoch = null
  }
  requireActivation(): void {this.#providerEpochNeedingActivation = this.session.sessionEpoch}
  findQueuedEvent(eventId: string): QueuedHostResponse | undefined {
    return this.#hostItems.find(candidate => candidate.intent.item.event_id === eventId)
  }
  spendReconnectPermit(preemption: PreemptiveAlert): PreemptiveAlert {
    const spent: PreemptiveAlert = {...preemption, cancel_sent: true, reconnect_permit_consumed: true}
    this.#preemptiveAlert = spent
    return spent
  }
  adoptReconnectedPreemption(current: PreemptiveAlert): void {
    this.#preemptiveAlert = {...current, session_epoch: this.session.sessionEpoch, old_response_id: null}
  }

  rememberLocalSpeechInterruption(key: string): void {
    this.#localSpeechInterruptedResponses.delete(key)
    this.#localSpeechInterruptedResponses.set(key, null)
    while (
      this.#localSpeechInterruptedResponses.size
      > MAX_TRACKED_SEMANTIC_ACKNOWLEDGEMENTS
    ) {
      const oldest = this.#localSpeechInterruptedResponses.keys().next()
      if (oldest.done) break
      this.#localSpeechInterruptedResponses.delete(oldest.value)
    }
  }

  learnPreemptedResponse(event: {readonly session_epoch: number; readonly response_id: string}): void {
    const preemption = this.#preemptiveAlert
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
      this.#preemptiveAlert = {...preemption, old_response_id: event.response_id}
    }
  }

  revokePreemptiveReconnect(): void {
    const preemption = this.#preemptiveAlert
    if (preemption !== null) {
      // The user speaking is the authority the preemption was borrowing. A permit not yet spent is
      // now disallowed; one already spent means a reconnect is in flight and has to be abandoned.
      this.#preemptiveAlert = {
        ...preemption,
        reconnect_disallowed: !preemption.reconnect_permit_consumed,
        reconnect_aborted: preemption.reconnect_permit_consumed,
      }
    }
  }

  finishReconnect(oldEpoch: number): void {
    if (this.#providerReconnectSourceEpoch === oldEpoch) {
      this.#providerEpochNeedingActivation = this.session.sessionEpoch
      this.#providerReconnectSourceEpoch = null
    }
  }

  beginReconnect(oldEpoch: number): void {
    this.#preemptiveAlert = null
    this.#providerReconnectSourceEpoch = oldEpoch
  }

  resetAcknowledgements(): void {
    this.#semanticAcknowledgements.clear()
    this.#semanticAcknowledgementReservations = 0
    this.#localSpeechInterruptedResponses.clear()
    this.#delegateHostEvents.clear()
    this.#providerRetirementEventIds.clear()
  }

  resetDelivery(): void {
    for(const queued of this.#hostItems)void this.#notDelivered(queued)
    this.#hostItems.length = 0
    this.#hostItemSeq = 0
    this.#pendingPreemptPriority = null
    this.#urgentDeliveryToken += 1
    this.releaseUrgentOwner()
    this.#providerEpochNeedingActivation = null
    this.#providerReconnectSourceEpoch = null
    this.#preemptiveAlertToken += 1
    this.#preemptiveAlertAbort?.abort()
    this.#preemptiveAlertAbort = null
    this.#preemptiveAlert = null
  }

  releaseFailedDelivery(): void {
    this.#urgentHostResponseOwner = null
    this.#preemptiveAlert = null
  }

  close(): void {
    this.#providerEpochNeedingActivation = null
    this.#providerReconnectSourceEpoch = null
    this.#urgentHostResponseOwner = null
    this.#preemptiveAlert = null
  }

  resumeAfterConversationClear(): void {
    this.#rendererHostDeliveryPaused = false
    this.#rendererHostDeliveryBoundary = null
  }

  pauseForConversationClear(): void {
    this.#rendererHostDeliveryPaused = true
    this.#rendererHostDeliveryBoundary = {}
    this.#preemptiveAlertToken += 1
    this.clearPreemptiveAlert()
    for (const deadline of this.#preemptiveAlertClearDeadlines.values()) deadline.abort()
    this.#preemptiveAlertClearDeadlines.clear()
  }

  retireCodingProgress(): void {
    for (const eventId of this.#codingProgressHostEventIds) this.retireProviderHostEvent(eventId)
    const retained = this.#hostItems.filter(item => !this.#codingProgressQueued.has(item))
    this.#hostItems.length = 0
    this.#hostItems.push(...retained.sort(compareQueuedHostResponses))
    this.#codingProgressHostEventIds.clear()
  }

  coalesceCodingProgress(): void {
    const retained = this.#hostItems.filter(item => !this.#codingProgressQueued.has(item)
      || this.#codingProgressHostEventIds.has(item.intent.item.event_id))
    this.#hostItems.length = 0
    this.#hostItems.push(...retained.sort(compareQueuedHostResponses))
  }

  readonly #ports: HostDeliveryPorts
  constructor(ports: HostDeliveryPorts) {this.#ports = ports}
  get session(): RealtimeSession {return this.#ports.session}

  readonly #codingProgressQueued = new WeakSet<QueuedHostResponse>()

  readonly #codingProgressHostEventIds = new Set<string>()

  /** A binary min-heap ordered by `compareQueuedHostResponses`, matching the oracle's `heapq`. */
  readonly #uncertainQueuedDeliveries=new WeakSet<QueuedHostResponse>()
  async #notDelivered(queued:QueuedHostResponse):Promise<void>{if(!this.#uncertainQueuedDeliveries.has(queued))try{await queued.onNotDelivered?.()}catch{this.#ports.onDiagnostic('[realtime-diagnostic] hostitem_disposition_failed')}}
  #hostItems: QueuedHostResponse[] = []

  #hostItemSeq = 0

  #pendingPreemptPriority: number | null = null

  #urgentDeliveryToken = 0

  #urgentHostResponseOwner: UrgentHostResponseOwner | null = null

  #providerEpochNeedingActivation: number | null = null

  #providerReconnectSourceEpoch: number | null = null

  #preemptiveAlertToken = 0

  #preemptiveAlert: PreemptiveAlert | null = null

  /** The in-flight cancel deadline for the current preemption, if one is armed. */
  #preemptiveAlertAbort: AbortController | null = null

  /** Per-generation waits for the renderer to confirm a clear, keyed `utterance:epoch`. */
  readonly #preemptiveAlertClearDeadlines = new Map<string, AbortController>()

  readonly #deliveryLock = new Mutex()

  #rendererHostDeliveryPaused = false

  #rendererHostDeliveryBoundary: object | null = null

  readonly #semanticAcknowledgements = new Map<string, SemanticAcknowledgement>()

  /** Responses whose renderer generation was fenced because the user locally took the floor. */
  readonly #localSpeechInterruptedResponses = new Map<string, null>()

  /** Provider-visible progress events and their owners, bounded in provider-ledger order. */
  readonly #delegateHostEvents = new Map<string, string>()

  /** Best-effort provider cleanup is observed so it cannot reject outside service ownership. */
  readonly #providerRetirementTasks = new Set<Promise<void>>()

  readonly #providerRetirementEventIds = new Set<string>()

  /** Exact standalone delegation acknowledgements superseded by their own terminal handoff. */
  readonly #semanticAcknowledgementReleaseTasks = new Set<Promise<void>>()

  /**
   * Slots promised to calls admitted but not yet acknowledged.
   *
   * Counted against the same bound as the acknowledgements themselves, so two calls admitted back to
   * back cannot both be promised a slot only one of them can have.
   */
  #semanticAcknowledgementReservations = 0

  /**
   * `(epoch, response)` keys whose playback the user demonstrably heard.
   *
   * Proof rather than assumption: an acknowledgement is only suppressed as already-said when there is
   * a record of the turn carrying it having actually been played.
   */
  readonly #originDeliveryProofs = new Map<string, null>()

  /** The acknowledgement bound to one provider response, if it is the one being spoken. */
  semanticAcknowledgementFor(responseId: string): string | null {
    for (const current of this.#semanticAcknowledgements.values()) {
      if (current.phase === 'bound' && current.response_id === responseId) return current.event_id
    }
    return null
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
    options: HostItemOptions = {},
  ): void {
    if (this.#ports.clearingConversation()){void options.onNotDelivered?.().catch(()=>this.#ports.onDiagnostic('[realtime-diagnostic] hostitem_disposition_failed'));return}
    const priority = options.priority ?? 50
    const preemptive = options.preemptive ?? false
    const preemptiveAlert = options.preemptiveAlert ?? false
    const effectivePriority = Math.min(priority, USER_PRIORITY - 1)
    const preemptiveAlertDelegateId = options.preemptiveAlertDelegateId ?? null
    const preemptiveAlertActivation: PreemptiveAlertActivationAuthority | null = preemptiveAlertDelegateId === null
      ? null
      : {
        delegate_id: preemptiveAlertDelegateId,
        event_id: intent.item.event_id,
        source_epoch: this.session.sessionEpoch,
      }
    this.#ports.telemetry?.record('hostitem.queued', {event_id: intent.item.event_id})
    this.#hostItemSeq += 1
    const queued: QueuedHostResponse = {
      ...(options.stillWanted?{stillWanted:options.stillWanted}:{}),
      ...(options.onNotDelivered?{onNotDelivered:options.onNotDelivered}:{}),
      sortKey: [-effectivePriority, preemptive ? -1 : 0, this.#hostItemSeq],
      intent,
      priority: effectivePriority,
      preemptive,
      preemptive_alert: preemptiveAlert,
      seq: this.#hostItemSeq,
      queued_at: this.#ports.clock.now(),
      semantic_event_id: options.semanticEventId ?? null,
      preemptive_alert_activation: preemptiveAlertActivation,
      owner: options.owner ?? null,
      expires_at: options.expiresAt ?? null,
    }
    if (this.#codingProgressHostEventIds.has(intent.item.event_id)) this.#codingProgressQueued.add(queued)
    heapPush(this.#hostItems, queued)
    if (preemptive) this.#armPreempt(effectivePriority)
    this.#ports.wake()
  }

  requeueHostItem(queued: QueuedHostResponse): void {
    this.#ports.telemetry?.record('hostitem.queued', {event_id: queued.intent.item.event_id})
    heapPush(this.#hostItems, queued)
    if (queued.preemptive) this.#armPreempt(queued.priority)
    this.#ports.wake()
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

  /** Generic urgent items need the legacy priority band; monitor alerts carry explicit policy authority. */
  #preemptEligible(queued: QueuedHostResponse): boolean {
    return queued.preemptive && (queued.preemptive_alert || queued.priority >= PREEMPT_MIN_PRIORITY)
  }

  hasEligiblePreempt(): boolean {
    return this.#hostItems.some(queued => this.#preemptEligible(queued))
  }

  /**
   * Arbitrate a preemptive host item against whatever the agent is saying.
   *
   * Every early return here is a reason *not* to interrupt, and they are checked before any preemptive alert
   * state is touched so the ordinary path never reaches the unported arbitration.
   */
  async #maybePreemptLocked(): Promise<void> {
    if (!this.hasEligiblePreempt()) return
    if (this.session.floor.state === 'user_speaking') return
    if (this.session.foregroundIdle) return
    if (this.#urgentHostResponseOwner !== null) return
    if (this.#preemptiveAlert !== null) return
    const queued = this.#hostItems
      .filter(candidate => this.#preemptEligible(candidate))
      .sort(compareQueuedHostResponses)
      .at(0)
    if (queued === undefined) return

    this.#preemptiveAlertToken += 1
    const preemption: PreemptiveAlert = {
      token: this.#preemptiveAlertToken,
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
    this.#preemptiveAlert = preemption
    // Armed before the await: the provider may never confirm the cancel, and the deadline is what
    // stops the alert waiting behind a turn that will not stop.
    const abort = new AbortController()
    this.#preemptiveAlertAbort = abort
    void this.#firePreemptiveAlertDeadline(preemption)
    this.#ports.telemetry?.record('guard.preempt_started', {})
    let preempted: boolean
    try {
      preempted = await this.session.hostPreempt()
    } catch (cause) {
      // The preemption never happened, so its deadline must not fire against a session that is still
      // speaking normally.
      this.clearPreemptiveAlert(preemption.token)
      throw cause
    }
    if (!preempted) {
      this.clearPreemptiveAlert(preemption.token)
      return
    }
    // The session may have learned the response id only while preempting -- a turn that was still
    // starting when the alert arrived.
    const responseId = this.session.activeProviderResponseId
    const current = this.#preemptiveAlert
    if (
      responseId !== null
      && current !== null
      && current.token === preemption.token
      && this.session.providerTurnPhase(responseId) === 'cancel_requested'
    ) {
      if (current.old_response_id === null) {
        this.#preemptiveAlert = {...current, old_response_id: responseId}
      }
      this.recordPreemptiveAlertCancelSent(responseId)
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
      if (this.#executorApprovalBlocksSemanticAcknowledgement(queued)) break
      if (!this.#queuedHostItemEligible(queued)) {
        heapPop(this.#hostItems);await this.#notDelivered(queued)
        if (queued.preemptive) this.#recomputePreemptPriority()
        continue
      }
      const preemptiveOverlap = this.#preemptiveAlertOverlapAllowed(queued)
      const ordinaryDelivery = this.session.foregroundIdle && this.session.floor.state === 'idle'
      if (!preemptiveOverlap && !ordinaryDelivery) break
      heapPop(this.#hostItems)
      const userActivation = this.#preemptiveAlertActivationRequired(queued)
      let eligibilityRevoked = false
      const responseAllowed = (): boolean => {
        const eligible = this.#queuedHostItemEligible(queued)
        if (!eligible) eligibilityRevoked = true
        return eligible
      }
      let delivery
      try {
        if (userActivation) {
          // A reconnected session will not speak until something user-shaped arrives, so a preemptive-alert fact
          // crossing a reconnect has to carry that activation or it lands in a session that never
          // responds.
          delivery = await this.session.deliverHostResponse(queued.intent, {
            responseAllowed,
            asUserActivation: true,
          })
        } else if (preemptiveOverlap) {
          const preemption = this.#preemptiveAlert
          // Only a permit-consuming preemption gets a confirmation timeout: it is speaking into a
          // session created for it, where waiting indefinitely would strand the alert.
          const confirmationTimeout = preemption !== null
            && preemption.reconnect_permit_consumed
            && preemption.event_id === queued.intent.item.event_id
            ? 0.5
            : null
          delivery = confirmationTimeout === null
            ? await this.session.deliverPreemptiveHostResponse(queued.intent, {responseAllowed})
            : await this.session.deliverPreemptiveHostResponse(queued.intent, {
              confirmationTimeout,
              responseAllowed,
            })
        } else {
          delivery = await this.session.deliverHostResponse(queued.intent, {responseAllowed})
        }
      } catch (cause) {
        // Preserve the item after transport failure; a response may already have been requested.
        // Later queue invalidation must not claim this uncertain delivery was never sent.
        this.#uncertainQueuedDeliveries.add(queued)
        if(queued.intent.kind!=='task_continuation'||!(cause instanceof ResponseRequestUncertainError))heapPush(this.#hostItems, queued)
        else if(queued.preemptive)this.#recomputePreemptPriority()
        throw cause
      }
      const delivered = delivery.accepted
      if (
        !delivered
        && eligibilityRevoked
        && delivery.injectionEpoch === this.session.sessionEpoch
      ) {
        await this.retireProviderHostEventNow(queued.intent.item.event_id)
        await this.#notDelivered(queued)
      }
      if (delivered && userActivation) {
        this.#providerEpochNeedingActivation = null
        this.#providerReconnectSourceEpoch = null
      }
      if (queued.preemptive) this.#recomputePreemptPriority()
      if (
        delivered
        && queued.preemptive
        && !this.#ports.stopped()
        && !this.#ports.providerFailed()
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
        this.#ports.telemetry?.record('hostitem.injected', {event_id: queued.intent.item.event_id})
        // One delivery per pass: the floor state this loop tested is now stale, and the next pass
        // re-reads it rather than assuming the item just injected left the floor unchanged.
        break
      }
    }
  }

  /** Revalidate lifecycle eligibility at the final provider boundary. */
  #queuedHostItemEligible(queued: QueuedHostResponse): boolean {
    if(queued.stillWanted&&!queued.stillWanted())return false
    const eventId = queued.intent.item.event_id
    if (this.#codingProgressQueued.has(queued) && !this.#codingProgressHostEventIds.has(eventId)) return false
    if (eventId.startsWith('intake:') && this.#ports.intakeFactEligible(eventId, this.session.sessionEpoch) !== true) return false
    if (eventId.startsWith('approval:') && !this.#ports.approvalHost.factEligible(eventId)) return false
    if (queued.semantic_event_id !== null) {
      const acknowledgement = this.#semanticAcknowledgements.get(queued.semantic_event_id)
      if (
        acknowledgement?.phase === 'cancelled'
        || acknowledgement?.phase === 'delivered'
      ) return false
    }
    if (queued.owner !== null) {
      const state = this.session.delegateState(queued.owner.delegate_id)
      if (state !== undefined && state !== 'running') return false
    }
    return queued.expires_at === null || this.#ports.clock.now() < queued.expires_at
  }

  /** A pending permission question owns the foreground ahead of any generic startup receipt. */
  #executorApprovalBlocksSemanticAcknowledgement(queued: QueuedHostResponse): boolean {
    return this.#ports.approvalHost.blocksSemanticAcknowledgement(queued.semantic_event_id)
  }

  /** Whether this queued item is the captured preemptive alert the current handoff is waiting to deliver. */
  #preemptiveAlertOverlapAllowed(queued: QueuedHostResponse): boolean {
    const preemption = this.#preemptiveAlert
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
   * A reconnected provider session will not speak until something user-shaped arrives, so a preemptive alert
   * fact that crosses a reconnect has to carry that activation or it is delivered into a session
   * that never responds.
   */
  #preemptiveAlertActivationRequired(queued: QueuedHostResponse): boolean {
    const authority = queued.preemptive_alert_activation
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

  /** Queue one acknowledgement as a host fact, unless it is already queued or already said. */
  #queueSemanticAcknowledgement(acknowledgement: SemanticAcknowledgement): void {
    if (
      acknowledgement.phase === 'requested'
      || acknowledgement.phase === 'bound'
      || acknowledgement.phase === 'delivered'
      || acknowledgement.phase === 'cancelled'
    ) {
      return
    }
    if (this.#hostItems.some(queued => queued.semantic_event_id === acknowledgement.event_id)) {
      // Already waiting its turn. Marked queued rather than queued again, so the user hears it once.
      acknowledgement.phase = 'queued'
      return
    }
    const priority = this.#ports.executorPriority(acknowledgement.channel)
    acknowledgement.provider_event_id = acknowledgement.event_id
    this.queueHostItem({
      kind: 'host_fact',
      item: {
        kind: 'progress',
        host_item_id: this.#ports.idFactory(),
        event_id: acknowledgement.event_id,
        content: `${this.#ports.executorDisplayName(acknowledgement.channel)} 已提交，正在启动：${acknowledgement.summary}`,
        call_id: null,
      },
      task_summary: null,
      origin_spoken: false,
    }, {semanticEventId: acknowledgement.event_id, priority})
    acknowledgement.phase = 'queued'
  }

  /**
   * Settle the acknowledgements the response that just ended was carrying.
   *
   * Provider completion is not audible delivery. A completed turn with a live renderer generation
   * stays bound until playback reports what happened; one with no playable audio becomes a fallback.
   * A failed fallback gets one bounded retry, while a failed continuation returns to its batch.
   *
   * An origin already proven delivered is delivered regardless of the status: the user heard it, and a
   * retry would be the second telling.
   */
  finishSemanticAcknowledgement(event: {
    readonly session_epoch: number
    readonly response_id: string
    readonly status: string
  }): void {
    const bound = [...this.#semanticAcknowledgements.values()]
      .filter(current => (
        current.phase === 'bound'
        && current.response_session_epoch === event.session_epoch
        && current.response_id === event.response_id
      ))
    for (const acknowledgement of bound) {
      if (acknowledgement.origin_delivered || acknowledgement.heard) {
        this.#markAcknowledgementDelivered(acknowledgement)
        continue
      }
      if (event.status === 'completed') {
        const generation = this.session.currentGeneration
        if (
          generation?.session_epoch === event.session_epoch
          && generation.response_id === event.response_id
        ) continue
        // Only a standalone fallback owns its semantic event as a provider fact. Continuations leave
        // `provider_event_id` null in `#bindContinuation`, so this equality is the explicit ownership
        // boundary: preserve the injected fact, but return its response authority for another turn.
        if (
          acknowledgement.provider_event_id === acknowledgement.event_id
          && !this.session.reopenHostResponse(acknowledgement.event_id)
        ) {
          this.#ports.onDiagnostic('[realtime-diagnostic] semantic_ack_reopen_failed')
          continue
        }
        acknowledgement.phase = 'pending'
        acknowledgement.response_id = null
        acknowledgement.response_session_epoch = null
        acknowledgement.binding = null
        this.#queueSemanticAcknowledgement(acknowledgement)
      } else if (acknowledgement.binding === 'fallback') {
        acknowledgement.phase = 'pending'
        acknowledgement.response_id = null
        acknowledgement.response_session_epoch = null
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
        acknowledgement.response_session_epoch = null
        acknowledgement.binding = null
      }
    }
  }

  #markAcknowledgementDelivered(acknowledgement: SemanticAcknowledgement): void {
    acknowledgement.phase = 'delivered'
    acknowledgement.response_id = null
    acknowledgement.response_session_epoch = null
    acknowledgement.binding = null
  }

  /** Bind the one acknowledgement that asked for a turn to the response that will speak it. */
  bindRequestedSemanticAcknowledgement(responseId: string): void {
    for (const acknowledgement of this.#semanticAcknowledgements.values()) {
      if (acknowledgement.phase !== 'requested') continue
      acknowledgement.phase = 'bound'
      acknowledgement.response_id = responseId
      acknowledgement.response_session_epoch = this.session.sessionEpoch
      acknowledgement.provider_event_id = acknowledgement.event_id
      acknowledgement.binding = 'fallback'
      return
    }
  }

  suppressCancelledSemanticAcknowledgement(responseId: string): boolean {
    const eventIds = this.session.responseEventIds(responseId)
    const acknowledgement = [...this.#semanticAcknowledgements.values()].find(current => (
      current.phase === 'cancelled' && eventIds.includes(current.event_id)
    ))
    return acknowledgement !== undefined && this.session.suppressResponse(responseId)
  }

  fenceSemanticAcknowledgement(delegateId: string): boolean {
    const acknowledgement = this.#semanticAcknowledgements.get(`background:${delegateId}`)
    if (
      acknowledgement === undefined
      || acknowledgement.phase === 'delivered'
      || acknowledgement.phase === 'cancelled'
    ) return false
    if (
      acknowledgement.origin_delivered
      || acknowledgement.heard
      || this.session.eventWasSpoken(acknowledgement.event_id)
    ) {
      if (
        acknowledgement.phase === 'bound'
        && acknowledgement.binding === 'fallback'
        && acknowledgement.response_id !== null
        && acknowledgement.response_session_epoch === this.session.sessionEpoch
      ) {
        this.#cancelSemanticAcknowledgementResponse(
          acknowledgement.response_session_epoch,
          acknowledgement.response_id,
        )
      }
      this.#markAcknowledgementDelivered(acknowledgement)
      this.#retireSemanticAcknowledgementHostEvent(acknowledgement)
      return false
    }
    if (acknowledgement.phase === 'bound') {
      const responseId = acknowledgement.response_id
      if (responseId === null) return false
      if (!this.session.suppressResponse(responseId)) {
        if (
          acknowledgement.binding !== 'fallback'
          || acknowledgement.response_session_epoch !== this.session.sessionEpoch
        ) return false
        this.#cancelSemanticAcknowledgementResponse(
          acknowledgement.response_session_epoch,
          responseId,
        )
      }
    }
    const retained = this.#hostItems.filter(queued => (
      queued.semantic_event_id !== acknowledgement.event_id
    ))
    if (retained.length !== this.#hostItems.length) {
      retained.sort(compareQueuedHostResponses)
      this.#hostItems.length = 0
      this.#hostItems.push(...retained)
    }
    acknowledgement.phase = 'cancelled'
    acknowledgement.response_id = null
    acknowledgement.response_session_epoch = null
    acknowledgement.binding = null
    this.#retireSemanticAcknowledgementHostEvent(acknowledgement)
    return true
  }

  /** Cancel only the standalone acknowledgement that its own terminal handoff made obsolete. */
  #cancelSemanticAcknowledgementResponse(sessionEpoch: number, responseId: string): void {
    const cancellation = (async (): Promise<void> => {
      if (sessionEpoch !== this.session.sessionEpoch) return
      try {
        await this.session.quarantineResponse(responseId)
      } catch (failure) {
        this.#ports.reportDeliveryFailure(failure instanceof RealtimeDeliveryError
          ? failure
          : new RealtimeDeliveryError(String(failure)))
      } finally {
        this.#ports.wake()
      }
    })()
    const task = cancellation.finally(() => {
      this.#semanticAcknowledgementReleaseTasks.delete(task)
    })
    this.#semanticAcknowledgementReleaseTasks.add(task)
  }

  /**
   * Re-queue acknowledgements whose turn died with the old session.
   *
   * One that was requested or bound to any response was never proven audible -- the turn carrying it
   * belonged to a provider session that is gone -- so it goes back to pending and is queued again.
   * Only an acknowledgement carrying renderer-backed `heard` proof stays delivered.
   */
  reconcileSemanticAcknowledgementsAfterReconnect(): void {
    for (const acknowledgement of this.#semanticAcknowledgements.values()) {
      if (acknowledgement.heard) {
        this.#markAcknowledgementDelivered(acknowledgement)
        continue
      }
      if (
        acknowledgement.phase === 'requested'
        || acknowledgement.phase === 'bound'
      ) {
        if (acknowledgement.provider_event_id !== null) {
          this.session.reopenHostEvent(acknowledgement.provider_event_id)
        }
        acknowledgement.phase = 'pending'
        acknowledgement.response_id = null
        acknowledgement.response_session_epoch = null
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
  reopenFailedSemanticAcknowledgements(): void {
    for (const acknowledgement of this.#semanticAcknowledgements.values()) {
      if (!acknowledgement.failed_retry_consumed) continue
      if (acknowledgement.phase === 'pending') {
        this.#queueSemanticAcknowledgement(acknowledgement)
      }
    }
  }

  rememberCodingProgressHostEvent(eventId: string): void {
    this.#codingProgressHostEventIds.add(eventId)
    while (this.#codingProgressHostEventIds.size > MAX_PENDING_HOST_EVENTS) {
      this.#codingProgressHostEventIds.delete(this.#codingProgressHostEventIds.values().next().value!)
    }
  }

  /**
   * The acknowledgement for one delegated call, creating it if the ledger has room.
   *
   * Returns null rather than evicting something live: an acknowledgement still waiting to be spoken
   * is a promise to the user, and dropping one to make room for another would silently break it. Only
   * terminal entries (delivered, or cancelled before speech) are reclaimed.
   */
  #ensureSemanticAcknowledgement(state: ToolCallState): SemanticAcknowledgement | null {
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
        .find(([, current]) => (
          current.phase === 'delivered' || current.phase === 'cancelled'
        ))?.[0]
      if (deliveredId === undefined) return null
      this.#semanticAcknowledgements.delete(deliveredId)
    }
    const channel = state.acceptance.executor
    if (channel === null) return null
    const created = semanticAcknowledgement({
      event_id: eventId,
      delegate_id: delegateId,
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
  reserveSemanticAcknowledgement(): boolean {
    while (
      this.#semanticAcknowledgements.size + this.#semanticAcknowledgementReservations
      >= MAX_TRACKED_SEMANTIC_ACKNOWLEDGEMENTS
    ) {
      const deliveredId = [...this.#semanticAcknowledgements.entries()]
        .find(([, current]) => (
          current.phase === 'delivered' || current.phase === 'cancelled'
        ))?.[0]
      if (deliveredId === undefined) return false
      this.#semanticAcknowledgements.delete(deliveredId)
    }
    this.#semanticAcknowledgementReservations += 1
    return true
  }

  // ---------------------------------------------------------------------------------------------
  // Approval transport: queue delivery and exact audible-response fencing.
  /** Remove only the undelivered local queue entry; provider context has its own lifecycle. */
  removeQueuedExecutorApprovalPrompt(approvalId: string): void {
    const prefix = `approval:${approvalId}:`
    const retained = this.#hostItems.filter(queued => (
      !queued.intent.item.event_id.startsWith(prefix)
    ))
    if (retained.length !== this.#hostItems.length) {
      retained.sort(compareQueuedHostResponses)
      this.#hostItems.length = 0
      this.#hostItems.push(...retained)
      this.#recomputePreemptPriority()
    }
  }

  /** Stop/fence only the exact spoken question response while preserving its provider host fact. */
  releaseExecutorApprovalQuestion(approvalId: string): void {
    const prefix = `approval:${approvalId}:`
    const owner = this.#urgentHostResponseOwner
    if (owner?.event_id.startsWith(prefix) === true) {
      if (owner.response_id === null) {
        this.#ports.approvalHost.setResponseFencePending(
          this.session.armPendingResponseFence(),
        )
      } else {
        this.session.suppressResponse(owner.response_id)
        this.#ports.approvalHost.cancelExecutorApprovalPromptResponse(owner.session_epoch, owner.response_id)
      }
      this.releaseUrgentHostResponse(owner)
    }
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
    this.#localSpeechInterruptedResponses.delete(
      callKey(completion.session_epoch, completion.response_id),
    )
    this.#recordOriginDeliveryProof(completion)
    this.#recordSemanticAcknowledgementHeard(completion)
    this.#cancelPreemptiveAlertClearDeadline(utteranceId, generationEpoch)
    for (const eventId of eventIds) {
      // Confirmed only if it was actually spoken: a suggestion in a turn that was cut off has not been
      // offered, and marking it fired would stop it ever being offered again.
      if (eventId.startsWith('suggestion:') && this.session.eventWasSpoken(eventId)) {
        this.#ports.runtime.confirmSuggestionSpoken?.(eventId.slice('suggestion:'.length))
      }
    }
    this.releaseUrgentHostResponse(urgentOwner)
    this.#ports.wake()
    return true
  }

  /** The renderer dropped a generation on request. */
  playbackCleared(utteranceId: string, generationEpoch: number, playedMs: number | null): boolean {
    const urgentOwner = this.#urgentOwnerForGeneration(utteranceId, generationEpoch)
    const completion = this.session.completePlaybackClear(utteranceId, generationEpoch, playedMs)
    if (completion === null) return false
    const responseKey = callKey(completion.session_epoch, completion.response_id)
    const interruptedByLocalSpeech = this.#localSpeechInterruptedResponses.delete(responseKey)
    const audible = completion.played_ms === null
      ? completion.started
      : completion.played_ms > 0
    this.#reconcileAcknowledgementAfterPlaybackInterruption(
      completion.session_epoch,
      completion.response_id,
      interruptedByLocalSpeech && audible,
    )
    // The acknowledgement arrived, so the deadline waiting for it has nothing left to retire.
    this.#cancelPreemptiveAlertClearDeadline(utteranceId, generationEpoch)
    this.releaseUrgentHostResponse(urgentOwner)
    this.#ports.wake()
    return true
  }

  /** The renderer stopped playback without being asked -- a device change, or a closed window. */
  async playbackStopped(
    utteranceId: string,
    generationEpoch: number,
    playedMs: number | null,
  ): Promise<boolean> {
    const generation = this.session.currentGeneration
    const urgentOwner = this.#urgentOwnerForGeneration(utteranceId, generationEpoch)
    const namesCurrentGeneration = generation !== null
      && generation.utterance_id === utteranceId
      && generation.generation_epoch === generationEpoch
    const stopping = this.session.playbackStopped(utteranceId, generationEpoch, playedMs)
    // `RealtimeSession.playbackStopped` fences and clears the renderer generation synchronously,
    // then may wait for provider cancellation. Recover acknowledgement ownership before that wait:
    // a cascaded provider can emit `response_terminal(cancelled)` while the cancel promise is still
    // pending, and that terminal deliberately removes the old continuation binding.
    if (namesCurrentGeneration) {
      this.#localSpeechInterruptedResponses.delete(
        callKey(generation.session_epoch, generation.response_id),
      )
      this.#reconcileAcknowledgementAfterPlaybackInterruption(
        generation.session_epoch,
        generation.response_id,
      )
    }
    const stopped = await stopping
    if (!stopped) return false
    this.#cancelPreemptiveAlertClearDeadline(utteranceId, generationEpoch)
    this.releaseUrgentHostResponse(urgentOwner)
    this.#ports.wake()
    return true
  }

  /** The renderer transport vanished, so no current or imminent response may keep speaking. */
  async playbackDisconnected(
    options: {readonly resumeDelivery?: boolean} = {},
  ): Promise<boolean> {
    // Set before the first await so a concurrent host event cannot use the renderer boundary as a
    // chance to start speech that no authenticated renderer can play.
    const boundary = {}
    this.#rendererHostDeliveryBoundary = boundary
    this.#rendererHostDeliveryPaused = true
    try {
      const releasedUserHold = this.session.releaseRendererUserHold()
      const generation = this.session.currentGeneration
      let fenced: boolean
      if (generation !== null) {
        fenced = await this.playbackStopped(
          generation.utterance_id,
          generation.generation_epoch,
          null,
        )
      } else {
        fenced = await this.session.rendererDisconnected()
      }
      return fenced || releasedUserHold
    } finally {
      if (
        options.resumeDelivery === true
        && this.#rendererHostDeliveryBoundary === boundary
      ) {
        this.#rendererHostDeliveryPaused = false
        this.#ports.wake()
      }
    }
  }

  /** Return an interrupted, unheard acknowledgement to the live delegate that still owns it. */
  #reconcileAcknowledgementAfterPlaybackInterruption(
    sessionEpoch: number,
    responseId: string,
    suppressReplay = false,
  ): void {
    for (const acknowledgement of this.#semanticAcknowledgements.values()) {
      if (
        acknowledgement.phase !== 'bound'
        || acknowledgement.response_session_epoch !== sessionEpoch
        || acknowledgement.response_id !== responseId
        || acknowledgement.heard
      ) continue
      if (suppressReplay) {
        // The renderer supplied audible evidence and local VAD says the user took the floor. The
        // acknowledgement was interrupted rather than fully heard, but replaying the same sentence
        // over the user's next turn is worse than retiring it. Device/window stops never enter here.
        acknowledgement.phase = 'cancelled'
        acknowledgement.response_id = null
        acknowledgement.response_session_epoch = null
        acknowledgement.binding = null
        this.#retireSemanticAcknowledgementHostEvent(acknowledgement)
        continue
      }
      if (this.session.delegateState(acknowledgement.delegate_id) !== 'running') {
        acknowledgement.phase = 'cancelled'
        acknowledgement.response_id = null
        acknowledgement.response_session_epoch = null
        acknowledgement.binding = null
        this.#retireSemanticAcknowledgementHostEvent(acknowledgement)
        continue
      }
      if (
        acknowledgement.provider_event_id === acknowledgement.event_id
        && !this.session.reopenHostResponse(acknowledgement.event_id)
      ) {
        this.#ports.onDiagnostic('[realtime-diagnostic] semantic_ack_reopen_failed')
        continue
      }
      acknowledgement.phase = 'pending'
      acknowledgement.response_id = null
      acknowledgement.response_session_epoch = null
      acknowledgement.binding = null
      this.#queueSemanticAcknowledgement(acknowledgement)
    }
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
    if (!this.#ports.originCanReferenceProof(key)) return
    this.#originDeliveryProofs.delete(key)
    this.#originDeliveryProofs.set(key, null)
    this.#pruneOriginDeliveryProofs()
  }

  /** Persist renderer-backed audibility for the acknowledgement bound to this exact provider turn. */
  #recordSemanticAcknowledgementHeard(completion: PlaybackCompletion): void {
    const audible = completion.played_ms === null
      ? completion.started
      : completion.played_ms > 0
    if (completion.disposition !== 'spoken' || !audible) return
    for (const acknowledgement of this.#semanticAcknowledgements.values()) {
      if (
        acknowledgement.phase !== 'bound'
        || acknowledgement.response_session_epoch !== completion.session_epoch
        || acknowledgement.response_id !== completion.response_id
      ) continue
      acknowledgement.heard = true
      this.#markAcknowledgementDelivered(acknowledgement)
      this.#retireSemanticAcknowledgementHostEvent(acknowledgement)
    }
  }

  rememberDelegateHostEvent(delegateId: string, eventId: string): void {
    this.#delegateHostEvents.delete(eventId)
    this.#delegateHostEvents.set(eventId, delegateId)
    while (this.#delegateHostEvents.size > MAX_PENDING_HOST_EVENTS) {
      const oldest = this.#delegateHostEvents.keys().next()
      if (oldest.done) break
      this.#delegateHostEvents.delete(oldest.value)
    }
  }

  retireDelegateHostEvents(delegateId: string): void {
    for (const [eventId, owner] of [...this.#delegateHostEvents]) {
      if (owner !== delegateId) continue
      this.#delegateHostEvents.delete(eventId)
      this.#codingProgressHostEventIds.delete(eventId)
      this.retireProviderHostEvent(eventId)
    }
  }

  #retireSemanticAcknowledgementHostEvent(
    acknowledgement: SemanticAcknowledgement,
  ): void {
    const eventId = acknowledgement.provider_event_id
    if (eventId !== null) this.retireProviderHostEvent(eventId)
  }

  /** Provider deletion is defense in depth; queue eligibility remains the correctness boundary. */
  retireProviderHostEvent(eventId: string): void {
    if (this.#providerRetirementEventIds.has(eventId)) return
    this.#providerRetirementEventIds.add(eventId)
    const task = this.session.retireHostEvent(eventId)
      .then(() => undefined)
      .catch((failure: unknown) => {
        this.#ports.onDiagnostic(
          `[realtime-diagnostic] host_item_retire_failure type=${diagnosticName(failure)}`,
        )
      })
      .finally(() => {
        this.#providerRetirementEventIds.delete(eventId)
        this.#providerRetirementTasks.delete(task)
      })
    this.#providerRetirementTasks.add(task)
  }

  /** Injection just completed, so perform a fresh lookup even if an earlier best-effort miss exists. */
  async retireProviderHostEventNow(eventId: string): Promise<void> {
    try {
      await this.session.retireHostEvent(eventId)
    } catch (failure) {
      this.#ports.onDiagnostic(
        `[realtime-diagnostic] host_item_retire_failure type=${diagnosticName(failure)}`,
      )
    }
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
        if (!this.#ports.originHasNonterminalReference(key)) {
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

  /**
   * Deliver the exact preemptive alert captured before the reconnect, independent of heap order.
   *
   * Not through the ordinary flush: the item was chosen before the session was replaced, and re-running
   * the priority comparison now could deliver something else into a session that exists solely to
   * carry this one. Removed from the heap by identity and re-heapified, rather than popped.
   */
  async deliverCapturedPreemptiveAlertLocked(queued: QueuedHostResponse): Promise<void> {
    const index = this.#hostItems.indexOf(queued)
    if (index === -1) return
    this.#hostItems.splice(index, 1)
    this.#hostItems.sort(compareQueuedHostResponses)
    const userActivation = this.#preemptiveAlertActivationRequired(queued)
    let lifecycleRevoked = false
    let delivery
    try {
      delivery = await this.session.deliverPreemptiveHostResponse(queued.intent, {
        confirmationTimeout: 0.5,
        responseAllowed: () => {
          const eligible = this.#queuedHostItemEligible(queued)
          if (!eligible) lifecycleRevoked = true
          return eligible && this.#preemptiveAlertResponseIsAllowed(queued.intent.item.event_id)
        },
        asUserActivation: userActivation,
      })
    } catch (cause) {
      this.requeueHostItem(queued)
      throw cause
    }
    if (!delivery.accepted) {
      if (lifecycleRevoked) {
        if (delivery.injectionEpoch === this.session.sessionEpoch) {
          await this.retireProviderHostEventNow(queued.intent.item.event_id)
        }
      } else {
        this.requeueHostItem(queued)
      }
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
      !this.#ports.stopped()
      && !this.#ports.providerFailed()
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
    this.#ports.telemetry?.record('hostitem.injected', {event_id: queued.intent.item.event_id})
  }

  /**
   * Whether the replacement turn may still speak.
   *
   * Checked at the moment the provider is about to create it, not when it was requested: a user who
   * started talking in between has revoked the authority, and an aborted reconnect means the session
   * this was for is gone.
   */
  #preemptiveAlertResponseIsAllowed(eventId: string): boolean {
    const preemption = this.#preemptiveAlert
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
  bindUrgentHostResponse(event: {
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
  finishPreemptiveAlertFirstAudio(event: {
    readonly session_epoch: number
    readonly response_id: string
  }): void {
    const preemption = this.#preemptiveAlert
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
    this.clearPreemptiveAlert(token)
    if (
      this.#ports.controlledPreemptiveAlertReconnect
      && preemption.reconnect_permit_consumed
      && preemption.old_generation !== null
    ) {
      this.startPreemptiveAlertClearDeadline(preemption.old_generation)
    }
    this.#ports.telemetry?.record('guard.first_audio_switch', {
      elapsed_ms: Math.max(0, Math.round((this.#ports.clock.now() - preemption.queued_at) * 1_000)),
    })
  }

  /**
   * Stop waiting for the provider to confirm the cancel.
   *
   * The provider was asked to stop and has not said it did. Past the deadline the host acts as though
   * it had -- the alternative is the user hearing the old turn continue while an urgent alert waits
   * behind it, which is the failure preemption exists to prevent.
   */
  async #firePreemptiveAlertDeadline(preemption: PreemptiveAlert): Promise<void> {
    try {
      const delay = Math.max(
        0,
        preemption.queued_at + PREEMPTIVE_ALERT_DEADLINE_S - this.#ports.clock.now(),
      )
      await this.#ports.clock.sleep(delay, this.#preemptiveAlertAbort?.signal)
      const current = this.#preemptiveAlert
      // Re-read, never trusted: the preemption this timer belongs to may have resolved, been replaced,
      // or already fired while this was sleeping.
      if (current?.token !== preemption.token || current.deadline_fired) return
      if (current.reconnect_aborted) {
        this.clearPreemptiveAlert(current.token)
        return
      }
      const controlledHandoff = current.reconnect_permit_consumed
      const expired = controlledHandoff && current.old_generation !== null
        ? this.session.alertPreemptiveAlertHandoff(current.old_generation)
        : this.session.expireHostPreempt(current.old_generation)
      if (!expired) return
      this.#preemptiveAlert = {...current, deadline_fired: true}
      if (
        this.#ports.controlledPreemptiveAlertReconnect
        && current.reconnect_permit_consumed
        && current.old_generation !== null
      ) {
        this.startPreemptiveAlertClearDeadline(current.old_generation)
      }
      this.#ports.telemetry?.record('guard.alert_deadline_fired', {})
      // Both halves are done, so nothing is left to wait for.
      if (current.replacement_terminal) this.clearPreemptiveAlert(current.token)
      this.#ports.wake()
    } catch (failure) {
      if (isAbort(failure)) return
      this.#ports.onDiagnostic(`[realtime-diagnostic] preemptive_alert_failure type=${diagnosticName(failure)}`)
    }
  }

  /**
   * End a preemption, cancelling its deadline.
   *
   * The token argument is how a caller says "only if this is still the one I mean" -- without it, a
   * late callback would clear a preemption that started after the one it belonged to.
   */
  clearPreemptiveAlert(token?: number): void {
    const current = this.#preemptiveAlert
    if (current === null || (token !== undefined && current.token !== token)) return
    this.#preemptiveAlert = null
    const abort = this.#preemptiveAlertAbort
    this.#preemptiveAlertAbort = null
    abort?.abort()
  }

  /**
   * Wait for the renderer to confirm it dropped the cleared audio.
   *
   * Keyed by generation and idempotent: the clear can be re-sent, and a second deadline for the same
   * generation would retire it twice.
   */
  startPreemptiveAlertClearDeadline(generation: PlaybackGeneration): void {
    const key = `${generation.utterance_id}:${generation.generation_epoch}`
    if (this.#preemptiveAlertClearDeadlines.has(key)) return
    const abort = new AbortController()
    this.#preemptiveAlertClearDeadlines.set(key, abort)
    void this.#retirePreemptiveAlertClearUnknown(generation, key, abort.signal)
  }

  /**
   * Give up on the renderer's clear acknowledgement.
   *
   * Retiring the generation as *unknown* rather than cleared is the honest answer: the host does not
   * know how much of it the user heard, and recording either extreme would be a claim it cannot
   * support.
   */
  async #retirePreemptiveAlertClearUnknown(
    generation: PlaybackGeneration,
    key: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.#ports.clock.sleep(PREEMPTIVE_ALERT_CLEAR_ACK_DEADLINE_S, signal)
      if (!this.session.retirePlaybackClearUnknown(generation)) return
      this.#ports.telemetry?.record('renderer_clear_unknown', {
        session_epoch: generation.session_epoch,
        generation_epoch: generation.generation_epoch,
      })
      this.#ports.wake()
    } catch (failure) {
      if (!isAbort(failure)) throw failure
    } finally {
      if (this.#preemptiveAlertClearDeadlines.get(key)?.signal === signal) {
        this.#preemptiveAlertClearDeadlines.delete(key)
      }
    }
  }

  #cancelPreemptiveAlertClearDeadline(utteranceId: string, generationEpoch: number): void {
    const key = `${utteranceId}:${generationEpoch}`
    const abort = this.#preemptiveAlertClearDeadlines.get(key)
    if (abort === undefined) return
    this.#preemptiveAlertClearDeadlines.delete(key)
    abort.abort()
  }

  /** Record how the cancelled turn actually ended, which is the only measure of whether it worked. */
  recordPreemptiveAlertCancelTerminal(event: {
    readonly session_epoch: number
    readonly response_id: string
    readonly status: string
    readonly reason: string
  }): void {
    const preemption = this.#preemptiveAlert
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
    this.#ports.telemetry?.record('provider.cancel_terminal', {
      status: event.status,
      reason_category: reasonCategory,
      success,
      elapsed_ms: Math.max(0, Math.round((this.#ports.clock.now() - preemption.queued_at) * 1_000)),
    })
  }

  /** Note that the cancel actually reached the provider. Once per preemption. */
  recordPreemptiveAlertCancelSent(responseId: string): void {
    const preemption = this.#preemptiveAlert
    if (
      preemption?.session_epoch !== this.session.sessionEpoch
      || preemption.old_response_id !== responseId
      || preemption.cancel_sent
    ) {
      return
    }
    this.#preemptiveAlert = {...preemption, cancel_sent: true}
    this.#ports.telemetry?.record('provider.cancel_sent', {
      elapsed_ms: Math.max(0, Math.round((this.#ports.clock.now() - preemption.queued_at) * 1_000)),
    })
  }

  /**
   * The replacement turn has ended.
   *
   * Half of the two-sided finish: the preemption is over when the replacement has finished *and* the
   * old turn has been dealt with. Whichever arrives second does the clearing.
   */
  markPreemptiveAlertReplacementTerminal(owner: UrgentHostResponseOwner | null): void {
    const preemption = this.#preemptiveAlert
    if (
      owner === null
      || preemption?.event_id !== owner.event_id
      || preemption.session_epoch !== owner.session_epoch
    ) {
      return
    }
    const marked = {...preemption, replacement_terminal: true}
    this.#preemptiveAlert = marked
    if (marked.deadline_fired) this.clearPreemptiveAlert(marked.token)
  }

  /**
   * Release an urgent item that was fenced before it ever started.
   *
   * A fence receipt naming it means the provider never began the response carrying it. Holding the
   * owner would block every later preemption behind one that is never going to speak.
   */
  retireFencedPrestartUrgent(): void {
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
    this.releaseUrgentHostResponse(owner)
  }

  urgentOwnerForResponse(sessionEpoch: number, responseId: string): UrgentHostResponseOwner | null {
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
  releaseUrgentHostResponse(owner: UrgentHostResponseOwner | null): void {
    const current = this.#urgentHostResponseOwner
    if (
      owner !== null
      && current !== null
      && current.delivery_token === owner.delivery_token
    ) {
      this.#urgentHostResponseOwner = null
    }
  }

  releaseUrgentHostResponseForEpoch(sessionEpoch: number): void {
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

  /** Stand in for preemptive-alert delivery that would normally create an urgent owner. */
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
        preemptive_alert: false,
        seq: 0,
        queued_at: 0,
        semantic_event_id: null,
        preemptive_alert_activation: null,
        owner: null,
        expires_at: null,
      },
      response_id: input.responseId,
      generation: null,
    }
  }

  get urgentOwnerForTest(): UrgentHostResponseOwner | null {
    return this.#urgentHostResponseOwner
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
