/**
 * The differential-fixture contract for the realtime session.
 *
 * The runtime fixtures in `fixtures/runtime/v1` drive the whole reducer from host stimuli. These
 * drive one layer lower: a scripted sequence of normalized provider events and host actions goes
 * into a real `RealtimeSession`, and the golden records what came out -- the session's own verdict
 * on each event, the calls it made on the provider, the playback effects it produced, and the
 * state a caller can observe afterwards.
 *
 * That scope is deliberate. `accept` is a reducer whose guards read a dozen fields, and several of
 * them differ only in the boolean they return. Driving the session directly is the only way to
 * tell those apart; going through the provider session would not even reach the epoch guard,
 * because that layer already drops events whose epoch does not match.
 *
 * Python exports every golden here (`scripts/realtime_session_oracle.py export`) and both
 * runtimes then check the same committed bytes.
 */

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { delegateStateSchema, providerTurnPhaseSchema } from './session-state.js'

/**
 * Note on optionality: nothing here has a Zod default.
 *
 * `z.toJSONSchema` renders a defaulted field as still-required, so a fixture that omitted one
 * would satisfy the Node parse and fail the Python schema check. Every field is spelled out in
 * every fixture instead, which also means neither runtime has a default the other could disagree
 * about.
 */
const identifier = z.string().min(1)
const epoch = z.number().int().positive()
const generationEpoch = z.number().int().nonnegative()

/**
 * PCM carried as base64, in both halves of a fixture.
 *
 * The same encoding on the way in and on the way out means a scenario's audio can be read
 * against the frames it produced without decoding one side by hand.
 */
const pcmBase64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'pcm must be base64')

/**
 * Synthetic PCM: one repeated byte.
 *
 * The pre-map audio budget is 64 KiB, so proving it takes more literal audio than belongs in a
 * committed fixture. A scenario using this declares `pcm_fixture` in its manifest `requires`.
 */
const pcmFill = z.object({
  byte: z.number().int().min(0).max(255),
  length: z.number().int().positive(),
}).strict()

const pcmSchema = z.union([
  z.object({pcm_base64: pcmBase64}).strict(),
  z.object({pcm_fill: pcmFill}).strict(),
])

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

export const sessionFixtureManifestSchema = z.object({
  schema_version: z.literal(1),
  id: identifier,
  description: z.string().min(1),
  covers: z.array(identifier).min(1),
  clock: z.literal('virtual'),
  requires: z.array(z.enum(['pcm_fixture'])),
  canonicalization: z.literal('exact'),
  /**
   * Whether the Node leg checks this scenario's golden yet.
   *
   * The fixtures land before the ported reducer that has to satisfy them, so for a while the
   * Python leg is the only one checking. Saying so in the manifest keeps a green Node build from
   * reading as parity that does not exist yet.
   */
  node_parity: z.enum(['checked', 'pending-session-port']),
}).strict()

// ---------------------------------------------------------------------------
// input: normalized provider events
// ---------------------------------------------------------------------------

const providerEventBase = {session_epoch: epoch}

/** Host-only structured decision payload; transcript text is never part of this authority. */
export const fixtureProjectConfirmationDecisionArgumentsSchema = z.object({
  proposal_id: z.string().min(1).max(128),
  confirmed: z.boolean(),
}).strict()

export const fixtureProviderEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...providerEventBase,
    kind: z.literal('user_speech_started'),
    speech_id: identifier,
    provider_item_id: identifier.nullable(),
  }).strict(),
  z.object({
    ...providerEventBase,
    kind: z.literal('user_speech_ended'),
    speech_id: identifier,
    provider_item_id: identifier.nullable(),
  }).strict(),
  z.object({
    ...providerEventBase,
    kind: z.literal('user_transcript_delta'),
    item_id: identifier,
    text: z.string(),
  }).strict(),
  z.object({
    ...providerEventBase,
    kind: z.literal('user_transcript_final'),
    item_id: identifier,
    text: z.string(),
  }).strict(),
  z.object({
    ...providerEventBase,
    kind: z.literal('user_transcript_failed'),
    item_id: identifier,
  }).strict(),
  z.object({
    ...providerEventBase,
    kind: z.literal('response_started'),
    response_id: identifier,
  }).strict(),
  z.object({
    ...providerEventBase,
    kind: z.literal('response_audio_delta'),
    response_id: identifier,
    pcm: pcmSchema,
  }).strict(),
  z.object({
    ...providerEventBase,
    kind: z.literal('response_transcript_delta'),
    response_id: identifier,
    text: z.string(),
  }).strict(),
  z.object({
    ...providerEventBase,
    kind: z.literal('response_transcript_final'),
    response_id: identifier,
    text: z.string(),
  }).strict(),
  z.object({
    ...providerEventBase,
    kind: z.literal('tool_call_ready'),
    call_id: identifier,
    item_id: identifier,
    name: identifier,
    arguments: z.record(z.string(), z.unknown()),
    response_id: identifier.nullable(),
  }).strict(),
  z.object({
    ...providerEventBase,
    kind: z.literal('item_confirmed'),
    host_item_id: identifier,
    provider_item_id: identifier,
  }).strict(),
  z.object({
    ...providerEventBase,
    kind: z.literal('response_terminal'),
    response_id: identifier,
    status: z.enum(['completed', 'cancelled', 'failed']),
    reason: z.string(),
  }).strict(),
  z.object({
    ...providerEventBase,
    kind: z.literal('response_cancel_rejected'),
    response_id: identifier,
    cancel_request_id: identifier,
    reason: z.literal('no_active_response'),
  }).strict(),
  z.object({
    ...providerEventBase,
    kind: z.literal('provider_error'),
    code: identifier,
    recoverable: z.boolean(),
  }).strict(),
])

// ---------------------------------------------------------------------------
// input: host items and response intents
// ---------------------------------------------------------------------------

export const fixtureHostItemSchema = z.object({
  kind: z.enum(['progress', 'final', 'recovery', 'dialogue_context', 'tool_output']),
  host_item_id: identifier,
  event_id: identifier,
  content: z.string().min(1),
  call_id: identifier.nullable(),
}).strict()

export const fixtureHostIntentSchema = z.object({
  kind: z.enum(['host_fact', 'tool_result', 'delegation_acknowledgement']),
  item: fixtureHostItemSchema,
  task_summary: z.string().min(1).nullable(),
  origin_spoken: z.boolean(),
}).strict()

/**
 * One recovered conversation turn, in the only two shapes `RecoveryTurn` accepts.
 *
 * A user turn is a final transcript from a trusted user and never carries a played duration; an
 * assistant turn was spoken by a trusted system and may. Encoding that as a union on `role` rather
 * than as free fields means a malformed recovery turn cannot be written into a fixture at all,
 * instead of being rejected only once Python constructs it.
 */
const recoveryTurnSchema = z.discriminatedUnion('role', [
  z.object({
    sequence: z.number().int().positive(),
    role: z.literal('user'),
    text: z.string().min(1),
    delivery: z.literal('user_final'),
    played_ms: z.null(),
    trust: z.literal('trusted_user'),
    source: z.literal('conversation'),
  }).strict(),
  z.object({
    sequence: z.number().int().positive(),
    role: z.literal('assistant'),
    text: z.string().min(1),
    delivery: z.literal('spoken'),
    played_ms: z.number().int().nonnegative().nullable(),
    trust: z.literal('trusted_system'),
    source: z.literal('conversation'),
  }).strict(),
])

// ---------------------------------------------------------------------------
// input: steps
// ---------------------------------------------------------------------------

export const sessionFixtureStepSchema = z.discriminatedUnion('kind', [
  /** Open a provider session. `tools` is only a count; the session forwards them opaquely. */
  z.object({kind: z.literal('connect'), tools: z.number().int().nonnegative()}).strict(),
  z.object({kind: z.literal('reconnect'), tools: z.number().int().nonnegative()}).strict(),
  /** Feed one normalized event straight to `accept`. */
  z.object({kind: z.literal('provider_event'), event: fixtureProviderEventSchema}).strict(),
  /**
   * Project one event into the caption side channel.
   *
   * Captions are a separate projection, not part of `accept`, so a scenario asks for them
   * explicitly. `accepted` carries the session's verdict for the events whose authorization
   * lives in `accept` rather than in per-response tracking.
   */
  z.object({
    kind: z.literal('caption_for'),
    event: fixtureProviderEventSchema,
    accepted: z.boolean().nullable(),
  }).strict(),
  z.object({kind: z.literal('deliver_host_item'), item: fixtureHostItemSchema}).strict(),
  z.object({
    kind: z.literal('deliver_host_response'),
    intent: fixtureHostIntentSchema,
    as_user_activation: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal('deliver_preemptive_host_response'),
    intent: fixtureHostIntentSchema,
    confirmation_timeout: z.number().finite().positive().nullable(),
    as_user_activation: z.boolean(),
  }).strict(),
  z.object({kind: z.literal('inject_tool_output'), item: fixtureHostItemSchema}).strict(),
  z.object({
    kind: z.literal('request_tool_continuation'),
    intents: z.array(fixtureHostIntentSchema).min(1),
    origin_spoken: z.boolean(),
  }).strict(),
  z.object({kind: z.literal('arm_next_response_fence')}).strict(),
  z.object({kind: z.literal('local_speech_onset'), speech_id: identifier}).strict(),
  z.object({kind: z.literal('host_preempt')}).strict(),
  z.object({
    kind: z.literal('playback_started'),
    utterance_id: identifier,
    generation_epoch: generationEpoch,
  }).strict(),
  z.object({
    kind: z.literal('playback_done'),
    utterance_id: identifier,
    generation_epoch: generationEpoch,
    played_ms: z.number().int().nonnegative().nullable(),
  }).strict(),
  z.object({
    kind: z.literal('complete_playback'),
    utterance_id: identifier,
    generation_epoch: generationEpoch,
    played_ms: z.number().int().nonnegative().nullable(),
  }).strict(),
  z.object({
    kind: z.literal('playback_cleared'),
    utterance_id: identifier,
    generation_epoch: generationEpoch,
    played_ms: z.number().int().nonnegative().nullable(),
  }).strict(),
  z.object({
    kind: z.literal('playback_stopped'),
    utterance_id: identifier,
    generation_epoch: generationEpoch,
    played_ms: z.number().int().nonnegative().nullable(),
  }).strict(),
  z.object({kind: z.literal('reset_captions')}).strict(),
  /**
   * Move the virtual clock forward.
   *
   * Only the user-hold deadline reads the clock, so most scenarios never need this. Time cannot
   * move backwards, which both clocks enforce.
   */
  z.object({kind: z.literal('advance_clock'), to: z.number().finite().positive()}).strict(),
  /**
   * Ask whether a user floor hold has outlived its deadline, releasing it if so.
   *
   * This is the only read path for the hold timestamp, and production calls it at every host-item
   * delivery attempt. Without a step for it, a port could set or clear that timestamp wrongly and
   * still match every golden.
   */
  z.object({
    kind: z.literal('release_stale_user_hold'),
    max_hold_s: z.number().finite().positive(),
  }).strict(),
  /**
   * Replace provider authority while retaining one exact renderer generation.
   *
   * `old_generation` names the generation to keep; `"current"` is the one the session holds, which
   * is what a Guard handoff always passes. The return value distinguishes five recovery outcomes,
   * so a scenario pins which one a given history produced.
   */
  z.object({
    kind: z.literal('reconnect_for_guard'),
    tools: z.number().int().nonnegative(),
    old_generation: z.literal('current'),
    confirmation_timeout: z.number().finite().positive().nullable(),
    history: z.array(recoveryTurnSchema),
    history_mode: z.enum(['none', 'packed']),
  }).strict(),
])

export const sessionFixtureInputSchema = z.object({
  schema_version: z.literal(1),
  /**
   * Every host-allocated id the run may consume, in order.
   *
   * The session and the playback registry draw from one sequence, as they do in production, so
   * the interleaving is part of the contract. A run that leaves an id unconsumed, or asks for one
   * past the end, fails: both mean the two runtimes disagree about how much they allocate.
   */
  ids: z.array(identifier),
  steps: z.array(sessionFixtureStepSchema).min(1),
}).strict()

// ---------------------------------------------------------------------------
// expected: one observation per step
// ---------------------------------------------------------------------------

const generationRecordSchema = z.object({
  session_epoch: epoch,
  generation_epoch: generationEpoch,
  generation_id: identifier,
  utterance_id: identifier,
  response_id: identifier,
}).strict()

const frameRecordSchema = z.object({
  utterance_id: identifier,
  generation_epoch: generationEpoch,
  sequence: z.number().int().nonnegative(),
  pcm_base64: pcmBase64,
}).strict()

const completionRecordSchema = z.object({
  session_epoch: epoch,
  response_id: identifier,
  utterance_id: identifier,
  generation_epoch: generationEpoch,
  text: z.string(),
  disposition: z.enum(['spoken', 'interrupted', 'suppressed']),
  started: z.boolean(),
  played_ms: z.number().int().nonnegative().nullable(),
}).strict()

const captionRecordSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  final: z.boolean(),
}).strict()

const deliveryRecordSchema = z.object({
  accepted: z.boolean(),
  injection_epoch: z.number().int().positive().nullable(),
}).strict()

const delegateRecordSchema = z.object({
  summary: z.string().min(1),
  state: delegateStateSchema,
  channel: z.string().min(1),
  progress_summary: z.string().nullable(),
  internal_activity: z.number().int().nonnegative(),
  elapsed: z.number().finite().nonnegative(),
}).strict()

const responseStateSchema = z.object({
  phase: providerTurnPhaseSchema.nullable(),
  was_fenced: z.boolean(),
  user_input_revision: z.number().int().nonnegative().nullable(),
  has_spoken: z.boolean(),
  event_ids: z.array(identifier),
}).strict()

const snapshotRecordSchema = z.object({
  version: z.number().int().nonnegative(),
  active_delegates: z.array(z.tuple([identifier, delegateRecordSchema])),
  spoken_event_ids: z.array(identifier),
  interrupted_event_ids: z.array(identifier),
}).strict()

const observedStateSchema = z.object({
  /** The virtual clock. A hold deadline is relative to it, so it belongs in the golden. */
  clock: z.number().finite().nonnegative(),
  session_epoch: z.number().int().nonnegative(),
  user_input_revision: z.number().int().nonnegative(),
  active_provider_response_id: identifier.nullable(),
  provider_idle: z.boolean(),
  foreground_idle: z.boolean(),
  current_generation: generationRecordSchema.nullable(),
  floor_state: z.enum(['idle', 'user_speaking', 'agent_speaking']),
  user_caption: z.string(),
  assistant_caption: z.string(),
  /** Keyed by every response id the scenario mentions, so an absent turn is still reported. */
  responses: z.record(z.string(), responseStateSchema),
  /** Every event id the scenario mentions that the session considers already answered. */
  host_events_deduplicated: z.array(identifier),
  snapshot: snapshotRecordSchema,
}).strict()

/** What a step returned. Heterogeneous because the session's own return types are. */
const stepResultSchema = z.union([
  z.null(),
  z.boolean(),
  z.enum(['requested', 'retryable', 'rejected']),
  z.enum(['none', 'empty', 'packed', 'degraded', 'uncertain']),
  deliveryRecordSchema,
  completionRecordSchema,
  captionRecordSchema,
])

export const sessionFixtureObservationSchema = z.object({
  step: z.number().int().nonnegative(),
  kind: identifier,
  result: stepResultSchema,
  /**
   * Calls the session made during this step, in order.
   *
   * Provider calls and renderer clears share one log, because their relative order is the
   * observable that matters: a cancel after a clear is a different session than a cancel before.
   */
  actions: z.array(z.string().min(1)),
  frames: z.array(frameRecordSchema),
  alerts: z.array(z.tuple([identifier.nullable(), generationEpoch.nullable()])),
  deliveries: z.array(completionRecordSchema),
  spoken: z.array(z.string()),
  /** Session diagnostics printed during this step, which for some guards is the only signal. */
  diagnostics: z.array(z.string().min(1)),
  fence_interruption: z.object({
    session_epoch: epoch,
    event_ids: z.array(identifier),
  }).strict().nullable(),
  state: observedStateSchema,
}).strict()

export const sessionFixtureExpectedSchema = z.object({
  schema_version: z.literal(1),
  observations: z.array(sessionFixtureObservationSchema).min(1),
}).strict()

export const sessionFixtureSchema = z.object({
  manifest: sessionFixtureManifestSchema,
  input: sessionFixtureInputSchema,
  expected: sessionFixtureExpectedSchema,
}).strict()

export type SessionFixtureManifest = z.infer<typeof sessionFixtureManifestSchema>
export type SessionFixtureInput = z.infer<typeof sessionFixtureInputSchema>
export type SessionFixtureExpected = z.infer<typeof sessionFixtureExpectedSchema>
export type SessionFixtureStep = z.infer<typeof sessionFixtureStepSchema>
export type FixtureProviderEvent = z.infer<typeof fixtureProviderEventSchema>

export interface SessionFixture {
  readonly manifest: SessionFixtureManifest
  readonly input: SessionFixtureInput
  readonly expected: SessionFixtureExpected
}

export function sessionFixtureJsonSchema(): z.core.JSONSchema.JSONSchema {
  return z.toJSONSchema(sessionFixtureSchema)
}

export async function loadSessionFixture(directory: string): Promise<SessionFixture> {
  const [manifest, input, expected] = await Promise.all([
    readJson(join(directory, 'manifest.json')),
    readJson(join(directory, 'input.json')),
    readJson(join(directory, 'expected.json')),
  ])
  const parsedManifest = sessionFixtureManifestSchema.parse(manifest)
  if (parsedManifest.id !== basename(directory)) {
    throw new Error('fixture manifest id must match its directory')
  }
  return {
    manifest: parsedManifest,
    input: sessionFixtureInputSchema.parse(input),
    expected: sessionFixtureExpectedSchema.parse(expected),
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
