import {callKey} from './service-state.js'

export type UserOriginResponseBinding =
  | {
      readonly status: 'bound'
      readonly item_id: string
      readonly revision: number
    }
  | {
      readonly status: 'epoch_mismatch' | 'missing_item' | 'item_already_claimed'
      readonly revision: number
    }

interface UserOriginItem {
  readonly epoch: number
  readonly revision: number
  readonly item_id: string
  origin_ref: string | null
  transcript_failed: boolean
  claimed: boolean
}

/**
 * Bounded causal join between one provider user item, its response and its Memory origin.
 *
 * Provider ids are reusable after reconnect, so every lookup is epoch-scoped. Responses bind by
 * the exact user-input revision captured when their provider turn opened; an orphaned earlier item
 * can therefore age out, but can never be shifted onto a later response.
 */
export class UserOriginBindingLedger {
  readonly #limit: number
  #epoch = 0
  readonly #itemsByRevision = new Map<string, UserOriginItem>()
  readonly #itemRevisionKeys = new Map<string, string>()
  readonly #responseItems = new Map<string, string>()

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) throw new RangeError('limit must be positive')
    this.#limit = limit
  }

  beginEpoch(epoch: number): void {
    if (!Number.isInteger(epoch) || epoch < 0) throw new RangeError('epoch must be non-negative')
    this.#epoch = epoch
    this.#itemsByRevision.clear()
    this.#itemRevisionKeys.clear()
    this.#responseItems.clear()
  }

  registerUserItem(input: {
    readonly epoch: number
    readonly revision: number
    readonly itemId: string
  }): boolean {
    if (
      input.epoch !== this.#epoch
      || !Number.isInteger(input.revision)
      || input.revision <= 0
      || input.itemId === ''
    ) return false
    const itemKey = callKey(input.epoch, input.itemId)
    const knownRevisionKey = this.#itemRevisionKeys.get(itemKey)
    const revisionKey = callKey(input.epoch, String(input.revision))
    if (knownRevisionKey !== undefined) return knownRevisionKey === revisionKey
    if (this.#itemsByRevision.has(revisionKey)) return false
    this.#itemsByRevision.set(revisionKey, {
      epoch: input.epoch,
      revision: input.revision,
      item_id: input.itemId,
      origin_ref: null,
      transcript_failed: false,
      claimed: false,
    })
    this.#itemRevisionKeys.set(itemKey, revisionKey)
    this.#pruneItems()
    return true
  }

  bindResponse(input: {
    readonly epoch: number
    readonly responseId: string
    readonly revision: number
  }): UserOriginResponseBinding {
    if (input.epoch !== this.#epoch) {
      return {status: 'epoch_mismatch', revision: input.revision}
    }
    const responseKey = callKey(input.epoch, input.responseId)
    const existingItemId = this.#responseItems.get(responseKey)
    if (existingItemId !== undefined) {
      const item = this.#itemFor(input.epoch, existingItemId)
      return item === undefined
        ? {status: 'missing_item', revision: input.revision}
        : {status: 'bound', item_id: item.item_id, revision: item.revision}
    }
    const item = this.#itemsByRevision.get(callKey(input.epoch, String(input.revision)))
    if (item === undefined || item.transcript_failed) {
      return {status: 'missing_item', revision: input.revision}
    }
    if (item.claimed) return {status: 'item_already_claimed', revision: input.revision}
    item.claimed = true
    this.#rememberResponse(responseKey, item.item_id)
    return {status: 'bound', item_id: item.item_id, revision: item.revision}
  }

  /** A bounded retry may reuse only the exact reserved item, never another revision's item. */
  bindRetryResponse(input: {
    readonly epoch: number
    readonly responseId: string
    readonly itemId: string
  }): boolean {
    if (input.epoch !== this.#epoch) return false
    const item = this.#itemFor(input.epoch, input.itemId)
    if (item === undefined || item.transcript_failed || item.origin_ref === null) return false
    const responseKey = callKey(input.epoch, input.responseId)
    const existing = this.#responseItems.get(responseKey)
    if (existing !== undefined) return existing === input.itemId
    this.#rememberResponse(responseKey, input.itemId)
    return true
  }

  resolveTranscript(input: {
    readonly epoch: number
    readonly itemId: string
    readonly originRef: string
  }): boolean {
    const item = this.#itemFor(input.epoch, input.itemId)
    if (item === undefined || item.transcript_failed || input.originRef === '') return false
    item.origin_ref = input.originRef
    return true
  }

  failTranscript(epoch: number, itemId: string): boolean {
    const item = this.#itemFor(epoch, itemId)
    if (item === undefined) return false
    item.transcript_failed = true
    item.origin_ref = null
    for (const [responseKey, boundItemId] of [...this.#responseItems]) {
      if (boundItemId === itemId) this.#responseItems.delete(responseKey)
    }
    return true
  }

  itemForResponse(epoch: number, responseId: string): string | undefined {
    if (epoch !== this.#epoch) return undefined
    return this.#responseItems.get(callKey(epoch, responseId))
  }

  originRefForItem(epoch: number, itemId: string): string | undefined {
    const item = this.#itemFor(epoch, itemId)
    return item?.origin_ref ?? undefined
  }

  hasOriginRef(epoch: number, itemId: string): boolean {
    return this.originRefForItem(epoch, itemId) !== undefined
  }

  hasUnboundRevision(epoch: number, revision: number): boolean {
    if (epoch !== this.#epoch) return false
    const item = this.#itemsByRevision.get(callKey(epoch, String(revision)))
    return item !== undefined && !item.claimed && !item.transcript_failed
  }

  get unboundCount(): number {
    let count = 0
    for (const item of this.#itemsByRevision.values()) {
      if (!item.claimed && !item.transcript_failed) count += 1
    }
    return count
  }

  get boundResponses(): readonly (readonly [string, string])[] {
    return [...this.#responseItems.entries()]
  }

  get boundResponseCount(): number {
    return this.#responseItems.size
  }

  #itemFor(epoch: number, itemId: string): UserOriginItem | undefined {
    if (epoch !== this.#epoch) return undefined
    const revisionKey = this.#itemRevisionKeys.get(callKey(epoch, itemId))
    return revisionKey === undefined ? undefined : this.#itemsByRevision.get(revisionKey)
  }

  #rememberResponse(responseKey: string, itemId: string): void {
    this.#responseItems.set(responseKey, itemId)
    while (this.#responseItems.size > this.#limit) {
      const oldest = this.#responseItems.keys().next()
      if (oldest.done) break
      this.#responseItems.delete(oldest.value)
    }
  }

  #pruneItems(): void {
    while (this.#itemsByRevision.size > this.#limit) {
      const oldest = this.#itemsByRevision.entries().next()
      if (oldest.done) break
      const [revisionKey, item] = oldest.value
      this.#itemsByRevision.delete(revisionKey)
      this.#itemRevisionKeys.delete(callKey(item.epoch, item.item_id))
      for (const [responseKey, itemId] of [...this.#responseItems]) {
        if (itemId === item.item_id) this.#responseItems.delete(responseKey)
      }
    }
  }
}
