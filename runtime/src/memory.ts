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
  refs: z.array(memoryRefSchema).default([]),
}).strict()

export type MemoryItem = z.infer<typeof memoryItemSchema>

export const handoffPolicySchema = z.object({
  channel: z.string().min(1),
  priority: z.number().int(),
  wake: z.enum(['fast', 'surrogate', 'none']),
  typical_latency: z.number().finite().nonnegative(),
  compress_watermark: z.number().int().positive(),
  suggest: z.boolean().default(false),
  progress_via_surrogate: z.boolean().default(false),
}).strict()

export type HandoffPolicy = z.infer<typeof handoffPolicySchema>

export const CONVERSATION_CHANNEL_POLICY: HandoffPolicy = handoffPolicySchema.parse({
  channel: CONVERSATION_CHANNEL,
  priority: USER_PRIORITY,
  wake: 'none',
  typical_latency: 0,
  compress_watermark: 40,
})

export const intentSchema = z.object({
  objective_hypothesis: z.string().default(''),
  constraints: z.array(z.string()).default([]),
  unresolved_questions: z.array(z.string()).default([]),
  uncertainty: z.number().finite().default(1),
  revision: z.number().int().nonnegative().default(0),
}).strict()

export const goalSchema = z.object({
  objective: z.string().default(''),
  acceptance_criteria: z.array(z.string()).default([]),
  status: z.string().default('accepted'),
  revision: z.number().int().nonnegative().default(0),
}).strict()

export const authorizationSchema = z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  evidence_refs: z.array(z.string()).default([]),
  revision: z.number().int().nonnegative().default(0),
}).strict()

export const structuredStateSchema = z.object({
  intent: intentSchema.default(() => intentSchema.parse({})),
  goal: goalSchema.default(() => goalSchema.parse({})),
  authorization: authorizationSchema.default(() => authorizationSchema.parse({})),
}).strict()

export type Intent = z.infer<typeof intentSchema>
export type Goal = z.infer<typeof goalSchema>
export type Authorization = z.infer<typeof authorizationSchema>
export type StructuredState = z.infer<typeof structuredStateSchema>
export type StructuredTarget = keyof StructuredState

export function emptyStructuredState(): StructuredState {
  return structuredStateSchema.parse({})
}

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
  readonly refs?: readonly MemoryRef[]
}

export class Channel {
  readonly name: string
  #items: MemoryItem[] = []
  summary: string | null = null
  uncompressed = 0

  constructor(name: string) {
    if (name.length === 0) throw new TypeError('channel name cannot be empty')
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
  structured: StructuredState

  constructor(options: {
    readonly scope?: ConversationScope
    readonly policies?: readonly HandoffPolicy[]
    readonly structured?: StructuredState
  } = {}) {
    this.scope = conversationScopeSchema.parse(options.scope ?? {})
    this.structured = structuredStateSchema.parse(options.structured ?? {})
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

const intentUpdateSchema = z.object({
  objective_hypothesis: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  unresolved_questions: z.array(z.string()).optional(),
  uncertainty: z.number().finite().optional(),
}).strict()
const goalUpdateSchema = z.object({
  objective: z.string().optional(),
  acceptance_criteria: z.array(z.string()).optional(),
  status: z.string().optional(),
}).strict()
const authorizationUpdateSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  evidence_refs: z.array(z.string()).optional(),
}).strict()

const updateSchemas = {
  intent: intentUpdateSchema,
  goal: goalUpdateSchema,
  authorization: authorizationUpdateSchema,
} as const

export type StructuredUpdateResult =
  | {readonly ok: true, readonly state: StructuredState}
  | {
    readonly ok: false
    readonly reason: 'unknown_target' | 'malformed_delta' | 'empty_delta' | 'unknown_fields' | 'bad_types'
    readonly unknown?: readonly string[]
    readonly fields?: readonly string[]
  }

export function applyStructuredUpdate(
  state: StructuredState,
  target: string,
  delta: unknown,
): StructuredUpdateResult {
  if (!(target in updateSchemas)) return {ok: false, reason: 'unknown_target'}
  if (!isPlainObject(delta)) return {ok: false, reason: 'malformed_delta'}
  const fields = Object.keys(delta)
  if (fields.length === 0) return {ok: false, reason: 'empty_delta'}

  const schema = updateSchemas[target as StructuredTarget]
  const allowed = new Set(Object.keys(schema.shape))
  const unknown = fields.filter(field => !allowed.has(field)).sort(compareStrings)
  if (unknown.length > 0) return {ok: false, reason: 'unknown_fields', unknown}

  const parsed = schema.safeParse(delta)
  if (!parsed.success) {
    const badFields = [...new Set(parsed.error.issues
      .map(issue => issue.path[0])
      .filter((field): field is string => typeof field === 'string'))].sort(compareStrings)
    return {ok: false, reason: 'bad_types', fields: badFields}
  }

  switch (target) {
    case 'intent':
      return {
        ok: true,
        state: structuredStateSchema.parse({
          ...state,
          intent: {...state.intent, ...parsed.data, revision: state.intent.revision + 1},
        }),
      }
    case 'goal':
      return {
        ok: true,
        state: structuredStateSchema.parse({
          ...state,
          goal: {...state.goal, ...parsed.data, revision: state.goal.revision + 1},
        }),
      }
    case 'authorization':
      return {
        ok: true,
        state: structuredStateSchema.parse({
          ...state,
          authorization: {
            ...state.authorization,
            ...parsed.data,
            revision: state.authorization.revision + 1,
          },
        }),
      }
    default:
      return {ok: false, reason: 'unknown_target'}
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneJsonObject(value: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return structuredClone(value)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
