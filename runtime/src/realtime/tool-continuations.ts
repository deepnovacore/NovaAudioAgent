import type {TaskToolHost} from '../core/task-tools.js'
import {dispatchSources, projectRecoveryTurns, recentDispatchSources} from './history.js'
import {taskToolArguments} from '../core/task-tools.js'
import type {TaskDispatchContext} from '../core/task-tools.js'
import type {IntakeOptions} from '../executors/coding/intake.js'
import {
  parseAgentActionResult,
  type AgentActionResult,
  type AgentController
} from '../executors/agent-controller.js'
import type {ApprovalHost} from '../core/approval.js'
import {canonicalJson} from '../text/canonical-json.js'
import {type EventRecord, type JsonValue} from '../core/events.js'
import {
  type IntakeEventPort
} from '../executors/coding/intake.js'
import {codePointLengthLikePython, stripLikePython} from '../text/python-text.js'
import type {CompiledTools} from '../core/tool-schema.js'
import {CANCEL_TOOL, CONFIRM_TOOL, DISPATCH_TOOL} from '../core/work-tools.js'
import type {RealtimeRuntimeBridge, ToolAcceptance, ToolCallReady} from './bridge.js'
import {requiresSynchronousResult} from './bridge.js'
import {type CodingChannel} from './evidence.js'
import type {HostDelivery} from './host-delivery.js'
import type {
  HostContextItem,
  HostResponseIntent
} from './protocol.js'
import {ItemDeliveryUncertainError} from './protocol.js'
import type {BoundToolOrigin, HostItemOptions, ProviderReconnectReason, ServiceRuntime} from './service-ports.js'
import {
  MAX_HOST_FACT_CHARS,
  MAX_LATE_SYNC_RESULTS,
  MAX_PENDING_TOOL_REFUSALS,
  MAX_TRACKED_TOOL_CALLS, Mutex, SYNC_RESULT_SNIPPET_CHARS,
  SYNC_RESULT_TITLE_CHARS, callKey,
  continuationBatch,
  hostFactIntent, isAbort, parseCallKey, toolCallState,
  type ContinuationBatch,
  type DeferredOriginToolCall, type ToolCallAcceptanceSnapshot,
  type ToolCallState
} from './service-state.js'
import {
  MAX_CONTINUATION_TASK_SUMMARY
} from './session-state.js'
import {RealtimeDeliveryError, type RealtimeSession} from './session.js'
import type {RealtimeTelemetry} from './telemetry.js'
import type {UserOriginBindingLedger} from './user-origin-binding.js'
const UNKNOWN_CONFIRMATION_TOOL_RESULT = JSON.stringify({code: 'unknown_confirmation', state: 'refused'})
interface ToolContinuationPorts {
  readonly taskHost?: TaskToolHost
  readonly session: RealtimeSession
  readonly host: Pick<HostDelivery, 'bindContinuationAcknowledgement' | 'hasEligiblePreempt' | 'hasOriginDeliveryProof' | 'markOriginDelivered' | 'originCanReferenceProof' | 'originHasNonterminalReference' | 'releaseAcknowledgementReservation' | 'rendererPaused' | 'reserveSemanticAcknowledgement' | 'semanticAcknowledgement' | 'settleBackgroundAcknowledgement'>
  readonly runtime: ServiceRuntime
  readonly bridge: RealtimeRuntimeBridge
  readonly tools: CompiledTools
  readonly intake: IntakeEventPort | undefined
  readonly approvalHost: ApprovalHost
  readonly coding: CodingChannel | null
  readonly telemetry: RealtimeTelemetry | undefined
  readonly idFactory: () => string
  readonly executorPriority: (channel: string | null) => number
  readonly executorDisplayName: (channel: string) => string
  readonly publishExecutorState: () => void
  readonly queueHostItem: (intent: HostResponseIntent, options?: HostItemOptions) => void
  readonly wakeDelivery: () => void
  readonly userOrigins: Pick<UserOriginBindingLedger, 'itemForResponse' | 'revisionForItem' | 'originRefForItem' | 'bindRetryResponse'>
  readonly confirmTarget: (event: ToolCallReady) => 'approval' | 'project' | 'none' | null
  readonly isProjectConfirmationShadowItem: (epoch: number, itemId: string) => boolean
  readonly closeProjectConfirmationTool: (event: ToolCallReady) => Promise<void>
  readonly handleProjectConfirmationDecision: (event: ToolCallReady, origin: BoundToolOrigin) => Promise<void>
  readonly reconnectProviderSession: (options: {readonly reason: ProviderReconnectReason; readonly expectedEpoch?: number}) => Promise<boolean>
  readonly deliveryPass: () => Promise<void>
  readonly recoverUncertainDelivery: (failure: ItemDeliveryUncertainError) => Promise<void>
  readonly reportDeliveryFailure: (failure: RealtimeDeliveryError) => void
  readonly awaitingUserOrigin: () => boolean
  readonly userOriginPreexistingResponseId: () => string | null
  readonly discardedInputEpoch: () => number
  readonly stopSignal: () => AbortSignal
  readonly intakeUser: () => {readonly text: string; readonly epoch: number; readonly origin_ref: string} | null
  readonly currentUserTurn: (event: ToolCallReady, originRef: string | null) => {
    readonly originRef: string; readonly sessionEpoch: number; readonly acceptedUserInputRevision: number;
    readonly stillWanted: () => boolean
  } | null
  readonly agentController: (name: string) => AgentController | undefined
}

export class ToolContinuations {
  recordIntakeDispatch(
    intake: Parameters<IntakeOptions['dispatch']>[0],
    result: Awaited<ReturnType<IntakeOptions['dispatch']>>,
  ): Awaited<ReturnType<IntakeOptions['dispatch']>> {
    if (result.accepted && result.delegate_id !== null && result.delegate_id !== undefined) {
      const title = intake.title ?? intake.target?.session_title
      this.session.registerDelegate(result.delegate_id, {
        summary: intake.slots.goal.note.slice(0, 240),
        state: 'running',
        channel: this.#ports.coding?.channel ?? 'coding',
        ...(intake.target === null ? {} : {project: intake.target.workspace_display_name}),
        ...(title === undefined || title === null ? {} : {title}),
      })
      this.#ports.telemetry?.record('executor.dispatch', {delegate_id: result.delegate_id})
      this.#ports.publishExecutorState()
    }
    return result

  }

  resetCalls(): void {
    this.#toolCalls.clear()
    this.#overflowToolCalls.clear()
    this.#continuationBatches.clear()
    this.#continuationFifo.length = 0
  }
  resetDeferredAndSync(): void {
    this.#originDeferredToolCalls.length = 0
    this.#pendingSync.clear()
    this.#lateSync.clear()
  }
  clearDeferred(): void {this.#originDeferredToolCalls.length = 0}
  takeDeferredForItem(itemId: string): DeferredOriginToolCall[] {
    const matching: DeferredOriginToolCall[] = []
    const retained: DeferredOriginToolCall[] = []
    for (const call of this.#originDeferredToolCalls) {
      (call.user_item_id === itemId ? matching : retained).push(call)
    }
    this.#originDeferredToolCalls.length = 0
    this.#originDeferredToolCalls.push(...retained)
    return matching
  }
  continuationOrder(): readonly string[] {return [...this.#continuationFifo]}
  responseCarriesPersonalRecall(responseId: string): boolean {
    for (const state of this.#toolCalls.values()) {
      if (
        state.logical_name === 'memory.recall'
        && state.acceptance.inline_fulfilled
        && state.continuation_response_id === responseId
      ) {
        return true
      }
    }
    return false
  }

  readonly #ports: ToolContinuationPorts
  constructor(ports: ToolContinuationPorts) {this.#ports = ports}
  get session(): RealtimeSession {return this.#ports.session}

  /**
   * CP3: serializes the continuation pass across its two entry points -- provider events and the
   * delivery loop. Never held together with the delivery lock.
   */
  readonly #continuationDriveLock = new Mutex()

  readonly #toolCalls = new Map<string, ToolCallState>()

  readonly #overflowToolCalls = new Map<string, ToolCallState>()

  readonly #continuationBatches = new Map<string, ContinuationBatch>()

  readonly #continuationFifo: string[] = []

  /** Tool calls waiting for the transcript that would justify them. */
  readonly #originDeferredToolCalls: DeferredOriginToolCall[] = []

  /** R105: delegate id -> the call key waiting on its synchronous result. */
  readonly #pendingSync = new Map<string, string>()

  /** A timed-out sync call whose first real late handoff should become one host fact. */
  readonly #lateSync = new Map<string, string>()

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
    return this.#ports.host.rendererPaused
      || this.session.floor.state === 'user_speaking'
      || (
        this.#ports.host.hasEligiblePreempt()
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
      this.#ports.host.hasEligiblePreempt()
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
        if (state.acceptance.continuation === 'deferred' && batch.origin_status !== 'yielded') {
          state.continuation = 'terminal'
          state.final_disposition = 'completed'
        } else intents.push(state.acceptance.response_intent)
      }

      if (abandoning) {
        this.#abandonBatch(batch)
        this.#continuationFifo.shift()
        continue
      }
      if (intents.length === 0) {
        // Internal receipts settle without generating speech; their results remain provider context.
        batch.phase = 'terminal'
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
    const acknowledgement = this.#ports.host.semanticAcknowledgement(state)
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
    if (!singleAsync || !this.#ports.host.hasOriginDeliveryProof(key)) return false
    return this.#ports.host.markOriginDelivered(state)
  }

  /**
   * Queue the acknowledgement for work that ran but will not be spoken about in its own turn.
   *
   * If the user already heard it, it is marked delivered instead of queued: saying it twice is worse
   * than not saying it again.
   */
  #queueBackgroundAcknowledgement(state: ToolCallState): void {
    const acknowledgement = this.#ports.host.semanticAcknowledgement(state)
    if (acknowledgement === null) return
    this.#refreshOriginDelivery(state)
    this.#ports.host.settleBackgroundAcknowledgement(acknowledgement.event_id)
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
    this.#ports.queueHostItem({
      kind: 'host_fact',
      item: {
        kind: 'final',
        host_item_id: this.#ports.idFactory(),
        event_id: `sync:${delegateId}`,
        content: state.acceptance.host_item.content,
        call_id: null,
      },
      task_summary: null,
      origin_spoken: false,
    }, {priority: this.#ports.executorPriority(state.acceptance.executor)})
  }

  /**
   * Settle every tool call that belonged to the dead epoch.
   *
   * The dead epoch cannot receive a continuation, so nothing in it will ever be spoken about in its own
   * turn. Each call therefore gets a final disposition here rather than waiting for a terminal that
   * cannot arrive -- and the ones that actually ran get a background acknowledgement, because the work
   * happened and the user has not heard about it.
   */
  reconcileToolStateAfterReconnect(oldEpoch: number): void {
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

  /** Resolve a synchronous tool result before ordinary channel projection can consume it. */
  resolveSyncResult(event: Extract<EventRecord, {kind: 'handoff'}>): boolean {
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
      this.#ports.wakeDelivery()
    } else if (state.sync === 'announce') {
      this.#queueSyncAnnouncement(event)
    }
    return true
  }

  /** Resolve a synchronous timeout without narrating it; one real late handoff may still be announced. */
  expireSyncResult(event: Extract<EventRecord, {kind: 'deadline'}>): boolean {
    const callKeyValue = this.#pendingSync.get(event.payload.delegate_id)
    if (callKeyValue === undefined) return false
    this.#pendingSync.delete(event.payload.delegate_id)
    const state = this.#toolCallState(callKeyValue)
    if (state !== undefined) {
      if (state.sync === 'pending') {
        this.#confirmSyncOutput(state, '{"state":"timeout"}')
        this.#ports.wakeDelivery()
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
    const hostItem: HostContextItem = {...previous, content, recovery_eligible: true}
    state.acceptance = {
      ...state.acceptance,
      host_item: hostItem,
      response_intent: {
        kind: 'tool_result', item: hostItem, task_summary: null, origin_spoken: false,
      },
    }
  }

  #queueSyncAnnouncement(event: Extract<EventRecord, {kind: 'handoff'}>): void {
    this.#ports.queueHostItem(hostFactIntent({
      kind: 'final',
      host_item_id: this.#ports.idFactory(),
      event_id: `sync:${event.payload.delegate_id}`,
      content: this.#syncResultContent(event),
    }), {priority: this.#ports.executorPriority(event.payload.channel)})
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
            try {source = new URL(raw.canonical_url).hostname} catch { /* invalid source stays empty */}
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
    const encoded = JSON.stringify({state: event.payload.outcome, content})
    return [...encoded].length <= MAX_HOST_FACT_CHARS
      ? encoded
      : JSON.stringify({state: event.payload.outcome, error: 'result_too_large'})
  }

  async routeToolCall(event: ToolCallReady): Promise<void> {
    const activeResponseId = this.session.activeProviderResponseId
    const observedResponseId = event.response_id ?? activeResponseId

    const evidence = observedResponseId === null ? undefined : this.session.providerResponseOrigin(observedResponseId)
    const boundItem = observedResponseId === null ? undefined
      : this.#ports.userOrigins.itemForResponse(event.session_epoch, observedResponseId)
    const toolContinuation = observedResponseId !== null && evidence?.kind === 'host_request'
      && this.session.responseIsToolContinuation(observedResponseId)
      && boundItem !== undefined
      && this.#ports.userOrigins.revisionForItem(event.session_epoch, boundItem) === this.session.userInputRevision
      && this.session.providerTurnUserInputRevision(observedResponseId) === this.session.userInputRevision
    if (evidence !== undefined && !toolContinuation && (
      evidence.kind !== 'user_item' || boundItem !== evidence.item_id
    )) {
      // Explicit evidence may be rejected, but cannot fall back to the next arriving transcript.
      await this.#handleBoundToolCall(event, {
        observedProviderResponseId: observedResponseId, originItemId: null, originRef: null,
      })
      return
    }
    const confirmTarget = this.#ports.confirmTarget(event)
    if (confirmTarget === 'approval') {
      await this.#ports.approvalHost.routeExecutorApprovalCall(event, observedResponseId)
      return
    }
    const originItemId = observedResponseId === null
      ? undefined
      : this.#ports.userOrigins.itemForResponse(event.session_epoch, observedResponseId)

    if (
      originItemId !== undefined
      && this.#ports.isProjectConfirmationShadowItem(event.session_epoch, originItemId)
    ) {
      await this.#ports.closeProjectConfirmationTool(event)
      return
    }

    if (originItemId !== undefined) {
      const originRef = this.#ports.userOrigins.originRefForItem(event.session_epoch, originItemId)
      if (originRef !== undefined) {
        await this.#handleBoundToolCall(event, {
          observedProviderResponseId: observedResponseId,
          originItemId,
          originRef,
        })
      } else if (this.#originDeferredToolCalls.length >= MAX_PENDING_TOOL_REFUSALS) {
        await this.#ports.reconnectProviderSession({
          reason: 'origin_resolution_overflow',
          expectedEpoch: this.session.sessionEpoch,
        })
      } else {
        this.#originDeferredToolCalls.push({
          event,
          response_id: observedResponseId!,
          user_item_id: originItemId,
        })
      }
      return
    }

    if (confirmTarget === 'project') {
      await this.#ports.handleProjectConfirmationDecision(event, {
        observedProviderResponseId: observedResponseId,
        originItemId: null,
        originRef: null,
      })
      return
    }

    if (this.#ports.awaitingUserOrigin()) {
      // Whether the response this call names is the one the in-flight user turn will answer. If it is
      // not -- a different response, a finished one, or one already fenced -- the call is not waiting
      // on that turn and holding it back would delay it for evidence it was never going to get.
      const originIsActive = observedResponseId !== null
        && activeResponseId === observedResponseId
        && this.session.providerTurnPhase(observedResponseId) === 'active'
        && !this.session.providerTurnWasFenced(observedResponseId)
      if (observedResponseId === this.#ports.userOriginPreexistingResponseId()) {
        // The response was already running when the user started speaking, so it cannot be answering
        // them: handle it now with whatever evidence it has.
        await this.#handleToolCall(event)
      } else if (!originIsActive) {
        await this.#handleToolCall(event)
      } else if (this.#originDeferredToolCalls.length >= MAX_PENDING_TOOL_REFUSALS) {
        await this.#ports.reconnectProviderSession({
          reason: 'origin_binding_overflow',
          expectedEpoch: this.session.sessionEpoch,
        })
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
  async releaseDeferredOriginCalls(itemId: string, originRef: string | null): Promise<void> {
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
    const confirmTarget = this.#ports.confirmTarget(event)
    if (confirmTarget === 'project') {
      await this.#ports.handleProjectConfirmationDecision(event, origin)
      return
    }
    if (confirmTarget === 'approval') {
      await this.#ports.approvalHost.handleExecutorApprovalDecision(event, origin)
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
    if (phase === 'yielded') return 'yielded'
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
    call: ToolCallReady,
    options: {
      readonly observedProviderResponseId?: string | null
      readonly originRef?: string | null
    } = {},
  ): Promise<void> {
    const event = call
    // A hidden agent op named by the provider was never offered to it and cannot be reached through
    // a host rewrite. Controllers are the only path from a public agent name to a hidden channel.
    const hidden = this.#ports.tools.hidden.has(call.name)
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
    const binding = hidden ? undefined : this.#ports.tools.bindings.get(event.name)
    const personalRecall = binding?.kind === 'query'
      && (event.name === 'memory__evidence' || (event.name === 'memory__recall' && event.arguments.source !== 'session'))
    const noIntakeAgentDispatch = !hidden
      && event.name === DISPATCH_TOOL
      && this.#ports.intake === undefined
      && this.#agentExecutorName(event.arguments.executor) !== null
    // A delegated call will eventually need to be spoken about, so its acknowledgement slot is
    // reserved *before* admission -- admitting work the agent could never mention is worse than
    // refusing it.
    const synchronousDelegateCall = binding?.kind === 'delegate'
      && typeof binding.executor === 'string'
      && typeof binding.op === 'string'
      && requiresSynchronousResult(
        this.#ports.runtime.executors.get(binding.executor),
        binding.op,
        event.arguments,
        binding.sync_result === true,
      )
    const requiresSemanticAcknowledgement = !superseded
      && (binding?.kind === 'delegate' || noIntakeAgentDispatch)
      && !synchronousDelegateCall
    let semanticReserved = false
    if (!callOverCapacity && requiresSemanticAcknowledgement) {
      semanticReserved = this.#ports.host.reserveSemanticAcknowledgement()
    }
    const overCapacity = callOverCapacity
      || (requiresSemanticAcknowledgement && !semanticReserved)
    if (overCapacity && this.#overflowToolCalls.size >= MAX_PENDING_TOOL_REFUSALS) {
      // Both ledgers full of refusals the provider has not acknowledged. The session is no longer
      // tracking reality, and reconnecting is the only way back to a state that can be reasoned about.
      await this.#ports.reconnectProviderSession({
        reason: 'refusal_ledger_overflow',
        expectedEpoch: this.session.sessionEpoch,
      })
      return
    }

    let acceptance: ToolAcceptance
    if (superseded) {
      acceptance = this.#supersededAcceptance(event)
    } else if (overCapacity) {
      acceptance = this.#overCapacityAcceptance(event)
    } else if (hidden) {
      acceptance = this.#refusalAcceptance(event, 'unknown_tool', '{"code":"unknown_tool","state":"refused"}')
    } else if (personalRecall) {
      // Classification does not start the read. The serialized receive loop installs its ledger first.
      acceptance = await this.#ports.bridge.acceptToolCall(event, {originRef})
      if (acceptance.code === 'async_tool') {
        const state = toolCallState({
          acceptance,
          logical_name: binding?.logical_name ?? null,
          provider_response_id: providerResponseId,
          provider_session_epoch: event.session_epoch,
          origin_user_input_revision: originUserInputRevision,
          observation: 'observed',
          dispatch: 'fulfilled',
          sync: 'pending',
        })
        this.#toolCalls.set(key, state)
        const batchKey = callKey(event.session_epoch, providerResponseId)
        let batch = this.#continuationBatches.get(batchKey)
        if (batch === undefined) {
          batch = continuationBatch(providerResponseId)
          this.#continuationBatches.set(batchKey, batch)
          this.#continuationFifo.push(batchKey)
        }
        batch.call_keys.push(key)
        const originStatus = this.#originStatus(providerResponseId)
        if (originStatus !== 'active') {
          batch.origin_status = originStatus
          batch.phase = 'ready'
        }
        void this.#resolvePersonalRecall({
          event,
          key,
          state,
          originRef,
          originUserInputRevision,
          providerResponseId,
        }).catch(failure => {
          if (!isAbort(failure)) {
            this.#ports.reportDeliveryFailure(failure instanceof RealtimeDeliveryError
              ? failure
              : new RealtimeDeliveryError(String(failure)))
          }
        })
        return
      }
    } else {
      try {
        const userTurn = this.#ports.currentUserTurn(event, originRef)
        const intercepted = await this.#interceptHost(event, originRef)
        if (event.session_epoch <= this.#ports.discardedInputEpoch()) {
          if (semanticReserved) this.#ports.host.releaseAcknowledgementReservation()
          return
        }
        acceptance = intercepted
          ?? await this.#ports.bridge.acceptToolCall(event, {originRef, ...(userTurn === null ? {} : {userTurn})})
        if (event.session_epoch <= this.#ports.discardedInputEpoch()) {
          if (semanticReserved) this.#ports.host.releaseAcknowledgementReservation()
          return
        }
      } catch (cause) {
        // The reservation was taken on the assumption the admission would happen. It did not, and a
        // reservation nobody releases is a slot permanently unavailable to every later call.
        if (semanticReserved) this.#ports.host.releaseAcknowledgementReservation()
        throw cause
      }
    }

    this.#recordToolAdmission({
      callId: event.call_id,
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
      this.#ports.telemetry?.record('memory.recall', acceptance.telemetry)
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
          if (this.#ports.host.semanticAcknowledgement(state) === null) {
            throw new Error('reserved semantic acknowledgement is unavailable')
          }
        }
      } finally {
        this.#ports.host.releaseAcknowledgementReservation()
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
        : `${this.#ports.executorDisplayName(acceptance.executor)} background task`
      this.session.registerDelegate(acceptance.delegate_id, {
        summary: [...stripLikePython(display)].slice(0, MAX_CONTINUATION_TASK_SUMMARY).join(''),
        state: 'running',
        channel: acceptance.executor,
      })
      if (acceptance.executor === this.#ports.coding?.channel) {
        this.#ports.telemetry?.record('executor.dispatch', {delegate_id: acceptance.delegate_id})
      }
      this.#ports.publishExecutorState()
    }
  }

  async #resolvePersonalRecall(input: {
    readonly event: ToolCallReady
    readonly key: string
    readonly state: ToolCallState
    readonly originRef: string | null
    readonly originUserInputRevision: number
    readonly providerResponseId: string
  }): Promise<void> {
    const acceptance = await this.#ports.bridge.acceptPersonalMemoryRecall(input.event, {originRef: input.originRef, signal: this.#ports.stopSignal()})
    // A replacement session or shutdown cannot receive this old provider call. Its ledger was already
    // reconciled, so the late read has no provider-facing work left to do.
    if (
      this.#ports.stopSignal().aborted
      || this.session.sessionEpoch !== input.event.session_epoch
      || this.#toolCallState(input.key) !== input.state
      || input.state.final_disposition !== null
    ) return
    const superseded = this.session.userInputRevision !== input.originUserInputRevision
      || this.session.providerTurnWasFenced(input.providerResponseId)
    input.state.acceptance = superseded ? this.#supersededAcceptance(input.event) : acceptance
    input.state.observation = superseded ? 'superseded' : 'observed'
    input.state.dispatch = superseded
      ? 'not_dispatched'
      : acceptance.inline_fulfilled
        ? 'fulfilled'
        : 'rejected'
    input.state.sync = 'none'
    this.#recordToolAdmission({
      callId: input.event.call_id,
      logicalName: input.state.logical_name,
      acceptance: input.state.acceptance,
      superseded,
    })
    if (input.state.acceptance.inline_fulfilled && input.state.acceptance.telemetry !== null) {
      this.#ports.telemetry?.record('memory.recall', input.state.acceptance.telemetry)
    }
    const batch = this.#continuationBatches.get(callKey(input.event.session_epoch, input.providerResponseId))
    if (superseded && batch !== undefined) {
      batch.origin_status = 'cancelled'
      batch.phase = 'ready'
    }
    try {
      await this.driveContinuations()
      await this.#ports.deliveryPass()
    } catch (cause) {
      if (cause instanceof ItemDeliveryUncertainError) {
        await this.#ports.recoverUncertainDelivery(cause)
        return
      }
      if (cause instanceof RealtimeDeliveryError) {
        this.#ports.reportDeliveryFailure(cause)
        return
      }
      throw cause
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
      host_item_id: this.#ports.idFactory(),
      event_id: this.#ports.idFactory(),
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

  /** The `executor` argument names a registered host controller, or nothing. */
  #agentExecutorName(value: JsonValue | undefined): string | null {
    return typeof value === 'string' && this.#ports.agentController(value) !== undefined ? value : null
  }

  /**
   * The host tools. A controller receives the fenced public request and returns structured facts;
   * RealtimeService alone maps those facts to provider-facing result language.
   */
  async #interceptHost(event: ToolCallReady, originRef: string | null): Promise<ToolAcceptance | null> {
    if (event.name === CONFIRM_TOOL) {
      return this.#refusalAcceptance(event, 'unknown_confirmation', UNKNOWN_CONFIRMATION_TOOL_RESULT)
    }
    if(this.#ports.taskHost?.isCurrent?.()===false)return this.#refusalAcceptance(event,'superseded','{"code":"superseded"}')
    if (event.name === 'task') {
      const host=this.#ports.taskHost,user=this.#ports.intakeUser()
      const authority=this.#ports.currentUserTurn(event,originRef)
      if(!host)return this.#refusalAcceptance(event,'unsupported_tool','{"code":"unsupported_tool"}')
      if(!authority||!user||event.session_epoch<=this.#ports.discardedInputEpoch()||user.epoch!==event.session_epoch||originRef!==user.origin_ref)return this.#refusalAcceptance(event,'missing_origin_ref','{"code":"missing_origin_ref"}')
      const taskArguments={...event.arguments};delete taskArguments.origin_ref
      const parsed=taskToolArguments.safeParse(taskArguments)
      if(!parsed.success)return this.#refusalAcceptance(event,'invalid_params','{"code":"invalid_params"}')
      const args=parsed.data,sources=dispatchSources(this.#ports.runtime.memory?.channels.get('conversation')?.items??[])
      if(args.source_refs.some(ref=>!sources.some(source=>source.ref===ref)))return this.#refusalAcceptance(event,'invalid_source_refs','{"code":"invalid_source_refs"}')
      if(!authority.stillWanted())return this.#refusalAcceptance(event,'superseded','{"code":"superseded"}')
      try {
        let task
        if(args.operation==='declare'){const todo=args.link_source_todo?host.sourceTodo?.(user.origin_ref):undefined;if(args.link_source_todo&&!todo)throw Error('source_todo_unavailable');task=await host.tasks.delegate(event.call_id,{conversation_id:host.conversation_id,...(host.conversation_generation===undefined?{}:{conversation_generation:host.conversation_generation}),goal:args.goal,acceptance:args.acceptance,origin_ref:user.origin_ref,...(todo?{todo_ref:todo}:{})})}
        else {
          task=host.tasks.get(args.task_id)
          if(task.conversation_id!==host.conversation_id)throw Error('task_not_owned')
          const fence={task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision}
          if(args.operation==='revise')task=await host.tasks.reviseGoal(event.call_id,fence,{kind:'nova'},args.goal,args.acceptance)
          else if(args.operation==='return'){task=await host.tasks.returnFromUserOrigin(event.call_id,fence,{conversation_id:host.conversation_id,conversation_generation:host.conversation_generation??0,origin_ref:user.origin_ref},()=>authority.stillWanted()&&(host.isCurrent?.()??true));void host.wake?.(task.id)}
          else if(args.operation==='continue'){task=await host.tasks.continue(event.call_id,fence,{kind:'nova'});void host.wake?.(task.id)}
          else if(args.operation==='cancel'){if(!host.cancel)throw Error('task_execution_unavailable');await host.cancel(event.call_id,fence)}
          else throw Error('task_execution_unavailable')
        }
        return {...this.#refusalAcceptance(event,'accepted',canonicalJson({code:'accepted',task_id:task.id})),accepted:true,inline_fulfilled:true}
      }catch(error){const code=error instanceof Error?error.message:'task_failed';return this.#refusalAcceptance(event,code,canonicalJson({code}))}
    }
    if (event.name !== DISPATCH_TOOL && event.name !== CANCEL_TOOL) return null
    const executor = this.#agentExecutorName(event.arguments.executor)
    const raw = event.arguments.instruction
    const instruction = typeof raw === 'string' ? stripLikePython(raw) : null
    const instructionValid = event.name === CANCEL_TOOL && raw === undefined
      ? true
      : instruction !== null && instruction !== '' && codePointLengthLikePython(instruction) <= 4000
    if (executor === null || !instructionValid) {
      return this.#refusalAcceptance(event, 'invalid_params', '{"code":"invalid_params"}')
    }
    // Both act on the user's behalf, so both need the current user turn as origin: a spontaneous
    // `cancel` would stop work nobody asked to stop.
    const user = this.#ports.intakeUser()
    if (event.session_epoch <= this.#ports.discardedInputEpoch() || originRef === null || user?.epoch !== event.session_epoch || originRef !== user.origin_ref) {
      return this.#refusalAcceptance(event, 'missing_origin_ref', '{"code":"missing_origin_ref"}')
    }
    const conversationItems = this.#ports.runtime.memory?.channels.get('conversation')?.items ?? []
    const conversationContext = projectRecoveryTurns(conversationItems,
      {maxPairs: 8, maxChars: 8000}).map(({role, text, sequence}) => ({role, text, sequence}))
    const sources = dispatchSources(conversationItems)
    const sourceRefs = event.arguments.source_refs ?? []
    if (event.name === DISPATCH_TOOL && ('source_quotes' in event.arguments || !Array.isArray(sourceRefs)
      || sourceRefs.length > 8 || sourceRefs.some(ref => typeof ref !== 'string' || !sources.some(source => source.ref === ref)))) {
      return this.#refusalAcceptance(event, 'invalid_source_refs', canonicalJson({
        code: 'invalid_source_refs', parameter: 'source_refs',
        message: '任务尚未提交。source_refs 必须选择用户原话引用目录中的 ref。', sources: recentDispatchSources(conversationItems),
      }))
    }
    const sourceQuotes = sources.filter(source => (sourceRefs as readonly string[]).includes(source.ref)).map(source => source.text)
    const controller = this.#ports.agentController(executor)
    if (controller === undefined) return this.#refusalAcceptance(event, 'unsupported_tool', '{"code":"unsupported_tool"}')
    // A user turn that supersedes an async controller operation makes its result informational only;
    // the controller must re-check this fence before it changes executor state.
    const authority = this.#ports.currentUserTurn(event, originRef)
    if (authority === null) return this.#refusalAcceptance(event, 'superseded', '{"code":"superseded"}')
    const revision = authority.acceptedUserInputRevision
    let taskContext:TaskDispatchContext|undefined
    if(event.name===DISPATCH_TOOL&&event.arguments.task_id!==undefined){
      try{
        const host=this.#ports.taskHost
        if(!host||typeof event.arguments.task_id!=='string')throw Error('invalid_task')
        const task=host.tasks.get(event.arguments.task_id)
        if(task.conversation_id!==host.conversation_id)throw Error('task_not_owned')
        taskContext=host.tasks.continuationContext({task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision});await host.tasks.setRoute(taskContext.fence,executor)
      }catch(error){const code=error instanceof Error?error.message:'invalid_task';return this.#refusalAcceptance(event,code,canonicalJson({code}))}
    }
    const fence = ()=>authority.stillWanted()&&(taskContext?.stillWanted()??true)
    const rawResult = event.name === DISPATCH_TOOL
      ? await controller.dispatch({
        ...(taskContext ? {taskContext} : {}),
        instruction: instruction!, originalUserText: user.text, input_origin_ref:user.origin_ref, origin_ref: taskContext?.origin_ref ?? user.origin_ref,
        conversationContext, sourceQuotes,
        sessionEpoch: event.session_epoch, acceptedUserInputRevision: revision, stillWanted: fence,
      })
      : await controller.cancel({
        ...(instruction === null ? {} : {instruction}), originalUserText: user.text, origin_ref: user.origin_ref,
        sessionEpoch: event.session_epoch, acceptedUserInputRevision: revision, stillWanted: fence,
      })
    const result = parseAgentActionResult(rawResult)
    if (result === null) {
      return this.#refusalAcceptance(event, 'controller_result_invalid', canonicalJson({code: 'controller_result_invalid'}))
    }
    if (result.code === 'delegated') {
      if (!controller.descriptor.ownedChannels.includes(result.detail.channel)) {
        return this.#refusalAcceptance(event, 'controller_result_invalid', canonicalJson({code: 'controller_result_invalid'}))
      }
      return this.#controllerDelegationAcceptance(event, result, instruction!)
    }
    if (result.code === 'monitor_stop_requested'
      && !controller.descriptor.ownedChannels.includes(result.detail.channel)) {
      return this.#refusalAcceptance(event, 'controller_result_invalid', canonicalJson({code: 'controller_result_invalid'}))
    }
    const acceptance = this.#refusalAcceptance(event, result.code, this.#agentActionContent(result))
    return result.accepted ? {...acceptance, accepted: true, inline_fulfilled: true,
      ...(result.code === 'intake_opened' || result.code === 'intake_in_progress'
        ? {continuation: 'deferred' as const} : {}),
    } : acceptance
  }

  #agentActionContent(result: AgentActionResult): string {
    switch (result.code) {
      case 'intake_opened':
      case 'intake_in_progress':
        if (result.detail.state === 'dispatch_unknown') return canonicalJson({
          code: result.code, execution_started: null,
          message: '派单结果暂时无法确认，任务可能已开始。先核实执行状态，不要重复派单。',
        })
        return canonicalJson({
          code: result.code,
          execution_started: false,
        })
      case 'intake_cancelled':
        return canonicalJson({code: result.code, message: '待执行任务已取消，尚未启动。'})
      case 'cancelled':
        return canonicalJson({
          code: result.code,
          message: 'code=cancelled：已请求停止任务，稍后有终态事实。',
        })
      case 'ambiguous_work':
        return canonicalJson({
          code: result.code,
          running_count: result.detail.running.length,
          message: 'code=ambiguous_work：有多个任务正在执行，请说明要停止哪一个。',
        })
      case 'not_running':
        return canonicalJson({code: result.code, message: 'code=not_running：当前没有正在执行的任务。'})
      case 'busy':
        return canonicalJson({code: result.code, message: '当前已有一个监控任务在运行。'})
      case 'clarification_required':
        return canonicalJson({code: result.code, message: '请完整重述需要监控的画面条件、提醒要求和时长。'})
      case 'assessment_unavailable':
        return canonicalJson({code: result.code, message: '暂时无法判断监控请求。'})
      case 'monitor_stop_requested':
        return canonicalJson({code: result.code, message: '已请求停止监控。'})
      case 'accepted':
      case 'delegated':
      case 'unsupported_tool':
      case 'superseded':
      case 'runtime_rejected':
        return canonicalJson({code: result.code})
    }
  }

  #controllerDelegationAcceptance(
    event: ToolCallReady,
    result: Extract<AgentActionResult, {readonly code: 'delegated'}>,
    instruction: string,
  ): ToolAcceptance {
    const hostItem: HostContextItem = {
      kind: 'tool_output', host_item_id: this.#ports.idFactory(), event_id: this.#ports.idFactory(),
      call_id: event.call_id, content: canonicalJson({state: 'accepted'}),
    }
    return {
      accepted: true,
      code: 'accepted',
      host_item: hostItem,
      response_intent: {
        kind: 'delegation_acknowledgement', item: hostItem,
        task_summary: [...stripLikePython(instruction)].slice(0, MAX_CONTINUATION_TASK_SUMMARY).join(''),
        origin_spoken: false,
      },
      delegate_id: result.delegate_id,
      sync_result: false,
      executor: result.detail.channel,
      op: result.detail.op,
      inline_fulfilled: false,
      telemetry: null,
    }
  }

  #recordToolAdmission(input: {
    readonly callId: string
    readonly logicalName: string | null
    readonly acceptance: ToolAcceptance
    readonly superseded: boolean
  }): void {
    if (this.#ports.telemetry === undefined || input.logicalName === null) return
    const outcome = input.superseded
      ? 'superseded'
      : !input.acceptance.accepted
        ? 'rejected'
        : input.acceptance.inline_fulfilled
          ? 'inline'
          : input.acceptance.sync_result
            ? 'sync'
            : 'delegated'
    this.#ports.telemetry.record('tool.admission', {
      logical_name: input.logicalName, call_id: input.callId,
      delegate_id: input.acceptance.delegate_id, outcome, code: input.acceptance.code,
    })
  }

  /** Give the provider the result it is holding a slot for, once. */
  async #confirmSupersededOutput(state: ToolCallState): Promise<void> {
    if (state.output === 'confirmed') return
    await this.session.injectToolOutput(state.acceptance.host_item)
    state.output = 'confirmed'
    state.final_disposition = 'superseded'
  }

  // ---------------------------------------------------------------------------------------------
  // Family M: batching tool results into one turn.
  // ---------------------------------------------------------------------------------------------

  /** A tool continuation inherits evidence only from its confirmed outputs in the current turn. */
  bindToolContinuationOrigin(epoch: number, responseId: string): void {
    if (epoch !== this.session.sessionEpoch || !this.session.responseIsToolContinuation(responseId)) return
    const revision = this.session.providerTurnUserInputRevision(responseId)
    if (revision !== this.session.userInputRevision) return
    let itemId: string | undefined
    // ponytail: bounded ledger scan; index event ids if large continuation batches become common.
    for (const eventId of this.session.responseEventIds(responseId)) {
      const state = [...this.#toolCalls.values(), ...this.#overflowToolCalls.values()].find(current => (
        current.acceptance.host_item.event_id === eventId
        && current.provider_session_epoch === epoch
        && current.output === 'confirmed'
        && current.continuation !== 'abandoned'
        && current.observation !== 'superseded'
      ))
      if (state?.origin_user_input_revision !== revision) return
      const sourceItem = this.#ports.userOrigins.itemForResponse(epoch, state.provider_response_id)
      if (sourceItem === undefined || this.#ports.userOrigins.revisionForItem(epoch, sourceItem) !== revision
        || (itemId !== undefined && itemId !== sourceItem)) return
      itemId = sourceItem
    }
    if (itemId !== undefined) this.#ports.userOrigins.bindRetryResponse({epoch, responseId, itemId})
  }

  /** Bind the head batch to the response that will speak it. */
  bindContinuation(responseId: string): void {
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
      this.#ports.host.bindContinuationAcknowledgement(state, responseId)
    }
  }

  /**
   * Close the head batch when the response that was speaking it ends.
   *
   * Only the head, and only if this is the response it was bound to: a terminal for some other
   * response says nothing about whether this batch was spoken.
   */
  finishContinuation(event: {readonly response_id: string; readonly status: string}): void {
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
        : event.status === 'completed' || event.status === 'yielded'
          ? 'completed'
          : 'abandoned'
    }
    this.#continuationFifo.shift()
  }

  /** A collecting batch whose originating response has ended is ready to speak. */
  finishOrigin(responseId: string): void {
    const batch = this.#continuationBatches.get(callKey(this.session.sessionEpoch, responseId))
    if (batch?.phase !== 'collecting' && batch?.phase !== 'ready') return
    batch.origin_status = this.#originStatus(responseId)
    batch.phase = 'ready'
  }

  abandonProjectConfirmationContinuation(sessionEpoch: number, responseId: string): void {
    const batch = this.#continuationBatches.get(callKey(sessionEpoch, responseId))
    if (batch === undefined) return
    batch.origin_status = 'cancelled'
    batch.phase = 'ready'
  }

  /** Take the deferred calls belonging to one epoch, leaving the rest queued in order. */
  takeConfirmationDeferredCalls(sourceEpoch: number): readonly DeferredOriginToolCall[] {
    const matching: DeferredOriginToolCall[] = []
    const retained: DeferredOriginToolCall[] = []
    for (const deferred of this.#originDeferredToolCalls) {
      (deferred.event.session_epoch === sourceEpoch ? matching : retained).push(deferred)
    }
    this.#originDeferredToolCalls.length = 0
    this.#originDeferredToolCalls.push(...retained)
    return matching
  }

  /** Whether anything at all refers to this turn. A proof nothing can cite is not worth keeping. */
  originCanReferenceProof(key: string): boolean {
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
    return this.#ports.host.originCanReferenceProof(sessionEpoch, responseId)
  }

  /** Whether anything *unfinished* refers to it, which is what makes it unsafe to evict. */
  originHasNonterminalReference(key: string): boolean {
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
    return this.#ports.host.originHasNonterminalReference(sessionEpoch, responseId)
  }

  /** Each tracked tool call's final disposition, in admission order. */
  get toolCallDispositionsForTest(): readonly (string | null)[] {
    return [...this.#toolCalls.values()].map(state => state.final_disposition)
  }
}
