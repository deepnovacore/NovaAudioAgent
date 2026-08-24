import { z } from 'zod'
import { jsonValueSchema, outcomeSchema, trustSchema } from './events.js'
import { handoffPolicySchema, memoryRefSchema } from './memory.js'

export const routingClassSchema = z.enum(['user_awaited', 'ambient'])

const requestSchema = z.record(z.string(), jsonValueSchema)

export const delegateRequestSchema = z.object({
  executor: z.string().min(1),
  op: z.string().min(1),
  request: requestSchema,
  origin_ref: z.string().min(1),
}).strict()

export const delegateSchema = delegateRequestSchema.extend({
  origin_ref: memoryRefSchema,
  delegate_id: z.string().min(1),
  deadline: z.number().finite(),
  routing_class: routingClassSchema,
  dispatched_at: z.number().finite(),
}).strict()

export type DelegateRequest = z.infer<typeof delegateRequestSchema>
export type Delegate = z.infer<typeof delegateSchema>

export const executorHandoffSchema = z.object({
  outcome: outcomeSchema,
  trust: trustSchema,
  content: z.record(z.string(), jsonValueSchema),
  refs: z.array(z.string()).default([]),
}).strict()

export const updateSpecSchema = z.object({
  target: z.string().min(1),
  delta: z.record(z.string(), jsonValueSchema),
}).strict()

export const speakOutputSchema = z.discriminatedUnion('act', [
  z.object({act: z.literal('none')}).strict(),
  z.object({act: z.literal('say'), text: z.string()}).strict(),
  z.object({act: z.literal('ask'), text: z.string()}).strict(),
])

export const actionOutputSchema = z.discriminatedUnion('act', [
  z.object({act: z.literal('none')}).strict(),
  z.object({act: z.literal('delegate'), delegate: delegateRequestSchema}).strict(),
  z.object({act: z.literal('update'), update: updateSpecSchema}).strict(),
])

export const contractFailureSchema = z.object({
  code: z.string().min(1),
  tool_name: z.string().min(1).nullable().default(null),
}).strict()

export const fastBrainOutputSchema = z.object({
  speak: speakOutputSchema,
  action: actionOutputSchema,
  /**
   * Malformed tool calls observed in this call's stream, without their payloads.
   *
   * Present so a streaming port can report what the oracle's CallRecord reports. Any
   * entry suppresses the action entirely, so dropping this field would dispatch an
   * action the oracle refuses.
   */
  contract_failures: z.array(contractFailureSchema).default([]),
  /**
   * How many actions arrived beyond the first.
   *
   * The action axis is singular, so a surplus is a conflict rather than last-one-wins.
   * Any surplus suppresses every action, including the first.
   */
  extra_actions: z.number().int().nonnegative().default(0),
}).strict()

export const surrogateOutputSchema = z.object({
  speak: z.boolean(),
  suggestion_id: z.string().nullable().default(null),
  reason: z.string().default(''),
}).strict()

export const compressorOutputSchema = z.object({
  channel: z.string().min(1),
  summary: z.string(),
}).strict()

export type UpdateSpec = z.infer<typeof updateSpecSchema>
export type FastBrainOutput = z.infer<typeof fastBrainOutputSchema>
export type SurrogateOutput = z.infer<typeof surrogateOutputSchema>
export type CompressorOutput = z.infer<typeof compressorOutputSchema>

export const opSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  params: z.record(z.string(), jsonValueSchema),
  readonly: z.boolean().default(false),
  confirm: z.boolean().default(false),
  deadline_budget: z.number().finite().positive().default(30),
  verifies: z.array(z.string()).default([]),
  sensitive_params: z.array(z.string()).default([]),
  sync_result: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (new Set(value.sensitive_params).size !== value.sensitive_params.length) {
    context.addIssue({code: 'custom', message: 'sensitive_params must be unique'})
  }
  const properties = value.params.properties
  if (
    value.sensitive_params.length > 0
    && (typeof properties !== 'object' || properties === null || Array.isArray(properties))
  ) {
    context.addIssue({code: 'custom', message: 'sensitive_params must name declared properties'})
    return
  }
  for (const name of value.sensitive_params) {
    if (!Object.hasOwn(properties as object, name)) {
      context.addIssue({code: 'custom', message: 'sensitive_params must name declared properties'})
    }
  }
})

export const executorManifestSchema = z.object({
  name: z.string().min(1),
  ops: z.array(opSpecSchema),
  policy: handoffPolicySchema,
  confirm_ttl: z.number().finite().nonnegative().default(0),
}).strict().superRefine((value, context) => {
  if (value.name !== value.policy.channel) {
    context.addIssue({code: 'custom', message: 'manifest name must match policy channel'})
  }
})

export type OpSpec = z.infer<typeof opSpecSchema>
export type ExecutorManifest = z.infer<typeof executorManifestSchema>
