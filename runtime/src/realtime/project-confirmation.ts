/**
 * Host confirmation for a Codex project boundary change.
 *
 * Ported from `src/nova_audio_agent/realtime/project_confirmation.py`. Changing which workspace or
 * Session the agent is operating in is not something a model may do on its own say-so, so the host
 * proposes, the *user* makes a structured decision, and only then is there authority to commit.
 * Everything here exists to make that authority unforgeable: one proposal at a time, one reserved
 * user item that may answer it, and a commit token that can be claimed exactly once. Transcript
 * meaning is deliberately outside this controller.
 */

import type { Clock } from '../clock.js'
import {codePointLengthLikePython} from '../python-text.js'

export type ProjectAction = 'create' | 'select' | 'resume'
export type ConfirmationKind = 'confirmed' | 'cancelled' | 'invalid' | 'expired' | 'ignored'
const EXPIRY_SECONDS = 90

export interface ProjectProposal {
  readonly action: ProjectAction
  readonly workspace_display_name: string
  readonly workspace_id: string | null
  readonly session_title: string | null
  readonly session_id: string | null
  readonly work_order: string | null
  readonly origin_ref: string
  readonly proposal_id: string
  /** Compatibility alias for callers migrated in Task 4 and later. */
  readonly nonce: string
  readonly expires_at: number
  readonly confirmation_prompt: string
}

/** A proposal the user confirmed. Holding one is the authority to commit, once. */
export interface ConfirmedProjectOperation {
  readonly action: ProjectAction
  readonly workspace_display_name: string
  readonly workspace_id: string | null
  readonly session_title: string | null
  readonly session_id: string | null
  readonly work_order: string | null
  readonly origin_ref: string
  readonly proposal_id: string
  /** Compatibility alias for callers migrated in Task 4 and later. */
  readonly nonce: string
}

export interface ProjectConfirmationView {
  readonly pending_confirmation: boolean
  readonly workspace_display_name: string | null
  readonly session_title: string | null
}

export interface ConfirmationOutcome {
  readonly kind: ConfirmationKind
  readonly operation: ConfirmedProjectOperation | null
  readonly response_text: string | null
}

export interface ProjectConfirmationOptions {
  readonly clock: Clock
  readonly idFactory: () => string
  readonly onChange?: (view: ProjectConfirmationView) => void
}

/** Own exactly one proposal, ASR reservation, and commit authority. */
export class ProjectConfirmationController {
  readonly #clock: Clock
  readonly #idFactory: () => string
  readonly #onChange: ((view: ProjectConfirmationView) => void) | undefined
  readonly #expiryObservers: (() => void)[] = []

  #proposal: ProjectProposal | null = null
  /** The one user item allowed to answer the proposal, as `epoch:itemId`. */
  #reserved: string | null = null
  #commitAuthority: ConfirmedProjectOperation | null = null
  #expiryAbort: AbortController | null = null

  constructor(options: ProjectConfirmationOptions) {
    this.#clock = options.clock
    this.#idFactory = options.idFactory
    this.#onChange = options.onChange
  }

  get view(): ProjectConfirmationView {
    const proposal = this.pending ? this.#proposal : null
    return {
      pending_confirmation: proposal !== null,
      workspace_display_name: proposal?.workspace_display_name ?? null,
      session_title: proposal?.session_title ?? null,
    }
  }

  /** A proposal that has passed its deadline is not pending, even before anything expires it. */
  get pending(): boolean {
    return this.#proposal !== null && !this.#isExpired(this.#proposal)
  }

  /**
   * Propose an operation and start its deadline.
   *
   * Replaces any proposal in flight: there is one boundary change under consideration at a time, and
   * the newest one is the one the user was just told about.
   */
  prepare(input: {
    readonly action: ProjectAction
    readonly workspace_display_name: string
    readonly workspace_id: string | null
    readonly session_title: string | null
    readonly session_id: string | null
    readonly work_order: string | null
    readonly origin_ref: string
  }): ProjectProposal {
    validatePrepared(input)
    const proposalId = this.#idFactory()
    if (
      typeof proposalId !== 'string'
      || proposalId === ''
      || codePointLengthLikePython(proposalId) > 128
    ) {
      throw new TypeError('invalid confirmation proposal id')
    }
    const proposal: ProjectProposal = Object.freeze({
      ...input,
      proposal_id: proposalId,
      nonce: proposalId,
      expires_at: this.#clock.now() + EXPIRY_SECONDS,
      confirmation_prompt: confirmationPrompt(
        input.action,
        input.workspace_display_name,
        input.session_title,
        input.work_order !== null,
      ),
    })
    this.#proposal = proposal
    this.#reserved = null
    this.#commitAuthority = null
    this.#scheduleExpiry(proposal)
    this.#publish()
    return proposal
  }

  /** Learn when a proposal expires on its own, so a caller can tell the user. */
  observeExpiry(observer: () => void): () => void {
    this.#expiryObservers.push(observer)
    return (): void => {
      const index = this.#expiryObservers.indexOf(observer)
      if (index !== -1) this.#expiryObservers.splice(index, 1)
    }
  }

  /**
   * Claim one transcript item as the answer to the proposal.
   *
   * The reservation is what stops a later utterance -- or a different provider item -- from being
   * read as the confirmation. Re-reserving the same item is idempotent so a retried delivery does
   * not lose the reservation; reserving a different one is refused.
   */
  reserveUserItem(input: {readonly epoch: number; readonly itemId: string}): boolean {
    const proposal = this.#proposal
    if (proposal === null) return false
    if (this.#isExpired(proposal)) {
      this.expire()
      return false
    }
    // Type-checked, not just value-checked. The reservation key is built by interpolation, so a
    // numeric `7` and the string `'7'` would produce the same key -- letting a malformed reservation
    // be answered by an unrelated transcript, which is the spoken-authorization boundary itself.
    // The oracle rejects a non-string item id outright, and so must this.
    if (typeof input.epoch !== 'number' || !Number.isInteger(input.epoch) || input.epoch < 1) {
      return false
    }
    if (typeof input.itemId !== 'string' || input.itemId === '') return false
    const key = reservationKey(input.epoch, input.itemId)
    if (this.#reserved !== null) return this.#reserved === key
    this.#reserved = key
    return true
  }

  /** Accept only a structured decision bound to the reserved user item and current proposal ID. */
  acceptDecision(input: {
    readonly epoch: number
    readonly itemId: string
    readonly proposalId: string
    readonly confirmed: boolean
  }): ConfirmationOutcome {
    const proposal = this.#proposal
    if (proposal === null || !this.#isReserved(input.epoch, input.itemId)) {
      return outcome('ignored')
    }
    if (this.#isExpired(proposal)) {
      this.#clearAll()
      this.#publish()
      this.#publishExpiry()
      return outcome('expired', {responseText: '确认已过期，本次操作已取消。'})
    }
    if (input.proposalId !== proposal.proposal_id || typeof input.confirmed !== 'boolean') {
      return outcome('invalid', {responseText: '确认请求无效，操作尚未执行。'})
    }
    if (!input.confirmed) {
      this.#clearAll()
      this.#publish()
      return outcome('cancelled', {responseText: '已取消。'})
    }
    const operation = confirmedFrom(proposal)
    this.#proposal = null
    this.#reserved = null
    // Deliberately not `clearAll`: this is where commit authority is *granted*.
    this.#commitAuthority = operation
    this.#publish()
    return outcome('confirmed', {operation})
  }

  /** Release an undecided item without extending or discarding the proposal. */
  releaseUndecided(input: {readonly epoch: number; readonly itemId: string}): boolean {
    if (this.#proposal === null || !this.#isReserved(input.epoch, input.itemId)) return false
    this.#reserved = null
    return true
  }

  /**
   * Fail-closed compatibility for callers replaced by the realtime function handler in Task 4.
   * Transcript contents are intentionally ignored and can never grant authority.
   */
  acceptTranscript(_input: {
    readonly epoch: number
    readonly itemId: string
    readonly text: string
  }): ConfirmationOutcome {
    return outcome('ignored')
  }

  /**
   * Spend the commit authority for exactly this operation.
   *
   * Identity, not equality: the caller has to be holding the object the controller handed out, so a
   * reconstructed operation with the same fields cannot commit. That is what makes replaying a
   * confirmation impossible.
   */
  claimConfirmed(operation: ConfirmedProjectOperation): boolean {
    if (operation !== this.#commitAuthority) return false
    this.#commitAuthority = null
    return true
  }

  /** Transcription failed, so the answer is unknowable and the operation is cancelled. */
  failTranscript(input: {readonly epoch: number; readonly itemId: string}): ConfirmationOutcome {
    if (this.#proposal === null || !this.#isReserved(input.epoch, input.itemId)) {
      return outcome('ignored')
    }
    this.#clearAll()
    this.#publish()
    return outcome('cancelled', {responseText: '语音识别失败，本次操作已取消。'})
  }

  /** Expire a proposal that is past its deadline. A proposal still in time is left alone. */
  expire(): boolean {
    const proposal = this.#proposal
    if (proposal === null || !this.#isExpired(proposal)) return false
    this.#clearAll()
    this.#publish()
    this.#publishExpiry()
    return true
  }

  /**
   * Drop the proposal and any unspent authority.
   *
   * Called when the world the proposal described has changed underneath it -- a reconnect, a new
   * provider session -- so confirming it would commit against a context the user never saw.
   */
  invalidate(reason: string): boolean {
    // The reason is taken for the caller's benefit -- it names the event at the call site -- and
    // deliberately not acted on: every reason invalidates identically.
    void reason
    const changed = this.#proposal !== null || this.#commitAuthority !== null
    if (!changed) return false
    this.#clearAll()
    this.#publish()
    return true
  }

  /**
   * Whether this exact item holds the reservation.
   *
   * Types are checked here too, not only where the reservation is taken: an unreserved caller
   * passing a number must not match a string reservation of the same digits.
   */
  #isReserved(epoch: unknown, itemId: unknown): boolean {
    if (typeof epoch !== 'number' || !Number.isInteger(epoch)) return false
    if (typeof itemId !== 'string') return false
    return this.#reserved === reservationKey(epoch, itemId)
  }

  #isExpired(proposal: ProjectProposal): boolean {
    // `>=` so the instant of expiry is expired, matching the oracle.
    return this.#clock.now() >= proposal.expires_at
  }

  #clearAll(): void {
    this.#proposal = null
    this.#reserved = null
    this.#commitAuthority = null
    const abort = this.#expiryAbort
    this.#expiryAbort = null
    abort?.abort()
  }

  /**
   * Start the deadline timer.
   *
   * A deliberate divergence from the oracle, which schedules nothing when `prepare` is called
   * outside a running asyncio loop -- a proposal made there is never collected, and its `_proposal`
   * is retained after the deadline even though `pending` reports false. That is an artefact of how
   * Python discovers its loop rather than a decision, and it leaves stale authority reachable by
   * anything that inspects state directly. Here the timer is always armed.
   */
  #scheduleExpiry(proposal: ProjectProposal): void {
    this.#expiryAbort?.abort()
    const abort = new AbortController()
    this.#expiryAbort = abort
    void this.#expireGeneration(proposal, abort.signal)
  }

  async #expireGeneration(proposal: ProjectProposal, signal: AbortSignal): Promise<void> {
    try {
      await this.#clock.sleep(Math.max(0, proposal.expires_at - this.#clock.now()), signal)
    } catch {
      // Aborted, which means something already replaced or cleared this proposal.
      return
    }
    // Re-checked rather than trusted: the timer may have been overtaken by a replacement proposal
    // that happens to share a deadline, and identity is what distinguishes them.
    if (this.#proposal !== proposal || !this.#isExpired(proposal)) return
    this.#clearAll()
    this.#publish()
    this.#publishExpiry()
  }

  #publishExpiry(): void {
    // A copy, because an observer may unsubscribe itself while being notified.
    for (const observer of [...this.#expiryObservers]) {
      try {
        observer()
      } catch {
        // An observer's failure is not the controller's to propagate: the proposal is already gone,
        // and throwing here would strand the remaining observers.
      }
    }
  }

  #publish(): void {
    if (this.#onChange === undefined) return
    try {
      this.#onChange(this.view)
    } catch {
      // Same reasoning as the expiry observers: a renderer that cannot accept the view must not
      // prevent the state change that produced it.
    }
  }
}

function reservationKey(epoch: number, itemId: string): string {
  return `${epoch}:${itemId}`
}

function outcome(
  kind: ConfirmationKind,
  extra: {
    readonly operation?: ConfirmedProjectOperation
    readonly responseText?: string
  } = {},
): ConfirmationOutcome {
  return {
    kind,
    operation: extra.operation ?? null,
    response_text: extra.responseText ?? null,
  }
}

function confirmedFrom(proposal: ProjectProposal): ConfirmedProjectOperation {
  return Object.freeze({
    action: proposal.action,
    workspace_display_name: proposal.workspace_display_name,
    workspace_id: proposal.workspace_id,
    session_title: proposal.session_title,
    session_id: proposal.session_id,
    work_order: proposal.work_order,
    origin_ref: proposal.origin_ref,
    proposal_id: proposal.proposal_id,
    nonce: proposal.nonce,
  })
}

function validatePrepared(input: {
  readonly action: ProjectAction
  readonly workspace_display_name: string
  readonly workspace_id: string | null
  readonly session_title: string | null
  readonly session_id: string | null
  readonly work_order: string | null
  readonly origin_ref: string
}): void {
  if (input.action !== 'create' && input.action !== 'select' && input.action !== 'resume') {
    throw new TypeError('invalid project action')
  }
  // Typed *and* non-empty, in that order, because this runs before any state moves. A caller
  // handing over a number would otherwise produce a proposal whose prompt names workspace `42`, and
  // would replace whatever real proposal was pending. The oracle checks the type; so must this.
  if (typeof input.workspace_display_name !== 'string' || input.workspace_display_name === '') {
    throw new TypeError('workspace display name is required')
  }
  for (const value of [
    input.workspace_id,
    input.session_title,
    input.session_id,
    input.work_order,
  ]) {
    // An empty string is not a missing value: it would name a workspace or Session that is not
    // there, so it is rejected rather than coerced to null.
    if (value === null) continue
    if (typeof value !== 'string' || value === '') {
      throw new TypeError('invalid project proposal field')
    }
  }
  if (typeof input.origin_ref !== 'string' || input.origin_ref === '') {
    throw new TypeError('origin ref is required')
  }
  // What each action needs resolved before a user can meaningfully confirm it. Resuming is the
  // strictest: there is no way to confirm continuing a Session whose identity is unknown.
  if (input.action === 'select' && input.workspace_id === null) {
    throw new TypeError('select requires a resolved workspace')
  }
  if (
    input.action === 'resume'
    && (input.workspace_id === null || input.session_id === null || input.work_order === null)
  ) {
    throw new TypeError('resume requires resolved workspace, Session, and work order')
  }
}

/** What the user hears. The wording distinguishes the four shapes a boundary change can take. */
function confirmationPrompt(
  action: ProjectAction,
  workspace: string,
  session: string | null,
  hasWorkOrder: boolean,
): string {
  if (action === 'resume') {
    if (session === null) throw new TypeError('resume requires a Session title')
    return `准备切换到${workspace}，并继续 Session“${session}”，请确认或取消。`
  }
  if (action === 'create' && hasWorkOrder) {
    return `准备创建工作区${workspace}，并在其中开始任务，请确认或取消。`
  }
  if (action === 'create') return `准备创建并切换到工作区${workspace}，请确认或取消。`
  return `准备切换到工作区${workspace}，请确认或取消。`
}
