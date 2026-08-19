/**
 * Bounded ledgers and per-response bookkeeping for the realtime session.
 *
 * Ported from the state half of `src/nova_audio_agent/realtime/session.py`. This layer is
 * deliberately pure: no provider, no transport, no clock. It owns the questions the
 * session's event reducer keeps asking -- has this user turn already been counted, has
 * this response spoken, was this host event already answered -- and every answer is
 * bounded so a long session cannot grow without limit.
 *
 * Provider-allocated identities are keyed with the session epoch: a reconnect starts a new
 * epoch, and an item id from the old provider session must never satisfy a dedup check in the
 * new one. Host-allocated event ids are deliberately *not* epoch-scoped -- a host event that
 * was already answered stays answered across a reconnect, because the host owns that identity
 * and re-answering it would repeat the utterance to the user.
 */

import { z } from 'zod'
import { PROGRESS_SUMMARY_LIMIT } from '../events.js'

export const MAX_TRACKED_USER_TRANSCRIPTS = 4_096
export const MAX_CAPTION_CHARS = 160
export const MAX_TRACKED_HOST_EVENTS = 500
export const MAX_PENDING_HOST_EVENTS = 532
export const MAX_TRACKED_PROVIDER_TURNS = 500
export const MAX_PREMAP_AUDIO_BYTES = 64 * 1_024
export const MAX_CONTINUATION_TASK_SUMMARY = 240

export const delegateStateSchema = z.enum(['running', 'completed', 'failed', 'unknown'])
export type DelegateState = z.infer<typeof delegateStateSchema>

export const providerTurnPhaseSchema = z.enum([
  'active',
  'cancel_requested',
  'completed',
  'cancelled',
  'failed',
])
export type ProviderTurnPhase = z.infer<typeof providerTurnPhaseSchema>

export type ContinuationRequestResult = 'requested' | 'retryable' | 'rejected'

/** A speculative display-only caption: revisable, never persisted. */
export interface CaptionFrame {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly final: boolean
}

/** One delegate's session view: a task summary plus the latest progress slot. */
export interface DelegateRecord {
  readonly summary: string
  readonly state: DelegateState
  readonly channel: string
  readonly progress_summary: string | null
  readonly internal_activity: number
  readonly elapsed: number
}

export interface RealtimeSnapshot {
  readonly version: number
  readonly active_delegates: readonly (readonly [string, DelegateRecord])[]
  readonly spoken_event_ids: readonly string[]
  readonly interrupted_event_ids: readonly string[]
}

export interface ProviderTurn {
  phase: ProviderTurnPhase
  readonly user_input_revision: number
  locally_fenced: boolean
  defer_playback_fence: boolean
}

/**
 * An epoch-scoped, insertion-ordered set with a hard size bound.
 *
 * Eviction is oldest-first, which is what makes a long session safe: a provider that never
 * repeats an item id would otherwise grow this without limit. Keys embed the epoch so a
 * reconnect cannot inherit the previous session's answers.
 */
export class EpochLedger {
  readonly #keys: string[] = []
  readonly #seen = new Set<string>()
  readonly #limit: number

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`ledger limit must be a positive integer: ${limit}`)
    }
    this.#limit = limit
  }

  get size(): number {
    return this.#keys.length
  }

  has(epoch: number, id: string): boolean {
    return this.#seen.has(key(epoch, id))
  }

  /** Record the id; false means it was already present and nothing changed. */
  add(epoch: number, id: string): boolean {
    const entry = key(epoch, id)
    if (this.#seen.has(entry)) return false
    this.#seen.add(entry)
    this.#keys.push(entry)
    if (this.#keys.length > this.#limit) {
      const evicted = this.#keys.shift()
      if (evicted !== undefined) this.#seen.delete(evicted)
    }
    return true
  }

  /**
   * Rename an already-recorded id in place, keeping its position.
   *
   * The provider can reveal a turn's real item id after the turn was first observed under a
   * provisional one. Re-adding would move it to the end of the eviction order and could
   * evict an older turn that is still live, so the slot is rewritten instead.
   */
  replace(epoch: number, previousId: string, id: string): boolean {
    const previous = key(epoch, previousId)
    const entry = key(epoch, id)
    if (!this.#seen.has(previous) || this.#seen.has(entry)) return false
    const index = this.#keys.indexOf(previous)
    if (index === -1) return false
    this.#keys[index] = entry
    this.#seen.delete(previous)
    this.#seen.add(entry)
    return true
  }
}

function key(epoch: number, id: string): string {
  // The separator cannot occur in a decimal epoch, so the pair round-trips unambiguously.
  return `${epoch}:${id}`
}

/**
 * Tracks user turns, transcripts, captions, provider turns, and delegates for one session.
 *
 * Split out from the session so the bookkeeping can be tested without a provider, and so
 * the session's own reducer reads as decisions rather than as bookkeeping.
 */
export class RealtimeSessionState {
  readonly #transcripts = new EpochLedger(MAX_TRACKED_USER_TRANSCRIPTS)
  readonly #turns = new EpochLedger(MAX_TRACKED_USER_TRANSCRIPTS)
  // A Map is insertion-ordered, and `delete` + `set` moves a key to the end, so these two
  // reproduce OrderedDict with `move_to_end` on every touch. That LRU-by-touch order is
  // load-bearing: eviction is oldest-touched-first, not oldest-inserted-first.
  readonly #providerTurns = new Map<string, ProviderTurn>()
  readonly #delegates = new Map<string, DelegateRecord>()
  readonly #spokenEventIds: string[] = []
  readonly #interruptedEventIds: string[] = []
  readonly #respondedEventIds = new Map<string, null>()
  #epoch = 0
  #userInputRevision = 0
  #snapshotVersion = 0
  #userCaptionItem: string | null = null
  #userCaptionText = ''
  #assistantCaptionResponse: string | null = null
  #assistantCaptionText = ''

  get sessionEpoch(): number {
    return this.#epoch
  }

  get userInputRevision(): number {
    return this.#userInputRevision
  }

  get snapshotVersion(): number {
    return this.#snapshotVersion
  }

  /**
   * Begin a new provider session.
   *
   * Epoch-scoped answers start over because their keys embed the epoch, not because anything is
   * cleared here. Captions are deliberately left alone: clearing them belongs to the layer above,
   * which does it around a reconnect, and doing it here too would hide a missing reset there.
   */
  beginEpoch(epoch: number): void {
    if (!Number.isInteger(epoch) || epoch <= this.#epoch) {
      throw new RangeError(`session epoch must increase: ${this.#epoch} -> ${epoch}`)
    }
    this.#epoch = epoch
    this.advanceSnapshot()
  }

  /** Count a user transcript terminal once; false means it was a duplicate. */
  acceptUserTranscriptTerminal(itemId: string): boolean {
    return this.#transcripts.add(this.#epoch, itemId)
  }

  /**
   * Count a user turn once, advancing the input revision.
   *
   * The revision is what later lets a response be recognised as answering a world that no
   * longer exists, so it must advance exactly once per genuinely new turn.
   */
  acceptUserTurn(itemId: string): boolean {
    if (!this.#turns.add(this.#epoch, itemId)) return false
    this.#userInputRevision += 1
    return true
  }

  /** Rename a counted turn without advancing the revision or reordering eviction. */
  replaceUserTurnIdentity(previousItemId: string, itemId: string): boolean {
    return this.#turns.replace(this.#epoch, previousItemId, itemId)
  }

  hasUserTurn(itemId: string): boolean {
    return this.#turns.has(this.#epoch, itemId)
  }

  /**
   * Record that a host event has been answered, so it is never answered twice.
   *
   * Re-recording an already-answered event moves it to the end of the eviction order without
   * changing the answer, which is how a repeated response request keeps a still-relevant event
   * from ageing out. `false` reports that it was already present.
   *
   * The bound is not enforced here: pruning is a separate step the session drives once per
   * response request, so a burst of records cannot evict an event the same burst still needs.
   */
  markEventResponded(eventId: string): boolean {
    const known = this.#respondedEventIds.delete(eventId)
    this.#respondedEventIds.set(eventId, null)
    return !known
  }

  hostEventIsDeduplicated(eventId: string): boolean {
    return this.#respondedEventIds.has(eventId)
  }

  /** Every answered host event id, oldest-touched first. */
  get respondedEventIds(): readonly string[] {
    return [...this.#respondedEventIds.keys()]
  }

  /**
   * Withdraw an event's answer so it can be answered again.
   *
   * A suggestion whose response was interrupted never reached the user, so its authority goes
   * back and the event becomes eligible again.
   */
  releaseRespondedEvent(eventId: string): boolean {
    return this.#respondedEventIds.delete(eventId)
  }

  /** Drop oldest-touched answered events down to the bound. */
  pruneRespondedEvents(): void {
    while (this.#respondedEventIds.size > MAX_TRACKED_HOST_EVENTS) {
      const oldest = this.#respondedEventIds.keys().next()
      if (oldest.done === true) break
      this.#respondedEventIds.delete(oldest.value)
    }
  }

  /**
   * Open a provider turn, evicting the oldest-touched when the bound is reached.
   *
   * A response id that is already recorded returns its existing turn **unchanged**. Its phase,
   * fence flag, and input revision are decisions already taken; rebuilding the entry would
   * revive a `cancel_requested` or terminal turn as `active` and would re-date a stale turn
   * against the current input revision. Only the eviction position moves.
   */
  openProviderTurn(responseId: string): ProviderTurn {
    const composite = key(this.#epoch, responseId)
    const known = this.#providerTurns.get(composite)
    const entry: ProviderTurn = known ?? {
      phase: 'active',
      user_input_revision: this.#userInputRevision,
      locally_fenced: false,
      defer_playback_fence: false,
    }
    // Touch the key so eviction order is by last use, matching `OrderedDict.move_to_end`.
    this.#providerTurns.delete(composite)
    this.#providerTurns.set(composite, entry)
    while (this.#providerTurns.size > MAX_TRACKED_PROVIDER_TURNS) {
      const oldest = this.#providerTurns.keys().next()
      if (oldest.done === true) break
      this.#providerTurns.delete(oldest.value)
    }
    return entry
  }

  providerTurn(responseId: string | null): ProviderTurn | undefined {
    return responseId === null ? undefined : this.#providerTurns.get(key(this.#epoch, responseId))
  }

  providerTurnPhase(responseId: string | null): ProviderTurnPhase | undefined {
    return this.providerTurn(responseId)?.phase
  }

  providerTurnUserInputRevision(responseId: string | null): number | undefined {
    return this.providerTurn(responseId)?.user_input_revision
  }

  providerTurnWasFenced(responseId: string | null): boolean {
    return this.providerTurn(responseId)?.locally_fenced ?? false
  }

  /** Whether the world this response answers has been superseded by newer user input. */
  providerTurnIsStale(responseId: string | null): boolean {
    const revision = this.providerTurnUserInputRevision(responseId)
    return revision !== undefined && revision < this.#userInputRevision
  }

  /**
   * Append a spoken event id once.
   *
   * This deliberately does not advance the snapshot version. Callers append a whole response's
   * event ids in a loop and then publish once, so the version counts published changes rather
   * than individual appends.
   */
  markEventSpoken(eventId: string): void {
    if (!this.#spokenEventIds.includes(eventId)) this.#spokenEventIds.push(eventId)
  }

  /** Append an interrupted event id once. Does not advance the snapshot; see markEventSpoken. */
  markEventInterrupted(eventId: string): void {
    if (!this.#interruptedEventIds.includes(eventId)) this.#interruptedEventIds.push(eventId)
  }

  eventWasSpoken(eventId: string): boolean {
    return this.#spokenEventIds.includes(eventId)
  }

  /** Replace a caption for one role, bounded to what a display can show. */
  setCaption(frame: CaptionFrame): CaptionFrame {
    const text = truncateCaption(frame.text)
    if (frame.role === 'user') this.#userCaptionText = text
    else this.#assistantCaptionText = text
    return {role: frame.role, text, final: frame.final}
  }

  trackUserCaption(itemId: string): boolean {
    if (this.#userCaptionItem === itemId) return false
    this.#userCaptionItem = itemId
    this.#userCaptionText = ''
    return true
  }

  trackAssistantCaption(responseId: string): boolean {
    if (this.#assistantCaptionResponse === responseId) return false
    this.#assistantCaptionResponse = responseId
    this.#assistantCaptionText = ''
    return true
  }

  get userCaption(): string {
    return this.#userCaptionText
  }

  get assistantCaption(): string {
    return this.#assistantCaptionText
  }

  clearCaptions(): void {
    this.#userCaptionItem = null
    this.#userCaptionText = ''
    this.#assistantCaptionResponse = null
    this.#assistantCaptionText = ''
  }

  /**
   * Record or update one delegate.
   *
   * An omitted progress field preserves the previous slot rather than clearing it, which is
   * what lets a handoff update state without erasing the progress a caller never mentioned.
   * An explicitly null progress summary does clear it.
   */
  registerDelegate(
    delegateId: string,
    update: {
      readonly summary: string
      readonly state: DelegateState
      readonly channel?: string
      readonly progress_summary?: string | null
      readonly internal_activity?: number
      readonly elapsed?: number
    },
  ): void {
    if (delegateId.length === 0 || update.summary.length === 0) {
      throw new TypeError('delegate_id and summary are required')
    }
    const previous = this.#delegates.get(delegateId)
    const progress = 'progress_summary' in update
      ? boundedProgress(update.progress_summary ?? null)
      : previous?.progress_summary ?? null
    this.#delegates.set(delegateId, {
      summary: update.summary,
      state: delegateStateSchema.parse(update.state),
      channel: update.channel ?? 'codex',
      progress_summary: progress,
      internal_activity: update.internal_activity ?? previous?.internal_activity ?? 0,
      elapsed: update.elapsed ?? previous?.elapsed ?? 0,
    })
    this.advanceSnapshot()
  }

  delegateState(delegateId: string): DelegateState | undefined {
    return this.#delegates.get(delegateId)?.state
  }

  /** Only running delegates are visible; the rest are history. */
  snapshot(): RealtimeSnapshot {
    return {
      version: this.#snapshotVersion,
      active_delegates: [...this.#delegates]
        .filter(([, record]) => record.state === 'running')
        .map(([delegateId, record]) => [delegateId, {...record}] as const),
      spoken_event_ids: [...this.#spokenEventIds],
      interrupted_event_ids: [...this.#interruptedEventIds],
    }
  }

  /** Publish the accumulated changes as one new snapshot version. */
  advanceSnapshot(): void {
    this.#snapshotVersion += 1
  }
}

function boundedProgress(value: string | null): string | null {
  if (value === null) return null
  return [...value].slice(0, PROGRESS_SUMMARY_LIMIT).join('')
}

/**
 * Keep the last MAX_CAPTION_CHARS code points.
 *
 * A caption accumulates from deltas and the interesting end is the newest one: the display should
 * follow what is being said now, not the opening of a long utterance. This is deliberately the
 * opposite end from the progress-summary bound, which keeps its head. Slicing by code point is
 * what keeps either bound from splitting an astral character.
 */
export function truncateCaption(text: string): string {
  const characters = [...text]
  return characters.length <= MAX_CAPTION_CHARS
    ? text
    : characters.slice(-MAX_CAPTION_CHARS).join('')
}
