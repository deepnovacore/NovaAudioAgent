import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AssemblyError, NULL_SPEECH_SINK, buildAssembly } from '../src/assembly.js'
import { RealClock, VirtualClock } from '../src/clock.js'
import { settingsSchema, type Settings } from '../src/config.js'
import type { ExecutorDispatchContext } from '../src/causal-runtime.js'
import type { EventRecord } from '../src/events.js'
import { CamAdapter } from '../src/executors/camera.js'
import { ChromiumFrameSource } from '../src/executors/chromium-frame-source.js'
import { DisabledFrameSource } from '../src/executors/frame-source.js'
import type { SearchTransport } from '../src/executors/search.js'
import { WatchAdapter, type Frame, type FrameSource } from '../src/executors/watcher.js'
import { MonotonicIdFactory } from '../src/ids.js'
import { MediaStore } from '../src/media-store.js'
import type {
  CompleteRequest,
  GatewayCompletion,
  GatewayDelta,
  ModelGateway,
  StreamRequest,
} from '../src/model-gateway.js'
import type { SpeechSink } from '../src/calls.js'
import { delegateSchema } from '../src/ports.js'

function settings(overrides: Partial<Settings> = {}): Settings {
  return settingsSchema.parse({
    executors: ['fast_sim'],
    model_api_key: 'assembly-test-key',
    tavily_api_key: 'tavily-test-key',
    ...overrides,
  })
}

class ScriptedSearchTransport implements SearchTransport {
  readonly queries: {readonly query: string; readonly maxResults: number}[] = []

  search(query: string, options: {readonly maxResults: number}): Promise<Record<string, unknown>> {
    this.queries.push({query, maxResults: options.maxResults})
    return Promise.resolve({
      request_id: 'search-request-1',
      results: [{
        title: 'Nova',
        content: 'An audio agent',
        url: 'https://example.com/nova',
      }],
    })
  }
}

class ScriptedFrameSource implements FrameSource {
  readonly isFileBackedFrameSource = true
  starts = 0
  stops = 0
  restarts = 0
  failNextStart = false
  failNextStop = false

  constructor(readonly frame: Frame | null) {}

  start(): Promise<void> {
    this.starts += 1
    if (this.failNextStart) {
      this.failNextStart = false
      return Promise.reject(new Error('start failed'))
    }
    return Promise.resolve()
  }

  stop(): Promise<void> {
    this.stops += 1
    if (this.failNextStop) {
      this.failNextStop = false
      return Promise.reject(new Error('stop failed'))
    }
    return Promise.resolve()
  }

  restart(): Promise<void> {
    this.restarts += 1
    return Promise.resolve()
  }

  snapshot(): Promise<Frame | null> {
    return Promise.resolve(this.frame)
  }
}

class ExplodingLocalChromiumSource extends ChromiumFrameSource {
  restartCalls = 0

  override restart(): Promise<void> {
    this.restartCalls += 1
    return Promise.reject(new Error('local restart must not be exposed to Guard'))
  }
}

class DeferredFrameSource implements FrameSource {
  starts = 0
  stops = 0
  readonly #startGate: Promise<void>
  readonly #releaseStart: () => void

  constructor() {
    let release = (): void => undefined
    this.#startGate = new Promise<void>(resolve => { release = resolve })
    this.#releaseStart = release
  }

  start(): Promise<void> {
    this.starts += 1
    return this.#startGate
  }

  stop(): Promise<void> {
    this.stops += 1
    return Promise.resolve()
  }

  snapshot(): Promise<Frame | null> {
    return Promise.resolve(null)
  }

  releaseStart(): void {
    this.#releaseStart()
  }
}

/** A gateway whose stream and completion answers are scripted per model name. */
class ScriptedGateway implements ModelGateway {
  readonly streamed: StreamRequest[] = []
  readonly completed: CompleteRequest[] = []
  constructor(
    private readonly deltas: readonly GatewayDelta[],
    private readonly answers: Readonly<Record<string, string>> = {},
    private readonly onComplete?: (request: CompleteRequest) => void,
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
    this.onComplete?.(request)
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

test('model credential validation wins when both production credentials are absent', () => {
  assert.throws(
    () => buildAssembly({
      settings: settings({model_api_key: null, tavily_api_key: null}),
    }),
    (error: unknown) => error instanceof AssemblyError
      && error.message === '缺少 NOVA_AUDIO_AGENT_MODEL_API_KEY',
  )
})

test('production search requires Tavily without exposing credential values', () => {
  assert.throws(
    () => buildAssembly({settings: settings({tavily_api_key: null})}),
    (error: unknown) => {
      assert.ok(error instanceof AssemblyError)
      assert.match(error.message, /TAVILY_API_KEY/u)
      assert.doesNotMatch(error.message, /tavily-test-key/u)
      return true
    },
  )
})

test('the compiled tool schema advertises always-on adapters before configured executors', () => {
  const assembly = buildAssembly({
    settings: settings({executors: ['fast_sim', 'slow_sim']}),
    gateway: new ScriptedGateway([]),
  })
  assert.deepEqual(assembly.manifests.map(manifest => manifest.name), [
    'search', 'cam', 'watch', 'guard', 'fast_sim', 'slow_sim',
  ])
  const names = [...assembly.tools.bindings.keys()]
  assert.ok(names.includes('search__search'))
  assert.ok(names.includes('cam__snapshot'))
  assert.ok(names.includes('watch__start'))
  assert.ok(names.includes('guard__status'))
  assert.ok(names.includes('fast_sim__set_light'))
  assert.ok(names.includes('slow_sim__get_state'))
  // The three structured-update tools are always present.
  assert.ok(names.includes('update_intent'))
  // memory__recall is opt-in.
  assert.ok(!names.includes('memory__recall'))
})

test('search and camera dispatch through the real runtime and shared media store', async () => {
  const searchTransport = new ScriptedSearchTransport()
  const frame: Frame = {
    payload: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    media_type: 'image/jpeg',
    width: 2,
    height: 2,
    captured_at: 7,
  }
  const frameSource = new ScriptedFrameSource(frame)
  const mediaStore = new MediaStore(1_024, {idFactory: () => 'assembly-frame'})
  const assembly = buildAssembly({
    settings: settings(),
    gateway: new ScriptedGateway([]),
    searchTransport,
    frameSource,
    mediaStore,
  })
  const origin = assembly.runtime.memory.append('conversation', {
    ts: 0,
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'search and look'},
  })
  const originRef = `${origin.channel}:${origin.seq}`
  const reason = {
    kind: 'realtime_tool', priority: 100, routing_class: 'user_awaited' as const,
    origin: null, selected_suggestion: null,
  }
  const events: EventRecord[] = []
  assembly.runtime.observe(event => events.push(event))
  const stop = new AbortController()
  const serving = assembly.runtime.serve(stop.signal)

  assert.equal(assembly.runtime.dispatchExternal({
    executor: 'search', op: 'search', request: {query: 'Nova', k: 1}, origin_ref: originRef,
  }, reason).accepted, true)
  await waitFor(() => events.some(event => event.kind === 'handoff'
    && event.payload.channel === 'search'))
  assert.deepEqual(searchTransport.queries, [{query: 'Nova', maxResults: 1}])

  assert.equal(assembly.runtime.dispatchExternal({
    executor: 'cam', op: 'snapshot', request: {}, origin_ref: originRef,
  }, reason).accepted, true)
  await waitFor(() => events.some(event => event.kind === 'handoff'
    && event.payload.channel === 'cam'))
  stop.abort()
  await serving

  assert.equal(assembly.mediaStore, mediaStore)
  assert.equal(assembly.frameSource, frameSource)
  assert.equal(mediaStore.peek('media:assembly-frame')?.captured_at, 7)
})

test('camera, watch, and guard share capture while only Guard prepares a restartable source', async () => {
  const clock = new VirtualClock()
  const source = new ScriptedFrameSource({
    payload: new Uint8Array([1, 2, 3]),
    media_type: 'image/png',
    width: 3,
    height: 1,
    captured_at: 11,
  })
  const store = new MediaStore(1_024, {
    idFactory: (() => {
      let id = 0
      return () => `shared-${++id}`
    })(),
  })
  const gateway = new ScriptedGateway(
    [],
    {'fast-model': '{"hit": true, "observation": "motion"}'},
    () => { setImmediate(() => clock.advanceTo(clock.now() + 31)) },
  )
  const assembly = buildAssembly({
    settings: settings({fast_model: 'fast-model', watch_model: '\u001c'}),
    gateway,
    searchTransport: new ScriptedSearchTransport(),
    frameSource: source,
    mediaStore: store,
    clock,
  })

  assert.ok(assembly.runtime.executors.get('cam') instanceof CamAdapter)
  const watch = assembly.runtime.executors.get('watch')
  const guard = assembly.runtime.executors.get('guard')
  assert.ok(watch instanceof WatchAdapter)
  assert.ok(guard instanceof WatchAdapter)

  await watch.dispatch('start', {condition: 'motion', duration_s: 30}, watchContext('watch', clock))
  assert.equal(source.restarts, 0, 'Watch must not reset a shared file-like source')
  await guard.dispatch('start', {condition: 'motion', duration_s: 30}, watchContext('guard', clock))
  assert.equal(source.restarts, 1, 'Guard prepares a restartable source once per observation')

  assert.equal(gateway.completed.length, 2)
  assert.deepEqual(gateway.completed.map(request => request.model), ['fast-model', 'fast-model'])
  assert.deepEqual(gateway.completed[0]?.images, [{
    ref: 'watch-frame', media_type: 'image/png', payload: new Uint8Array([1, 2, 3]),
  }])
  assert.equal(store.size, 2, 'both Watch adapters persist hits into the assembly store')
})

test('a local Chromium source is not exposed to Guard as file-restartable', async () => {
  const clock = new VirtualClock()
  const source = new ExplodingLocalChromiumSource({
    source: 'local',
    clock,
    transport: {
      captureCamera: () => Promise.resolve({
        payload: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        media_type: 'image/jpeg',
        width: 1280,
        height: 720,
      }),
      requestCameraPermission: () => Promise.resolve('granted'),
    },
  })
  const gateway = new ScriptedGateway(
    [],
    {'fast-model': '{"hit": false, "observation": "clear"}'},
    () => { setImmediate(() => clock.advanceTo(31)) },
  )
  const assembly = buildAssembly({
    settings: settings({fast_model: 'fast-model'}),
    gateway,
    searchTransport: new ScriptedSearchTransport(),
    frameSource: source,
    clock,
  })
  await assembly.start()
  try {
    const guard = assembly.runtime.executors.get('guard')
    assert.ok(guard instanceof WatchAdapter)
    const handoff = await guard.dispatch(
      'start', {condition: 'motion', duration_s: 30}, watchContext('guard', clock),
    )
    assert.notEqual(handoff.content.error, 'capture_unavailable')
    assert.equal(source.restartCalls, 0)
  } finally {
    await assembly.stop()
  }
})

test('assembly gates local Guard before armed and emits bounded camera admission telemetry', async () => {
  const clock = new VirtualClock()
  let captures = 0
  let permissionRequests = 0
  const telemetry: {readonly kind: string; readonly payload: unknown}[] = []
  const source = new ChromiumFrameSource({
    source: 'local',
    clock,
    transport: {
      captureCamera: () => {
        captures += 1
        return Promise.reject(new Error('capture must not run before denied admission'))
      },
      requestCameraPermission: () => {
        permissionRequests += 1
        return Promise.resolve('denied')
      },
    },
  })
  const assembly = buildAssembly({
    settings: settings(),
    gateway: new ScriptedGateway([]),
    searchTransport: new ScriptedSearchTransport(),
    frameSource: source,
    clock,
    telemetry: {
      record: (kind, payload) => telemetry.push({kind, payload}),
      close: () => undefined,
    },
  })
  const guard = assembly.runtime.executors.get('guard')
  assert.ok(guard instanceof WatchAdapter)

  const handoff = await guard.dispatch(
    'start',
    {condition: 'motion'},
    watchContext('guard', clock),
  )

  assert.equal(handoff.outcome, 'refused')
  assert.equal(handoff.content.error, 'camera_permission_denied')
  assert.equal(permissionRequests, 1)
  assert.equal(captures, 0)
  assert.deepEqual(telemetry, [{
    kind: 'camera.admission',
    payload: {executor: 'guard', status: 'denied', phase: 'pre_arm', admitted: false},
  }])
})

test('assembly emits bounded Surrogate verdict attribution without model reason text', async () => {
  const telemetry: {readonly kind: string; readonly payload: unknown}[] = []
  const gateway = new ScriptedGateway([], {
    'qwen-flash': '{"speak":false,"suggestion_id":null,"reason":"private summary echo"}',
  })
  const assembly = buildAssembly({
    settings: settings({proactivity_preset: 'eager'}),
    gateway,
    realtimeFrontbrain: true,
    telemetry: {
      record: (kind, payload) => telemetry.push({kind, payload}),
      close: () => undefined,
    },
  })
  const stop = new AbortController()
  const applied: EventRecord[] = []
  assembly.runtime.observe(event => applied.push(event))
  const serving = assembly.runtime.serve(stop.signal)

  assembly.runtime.post({
    kind: 'handoff',
    payload: {
      channel: 'watch',
      delegate_id: 'ambient-watch-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {hit: true},
      refs: [],
    },
  })
  await waitFor(() => applied.some(event => event.kind === 'model_done'))
  stop.abort()
  await serving

  assert.deepEqual(telemetry, [{
    kind: 'surrogate.verdict',
    payload: {
      disposition: 'silent',
      offered_count: 0,
      preset: 'eager',
      trigger_kind: 'handoff',
    },
  }])
  assert.doesNotMatch(JSON.stringify(telemetry), /private summary echo/u)
})

test('Watch keeps the Chromium file epoch while Guard resets it before observation', async () => {
  const clock = new VirtualClock()
  const captures: unknown[] = []
  const source = new ChromiumFrameSource({
    source: 'file',
    clock,
    transport: {
      captureCamera: request => {
        captures.push(request)
        return Promise.resolve({
          payload: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
          media_type: 'image/jpeg',
          width: 1280,
          height: 720,
        })
      },
    },
  })
  const gateway = new ScriptedGateway(
    [],
    {'fast-model': '{"hit": false, "observation": "clear"}'},
    () => { setImmediate(() => clock.advanceTo(clock.now() + 31)) },
  )
  const assembly = buildAssembly({
    settings: settings({fast_model: 'fast-model'}),
    gateway,
    searchTransport: new ScriptedSearchTransport(),
    frameSource: source,
    clock,
  })
  await assembly.start()
  try {
    await source.restart()
    clock.advanceTo(10)
    const watch = assembly.runtime.executors.get('watch')
    const guard = assembly.runtime.executors.get('guard')
    assert.ok(watch instanceof WatchAdapter)
    assert.ok(guard instanceof WatchAdapter)
    await watch.dispatch('start', {condition: 'motion', duration_s: 30}, watchContext('watch', clock))
    await guard.dispatch('start', {condition: 'motion', duration_s: 30}, watchContext('guard', clock))
    assert.deepEqual(captures, [
      {source: 'file', positionMs: 10_000},
      {source: 'file', positionMs: 0},
    ])
  } finally {
    await assembly.stop()
  }
})

test('assembly owns an idempotent retryable frame-source lifecycle', async () => {
  const source = new ScriptedFrameSource(null)
  const assembly = buildAssembly({
    settings: settings(),
    gateway: new ScriptedGateway([]),
    searchTransport: new ScriptedSearchTransport(),
    frameSource: source,
  })

  source.failNextStart = true
  await assert.rejects(assembly.start(), /start failed/u)
  await assembly.start()
  await assembly.start()
  assert.equal(source.starts, 2, 'a failed start is retried and a successful start is idempotent')

  source.failNextStop = true
  await assert.rejects(assembly.stop(), /stop failed/u)
  await assembly.stop()
  await assembly.stop()
  assert.equal(source.stops, 2, 'a failed stop remains started and is retried')
})

test('concurrent assembly starts acquire the frame source exactly once', async () => {
  const source = new DeferredFrameSource()
  const assembly = buildAssembly({
    settings: settings(),
    gateway: new ScriptedGateway([]),
    searchTransport: new ScriptedSearchTransport(),
    frameSource: source,
  })

  const first = assembly.start()
  const second = assembly.start()
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(source.starts, 1)
  source.releaseStart()
  await Promise.all([first, second])
  assert.equal(source.starts, 1)
})

test('assembly stop waits for an in-flight start and then releases the source', async () => {
  const source = new DeferredFrameSource()
  const assembly = buildAssembly({
    settings: settings(),
    gateway: new ScriptedGateway([]),
    searchTransport: new ScriptedSearchTransport(),
    frameSource: source,
  })

  const starting = assembly.start()
  let stopReturned = false
  const stopping = assembly.stop().then(() => { stopReturned = true })
  await Promise.resolve()
  assert.equal(stopReturned, false)
  assert.equal(source.stops, 0)

  source.releaseStart()
  await starting
  await stopping
  assert.equal(source.starts, 1)
  assert.equal(source.stops, 1)
})

test('the default disabled source reports unavailable capture and has a no-op lifecycle', async () => {
  const clock = new VirtualClock()
  const assembly = buildAssembly({
    settings: settings(),
    gateway: new ScriptedGateway([]),
    searchTransport: new ScriptedSearchTransport(),
    clock,
  })
  assert.ok(assembly.frameSource instanceof DisabledFrameSource)
  const cam = assembly.runtime.executors.get('cam')
  const watch = assembly.runtime.executors.get('watch')
  assert.ok(cam instanceof CamAdapter)
  assert.ok(watch instanceof WatchAdapter)
  const cameraHandoff = await cam.dispatch('snapshot', {}, watchContext('cam', clock))
  assert.equal(cameraHandoff.outcome, 'unknown')
  assert.equal(cameraHandoff.content.error, 'capture_unavailable')
  const watchHandoff = await watch.dispatch(
    'start', {condition: 'motion'}, watchContext('watch', clock),
  )
  assert.equal(watchHandoff.outcome, 'unknown')
  assert.equal(watchHandoff.content.error, 'capture_unavailable')

  const source = assembly.frameSource
  await source.start()
  await source.start()
  assert.equal(await source.snapshot(), null)
  await source.stop()
  await source.stop()
})

function watchContext(
  executor: 'cam' | 'watch' | 'guard',
  clock: VirtualClock,
): ExecutorDispatchContext {
  return {
    clock,
    delegate: delegateSchema.parse({
      delegate_id: `${executor}-assembly`, executor, op: 'start', request: {},
      origin_ref: 'conversation:1', deadline: clock.now() + 30,
      routing_class: 'user_awaited', dispatched_at: clock.now(),
    }),
    signal: new AbortController().signal,
    progress: () => undefined,
    observe: () => undefined,
  }
}

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
