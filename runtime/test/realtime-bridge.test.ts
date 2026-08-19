/**
 * The Node leg of the realtime bridge parity suite.
 *
 * The bridge is the only route by which a provider's tool calls and user transcripts reach the
 * reducer, so what it admits, refuses, and dispatches *is* the authorization boundary for
 * model-proposed work. The runtime underneath is a scripted double, matching the oracle: the point is
 * to pin the bridge's decisions, and a real runtime would make the fixture measure the reducer.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical-json.js'
import { VirtualClock } from '../src/clock.js'
import type { JsonValue } from '../src/events.js'
import { Memory } from '../src/memory.js'
import { executorManifestSchema, type ExecutorManifest, type UpdateSpec } from '../src/ports.js'
import type { DelegateRequest } from '../src/ports.js'
import { RealtimeRuntimeBridge, validParams, type BridgeRuntime } from '../src/realtime/bridge.js'
import type { WakeReason } from '../src/slots.js'
import { compileToolSchema } from '../src/tool-schema.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/realtime/bridge/v1')

/**
 * Fixed so the digest is reproducible across runs.
 *
 * Production uses a random per-process key; this is the one place a stable key is correct, because
 * the golden has to be byte-identical. Same bytes as the oracle's.
 */
const DIGEST_KEY = Buffer.from(Array.from({length: 32}, (_, index) => index))

interface Step {
  readonly kind: string
  readonly text?: string
  readonly call_id?: string
  readonly item_id?: string
  readonly name?: string
  readonly arguments?: Readonly<Record<string, JsonValue>>
  readonly response_id?: string | null
  readonly origin_ref?: string | null
  readonly session_epoch?: number
  readonly to?: number
}

interface Scenario {
  readonly name: string
  readonly covers: readonly string[]
  readonly manifests: readonly JsonValue[]
  readonly memory?: readonly {
    readonly channel: string
    readonly ts: number
    readonly trust: 'trusted_user' | 'trusted_system' | 'untrusted_external'
    readonly priority: number
    readonly content: Readonly<Record<string, JsonValue>>
  }[]
  readonly include_memory_recall?: boolean
  readonly runtime?: {
    readonly ingest_refs?: readonly string[]
    readonly update_results?: readonly boolean[]
    readonly dispatch_results?: readonly {
      readonly accepted: boolean
      readonly delegate_id?: string | null
    }[]
  }
  readonly ids?: readonly string[]
  readonly steps: readonly Step[]
  readonly allow_unconsumed?: boolean
}

const document = JSON.parse(readFileSync(resolve(fixtureRoot, 'scenarios.json'), 'utf8')) as {
  readonly scenarios: readonly Scenario[]
}
const golden = JSON.parse(
  readFileSync(resolve(fixtureRoot, 'scenarios-expected.json'), 'utf8'),
) as {readonly scenarios: readonly Record<string, unknown>[]}

/** Records every call so the golden pins what the bridge asked the runtime to do, not just what it returned. */
class ScriptedRuntime implements BridgeRuntime {
  readonly calls: Record<string, unknown>[] = []
  #ingest: string[]
  #updates: boolean[]
  #dispatches: {readonly accepted: boolean; readonly delegate_id?: string | null}[]

  constructor(
    readonly clock: VirtualClock,
    readonly memory: Memory,
    readonly executors: ReadonlyMap<string, {readonly manifest: ExecutorManifest}>,
    script: Scenario['runtime'],
  ) {
    this.#ingest = [...(script?.ingest_refs ?? [])]
    this.#updates = [...(script?.update_results ?? [])]
    this.#dispatches = [...(script?.dispatch_results ?? [])]
  }

  ingestUserInput(input: {readonly text: string}): Promise<string> {
    const reference = this.#ingest.shift()
    if (reference === undefined) throw new Error('ingest_refs exhausted')
    this.calls.push({call: 'ingest_user_input', text: input.text, ref: reference})
    return Promise.resolve(reference)
  }

  updateExternal(spec: UpdateSpec, reason: WakeReason): boolean {
    const accepted = this.#updates.shift()
    if (accepted === undefined) throw new Error('update_results exhausted')
    this.calls.push({
      call: 'update_external',
      target: spec.target,
      delta: {...spec.delta},
      routing_class: reason.routing_class,
      priority: reason.priority,
      accepted,
    })
    return accepted
  }

  dispatchExternal(
    request: DelegateRequest,
    reason: WakeReason,
  ): {readonly accepted: boolean; readonly delegate_id: string | null} {
    const scripted = this.#dispatches.shift()
    if (scripted === undefined) throw new Error('dispatch_results exhausted')
    this.calls.push({
      call: 'dispatch_external',
      executor: request.executor,
      op: request.op,
      request: {...request.request},
      origin_ref: request.origin_ref,
      routing_class: reason.routing_class,
      priority: reason.priority,
    })
    return {accepted: scripted.accepted, delegate_id: scripted.delegate_id ?? null}
  }

  unconsumed(): Record<string, number> {
    return {
      ingest_refs: this.#ingest.length,
      update_results: this.#updates.length,
      dispatch_results: this.#dispatches.length,
    }
  }
}

async function runScenario(scenario: Scenario): Promise<Record<string, unknown>> {
  const clock = new VirtualClock()
  const manifests = scenario.manifests.map(entry => executorManifestSchema.parse(entry))
  const memory = new Memory({policies: manifests.map(manifest => manifest.policy)})
  for (const item of scenario.memory ?? []) {
    memory.append(item.channel, {
      ts: item.ts,
      trust: item.trust,
      priority: item.priority,
      content: item.content,
    })
  }
  const executors = new Map(manifests.map(manifest => [manifest.name, {manifest}]))
  const runtime = new ScriptedRuntime(clock, memory, executors, scenario.runtime)
  const tools = compileToolSchema(manifests, {
    includeMemoryRecall: scenario.include_memory_recall ?? false,
  })
  const identifiers = [
    ...(scenario.ids ?? Array.from({length: 40}, (_, index) => `id-${index + 1}`)),
  ]
  let identifierIndex = 0
  const bridge = new RealtimeRuntimeBridge({
    runtime,
    tools,
    idFactory: () => {
      const value = identifiers[identifierIndex]
      if (value === undefined) throw new Error('id sequence exhausted')
      identifierIndex += 1
      return value
    },
    queryDigestKey: DIGEST_KEY,
  })

  const steps: Record<string, unknown>[] = []
  for (const [index, step] of scenario.steps.entries()) {
    const callMark = runtime.calls.length
    let result: unknown
    try {
      switch (step.kind) {
        case 'accept_user_transcript':
          result = await bridge.acceptUserTranscript(step.text!)
          break
        case 'accept_tool_call':
          result = bridge.acceptToolCall(
            {
              kind: 'tool_call_ready',
              session_epoch: step.session_epoch ?? 1,
              call_id: step.call_id!,
              item_id: step.item_id ?? 'item-1',
              name: step.name!,
              arguments: {...(step.arguments ?? {})},
              response_id: step.response_id ?? null,
            },
            {originRef: step.origin_ref ?? null},
          )
          break
        case 'advance_clock':
          clock.advanceTo(step.to!)
          result = null
          break
        default:
          throw new Error(`unsupported step kind: ${step.kind}`)
      }
    } catch (cause) {
      result = {error: (cause as Error).constructor.name, message: (cause as Error).message}
    }
    steps.push({
      step: index,
      kind: step.kind,
      result,
      runtime_calls: runtime.calls.slice(callMark),
    })
  }

  const unconsumed = runtime.unconsumed()
  if (Object.values(unconsumed).some(count => count > 0) && scenario.allow_unconsumed !== true) {
    throw new Error(`${scenario.name}: unconsumed runtime script ${JSON.stringify(unconsumed)}`)
  }
  return {name: scenario.name, steps}
}

test('every bridge scenario matches the Python-exported golden', async () => {
  const mismatched: string[] = []
  for (const [index, scenario] of document.scenarios.entries()) {
    const actual = await runScenario(scenario)
    if (canonicalJson(actual) !== canonicalJson(golden.scenarios[index])) {
      mismatched.push(scenario.name)
    }
  }
  assert.deepEqual(mismatched, [], 'bridge behavior differs from the oracle')
})

test('the golden records one result per scenario, in order', () => {
  assert.deepEqual(
    golden.scenarios.map(entry => entry.name),
    document.scenarios.map(scenario => scenario.name),
  )
})

test('every scenario declares what it covers', () => {
  for (const scenario of document.scenarios) {
    assert.ok(scenario.covers.length > 0, scenario.name)
    assert.ok(scenario.steps.length > 0, scenario.name)
  }
})

test('the scenario set reaches every acceptance code the bridge can produce', () => {
  // A set that only exercised the happy path would prove nothing: most of this module is refusal,
  // and each refusal code is a different thing the model is not allowed to do.
  const codes = new Set<string>()
  for (const scenario of golden.scenarios) {
    for (const step of scenario.steps as readonly {readonly result: unknown}[]) {
      const result = step.result
      if (typeof result === 'object' && result !== null && 'code' in result) {
        codes.add(String(result.code))
      }
    }
  }
  for (const expected of [
    'accepted',
    'completed',
    'ok',
    'unknown_tool',
    'invalid_params',
    'missing_origin_ref',
    'runtime_rejected',
  ]) {
    assert.ok(codes.has(expected), `no scenario produces ${expected}`)
  }
})

test('a refused call still carries a tool result the provider can render', () => {
  // A provider left without a result for a call it made stalls waiting for one, so a refusal has to
  // be shaped like an answer rather than like silence.
  for (const scenario of golden.scenarios) {
    for (const step of scenario.steps as readonly {readonly result: unknown}[]) {
      const result = step.result as {
        readonly accepted?: boolean
        readonly host_item?: {readonly kind: string; readonly call_id: string | null}
        readonly response_intent?: {readonly kind: string}
      }
      if (result?.accepted !== false) continue
      assert.equal(result.host_item?.kind, 'tool_output')
      assert.equal(result.response_intent?.kind, 'tool_result')
      assert.ok(result.host_item?.call_id, 'the result must name the call it answers')
    }
  }
})

test('an accepted delegation is always correlated with a delegate id', () => {
  // An acceptance with no id would be a promise nothing can be matched to when the work finishes.
  for (const scenario of golden.scenarios) {
    for (const step of scenario.steps as readonly {readonly result: unknown}[]) {
      const result = step.result as {
        readonly accepted?: boolean
        readonly code?: string
        readonly delegate_id?: string | null
      }
      if (result?.accepted !== true || result.code !== 'accepted') continue
      assert.ok(result.delegate_id, JSON.stringify(scenario.name))
    }
  }
})

test('the provider-supplied origin ref never reaches the executor', () => {
  // It is evidence for the admission decision, not a parameter of the work. Forwarding it would let
  // a model smuggle an arbitrary field into an executor request through a name the schema blesses.
  const scenario = golden.scenarios.find(
    entry => entry.name === 'the-provider-origin-ref-never-reaches-the-executor',
  )
  assert.ok(scenario, 'the scenario must exist')
  const calls = (scenario.steps as readonly {readonly runtime_calls: readonly Record<string, unknown>[]}[])
    .flatMap(step => step.runtime_calls)
    .filter(call => call.call === 'dispatch_external')
  assert.equal(calls.length, 1)
  const request = calls[0]!.request as Record<string, unknown>
  assert.equal('origin_ref' in request, false, 'origin_ref must be stripped from the request')
  assert.equal(calls[0]!.origin_ref, 'conversation:1', 'but it must still be the admission evidence')
})

test('an unrecognised schema type refuses rather than passes', () => {
  // Not reachable through a compiled schema -- the compiler only emits the six types above -- so it is
  // exercised directly. The direction matters: an unknown keyword must close the gate, because a
  // validator that passed what it did not understand would admit whatever a future schema described.
  assert.equal(
    validParams({field: 'x'}, {
      type: 'object',
      properties: {field: {type: 'sideways'}},
      additionalProperties: false,
    }),
    false,
  )
  // A property whose schema is not an object at all.
  assert.equal(
    validParams({field: 'x'}, {type: 'object', properties: {field: true}}),
    false,
  )
  // A schema that is not an object schema.
  assert.equal(validParams({}, {type: 'array'}), false)
  assert.equal(validParams({}, {type: 'object'}), false, 'properties is required')
  // A malformed `required`.
  assert.equal(
    validParams({}, {type: 'object', properties: {}, required: 'field'}),
    false,
  )
  assert.equal(
    validParams({}, {type: 'object', properties: {}, required: [7]}),
    false,
  )
})

test('an extra property is refused whether or not additionalProperties says so', () => {
  // The `additionalProperties: false` branch is redundant as this validator is written: a name absent
  // from `properties` has no schema, so the per-value check refuses it anyway. It is kept because the
  // oracle keeps it -- removing it would be a structural divergence for no behavioral gain -- and this
  // records that the two paths agree rather than leaving the redundancy to be rediscovered.
  const withFlag = {type: 'object', properties: {mode: {type: 'string'}}, additionalProperties: false}
  const withoutFlag = {type: 'object', properties: {mode: {type: 'string'}}}
  for (const schema of [withFlag, withoutFlag]) {
    assert.equal(validParams({mode: 'fast', surprise: 1}, schema), false)
  }
  assert.equal(validParams({mode: 'fast'}, withFlag), true)
})

test('minProperties is not among the keywords the bridge enforces', () => {
  // It appears in the published update schema, so a model reading the schema is told a delta cannot be
  // empty -- but the check that stops an empty one is the reducer's, not this validator's. Recorded
  // because the division of labour is the part that would be surprising later.
  assert.equal(
    validParams({}, {type: 'object', properties: {a: {type: 'string'}}, minProperties: 1}),
    true,
  )
})

test('a canonical tool-output body orders its keys, whatever order they were built in', () => {
  // As called, the refusal body's keys already happen to be in sorted order, so `JSON.stringify` and
  // `canonicalJson` agree and no scenario can tell them apart. The property still has to hold, so it
  // is asserted where it can be: on the encoder the bridge uses.
  assert.equal(canonicalJson({state: 'refused', code: 'unknown_tool'}), '{"code":"unknown_tool","state":"refused"}')
  assert.equal(JSON.stringify({state: 'refused', code: 'unknown_tool'}), '{"state":"refused","code":"unknown_tool"}')
})

test('a recall origin is required by the bridge and again by recall itself', () => {
  // Two guards, one outcome. Removing the bridge's pre-check changes nothing observable: an empty
  // reference makes `compileMemoryRecall` raise `RecallOriginError`, which becomes the same refusal
  // with the same absent telemetry. The pre-check earns its place only by not doing the work -- no
  // HMAC over the query, no clock read -- for a call that cannot succeed. Kept because the oracle
  // keeps it; a mutation sweep will report it as undetected, and that is correct.
  const clock = new VirtualClock()
  const manifests = [executorManifestSchema.parse(document.scenarios[0]!.manifests[0])]
  const memory = new Memory({policies: manifests.map(manifest => manifest.policy)})
  const runtime = new ScriptedRuntime(
    clock,
    memory,
    new Map(manifests.map(manifest => [manifest.name, {manifest}])),
    {},
  )
  const bridge = new RealtimeRuntimeBridge({
    runtime,
    tools: compileToolSchema(manifests, {includeMemoryRecall: true}),
    idFactory: () => 'id-1',
    queryDigestKey: DIGEST_KEY,
  })
  const refused = bridge.acceptToolCall({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'item-1',
    name: 'memory__recall',
    arguments: {query: 'compile', scope: 'recent'},
    response_id: null,
  })
  assert.equal(refused.code, 'missing_origin_ref')
  assert.equal(refused.telemetry, null, 'a call with no evidence leaves no telemetry')
  assert.equal(refused.inline_fulfilled, false)
})

test('a clock that moved backwards reports zero elapsed rather than a negative', () => {
  // Neither virtual clock can go backwards, so no fixture can reach this; a real clock adjusted under
  // the process can. The clamp exists so one such adjustment cannot poison an aggregate computed over
  // these durations, and it is asserted here because the fixtures cannot assert it.
  const readings = [5, 2]
  let index = 0
  const backwards = {
    now: (): number => {
      const value = readings[Math.min(index, readings.length - 1)]!
      index += 1
      return value
    },
  }
  const manifests = [executorManifestSchema.parse(document.scenarios[0]!.manifests[0])]
  const memory = new Memory({policies: manifests.map(manifest => manifest.policy)})
  memory.append('conversation', {
    ts: 1,
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'compile the runtime'},
  })
  memory.append('conversation', {
    ts: 2,
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'how did that go'},
  })
  const bridge = new RealtimeRuntimeBridge({
    runtime: {
      clock: backwards,
      memory,
      executors: new Map(manifests.map(manifest => [manifest.name, {manifest}])),
      ingestUserInput: () => Promise.reject(new Error('unused')),
      updateExternal: () => false,
      dispatchExternal: () => ({accepted: false, delegate_id: null}),
    },
    tools: compileToolSchema(manifests, {includeMemoryRecall: true}),
    idFactory: () => 'id-1',
    queryDigestKey: DIGEST_KEY,
  })
  const result = bridge.acceptToolCall({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'item-1',
    name: 'memory__recall',
    arguments: {query: 'compile', scope: 'recent'},
    response_id: null,
  }, {originRef: 'conversation:2'})
  assert.equal(result.telemetry?.elapsed, 0)
})

test('a container summary renders as canonical JSON, which is a recorded divergence', () => {
  // The oracle renders a non-string summary with `str()`. For a container that is Python repr, whose
  // dict ordering and int-vs-float spelling are the two divergences already recorded for model-facing
  // serialization -- `str(['a'])` is `['a']` and `str({'k': 'v'})` is `{'k': 'v'}`, neither
  // reproducible from a JSON-derived value in JavaScript. Canonical JSON is used instead, and stated
  // here rather than in a golden that would be pretending to parity.
  //
  // Unreachable in production: every shipped manifest declares these fields
  // `{"type": "string", "minLength": 1}`, so validation refuses a container before this is reached.
  // The test exists so a future manifest that loosens one does not change behavior unnoticed.
  const manifest = executorManifestSchema.parse({
    name: 'loose_sim',
    policy: {
      channel: 'loose_sim',
      priority: 50,
      wake: 'fast',
      typical_latency: 5,
      compress_watermark: 8,
    },
    ops: [
      {
        name: 'act',
        description: 'a summary field with no string constraint',
        params: {
          type: 'object',
          properties: {work_order: {type: 'array'}},
          additionalProperties: false,
        },
        deadline_budget: 10,
      },
      {
        name: 'look',
        description: 'the readonly path every manifest needs',
        params: {type: 'object', properties: {}, additionalProperties: false},
        readonly: true,
        deadline_budget: 5,
      },
    ],
  })
  const memory = new Memory({policies: [manifest.policy]})
  const bridge = new RealtimeRuntimeBridge({
    runtime: {
      clock: new VirtualClock(),
      memory,
      executors: new Map([[manifest.name, {manifest}]]),
      ingestUserInput: () => Promise.reject(new Error('unused')),
      updateExternal: () => false,
      dispatchExternal: () => ({accepted: true, delegate_id: 'd-1'}),
    },
    tools: compileToolSchema([manifest]),
    idFactory: () => 'id-1',
  })
  const accepted = bridge.acceptToolCall({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'item-1',
    name: 'loose_sim__act',
    arguments: {work_order: ['a', 'b']},
    response_id: null,
  }, {originRef: 'conversation:1'})
  assert.equal(accepted.code, 'accepted')
  assert.equal(
    accepted.response_intent.task_summary,
    '["a","b"]',
    'canonical JSON, not the oracle\'s ["a", "b"] repr',
  )
  // An empty container still falls through, because that is truthiness rather than rendering.
  const fellThrough = bridge.acceptToolCall({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-2',
    item_id: 'item-1',
    name: 'loose_sim__act',
    arguments: {work_order: []},
    response_id: null,
  }, {originRef: 'conversation:1'})
  assert.equal(fellThrough.response_intent.task_summary, 'loose_sim__act')
})
