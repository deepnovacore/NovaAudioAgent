import { z } from 'zod'
import {
  jsonValueSchema,
  outcomeSchema,
  trustSchema,
  type JsonValue,
} from './events.js'

export const CONVERSATION_CHANNEL = 'conversation'
export const USER_PRIORITY = 100

export const memoryRefSchema = z.string().regex(/^.+:[0-9]+$/u, 'invalid MemoryRef')

export type MemoryRef = z.infer<typeof memoryRefSchema>

export function makeMemoryRef(channel: string, sequence: number): MemoryRef {
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new RangeError(`memory sequence must be a non-negative integer: ${sequence}`)
  }
  return memoryRefSchema.parse(`${channel}:${sequence}`)
}

export function parseMemoryRef(reference: MemoryRef): readonly [string, number] {
  const parsed = memoryRefSchema.parse(reference)
  const separator = parsed.lastIndexOf(':')
  return [parsed.slice(0, separator), Number(parsed.slice(separator + 1))]
}

const jsonObjectSchema = z.record(z.string(), jsonValueSchema)

export const memoryItemSchema = z.object({
  channel: z.string().min(1),
  seq: z.number().int().positive(),
  ts: z.number().finite(),
  trust: trustSchema,
  priority: z.number().int(),
  content: jsonObjectSchema,
  outcome: outcomeSchema.nullable().default(null),
  // Executor evidence refs (for example web.search://evidence/...) intentionally
  // coexist with canonical MemoryRefs here. Only origin_ref is required to be
  // parseable; Python's MemoryItem stores the remaining refs as opaque strings.
  refs: z.array(z.string()).default([]),
}).strict()

export type MemoryItem = z.infer<typeof memoryItemSchema>

/** Recovery contains records only: no executable delegates, events or capabilities. */
export const memoryChannelSnapshotSchema = z.object({
  name: z.string().min(1).max(512), highWater: z.number().int().nonnegative(),
  retentionRevision: z.number().int().nonnegative(),
  summary: z.object({text: z.string().max(65_536), throughSequence: z.number().int().positive(),
    expiresAtMs: z.number().int().nonnegative()}).strict().nullable(),
  items: z.array(z.object({item: memoryItemSchema, recordedAtMs: z.number().int().nonnegative(),
    ordinal: z.number().int().positive()}).strict()).max(10_000),
}).strict().superRefine((channel, context) => {
  let previous = 0
  for (const {item} of channel.items) {
    if (item.channel !== channel.name || item.seq <= previous || item.seq > channel.highWater) {
      context.addIssue({code: 'custom', message: 'invalid recovered record sequence'})
    }
    previous = item.seq
  }
  if (channel.summary !== null && !channel.items.some(({item}) => item.seq === channel.summary!.throughSequence)) {
    context.addIssue({code: 'custom', message: 'missing recovered summary source'})
  }
})
export type MemoryChannelSnapshot = z.infer<typeof memoryChannelSnapshotSchema>

export const handoffPolicySchema = z.object({
  channel: z.string().min(1),
  priority: z.number().int(),
  wake: z.enum(['fast', 'surrogate', 'none']),
  typical_latency: z.number().finite().nonnegative(),
  compress_watermark: z.number().int().positive(),
  /** What kind of work this handoff represents; semantics must not infer it from the channel id. */
  operation_class: z.enum(['task', 'monitor']).default('task'),
  /** How a monitor's hit reaches the user. Ordinary tasks do not deliver alerts. */
  alert_delivery: z.enum(['none', 'deferred', 'preemptive']).default('none'),
  suggest: z.boolean().default(false),
  progress_via_surrogate: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.operation_class === 'task' && value.alert_delivery !== 'none') {
    context.addIssue({
      code: 'custom',
      message: 'task handoff policies must use alert_delivery none',
      path: ['alert_delivery'],
    })
  }
})

export type HandoffPolicy = z.infer<typeof handoffPolicySchema>

/** A policy, not a channel name, owns monitoring semantics. */
export function isMonitorPolicy(policy: Pick<Partial<HandoffPolicy>, 'operation_class'> | null | undefined): boolean {
  return policy?.operation_class === 'monitor'
}

/** A monitor alerts only when its policy explicitly assigns a delivery mode. */
export function monitorAlertDelivery(
  policy: Pick<Partial<HandoffPolicy>, 'operation_class' | 'alert_delivery'> | null | undefined,
): 'none' | 'deferred' | 'preemptive' {
  return policy?.operation_class === 'monitor' ? policy.alert_delivery ?? 'none' : 'none'
}

/** Preemption is an alert-delivery policy, never a channel name or priority band. */
export function isPreemptiveMonitorAlert(
  policy: Pick<Partial<HandoffPolicy>, 'operation_class' | 'alert_delivery'> | null | undefined,
): boolean {
  return monitorAlertDelivery(policy) === 'preemptive'
}

/** A preemptive monitor hit is prominent; deferred and non-alerting hits remain detail. */
export function monitorHitProgressLevel(
  policy: Pick<Partial<HandoffPolicy>, 'operation_class' | 'alert_delivery'> | null | undefined,
): 'milestone' | 'detail' {
  return isPreemptiveMonitorAlert(policy)
    ? 'milestone'
    : 'detail'
}

export const CONVERSATION_CHANNEL_POLICY: HandoffPolicy = handoffPolicySchema.parse({
  channel: CONVERSATION_CHANNEL,
  priority: USER_PRIORITY,
  wake: 'none',
  typical_latency: 0,
  compress_watermark: 40,
})

export const conversationScopeSchema = z.object({
  conversation_id: z.string().min(1).default('default'),
}).strict()

export type ConversationScope = z.infer<typeof conversationScopeSchema>

export interface AppendMemoryItem {
  readonly ts: number
  readonly trust: z.infer<typeof trustSchema>
  readonly priority: number
  readonly content: Readonly<Record<string, JsonValue>>
  readonly outcome?: z.infer<typeof outcomeSchema> | null
  readonly refs?: readonly string[]
}

export class Channel {
  readonly name: string
  #items: MemoryItem[] = []
  #lastSequence = 0
  #retentionRevision = 0
  #summaryThroughSequence = 0
  readonly #restoredThroughSequence: number
  readonly #restoredRecords = new Map<number, {recordedAtMs: number; ordinal: number}>()
  readonly #writable: boolean
  summary: string | null = null
  uncompressed = 0

  constructor(name: string, recovery?: MemoryChannelSnapshot, writable = true) {
    if (name === '') throw new TypeError('channel name cannot be empty')
    this.name = name
    this.#writable = writable
    const recovered = recovery === undefined ? undefined : memoryChannelSnapshotSchema.parse(recovery)
    if (recovered !== undefined && recovered.name !== name) throw new TypeError('recovered channel mismatch')
    this.#restoredThroughSequence = recovered?.highWater ?? 0
    if (recovered !== undefined) {
      this.#items = recovered.items.map(record => record.item)
      this.#lastSequence = recovered.highWater
      this.#retentionRevision = recovered.retentionRevision
      this.summary = recovered.summary?.text ?? null
      this.#summaryThroughSequence = recovered.summary?.throughSequence ?? 0
      this.uncompressed = this.#items.filter(item => item.seq > this.#summaryThroughSequence).length
      for (const record of recovered.items) this.#restoredRecords.set(record.item.seq, {
        recordedAtMs: record.recordedAtMs, ordinal: record.ordinal,
      })
    }
  }

  get restoredThroughSequence(): number { return this.#restoredThroughSequence }
  get highWater(): number { return this.#lastSequence }
  get summaryThroughSequence(): number { return this.#summaryThroughSequence }

  restoredRecord(sequence: number): Readonly<{recordedAtMs: number; ordinal: number}> | undefined {
    return this.#restoredRecords.get(sequence)
  }

  get items(): readonly MemoryItem[] {
    return this.#items
  }

  get retentionRevision(): number {
    return this.#retentionRevision
  }

  getBySeq(sequence: number): MemoryItem | undefined {
    return this.#items.find(item => item.seq === sequence)
  }

  /** Retention never renumbers records or lets a stale compressor restore removed sources. */
  pruneThrough(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError('invalid retention sequence')
    const retained = this.#items.filter(item => item.seq > sequence)
    if (retained.length === this.#items.length) return
    this.applyRetention(Math.min(sequence, this.#lastSequence), this.#retentionRevision + 1)
  }

  /** Store receipts carry an absolute revision, including summary-only expiry at sequence zero. */
  applyRetention(sequence: number, revision: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.#lastSequence
      || !Number.isSafeInteger(revision) || revision < this.#retentionRevision) throw new RangeError('invalid retention receipt')
    const retained = this.#items.filter(item => item.seq > sequence)
    if (revision === this.#retentionRevision) {
      if (retained.length !== this.#items.length) throw new RangeError('conflicting retention receipt')
      return
    }
    this.#items = retained
    for (const seq of this.#restoredRecords.keys()) if (seq <= sequence) this.#restoredRecords.delete(seq)
    this.#retentionRevision = revision
    this.#summaryThroughSequence = 0
    this.summary = null
    this.uncompressed = retained.length
  }

  replaceSummary(summary: string, throughSequence: number, retentionRevision: number): boolean {
    if (!this.#writable) return false
    if (retentionRevision !== this.#retentionRevision) return false
    if (throughSequence < this.#summaryThroughSequence) return false
    if (!Number.isSafeInteger(throughSequence) || this.getBySeq(throughSequence) === undefined) return false
    this.summary = summary
    this.#summaryThroughSequence = throughSequence
    this.uncompressed = this.#items.filter(item => item.seq > throughSequence).length
    return true
  }

  /** Forget the live projection without making a future record reuse this channel's sequence. */
  clear(retentionRevision = this.#retentionRevision + 1): void {
    if (!Number.isSafeInteger(retentionRevision) || retentionRevision < this.#retentionRevision) {
      throw new RangeError('invalid clear retention revision')
    }
    this.#items = []
    this.#restoredRecords.clear()
    this.#retentionRevision = retentionRevision
    this.#summaryThroughSequence = 0
    this.summary = null
    this.uncompressed = 0
  }

  append(input: AppendMemoryItem): MemoryItem {
    if (!this.#writable) throw new Error('historical channel is read-only')
    const item = memoryItemSchema.parse({
      channel: this.name,
      seq: this.#lastSequence + 1,
      ts: input.ts,
      trust: input.trust,
      priority: input.priority,
      content: cloneJsonObject(input.content),
      outcome: input.outcome ?? null,
      refs: [...(input.refs ?? [])],
    })
    this.#items = [...this.#items, item]
    this.#lastSequence = item.seq
    this.uncompressed += 1
    return item
  }
}

export class Memory {
  readonly scope: ConversationScope
  readonly policies = new Map<string, HandoffPolicy>()
  readonly channels = new Map<string, Channel>()
  #recovered = false

  constructor(options: {
    readonly scope?: ConversationScope
    readonly policies?: readonly HandoffPolicy[]
    readonly recovery?: readonly MemoryChannelSnapshot[]
  } = {}) {
    this.scope = conversationScopeSchema.parse(options.scope ?? {})
    for (const policy of [CONVERSATION_CHANNEL_POLICY, ...(options.policies ?? [])]) {
      const parsed = handoffPolicySchema.parse(policy)
      this.policies.set(parsed.channel, parsed)
    }
    this.#replaceChannels(options.recovery ?? [])
    this.#recovered = options.recovery !== undefined
  }

  /** Startup only; an existing reducer's Memory identity stays stable for its readers. */
  restore(snapshot: readonly MemoryChannelSnapshot[]): void {
    if (this.#recovered || [...this.channels.values()].some(channel => channel.highWater !== 0 || channel.summary !== null)) {
      throw new Error('memory recovery requires an unused instance')
    }
    this.#replaceChannels(snapshot)
    this.#recovered = true
  }

  /** A live clear retains the configured channels and their sequence watermarks. */
  clear(retentionRevisions?: ReadonlyMap<string, number>): void {
    if (retentionRevisions !== undefined) {
      if (retentionRevisions.size !== this.channels.size) throw new RangeError('clear retention revisions must cover every channel')
      for (const name of retentionRevisions.keys()) {
        if (!this.channels.has(name)) throw new RangeError('clear retention revisions contain an unknown channel')
      }
    }
    for (const [name, channel] of this.channels) {
      channel.clear(retentionRevisions?.get(name))
    }
  }

  #replaceChannels(snapshot: readonly MemoryChannelSnapshot[]): void {
    const recovery = new Map(snapshot.map(channel => [channel.name, channel]))
    if (recovery.size !== snapshot.length) throw new TypeError('duplicate recovered channel')
    const channels = new Map<string, Channel>()
    for (const channel of new Set([...this.policies.keys(), ...recovery.keys()])) {
      channels.set(channel, new Channel(channel, recovery.get(channel), this.policies.has(channel)))
    }
    this.channels.clear()
    for (const [name, channel] of channels) this.channels.set(name, channel)
  }

  isHistorical(item: Pick<MemoryItem, 'channel' | 'seq'>): boolean {
    return item.seq <= (this.channels.get(item.channel)?.restoredThroughSequence ?? 0)
  }

  /** Process-local timestamps cannot order records from different process lifetimes. */
  compareRecency(left: MemoryItem, right: MemoryItem): number {
    const leftRecord = this.channels.get(left.channel)?.restoredRecord(left.seq)
    const rightRecord = this.channels.get(right.channel)?.restoredRecord(right.seq)
    if (leftRecord !== undefined && rightRecord !== undefined) return rightRecord.ordinal - leftRecord.ordinal
    if (leftRecord !== undefined) return 1
    if (rightRecord !== undefined) return -1
    return right.ts - left.ts
  }

  append(channel: string, input: AppendMemoryItem): MemoryItem {
    const target = this.channels.get(channel)
    if (target === undefined) throw new Error(`unknown memory channel: ${channel}`)
    return target.append(input)
  }
}

function cloneJsonObject(value: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return structuredClone(value)
}
