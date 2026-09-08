import {homedir} from 'node:os'
import {resolve} from 'node:path'
import type {Settings} from '../config.js'
import {canonicalJson} from '../canonical-json.js'
import type {Channel, Memory} from '../memory.js'
import {BLACKBOARD_BATCH_BYTES, BLACKBOARD_BATCH_ITEMS, BlackboardStore, BlackboardStoreError, type BlackboardBatch, type BlackboardOptions} from './blackboard-store.js'

export type BlackboardSessionOptions = Omit<BlackboardOptions, 'channels' | 'conversationId'>
type Summary = {text: string; throughSequence: number; retentionRevision: number} | null
interface Cursor {highWater: number; retentionRevision: number; summary: Summary}

/** One runtime owns this store; Memory remains the live projection, not a second mutation queue. */
export class BlackboardSession {
  readonly #memory: Memory
  readonly #store: BlackboardStore
  readonly #committed = new Map<string, Cursor>()
  #generation = 0
  #revision = 0
  #opened = false
  #opening = false
  #failure: Error | undefined
  #requested = false
  #maintenance = false
  #drain: Promise<void> | undefined
  #clearing: Promise<void> | undefined
  #closing: Promise<void> | undefined

  constructor(memory: Memory, options: BlackboardSessionOptions) {
    this.#memory = memory
    this.#store = new BlackboardStore({...options, conversationId: memory.scope.conversation_id,
      channels: [...memory.policies.keys()]})
  }

  async open(): Promise<void> {
    if (this.#opened || this.#opening || this.#closing !== undefined) throw new BlackboardStoreError('closed')
    this.#opening = true
    try {
      const snapshot = await this.#store.open()
      if (this.#closing !== undefined) throw new BlackboardStoreError('closed')
      this.#memory.restore(snapshot.channels)
      this.#generation = snapshot.generation
      this.#revision = snapshot.revision
      for (const channel of this.#memory.channels.values()) this.#committed.set(channel.name, cursor(channel))
      this.#opened = true
    } catch (error) { this.#failure = error instanceof Error ? error : new BlackboardStoreError('storage'); await this.#store.close(); throw error }
    finally { this.#opening = false }
  }

  /** Every caller waits until changes observed during any outstanding commit have also drained. */
  // ponytail: quiescent drain; use caller watermarks before adding high-rate host writers.
  flush(maintenance = false): Promise<void> {
    if (!this.#opened || this.#closing !== undefined) return Promise.reject(new BlackboardStoreError('closed'))
    if (this.#clearing !== undefined) return this.#clearing
    return this.#requestFlush(maintenance)
  }

  /** Caller pauses reducer mutation; prior writes drain before one durable clear receipt changes Memory. */
  clear(): Promise<void> {
    if (!this.#opened || this.#closing !== undefined) return Promise.reject(new BlackboardStoreError('closed'))
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    if (this.#clearing !== undefined) return this.#clearing
    const previous = this.#requestFlush(false)
    const clearing = previous.then(async () => {
      const batch: BlackboardBatch = {
        generation: this.#generation,
        revision: this.#revision + 1,
        mutations: [{kind: 'clear'}],
      }
      const receipt = await this.#store.commit(batch)
      const revisions = new Map<string, number>()
      for (const channel of this.#memory.channels.values()) revisions.set(channel.name, channel.retentionRevision)
      for (const retention of receipt.retention) revisions.set(retention.channel, retention.retentionRevision)
      this.#memory.clear(revisions)
      this.#revision = receipt.revision
      this.#generation = receipt.generation
      this.#committed.clear()
      for (const channel of this.#memory.channels.values()) this.#committed.set(channel.name, cursor(channel))
    }).catch(error => {
      this.#failure = error instanceof Error ? error : new BlackboardStoreError('storage')
      throw this.#failure
    }).finally(() => {
      if (this.#clearing === clearing) this.#clearing = undefined
    })
    this.#clearing = clearing
    return clearing
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      const clearing = this.#clearing
      try {
        if (clearing !== undefined) await clearing
        else if (this.#opened) await this.#requestFlush(false)
      }
      finally { this.#opened = false; await this.#store.close() }
    })()
    return this.#closing
  }

  #requestFlush(maintenance: boolean): Promise<void> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    this.#requested = true
    this.#maintenance ||= maintenance
    this.#drain ??= (async () => {
      // Start after synchronous reducer work has finished, including its final admission record.
      await Promise.resolve()
      try {
        while (this.#requested) {
          this.#requested = false
          const maintain = this.#maintenance
          this.#maintenance = false
          await this.#commit(maintain)
        }
      } catch (error) { this.#failure = error instanceof Error ? error : new BlackboardStoreError('storage'); throw error }
      finally { this.#drain = undefined }
    })()
    return this.#drain
  }

  async #commit(maintenance: boolean): Promise<void> {
    const mutations: BlackboardBatch['mutations'] = []
    const summaries: BlackboardBatch['mutations'] = []
    for (const channel of this.#memory.channels.values()) {
      const previous = this.#committed.get(channel.name)
      if (previous?.retentionRevision !== channel.retentionRevision) {
        throw new BlackboardStoreError('retention')
      }
      const appended = channel.items.filter(item => item.seq > previous.highWater)
      if (channel.highWater < previous.highWater
        || appended.length !== channel.highWater - previous.highWater) throw new BlackboardStoreError('sequence')
      for (const item of appended) mutations.push({kind: 'append', item})
      const current = cursor(channel)
      if (canonicalJson(current.summary) !== canonicalJson(previous.summary)) {
        if (current.summary === null) throw new BlackboardStoreError('retention')
        summaries.push({kind: 'summary', channel: channel.name, ...current.summary})
      }
    }
    mutations.push(...summaries)
    if (mutations.length === 0 && !maintenance) return
    const batch: BlackboardBatch = {generation: this.#generation, revision: this.#revision + 1, mutations: []}
    let bytes = Buffer.byteLength(canonicalJson(batch), 'utf8')
    for (const mutation of mutations) {
      const size = Buffer.byteLength(canonicalJson(mutation), 'utf8') + (batch.mutations.length === 0 ? 0 : 1)
      if (batch.mutations.length === BLACKBOARD_BATCH_ITEMS || bytes + size > BLACKBOARD_BATCH_BYTES) {
        if (batch.mutations.length === 0) throw new BlackboardStoreError('capacity')
        // Rescan the live projection after the receipt, including retention and concurrent writes.
        this.#requested = true
        break
      }
      batch.mutations.push(mutation)
      bytes += size
    }
    const receipt = await this.#store.commit(batch)
    this.#revision = receipt.revision
    this.#generation = receipt.generation
    for (const mutation of batch.mutations) {
      if (mutation.kind === 'append') this.#committed.get(mutation.item.channel)!.highWater = mutation.item.seq
      else if (mutation.kind === 'summary') this.#committed.get(mutation.channel)!.summary = {
        text: mutation.text, throughSequence: mutation.throughSequence, retentionRevision: mutation.retentionRevision,
      }
    }
    for (const retention of receipt.retention) {
      this.#memory.channels.get(retention.channel)!.applyRetention(retention.prunedThroughSequence, retention.retentionRevision)
      const position = this.#committed.get(retention.channel)!
      position.retentionRevision = retention.retentionRevision
      position.summary = null
    }
  }
}

function cursor(channel: Channel): Cursor {
  return {highWater: channel.highWater, retentionRevision: channel.retentionRevision,
    summary: channel.summary === null ? null : {text: channel.summary,
      throughSequence: channel.summaryThroughSequence, retentionRevision: channel.retentionRevision}}
}

/** Host-owned recovery is independent of the selected personal-memory backend. */
export function blackboardOptionsFromSettings(settings: Settings): BlackboardSessionOptions {
  const path = settings.blackboard_path
  return {path: resolve(path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path),
    ownerId: settings.blackboard_owner_id}
}
