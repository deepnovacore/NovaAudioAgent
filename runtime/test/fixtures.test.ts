import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  fixtureInputSchema,
  fixtureManifestSchema,
  loadRuntimeFixture,
  runtimeFixtureJsonSchema,
} from '../src/fixtures.js'
import { handoffPolicySchema } from '../src/memory.js'
import { executorManifestSchema } from '../src/ports.js'
import { runRuntimeFixture } from '../src/runtime.js'
import { canonicalJson } from '../src/trace.js'

const fixtureParent = resolve(
  import.meta.dirname,
  '../../../fixtures/runtime/v1',
)
const fixtureRoot = resolve(fixtureParent, 'deadline-handoff-wins')
const redactionFixtureRoot = resolve(fixtureParent, 'deadline-sensitive-redaction')
const malformedFixtureRoot = resolve(fixtureParent, 'malformed-fastbrain-output')
const staleFixtureRoot = resolve(fixtureParent, 'stale-model-action')
const progressFixtureRoot = resolve(fixtureParent, 'progress-surrogate-selection')
const structuredFixtureRoot = resolve(fixtureParent, 'structured-update-model-view')

test('every version-one fixture directory validates', async () => {
  const entries = await readdir(fixtureParent, {withFileTypes: true})
  const directories = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  assert.ok(directories.length > 0)

  await Promise.all(directories.map(async directory => {
    await loadRuntimeFixture(resolve(fixtureParent, directory))
  }))
})

const slowManifest = executorManifestSchema.parse({
  name: 'slow_sim',
  policy: handoffPolicySchema.parse({
    channel: 'slow_sim',
    priority: 50,
    wake: 'fast',
    typical_latency: 5,
    compress_watermark: 8,
    progress_via_surrogate: true,
  }),
  ops: [{
    name: 'set_light',
    description: 'set light brightness',
    params: {},
    deadline_budget: 5,
  }, {
    name: 'set_credential',
    description: 'exercise sensitive parameter handling',
    params: {
      type: 'object',
      properties: {
        mode: {type: 'string'},
        token: {type: 'string'},
      },
      required: ['mode', 'token'],
    },
    sensitive_params: ['token'],
    deadline_budget: 5,
  }],
})

test('every fixture runs host stimuli through binding, reducer, and full snapshot', async () => {
  const entries = await readdir(fixtureParent, {withFileTypes: true})
  const directories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()

  for (const directory of directories) {
    const fixture = await loadRuntimeFixture(resolve(fixtureParent, directory))
    const actual = runRuntimeFixture(fixture, [slowManifest])
    assert.equal(canonicalJson(actual), canonicalJson(fixture.expected), fixture.manifest.id)
  }

  const exactDeadline = await loadRuntimeFixture(fixtureRoot)
  const actual = runRuntimeFixture(exactDeadline, [slowManifest])
  assert.deepEqual(actual.applied_events.map(event => event.kind), [
    'user_input', 'model_done', 'handoff', 'model_done', 'deadline',
  ])
  assert.equal(actual.memory.channels.slow_sim?.[0]?.outcome, 'ok')
})

test('fixture loader rejects an unknown schema version', async () => {
  const fixture = await loadRuntimeFixture(fixtureRoot)
  assert.throws(() => fixtureManifestSchema.parse({
    ...fixture.manifest,
    schema_version: 2,
  }))
})

test('fixture validation rejects backwards and clock-crossing timelines', async () => {
  const fixture = await loadRuntimeFixture(fixtureRoot)
  assert.throws(() => fixtureInputSchema.parse({
    ...fixture.input,
    initial_clock: 1,
    stimuli: [{at: 0, kind: 'user_input', text: 'too early'}],
  }), /timeline moves backwards/u)
  assert.throws(() => fixtureInputSchema.parse({
    ...fixture.input,
    stimuli: [
      {at: 0, kind: 'advance_clock', to: 5},
      {at: 1, kind: 'user_input', text: 'crossed'},
    ],
  }), /crosses an earlier clock advance/u)
  assert.throws(() => fixtureInputSchema.parse({
    ...fixture.input,
    stimuli: [{at: 0, kind: 'advance_clock', to: 0}],
  }), /must strictly advance/u)
})

test('fixture validation rejects duplicate executors and invalid completion plans', async () => {
  const fixture = await loadRuntimeFixture(fixtureRoot)
  assert.throws(() => fixtureInputSchema.parse({
    ...fixture.input,
    configuration: {
      ...fixture.input.configuration,
      enabled_executors: ['slow_sim', 'slow_sim'],
    },
  }), /enabled_executors must be unique/u)
  const completion = fixture.input.stimuli.find(stimulus => stimulus.kind === 'executor_complete')
  assert.ok(completion !== undefined)
  assert.throws(() => fixtureInputSchema.parse({
    ...fixture.input,
    stimuli: [...fixture.input.stimuli, {...completion, at: completion.at + 1}],
  }), /multiple completions/u)
  assert.throws(() => fixtureInputSchema.parse({
    ...fixture.input,
    stimuli: [
      ...fixture.input.stimuli,
      {
        at: completion.at + 1,
        kind: 'executor_progress',
        dispatch_index: completion.dispatch_index,
        phase: 'working',
        internal_activity: 1,
        elapsed: 1,
        summary: 'too late',
      },
    ],
  }), /stimuli after completion/u)
  assert.throws(() => fixtureInputSchema.parse({
    ...fixture.input,
    id_sequences: {...fixture.input.id_sequences, delegate: []},
    stimuli: [{
      at: 0,
      kind: 'executor_complete',
      dispatch_index: 0,
      outcome: 'ok',
      trust: 'trusted_system',
      content: {},
      refs: [],
    }],
  }), /has no scripted delegate/u)
})

test('a same-time user stimulus is sequenced before an older model completion', async () => {
  const fixture = await loadRuntimeFixture(staleFixtureRoot)
  const actual = runRuntimeFixture(fixture, [slowManifest])
  assert.deepEqual(actual.applied_events
    .filter(event => event.kind === 'user_input' || event.kind === 'model_done')
    .slice(0, 3)
    .map(event => ({seq: event.seq, ts: event.ts, kind: event.kind})), [
    {seq: 1, ts: 0, kind: 'user_input'},
    {seq: 2, ts: 1, kind: 'user_input'},
    {seq: 5, ts: 1, kind: 'model_done'},
  ])
  assert.equal(actual.executor_effects.length, 0)
})

test('fixture proactivity preset controls suggestion cooldown', async () => {
  const fixture = await loadRuntimeFixture(progressFixtureRoot)
  const eagerInput = fixtureInputSchema.parse({
    ...fixture.input,
    configuration: {...fixture.input.configuration, proactivity_preset: 'eager'},
  })
  const actual = runRuntimeFixture({...fixture, input: eagerInput}, [slowManifest])

  assert.equal(actual.suggestions[0]?.status, 'fired')
  assert.equal(actual.suggestions[0]?.cooldown_until, 31)
})

test('deadline evidence redacts sensitive request fields from durable outputs', async () => {
  const fixture = await loadRuntimeFixture(redactionFixtureRoot)
  const actual = runRuntimeFixture(fixture, [slowManifest])
  const durableOutput = canonicalJson({
    applied_events: actual.applied_events,
    memory: actual.memory,
    diagnostics: actual.diagnostics,
  })

  assert.doesNotMatch(durableOutput, /fixture-secret-sentinel/u)
  assert.match(durableOutput, /\[REDACTED\]/u)
})

test('malformed model raw output never enters the runtime snapshot', async () => {
  const fixture = await loadRuntimeFixture(malformedFixtureRoot)
  const actual = runRuntimeFixture(fixture, [slowManifest])
  const durableOutput = canonicalJson(actual)

  assert.doesNotMatch(durableOutput, /fixture-private-model-output-sentinel/u)
  assert.match(durableOutput, /model_contract_failure/u)
})

test('Python-exported model views expose structured update parity to the next call', async () => {
  const fixture = await loadRuntimeFixture(structuredFixtureRoot)
  const actual = runRuntimeFixture(fixture, [slowManifest])

  assert.equal(canonicalJson(actual), canonicalJson(fixture.expected))
  assert.equal(actual.model_views.length, 2)
  const second = actual.model_views[1]?.view
  assert.equal(second?.structured !== null && typeof second?.structured === 'object'
    && !Array.isArray(second.structured)
    && second.structured.intent !== null
    && typeof second.structured.intent === 'object'
    && !Array.isArray(second.structured.intent)
    ? second.structured.intent.revision
    : undefined, 1)
  assert.deepEqual(actual.memory.structured.intent, {
    objective_hypothesis: 'keep the room quiet and dim',
    constraints: ['do not speak loudly'],
    unresolved_questions: [],
    uncertainty: 0.25,
    revision: 1,
  })
  assert.deepEqual(actual.memory.channels.conversation?.at(-1)?.content, {
    error: 'update_rejected',
    target: 'intent',
    reason: 'unknown_fields',
    unknown: ['revision'],
  })
})

test('fixture contracts can be emitted as JSON Schema', () => {
  const schema = runtimeFixtureJsonSchema()
  assert.equal(schema.type, 'object')
  assert.ok('$defs' in schema || 'properties' in schema)
  assert.match(JSON.stringify(schema), /\^\.\+:\[0-9\]\+\$/u)
})

test('the committed fixture schema has no drift from the Zod contract', () => {
  const path = resolve(fixtureParent, 'schema.json')
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), runtimeFixtureJsonSchema())
})
