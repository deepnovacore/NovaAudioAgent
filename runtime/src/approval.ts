import type {Clock} from './clock.js'
import {APPROVAL_TTL_SECONDS, type ApprovalDecision, type ApprovalKind, type ApprovalLocalDetail, type ApprovalView, type ApprovalWork, type ApprovalController} from './approval-port.js'
import {MAX_CONCURRENT_WORK, confirmArguments} from './work-tools.js'
import {codePointLengthLikePython, isWellFormed} from './python-text.js'
import {USER_PRIORITY} from './memory.js'
import {ConfirmationTurnIsolation} from './realtime/confirmation-turn-isolation.js'
import type {ToolCallReady} from './realtime/bridge.js'
import type {HostContextItem, HostResponseIntent, RealtimeProviderEvent} from './realtime/protocol.js'
import {RealtimeDeliveryError, type RealtimeSession} from './realtime/session.js'
import type {RealtimeTelemetry} from './realtime/telemetry.js'
import {MAX_HOST_FACT_CHARS, MAX_TRACKED_TOOL_CALLS, callKey, hostFactIntent} from './realtime/service-state.js'

const APPROVAL_ID_LIMIT = 128

export interface ApprovalOffer {
  readonly kind: ApprovalKind
  readonly local_detail: ApprovalLocalDetail
  readonly operation_summary: string
  readonly allowed_decisions?: readonly ApprovalDecision[]
}
export interface ApprovalResolution { readonly decision: ApprovalDecision }

interface PendingApproval {
  readonly id: string
  readonly offer: ApprovalOffer
  readonly work: ApprovalWork | null
  /** Armed when the entry becomes head (spec 08): queue position has no deadline of its own. */
  expiresAt: number
  readonly signal: AbortSignal
  readonly resolve: (resolution: ApprovalResolution) => void
  /** Replaced by `release`, which re-arms the head with a fresh deadline. */
  expiryAbort: AbortController
  /** Parked by `hold` behind a project confirmation: the deadline is stale and must not drop the entry. */
  held: boolean
  onSignalAbort: (() => void) | null
  state: 'pending' | 'responding'
  resolution: ApprovalResolution | null
}

export interface HostApprovalControllerOptions {
  readonly clock: Clock
  readonly idFactory: () => string
}

/** What a transport needs from the approval FIFO; `forWork` binds it to one running work. */
export type ApprovalPort = Pick<HostApprovalController, 'offer' | 'consume' | 'invalidate'>

/**
 * Owns the executor permission FIFO (spec 08): exactly one approval is voice-visible (the head); later
 * offers queue with their server request still open and get a full TTL once they become head.
 */
export class HostApprovalController {
  readonly #clock: Clock
  readonly #idFactory: () => string
  readonly #observers: ((view: ApprovalView) => void)[] = []
  #current: PendingApproval | null = null
  readonly #queue: PendingApproval[] = []

  constructor(options: HostApprovalControllerOptions) {
    this.#clock = options.clock
    this.#idFactory = options.idFactory
  }

  get view(): ApprovalView {
    const current = this.#current
    if (current === null) return emptyView()
    return {
      pending_approval: true,
      pending_approval_busy: current.state === 'responding',
      pending_approval_id: current.id,
      kind: current.offer.kind,
      local_detail: current.offer.local_detail,
      operation_summary: current.offer.operation_summary,
      expires_at: current.expiresAt,
      ...(current.offer.allowed_decisions === undefined ? {} : {allowed_decisions: current.offer.allowed_decisions}),
      work: current.work,
      queued: this.#queue.length,
      ...(current.held ? {held: true} : {}),
    }
  }

  /** The same surface bound to one running work: its offers carry `work`, its invalidations touch only its own entries. */
  forWork(work: ApprovalWork): ApprovalPort {
    return {
      offer: (input, signal) => this.offer(input, signal, work),
      consume: resolution => this.consume(resolution),
      invalidate: reason => this.invalidateWork(work.work_id, reason),
    }
  }

  get pending(): boolean {
    return this.#current?.state === 'pending' && (this.#current.held || this.#clock.now() < this.#current.expiresAt)
  }

  /** Park the head (spec 08: it waits behind a project confirmation). The timer stops; a renderer click still decides. */
  hold(): boolean {
    const current = this.#current
    if (current?.state !== 'pending' || current.held) return false
    if (this.#clock.now() >= current.expiresAt) {
      this.#drop(current)
      return false
    }
    current.held = true
    current.expiryAbort.abort()
    this.#publish()
    return true
  }

  /** Un-park the head with a fresh full TTL, exactly as if it had just been promoted. */
  release(): boolean {
    const current = this.#current
    if (current?.state !== 'pending' || !current.held) return false
    current.held = false
    current.expiryAbort = new AbortController()
    this.#arm(current)
    this.#publish()
    return true
  }

  observe(observer: (view: ApprovalView) => void): () => void {
    this.#observers.push(observer)
    return (): void => {
      const index = this.#observers.indexOf(observer)
      if (index !== -1) this.#observers.splice(index, 1)
    }
  }

  /** Offer only host-sanitized display facts. A concurrent offer queues behind the head. */
  async offer(
    input: ApprovalOffer,
    signal: AbortSignal,
    work: ApprovalWork | null = null,
  ): Promise<ApprovalResolution | null> {
    if (!(signal instanceof AbortSignal) || signal.aborted) return null
    const offer = input
    // ponytail: the FIFO holds at most MAX_CONCURRENT_WORK entries and one per work. An executor turn blocks
    // on its pending approval, so a second request from the same work is a protocol anomaly, and there
    // are never more asking works than run slots. An over-cap offer is declined at once (the shape the
    // transport already handles) and publishes nothing; a per-work sub-queue is the upgrade path if a
    // transport ever legitimately pipelines approvals.
    const pending = this.#current === null ? this.#queue : [this.#current, ...this.#queue]
    if (
      pending.length >= MAX_CONCURRENT_WORK
      || (work !== null && pending.some(entry => entry.work?.work_id === work.work_id))
    ) return Object.freeze({decision: 'decline'})
    const id = validateApprovalId(this.#idFactory())
    let resolve!: (resolution: ApprovalResolution) => void
    const decision = new Promise<ApprovalResolution>(done => { resolve = done })
    const entry: PendingApproval = {
      id,
      offer,
      work,
      expiresAt: 0,
      signal,
      resolve,
      expiryAbort: new AbortController(),
      held: false,
      onSignalAbort: null,
      state: 'pending',
      resolution: null,
    }
    entry.onSignalAbort = () => { this.#drop(entry) }
    signal.addEventListener('abort', entry.onSignalAbort, {once: true})
    if (this.#current === null) this.#promote(entry)
    else this.#queue.push(entry)
    this.#publish()
    return await decision
  }

  /** Accept exactly one structured decision for the current Nova-generated public ID. */
  acceptDecision(input: {
    readonly approvalId: string
    readonly decision: ApprovalDecision
  }): boolean {
    const current = this.#current
    if (
      current?.state !== 'pending'
      || typeof input.approvalId !== 'string'
      || input.approvalId !== current.id
      || !(current.offer.allowed_decisions ?? ['accept', 'decline']).includes(input.decision)
    ) return false
    if ((!current.held && this.#clock.now() >= current.expiresAt) || current.signal.aborted) {
      this.#drop(current)
      return false
    }
    const resolution = Object.freeze({decision: input.decision})
    current.state = 'responding'
    current.resolution = resolution
    current.expiryAbort.abort()
    current.resolve(resolution)
    this.#publish()
    return true
  }

  /** Spend a returned resolution once; stale or invalidated resolutions become decline. */
  consume(resolution: ApprovalResolution): ApprovalDecision {
    const current = this.#current
    if (
      current?.state !== 'responding'
      || current.resolution !== resolution
      || current.signal.aborted
    ) return 'decline'
    const decision = resolution.decision
    this.#detach(current)
    this.#current = null
    this.#promoteNext()
    this.#publish()
    return decision
  }

  /** Drop the head (expiry, epoch change, carrier loss); the next queued entry becomes visible. */
  invalidate(reason: string): boolean {
    void reason
    const current = this.#current
    if (current === null) return false
    this.#drop(current)
    return true
  }

  /** Drop every entry of one work (its turn ended or its transport closed) without touching other works. */
  invalidateWork(workId: string, reason: string): boolean {
    void reason
    const owned = [this.#current, ...this.#queue].filter(
      (entry): entry is PendingApproval => entry?.work?.work_id === workId,
    )
    for (const entry of owned) this.#drop(entry)
    return owned.length > 0
  }

  async #expireAtDeadline(current: PendingApproval): Promise<void> {
    try {
      await this.#clock.sleep(
        Math.max(0, current.expiresAt - this.#clock.now()),
        current.expiryAbort.signal,
      )
    } catch {
      return
    }
    if (this.#current !== current || current.held || this.#clock.now() < current.expiresAt) return
    this.#drop(current)
  }

  #promote(entry: PendingApproval): void {
    this.#current = entry
    this.#arm(entry)
  }

  #arm(entry: PendingApproval): void {
    entry.expiresAt = this.#clock.now() + APPROVAL_TTL_SECONDS
    void this.#expireAtDeadline(entry)
  }

  #promoteNext(): void {
    const next = this.#queue.shift()
    if (next !== undefined) this.#promote(next)
  }

  /** Remove one entry wherever it sits, declining it if still undecided; a dropped head promotes the next. */
  #drop(entry: PendingApproval): void {
    if (this.#current === entry) {
      this.#current = null
      this.#promoteNext()
    } else {
      const index = this.#queue.indexOf(entry)
      if (index === -1) return
      this.#queue.splice(index, 1)
    }
    this.#detach(entry)
    if (entry.state === 'pending') entry.resolve(Object.freeze({decision: 'decline' as const}))
    this.#publish()
  }

  #detach(entry: PendingApproval): void {
    entry.expiryAbort.abort()
    if (entry.onSignalAbort !== null) {
      entry.signal.removeEventListener('abort', entry.onSignalAbort)
      entry.onSignalAbort = null
    }
  }

  #publish(): void {
    const view = this.view
    for (const observer of [...this.#observers]) {
      try { observer(view) } catch { /* observers never own approval state */ }
    }
  }
}

function emptyView(): ApprovalView {
  return {
    pending_approval: false,
    pending_approval_busy: false,
    kind: null,
    local_detail: null,
    operation_summary: null,
    expires_at: null,
    work: null,
    queued: 0,
  }
}

function validateApprovalId(value: string): string {
  if (
    typeof value !== 'string'
    || !isWellFormed(value)
    || value === ''
    || codePointLengthLikePython(value) > APPROVAL_ID_LIMIT
  ) throw new TypeError('invalid approval id')
  return value
}

/** Host-owned voice approval authority. Realtime supplies transport and forwards lifecycle events. */

const APPROVAL_CLARIFICATION = '请明确说同意或拒绝。'
interface ApprovalHostPort {
  readonly session: RealtimeSession
  readonly clock: Clock
  readonly idFactory: () => string
  readonly controller: ApprovalController | undefined
  readonly telemetry: RealtimeTelemetry | undefined
  readonly projectBlocking: () => boolean
  readonly displayName: () => string
  readonly queueHostItem: (intent: HostResponseIntent, options: {priority: number; preemptive: boolean}) => unknown
  readonly deliveryReady: () => void
  readonly reportDeliveryFailure: (failure: RealtimeDeliveryError) => void
  readonly retireProviderHostEventNow: (eventId: string) => Promise<void>
  readonly retireProviderHostEvent: (eventId: string) => void
  readonly removeQueuedPrompt: (approvalId: string) => void
  readonly releaseQuestion: (approvalId: string) => void
}

type ExecutorApprovalDecisionReason =
  | 'not_pending'
  | 'epoch_mismatch'
  | 'authority_missing'
  | 'revision_mismatch'
  | 'item_mismatch'
  | 'response_mismatch'
  | 'malformed_arguments'
  | 'expired'
  | 'replaced'
  | 'context_not_ready'
  | 'voice_exhausted'

interface ExecutorApprovalDecisionRetry {
  readonly item_key: string
  readonly source_response_id: string
  requested: boolean
  retry_response_id: string | null
}

interface ExecutorApprovalAuthorityState {
  readonly approvalId: string
  readonly sessionEpoch: number
  readonly expiresAt: number
  readonly lifecycleToken: number
  readonly contextItem: HostContextItem
  contextReady: boolean
  preContextOnset: boolean
  attempt: 0 | 1 | 2
  clarificationQueued: boolean
}

interface ExecutorApprovalPendingResponseQuarantine {
  readonly sessionEpoch: number
  readonly sourceRetry: ExecutorApprovalDecisionRetry | null
  requestFreshResponse: boolean
  responseId: string | null
  terminal: boolean
}

/**
 * The host fact for a pending executor approval (spec 08): names the work when the executor knows it,
 * carries the id the model must copy into `confirm`, and never a wire tool name.
 */
function approvalFactText(view: ApprovalView, id: string, executorDisplayName: string): string {
  const who = view.work === null ? executorDisplayName : `项目 ${view.work.project} · 会话 ${view.work.title}`
  const queued = view.queued > 0 ? `（还有 ${view.queued} 个等待）` : ''
  const summary = (view.operation_summary ?? '').replace(/。$/u, '')
  const text = `权限请求 id=${id}：${who} 请求批准 ${view.kind ?? ''}：${summary}${queued}。`
    + '只有用户本轮明确同意或拒绝后才调用 confirm(id, accepted)；不要朗读 id。'
  return [...text].slice(0, MAX_HOST_FACT_CHARS).join('')
}

interface BoundToolOrigin {
  readonly observedProviderResponseId: string | null
  readonly originItemId: string | null
  readonly originRef: string | null
}

export class ApprovalHost {
  readonly #port: ApprovalHostPort
  readonly #executorApprovalPromptReleaseTasks = new Set<Promise<void>>()
  readonly #executorApprovalIsolation = new ConfirmationTurnIsolation<ToolCallReady>(
    MAX_TRACKED_TOOL_CALLS,
  )
  #executorApprovalAuthority: ExecutorApprovalAuthorityState | null = null
  /** Current controller identity observed independently of the optional provider voice path. */
  #executorApprovalObservedIdentity: {
    readonly approvalId: string
    readonly sessionEpoch: number
    readonly expiresAt: number
  } | null = null
  /** One closed expiry tombstone used only to classify a late decision; never restored or emitted. */
  #executorApprovalExpiredIdentity: {
    readonly approvalId: string
    readonly sessionEpoch: number
  } | null = null
  #executorApprovalLifecycleToken = 0
  #executorApprovalDecisionRetry: ExecutorApprovalDecisionRetry | null = null
  #executorApprovalPendingResponseQuarantine: ExecutorApprovalPendingResponseQuarantine | null = null
  readonly #executorApprovalQuarantinedResponses = new Map<string, null>()
  /** Internal response identity -> closed attempt number; IDs never enter approval telemetry. */
  readonly #executorApprovalCarrierAttempts = new Map<string, 1 | 2>()
  #executorApprovalNeedsFreshResponse = false

  constructor(port: ApprovalHostPort) { this.#port = port }
  get pendingTasks(): readonly Promise<void>[] { return [...this.#executorApprovalPromptReleaseTasks] }
  async routeExecutorApprovalCall(
    event: ToolCallReady,
    observedResponseId: string | null,
  ): Promise<void> {
    if (
      event.response_id !== null
      && this.isExecutorApprovalResponseQuarantined(event.session_epoch, event.response_id)
    ) {
      await this.handleExecutorApprovalDecision(event, {
        observedProviderResponseId: observedResponseId,
        originItemId: null,
        originRef: null,
      })
      return
    }
    const authority = this.#executorApprovalIsolation.authority
    const responseId = event.response_id
    const providerRevision = responseId === null
      ? undefined
      : this.#port.session.providerTurnUserInputRevision(responseId)
    const reservation = this.#executorApprovalIsolation.reservation
    const revision = responseId !== null
      && reservation !== null
      && this.#executorApprovalIsolation.isAuthorizationCarrier({
        sessionEpoch: event.session_epoch,
        userRevision: reservation.userRevision,
        responseId,
      })
      ? reservation.userRevision
      : providerRevision
    if (
      authority !== null
      && responseId !== null
      && observedResponseId === responseId
      && authority.sessionEpoch === event.session_epoch
      && revision !== undefined
      && revision > authority.createdUserRevision
      && revision === this.#port.session.userInputRevision
    ) {
      const reservation = this.#executorApprovalIsolation.reservation
      if (this.#executorApprovalIsolation.isAuthorizationCarrier({
        sessionEpoch: event.session_epoch,
        userRevision: revision,
        responseId,
      })) {
        await this.handleExecutorApprovalDecision(event, {
          observedProviderResponseId: responseId,
          originItemId: reservation?.itemId ?? null,
          originRef: null,
        })
        return
      }
      const deferred = this.#executorApprovalIsolation.deferCall({
        sessionEpoch: event.session_epoch,
        userRevision: revision,
        responseId,
        call: event,
      })
      if (deferred === 'deferred') return
    }
    const decision = confirmArguments(event.arguments)
    if (
      authority !== null
      && responseId !== null
      && observedResponseId === responseId
      && authority.sessionEpoch === event.session_epoch
      && providerRevision === authority.createdUserRevision
      && this.#port.controller?.pending === true
      && this.#port.clock.now() < authority.expiresAt
      && decision?.id === authority.authorityId
    ) {
      const deferred = this.#executorApprovalIsolation.deferProvisionalCall({
        sessionEpoch: event.session_epoch,
        responseId,
        call: event,
      })
      if (deferred === 'deferred') return
    }
    await this.handleExecutorApprovalDecision(event, {
      observedProviderResponseId: observedResponseId,
      originItemId: null,
      originRef: null,
    })
  }

  syncExecutorApproval(view: ApprovalView): void {
    if (
      view.pending_approval
      && !view.pending_approval_busy
      && view.pending_approval_id !== undefined
      && view.kind !== null
      && view.operation_summary !== null
    ) {
      if (this.#port.session.sessionEpoch < 1 || view.expires_at === null) return
      this.#executorApprovalObservedIdentity = {
        approvalId: view.pending_approval_id,
        sessionEpoch: this.#port.session.sessionEpoch,
        expiresAt: view.expires_at,
      }
      if (this.#port.projectBlocking()) {
        // Spec 08: the approval keeps its queue place, its TTL is paused (`hold`) and it is not voice-armed
        // while a project confirmation holds the floor; `#publishProjectView` releases it once that settles.
        if (this.#executorApprovalAuthority !== null) this.#clearExecutorApprovalVoiceState()
        this.#port.controller?.hold()
        return
      }
      if (
        this.#executorApprovalAuthority?.approvalId === view.pending_approval_id
        && this.#executorApprovalAuthority.sessionEpoch === this.#port.session.sessionEpoch
      ) return
      this.#executorApprovalExpiredIdentity = null
      if (this.#executorApprovalAuthority !== null) this.#clearExecutorApprovalVoiceState()
      this.#executorApprovalLifecycleToken += 1
      const contextItem = hostFactIntent({
        kind: 'final',
        host_item_id: this.#port.idFactory(),
        event_id: `approval:${view.pending_approval_id}:requested`,
        content: approvalFactText(view, view.pending_approval_id, this.#port.displayName()),
      }).item
      const authority: ExecutorApprovalAuthorityState = {
        approvalId: view.pending_approval_id,
        sessionEpoch: this.#port.session.sessionEpoch,
        expiresAt: view.expires_at,
        lifecycleToken: this.#executorApprovalLifecycleToken,
        contextItem,
        contextReady: false,
        preContextOnset: false,
        attempt: 0,
        clarificationQueued: false,
      }
      this.#executorApprovalAuthority = authority
      this.#executorApprovalDecisionRetry = null
      if (
        this.#executorApprovalPendingResponseQuarantine?.sessionEpoch
        !== this.#port.session.sessionEpoch
      ) this.#executorApprovalPendingResponseQuarantine = null
      this.#executorApprovalNeedsFreshResponse = false
      this.#executorApprovalIsolation.invalidate()
      this.#trackExecutorApprovalTask(this.#prepareExecutorApprovalContext(authority))
      return
    }
    const observed = this.#executorApprovalObservedIdentity
    if (observed !== null) {
      this.#executorApprovalExpiredIdentity = this.#port.clock.now() >= observed.expiresAt
        ? {
            approvalId: observed.approvalId,
            sessionEpoch: observed.sessionEpoch,
          }
        : null
      this.#executorApprovalObservedIdentity = null
    }
    this.#clearExecutorApprovalVoiceState()
    this.#port.deliveryReady()
  }

  async #prepareExecutorApprovalContext(authority: ExecutorApprovalAuthorityState): Promise<void> {
    let injected = false
    try {
      injected = await this.#port.session.injectHostContext(authority.contextItem)
    } catch (failure) {
      this.#port.reportDeliveryFailure(failure instanceof RealtimeDeliveryError
        ? failure
        : new RealtimeDeliveryError(String(failure)))
    }
    if (!this.#executorApprovalAuthorityIsCurrent(authority)) {
      this.#port.telemetry?.record('approval.context', {
        session_epoch: authority.sessionEpoch,
        outcome: 'stale',
      })
      if (injected) await this.#port.retireProviderHostEventNow(authority.contextItem.event_id)
      return
    }
    if (!injected) {
      this.#port.telemetry?.record('approval.context', {
        session_epoch: authority.sessionEpoch,
        outcome: 'failed',
      })
      // A context that was not confirmed cannot support voice authority. Keep the renderer's
      // controller pending, but release the foreground so an existing task receipt is not held until
      // the approval TTL. Uncertain injection is intentionally not retried: the provider may already
      // have accepted the fact even though this session could not confirm it.
      this.#clearExecutorApprovalVoiceState()
      this.#port.deliveryReady()
      return
    }
    authority.contextReady = true
    this.#port.telemetry?.record('approval.context', {
      session_epoch: authority.sessionEpoch,
      outcome: 'ready',
    })
    if (authority.preContextOnset) {
      this.#beginExecutorApprovalAttempt(
        authority,
        2,
        this.#port.session.userInputRevision,
        'rotated',
      )
      this.#queueExecutorApprovalClarification(authority)
      return
    }
    this.#beginExecutorApprovalAttempt(authority, 1, this.#port.session.userInputRevision, 'begun')
    // The fact is already in provider context. This queued delivery therefore only creates its
    // host-owned audible response and cannot expose a response before context confirmation.
    this.#port.queueHostItem({
      kind: 'host_fact',
      item: authority.contextItem,
      task_summary: null,
      origin_spoken: false,
    }, {
      priority: USER_PRIORITY - 1,
      preemptive: true,
    })
  }

  #executorApprovalAuthorityIsCurrent(authority: ExecutorApprovalAuthorityState): boolean {
    return this.#executorApprovalAuthority === authority
      && authority.lifecycleToken === this.#executorApprovalLifecycleToken
      && authority.sessionEpoch === this.#port.session.sessionEpoch
      && this.#port.controller?.pending === true
      && this.#port.clock.now() < authority.expiresAt
  }

  #trackExecutorApprovalTask(work: Promise<void>): void {
    const task = work.finally(() => {
      this.#executorApprovalPromptReleaseTasks.delete(task)
    })
    this.#executorApprovalPromptReleaseTasks.add(task)
  }

  #beginExecutorApprovalAttempt(
    authority: ExecutorApprovalAuthorityState,
    attempt: 1 | 2,
    createdUserRevision: number,
    action: 'begun' | 'rotated',
  ): void {
    if (!this.#executorApprovalAuthorityIsCurrent(authority)) return
    authority.attempt = attempt
    this.#executorApprovalDecisionRetry = null
    this.#executorApprovalIsolation.beginAuthority({
      authorityId: authority.approvalId,
      sessionEpoch: authority.sessionEpoch,
      createdUserRevision,
      expiresAt: authority.expiresAt,
    })
    this.#port.telemetry?.record('approval.attempt', {
      session_epoch: authority.sessionEpoch,
      attempt,
      action,
    })
  }

  /** The only extra audible prompt; it uses host createResponse, never a free provider retry. */
  #queueExecutorApprovalClarification(authority: ExecutorApprovalAuthorityState): void {
    if (!this.#executorApprovalAuthorityIsCurrent(authority) || authority.clarificationQueued) return
    authority.clarificationQueued = true
    this.#port.queueHostItem(hostFactIntent({
      kind: 'final',
      host_item_id: this.#port.idFactory(),
      event_id: `approval:${authority.approvalId}:clarification`,
      content: APPROVAL_CLARIFICATION,
    }), {priority: USER_PRIORITY - 1, preemptive: true})
  }

  noteExecutorApprovalOnsetBeforeContext(): void {
    const authority = this.#executorApprovalAuthority
    if (authority !== null && !authority.contextReady) authority.preContextOnset = true
  }

  /** Retain one provider inference whose response id has not arrived yet across lifecycle changes. */
  #capturePendingExecutorApprovalResponse(requestFreshResponse: boolean): void {
    const retry = this.#executorApprovalDecisionRetry
    const reservation = this.#executorApprovalIsolation.reservation
    const pendingRetry = retry?.requested === true && retry.retry_response_id === null
    const pendingInitial = !pendingRetry
      && reservation !== null
      && !this.#executorApprovalIsolation.blockedResponses.some(response => (
        response.authorizationCarrier && response.userRevision === reservation.userRevision
      ))
    if (!pendingRetry && !pendingInitial) return
    const current = this.#executorApprovalPendingResponseQuarantine
    if (current !== null) {
      if (current.sessionEpoch === this.#port.session.sessionEpoch) {
        current.requestFreshResponse ||= requestFreshResponse
      }
      return
    }
    this.#executorApprovalPendingResponseQuarantine = {
      sessionEpoch: this.#port.session.sessionEpoch,
      sourceRetry: pendingRetry ? retry : null,
      requestFreshResponse,
      responseId: null,
      terminal: false,
    }
  }

  /** The first response identity observed for the retained one-inference provider slot owns it. */
  #claimPendingExecutorApprovalResponseQuarantine(
    sessionEpoch: number,
    responseId: string | null,
  ): void {
    const pending = this.#executorApprovalPendingResponseQuarantine
    if (
      responseId === null
      || pending?.sessionEpoch !== sessionEpoch
      || pending.responseId !== null
    ) return
    pending.responseId = responseId
    this.#rememberExecutorApprovalQuarantinedResponse(sessionEpoch, responseId)
    this.#port.session.suppressResponse(responseId)
  }

  isExecutorApprovalResponseQuarantined(sessionEpoch: number, responseId: string): boolean {
    return this.#executorApprovalQuarantinedResponses.has(callKey(sessionEpoch, responseId))
  }

  #rememberExecutorApprovalQuarantinedResponse(sessionEpoch: number, responseId: string): void {
    const key = callKey(sessionEpoch, responseId)
    this.#executorApprovalQuarantinedResponses.delete(key)
    this.#executorApprovalQuarantinedResponses.set(key, null)
    while (this.#executorApprovalQuarantinedResponses.size > MAX_TRACKED_TOOL_CALLS) {
      const oldest = this.#executorApprovalQuarantinedResponses.keys().next()
      if (oldest.done) break
      this.#executorApprovalQuarantinedResponses.delete(oldest.value)
    }
  }

  async finishPendingExecutorApprovalResponseQuarantine(
    sessionEpoch: number,
    responseId: string,
  ): Promise<void> {
    const pending = this.#executorApprovalPendingResponseQuarantine
    if (
      pending?.sessionEpoch !== sessionEpoch
      || pending.responseId !== responseId
    ) return
    pending.terminal = true
    if (pending.requestFreshResponse) this.#executorApprovalNeedsFreshResponse = true
    this.#executorApprovalPendingResponseQuarantine = null
    await this.maybeRequestFreshExecutorApprovalResponse()
    this.#port.deliveryReady()
  }

  /** A failed stale request proves that its not-yet-identified response can no longer arrive. */
  #releaseFailedExecutorApprovalResponseRequest(retry: ExecutorApprovalDecisionRetry): void {
    const pending = this.#executorApprovalPendingResponseQuarantine
    if (pending?.sourceRetry === retry && pending.responseId === null) {
      this.#executorApprovalPendingResponseQuarantine = null
    }
  }

  #clearExecutorApprovalVoiceState(): void {
    const authority = this.#executorApprovalAuthority
    this.#executorApprovalLifecycleToken += 1
    this.#capturePendingExecutorApprovalResponse(false)
    const abandonedCalls = this.#executorApprovalIsolation.takeAbandonedCalls()
    if (authority !== null) {
      this.#port.removeQueuedPrompt(authority.approvalId)
      this.#port.releaseQuestion(authority.approvalId)
      this.#quarantineExecutorApprovalCarriers()
      this.#retireExecutorApprovalProviderContext(authority.approvalId)
    }
    this.#executorApprovalAuthority = null
    this.#executorApprovalDecisionRetry = null
    this.#executorApprovalNeedsFreshResponse = false
    this.#executorApprovalIsolation.invalidate()
    this.#scheduleExecutorApprovalRefusals(abandonedCalls)
  }

  #retireExecutorApprovalProviderContext(approvalId: string): void {
    this.#port.retireProviderHostEvent(`approval:${approvalId}:requested`)
    this.#port.retireProviderHostEvent(`approval:${approvalId}:clarification`)
  }

  #isExecutorApprovalHostResponse(responseId: string): boolean {
    return this.#port.session.responseEventIds(responseId).some(eventId => (
      eventId.startsWith('approval:')
      && (eventId.endsWith(':requested') || eventId.endsWith(':clarification'))
    ))
  }

  /** Quarantine only exact initial/retry/provisional responses recorded by executor isolation. */
  #quarantineExecutorApprovalCarriers(): void {
    for (const response of this.#executorApprovalIsolation.blockedResponses) {
      this.cancelExecutorApprovalPromptResponse(response.sessionEpoch, response.responseId)
    }
  }

  /** Fence one exact already-audible approval response without ever targeting a newer user turn. */
  cancelExecutorApprovalPromptResponse(sessionEpoch: number, responseId: string): void {
    const cancellation = (async (): Promise<void> => {
      if (sessionEpoch !== this.#port.session.sessionEpoch) return
      try {
        await this.#port.session.quarantineResponse(responseId)
      } catch (failure) {
        this.#port.reportDeliveryFailure(failure instanceof RealtimeDeliveryError
          ? failure
          : new RealtimeDeliveryError(String(failure)))
      } finally {
        this.#port.deliveryReady()
      }
    })()
    const task = cancellation.finally(() => {
      this.#executorApprovalPromptReleaseTasks.delete(task)
    })
    this.#executorApprovalPromptReleaseTasks.add(task)
  }

  /** Reserve one exact item in the current attempt; one newer revision gets a fresh isolation. */
  async reserveExecutorApprovalItem(sessionEpoch: number, itemId: string | null): Promise<void> {
    const state = this.#executorApprovalAuthority
    let authority = this.#executorApprovalIsolation.authority
    if (
      itemId === null
      || this.#port.controller?.pending !== true
      || state === null
      || !state.contextReady
      || authority?.sessionEpoch !== sessionEpoch
    ) return
    const userRevision = this.#port.session.userInputRevision
    const existing = this.#executorApprovalIsolation.reservation
    const supersedesTrackedCarrier = existing === null
      && this.#executorApprovalIsolation.blockedResponses.some(response => (
        response.userRevision !== null && response.userRevision < userRevision
      ))
    if (
      existing !== null && userRevision > existing.userRevision
      || supersedesTrackedCarrier
    ) {
      if (state.attempt !== 1) {
        await this.#retireExecutorApprovalVoiceAuthority()
        return
      }
      this.#rotateExecutorApprovalAttempt(state, userRevision - 1)
      authority = this.#executorApprovalIsolation.authority
      if (authority?.sessionEpoch !== sessionEpoch) return
    }
    const abandonedCalls = this.#executorApprovalIsolation.takeAbandonedCalls({
      sessionEpoch,
      userRevision,
    })
    if (abandonedCalls.length > 0) {
      await this.#refuseExecutorApprovalCalls(abandonedCalls)
    }
    const result = this.#executorApprovalIsolation.reserveUserItem({
      sessionEpoch,
      itemId,
      userRevision,
    })
    if (result === 'stale') {
      await this.#retireExecutorApprovalVoiceAuthority()
      return
    }
    if (result !== 'reserved' && result !== 'idempotent') return
    const provisional = this.#executorApprovalIsolation.bindProvisionalResponse()
    if (provisional.kind === 'ambiguous') {
      await this.#exhaustExecutorApprovalAttempt()
      return
    }
    if (provisional.kind === 'bound') {
      await this.#bindExecutorApprovalResponse(sessionEpoch, provisional.responseId, userRevision)
      if (provisional.terminal && this.#port.controller?.pending === true) {
        this.#executorApprovalDecisionRetry ??= {
          item_key: callKey(sessionEpoch, itemId),
          source_response_id: provisional.responseId,
          requested: false,
          retry_response_id: null,
        }
        await this.#maybeRequestExecutorApprovalDecisionRetry()
      }
      return
    }
    const responseId = this.#port.session.activeProviderResponseId
    if (responseId !== null) await this.#bindExecutorApprovalResponse(sessionEpoch, responseId)
  }

  /** Replace attempt one before any await so old calls/responses cannot enter attempt two. */
  #rotateExecutorApprovalAttempt(
    state: ExecutorApprovalAuthorityState,
    createdUserRevision: number,
  ): void {
    if (!this.#executorApprovalAuthorityIsCurrent(state) || state.attempt !== 1) return
    this.#capturePendingExecutorApprovalResponse(true)
    this.#quarantineExecutorApprovalCarriers()
    const abandoned = this.#executorApprovalIsolation.takeAbandonedCalls()
    this.#beginExecutorApprovalAttempt(state, 2, createdUserRevision, 'rotated')
    this.#scheduleExecutorApprovalRefusals(abandoned)
    this.#port.deliveryReady()
  }

  /** Spend one attempt; only the first exhaustion may create the single host clarification. */
  async #exhaustExecutorApprovalAttempt(): Promise<void> {
    const state = this.#executorApprovalAuthority
    if (state === null || !this.#executorApprovalAuthorityIsCurrent(state)) return
    const attempt = state.attempt
    if (attempt === 1 || attempt === 2) {
      this.#port.telemetry?.record('approval.attempt', {
        session_epoch: state.sessionEpoch,
        attempt,
        action: 'exhausted',
      })
    }
    this.#quarantineExecutorApprovalCarriers()
    const abandoned = this.#executorApprovalIsolation.takeAbandonedCalls()
    this.#executorApprovalDecisionRetry = null
    this.#executorApprovalIsolation.invalidate()
    await this.#refuseExecutorApprovalCalls(abandoned)
    if (!this.#executorApprovalAuthorityIsCurrent(state)) return
    if (attempt === 1 && !state.clarificationQueued) {
      this.#beginExecutorApprovalAttempt(
        state,
        2,
        this.#port.session.userInputRevision,
        'rotated',
      )
      this.#queueExecutorApprovalClarification(state)
      this.#port.deliveryReady()
      return
    }
    state.attempt = 0
    this.#port.deliveryReady()
  }

  /** Bind initial/retry carrier solely through exact authority/item/response/revision identity. */
  async #bindExecutorApprovalResponse(
    sessionEpoch: number,
    responseId: string,
    correlatedRevision?: number,
  ): Promise<boolean> {
    const reservation = this.#executorApprovalIsolation.reservation
    const revision = correlatedRevision ?? this.#port.session.providerTurnUserInputRevision(responseId)
    if (
      reservation?.sessionEpoch !== sessionEpoch
      || revision === undefined
      || revision !== reservation.userRevision
      || revision !== this.#port.session.userInputRevision
    ) return false
    await this.#refuseExecutorApprovalCalls(this.#executorApprovalIsolation.takeAbandonedCalls({
      sessionEpoch,
      userRevision: revision,
      responseId,
    }))
    const retry = this.#executorApprovalDecisionRetry
    const result = retry?.requested === true
      && retry.retry_response_id === null
      ? this.#executorApprovalIsolation.bindRetryResponse({
          sessionEpoch,
          itemId: reservation.itemId,
          userRevision: revision,
          responseId,
        })
      : this.#executorApprovalIsolation.bindResponse({
          sessionEpoch,
          itemId: reservation.itemId,
          userRevision: revision,
          responseId,
        })
    if (result !== 'bound' && result !== 'idempotent') return false
    if (retry?.requested === true && retry.retry_response_id === null) {
      retry.retry_response_id = responseId
    }
    this.#executorApprovalIsolation.markBlockedResponse({sessionEpoch, responseId})
    this.#port.session.suppressResponse(responseId)
    if (result === 'bound') {
      const attempt = this.#executorApprovalAuthority?.attempt
      if (attempt === 1 || attempt === 2) {
        const key = callKey(sessionEpoch, responseId)
        this.#executorApprovalCarrierAttempts.delete(key)
        this.#executorApprovalCarrierAttempts.set(key, attempt)
        while (this.#executorApprovalCarrierAttempts.size > MAX_TRACKED_TOOL_CALLS) {
          const oldest = this.#executorApprovalCarrierAttempts.keys().next()
          if (oldest.done) break
          this.#executorApprovalCarrierAttempts.delete(oldest.value)
        }
        this.#port.telemetry?.record('approval.carrier', {
          session_epoch: sessionEpoch,
          attempt,
          action: 'bound',
        })
      }
    }
    const calls = this.#executorApprovalIsolation.releaseCallsForResponse({
      sessionEpoch,
      userRevision: revision,
      responseId,
    })
    for (const call of calls) {
      await this.handleExecutorApprovalDecision(call, {
        observedProviderResponseId: responseId,
        originItemId: reservation.itemId,
        originRef: null,
      })
    }
    return true
  }

  /** One exact silent carrier may request one same-reservation structured-decision retry. */
  async #maybeRequestExecutorApprovalDecisionRetry(): Promise<void> {
    const retry = this.#executorApprovalDecisionRetry
    const reservation = this.#executorApprovalIsolation.reservation
    const authority = this.#executorApprovalIsolation.authority
    const state = this.#executorApprovalAuthority
    if (
      retry === null
      || retry.requested
      || reservation === null
      || authority === null
      || state === null
      || retry.item_key !== callKey(reservation.sessionEpoch, reservation.itemId)
      || this.#port.controller?.pending !== true
      || this.#port.clock.now() >= authority.expiresAt
    ) return
    const attempt = state.attempt
    retry.requested = true
    if (attempt === 1 || attempt === 2) {
      this.#port.telemetry?.record('approval.carrier', {
        session_epoch: state.sessionEpoch,
        attempt,
        action: 'retry_requested',
      })
    }
    let requested = false
    try {
      requested = await this.#port.session.requestUserResponse()
    } catch (failure) {
      this.#port.reportDeliveryFailure(failure instanceof RealtimeDeliveryError
        ? failure
        : new RealtimeDeliveryError(String(failure)))
    }
    if (!requested && (attempt === 1 || attempt === 2)) {
      this.#port.telemetry?.record('approval.carrier', {
        session_epoch: state.sessionEpoch,
        attempt,
        action: 'retry_failed',
      })
    }
    const stillCurrent = this.#executorApprovalAuthorityIsCurrent(state)
      && state.attempt === attempt
      && this.#executorApprovalDecisionRetry === retry
      && this.#executorApprovalIsolation.authority === authority
      && this.#executorApprovalIsolation.reservation === reservation
    if (!stillCurrent) {
      if (!requested) this.#releaseFailedExecutorApprovalResponseRequest(retry)
      return
    }
    if (requested) return
    await this.#exhaustExecutorApprovalAttempt()
  }

  /** Replace one ambiguous old retry with an initial carrier request for the fresh attempt. */
  async maybeRequestFreshExecutorApprovalResponse(): Promise<void> {
    const state = this.#executorApprovalAuthority
    if (
      !this.#executorApprovalNeedsFreshResponse
      || state === null
      || !this.#executorApprovalAuthorityIsCurrent(state)
      || state.attempt !== 2
      || this.#executorApprovalIsolation.reservation === null
    ) return
    let requested = false
    try {
      requested = await this.#port.session.requestUserResponse()
    } catch (failure) {
      this.#port.reportDeliveryFailure(failure instanceof RealtimeDeliveryError
        ? failure
        : new RealtimeDeliveryError(String(failure)))
    }
    if (requested) this.#executorApprovalNeedsFreshResponse = false
  }

  blocksExecutorApprovalTool(event: {
    readonly session_epoch: number
    readonly response_id: string | null
  }): boolean {
    if (
      event.response_id !== null
      && this.isExecutorApprovalResponseQuarantined(event.session_epoch, event.response_id)
    ) return true
    return event.response_id !== null && this.#executorApprovalIsolation.responseState({
        sessionEpoch: event.session_epoch,
        responseId: event.response_id,
      })?.blocked === true
  }

  async closeExecutorApprovalCarrierTool(event: ToolCallReady): Promise<void> {
    await this.#port.session.injectToolOutput({
      kind: 'tool_output',
      host_item_id: this.#port.idFactory(),
      event_id: this.#port.idFactory(),
      call_id: event.call_id,
      content: JSON.stringify({code: 'approval_carrier_tool_refused', state: 'refused'}),
    })
  }

  /** Complete every abandoned current-session function without routing output to a retired epoch. */
  async #refuseExecutorApprovalCalls(calls: readonly ToolCallReady[]): Promise<void> {
    for (const call of calls) {
      if (call.session_epoch !== this.#port.session.sessionEpoch) continue
      try {
        await this.#port.session.injectToolOutput({
          kind: 'tool_output',
          host_item_id: this.#port.idFactory(),
          event_id: this.#port.idFactory(),
          call_id: call.call_id,
          content: JSON.stringify({code: 'approval_not_authorized', state: 'refused'}),
        })
      } catch (failure) {
        this.#port.reportDeliveryFailure(failure instanceof RealtimeDeliveryError
          ? failure
          : new RealtimeDeliveryError(String(failure)))
      }
    }
  }

  /** A controller observer is synchronous, so own its protocol-completion work as a tracked task. */
  #scheduleExecutorApprovalRefusals(calls: readonly ToolCallReady[]): void {
    if (calls.length === 0) return
    const refusal = this.#refuseExecutorApprovalCalls(calls)
    const task = refusal.finally(() => {
      this.#executorApprovalPromptReleaseTasks.delete(task)
    })
    this.#executorApprovalPromptReleaseTasks.add(task)
  }

  /** Permanently retire voice authority while leaving renderer/controller/provider-fact policy intact. */
  async #retireExecutorApprovalVoiceAuthority(): Promise<void> {
    const state = this.#executorApprovalAuthority
    if (state?.attempt === 1 || state?.attempt === 2) {
      this.#port.telemetry?.record('approval.attempt', {
        session_epoch: state.sessionEpoch,
        attempt: state.attempt,
        action: 'exhausted',
      })
    }
    this.#capturePendingExecutorApprovalResponse(false)
    this.#quarantineExecutorApprovalCarriers()
    const abandonedCalls = this.#executorApprovalIsolation.takeAbandonedCalls()
    await this.#refuseExecutorApprovalCalls(abandonedCalls)
    this.#executorApprovalDecisionRetry = null
    this.#executorApprovalNeedsFreshResponse = false
    this.#executorApprovalIsolation.invalidate()
    if (state !== null) state.attempt = 0
    this.#port.deliveryReady()
  }

  async handleExecutorApprovalDecision(
    event: ToolCallReady,
    origin: BoundToolOrigin,
  ): Promise<void> {
    const controller = this.#port.controller
    const authority = this.#executorApprovalIsolation.authority
    const reservation = this.#executorApprovalIsolation.reservation
    const decision = confirmArguments(event.arguments)
    const voiceState = this.#executorApprovalAuthority
    let code = decision === null
      ? 'approval_invalid'
      : controller?.pending === true ? 'approval_not_authorized' : 'approval_not_pending'
    let state = 'refused'
    let telemetryOutcome: 'accepted' | 'refused' = 'refused'
    let telemetryReason: ExecutorApprovalDecisionReason | undefined
    const expired = this.#executorApprovalExpiredIdentity
    if (decision === null) telemetryReason = 'malformed_arguments'
    else if (controller?.pending !== true) {
      telemetryReason = expired?.sessionEpoch === event.session_epoch
          && expired.approvalId === decision.id
        ? 'expired'
        : 'not_pending'
    }
    else if (voiceState === null) telemetryReason = 'authority_missing'
    else if (decision.id !== voiceState.approvalId) telemetryReason = 'replaced'
    else if (voiceState.sessionEpoch !== event.session_epoch) telemetryReason = 'epoch_mismatch'
    else if (this.#port.clock.now() >= voiceState.expiresAt) telemetryReason = 'expired'
    else if (!voiceState.contextReady) telemetryReason = 'context_not_ready'
    else if (voiceState.attempt === 0) telemetryReason = 'voice_exhausted'
    else if (authority === null || reservation === null) telemetryReason = 'authority_missing'
    else if (
      origin.originItemId !== null
      && origin.originItemId !== reservation.itemId
    ) telemetryReason = 'item_mismatch'
    else if (
      event.response_id === null
      || origin.observedProviderResponseId !== event.response_id
    ) telemetryReason = 'response_mismatch'
    if (
      decision !== null
      && controller?.pending === true
      && authority !== null
      && telemetryReason === undefined
    ) {
      const responseId = event.response_id
      const providerRevision = responseId === null
        ? undefined
        : this.#port.session.providerTurnUserInputRevision(responseId)
      const revision = responseId !== null
        && reservation !== null
        && this.#executorApprovalIsolation.isAuthorizationCarrier({
          sessionEpoch: event.session_epoch,
          userRevision: reservation.userRevision,
          responseId,
        })
        ? reservation.userRevision
        : providerRevision
      const authorized = authority.authorityId === decision.id
        && authority.sessionEpoch === event.session_epoch
        && this.#port.clock.now() < authority.expiresAt
        && reservation !== null
        && reservation.sessionEpoch === event.session_epoch
        && responseId !== null
        && origin.observedProviderResponseId === responseId
        && revision !== undefined
        && revision === reservation.userRevision
        && revision > authority.createdUserRevision
        && revision === this.#port.session.userInputRevision
        && this.#executorApprovalIsolation.isAuthorizationCarrier({
          sessionEpoch: event.session_epoch,
          userRevision: revision,
          responseId,
        })
      if (!authorized) {
        code = 'approval_not_authorized'
        telemetryReason = revision === undefined || reservation === null
          ? 'revision_mismatch'
          : revision !== reservation.userRevision
              || revision <= authority.createdUserRevision
              || revision !== this.#port.session.userInputRevision
            ? 'revision_mismatch'
            : 'response_mismatch'
      } else if (controller.acceptDecision({
        approvalId: decision.id,
        decision: decision.accepted ? 'accept' : 'decline',
      })) {
        this.#port.session.settleUserResponse(responseId)
        code = decision.accepted ? 'approval_accepted' : 'approval_declined'
        state = decision.accepted ? 'accepted' : 'refused'
        telemetryOutcome = decision.accepted ? 'accepted' : 'refused'
        telemetryReason = undefined
      } else {
        telemetryReason = 'not_pending'
      }
    }
    this.#recordExecutorApprovalDecision(
      event.session_epoch,
      'function',
      telemetryOutcome,
      telemetryReason,
    )
    await this.#port.session.injectToolOutput({
      kind: 'tool_output',
      host_item_id: this.#port.idFactory(),
      event_id: this.#port.idFactory(),
      call_id: event.call_id,
      content: JSON.stringify({code, state}),
    })
  }

  #recordExecutorApprovalDecision(
    sessionEpoch: number,
    source: 'function' | 'renderer',
    outcome: 'accepted' | 'refused',
    reason?: ExecutorApprovalDecisionReason,
  ): void {
    this.#port.telemetry?.record('approval.decision', reason === undefined
      ? {session_epoch: sessionEpoch, source, outcome}
      : {session_epoch: sessionEpoch, source, outcome, reason})
  }

  invalidateExecutorApproval(reason: string): void {
    this.#port.controller?.invalidate(reason)
    if (this.#executorApprovalAuthority !== null) this.#clearExecutorApprovalVoiceState()
  }

  executorApprovalDecision(approvalId: string, approved: boolean, scope?: 'session'): boolean {
    if (typeof approved !== 'boolean' || scope !== undefined && (scope !== 'session' || !approved)) return false
    const controller = this.#port.controller
    if (controller === undefined) return false
    const accepted = controller.acceptDecision({
      approvalId,
      decision: approved ? scope === 'session' ? 'acceptForSession' : 'accept' : 'decline',
    })
    const expired = this.#executorApprovalExpiredIdentity
    this.#recordExecutorApprovalDecision(
      this.#port.session.sessionEpoch,
      'renderer',
      accepted && approved ? 'accepted' : 'refused',
      accepted
        ? undefined
        : controller.pending
          ? controller.view.pending_approval_id !== approvalId ? 'replaced' : 'not_pending'
          : expired?.sessionEpoch === this.#port.session.sessionEpoch
              && expired.approvalId === approvalId
            ? 'expired'
            : 'not_pending',
    )
    return accepted
  }

  sync(): void { if (this.#port.controller !== undefined) this.syncExecutorApproval(this.#port.controller.view) }
  get pending(): boolean { return this.#port.controller?.view.pending_approval === true }
  ownsId(id: string): boolean {
    return this.#port.controller?.view.pending_approval_id === id
      || this.#executorApprovalAuthority?.approvalId === id
      || this.#executorApprovalExpiredIdentity?.approvalId === id
  }
  factEligible(eventId: string): boolean {
    const authority = this.#executorApprovalAuthority
    return authority !== null && eventId.startsWith(`approval:${authority.approvalId}:`)
      && this.#executorApprovalAuthorityIsCurrent(authority)
  }
  blocksSemanticAcknowledgement(eventId: string | null): boolean {
    return this.#executorApprovalAuthority !== null && eventId !== null
  }
  hold(): void {
    if (this.#executorApprovalAuthority !== null) this.#clearExecutorApprovalVoiceState()
    this.#port.controller?.hold()
  }
  release(): void {
    const approval = this.#port.controller
    if (approval?.view.pending_approval === true && !approval.release()) this.syncExecutorApproval(approval.view)
  }
  setResponseFencePending(pending: boolean): void { this.#executorApprovalIsolation.setResponseFencePending(pending) }
  releaseQuestionOnOnset(): void {
    const approvalId = this.#executorApprovalAuthority?.approvalId
    if (approvalId !== undefined) {
      this.#port.removeQueuedPrompt(approvalId)
      this.#port.releaseQuestion(approvalId)
    }
  }
  beforeEvent(event: RealtimeProviderEvent) {
    const executorEventResponseId = 'response_id' in event ? event.response_id : null
    const pendingExecutorResponseQuarantineAtStart = event.kind === 'response_started'
      && this.#executorApprovalPendingResponseQuarantine?.sessionEpoch === event.session_epoch
      && this.#executorApprovalPendingResponseQuarantine.responseId === null
    if (
      event.kind !== 'response_started'
      && (
        executorEventResponseId === null
        || this.#port.session.responseEventIds(executorEventResponseId).length === 0
      )
    ) {
      this.#claimPendingExecutorApprovalResponseQuarantine(
        event.session_epoch,
        executorEventResponseId,
      )
    }
    const executorQuarantinedResponse = executorEventResponseId !== null
      && this.isExecutorApprovalResponseQuarantined(event.session_epoch, executorEventResponseId)

    const executorFencePendingAtStart = this.#executorApprovalIsolation.responseFencePending
    const executorResponseCandidate = event.kind === 'response_started'
      && event.session_epoch === this.#port.session.sessionEpoch
      && !executorFencePendingAtStart
      && this.#port.controller?.pending === true
      && this.#executorApprovalIsolation.authority?.sessionEpoch === event.session_epoch
      && !pendingExecutorResponseQuarantineAtStart
      && this.#port.session.userInputRevision
        > (this.#executorApprovalIsolation.authority?.createdUserRevision ?? Number.MAX_SAFE_INTEGER)
    const provisionalCandidate = event.kind === 'response_started'
      && event.session_epoch === this.#port.session.sessionEpoch
      && !executorFencePendingAtStart
      && this.#port.controller?.pending === true
      && this.#executorApprovalIsolation.reservation === null
      && !pendingExecutorResponseQuarantineAtStart
      && this.#port.session.userInputRevision
        === this.#executorApprovalIsolation.authority?.createdUserRevision
    const responseStartsDuringSpeech = executorResponseCandidate
      && this.#port.session.floor.state === 'user_speaking'
    const orphanedExecutorRetryCandidate = event.kind === 'response_started'
      && (executorQuarantinedResponse || pendingExecutorResponseQuarantineAtStart)
    return {executorFencePendingAtStart, executorResponseCandidate, provisionalCandidate, orphanedExecutorRetryCandidate, pendingExecutorResponseQuarantineAtStart, executorQuarantinedResponse, responseStartsDuringSpeech}
  }
  async afterEventAccepted(event: RealtimeProviderEvent, accepted: boolean, observation: ReturnType<ApprovalHost['beforeEvent']>): Promise<boolean> {
    const {executorFencePendingAtStart, executorResponseCandidate, provisionalCandidate, orphanedExecutorRetryCandidate, pendingExecutorResponseQuarantineAtStart} = observation
    let {executorQuarantinedResponse} = observation
    if (
      event.kind === 'response_started'
      && accepted
      && pendingExecutorResponseQuarantineAtStart
      && this.#port.session.responseEventIds(event.response_id).length === 0
    ) {
      this.#claimPendingExecutorApprovalResponseQuarantine(
        event.session_epoch,
        event.response_id,
      )
      executorQuarantinedResponse = true
    }
    const executorHostOwnedResponse = event.kind === 'response_started'
      && accepted
      && this.#isExecutorApprovalHostResponse(event.response_id)
    if (event.kind === 'response_started' && executorFencePendingAtStart) {
      this.#executorApprovalIsolation.setResponseFencePending(false)
    }
    if (event.kind === 'response_started' && accepted && executorQuarantinedResponse) {
      this.#port.session.suppressResponse(event.response_id)
      this.cancelExecutorApprovalPromptResponse(event.session_epoch, event.response_id)
    }
    if (
      event.kind === 'response_started'
      && accepted
      && executorResponseCandidate
      && !executorHostOwnedResponse
      && !orphanedExecutorRetryCandidate
    ) {
      this.#executorApprovalIsolation.markBlockedResponse({
        sessionEpoch: event.session_epoch,
        responseId: event.response_id,
      })
      this.#port.session.suppressResponse(event.response_id)
      await this.#bindExecutorApprovalResponse(event.session_epoch, event.response_id)
    }
    if (
      event.kind === 'response_started'
      && accepted
      && provisionalCandidate
      && !executorHostOwnedResponse
      && !orphanedExecutorRetryCandidate
      && this.#port.session.responseEventIds(event.response_id).length === 0
    ) {
      const authority = this.#executorApprovalIsolation.authority
      const tracked = authority === null ? 'stale' : this.#executorApprovalIsolation.trackProvisionalResponse({
        sessionEpoch: event.session_epoch,
        userRevision: authority.createdUserRevision + 1,
        responseId: event.response_id,
      })
      if (tracked === 'tracked' || tracked === 'idempotent') {
        this.#port.session.suppressResponse(event.response_id)
      } else if (tracked === 'overflow') {
        await this.#retireExecutorApprovalVoiceAuthority()
      }
    }
    return executorQuarantinedResponse
  }
  noteTerminal(event: Extract<RealtimeProviderEvent, {kind: 'response_terminal'}>): void {
    const executorCarrierKey = callKey(event.session_epoch, event.response_id)
    const executorCarrierAttempt = this.#executorApprovalCarrierAttempts.get(executorCarrierKey)
    if (executorCarrierAttempt !== undefined) {
      this.#executorApprovalCarrierAttempts.delete(executorCarrierKey)
      this.#port.telemetry?.record('approval.carrier', {
        session_epoch: event.session_epoch,
        attempt: executorCarrierAttempt,
        action: 'terminal',
      })
    }
  }

  async settleTerminal(event: Extract<RealtimeProviderEvent, {kind: 'response_terminal'}>): Promise<void> {
    const carrier = this.#executorApprovalIsolation.responseState({
      sessionEpoch: event.session_epoch,
      responseId: event.response_id,
    })
    if (
      carrier?.authorizationCarrier === true
      && !this.#port.session.responseHasSpoken(event.response_id)
      && this.#port.controller?.pending === true
    ) {
      const reservation = this.#executorApprovalIsolation.reservation
      const retry = this.#executorApprovalDecisionRetry
      const isRetryTerminal = retry?.retry_response_id === event.response_id
      if (reservation !== null && !isRetryTerminal) {
        this.#executorApprovalDecisionRetry ??= {
          item_key: callKey(reservation.sessionEpoch, reservation.itemId),
          source_response_id: event.response_id,
          requested: false,
          retry_response_id: null,
        }
        await this.#maybeRequestExecutorApprovalDecisionRetry()
      } else if (reservation !== null && isRetryTerminal) {
        await this.#exhaustExecutorApprovalAttempt()
      }
    }
  }

  clearTerminal(event: Extract<RealtimeProviderEvent, {kind: 'response_terminal'}>): void {
    if (!this.#executorApprovalIsolation.markProvisionalTerminal({
      sessionEpoch: event.session_epoch,
      responseId: event.response_id,
    })) {
      this.#executorApprovalIsolation.clearResponse({
        sessionEpoch: event.session_epoch,
        responseId: event.response_id,
      })
    }
  }
}
