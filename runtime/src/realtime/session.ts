/**
 * The realtime session: one provider conversation, reduced.
 *
 * Ported from `src/nova_audio_agent/realtime/session.py`. The state half lives in
 * `session-state.ts`; this file is the decisions. `accept` is the centre of it -- a reducer over
 * normalized provider events whose guards decide, for each event, whether it may take the provider
 * slot, reach the renderer, or count as user input at all.
 *
 * Two ideas run through every guard. **Authority** is the right to be heard: a response earns it by
 * taking the provider slot and loses it to a fence, and holding the slot is not the same as holding
 * authority. **Epoch** scopes provider-allocated identity: a reconnect starts a new one, and an id
 * from the old session must never satisfy a check in the new one.
 *
 * Every guard here is pinned by a scenario in `fixtures/realtime/session/v1/`, exported from the
 * Python oracle. When changing one, delete it and confirm a named scenario goes red; a guard no
 * scenario distinguishes is either dead or a hole in the fixture set.
 */

import type { Clock } from '../clock.js'
import { Floor } from '../floor.js'
import { USER_PRIORITY } from '../memory.js'
import {codePointLengthLikePython} from '../python-text.js'
import type {
  PlaybackCompletion,
  PlaybackGeneration,
  PlaybackRegistry,
} from '../playback.js'
import { packRecoveryTurns, type RecoveryTurn } from './history.js'
import {
  ItemDeliveryUncertainError,
  MAX_REALTIME_TEXT,
  hostFact,
  type HostContextItem,
  type HostResponseIntent,
  type RealtimeProviderEvent,
} from './protocol.js'
import {
  MAX_CONTINUATION_TASK_SUMMARY,
  RealtimeSessionState,
  truncateCaption as truncateCaptionText,
  type CaptionFrame,
  type RealtimeSnapshot,
} from './session-state.js'

/** A host response the session asked for and could not deliver. */
export class RealtimeDeliveryError extends Error {}

/** What a fence took away from the host, so the caller can put it back in the queue. */
export interface FenceInterruption {
  readonly session_epoch: number
  readonly event_ids: readonly string[]
}

export interface HostResponseDelivery {
  readonly accepted: boolean
  readonly injectionEpoch: number | null
}

/** Just enough of the provider port for the session; the adapter implements more. */
export interface SessionProvider {
  connect(options: {readonly tools: readonly Record<string, unknown>[]}): Promise<{
    readonly epoch: number
  }>
  reconnect?(tools: readonly Record<string, unknown>[]): Promise<{readonly epoch: number}>
  injectHostItem(
    item: HostContextItem,
    options?: {
      readonly confirmationTimeout?: number | null
      readonly asUserActivation?: boolean
    },
  ): Promise<{
    readonly session_epoch: number
    readonly host_item_id: string
    readonly provider_item_id?: string
  }>
  retireHostItem?(providerItemId: string): Promise<boolean>
  createResponse(intent: HostResponseIntent): Promise<void>
  ensureResponse?(): Promise<void>
  cancelResponse(responseId: string): Promise<void>
  close(): Promise<void>
}

export interface RealtimeSessionOptions {
  readonly provider: SessionProvider
  readonly playback: PlaybackRegistry
  /** Allocates host-owned ids: recovery items, packed history, and playback generations. */
  readonly idFactory: () => string
  readonly clock: Clock
  readonly onSpoken?: (text: string) => void
  readonly onDelivery?: (completion: PlaybackCompletion) => void
  /** Where a diagnostic goes. Defaults to stdout, which is what the oracle captures. */
  readonly onDiagnostic?: (line: string) => void
}

export class RealtimeSession {
  readonly #state = new RealtimeSessionState()
  readonly #provider: SessionProvider
  readonly #playback: PlaybackRegistry
  readonly #idFactory: () => string
  readonly #clock: Clock
  readonly #onSpoken: (text: string) => void
  readonly #onDelivery: (completion: PlaybackCompletion) => void
  readonly #onDiagnostic: (line: string) => void

  #floor = new Floor()
  #userHoldSince: number | null = null
  #awaitingUserResponse = false
  #fenceNextResponse = false
  #fenceInterruption: FenceInterruption | null = null
  #providerResponseId: string | null = null
  #hostPreemptResponseId: string | null = null
  #hostPreemptPending = false
  #providerTranscript = ''
  #guardHandoffGeneration: PlaybackGeneration | null = null
  /** The generation a Guard handoff may retain: only the most recent one can be handed off. */
  #lastOpenedGeneration: PlaybackGeneration | null = null
  readonly #responseItems = new Map<string, readonly HostContextItem[]>()

  constructor(options: RealtimeSessionOptions) {
    this.#provider = options.provider
    this.#playback = options.playback
    this.#idFactory = options.idFactory
    this.#clock = options.clock
    this.#onSpoken = options.onSpoken ?? noop
    this.#onDelivery = options.onDelivery ?? noop
    this.#onDiagnostic = options.onDiagnostic
      ?? ((line: string): void => {
        process.stdout.write(`${line}\n`)
      })
  }

  // ---------------------------------------------------------------------------
  // Observable state
  // ---------------------------------------------------------------------------

  get floor(): Floor {
    return this.#floor
  }

  get sessionEpoch(): number {
    return this.#state.sessionEpoch
  }

  get userInputRevision(): number {
    return this.#state.userInputRevision
  }

  get activeProviderResponseId(): string | null {
    return this.#providerResponseId
  }

  get currentGeneration(): PlaybackGeneration | null {
    return this.#playback.current
  }

  /** No provider inference is outstanding, whatever the renderer is still playing. */
  get providerIdle(): boolean {
    return (
      this.#state.pendingResponseCount === 0
      && !this.#awaitingUserResponse
      && this.#providerResponseId === null
    )
  }

  /** Provider idle *and* nothing audible, which is what a non-preemptive host item waits for. */
  get foregroundIdle(): boolean {
    return (
      this.providerIdle
      && this.#playback.current === null
      && !this.#playback.hasUnreportedFence
    )
  }

  providerTurnPhase(responseId: string | null): string | undefined {
    return this.#state.providerTurnPhase(responseId)
  }

  providerTurnUserInputRevision(responseId: string | null): number | undefined {
    return this.#state.providerTurnUserInputRevision(responseId)
  }

  providerTurnWasFenced(responseId: string | null): boolean {
    return this.#state.providerTurnWasFenced(responseId)
  }

  responseEventIds(responseId: string): readonly string[] {
    return (this.#responseItems.get(this.#turnKey(responseId)) ?? []).map(item => item.event_id)
  }

  responseHasSpoken(responseId: string | null): boolean {
    return responseId !== null && responseId === this.#spokenResponseId
  }

  /**
   * Give the host sole speech ownership of a provider response before it emits audio.
   *
   * Once a generation exists, provider audio has already crossed the attribution boundary even if
   * the renderer has not acknowledged it yet. Refuse the transfer in that case rather than creating
   * two competing owners for one turn.
   */
  suppressResponse(responseId: string): boolean {
    const generation = this.#playback.current
    if (
      this.responseHasSpoken(responseId)
      || (generation !== null && generation.response_id === responseId)
    ) return false
    this.#state.suppressResponse(responseId)
    return true
  }

  /** Revoke a response that belongs to a host-settled decision, even before its id is known. */
  async quarantineActiveOrAwaitingResponse(): Promise<boolean> {
    return this.#fenceAndCancelActiveResponse()
  }

  eventWasSpoken(eventId: string): boolean {
    return this.#state.eventWasSpoken(eventId)
  }

  hostEventIsDeduplicated(eventId: string): boolean {
    return this.#state.hostEventIsDeduplicated(eventId)
  }

  snapshot(): RealtimeSnapshot {
    return this.#state.snapshot()
  }

  get userCaption(): string {
    return this.#state.userCaption
  }

  get assistantCaption(): string {
    return this.#state.assistantCaption
  }

  #spokenResponseId: string | null = null

  /**
   * Take the fence interruption, if any. Reading it clears it.
   *
   * A fence takes a host response away before it was heard; the caller has to learn that exactly
   * once so it can re-queue the events, which is why this is destructive.
   */
  takeFenceInterruption(): FenceInterruption | null {
    const interruption = this.#fenceInterruption
    this.#fenceInterruption = null
    return interruption
  }

  /**
   * Fence the next provider response before it can own playback.
   *
   * Repeated arming is deliberately idempotent, so one interruption cannot consume several
   * responses. Confirmation uses the narrower pending-only wrapper below.
   */
  armNextResponseFence(): void {
    if (this.#fenceNextResponse) return
    if (this.#state.pendingResponseCount > 0) this.#markHeadPendingFenced()
    this.#fenceNextResponse = true
    this.#state.advanceSnapshot()
  }

  /** Fence an already-requested host response, without consuming the user's next response. */
  armPendingResponseFence(): boolean {
    if (this.#fenceNextResponse) return true
    if (this.#state.pendingResponseCount === 0) return false
    this.#markHeadPendingFenced()
    this.#fenceNextResponse = true
    this.#state.advanceSnapshot()
    return true
  }

  // ---------------------------------------------------------------------------
  // Provider session lifecycle
  // ---------------------------------------------------------------------------

  async connect(options: {readonly tools: readonly Record<string, unknown>[]}): Promise<void> {
    const identity = await this.#provider.connect({tools: options.tools})
    // The epoch must strictly increase; a provider that reuses one would let old ids satisfy
    // dedup checks in the new session.
    this.#state.beginEpoch(identity.epoch)
  }

  /**
   * Replace the provider session, giving up everything the old one authorized.
   *
   * A reconnect is not a resume. Every provider-allocated identity dies with the epoch, so the
   * new session is told what happened in a recovery item rather than being expected to remember.
   * A response that never happened has its host event answer withdrawn, because it must be
   * answerable again -- whereas one that completed stays answered, since the user heard it.
   */
  async reconnect(options: {readonly tools: readonly Record<string, unknown>[]}): Promise<void> {
    this.#guardHandoffGeneration = null
    const interruptedResponseIds: string[] = []
    const generation = this.#playback.fenceCurrent()
    if (generation !== null && generation.session_epoch === this.sessionEpoch) {
      interruptedResponseIds.push(generation.response_id)
    }
    if (
      this.#providerResponseId !== null
      && !interruptedResponseIds.includes(this.#providerResponseId)
    ) {
      interruptedResponseIds.push(this.#providerResponseId)
    }
    for (const responseId of interruptedResponseIds) {
      this.#markLocallyFenced(responseId)
      this.#markResponseInterrupted(responseId)
      this.#finishResponseAuthority(responseId)
    }
    this.#state.revokeRetainedSuggestionInjections()
    this.#abandonPendingResponses()
    this.#resetForNewProviderSession()
    // A reconnect must not inherit an orphaned floor hold from the old epoch.
    this.#floor = new Floor()
    this.#userHoldSince = null

    const identity = await this.#replaceProviderSession(options.tools)
    this.#state.beginEpoch(identity.epoch)
    await this.#injectRecoveryItem(null)
    this.#state.advanceSnapshot()
  }

  /**
   * Replace provider authority while retaining one exact renderer generation.
   *
   * This is the Guard handoff: the provider session underneath the user is replaced while the
   * audio they are hearing keeps playing, so there is no gap. The retained generation is the one
   * thing that survives, which is why it is validated three ways before anything is given up.
   */
  async reconnectForGuard(options: {
    readonly tools: readonly Record<string, unknown>[]
    readonly oldGeneration: PlaybackGeneration
    readonly confirmationTimeout?: number | null
    readonly history?: readonly RecoveryTurn[]
    readonly historyMode?: 'none' | 'packed'
  }): Promise<'none' | 'empty' | 'packed' | 'degraded' | 'uncertain'> {
    const {oldGeneration} = options
    const historyMode = options.historyMode ?? 'none'
    const confirmationTimeout = options.confirmationTimeout ?? null
    // Checked before any state is touched: this method closes the provider session, so a caller
    // whose input is malformed must get an error rather than an irreversible handoff. The type
    // annotation is not enough -- a value reaching here from JSON is unchecked at runtime.
    if (historyMode !== 'none' && historyMode !== 'packed') {
      throw new TypeError(`unknown Guard history recovery arm: ${String(historyMode)}`)
    }
    if (oldGeneration.session_epoch !== this.sessionEpoch) {
      throw new TypeError('guard handoff generation must belong to the current session')
    }
    if (
      this.#lastOpenedGeneration === null
      || !sameGeneration(oldGeneration, this.#lastOpenedGeneration)
    ) {
      throw new TypeError('guard handoff requires a known playback generation')
    }
    const current = this.#playback.current
    if (current !== null && !sameGeneration(current, oldGeneration)) {
      throw new TypeError('guard handoff generation must be current')
    }

    const oldEpoch = this.sessionEpoch
    const responseIds = [oldGeneration.response_id]
    if (
      this.#providerResponseId !== null
      && !responseIds.includes(this.#providerResponseId)
    ) {
      responseIds.push(this.#providerResponseId)
    }
    for (const responseId of responseIds) {
      const turn = this.#state.providerTurn(responseId, oldEpoch)
      if (turn !== undefined) {
        turn.defer_playback_fence = false
        if (turn.phase !== 'completed' && turn.phase !== 'cancelled' && turn.phase !== 'failed') {
          turn.locally_fenced = true
          turn.phase = 'cancelled'
        }
      }
      this.#markResponseInterrupted(responseId, oldEpoch)
      this.#finishResponseAuthority(responseId, oldEpoch)
    }
    // The retained generation is interrupted from the provider's point of view even though the
    // renderer is still playing it: no more audio is coming for it.
    this.#playback.markProviderTerminal({
      sessionEpoch: oldEpoch,
      responseId: oldGeneration.response_id,
      disposition: 'interrupted',
    })
    this.#state.revokeRetainedSuggestionInjections()
    this.#abandonPendingResponses()
    this.#resetForNewProviderSession()
    // Unlike a plain reconnect, an agent_speaking floor for the retained utterance survives: it is
    // still speaking, and blanking it would let something else claim the floor mid-word.
    if (
      !(this.#floor.state === 'agent_speaking'
        && this.#floor.utteranceId === oldGeneration.utterance_id)
    ) {
      this.#floor = new Floor()
    }
    this.#userHoldSince = null
    this.#guardHandoffGeneration = oldGeneration

    const identity = await this.#replaceProviderSession(options.tools)
    this.#state.beginEpoch(identity.epoch)

    let outcome: 'none' | 'empty' | 'packed' | 'degraded' | 'uncertain' = 'none'
    if (historyMode !== 'none') outcome = 'empty'
    const history = options.history ?? []
    if (historyMode === 'packed' && history.length > 0) {
      const {content: packedContent} = packRecoveryTurns(history)
      if (packedContent === '') {
        // History existed and none of it fit, which is not the same as there being none.
        outcome = 'degraded'
      } else {
        const historyItemId = this.#idFactory()
        try {
          await this.#provider.injectHostItem(
            {
              kind: 'dialogue_context',
              host_item_id: historyItemId,
              event_id: `${historyItemId}-event`,
              content: packedContent,
              call_id: null,
            },
            {confirmationTimeout},
          )
          outcome = 'packed'
        } catch (cause) {
          // Uncertain and failed are different answers: uncertain means it may have arrived, so
          // the caller must not assume the new session is missing it.
          outcome = cause instanceof ItemDeliveryUncertainError ? 'uncertain' : 'degraded'
        }
      }
    }
    await this.#injectRecoveryItem(confirmationTimeout)
    this.#state.advanceSnapshot()
    return outcome
  }

  async #replaceProviderSession(
    tools: readonly Record<string, unknown>[],
  ): Promise<{readonly epoch: number}> {
    if (this.#provider.reconnect !== undefined) return this.#provider.reconnect(tools)
    await this.#provider.close()
    return this.#provider.connect({tools})
  }

  /** The fields that belong to one provider session and none other. */
  #resetForNewProviderSession(): void {
    this.#awaitingUserResponse = false
    this.#fenceNextResponse = false
    this.#fenceInterruption = null
    this.#providerResponseId = null
    this.#hostPreemptResponseId = null
    this.#hostPreemptPending = false
    this.#spokenResponseId = null
    this.#state.clearSuppressedResponses()
    this.#providerTranscript = ''
    this.#state.clearPremapAudio()
  }

  /** Tell the new session what the old one had been doing. */
  async #injectRecoveryItem(confirmationTimeout: number | null): Promise<void> {
    const hostItemId = this.#idFactory()
    const recovery: HostContextItem = {
      kind: 'recovery',
      host_item_id: hostItemId,
      event_id: `${hostItemId}-event`,
      content: recoveryContent(this.snapshot()),
      call_id: null,
    }
    const identity = confirmationTimeout === null
      ? await this.#provider.injectHostItem(recovery)
      : await this.#provider.injectHostItem(recovery, {confirmationTimeout})
    if (identity.session_epoch !== this.sessionEpoch) {
      throw new TypeError('recovery confirmation identity mismatch')
    }
  }

  /**
   * Give up every queued response.
   *
   * Their host events lose both their answer and their injection, because a response that never
   * happened must be answerable again in the new session.
   */
  #abandonPendingResponses(): void {
    for (const pending of this.#state.pendingResponses) {
      for (const intent of pending.intents) {
        this.#state.releaseRespondedEvent(intent.item.event_id)
        this.#state.releaseInjectedEvent(intent.item.event_id)
      }
    }
    this.#state.clearPendingResponses()
  }

  // ---------------------------------------------------------------------------
  // Host delivery
  // ---------------------------------------------------------------------------

  async deliverHostItem(item: HostContextItem): Promise<boolean> {
    const delivery = await this.deliverHostResponse(hostFact(item))
    return delivery.accepted
  }

  async deliverHostResponse(
    intent: HostResponseIntent,
    options: {
      readonly responseAllowed?: () => boolean
      readonly asUserActivation?: boolean
    } = {},
  ): Promise<HostResponseDelivery> {
    return this.#deliverHostResponse(intent, {
      allowPlaybackOverlap: false,
      confirmationTimeout: null,
      asUserActivation: options.asUserActivation ?? false,
      ...(options.responseAllowed === undefined ? {} : {responseAllowed: options.responseAllowed}),
    })
  }

  /**
   * Deliver a response that may talk over playback.
   *
   * A preemptive item waits only for the provider, not for the renderer, because the whole point is
   * to interrupt. `responseAllowed` is re-checked after injection, since injecting is awaited and
   * the reason for the response can expire while it is in flight.
   */
  async deliverPreemptiveHostResponse(
    intent: HostResponseIntent,
    options: {
      readonly confirmationTimeout?: number | null
      readonly responseAllowed?: () => boolean
      readonly asUserActivation?: boolean
    } = {},
  ): Promise<HostResponseDelivery> {
    return this.#deliverHostResponse(intent, {
      allowPlaybackOverlap: true,
      confirmationTimeout: options.confirmationTimeout ?? null,
      asUserActivation: options.asUserActivation ?? false,
      ...(options.responseAllowed === undefined ? {} : {responseAllowed: options.responseAllowed}),
    })
  }

  async #deliverHostResponse(
    intent: HostResponseIntent,
    options: {
      readonly allowPlaybackOverlap: boolean
      readonly confirmationTimeout: number | null
      readonly responseAllowed?: () => boolean
      readonly asUserActivation: boolean
    },
  ): Promise<HostResponseDelivery> {
    const item = intent.item
    if (this.#state.hostEventIsDeduplicated(item.event_id)) {
      return {accepted: false, injectionEpoch: null}
    }
    const ready = options.allowPlaybackOverlap ? this.providerIdle : this.foregroundIdle
    if (!ready) throw new RealtimeDeliveryError('foreground became busy before host delivery')

    let injectionEpoch = this.#state.injectedEventEpoch(item.event_id) ?? null
    if (item.kind === 'tool_output') {
      if (injectionEpoch === null) {
        throw new TypeError('tool output must be confirmed before response')
      }
      // A tool output from a previous epoch no longer refers to this conversation, unless it is a
      // delegation acknowledgement, which narrates work that outlived the reconnect.
      if (injectionEpoch !== this.sessionEpoch && intent.kind !== 'delegation_acknowledgement') {
        return {accepted: false, injectionEpoch}
      }
    } else if (injectionEpoch !== null && injectionEpoch !== this.sessionEpoch) {
      return {accepted: false, injectionEpoch}
    } else if (injectionEpoch === null) {
      await this.#injectHostItem(item, {
        confirmationTimeout: options.confirmationTimeout,
        asUserActivation: options.asUserActivation,
      })
      injectionEpoch = this.#state.injectedEventEpoch(item.event_id) ?? null
    }
    if (options.responseAllowed !== undefined && !options.responseAllowed()) {
      return {accepted: false, injectionEpoch}
    }
    await this.#createResponse(intent, [item.event_id])
    this.#state.queuePendingResponse({
      intents: [intent],
      provider_intent: intent,
      user_input_revision: this.userInputRevision,
    })
    return {accepted: true, injectionEpoch}
  }

  async injectToolOutput(item: HostContextItem): Promise<boolean> {
    if (item.kind !== 'tool_output') {
      throw new TypeError('only tool output can bypass host response gating')
    }
    return this.#injectHostItem(item, {confirmationTimeout: null, asUserActivation: false})
  }

  /** Request one normal provider response for the user turn that already reached transcript final. */
  async requestUserResponse(): Promise<boolean> {
    if (
      this.#provider.ensureResponse === undefined
      || this.#providerResponseId !== null
      || this.#state.pendingResponseCount > 0
      || this.#floor.state === 'user_speaking'
      || this.#playback.current !== null
      || this.#playback.hasUnreportedFence
    ) return false
    this.#awaitingUserResponse = true
    try {
      await this.#provider.ensureResponse()
      return true
    } catch (cause) {
      this.#awaitingUserResponse = false
      throw new RealtimeDeliveryError(`user response request failed: ${String(cause)}`)
    }
  }

  /** Retire one exact provider-visible host item without weakening the answered-event ledger. */
  async retireHostEvent(eventId: string): Promise<boolean> {
    const identity = this.#state.injectedProviderItem(eventId)
    if (identity?.epoch !== this.sessionEpoch) return false
    if (this.#provider.retireHostItem === undefined) return false
    let retired: boolean
    try {
      retired = await this.#provider.retireHostItem(identity.provider_item_id)
    } catch (cause) {
      throw new RealtimeDeliveryError(`host item retirement failed: ${String(cause)}`)
    }
    if (!retired) return false
    return this.#state.releaseInjectedProviderItem(eventId, identity)
  }

  /** Return an un-heard event's delivery authority after its provider session has been replaced. */
  reopenHostEvent(eventId: string): boolean {
    const responded = this.#state.releaseRespondedEvent(eventId)
    const injected = this.#state.releaseInjectedEvent(eventId)
    return responded || injected
  }

  /** Reuse one still-injected provider fact after renderer playback was interrupted. */
  reopenHostResponse(eventId: string): boolean {
    if (this.#state.injectedEventEpoch(eventId) !== this.sessionEpoch) return false
    this.#state.releaseRespondedEvent(eventId)
    return true
  }

  async #injectHostItem(
    item: HostContextItem,
    options: {readonly confirmationTimeout: number | null; readonly asUserActivation: boolean},
  ): Promise<boolean> {
    if (this.#state.injectedEventEpoch(item.event_id) !== undefined) return false
    let identity: {
      readonly session_epoch: number
      readonly host_item_id: string
      readonly provider_item_id?: string
    }
    try {
      identity = options.asUserActivation
        ? await this.#provider.injectHostItem(item, {
          confirmationTimeout: options.confirmationTimeout,
          asUserActivation: true,
        })
        : options.confirmationTimeout === null
          ? await this.#provider.injectHostItem(item)
          : await this.#provider.injectHostItem(item, {
            confirmationTimeout: options.confirmationTimeout,
          })
    } catch (cause) {
      // An uncertain delivery is not a failure: the item may have arrived, so the caller must not
      // retry it as though it had not.
      if (cause instanceof ItemDeliveryUncertainError) throw cause
      throw new RealtimeDeliveryError(`host item injection failed: ${String(cause)}`)
    }
    if (
      identity.session_epoch !== this.sessionEpoch
      || identity.host_item_id !== item.host_item_id
    ) {
      throw new TypeError('host item confirmation identity mismatch')
    }
    this.#state.recordInjectedEvent(item.event_id, identity.provider_item_id)
    return true
  }

  async #createResponse(intent: HostResponseIntent, eventIds: readonly string[]): Promise<void> {
    try {
      await this.#provider.createResponse(intent)
    } catch (cause) {
      throw new RealtimeDeliveryError(`response request failed: ${String(cause)}`)
    }
    for (const eventId of eventIds) this.#state.markEventResponded(eventId)
    this.#state.pruneHostEventLedgers(eventIds)
  }

  // ---------------------------------------------------------------------------
  // The reducer
  // ---------------------------------------------------------------------------

  /**
   * Reduce one normalized provider event. `true` means the session acted on it.
   *
   * The return value is the contract: a refusal is a decision, not an omission. Several guards
   * differ *only* in the boolean they return, which is why the fixtures record it per step.
   */
  async accept(
    event: RealtimeProviderEvent,
    options: {readonly allowResponseStartDuringUserSpeech?: boolean} = {},
  ): Promise<boolean> {
    // An event from another provider session describes a world this session no longer has.
    if (event.session_epoch !== this.sessionEpoch) return false

    switch (event.kind) {
      case 'tool_call_ready':
        return this.#acceptToolCall(event.response_id)
      case 'response_started':
        return this.#acceptResponseStarted(
          event.response_id,
          options.allowResponseStartDuringUserSpeech === true,
        )
      case 'response_audio_delta':
        return this.#acceptAudioDelta(event.response_id, event.pcm)
      case 'response_transcript_final':
        return this.#acceptTranscriptFinal(event.response_id, event.text)
      case 'response_terminal':
        return this.#acceptTerminal(event.response_id, event.status, event.session_epoch)
      case 'user_speech_started':
        return this.#acceptSpeechStarted(event.speech_id, event.provider_item_id)
      case 'user_speech_ended':
        return this.#acceptSpeechEnded(event.speech_id, event.provider_item_id)
      case 'user_transcript_final':
      case 'user_transcript_failed':
        return this.#acceptTranscriptTerminal(event.item_id, event.kind)
      default:
        // Deltas, confirmations, cancel rejections and provider errors are not this reducer's to
        // act on. Transcript deltas belong to `captionFor`; the rest belong to the layer above.
        return false
    }
  }

  #acceptToolCall(eventResponseId: string | null): boolean {
    const responseId = eventResponseId ?? this.#providerResponseId
    if (responseId !== null) {
      const turn = this.#state.providerTurn(responseId)
      if (turn !== undefined && (turn.locally_fenced || turn.phase !== 'active')) return false
    }
    if (responseId !== null && this.#responseItems.has(this.#turnKey(responseId))) {
      // Host-created responses narrate an injected fact or continue an already accepted tool
      // protocol. They never authorize a new tool.
      return false
    }
    return true
  }

  async #acceptResponseStarted(
    responseId: string,
    allowDuringUserSpeech: boolean,
  ): Promise<boolean> {
    this.#awaitingUserResponse = false
    let turn = this.#state.providerTurn(responseId)
    if (turn !== undefined && (turn.locally_fenced || turn.phase !== 'active')) return false

    if (turn !== undefined && this.#fenceNextResponse) {
      // An active recorded turn must not coexist with an armed pre-start fence: the known entry
      // was closed at the oversized-delta gate. A provider protocol violation that recreates the
      // shape is rejected loudly rather than killing the session.
      this.#onDiagnostic('[realtime-diagnostic] armed_fence_turn_conflict')
      turn.locally_fenced = true
      turn.phase = 'cancel_requested'
      if (this.#state.premapResponseId === responseId) this.#state.clearPremapAudio()
      this.#state.advanceSnapshot()
      await this.#provider.cancelResponse(responseId)
      return false
    }
    // The user holds the floor, so the queued host utterance loses its turn rather than talking
    // over them.
    if (this.#floor.state === 'user_speaking' && !allowDuringUserSpeech) {
      await this.#fencePendingResponse(responseId)
      return false
    }
    if (turn === undefined && this.#fenceNextResponse) {
      await this.#fencePendingResponse(responseId)
      return false
    }
    if (this.#providerResponseId !== null) {
      // Another response owns the slot. Fence the newcomer so a provider that reuses the id later
      // cannot reclaim a turn this session already gave up on.
      if (this.#providerResponseId !== responseId) this.#markLocallyFenced(responseId)
      return false
    }
    const premapOwner = this.#state.premapResponseId
    if (premapOwner !== null && premapOwner !== responseId) {
      // The buffer belongs to one response at a time; adopting another's audio would lose which
      // is which, so it is discarded rather than replayed into the wrong generation.
      this.#state.clearPremapAudio()
      return false
    }
    turn ??= this.#state.openProviderTurn(responseId)
    this.#providerResponseId = responseId
    this.#spokenResponseId = null
    this.#providerTranscript = ''

    const pending = this.#state.popPendingResponse()
    if (pending !== undefined) {
      this.#responseItems.set(
        this.#turnKey(responseId),
        pending.intents.map(intent => intent.item),
      )
      if (
        pending.provider_intent.origin_spoken
        && pending.user_input_revision === this.userInputRevision
      ) {
        // Provider instructions are advisory. The host's played-origin proof owns audible
        // acknowledgement -- but only for the world that response answers, which is why the
        // revision has to still match.
        this.#state.suppressResponse(responseId)
      }
    }
    const buffered = this.#state.premapAudio
    if (
      buffered.length > 0
      && !this.#state.responseIsSuppressed(responseId)
      && this.#openAudioResponse(responseId)
    ) {
      for (const pcm of buffered) {
        this.#playback.pushAudio({
          sessionEpoch: this.sessionEpoch,
          responseId,
          pcm,
        })
      }
    }
    this.#state.clearPremapAudio()
    return true
  }

  async #acceptAudioDelta(responseId: string, pcm: Uint8Array): Promise<boolean> {
    const head = this.#state.headPendingResponse
    const suppressPending = this.#providerResponseId === null
      && head !== undefined
      && head.provider_intent.origin_spoken
      && head.user_input_revision === this.userInputRevision
    if (this.#state.responseIsSuppressed(responseId) || suppressPending) {
      // Recorded rather than merely refused: the suppression has to outlive this delta so every
      // later frame from the same response is refused too.
      this.#state.suppressResponse(responseId)
      return false
    }
    if (this.#floor.state === 'user_speaking') {
      if (this.#state.pendingResponseCount > 0) await this.#fencePendingResponse(responseId)
      return false
    }
    let turn = this.#state.providerTurn(responseId)
    if (turn === undefined) {
      if (this.#fenceNextResponse) {
        await this.#fencePendingResponse(responseId)
        return false
      }
      // Nothing pending means no intent for this audio to belong to, so there is nothing to
      // buffer it against.
      if (this.#state.pendingResponseCount === 0) return false
      const premapOwner = this.#state.premapResponseId
      if (premapOwner !== null && premapOwner !== responseId) return false
      // Checked here as well as below, and the two are not redundant: this one refuses without
      // recording a turn at all, so an oversized first delta leaves no trace of the response.
      if (this.#state.premapAudioWouldExceed(pcm.byteLength)) {
        this.#state.clearPremapAudio()
        return false
      }
      turn = this.#state.openProviderTurn(responseId)
    }
    if (turn.locally_fenced || turn.phase !== 'active') return false

    if (this.#playback.pushAudio({sessionEpoch: this.sessionEpoch, responseId, pcm})) return true
    if (this.#providerResponseId === responseId) {
      if (!this.#openAudioResponse(responseId)) return false
      return this.#playback.pushAudio({sessionEpoch: this.sessionEpoch, responseId, pcm})
    }
    if (this.#state.premapAudioWouldExceed(pcm.byteLength)) {
      // Over budget means the buffered audio is unusable, not that this one delta is: a gap in
      // the middle would be worse than starting over.
      this.#state.clearPremapAudio()
      return false
    }
    this.#state.bufferPremapAudio(responseId, pcm)
    return true
  }

  #acceptTranscriptFinal(responseId: string, text: string): boolean {
    if (this.#state.responseIsSuppressed(responseId)) return false
    if (this.#playback.setTranscript({sessionEpoch: this.sessionEpoch, responseId, text})) {
      return true
    }
    const turn = this.#state.providerTurn(responseId)
    if (turn !== undefined && (turn.locally_fenced || turn.phase !== 'active')) return false
    if (this.#providerResponseId === responseId) {
      // Cached for the generation this response has not opened yet. Holding the slot is not
      // authority, which is why the fence check above still applies to a slot owner.
      this.#providerTranscript = text
      return true
    }
    // A transcript the session cannot attribute is not evidence about anything.
    return false
  }

  #acceptTerminal(
    responseId: string,
    status: 'completed' | 'cancelled' | 'failed',
    eventEpoch: number,
  ): boolean {
    const turn = this.#state.providerTurn(responseId)
    if (turn === undefined) {
      // A pre-start fence has no provider response id to cancel. If its first observable event is
      // a terminal, it consumes the one-shot fence and releases the fenced pending's inference
      // slot. Without an armed fence an unknown terminal must not touch a live pending response.
      if (this.#fenceNextResponse) {
        this.#fenceNextResponse = false
        this.#state.popPendingResponse()
      }
      return false
    }
    if (turn.phase === 'completed' || turn.phase === 'cancelled' || turn.phase === 'failed') {
      // Applied once. A retransmission must not deliver the utterance twice, and a contradictory
      // status arriving later must not reopen a decided turn.
      return false
    }
    this.#awaitingUserResponse = false
    turn.phase = status
    if (this.#providerResponseId === responseId) {
      this.#providerResponseId = null
      this.#providerTranscript = ''
    }
    if (this.#state.premapResponseId === responseId) this.#state.clearPremapAudio()

    if (status === 'completed') {
      if (this.#state.responseIsSuppressed(responseId)) {
        this.#state.releaseSuppressedResponse(responseId)
        this.#finishResponseAuthority(responseId)
        return true
      }
      this.#playback.markProviderTerminal({sessionEpoch: this.sessionEpoch, responseId})
      return true
    }

    this.#state.releaseSuppressedResponse(responseId)
    this.#markResponseInterrupted(responseId)
    const current = this.#playback.current
    if (turn.defer_playback_fence) {
      // A host preempt deferred the renderer fence, so the audio already queued keeps playing and
      // reports back rather than being cut mid-word.
      if (
        current !== null
        && current.session_epoch === eventEpoch
        && current.response_id === responseId
      ) {
        this.#playback.markProviderTerminal({
          sessionEpoch: this.sessionEpoch,
          responseId,
          disposition: 'interrupted',
        })
      } else if (!this.responseHasSpoken(responseId)) {
        this.#finishResponseAuthority(responseId)
      }
      this.#state.advanceSnapshot()
      return true
    }
    if (current?.session_epoch !== eventEpoch || current.response_id !== responseId) {
      if (!this.responseHasSpoken(responseId)) this.#finishResponseAuthority(responseId)
      return true
    }
    const generation = this.#playback.fenceCurrent()
    if (generation !== null) {
      this.#markLocallyFenced(generation.response_id)
      this.#markResponseInterrupted(generation.response_id)
      this.#state.advanceSnapshot()
    }
    return true
  }

  #acceptSpeechStarted(speechId: string, providerItemId: string | null): boolean {
    // Floor only. Fencing the renderer here would mark the origin turn locally fenced and suppress
    // dispatch of a tool call still owned by that response: a user barge-in is not an abandonment
    // of tool protocol state. The local onset detector is the renderer barge-in path.
    this.#floor = this.#floor.onUserSpeakStart(speechId)
    this.#state.acceptUserTurn(providerItemId ?? `speech:${speechId}`)
    this.#userHoldSince = this.#clock.now()
    return true
  }

  #acceptSpeechEnded(speechId: string, providerItemId: string | null): boolean {
    const before = this.#floor
    this.#floor = this.#floor.onUserSpeakEnd(speechId)
    if (providerItemId !== null) {
      // The provider reveals the turn's real item id here. Renaming rather than recording a second
      // turn is what stops the same utterance counting twice.
      this.#state.replaceUserTurnIdentity(`speech:${speechId}`, providerItemId)
    }
    if (this.#floor.state !== 'user_speaking') this.#userHoldSince = null
    // Only the speech that took the floor can release it, so a mismatched id changes nothing.
    return this.#floor !== before
  }

  #acceptTranscriptTerminal(
    itemId: string,
    kind: 'user_transcript_final' | 'user_transcript_failed',
  ): boolean {
    if (!this.#state.acceptUserTranscriptTerminal(itemId)) return false
    this.#state.acceptUserTurn(itemId)
    if (kind === 'user_transcript_failed') return true
    // A final transcript is a question the provider owes an answer to, so the session is no longer
    // idle even though no response has started.
    this.#awaitingUserResponse = true
    return true
  }

  // ---------------------------------------------------------------------------
  // Barge-in and preempt
  // ---------------------------------------------------------------------------

  /**
   * The local energy detector heard the user.
   *
   * This is a barge-in signal only: it fences the audible renderer and cancels active provider
   * inference, but never takes the user_speaking floor. Floor ownership belongs to provider VAD
   * alone -- a local random id would overwrite the provider speech id, and the matching provider
   * end could then no longer release the floor.
   */
  async localSpeechOnset(speechId: string): Promise<void> {
    // The id is accepted and discarded, exactly as the oracle does: callers have one to give, and
    // taking it keeps them from inventing a floor identity this path must not own.
    void speechId
    this.#hostPreemptPending = false
    await this.#fenceAndCancelActiveResponse()
  }

  /**
   * The host wants the floor for something more important.
   *
   * Cancelling the provider and fencing the renderer are separate decisions here. When a response
   * is generating, its audio already queued is left playing (`defer_playback_fence`) so the user
   * hears a finished clause rather than a cut word; the fence lands when its terminal arrives.
   */
  async hostPreempt(): Promise<boolean> {
    if (this.#floor.state === 'user_speaking') return false
    const responseId = this.#providerResponseId
    const generation = this.#playback.current
    if (
      responseId !== null
      && generation !== null
      && generation.session_epoch !== this.sessionEpoch
      && generation.response_id === responseId
    ) {
      // A generation from an older epoch that happens to share this response id is not this
      // response's audio, and preempting on that coincidence would fence the wrong utterance.
      return false
    }
    if (responseId !== null) {
      const turn = this.#state.openProviderTurn(responseId)
      if (turn.phase === 'cancel_requested') return false
      turn.phase = 'cancel_requested'
      turn.defer_playback_fence = true
      this.#hostPreemptResponseId = responseId
      await this.#provider.cancelResponse(responseId)
      return true
    }
    if (generation !== null && generation.session_epoch === this.sessionEpoch) {
      const turn = this.#state.providerTurn(generation.response_id)
      if (turn !== undefined && !turn.defer_playback_fence) {
        turn.defer_playback_fence = true
        this.#hostPreemptResponseId = generation.response_id
        return true
      }
    }
    const preempted = await this.#fenceAndCancelActiveResponse()
    if (preempted && this.#fenceNextResponse) this.#hostPreemptPending = true
    return preempted
  }

  /**
   * Fence whatever is audible and cancel whatever is generating.
   *
   * Five cases, and which one applies turns on how far the response has got. Note what this does
   * *not* do: the cancelled response keeps the provider slot until its own terminal arrives, so a
   * second `response.create` cannot go out while this cancellation is in flight.
   */
  async #fenceAndCancelActiveResponse(): Promise<boolean> {
    const generation = this.#playback.fenceCurrent()
    const fenced = generation !== null
    const generationOwnsProvider = generation !== null
      && generation.session_epoch === this.sessionEpoch
    if (generation !== null && generationOwnsProvider) {
      this.#markLocallyFenced(generation.response_id)
      this.#markResponseInterrupted(generation.response_id)
      this.#state.advanceSnapshot()
    }

    const activeResponseId = this.#providerResponseId
    if (activeResponseId !== null) {
      // A generation from an older epoch that shares this response id is not this response's
      // audio; fencing it was right, cancelling on that coincidence would not be.
      if (
        generation !== null
        && !generationOwnsProvider
        && generation.response_id === activeResponseId
      ) {
        return fenced
      }
      const turn = this.#state.openProviderTurn(activeResponseId)
      if (turn.phase === 'cancel_requested') {
        // Already cancelled, by a host preempt that deferred the renderer fence. The fence has now
        // happened, so the deferral is spent and must not fence a later generation.
        turn.defer_playback_fence = false
        if (this.#hostPreemptResponseId === activeResponseId) this.#hostPreemptResponseId = null
        return fenced
      }
      turn.locally_fenced = true
      turn.phase = 'cancel_requested'
      // Its own generation was already marked interrupted above; marking twice would be wrong only
      // in the snapshot count, which is exactly what the goldens compare.
      if (
        generation === null
        || !generationOwnsProvider
        || generation.response_id !== activeResponseId
      ) {
        this.#markResponseInterrupted(activeResponseId)
        this.#state.advanceSnapshot()
      }
      await this.#provider.cancelResponse(activeResponseId)
      return true
    }

    const premapResponseId = this.#state.premapResponseId
    if (premapResponseId === null) {
      // `response.create` may already be in flight with no provider response id yet. Arm a
      // one-shot fence so the next unowned start or pre-map delta is fenced instead of played.
      // The fenced pending stays queued: it still owns the one inference slot, so no second
      // create can go out until a consumption event pops it.
      if (this.#state.pendingResponseCount > 0 && !this.#fenceNextResponse) {
        this.#fenceNextResponse = true
        this.#markHeadPendingFenced()
        this.#state.advanceSnapshot()
        return true
      }
      if (this.#awaitingUserResponse && !this.#fenceNextResponse) {
        this.#fenceNextResponse = true
        this.#state.advanceSnapshot()
        return true
      }
      return fenced
    }

    // Audio arrived before the start, so the response is known by the buffer alone. It takes the
    // provider slot here so its terminal has something to close.
    const turn = this.#state.openProviderTurn(premapResponseId)
    turn.locally_fenced = true
    turn.phase = 'cancel_requested'
    this.#providerResponseId = premapResponseId
    this.#abandonPendingResponse()
    this.#state.clearPremapAudio()
    this.#state.advanceSnapshot()
    await this.#provider.cancelResponse(premapResponseId)
    return true
  }

  /**
   * Fence a response before it owns a playback generation.
   *
   * The fenced response keeps the provider slot until its own terminal: releasing it early would
   * let a Guard open a second inference while this cancellation is still in flight.
   */
  async #fencePendingResponse(responseId: string): Promise<void> {
    const armed = this.#fenceNextResponse
    this.#fenceNextResponse = false
    const turn = this.#state.openProviderTurn(responseId)
    turn.locally_fenced = true
    turn.phase = 'cancel_requested'
    this.#providerResponseId = responseId
    if (this.#hostPreemptPending) {
      this.#hostPreemptResponseId = responseId
      turn.defer_playback_fence = true
    }
    if (armed) {
      // Arming already emitted the receipt for this pending; consuming it only releases the slot.
      this.#state.popPendingResponse()
    } else {
      this.#abandonPendingResponse()
    }
    this.#state.clearPremapAudio()
    this.#state.advanceSnapshot()
    await this.#provider.cancelResponse(responseId)
  }

  #markHeadPendingFenced(): readonly string[] {
    const pending = this.#state.headPendingResponse
    if (pending === undefined) return []
    const items = pending.intents.map(intent => intent.item)
    const eventIds = items.map(item => item.event_id)
    for (const eventId of eventIds) this.#state.markEventInterrupted(eventId)
    this.#releaseSuggestionEventAuthority(items)
    this.#fenceInterruption = {session_epoch: this.sessionEpoch, event_ids: eventIds}
    return eventIds
  }

  #abandonPendingResponse(): readonly string[] {
    const eventIds = this.#markHeadPendingFenced()
    this.#state.popPendingResponse()
    return eventIds
  }

  /**
   * Spend a deferred preempt fence, now that the audio it was waiting on is done.
   *
   * `hostPreempt` deferred fencing the renderer so a clause could finish. This is where that debt
   * is settled: pass the generation the preempt was aimed at, or `null` when the preempt never got
   * one because the response had not yet opened playback.
   */
  expireHostPreempt(generation: PlaybackGeneration | null): boolean {
    const responseId = this.#hostPreemptResponseId
    if (responseId === null) {
      // No response was preempted, so the only thing left to settle is a pending pre-start preempt,
      // and only when there is nothing audible to wait for.
      if (generation !== null || !this.#hostPreemptPending) return false
      this.#hostPreemptPending = false
      if (this.#playback.current === null) this.#playback.fenceCurrent({alert: true})
      this.#state.advanceSnapshot()
      return true
    }
    const turn = this.#state.providerTurn(responseId)
    if (turn?.defer_playback_fence !== true) return false
    turn.defer_playback_fence = false
    this.#hostPreemptResponseId = null
    const current = this.#playback.current
    let fenced: PlaybackGeneration | null = null
    if (generation !== null && current !== null && sameGeneration(current, generation)) {
      // Alert-fenced, not silently fenced: the user was interrupted mid-utterance and the renderer
      // has to say so rather than just stopping.
      fenced = this.#playback.fenceCurrent({alert: true})
    } else if (generation === null && this.#hostPreemptPending && current === null) {
      this.#playback.fenceCurrent({alert: true})
    }
    this.#hostPreemptPending = false
    if (fenced !== null && fenced.session_epoch === this.sessionEpoch) {
      this.#markLocallyFenced(fenced.response_id)
    }
    this.#markResponseInterrupted(responseId)
    this.#state.advanceSnapshot()
    return true
  }

  /** Alert-fence the exact renderer generation retained for a Guard handoff. */
  alertGuardHandoff(generation: PlaybackGeneration): boolean {
    // Reached with nothing current once the retained audio finishes: the generation is retired
    // while the handoff is still recorded, so a mismatched one would otherwise take the
    // nothing-is-playing branch and consume a handoff it does not name.
    if (
      this.#guardHandoffGeneration === null
      || !sameGeneration(this.#guardHandoffGeneration, generation)
    ) {
      return false
    }
    const current = this.#playback.current
    if (current !== null && sameGeneration(current, generation)) {
      if (!this.#playback.alertFenceGeneration(generation)) return false
    } else if (current === null) {
      this.#playback.fenceCurrent({alert: true})
    } else {
      // Something else is playing, so this generation is no longer the one to alert about.
      return false
    }
    this.#guardHandoffGeneration = null
    this.#floor = this.#floor.onSpeakEnd(generation.utterance_id)
    this.#state.advanceSnapshot()
    return true
  }

  /**
   * Release an exactly-identified fenced generation without inventing delivery evidence.
   *
   * The renderer reported a clear for a generation the session cannot account for. Retiring it frees
   * the slot; what it must not do is produce a completion, because nobody knows whether or how much
   * of it was heard.
   */
  retirePlaybackClearUnknown(generation: PlaybackGeneration): boolean {
    if (!this.#playback.retireClearUnknown(generation)) return false
    if (
      this.#guardHandoffGeneration !== null
      && sameGeneration(this.#guardHandoffGeneration, generation)
    ) {
      this.#guardHandoffGeneration = null
    }
    this.#floor = this.#floor.onSpeakEnd(generation.utterance_id)
    this.#state.advanceSnapshot()
    return true
  }

  // ---------------------------------------------------------------------------
  // Playback acknowledgement
  // ---------------------------------------------------------------------------

  playbackStarted(utteranceId: string, generationEpoch: number): boolean {
    const started = this.#playback.markStarted(utteranceId, generationEpoch)
    // Floor reflects audibility, so the grant lands on actual playback start; a start ack racing
    // barge-in must never take the user's floor.
    if (started && this.#floor.state === 'idle') {
      this.#floor = this.#floor.onSpeakStart(utteranceId, USER_PRIORITY)
    }
    return started
  }

  playbackDone(
    utteranceId: string,
    generationEpoch: number,
    playedMs: number | null = null,
  ): boolean {
    return this.completePlayback(utteranceId, generationEpoch, playedMs) !== null
  }

  completePlayback(
    utteranceId: string,
    generationEpoch: number,
    playedMs: number | null = null,
  ): PlaybackCompletion | null {
    const completion = this.#playback.ackDone(utteranceId, generationEpoch, playedMs)
    if (completion === null) return null
    if (completion.disposition !== 'spoken') {
      this.#releaseInterruptedSuggestionAuthority(completion.response_id, completion.session_epoch)
      this.#finishResponseAuthority(completion.response_id, completion.session_epoch)
      this.#onDelivery(completion)
      this.#floor = this.#floor.onSpeakEnd(utteranceId)
      this.#state.advanceSnapshot()
      return completion
    }
    const items = this.#responseItems.get(
      this.#turnKey(completion.response_id, completion.session_epoch),
    ) ?? []
    for (const item of items) {
      this.#state.markEventSpoken(item.event_id)
      // It was heard, so there is nothing left to re-offer.
      this.#state.releaseRetainedSuggestionInjection(item.event_id)
    }
    this.#finishResponseAuthority(completion.response_id, completion.session_epoch)
    this.#onSpoken(completion.text)
    this.#onDelivery(completion)
    this.#floor = this.#floor.onSpeakEnd(utteranceId)
    this.#state.advanceSnapshot()
    return completion
  }

  playbackCleared(
    utteranceId: string,
    generationEpoch: number,
    playedMs: number | null = null,
  ): boolean {
    return this.completePlaybackClear(utteranceId, generationEpoch, playedMs) !== null
  }

  completePlaybackClear(
    utteranceId: string,
    generationEpoch: number,
    playedMs: number | null = null,
  ): PlaybackCompletion | null {
    const completion = this.#playback.recordCleared(utteranceId, generationEpoch, playedMs)
    if (completion === null) return null
    this.#releaseInterruptedSuggestionAuthority(completion.response_id, completion.session_epoch)
    this.#finishResponseAuthority(completion.response_id, completion.session_epoch)
    this.#onDelivery(completion)
    this.#floor = this.#floor.onSpeakEnd(utteranceId)
    return completion
  }

  /**
   * The renderer stopped playing on its own account.
   *
   * Distinct from `playbackCleared`, which acknowledges a stop the session asked for. Here the
   * renderer decided, so the session has to catch up: fence the generation, record the partial
   * delivery, release the floor, and -- the part that matters -- cancel the provider if it is still
   * generating for this response. Without that last step audio would keep arriving for something
   * nobody is playing.
   */
  async playbackStopped(
    utteranceId: string,
    generationEpoch: number,
    playedMs: number | null = null,
  ): Promise<boolean> {
    const current = this.#playback.current
    // Only the generation actually on the renderer can be stopped by it; a stale report names one
    // that has already been replaced.
    if (
      current?.utterance_id !== utteranceId
      || current.generation_epoch !== generationEpoch
    ) {
      return false
    }
    const generation = this.#playback.fenceCurrent()
    if (generation === null) return false
    if (generation.session_epoch === this.sessionEpoch) {
      this.#markLocallyFenced(generation.response_id)
      this.#markResponseInterrupted(generation.response_id)
      this.#state.advanceSnapshot()
    }
    const completion = this.#playback.recordCleared(utteranceId, generationEpoch, playedMs)
    if (completion !== null) {
      this.#finishResponseAuthority(completion.response_id, completion.session_epoch)
      this.#onDelivery(completion)
    }
    this.#floor = this.#floor.onSpeakEnd(utteranceId)
    if (
      generation.session_epoch === this.sessionEpoch
      && this.#providerResponseId === generation.response_id
    ) {
      this.#state.openProviderTurn(generation.response_id).phase = 'cancel_requested'
      await this.#provider.cancelResponse(generation.response_id)
    }
    return true
  }

  // ---------------------------------------------------------------------------
  // Delegates
  // ---------------------------------------------------------------------------

  /**
   * Record or update one delegate's session view.
   *
   * The session holds this because a reconnect has to tell the new provider what work is still
   * running; without it the recovery item would claim no active work and the model would lose the
   * context for anything it is asked about next.
   */
  registerDelegate(
    delegateId: string,
    update: Parameters<RealtimeSessionState['registerDelegate']>[1],
  ): void {
    this.#state.registerDelegate(delegateId, update)
  }

  delegateState(delegateId: string): string | undefined {
    return this.#state.delegateState(delegateId)
  }

  // ---------------------------------------------------------------------------
  // Captions
  // ---------------------------------------------------------------------------

  /**
   * Project a transcript event into the display-only caption channel.
   *
   * Captions carry the session's truth policy -- epoch checks, fences, response authorization --
   * but are never session state: a caption is revisable evidence for the UI, not input to Floor,
   * Memory, or delivery. `accepted` carries the session's verdict for the events whose
   * authorization lives in `accept` rather than in per-response tracking.
   */
  captionFor(
    event: RealtimeProviderEvent,
    options: {readonly accepted?: boolean | null} = {},
  ): CaptionFrame | null {
    if (event.session_epoch !== this.sessionEpoch) return null
    const accepted = options.accepted ?? null
    switch (event.kind) {
      case 'user_transcript_delta':
        this.#state.trackUserCaption(event.item_id)
        return this.#state.appendCaption({role: 'user', text: event.text, final: false})
      case 'user_transcript_final': {
        // A final the reducer refused is not the user's turn, so it must not reach the display.
        if (accepted === false) return null
        this.#state.resetUserCaptionTarget()
        return {role: 'user', text: truncateCaptionText(event.text), final: true}
      }
      case 'response_transcript_delta': {
        if (!this.#captionAuthorized(event.response_id)) return null
        this.#state.trackAssistantCaption(event.response_id)
        return this.#state.appendCaption({role: 'assistant', text: event.text, final: false})
      }
      case 'response_transcript_final': {
        if (!this.#captionAuthorized(event.response_id)) return null
        this.#state.resetAssistantCaptionTarget()
        return {role: 'assistant', text: truncateCaptionText(event.text), final: true}
      }
      default:
        return null
    }
  }

  /** Only a response the session actually owns may put speculative text on screen. */
  #captionAuthorized(responseId: string): boolean {
    if (this.#state.responseIsSuppressed(responseId)) return false
    if (this.#state.providerTurn(responseId)?.locally_fenced === true) return false
    if (
      this.#providerResponseId === responseId
      || this.#state.premapResponseId === responseId
    ) {
      return true
    }
    if (this.#responseItems.has(this.#turnKey(responseId))) return true
    const current = this.#playback.current
    return (
      current !== null
      && current.session_epoch === this.sessionEpoch
      && current.response_id === responseId
    )
  }

  /** Drop speculative accumulators; the caller blanks the display. */
  resetCaptions(): void {
    this.#state.clearCaptions()
  }

  // ---------------------------------------------------------------------------
  // Tool continuation
  // ---------------------------------------------------------------------------

  /**
   * Ask the provider to narrate one or more finished tool calls.
   *
   * `retryable` rather than a refusal when the provider or renderer is busy: Qwen permits one
   * inference at a time, and a continuation's audio would fence pre-tool-call speech that is still
   * audible, so the caller is told to come back rather than told no.
   */
  async requestToolContinuation(
    intents: readonly HostResponseIntent[],
    options: {readonly originSpoken?: boolean} = {},
  ): Promise<'requested' | 'retryable' | 'rejected'> {
    if (intents.length === 0) throw new TypeError('tool continuation requires at least one intent')
    if (
      this.#state.pendingResponseCount > 0
      || this.#providerResponseId !== null
      || this.#playback.current !== null
      || this.#playback.hasUnreportedFence
    ) {
      return 'retryable'
    }
    for (const intent of intents) {
      const item = intent.item
      if (item.kind !== 'tool_output') {
        throw new TypeError('tool continuation requires tool output')
      }
      if (this.#state.hostEventIsDeduplicated(item.event_id)) return 'rejected'
      const injectedEpoch = this.#state.injectedEventEpoch(item.event_id)
      if (injectedEpoch === undefined) {
        throw new TypeError('tool output must be confirmed before continuation')
      }
      // Work that outlived a reconnect can still be narrated; a plain tool result cannot, because
      // the conversation it belonged to is gone.
      if (injectedEpoch !== this.sessionEpoch && intent.kind !== 'delegation_acknowledgement') {
        return 'rejected'
      }
    }
    const providerIntent = this.#mergeContinuationIntents(intents, options.originSpoken ?? false)
    await this.#createResponse(providerIntent, intents.map(intent => intent.item.event_id))
    this.#state.queuePendingResponse({
      intents: [...intents],
      provider_intent: providerIntent,
      user_input_revision: this.userInputRevision,
    })
    return 'requested'
  }

  #mergeContinuationIntents(
    intents: readonly HostResponseIntent[],
    originSpoken: boolean,
  ): HostResponseIntent {
    const acknowledgements = intents.filter(
      intent => intent.kind === 'delegation_acknowledgement',
    )
    if (acknowledgements.length > 0) {
      const summary = [...acknowledgements.map(intent => intent.task_summary ?? '')]
        .join('；')
        .slice(0, MAX_CONTINUATION_TASK_SUMMARY)
      return {
        kind: 'delegation_acknowledgement',
        item: acknowledgements[0]!.item,
        task_summary: summary,
        // One voiced confirmation cannot stand in for every task in a batch, nor for any
        // synchronous result sharing it.
        origin_spoken: originSpoken && intents.length === 1,
      }
    }
    // A batch with no acknowledgement is a plain tool result, and the caller guaranteed there
    // is one by construction: every intent is tool output and none is an acknowledgement.
    return intents.find(intent => intent.kind === 'tool_result')!
  }

  // ---------------------------------------------------------------------------
  // The user-hold deadline
  // ---------------------------------------------------------------------------

  /**
   * Release a user floor hold whose provider speech-end never arrived.
   *
   * Checked at each host-item delivery attempt. The deadline is measured from when the speech
   * started, not from when this is asked, so repeated asking cannot postpone it.
   */
  /**
   * Sleep on the injected clock until the active user hold turns stale.
   *
   * Returns false at once when no hold is active. The small margin past the deadline keeps the
   * release comparison strict on a real clock, where waking exactly on it would race.
   */
  async waitForStaleHold(maxHoldSeconds: number): Promise<boolean> {
    if (this.#floor.state !== 'user_speaking' || this.#userHoldSince === null) return false
    const remaining = this.#userHoldSince + maxHoldSeconds - this.#clock.now()
    // Past the deadline, not on it: `releaseStaleUserHold` compares strictly, so a wake at exactly
    // the deadline would find the hold not yet stale and the caller would spin.
    if (remaining > 0) await this.#clock.sleep(remaining + 0.05)
    return true
  }

  releaseStaleUserHold(maxHoldSeconds: number): boolean {
    if (this.#floor.state !== 'user_speaking' || this.#userHoldSince === null) return false
    if (this.#clock.now() - this.#userHoldSince <= maxHoldSeconds) return false
    this.#floor = new Floor()
    this.#userHoldSince = null
    return true
  }

  // ---------------------------------------------------------------------------
  // Authority bookkeeping
  // ---------------------------------------------------------------------------

  #markLocallyFenced(responseId: string): void {
    this.#state.openProviderTurn(responseId).locally_fenced = true
  }

  #markResponseInterrupted(responseId: string, sessionEpoch?: number): void {
    const epoch = sessionEpoch ?? this.sessionEpoch
    const items = this.#responseItems.get(this.#turnKey(responseId, epoch)) ?? []
    for (const item of items) this.#state.markEventInterrupted(item.event_id)
    this.#releaseSuggestionEventAuthority(items, epoch)
  }

  #releaseInterruptedSuggestionAuthority(responseId: string, sessionEpoch?: number): void {
    const epoch = sessionEpoch ?? this.sessionEpoch
    this.#releaseSuggestionEventAuthority(
      this.#responseItems.get(this.#turnKey(responseId, epoch)) ?? [],
      epoch,
    )
  }

  /**
   * Give a suggestion back its right to be offered again.
   *
   * An interrupted suggestion never reached the user, so treating it as answered would lose it
   * silently. Its injection is retained for the rest of the epoch so it is not injected twice.
   */
  #releaseSuggestionEventAuthority(
    items: readonly HostContextItem[],
    sessionEpoch?: number,
  ): void {
    const epoch = sessionEpoch ?? this.sessionEpoch
    for (const item of items) {
      if (!item.event_id.startsWith('suggestion:')) continue
      this.#state.releaseRespondedEvent(item.event_id)
      if (this.#state.injectedEventEpoch(item.event_id) === epoch) {
        this.#state.retainSuggestionInjection(item.event_id)
      }
    }
  }

  /** A delivered response loses caption authority and its item bookkeeping. */
  #finishResponseAuthority(responseId: string, sessionEpoch?: number): void {
    const epoch = sessionEpoch ?? this.sessionEpoch
    this.#responseItems.delete(this.#turnKey(responseId, epoch))
    if (epoch === this.sessionEpoch) this.#state.clearAssistantCaptionFor(responseId)
  }

  /**
   * Give a response a renderer generation, fencing whatever held one before.
   *
   * Called at the first audio that has somewhere to go. Doing it here rather than at
   * `response_started` means a response that never produces audio never takes the renderer.
   */
  #openAudioResponse(responseId: string): boolean {
    const turn = this.#state.providerTurn(responseId)
    if (
      this.#floor.state === 'user_speaking'
      || turn === undefined
      || turn.locally_fenced
      || turn.phase !== 'active'
    ) {
      return false
    }
    let current = this.#playback.current
    const handoff = this.#guardHandoffGeneration
    if (handoff !== null) {
      if (current !== null && sameGeneration(current, handoff)) {
        // The Guard's retained generation becomes this response's, so the user hears no seam.
        if (!this.#playback.switchGeneration(handoff)) return false
        this.#floor = this.#floor.onSpeakEnd(handoff.utterance_id)
      } else if (current !== null) {
        return false
      }
      this.#guardHandoffGeneration = null
      current = null
    }
    if (
      current !== null
      && (current.session_epoch !== this.sessionEpoch || current.response_id !== responseId)
    ) {
      const generation = this.#playback.fenceCurrent()
      if (generation !== null && generation.session_epoch === this.sessionEpoch) {
        const previous = this.#state.providerTurn(generation.response_id)
        if (previous !== undefined) previous.defer_playback_fence = false
        this.#markLocallyFenced(generation.response_id)
        this.#markResponseInterrupted(generation.response_id)
        this.#state.advanceSnapshot()
      }
    }
    const preemptedResponseId = this.#hostPreemptResponseId
    if (preemptedResponseId !== null && preemptedResponseId !== responseId) {
      const previous = this.#state.providerTurn(preemptedResponseId)
      if (previous !== undefined) previous.defer_playback_fence = false
      this.#hostPreemptResponseId = null
    }
    this.#hostPreemptPending = false
    this.#lastOpenedGeneration = this.#playback.openResponse({
      sessionEpoch: this.sessionEpoch,
      responseId,
    })
    this.#spokenResponseId = responseId
    if (this.#providerTranscript !== '') {
      // A transcript that arrived before the generation existed still belongs to it.
      this.#playback.setTranscript({
        sessionEpoch: this.sessionEpoch,
        responseId,
        text: this.#providerTranscript,
      })
    }
    return true
  }

  #turnKey(responseId: string, sessionEpoch?: number): string {
    return `${sessionEpoch ?? this.#state.sessionEpoch}:${responseId}`
  }
}

/**
 * What the new provider session is told about the old one.
 *
 * Counts and active work only: a recovery item is context, not a transcript, and the packed history
 * is a separate item precisely so this one stays small enough to always fit.
 */
function recoveryContent(snapshot: RealtimeSnapshot): string {
  const header = [
    `snapshot_version=${snapshot.version}`,
    `active_work_count=${snapshot.active_delegates.length}`,
  ]
  const footer = [
    `spoken_progress_count=${snapshot.spoken_event_ids.length}`,
    `interrupted_progress_count=${snapshot.interrupted_event_ids.length}`,
  ]
  const activeWork: string[] = []
  for (const [index, [, record]] of snapshot.active_delegates.entries()) {
    let line = `active_work_channel=${record.channel};`
      + `active_work=${record.summary.slice(0, MAX_CONTINUATION_TASK_SUMMARY)};`
      + ` state=${record.state}`
    if (record.progress_summary !== null && record.progress_summary !== '') {
      line += `; progress=${record.progress_summary.slice(0, 120)}`
    }
    const remaining = snapshot.active_delegates.length - index - 1
    const trial = [...header, ...activeWork, line]
    // The omission notice has to fit too, or dropping a line could make the content longer.
    if (remaining > 0) trial.push(`active_work_omitted=${remaining}`)
    if (codePointLengthLikePython([...trial, ...footer].join('\n')) > MAX_REALTIME_TEXT) break
    activeWork.push(line)
  }
  const omitted = snapshot.active_delegates.length - activeWork.length
  const parts = [...header, ...activeWork]
  if (omitted > 0) parts.push(`active_work_omitted=${omitted}`)
  return [...parts, ...footer].join('\n')
}

/** A no-op default for the optional callbacks, shared rather than allocated twice. */
function noop(): void {
  // Intentionally empty: a caller that wants nothing to happen gets nothing.
}

function sameGeneration(left: PlaybackGeneration, right: PlaybackGeneration): boolean {
  return (
    left.session_epoch === right.session_epoch
    && left.generation_epoch === right.generation_epoch
    && left.generation_id === right.generation_id
    && left.utterance_id === right.utterance_id
    && left.response_id === right.response_id
  )
}
