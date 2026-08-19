import { z } from 'zod'

export const EVENT_KINDS = [
  'user_input',
  'handoff',
  'progress',
  'observation',
  'deadline',
  'compress',
  'model_done',
  'compress_done',
  'speak_start',
  'speak_end',
  'assistant_spoken',
] as const

export const trustSchema = z.enum([
  'trusted_user',
  'trusted_system',
  'untrusted_external',
])
export const outcomeSchema = z.enum(['ok', 'unknown', 'failed'])

export type JsonValue = null | boolean | number | string | JsonValue[] | {
  readonly [key: string]: JsonValue
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]))

const jsonObjectSchema = z.record(z.string(), jsonValueSchema)
const timestampSchema = z.number().finite()
const sequenceSchema = z.number().int().nonnegative()

export const PROGRESS_SUMMARY_LIMIT = 400

export function validProgressSummary(summary: unknown, phase: string): boolean {
  if (summary === null) return true
  if (typeof summary !== 'string' || phase !== 'working') return false
  const characters = [...summary]
  return characters.length >= 1
    && characters.length <= PROGRESS_SUMMARY_LIMIT
    && characters.every(character => !/\p{C}/u.test(character))
}

const eventRecord = <Kind extends z.ZodLiteral<string>, Payload extends z.ZodType>(
  kind: Kind,
  payload: Payload,
) => z.object({
  seq: sequenceSchema,
  ts: timestampSchema,
  kind,
  payload,
}).strict()

const eventInput = <Kind extends z.ZodLiteral<string>, Payload extends z.ZodType>(
  kind: Kind,
  payload: Payload,
) => z.object({kind, payload}).strict()

const userInputPayloadSchema = z.object({
  text: z.string(),
  media_refs: z.array(z.string()).optional(),
}).strict().overwrite(payload => (
  payload.media_refs?.length === 0 ? {text: payload.text} : payload
))

const handoffPayloadSchema = z.object({
  channel: z.string(),
  delegate_id: z.string(),
  origin_ref: z.string(),
  outcome: outcomeSchema,
  trust: trustSchema,
  content: jsonObjectSchema,
  refs: z.array(z.string()).default([]),
}).strict()

const observationPayloadSchema = z.object({
  channel: z.string(),
  delegate_id: z.string(),
  op: z.string(),
  origin_ref: z.string(),
  trust: trustSchema,
  content: jsonObjectSchema,
  refs: z.array(z.string()).default([]),
}).strict()

const payloadSchemas = {
  user_input: userInputPayloadSchema,
  handoff: handoffPayloadSchema,
  progress: z.object({
    channel: z.string(),
    delegate_id: z.string(),
    op: z.string(),
    phase: z.enum(['started', 'working']),
    internal_activity: z.number().int().nonnegative(),
    elapsed: z.number().finite().nonnegative(),
    summary: z.string().nullable(),
  }).strict(),
  observation: observationPayloadSchema,
  deadline: z.object({delegate_id: z.string()}).strict(),
  compress: z.object({channel: z.string()}).strict(),
  model_done: z.object({slot: z.string(), job_id: z.string()}).strict(),
  compress_done: z.object({channel: z.string(), job_id: z.string()}).strict(),
  speak_start: z.object({
    utterance_id: z.string(),
    priority: z.number().int(),
  }).strict(),
  speak_end: z.object({utterance_id: z.string()}).strict(),
  assistant_spoken: z.object({
    text: z.string(),
    utterance_id: z.string(),
    delivery: z.enum(['spoken', 'interrupted']),
    played_ms: z.number().int().nonnegative().nullable(),
  }).strict(),
} as const

export const eventRecordSchema = z.discriminatedUnion('kind', [
  eventRecord(z.literal('user_input'), payloadSchemas.user_input),
  eventRecord(z.literal('handoff'), payloadSchemas.handoff),
  eventRecord(z.literal('progress'), payloadSchemas.progress),
  eventRecord(z.literal('observation'), payloadSchemas.observation),
  eventRecord(z.literal('deadline'), payloadSchemas.deadline),
  eventRecord(z.literal('compress'), payloadSchemas.compress),
  eventRecord(z.literal('model_done'), payloadSchemas.model_done),
  eventRecord(z.literal('compress_done'), payloadSchemas.compress_done),
  eventRecord(z.literal('speak_start'), payloadSchemas.speak_start),
  eventRecord(z.literal('speak_end'), payloadSchemas.speak_end),
  eventRecord(z.literal('assistant_spoken'), payloadSchemas.assistant_spoken),
])

export const eventInputSchema = z.discriminatedUnion('kind', [
  eventInput(z.literal('user_input'), payloadSchemas.user_input),
  eventInput(z.literal('handoff'), payloadSchemas.handoff),
  eventInput(z.literal('progress'), payloadSchemas.progress),
  eventInput(z.literal('observation'), payloadSchemas.observation),
  eventInput(z.literal('deadline'), payloadSchemas.deadline),
  eventInput(z.literal('compress'), payloadSchemas.compress),
  eventInput(z.literal('model_done'), payloadSchemas.model_done),
  eventInput(z.literal('compress_done'), payloadSchemas.compress_done),
  eventInput(z.literal('speak_start'), payloadSchemas.speak_start),
  eventInput(z.literal('speak_end'), payloadSchemas.speak_end),
  eventInput(z.literal('assistant_spoken'), payloadSchemas.assistant_spoken),
])

export type EventRecord = z.infer<typeof eventRecordSchema>
export type EventInput = z.infer<typeof eventInputSchema>

interface QueueEntry {
  readonly event: EventRecord
  readonly rank: number
}

export class EventQueue {
  readonly #heap: QueueEntry[] = []
  #sequence = 0

  push(input: EventInput, at: number): EventRecord {
    if (!Number.isFinite(at)) throw new TypeError('event timestamp must be finite')
    this.#sequence += 1
    const event = eventRecordSchema.parse({
      ...input,
      seq: this.#sequence,
      ts: at,
    })
    this.#heap.push({event, rank: event.kind === 'deadline' ? 1 : 0})
    this.#siftUp(this.#heap.length - 1)
    return event
  }

  popReady(now: number): EventRecord | undefined {
    const first = this.#heap[0]
    if (first === undefined || first.event.ts > now) return undefined
    const last = this.#heap.pop()
    if (this.#heap.length > 0 && last !== undefined) {
      this.#heap[0] = last
      this.#siftDown(0)
    }
    return first.event
  }

  nextTimestamp(): number | undefined {
    return this.#heap[0]?.event.ts
  }

  get size(): number {
    return this.#heap.length
  }

  #siftUp(index: number): void {
    let child = index
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2)
      if (compareEntries(this.#heap[parent]!, this.#heap[child]!) <= 0) return
      ;[this.#heap[parent], this.#heap[child]] = [this.#heap[child]!, this.#heap[parent]!]
      child = parent
    }
  }

  #siftDown(index: number): void {
    let parent = index
    while (true) {
      const left = parent * 2 + 1
      const right = left + 1
      let smallest = parent
      if (
        left < this.#heap.length
        && compareEntries(this.#heap[left]!, this.#heap[smallest]!) < 0
      ) smallest = left
      if (
        right < this.#heap.length
        && compareEntries(this.#heap[right]!, this.#heap[smallest]!) < 0
      ) smallest = right
      if (smallest === parent) return
      ;[this.#heap[parent], this.#heap[smallest]] = [
        this.#heap[smallest]!,
        this.#heap[parent]!,
      ]
      parent = smallest
    }
  }
}

function compareEntries(left: QueueEntry, right: QueueEntry): number {
  return left.event.ts - right.event.ts
    || left.rank - right.rank
    || left.event.seq - right.event.seq
}
