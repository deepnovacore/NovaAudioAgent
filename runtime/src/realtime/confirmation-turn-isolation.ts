/**
 * Correlates the unordered events belonging to one confirmation turn.
 *
 * This class deliberately makes no confirmation decision. Callers provide authority and choose
 * their own policy; the isolation state only prevents an event from one epoch or user revision
 * being associated with another.
 */

export interface ConfirmationAuthority {
  readonly authorityId: string
  readonly sessionEpoch: number
  readonly createdUserRevision: number
  readonly expiresAt: number
}

export interface ReservedConfirmationItem {
  readonly sessionEpoch: number
  readonly itemId: string
  readonly userRevision: number
  readonly responseId: string | null
}

export interface ConfirmationTurnBlockingView {
  readonly responseId: string | null
  readonly closing: boolean
  readonly quarantined: boolean
  readonly transcript: 'pending' | 'completed' | 'failed' | null
}

export interface ConfirmationResponseView {
  readonly sessionEpoch: number
  readonly responseId: string
  readonly userRevision: number | null
  readonly authorizationCarrier: boolean
  readonly blocked: boolean
  readonly closing: boolean
  readonly quarantined: boolean
  readonly transcript: 'pending' | 'completed' | 'failed' | null
}

export type ReserveUserItemResult = 'reserved' | 'idempotent' | 'refused' | 'stale'
export type BindResponseResult = 'bound' | 'idempotent' | 'stale'
export type DeferCallResult = 'deferred' | 'overflow' | 'stale'
export type TrackResponseResult = 'tracked' | 'idempotent' | 'overflow' | 'stale'
export type BindProvisionalResponseResult =
  | {readonly kind: 'bound'; readonly responseId: string; readonly terminal: boolean}
  | {readonly kind: 'none' | 'ambiguous'}

interface ResponseState {
  readonly sessionEpoch: number
  readonly responseId: string
  readonly itemId: string | null
  readonly userRevision: number | null
  readonly authorizationCarrier: boolean
  readonly provisional: boolean
  terminal: boolean
  blocked: boolean
  closing: boolean
  quarantined: boolean
  transcript: 'pending' | 'completed' | 'failed' | null
}

interface PendingTranscript {
  readonly sessionEpoch: number
  readonly userRevision: number
  readonly responseId: string
  readonly transcript: 'completed' | 'failed'
}

/** Owns bounded, instance-local correlation state for one potential confirmation turn. */
export class ConfirmationTurnIsolation<TCall> {
  readonly #limit: number
  #authority: ConfirmationAuthority | null = null
  #reservation: ReservedConfirmationItem | null = null
  readonly #responses = new Map<string, ResponseState>()
  #initialResponseId: string | null = null
  #retryResponseId: string | null = null
  #pendingTranscript: PendingTranscript | null = null
  #deferredCalls = new Map<string, TCall[]>()
  #deferredCount = 0
  #responseFencePending = false

  constructor(limit: number) {
    if (!isPositiveInteger(limit)) throw new TypeError('deferred call limit must be a positive integer')
    this.#limit = limit
  }

  get authority(): ConfirmationAuthority | null {
    return this.#authority
  }

  get reservation(): ReservedConfirmationItem | null {
    return this.#reservation
  }

  get blocking(): ConfirmationTurnBlockingView {
    const response = this.#primaryResponse()
    return Object.freeze({
      responseId: response?.responseId ?? null,
      closing: response?.closing ?? false,
      quarantined: response?.quarantined ?? false,
      transcript: response?.transcript ?? null,
    })
  }

  get blockedResponses(): readonly ConfirmationResponseView[] {
    return [...this.#responses.values()]
      .filter(response => response.blocked)
      .map(responseView)
  }

  get responseFencePending(): boolean {
    return this.#responseFencePending
  }

  /** The bounded number of opaque calls that are still awaiting an exact response binding. */
  get deferredCallCount(): number {
    return this.#deferredCount
  }

  /** Replace all local state with immutable authority for a new turn. */
  beginAuthority(input: ConfirmationAuthority): ConfirmationAuthority {
    validateAuthority(input)
    const authority = Object.freeze({
      authorityId: input.authorityId,
      sessionEpoch: input.sessionEpoch,
      createdUserRevision: input.createdUserRevision,
      expiresAt: input.expiresAt,
    })
    this.#clear()
    this.#authority = authority
    return authority
  }

  /** Reserve exactly one later user item; a newer rival revision stales the old reservation. */
  reserveUserItem(input: {
    readonly sessionEpoch: number
    readonly itemId: string
    readonly userRevision: number
  }): ReserveUserItemResult {
    if (!isItemIdentity(input) || !this.#isPostAuthority(input.sessionEpoch, input.userRevision)) {
      return 'refused'
    }
    const reserved = this.#reservation
    if (reserved === null) {
      this.#reservation = freezeReservation(input)
      return 'reserved'
    }
    if (
      reserved.sessionEpoch === input.sessionEpoch
      && reserved.itemId === input.itemId
      && reserved.userRevision === input.userRevision
    ) return 'idempotent'
    if (input.userRevision <= reserved.userRevision) return 'refused'

    this.#clearReservation()
    return 'stale'
  }

  /** Bind an exact response to the reserved user item. The first binding is immutable. */
  bindResponse(input: {
    readonly sessionEpoch: number
    readonly itemId: string
    readonly userRevision: number
    readonly responseId: string
  }): BindResponseResult {
    if (!isResponseBindingIdentity(input) || !this.#matchesReservation(input)) return 'stale'
    const reservation = this.#reservation
    if (reservation === null) return 'stale'
    if (this.#initialResponseId !== null) {
      return this.#initialResponseId === input.responseId ? 'idempotent' : 'stale'
    }
    if (!this.#ensureResponseCapacity(input.sessionEpoch, input.responseId)) return 'stale'
    const key = deferredKey(input.sessionEpoch, input.userRevision, input.responseId)
    const calls = this.#deferredCalls.get(key)
    this.#deferredCalls.clear()
    this.#deferredCount = 0
    if (calls !== undefined) {
      this.#deferredCalls.set(key, calls)
      this.#deferredCount = calls.length
    }
    const pendingTranscript = this.#pendingTranscript
    this.#pendingTranscript = null
    const existing = this.#responses.get(responseKey(input.sessionEpoch, input.responseId))
    this.#responses.set(responseKey(input.sessionEpoch, input.responseId), {
      sessionEpoch: input.sessionEpoch,
      itemId: input.itemId,
      userRevision: input.userRevision,
      responseId: input.responseId,
      authorizationCarrier: true,
      provisional: false,
      terminal: existing?.terminal ?? false,
      blocked: existing?.blocked ?? false,
      closing: existing?.closing ?? false,
      quarantined: existing?.quarantined ?? false,
      transcript: pendingTranscript !== null && matchesPendingTranscript(pendingTranscript, input)
        ? pendingTranscript.transcript
        : 'pending',
    })
    this.#initialResponseId = input.responseId
    this.#reservation = Object.freeze({
      sessionEpoch: reservation.sessionEpoch,
      itemId: reservation.itemId,
      userRevision: reservation.userRevision,
      responseId: input.responseId,
    })
    return 'bound'
  }

  /** Bind another exact response to the same reservation; the caller owns retry policy. */
  bindRetryResponse(input: {
    readonly sessionEpoch: number
    readonly itemId: string
    readonly userRevision: number
    readonly responseId: string
  }): BindResponseResult {
    if (!isResponseBindingIdentity(input) || !this.#matchesReservation(input)) return 'stale'
    if (this.#initialResponseId === null || input.responseId === this.#initialResponseId) return 'stale'
    if (this.#retryResponseId !== null) {
      return this.#retryResponseId === input.responseId ? 'idempotent' : 'stale'
    }
    if (!this.#ensureResponseCapacity(input.sessionEpoch, input.responseId)) return 'stale'
    const key = responseKey(input.sessionEpoch, input.responseId)
    const existing = this.#responses.get(key)
    this.#responses.set(key, {
      sessionEpoch: input.sessionEpoch,
      itemId: input.itemId,
      userRevision: input.userRevision,
      responseId: input.responseId,
      authorizationCarrier: true,
      provisional: false,
      terminal: existing?.terminal ?? false,
      blocked: existing?.blocked ?? false,
      closing: existing?.closing ?? false,
      quarantined: existing?.quarantined ?? false,
      transcript: 'pending',
    })
    this.#retryResponseId = input.responseId
    return 'bound'
  }

  /** Taint one exact response for service-level blocking without granting it authority. */
  markBlockedResponse(input: {
    readonly sessionEpoch: number
    readonly responseId: string
  }): TrackResponseResult {
    if (!isResponseIdentity(input) || this.#authority?.sessionEpoch !== input.sessionEpoch) {
      return 'stale'
    }
    const key = responseKey(input.sessionEpoch, input.responseId)
    const existing = this.#responses.get(key)
    if (existing !== undefined) {
      if (existing.blocked) return 'idempotent'
      existing.blocked = true
      return 'tracked'
    }
    if (this.#responses.size >= this.#limit) return 'overflow'
    this.#responses.set(key, {
      sessionEpoch: input.sessionEpoch,
      responseId: input.responseId,
      itemId: null,
      userRevision: null,
      authorizationCarrier: false,
      provisional: false,
      terminal: false,
      blocked: true,
      closing: false,
      quarantined: false,
      transcript: null,
    })
    return 'tracked'
  }

  isBlockedResponse(input: {readonly sessionEpoch: number; readonly responseId: string}): boolean {
    return isResponseIdentity(input)
      && this.#responses.get(responseKey(input.sessionEpoch, input.responseId))?.blocked === true
  }

  /** Track one silent response that may belong to the next final-only user item. */
  trackProvisionalResponse(input: {
    readonly sessionEpoch: number
    readonly userRevision: number
    readonly responseId: string
  }): TrackResponseResult {
    if (
      !isDeferredCallIdentity(input)
      || this.#reservation !== null
      || !this.#isPostAuthority(input.sessionEpoch, input.userRevision)
    ) return 'stale'
    const key = responseKey(input.sessionEpoch, input.responseId)
    const existing = this.#responses.get(key)
    if (existing !== undefined) {
      return existing.provisional && existing.userRevision === input.userRevision
        ? 'idempotent'
        : 'stale'
    }
    if (this.#responses.size >= this.#limit) return 'overflow'
    this.#responses.set(key, {
      sessionEpoch: input.sessionEpoch,
      responseId: input.responseId,
      itemId: null,
      userRevision: input.userRevision,
      authorizationCarrier: false,
      provisional: true,
      terminal: false,
      blocked: true,
      closing: false,
      quarantined: false,
      transcript: null,
    })
    return 'tracked'
  }

  /** Hold a structured call only for an already tracked final-only response. */
  deferProvisionalCall(input: {
    readonly sessionEpoch: number
    readonly responseId: string
    readonly call: TCall
  }): DeferCallResult {
    if (!isResponseIdentity(input)) return 'stale'
    const response = this.#responses.get(responseKey(input.sessionEpoch, input.responseId))
    if (!response?.provisional || response.userRevision === null) return 'stale'
    return this.deferCall({
      sessionEpoch: input.sessionEpoch,
      userRevision: response.userRevision,
      responseId: input.responseId,
      call: input.call,
    })
  }

  /** Retain a terminal provisional response until its unordered user item arrives. */
  markProvisionalTerminal(input: {
    readonly sessionEpoch: number
    readonly responseId: string
  }): boolean {
    if (!isResponseIdentity(input)) return false
    const response = this.#responses.get(responseKey(input.sessionEpoch, input.responseId))
    if (response?.provisional !== true) return false
    response.terminal = true
    return true
  }

  /** Bind the only exact provisional response to the now-revealed reserved item. */
  bindProvisionalResponse(): BindProvisionalResponseResult {
    const reservation = this.#reservation
    if (reservation === null || this.#initialResponseId !== null) return {kind: 'none'}
    const candidates = [...this.#responses.values()].filter(response => (
      response.provisional
      && response.sessionEpoch === reservation.sessionEpoch
      && response.userRevision === reservation.userRevision
    ))
    const withCalls = candidates.filter(response => this.#deferredCalls.has(deferredKey(
      response.sessionEpoch,
      reservation.userRevision,
      response.responseId,
    )))
    const eligible = withCalls.length > 0 ? withCalls : candidates
    if (eligible.length === 0) return {kind: 'none'}
    if (eligible.length !== 1) return {kind: 'ambiguous'}
    const response = eligible[0]!
    const result = this.bindResponse({
      sessionEpoch: reservation.sessionEpoch,
      itemId: reservation.itemId,
      userRevision: reservation.userRevision,
      responseId: response.responseId,
    })
    return result === 'bound' || result === 'idempotent'
      ? {kind: 'bound', responseId: response.responseId, terminal: response.terminal}
      : {kind: 'none'}
  }

  hasBlockedResponseInEpoch(sessionEpoch: number): boolean {
    if (!isEpoch(sessionEpoch)) return false
    return [...this.#responses.values()]
      .some(response => response.sessionEpoch === sessionEpoch && response.blocked)
  }

  isAuthorizationCarrier(input: {
    readonly sessionEpoch: number
    readonly userRevision: number
    readonly responseId: string
  }): boolean {
    if (!isDeferredCallIdentity(input)) return false
    const reservation = this.#reservation
    return reservation !== null
      && reservation.sessionEpoch === input.sessionEpoch
      && reservation.userRevision === input.userRevision
      && (input.responseId === this.#initialResponseId || input.responseId === this.#retryResponseId)
  }

  responseState(input: {
    readonly sessionEpoch: number
    readonly responseId: string
  }): ConfirmationResponseView | null {
    if (!isResponseIdentity(input)) return null
    const response = this.#responses.get(responseKey(input.sessionEpoch, input.responseId))
    return response === undefined ? null : responseView(response)
  }

  /** Track whether an exact not-yet-started response is still fenced. */
  setResponseFencePending(pending: boolean): boolean {
    if (typeof pending !== 'boolean' || (pending && this.#authority === null)) return false
    this.#responseFencePending = pending
    return true
  }

  /** Hold an opaque structured call until its current response is bound, subject to one fixed bound. */
  deferCall(input: {
    readonly sessionEpoch: number
    readonly userRevision: number
    readonly responseId: string
    readonly call: TCall
  }): DeferCallResult {
    if (!isDeferredCallIdentity(input) || !this.#matchesDeferredTurn(input)) return 'stale'
    if (this.#deferredCount >= this.#limit) return 'overflow'
    const key = deferredKey(input.sessionEpoch, input.userRevision, input.responseId)
    const calls = this.#deferredCalls.get(key)
    if (calls === undefined) this.#deferredCalls.set(key, [input.call])
    else calls.push(input.call)
    this.#deferredCount += 1
    return 'deferred'
  }

  /** Release the calls for one already-bound response exactly once. */
  releaseCallsForResponse(input: {
    readonly sessionEpoch: number
    readonly userRevision: number
    readonly responseId: string
  }): TCall[] {
    if (!isDeferredCallIdentity(input) || !this.#matchesResponse(input)) return []
    const key = deferredKey(input.sessionEpoch, input.userRevision, input.responseId)
    const calls = this.#deferredCalls.get(key)
    if (calls === undefined) return []
    this.#deferredCalls.delete(key)
    this.#deferredCount -= calls.length
    return [...calls]
  }

  /** Atomically abandon deferred calls outside an optional exact turn or response identity. */
  takeAbandonedCalls(keep?: {
    readonly sessionEpoch: number
    readonly userRevision: number
    readonly responseId?: string
  }): TCall[] {
    if (
      keep !== undefined
      && (
        !isEpoch(keep.sessionEpoch)
        || !isRevision(keep.userRevision)
        || (keep.responseId !== undefined && !isNonemptyString(keep.responseId))
      )
    ) return []
    const retainedPrefix = keep === undefined
      ? null
      : `${keep.sessionEpoch}:${keep.userRevision}:`
    const retainedKey = keep?.responseId === undefined
      ? null
      : deferredKey(keep.sessionEpoch, keep.userRevision, keep.responseId)
    const abandoned: TCall[] = []
    for (const [key, calls] of this.#deferredCalls) {
      const retained = retainedKey === null
        ? retainedPrefix !== null && key.startsWith(retainedPrefix)
        : key === retainedKey
      if (retained) continue
      abandoned.push(...calls)
      this.#deferredCalls.delete(key)
      this.#deferredCount -= calls.length
    }
    return abandoned
  }

  /** Record text-free transcript correlation metadata for the exact current response. */
  markResponse(input: {
    readonly sessionEpoch: number
    readonly userRevision: number
    readonly responseId: string
    readonly transcript: 'completed' | 'failed'
  }): boolean {
    if (!isDeferredCallIdentity(input) || !isTranscript(input.transcript)) return false
    const response = this.#responseForCarrier(input)
    if (response !== null) {
      response.transcript = input.transcript
      return true
    }
    if (!this.#matchesDeferredTurn(input)) return false
    const pending = this.#pendingTranscript
    if (pending !== null && !matchesPendingTranscript(pending, input)) return false
    this.#pendingTranscript = Object.freeze({
      sessionEpoch: input.sessionEpoch,
      userRevision: input.userRevision,
      responseId: input.responseId,
      transcript: input.transcript,
    })
    return true
  }

  /** Mark service-level closing state for the exact current response. */
  beginClosing(input: {
    readonly sessionEpoch: number
    readonly userRevision?: number
    readonly responseId: string
  }): boolean {
    const response = this.#responseForIdentity(input)
    if (response === null) return false
    response.closing = true
    return true
  }

  /** Clear service-level closing state for the exact current response. */
  endClosing(input: {
    readonly sessionEpoch: number
    readonly userRevision?: number
    readonly responseId: string
  }): boolean {
    const response = this.#responseForIdentity(input)
    if (response?.closing !== true) return false
    response.closing = false
    return true
  }

  /** Mark an exact current response as quarantined without invoking provider policy. */
  markQuarantined(input: {
    readonly sessionEpoch: number
    readonly userRevision?: number
    readonly responseId: string
  }): boolean {
    const response = this.#responseForIdentity(input)
    if (response === null) return false
    response.quarantined = true
    return true
  }

  clearQuarantined(input: {
    readonly sessionEpoch: number
    readonly userRevision?: number
    readonly responseId: string
  }): boolean {
    const response = this.#responseForIdentity(input)
    if (response?.quarantined !== true) return false
    response.quarantined = false
    return true
  }

  /** Release only item authority while retaining response cleanup records until terminal. */
  releaseReservation(input: {
    readonly sessionEpoch: number
    readonly itemId: string
    readonly userRevision: number
  }): boolean {
    if (!isItemIdentity(input) || !this.#matchesReservation(input)) return false
    this.#reservation = null
    this.#initialResponseId = null
    this.#retryResponseId = null
    this.#pendingTranscript = null
    this.#deferredCalls.clear()
    this.#deferredCount = 0
    this.#responseFencePending = false
    return true
  }

  /** Clear one terminal response without releasing the authority or reserved item. */
  clearResponse(input: {readonly sessionEpoch: number; readonly responseId: string}): boolean {
    if (!isResponseIdentity(input)) return false
    const key = responseKey(input.sessionEpoch, input.responseId)
    const changed = this.#responses.delete(key)
    const pending = this.#pendingTranscript
    if (pending?.sessionEpoch === input.sessionEpoch && pending.responseId === input.responseId) {
      this.#pendingTranscript = null
      return true
    }
    return changed
  }

  /** Release the exact reservation and every local event correlated to it. */
  releaseReserved(input: {
    readonly sessionEpoch: number
    readonly itemId: string
    readonly userRevision: number
  }): boolean {
    if (!isItemIdentity(input) || !this.#matchesReservation(input)) return false
    this.#clearReservation()
    return true
  }

  /** Invalidate all correlations when the containing session is replaced. */
  invalidate(): boolean {
    const changed = this.#authority !== null || this.#reservation !== null || this.#responses.size !== 0
      || this.#deferredCount !== 0 || this.#responseFencePending
    this.#clear()
    return changed
  }

  #isPostAuthority(sessionEpoch: number, userRevision: number): boolean {
    const authority = this.#authority
    return authority !== null
      && authority.sessionEpoch === sessionEpoch
      && userRevision > authority.createdUserRevision
  }

  #matchesReservation(input: {readonly sessionEpoch: number; readonly itemId: string; readonly userRevision: number}): boolean {
    const reservation = this.#reservation
    return reservation !== null
      && reservation.sessionEpoch === input.sessionEpoch
      && reservation.itemId === input.itemId
      && reservation.userRevision === input.userRevision
  }

  #matchesDeferredTurn(input: {readonly sessionEpoch: number; readonly userRevision: number; readonly responseId: string}): boolean {
    const reservation = this.#reservation
    if (reservation === null) return this.#isPostAuthority(input.sessionEpoch, input.userRevision)
    return reservation.responseId === null
      && reservation.sessionEpoch === input.sessionEpoch
      && reservation.userRevision === input.userRevision
  }

  #matchesResponse(input: {readonly sessionEpoch: number; readonly userRevision: number; readonly responseId: string; readonly itemId?: string}): boolean {
    const response = this.#responseForCarrier(input)
    return response !== null
      && response.sessionEpoch === input.sessionEpoch
      && response.userRevision === input.userRevision
      && response.responseId === input.responseId
      && (input.itemId === undefined || response.itemId === input.itemId)
  }

  #clearReservation(): void {
    this.#reservation = null
    this.#responses.clear()
    this.#initialResponseId = null
    this.#retryResponseId = null
    this.#pendingTranscript = null
    this.#deferredCalls.clear()
    this.#deferredCount = 0
    this.#responseFencePending = false
  }

  #clear(): void {
    this.#authority = null
    this.#clearReservation()
  }

  #primaryResponse(): ResponseState | null {
    const epoch = this.#reservation?.sessionEpoch
    if (epoch === undefined) return null
    if (this.#initialResponseId !== null) {
      const initial = this.#responses.get(responseKey(epoch, this.#initialResponseId))
      if (initial !== undefined) return initial
    }
    if (this.#retryResponseId !== null) {
      return this.#responses.get(responseKey(epoch, this.#retryResponseId)) ?? null
    }
    return null
  }

  #responseForCarrier(input: {
    readonly sessionEpoch: number
    readonly userRevision: number
    readonly responseId: string
  }): ResponseState | null {
    if (!isDeferredCallIdentity(input)) return null
    const response = this.#responses.get(responseKey(input.sessionEpoch, input.responseId))
    return response?.authorizationCarrier === true && response.userRevision === input.userRevision
      ? response
      : null
  }

  #responseForIdentity(input: {
    readonly sessionEpoch: number
    readonly userRevision?: number
    readonly responseId: string
  }): ResponseState | null {
    if (!isResponseIdentity(input)) return null
    const response = this.#responses.get(responseKey(input.sessionEpoch, input.responseId))
    if (response === undefined) return null
    return input.userRevision === undefined || response.userRevision === input.userRevision
      ? response
      : null
  }

  #ensureResponseCapacity(sessionEpoch: number, responseId: string): boolean {
    return this.#responses.has(responseKey(sessionEpoch, responseId)) || this.#responses.size < this.#limit
  }
}

function freezeReservation(input: {readonly sessionEpoch: number; readonly itemId: string; readonly userRevision: number}): ReservedConfirmationItem {
  return Object.freeze({
    sessionEpoch: input.sessionEpoch,
    itemId: input.itemId,
    userRevision: input.userRevision,
    responseId: null,
  })
}

function deferredKey(sessionEpoch: number, userRevision: number, responseId: string): string {
  return `${sessionEpoch}:${userRevision}:${responseId}`
}

function responseKey(sessionEpoch: number, responseId: string): string {
  return `${sessionEpoch}:${responseId}`
}

function responseView(response: ResponseState): ConfirmationResponseView {
  return Object.freeze({
    sessionEpoch: response.sessionEpoch,
    responseId: response.responseId,
    userRevision: response.userRevision,
    authorizationCarrier: response.authorizationCarrier,
    blocked: response.blocked,
    closing: response.closing,
    quarantined: response.quarantined,
    transcript: response.transcript,
  })
}

function matchesPendingTranscript(
  pending: PendingTranscript,
  input: {readonly sessionEpoch: number; readonly userRevision: number; readonly responseId: string},
): boolean {
  return pending.sessionEpoch === input.sessionEpoch
    && pending.userRevision === input.userRevision
    && pending.responseId === input.responseId
}

function validateAuthority(input: ConfirmationAuthority): void {
  if (
    input === null
    || typeof input !== 'object'
    || !isNonemptyString(input.authorityId)
    || !isEpoch(input.sessionEpoch)
    || !isRevision(input.createdUserRevision)
    || !Number.isFinite(input.expiresAt)
  ) throw new TypeError('invalid confirmation authority')
}

function isItemIdentity(input: {readonly sessionEpoch: unknown; readonly itemId: unknown; readonly userRevision: unknown}): boolean {
  return isEpoch(input.sessionEpoch) && isNonemptyString(input.itemId) && isRevision(input.userRevision)
}

function isResponseBindingIdentity(input: {readonly sessionEpoch: unknown; readonly itemId: unknown; readonly userRevision: unknown; readonly responseId: unknown}): boolean {
  return isItemIdentity(input) && isNonemptyString(input.responseId)
}

function isDeferredCallIdentity(input: {readonly sessionEpoch: unknown; readonly userRevision: unknown; readonly responseId: unknown}): boolean {
  return isEpoch(input.sessionEpoch) && isRevision(input.userRevision) && isNonemptyString(input.responseId)
}

function isResponseIdentity(input: {readonly sessionEpoch: unknown; readonly responseId: unknown}): boolean {
  return isEpoch(input.sessionEpoch) && isNonemptyString(input.responseId)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isTranscript(value: unknown): value is 'completed' | 'failed' {
  return value === 'completed' || value === 'failed'
}
