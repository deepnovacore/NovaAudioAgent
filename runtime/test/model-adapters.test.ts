import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { VirtualClock } from '../src/clock.js'
import type { ContextView } from '../src/context-view.js'
import type { JsonValue } from '../src/events.js'
import { handoffPolicySchema, type MemoryItem } from '../src/memory.js'
import type {
  CompleteRequest,
  GatewayCompletion,
  GatewayDelta,
  ModelGateway,
  StreamRequest,
} from '../src/model-gateway.js'
import {
  GatewayCompressor,
  GatewaySurrogate,
  GatewayFastBrain,
  compressorPrompt,
  decodeToolCall,
  isFiniteBinary64Json,
  toolsForTrigger,
} from '../src/model-adapters.js'
import { executorManifestSchema } from '../src/ports.js'
import { compileToolSchema } from '../src/tool-schema.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/adapters/v1')

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8')) as T
}

void new VirtualClock()

function manifest(name: string, ops: readonly Record<string, JsonValue>[]) {
  return executorManifestSchema.parse({
    name,
    policy: handoffPolicySchema.parse({
      channel: name, priority: 50, wake: 'fast', typical_latency: 5, compress_watermark: 8,
    }),
    ops,
  })
}

const readonlyOp = {
  name: 'peek', description: 'readonly', params: {type: 'object', properties: {}}, readonly: true,
}
const writeOp = {
  name: 'run', description: 'runs work',
  params: {type: 'object', properties: {work_order: {type: 'string'}}, required: ['work_order']},
}

const tools = compileToolSchema([
  manifest('slow_sim', [readonlyOp]),
  manifest('codex', [readonlyOp, writeOp]),
])

class ScriptedGateway implements ModelGateway {
  readonly requests: StreamRequest[] = []
  readonly completions: CompleteRequest[] = []
  constructor(
    private readonly deltas: readonly GatewayDelta[] = [],
    private readonly text = '',
  ) {}

  async *stream(request: StreamRequest): AsyncIterable<GatewayDelta> {
    this.requests.push(request)
    for (const delta of this.deltas) {
      // Yield across a real turn so the consumer cannot depend on synchronous delivery.
      await Promise.resolve()
      yield delta
    }
  }

  complete(request: CompleteRequest): Promise<GatewayCompletion> {
    this.completions.push(request)
    return Promise.resolve({text: this.text})
  }
}

const emptyView: ContextView = {
  structured: {
    intent: {objective_hypothesis: '', constraints: [], unresolved_questions: [],
      uncertainty: 0.5, revision: 0},
    goal: {objective: '', acceptance_criteria: [], status: 'unset', revision: 0},
    authorization: {allow: [], deny: [], evidence_refs: [], revision: 0},
  },
  channels: [], in_flight: [], affordances: [], floor: 'idle', now: 0, trigger_kind: null,
}

test('the compressor prompt matches the Python oracle byte for byte', () => {
  const fixture = loadJson<{
    readonly schema_version: number
    readonly scenarios: readonly {readonly id: string, readonly covers: string,
      readonly items: readonly MemoryItem[]}[]
  }>('compressor-items.json')
  const golden = loadJson<{
    readonly schema_version: number
    readonly prompts: Readonly<Record<string, string>>
  }>('compressor-items-expected.json')
  assert.equal(fixture.schema_version, golden.schema_version)
  assert.deepEqual(
    fixture.scenarios.map(scenario => scenario.id).sort(),
    Object.keys(golden.prompts).sort(),
  )
  for (const scenario of fixture.scenarios) {
    assert.equal(
      compressorPrompt(scenario.items),
      golden.prompts[scenario.id],
      `${scenario.id}: ${scenario.covers}`,
    )
  }
  // Guard the premise: the scenario must actually exercise both hazards.
  const sorted = golden.prompts['sorted-keys-and-float-ts']!
  // Code-point key order, which JavaScript would otherwise reorder.
  assert.match(sorted, /"10": "ten", "2": "two"/u)
  // An integral float renders without a decimal point on BOTH sides, because the
  // oracle routes this through prompt_json. json.dumps would have written 1.0 here,
  // which no JavaScript number can express.
  assert.match(sorted, /"ts": 1\}/u)
  assert.doesNotMatch(sorted, /"ts": 1\.0/u)
})

test('a background trigger cannot reach Codex tools', () => {
  const userTurn = toolsForTrigger(tools, 'user_input', true)
  assert.ok([...userTurn.bindings.keys()].some(name => name.startsWith('codex__')))

  const background = toolsForTrigger(tools, 'progress', true)
  assert.ok([...background.bindings.keys()].every(name => !name.startsWith('codex__')))
  // The schema list must shrink with the bindings, not just the map.
  assert.equal(background.schemas.length, background.bindings.size)
  assert.ok([...background.bindings.keys()].some(name => name.startsWith('slow_sim__')))

  // Disabled means the filter never runs at all.
  assert.equal(toolsForTrigger(tools, 'progress', false).bindings.size, tools.bindings.size)
})

test('tool calls decode into typed actions and bounded contract failures', () => {
  assert.deepEqual(decodeToolCall(tools, 'codex__run',
    '{"work_order":"ship it","origin_ref":"conversation:1"}'), {
    kind: 'action',
    action: {act: 'delegate', delegate: {
      executor: 'codex', op: 'run', request: {work_order: 'ship it'},
      origin_ref: 'conversation:1',
    }},
  })

  assert.deepEqual(decodeToolCall(tools, 'update_intent', '{"uncertainty":0.25}'), {
    kind: 'action',
    action: {act: 'update', update: {target: 'intent', delta: {uncertainty: 0.25}}},
  })

  // Each failure names its code and never carries the offending payload.
  for (const [name, raw, code] of [
    ['nope__missing', '{}', 'unknown_tool'],
    ['codex__run', 'not json', 'invalid_tool_arguments'],
    ['codex__run', '[1,2,3]', 'invalid_tool_arguments'],
    ['codex__run', '"a string"', 'invalid_tool_arguments'],
    ['codex__run', '{"work_order":"x"}', 'missing_origin_ref'],
    ['codex__run', '{"work_order":"x","origin_ref":""}', 'missing_origin_ref'],
  ] as const) {
    const result = decodeToolCall(tools, name, raw)
    assert.equal(result.kind, 'contract_failure', `${name} ${raw}`)
    assert.equal(result.kind === 'contract_failure' ? result.code : undefined, code)
    assert.doesNotMatch(JSON.stringify(result), /ship it|not json|a string/u)
  }

  // An empty tool name reports null rather than an empty string.
  const anonymous = decodeToolCall(tools, '', '{}')
  assert.equal(anonymous.kind === 'contract_failure' ? anonymous.tool_name : 'set', null)
})

test('numbers JSON cannot represent as finite binary64 are refused', () => {
  assert.equal(isFiniteBinary64Json({a: 1, b: [2, {c: 3.5}]}), true)
  assert.equal(isFiniteBinary64Json({a: Number.POSITIVE_INFINITY}), false)
  assert.equal(isFiniteBinary64Json({a: Number.NaN}), false)
  assert.equal(isFiniteBinary64Json([1, [Number.NEGATIVE_INFINITY]]), false)
  assert.equal(isFiniteBinary64Json(undefined), false)
})

test('FastBrain forwards text immediately and decodes tool calls after the stream', async () => {
  const gateway = new ScriptedGateway([
    {kind: 'text', text: '好'},
    {kind: 'tool_call', index: 1, name: 'slow_sim__', arguments: '{"origin_ref"'},
    {kind: 'text', text: '的'},
    {kind: 'tool_call', index: 0, name: 'update_intent', arguments: '{"uncertainty":0.1}'},
    {kind: 'tool_call', index: 1, name: 'peek', arguments: ':"conversation:1"}'},
  ])
  const brain = new GatewayFastBrain({gateway, model: 'm', tools})
  const seen = []
  for await (const delta of brain.call(emptyView)) seen.push(delta)

  // Text arrives in stream order, before any structured output.
  assert.deepEqual(seen.slice(0, 2), [
    {kind: 'text', text: '好'}, {kind: 'text', text: '的'},
  ])
  // Fragments are reassembled per index and emitted in ascending index order.
  assert.deepEqual(seen.slice(2), [
    {kind: 'action', action: {act: 'update', update: {target: 'intent',
      delta: {uncertainty: 0.1}}}},
    {kind: 'action', action: {act: 'delegate', delegate: {executor: 'slow_sim', op: 'peek',
      request: {}, origin_ref: 'conversation:1'}}},
  ])
  // The FastBrain system prompt must actually be sent, not defaulted away.
  assert.ok((gateway.requests[0]?.system.length ?? 0) > 100)
  assert.equal(gateway.requests.length, 1)
})

test('the Surrogate rejects output that is not contract-shaped', async () => {
  const good = new GatewaySurrogate({
    gateway: new ScriptedGateway([], '{"speak":true,"suggestion_id":"s-1","reason":"因为"}'),
    model: 'm',
  })
  assert.deepEqual(await good.watch(emptyView),
    {speak: true, suggestion_id: 's-1', reason: '因为'})

  for (const text of ['not json', '{}', '{"speak":"yes","suggestion_id":null,"reason":"r"}',
    '{"speak":true,"suggestion_id":7,"reason":"r"}', '{"speak":true,"suggestion_id":null}']) {
    const bad = new GatewaySurrogate({gateway: new ScriptedGateway([], text), model: 'm'})
    await assert.rejects(bad.watch(emptyView), TypeError, text)
  }
})

test('the compressor trims its answer and sends the schema-free request', async () => {
  const gateway = new ScriptedGateway([], '  摘要文本  ')
  const compressor = new GatewayCompressor({gateway, model: 'qwen-flash'})
  assert.equal(await compressor.compress([]), '摘要文本')
  assert.equal(gateway.completions[0]?.jsonSchema, undefined)
  assert.equal(gateway.completions[0]?.prompt, '[]')
})
