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
export function isMonitorPolicy(policy: Pick<HandoffPolicy, 'operation_class'> | null | undefined): boolean {
  return policy?.operation_class === 'monitor'
}

/** A preemptive monitor hit is prominent; deferred and non-alerting hits remain detail. */
export function monitorHitProgressLevel(
  policy: Pick<HandoffPolicy, 'operation_class' | 'alert_delivery'> | null | undefined,
): 'milestone' | 'detail' {
  return policy?.operation_class === 'monitor' && policy.alert_delivery === 'preemptive'
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
  summary: string | null = null
  uncompressed = 0

  constructor(name: string) {
    if (name === '') throw new TypeError('channel name cannot be empty')
    this.name = name
  }

  get items(): readonly MemoryItem[] {
    return this.#items
  }

  append(input: AppendMemoryItem): MemoryItem {
    const item = memoryItemSchema.parse({
      channel: this.name,
      seq: this.#items.length + 1,
      ts: input.ts,
      trust: input.trust,
      priority: input.priority,
      content: cloneJsonObject(input.content),
      outcome: input.outcome ?? null,
      refs: [...(input.refs ?? [])],
    })
    this.#items = [...this.#items, item]
    this.uncompressed += 1
    return item
  }
}

export class Memory {
  readonly scope: ConversationScope
  readonly policies = new Map<string, HandoffPolicy>()
  readonly channels = new Map<string, Channel>()

  constructor(options: {
    readonly scope?: ConversationScope
    readonly policies?: readonly HandoffPolicy[]
  } = {}) {
    this.scope = conversationScopeSchema.parse(options.scope ?? {})
    for (const policy of [CONVERSATION_CHANNEL_POLICY, ...(options.policies ?? [])]) {
      const parsed = handoffPolicySchema.parse(policy)
      this.policies.set(parsed.channel, parsed)
    }
    for (const channel of this.policies.keys()) this.channels.set(channel, new Channel(channel))
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
