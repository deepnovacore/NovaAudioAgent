import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { proactivityPresetSchema } from './config.js'
import {
  eventRecordSchema,
  jsonValueSchema,
  outcomeSchema,
  trustSchema,
} from './events.js'
import { memoryItemSchema, memoryRefSchema, structuredStateSchema } from './memory.js'
import {
  delegateSchema,
} from './ports.js'
import {
  desktopEffectSchema,
  diagnosticSchema,
  executorEffectSchema,
  floorDecisionRecordSchema,
  playbackEffectSchema,
} from './effects.js'

export const fixtureManifestSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  description: z.string().min(1),
  covers: z.array(z.string().min(1)).min(1),
  clock: z.literal('virtual'),
  requires: z.array(z.string()),
  canonicalization: z.literal('exact'),
}).strict()

const idSequenceSchema = z.record(z.string(), z.array(z.string().min(1)))
const configurationSchema = z.object({
  proactivity_preset: proactivityPresetSchema,
  enabled_executors: z.array(z.string()),
}).strict().superRefine((configuration, context) => {
  if (new Set(configuration.enabled_executors).size !== configuration.enabled_executors.length) {
    context.addIssue({
      code: 'custom',
      message: 'enabled_executors must be unique',
      path: ['enabled_executors'],
    })
  }
})

export const scriptedPortCompletionSchema = z.object({
  delay: z.number().finite().nonnegative().default(0),
  output: z.unknown(),
}).strict()

export const fixtureStimulusSchema = z.discriminatedUnion('kind', [
  z.object({
    at: z.number().finite(),
    kind: z.literal('playback_open'),
    session_epoch: z.number().int().positive(),
    response_id: z.string().min(1),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('playback_audio'),
    session_epoch: z.number().int().positive(),
    response_id: z.string().min(1),
    pcm_base64: z.string().min(1),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('playback_transcript'),
    session_epoch: z.number().int().positive(),
    response_id: z.string().min(1),
    text: z.string(),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('playback_terminal'),
    session_epoch: z.number().int().positive(),
    response_id: z.string().min(1),
    disposition: z.enum(['spoken', 'interrupted']).default('spoken'),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('playback_start'),
    utterance_id: z.string().min(1),
    generation_epoch: z.number().int().positive(),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('playback_fence_current'),
    alert: z.boolean().default(false),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('playback_cleared'),
    utterance_id: z.string().min(1),
    generation_epoch: z.number().int().positive(),
    played_ms: z.number().int().nonnegative().nullable(),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('playback_done'),
    utterance_id: z.string().min(1),
    generation_epoch: z.number().int().positive(),
    played_ms: z.number().int().nonnegative().nullable().default(null),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('floor_user_start'),
    speech_id: z.string().min(1),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('floor_user_end'),
    speech_id: z.string().min(1),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('floor_agent_start'),
    utterance_id: z.string().min(1),
    priority: z.number().int(),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('floor_agent_end'),
    utterance_id: z.string().min(1),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('user_input'),
    text: z.string(),
    media_refs: z.array(z.string()).optional(),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('executor_complete'),
    dispatch_index: z.number().int().nonnegative(),
    outcome: outcomeSchema,
    trust: trustSchema,
    content: z.record(z.string(), jsonValueSchema),
    refs: z.array(z.string()).default([]),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('executor_progress'),
    dispatch_index: z.number().int().nonnegative(),
    phase: z.enum(['started', 'working']),
    internal_activity: z.number().int().nonnegative(),
    elapsed: z.number().finite().nonnegative(),
    summary: z.string().nullable(),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('executor_observation'),
    dispatch_index: z.number().int().nonnegative(),
    trust: trustSchema,
    content: z.record(z.string(), jsonValueSchema),
    refs: z.array(z.string()).default([]),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('raw_progress'),
    channel: z.string(),
    delegate_id: z.string(),
    op: z.string(),
    phase: z.enum(['started', 'working']),
    internal_activity: z.number().int().nonnegative(),
    elapsed: z.number().finite().nonnegative(),
    summary: z.string().nullable(),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('raw_observation'),
    channel: z.string(),
    delegate_id: z.string(),
    op: z.string(),
    origin_ref: z.string(),
    trust: trustSchema,
    content: z.record(z.string(), jsonValueSchema),
    refs: z.array(z.string()).default([]),
  }).strict(),
  z.object({
    at: z.number().finite(),
    kind: z.literal('advance_clock'),
    to: z.number().finite(),
  }).strict(),
])

export const fixtureInputSchema = z.object({
  schema_version: z.literal(1),
  initial_clock: z.number().finite(),
  id_sequences: idSequenceSchema,
  configuration: configurationSchema,
  stimuli: z.array(fixtureStimulusSchema),
  ports: z.object({
    fastbrain: z.array(scriptedPortCompletionSchema),
    surrogate: z.array(scriptedPortCompletionSchema),
    compressor: z.array(scriptedPortCompletionSchema),
    executors: z.record(z.string(), z.array(scriptedPortCompletionSchema)).optional(),
  }).strict(),
}).strict().superRefine((input, context) => {
  let current = input.initial_clock
  for (const [index, stimulus] of input.stimuli.entries()) {
    if (stimulus.at < current) {
      context.addIssue({
        code: 'custom',
        message: 'stimulus timeline moves backwards or crosses an earlier clock advance',
        path: ['stimuli', index, 'at'],
      })
      continue
    }
    current = stimulus.at
    if (stimulus.kind !== 'advance_clock') continue
    if (stimulus.to <= current) {
      context.addIssue({
        code: 'custom',
        message: 'clock advance must strictly advance',
        path: ['stimuli', index, 'to'],
      })
      continue
    }
    current = stimulus.to
  }

  const plans = new Map<number, {readonly index: number; readonly kind: string}[]>()
  for (const [index, stimulus] of input.stimuli.entries()) {
    if (!stimulus.kind.startsWith('executor_') || !('dispatch_index' in stimulus)) continue
    const plan = plans.get(stimulus.dispatch_index) ?? []
    plan.push({index, kind: stimulus.kind})
    plans.set(stimulus.dispatch_index, plan)
  }
  for (const [dispatchIndex, plan] of plans) {
    if (dispatchIndex >= (input.id_sequences.delegate ?? []).length) {
      context.addIssue({
        code: 'custom',
        message: `dispatch ${dispatchIndex} has no scripted delegate`,
        path: ['stimuli', plan[0]!.index, 'dispatch_index'],
      })
    }
    const completions = plan.filter(item => item.kind === 'executor_complete')
    if (completions.length > 1) {
      context.addIssue({
        code: 'custom',
        message: `dispatch ${dispatchIndex} has multiple completions`,
        path: ['stimuli', completions[1]!.index],
      })
    }
    const completion = completions[0]
    if (completion !== undefined && completion.index !== plan.at(-1)?.index) {
      context.addIssue({
        code: 'custom',
        message: `dispatch ${dispatchIndex} has stimuli after completion`,
        path: ['stimuli', completion.index],
      })
    }
  }
})

export const fixtureSuggestionSchema = z.object({
  id: z.string().min(1),
  origin: z.enum(['fast_brain', 'surrogate', 'executor']),
  kind: z.enum(['question', 'notify', 'followup']),
  content: z.record(z.string(), jsonValueSchema),
  evidence_refs: z.array(z.string()),
  salience: z.number().finite(),
  cooldown_until: z.number().finite(),
  expires_at: z.number().finite().nullable(),
  status: z.enum(['pending', 'fired', 'withdrawn', 'expired']),
}).strict()

export const fixtureModelViewSchema = z.object({
  slot: z.enum(['fast', 'surrogate.watch']),
  view: z.record(z.string(), jsonValueSchema),
}).strict()

/** Portable oracle snapshots use only canonical channel/sequence references. */
const fixtureMemoryItemSchema = memoryItemSchema.extend({
  refs: z.array(memoryRefSchema).default([]),
})

export const fixtureExpectedSchema = z.object({
  schema_version: z.literal(1),
  model_views: z.array(fixtureModelViewSchema),
  applied_events: z.array(eventRecordSchema),
  memory: z.object({
    channels: z.record(z.string(), z.array(fixtureMemoryItemSchema)),
    structured: structuredStateSchema,
    summaries: z.record(z.string(), z.string().nullable()),
  }).strict(),
  delegates: z.array(delegateSchema),
  suggestions: z.array(fixtureSuggestionSchema),
  floor_decisions: z.array(floorDecisionRecordSchema),
  outbound_desktop: z.array(desktopEffectSchema),
  executor_effects: z.array(executorEffectSchema),
  playback_effects: z.array(playbackEffectSchema).optional(),
  diagnostics: z.array(diagnosticSchema),
}).strict()

export const runtimeFixtureSchema = z.object({
  manifest: fixtureManifestSchema,
  input: fixtureInputSchema,
  expected: fixtureExpectedSchema,
}).strict()

export type FixtureManifest = z.infer<typeof fixtureManifestSchema>
export type FixtureInput = z.infer<typeof fixtureInputSchema>
export type FixtureExpected = z.infer<typeof fixtureExpectedSchema>
export type ScriptedPortCompletion = z.infer<typeof scriptedPortCompletionSchema>

export interface RuntimeFixture {
  readonly manifest: FixtureManifest
  readonly input: FixtureInput
  readonly expected: FixtureExpected
}

export function runtimeFixtureJsonSchema(): z.core.JSONSchema.JSONSchema {
  return z.toJSONSchema(runtimeFixtureSchema)
}

export async function loadRuntimeFixture(directory: string): Promise<RuntimeFixture> {
  const [manifest, input, expected] = await Promise.all([
    readJson(join(directory, 'manifest.json')),
    readJson(join(directory, 'input.json')),
    readJson(join(directory, 'expected.json')),
  ])
  const parsedManifest = fixtureManifestSchema.parse(manifest)
  if (parsedManifest.id !== basename(directory)) {
    throw new Error('fixture manifest id must match its directory')
  }
  return {
    manifest: parsedManifest,
    input: fixtureInputSchema.parse(input),
    expected: fixtureExpectedSchema.parse(expected),
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
