/**
 * Host confirmation for a Codex project boundary change.
 *
 * Ported from `src/nova_audio_agent/realtime/project_confirmation.py`. Changing which workspace or
 * Session the agent is operating in is not something a model may do on its own say-so, so the host
 * proposes, the *user* confirms out loud, and only then is there authority to commit. Everything
 * here exists to make that authority unforgeable: one proposal at a time, one reserved transcript
 * item that may answer it, one retry, and a commit token that can be claimed exactly once.
 *
 * The matching is deliberately narrow. A confirmation has to be one of a closed set of phrases,
 * optionally wrapped in a listed filler word -- not anything a classifier judges affirmative --
 * because the failure mode to avoid is acting on speech that merely sounded like agreement.
 * Normalization runs through the pinned Unicode pipeline for the same reason recall does: the two
 * runtimes must agree on what a user said.
 */

import type { Clock } from '../clock.js'
import {codePointLengthLikePython, isPythonSpace} from '../python-text.js'
import { isOtherCategory, isPunctuationCategory } from '../unicode-tables.js'
import { normalizeNfkcPinned } from '../unicode-normalize.js'

export type ProjectAction = 'create' | 'select' | 'resume'
export type ConfirmationClass = 'confirm' | 'cancel' | 'unknown'
export type ConfirmationKind = 'confirmed' | 'cancelled' | 'retry' | 'expired' | 'ignored'

/**
 * The closed set of confirmations, and of cancellations.
 *
 * Confirmations must match exactly (after filler removal); cancellations match as a *substring*,
 * because a user who says anything containing "取消" is cancelling and the cost of over-cancelling
 * is far lower than the cost of over-confirming.
 */
/**
 * Exported so a test can assert the property the check order relies on, rather than restating the
 * lists and testing its own copy. The safety of `classifyConfirmation` rests on these sets not
 * intersecting; a phrase added here that contains a refusal would make the order load-bearing.
 */
export const CONFIRMATION_POSITIVE: ReadonlySet<string> = new Set([
  '确认',
  '确认执行',
  '可以',
  '可以执行',
  '同意',
  '没问题',
  '就这么做',
  '按这个来',
  '开始吧',
  '执行吧',
  '做吧',
])

export const CONFIRMATION_NEGATIVE: readonly string[] = [
  '取消',
  '不确认',
  '不要',
  '不行',
  '先不要',
  '先别',
  '算了',
  '停止',
]

/**
 * Filler that may wrap a confirmation, longest first.
 *
 * Longest-first matters: "好的" has to be stripped as one token rather than leaving "的" behind,
 * which would then fail the exact match.
 */
export const CONFIRMATION_LEADING: readonly string[] = ['嗯嗯', '好的', '那就', '嗯', '好', '那']
export const CONFIRMATION_TRAILING: readonly string[] = ['啊', '呀', '哦', '啦']

/** Past this, an unrecognised utterance is a cancellation rather than a request to repeat. */
const MAX_RETRY_CHARS = 24
const EXPIRY_SECONDS = 90

export interface ProjectProposal {
  readonly action: ProjectAction
  readonly workspace_display_name: string
  readonly workspace_id: string | null
  readonly session_title: string | null
  readonly session_id: string | null
  readonly work_order: string | null
  readonly origin_ref: string
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
  /** The one transcript item allowed to answer the proposal, as `epoch:itemId`. */
  #reserved: string | null = null
  #retryCount = 0
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
    const nonce = this.#idFactory()
    if (typeof nonce !== 'string' || nonce === '' || codePointLengthLikePython(nonce) > 128) {
      throw new TypeError('invalid confirmation nonce')
    }
    const proposal: ProjectProposal = Object.freeze({
      ...input,
      nonce,
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
    this.#retryCount = 0
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

  /**
   * Judge the reserved item's transcript.
   *
   * `ignored` means this transcript is not the answer to anything, which is different from not
   * understanding it: an unreserved item must leave the proposal exactly as it was.
   */
  acceptTranscript(input: {
    readonly epoch: number
    readonly itemId: string
    readonly text: string
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
    const classification = classifyConfirmation(input.text)
    if (classification === 'confirm') {
      const operation = confirmedFrom(proposal)
      this.#proposal = null
      this.#reserved = null
      this.#retryCount = 0
      // Deliberately not `clearAll`: this is where commit authority is *granted*.
      this.#commitAuthority = operation
      this.#publish()
      return outcome('confirmed', {operation})
    }
    if (classification === 'cancel') {
      this.#clearAll()
      this.#publish()
      return outcome('cancelled', {responseText: '已取消。'})
    }
    // One retry, and only for something short. A long unrecognised utterance is the user talking
    // about something else, so treating it as a mishearing would keep a boundary change alive that
    // nobody is attending to.
    const normalized = normalizedUtterance(input.text)
    if (this.#retryCount === 0 && [...normalized].length <= MAX_RETRY_CHARS) {
      this.#retryCount = 1
      this.#reserved = null
      return outcome('retry', {
        responseText: '没有听清，请说“确认”“可以”，或者说“取消”。',
      })
    }
    this.#clearAll()
    this.#publish()
    return outcome('cancelled', {responseText: '未收到明确确认，已取消。'})
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
    this.#retryCount = 0
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
    nonce: proposal.nonce,
  })
}

/**
 * Classify one utterance as confirmation, cancellation, or neither.
 *
 * Cancellation is checked first, and as a substring, so anything containing a refusal cancels --
 * "可以取消吗" must never confirm. Confirmation is checked as an exact match against a closed set,
 * then again after stripping one leading and one trailing filler token. Everything else is
 * `unknown`, which the caller turns into a retry or a cancellation.
 *
 * With today's sets the order is not observable, because no confirmable phrase contains a refusal.
 * That is a property of the *sets*, not of this function, and it is the property the safety actually
 * rests on -- so a test asserts it directly over the exported lists rather than over a copy. Add a
 * phrase that breaks it and that test fails, which is the moment the order here becomes real.
 */
export function classifyConfirmation(text: unknown): ConfirmationClass {
  const normalized = normalizedUtterance(text)
  if (normalized === '') return 'unknown'
  if (CONFIRMATION_NEGATIVE.some(negative => normalized.includes(negative))) return 'cancel'
  if (CONFIRMATION_POSITIVE.has(normalized)) return 'confirm'
  let core = normalized
  for (const token of CONFIRMATION_LEADING) {
    if (core.startsWith(token)) {
      core = core.slice(token.length)
      break
    }
  }
  for (const token of CONFIRMATION_TRAILING) {
    if (core.endsWith(token)) {
      core = core.slice(0, core.length - token.length)
      break
    }
  }
  return CONFIRMATION_POSITIVE.has(core) ? 'confirm' : 'unknown'
}

/**
 * Reduce an utterance to the characters that carry meaning.
 *
 * Whitespace, punctuation, and control characters all go: a user saying "确认。" or "确 认" has
 * confirmed. Classification runs on the pinned Unicode tables rather than the host's, so the two
 * runtimes agree on what was said -- a code point assigned after the pin would otherwise be
 * punctuation to one and a letter to the other.
 */
function normalizedUtterance(text: unknown): string {
  if (typeof text !== 'string') return ''
  let result = ''
  for (const character of normalizeNfkcPinned(text)) {
    if (isPythonSpace(character)) continue
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) continue
    if (isPunctuationCategory(codePoint) || isOtherCategory(codePoint)) continue
    result += character
  }
  return result
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
