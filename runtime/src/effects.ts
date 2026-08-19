/**
 * Observable effects the runtime emits, as runtime-owned contracts.
 *
 * These used to live in `fixtures.ts`, which made the production reducer's own
 * types derive from the test-oracle schema: `runtime.ts` read them back out as
 * `z.infer<typeof fixtureExpectedSchema>['executor_effects'][number]`. That is the
 * dependency backwards. The runtime defines what it emits; the fixture contract
 * composes those definitions to describe a recorded scenario.
 *
 * Keeping them here also keeps the fixture harness, the virtual clock, and the
 * scripted id factory out of the module graph a packaged desktop runtime loads.
 */

import { z } from 'zod'
import { jsonValueSchema } from './events.js'
import { delegateSchema } from './ports.js'

export const floorDecisionRecordSchema = z.object({
  event_seq: z.number().int().nonnegative(),
  priority: z.number().int(),
  decision: z.enum(['allow', 'preempt', 'defer']),
}).strict()

export const desktopEffectSchema = z.object({
  kind: z.string().min(1),
  data: z.record(z.string(), jsonValueSchema),
}).strict()

export const executorEffectSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('dispatch'), delegate: delegateSchema}).strict(),
  z.object({kind: z.literal('cancel'), delegate_id: z.string().min(1)}).strict(),
])

export const diagnosticSchema = z.object({
  code: z.string().min(1),
  message: z.string().optional(),
  details: z.record(z.string(), jsonValueSchema).optional(),
}).strict()

export const playbackGenerationSchema = z.object({
  session_epoch: z.number().int().positive(),
  generation_epoch: z.number().int().positive(),
  generation_id: z.string().min(1),
  utterance_id: z.string().min(1),
  response_id: z.string().min(1),
}).strict()

export const playbackCompletionSchema = z.object({
  session_epoch: z.number().int().positive(),
  response_id: z.string().min(1),
  utterance_id: z.string().min(1),
  generation_epoch: z.number().int().positive(),
  text: z.string(),
  disposition: z.enum(['spoken', 'interrupted', 'suppressed']),
  started: z.boolean(),
  played_ms: z.number().int().nonnegative().nullable(),
}).strict()

export const playbackEffectSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('open'), generation: playbackGenerationSchema}).strict(),
  z.object({
    kind: z.literal('ack'),
    ack: z.enum(['started', 'cleared', 'done']),
    utterance_id: z.string().min(1),
    generation_epoch: z.number().int().positive(),
    accepted: z.boolean(),
    completion: playbackCompletionSchema.nullable(),
  }).strict(),
])

export type FloorDecisionRecord = z.infer<typeof floorDecisionRecordSchema>
export type DesktopEffect = z.infer<typeof desktopEffectSchema>
export type ExecutorEffect = z.infer<typeof executorEffectSchema>
export type Diagnostic = z.infer<typeof diagnosticSchema>
export type PlaybackEffect = z.infer<typeof playbackEffectSchema>
