import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AssemblyError, NULL_SPEECH_SINK, buildAssembly } from '../src/assembly.js'
import { RealClock } from '../src/clock.js'
import { settingsSchema, type Settings } from '../src/config.js'
import type { EventRecord } from '../src/events.js'
import { MonotonicIdFactory } from '../src/ids.js'
import type {
  CompleteRequest,
  GatewayCompletion,
  GatewayDelta,
  ModelGateway,
  StreamRequest,
} from '../src/model-gateway.js'
import type { SpeechSink } from '../src/calls.js'

function settings(overrides: Partial<Settings> = {}): Settings {
  return settingsSchema.parse({
    executors: ['fast_sim'],
    model_api_key: 'assembly-test-key',
    ...overrides,
  })
}

/** A gateway whose stream and completion answers are scripted per model name. */
class ScriptedGateway implements ModelGateway {
  readonly streamed: StreamRequest[] = []
  readonly completed: CompleteRequest[] = []
  constructor(
    private readonly deltas: readonly GatewayDelta[],
    private readonly answers: Readonly<Record<string, string>> = {},
  ) {}

  async *stream(request: StreamRequest): AsyncIterable<GatewayDelta> {
    this.streamed.push(request)
    for (const delta of this.deltas) {
      await Promise.resolve()
      yield delta
    }
  }

  complete(request: CompleteRequest): Promise<GatewayCompletion> {
    this.completed.push(request)
    return Promise.resolve({text: this.answers[request.model] ?? ''})
  }
}

/**
 * Wait on real elapsed time, not on macrotask turns.
 *
 * The simulators sleep on the real clock, so spinning setImmediate only burns
 * microseconds and would time out before a 50ms dispatch could land.
 */
async function waitFor(condition: () => boolean, milliseconds = 3_000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never became true')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function collectingSink(): SpeechSink & {readonly spoken: string[]} {
  const spoken: string[] = []
  return {
    spoken,
    emit: (_utteranceId, text) => { spoken.push(text) },
    end: () => undefined,
  }
}

test('a configured executor with no adapter fails at startup, not at first dispatch', () => {
  assert.throws(
    () => buildAssembly({settings: settings({executors: ['codex']})}),
    (error: unknown) => error instanceof AssemblyError
      && error.message.includes('no adapter for configured executor'),
  )
})

test('a missing model credential is refused without echoing configuration', () => {
  assert.throws(
    () => buildAssembly({settings: settings({model_api_key: null})}),
    (error: unknown) => {
      assert.ok(error instanceof AssemblyError)
      assert.match(error.message, /NOVA_AUDIO_AGENT_MODEL_API_KEY/u)
      // The name is enough to act on; no value may appear.
      assert.doesNotMatch(error.message, /assembly-test-key|dashscope/u)
      return true
    },
  )
})

test('the compiled tool schema advertises exactly the configured executors', () => {
  const assembly = buildAssembly({
    settings: settings({executors: ['fast_sim', 'slow_sim']}),
    gateway: new ScriptedGateway([]),
  })
  assert.deepEqual(assembly.manifests.map(manifest => manifest.name), ['fast_sim', 'slow_sim'])
  const names = [...assembly.tools.bindings.keys()]
  assert.ok(names.includes('fast_sim__set_light'))
  assert.ok(names.includes('slow_sim__get_state'))
  // The three structured-update tools are always present.
  assert.ok(names.includes('update_intent'))
  // memory__recall is opt-in.
  assert.ok(!names.includes('memory__recall'))
})

test('a duplicate supplied adapter is rejected', () => {
  const assembly = buildAssembly({settings: settings(), gateway: new ScriptedGateway([])})
  const adapter = {
    manifest: assembly.manifests[0]!,
    dispatch: () => Promise.resolve({outcome: 'ok' as const, trust: 'trusted_system' as const,
      content: {}}),
  }
  assert.throws(
    () => buildAssembly({settings: settings(), gateway: new ScriptedGateway([]),
      executors: [adapter, adapter]}),
    AssemblyError,
  )
})

test('user input drives a streamed answer through the real serving loop', async () => {
  const sink = collectingSink()
  const gateway = new ScriptedGateway([
    {kind: 'text', text: '好的'},
    {kind: 'text', text: '，已处理'},
  ])
  const assembly = buildAssembly({
    settings: settings(),
    gateway,
    sink,
    clock: new RealClock(),
    ids: new MonotonicIdFactory(),
  })

  const stop = new AbortController()
  const applied: EventRecord[] = []
  assembly.runtime.observe(event => applied.push(event))
  const serving = assembly.runtime.serve(stop.signal)

  const reference = await assembly.runtime.ingestUserInput({text: '帮我处理一下'})
  assert.match(reference, /^conversation:\d+$/u)

  await waitFor(() => applied.some(event => event.kind === 'model_done'))
  stop.abort()
  await serving

  const kinds = applied.map(event => event.kind)
  assert.ok(kinds.includes('user_input'))
  assert.ok(kinds.includes('speak_start'), 'the streaming port must open the Floor')
  assert.ok(kinds.includes('speak_end'))
  assert.ok(kinds.includes('model_done'))
  // Speech reached the sink incrementally, in stream order.
  assert.deepEqual(sink.spoken, ['好的', '，已处理'])

  // And the spoken text landed in the conversation channel, not the suggestion pool.
  const conversation = assembly.runtime.core.memory.channels.get('conversation')?.items ?? []
  assert.ok(conversation.some(item => item.content.text === '好的，已处理'))
  assert.equal(assembly.runtime.core.suggestions.all().length, 0)

  // The FastBrain system prompt and the compiled tools actually reached the gateway.
  assert.equal(gateway.streamed.length, 1)
  assert.ok((gateway.streamed[0]?.tools?.length ?? 0) > 0)
})

test('a delegating answer dispatches to the simulator and records its handoff', async () => {
  const gateway = new ScriptedGateway([
    {kind: 'tool_call', index: 0, name: 'fast_sim__set_light',
      arguments: '{"room":"客厅","brightness":30,"origin_ref":"conversation:1"}'},
  ])
  const assembly = buildAssembly({
    settings: settings(),
    gateway,
    sink: NULL_SPEECH_SINK,
    ids: new MonotonicIdFactory(),
  })

  const stop = new AbortController()
  const applied: EventRecord[] = []
  assembly.runtime.observe(event => applied.push(event))
  const serving = assembly.runtime.serve(stop.signal)

  await assembly.runtime.ingestUserInput({text: '把客厅调到30'})
  await waitFor(() => applied.some(event => event.kind === 'handoff'))
  stop.abort()
  await serving

  const handoff = applied.find(event => event.kind === 'handoff')
  assert.ok(handoff !== undefined, 'the simulator must produce exactly one handoff')
  assert.equal(handoff.kind === 'handoff' ? handoff.payload.outcome : undefined, 'ok')
  assert.equal(handoff.kind === 'handoff' ? handoff.payload.channel : undefined, 'fast_sim')
  // Identity is bound by the core; the simulator never supplies it.
  assert.equal(handoff.kind === 'handoff' ? handoff.payload.origin_ref : undefined,
    'conversation:1')
  const light = assembly.runtime.core.memory.channels.get('fast_sim')?.items ?? []
  assert.ok(light.some(item => item.content.op === 'set_light'))
  // No speech was produced, so no Floor turn was spent.
  assert.ok(!applied.some(event => event.kind === 'speak_start'))
})

test('a malformed tool call beside a valid delegate dispatches nothing', async () => {
  // The fold must carry contract failures through, or an unknown tool name becomes a way
  // to smuggle work past the contract gate.
  const gateway = new ScriptedGateway([
    {kind: 'tool_call', index: 0, name: 'nope__missing', arguments: '{}'},
    {kind: 'tool_call', index: 1, name: 'fast_sim__set_light',
      arguments: '{"room":"客厅","brightness":30,"origin_ref":"conversation:1"}'},
  ])
  const assembly = buildAssembly({
    settings: settings(), gateway, sink: NULL_SPEECH_SINK, ids: new MonotonicIdFactory(),
  })
  const stop = new AbortController()
  const applied: EventRecord[] = []
  assembly.runtime.observe(event => applied.push(event))
  const serving = assembly.runtime.serve(stop.signal)

  await assembly.runtime.ingestUserInput({text: '把客厅调到30'})
  await waitFor(() => applied.some(event => event.kind === 'model_done'))
  // Give any dispatch a real chance to land before asserting it did not.
  await new Promise(resolve => setTimeout(resolve, 150))
  stop.abort()
  await serving

  assert.ok(!applied.some(event => event.kind === 'handoff'), 'nothing may be dispatched')
  const conversation = assembly.runtime.core.memory.channels.get('conversation')?.items ?? []
  const refusal = conversation.at(-1)
  assert.equal(refusal?.content.error, 'model_contract_failure')
  assert.equal(refusal?.content.code, 'unknown_tool')
})

test('two valid delegates in one turn dispatch neither', async () => {
  // Executing one of two would produce "one of your requests was handled; guess which".
  const gateway = new ScriptedGateway([
    {kind: 'tool_call', index: 0, name: 'fast_sim__set_light',
      arguments: '{"room":"客厅","brightness":30,"origin_ref":"conversation:1"}'},
    {kind: 'tool_call', index: 1, name: 'fast_sim__set_light',
      arguments: '{"room":"卧室","brightness":10,"origin_ref":"conversation:1"}'},
  ])
  const assembly = buildAssembly({
    settings: settings(), gateway, sink: NULL_SPEECH_SINK, ids: new MonotonicIdFactory(),
  })
  const stop = new AbortController()
  const applied: EventRecord[] = []
  assembly.runtime.observe(event => applied.push(event))
  const serving = assembly.runtime.serve(stop.signal)

  await assembly.runtime.ingestUserInput({text: '客厅30卧室10'})
  await waitFor(() => applied.some(event => event.kind === 'model_done'))
  await new Promise(resolve => setTimeout(resolve, 150))
  stop.abort()
  await serving

  assert.ok(!applied.some(event => event.kind === 'handoff'))
  const refusal = (assembly.runtime.core.memory.channels.get('conversation')?.items ?? []).at(-1)
  assert.equal(refusal?.content.error, 'multiple_actions')
  assert.equal(refusal?.content.count, 2)
})
