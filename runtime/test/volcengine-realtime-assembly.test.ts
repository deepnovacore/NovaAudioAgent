import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {ExecutorAdapter, ExecutorDispatchContext} from '../src/causal-runtime.js'
import {VirtualClock} from '../src/clock.js'
import {
  ConfigurationError,
  loadSettings,
  requireVolcengineRealtime,
  type Settings,
  type VolcengineRealtimeConfig,
} from '../src/config.js'
import type {Frame, FrameSource} from '../src/executors/watcher.js'
import {WatchAdapter} from '../src/executors/watcher.js'
import type {IdFactory} from '../src/ids.js'
import {MediaStore} from '../src/media-store.js'
import {handoffPolicySchema} from '../src/memory.js'
import {delegateSchema, executorManifestSchema} from '../src/ports.js'
import {createArkCascadedLlmSession} from '../src/realtime/cascaded/ark-llm.js'
import {CascadedRealtimeError} from '../src/realtime/cascaded/adapter.js'
import {CascadedRealtimeProvider} from '../src/realtime/cascaded/provider.js'
import type {AsrClient, TtsClient} from '../src/realtime/cascaded/ports.js'
import type {ArkEvent, ArkResponsesGateway, ArkStreamInput} from '../src/realtime/volcengine/ark.js'
import type {
  EndpointingCapabilityReason,
  EndpointingCapabilityResult,
  LiveKitAgentsPublicSurface,
  LiveKitExecutor,
  LiveKitVadEvent,
  PreparedEndpointingCapability,
} from '../src/realtime/volcengine/endpointing-capability.js'
import {LiveKitVolcEndpointing} from '../src/realtime/volcengine/livekit-endpointing.js'
import {SilenceVolcEndpointing} from '../src/realtime/volcengine/silence-endpointing.js'
import {
  buildVolcengineRealtimeAssembly,
  type BuildVolcengineRealtimeAssemblyOptions,
} from '../src/volcengine-realtime-assembly.js'

function settings(environment: NodeJS.ProcessEnv = {}): Settings {
  return loadSettings({
    NOVA_AUDIO_AGENT_REALTIME_PROVIDER: 'volcengine',
    ARK_API_KEY: 'ark-test-key',
    DOUBAO_BIGMODEL_API_KEY: 'doubao-test-key',
    TAVILY_API_KEY: 'tavily-test-key',
    ...environment,
  })
}

function fallback(reason: EndpointingCapabilityReason): EndpointingCapabilityResult {
  return Object.freeze({
    schema_version: 1,
    mode: 'bounded_silence',
    eot: {available: false, reason},
    vad: {available: false, reason},
    platform: 'darwin',
    arch: 'arm64',
  })
}

class EmptyArk implements ArkResponsesGateway {
  readonly operations: string[]
  constructor(operations: string[]) { this.operations = operations }
  async *stream(_input: ArkStreamInput): AsyncIterable<ArkEvent> {
    void _input
    await Promise.resolve()
  }
  close(): Promise<void> { this.operations.push('ark.close'); return Promise.resolve() }
}

function testProvider(options: {
  readonly config: VolcengineRealtimeConfig
  readonly endpointingCapability: () => Promise<PreparedEndpointingCapability>
  readonly asrClient: () => AsrClient
  readonly ttsClient: () => TtsClient
  readonly arkFactory: () => ArkResponsesGateway
  readonly idFactory: () => string
}): CascadedRealtimeProvider {
  return new CascadedRealtimeProvider({
    endpointingFactory: async () => {
      const prepared = await options.endpointingCapability()
      if (prepared.result.mode !== 'livekit_v1_mini') {
        return new SilenceVolcEndpointing(options.config)
      }
      if (prepared.surface === undefined || prepared.executor === undefined) {
        throw new CascadedRealtimeError('configuration')
      }
      return new LiveKitVolcEndpointing({
        surface: prepared.surface, executor: prepared.executor, config: options.config,
      })
    },
    asrFactory: {openClient: options.asrClient},
    llmFactory: {open: () => createArkCascadedLlmSession(options.arkFactory())},
    ttsFactory: {openClient: options.ttsClient},
    idFactory: options.idFactory,
  })
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined
  const promise = new Promise<T>(promiseResolve => { resolve = promiseResolve })
  return {promise, resolve: resolve!}
}

async function settleNamed<T>(name: string, promise: Promise<T>, timeoutMs = 1_500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} did not settle in time`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function waitFor(name: string, predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const started = performance.now()
  while (!predicate()) {
    if (performance.now() - started >= timeoutMs) throw new Error(`${name} did not settle in time`)
    await new Promise(resolve => setImmediate(resolve))
  }
}

class RecordingIds implements IdFactory {
  readonly calls: string[] = []
  #sequence = 0

  next(namespace: string): string {
    this.calls.push(namespace)
    this.#sequence += 1
    return `${namespace}-${this.#sequence}`
  }
}

class RecordingFrameSource implements FrameSource {
  starts = 0
  stops = 0
  snapshots = 0

  start(): Promise<void> { this.starts += 1; return Promise.resolve() }
  stop(): Promise<void> { this.stops += 1; return Promise.resolve() }
  snapshot(): Promise<Frame> {
    this.snapshots += 1
    return Promise.resolve({
      payload: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      media_type: 'image/jpeg', width: 2, height: 2, captured_at: 0,
    })
  }
}

class EmptyVadStream implements AsyncIterable<LiveKitVadEvent> {
  #resolve: ((result: IteratorResult<LiveKitVadEvent>) => void) | undefined

  updateInputStream(): void { return }
  flush(): void { return }
  close(): void { this.#resolve?.({done: true, value: undefined}); this.#resolve = undefined }
  [Symbol.asyncIterator](): AsyncIterator<LiveKitVadEvent> {
    return {
      next: () => new Promise(resolve => { this.#resolve = resolve }),
    }
  }
}

function readySurface(onVad: () => void): LiveKitAgentsPublicSurface {
  return {
    version: '1.6.4',
    initializeLogger: () => undefined,
    getJobContext: () => undefined,
    inference: {
      VAD: class {
        constructor() { onVad() }
        stream(): EmptyVadStream { return new EmptyVadStream() }
        close(): Promise<void> { return Promise.resolve() }
      },
      TurnDetector: class {
        readonly model = 'v1-mini'
        supportsLanguage(): Promise<boolean> { return Promise.resolve(true) }
        unlikelyThreshold(): Promise<number> { return Promise.resolve(0.1) }
        stream(): {
          readonly model: string
          pushAudio(): void
          predict(): {readonly await: Promise<{readonly endOfTurnProbability: number}>}
          aclose(): Promise<void>
        } {
          return {
            model: 'v1-mini', pushAudio: () => undefined,
            predict: () => ({await: Promise.resolve({endOfTurnProbability: 0})}),
            aclose: () => Promise.resolve(),
          }
        }
        aclose(): Promise<void> { return Promise.resolve() }
      },
    },
    AudioByteStream: class {
      write(): readonly never[] { return [] }
      flush(): readonly never[] { return [] }
    },
    VADEventType: {START_OF_SPEECH: 0, INFERENCE_DONE: 1, END_OF_SPEECH: 2},
  }
}

const MODEL_PROBE_MANIFEST = executorManifestSchema.parse({
  name: 'fast_sim',
  policy: handoffPolicySchema.parse({
    channel: 'fast_sim', priority: 50, wake: 'surrogate', typical_latency: 1,
    compress_watermark: 1,
  }),
  ops: [{
    name: 'run', description: 'run model probes',
    params: {type: 'object', properties: {}, additionalProperties: false},
    readonly: true, deadline_budget: 5,
  }],
})

const modelProbeAdapter: ExecutorAdapter = {
  manifest: MODEL_PROBE_MANIFEST,
  dispatch: () => Promise.resolve({
    outcome: 'ok', trust: 'trusted_system', content: {done: true}, refs: [],
  }),
}

interface GatewayRequest {
  readonly endpoint: string
  readonly authorization: string
  readonly model: string
  readonly role: 'gateway' | 'watch' | 'surrogate' | 'compressor'
}

function installRecordingFetch(records: GatewayRequest[]): () => void {
  const previous = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      readonly model?: string
      readonly response_format?: unknown
      readonly messages?: readonly {readonly content?: unknown}[]
    }
    const serialized = JSON.stringify(body.messages ?? [])
    const role = serialized.includes('image_url') ? 'watch'
      : body.response_format !== undefined ? 'surrogate'
        : body.model === 'gateway-probe' ? 'gateway' : 'compressor'
    records.push({
      endpoint: typeof input === 'string' ? input
        : input instanceof URL ? input.href : input.url,
      authorization: new Headers(init?.headers).get('authorization') ?? '',
      model: body.model ?? '', role,
    })
    const content = role === 'watch'
      ? JSON.stringify({hit: false, observation: ''})
      : JSON.stringify({speak: false, suggestion_id: null, reason: 'quiet'})
    return Promise.resolve(new Response(JSON.stringify({
      id: 'gateway-response',
      choices: [{finish_reason: 'stop', message: {content}}],
      usage: {prompt_tokens: 1, completion_tokens: 1},
    }), {status: 200, headers: {'content-type': 'application/json'}}))
  }
  return () => { globalThis.fetch = previous }
}

function watchContext(clock: VirtualClock): ExecutorDispatchContext {
  return {
    clock,
    delegate: delegateSchema.parse({
      delegate_id: 'watch-model-probe', executor: 'watch', op: 'start', request: {},
      origin_ref: 'conversation:1', deadline: 60, routing_class: 'user_awaited',
      dispatched_at: 0,
    }),
    signal: new AbortController().signal,
    progress: () => undefined,
    observe: () => undefined,
  }
}

async function exerciseCoreModels(
  realtime: ReturnType<typeof buildVolcengineRealtimeAssembly>,
  records: GatewayRequest[],
): Promise<void> {
  await realtime.core.gateway.complete({model: 'gateway-probe', system: 'system', prompt: 'prompt'})
  const watch = realtime.runtime.executors.get('watch')
  assert.ok(watch instanceof WatchAdapter)
  const clock = realtime.runtime.clock
  assert.ok(clock instanceof VirtualClock)
  const context = watchContext(clock)
  const watching = watch.dispatch(
    'start', {condition: 'no movement', interval_s: 2, duration_s: 30}, context,
  )
  await waitFor('watch model request', () => watch.status.samples === 1)
  await watch.dispatch('stop', {}, context)
  watch.interruptForTest()
  await settleNamed('watch model probe', watching)

  const origin = realtime.runtime.core.memory.append('conversation', {
    ts: 0, trust: 'trusted_user', priority: 100, content: {text: 'probe models'},
  })
  const stop = new AbortController()
  const serving = realtime.runtime.serve(stop.signal)
  const admitted = realtime.runtime.dispatchExternal({
    executor: 'fast_sim', op: 'run', request: {},
    origin_ref: `${origin.channel}:${origin.seq}`,
  }, {
    kind: 'realtime_tool', priority: 100, routing_class: 'ambient',
    origin: null, selected_suggestion: null,
  })
  assert.equal(admitted.accepted, true)
  await waitFor('surrogate and compressor model requests', () => (
    records.some(record => record.role === 'surrogate')
    && records.some(record => record.role === 'compressor')
  ))
  stop.abort()
  await settleNamed('model probe runtime', serving)
}

test('Volc owner resolves endpointing before epoch resources and reconnects monotonically', async () => {
  const operations: string[] = []
  let ids = 0
  const provider = testProvider({
    config: requireVolcengineRealtime(settings()),
    endpointingCapability: () => {
      operations.push('capability')
      return Promise.resolve({result: fallback('executor_unavailable')})
    },
    asrClient: () => {
      operations.push('asr.client')
      return {open: () => Promise.reject(new Error('ASR open was not expected'))}
    },
    ttsClient: () => {
      operations.push('tts.client')
      return {open: () => Promise.reject(new Error('TTS open was not expected'))}
    },
    arkFactory: () => {
      operations.push('ark.client')
      return new EmptyArk(operations)
    },
    idFactory: () => `volc-owner-${++ids}`,
  })

  assert.deepEqual(operations, [])
  const first = await provider.connect({tools: [], signal: new AbortController().signal})
  assert.deepEqual(operations.slice(0, 4), [
    'capability', 'asr.client', 'ark.client', 'tts.client',
  ])
  assert.equal(first.epoch, 1)
  await provider.close()

  const second = await provider.connect({tools: [], signal: new AbortController().signal})
  assert.equal(second.epoch, 2)
  assert.equal(operations.filter(value => value === 'capability').length, 2)
  assert.equal(operations.filter(value => value === 'asr.client').length, 2)
  assert.equal(operations.filter(value => value === 'tts.client').length, 2)
  assert.equal(operations.filter(value => value === 'ark.client').length, 2)
  await provider.close()
})

test('close owns an in-flight capability resolution and prevents late resource construction',
  async () => {
    const gate = deferred<{readonly result: EndpointingCapabilityResult}>()
    let resources = 0
    const provider = testProvider({
      config: requireVolcengineRealtime(settings()),
      endpointingCapability: () => gate.promise,
      asrClient: () => { resources += 1; return {open: () => Promise.reject(new Error('unused'))} },
      ttsClient: () => { resources += 1; return {open: () => Promise.reject(new Error('unused'))} },
      arkFactory: () => { resources += 1; return new EmptyArk([]) },
      idFactory: () => 'volc-close-owner',
    })
    const connecting = provider.connect({tools: [], signal: new AbortController().signal})
    await new Promise(resolve => setImmediate(resolve))
    let closeSettled = false
    const closing = provider.close().then(() => { closeSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closeSettled, false)
    await assert.rejects(
      provider.connect({tools: [], signal: new AbortController().signal}),
      error => error instanceof CascadedRealtimeError && error.code === 'state',
    )

    gate.resolve({result: fallback('executor_unavailable')})
    await assert.rejects(connecting, {name: 'AbortError'})
    await closing
    assert.equal(resources, 0)
  })

test('ready selects LiveKit while every unavailable result stays on bounded silence', async () => {
  let liveVad = 0
  const liveProvider = testProvider({
    config: requireVolcengineRealtime(settings()),
    endpointingCapability: () => Promise.resolve({
      result: {
        schema_version: 1, mode: 'livekit_v1_mini',
        eot: {available: true, reason: 'ready'}, vad: {available: true, reason: 'ready'},
        platform: 'darwin', arch: 'arm64',
      },
      surface: readySurface(() => { liveVad += 1 }),
      executor: {} as LiveKitExecutor,
    }),
    asrClient: () => ({open: () => Promise.reject(new Error('unused'))}),
    ttsClient: () => ({open: () => Promise.reject(new Error('unused'))}),
    arkFactory: () => new EmptyArk([]),
    idFactory: () => 'volc-ready',
  })
  await liveProvider.connect({tools: [], signal: new AbortController().signal})
  assert.equal(liveVad, 1)
  await liveProvider.close()

  const reasons: readonly EndpointingCapabilityReason[] = [
    'unsupported_platform', 'package_unavailable', 'native_unavailable',
    'executor_unavailable', 'model_unavailable', 'timeout', 'inconclusive', 'aborted',
  ]
  for (const reason of reasons) {
    let asrOpens = 0
    const provider = testProvider({
      config: requireVolcengineRealtime(settings()),
      endpointingCapability: () => Promise.resolve({result: fallback(reason)}),
      asrClient: () => ({open: () => { asrOpens += 1; return Promise.reject(new Error('unused')) }}),
      ttsClient: () => ({open: () => Promise.reject(new Error('unused'))}),
      arkFactory: () => new EmptyArk([]),
      idFactory: () => `volc-${reason}`,
    })
    await provider.connect({tools: [], signal: new AbortController().signal})
    await provider.sendAudio(new Uint8Array(1_024), new AbortController().signal)
    assert.equal(asrOpens, 0, reason)
    await provider.close()
  }
})

test('failed epoch construction rolls back and a later connect builds fresh resources', async () => {
  let capabilities = 0
  let asrClients = 0
  let ttsClients = 0
  let arkAttempts = 0
  const provider = testProvider({
    config: requireVolcengineRealtime(settings()),
    endpointingCapability: () => {
      capabilities += 1
      return Promise.resolve({result: fallback('executor_unavailable')})
    },
    asrClient: () => { asrClients += 1; return {open: () => Promise.reject(new Error('unused'))} },
    ttsClient: () => { ttsClients += 1; return {open: () => Promise.reject(new Error('unused'))} },
    arkFactory: () => {
      arkAttempts += 1
      if (arkAttempts === 1) throw new Error('private provider failure')
      return new EmptyArk([])
    },
    idFactory: () => `volc-rollback-${arkAttempts}`,
  })

  await assert.rejects(
    provider.connect({tools: [], signal: new AbortController().signal}),
    error => error instanceof CascadedRealtimeError && error.code === 'configuration',
  )
  const identity = await provider.connect({tools: [], signal: new AbortController().signal})
  assert.equal(identity.epoch, 1)
  assert.deepEqual({capabilities, asrClients, ttsClients, arkAttempts}, {
    capabilities: 2, asrClients: 2, ttsClients: 1, arkAttempts: 2,
  })
  await provider.close()
})

function assemblyOptions(
  configured: Settings,
  overrides: Partial<BuildVolcengineRealtimeAssemblyOptions> = {},
): BuildVolcengineRealtimeAssemblyOptions {
  return {
    settings: configured,
    searchTransport: {search: () => Promise.reject(new Error('search was not expected'))},
    endpointingCapability: () => Promise.resolve({result: fallback('executor_unavailable')}),
    asrClient: () => ({open: () => Promise.reject(new Error('ASR open was not expected'))}),
    ttsClient: () => ({open: () => Promise.reject(new Error('TTS open was not expected'))}),
    arkFactory: () => new EmptyArk([]),
    metrics: {record: () => undefined},
    onDiagnostic: () => undefined,
    ...overrides,
  }
}

test('Volc assembly preserves one graph, shared resources, and frozen Guard policy', async () => {
  const operations: string[] = []
  const clock = new VirtualClock(10)
  const ids = new RecordingIds()
  const frameSource = new RecordingFrameSource()
  const mediaStore = new MediaStore()
  let telemetryCloses = 0
  const configured = settings({
    NOVA_AUDIO_AGENT_MODEL_API_KEY: 'generic-model-key',
    NOVA_AUDIO_AGENT_VOLCENGINE_ARK_MODEL: 'ark-realtime-distinct',
    NOVA_AUDIO_AGENT_VOLCENGINE_ARK_SUPPORT_MODEL: 'ark-support-distinct',
    NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT: 'true',
    NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_RECOVERY: 'packed',
    NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS: '1',
  })
  const realtime = buildVolcengineRealtimeAssembly(assemblyOptions(configured, {
    clock, ids, frameSource, mediaStore,
    telemetry: {record: () => undefined, close: () => { telemetryCloses += 1 }},
    endpointingCapability: () => {
      operations.push('capability')
      return Promise.resolve({result: fallback('executor_unavailable')})
    },
    asrClient: () => { operations.push('asr'); return {open: () => Promise.reject(new Error('unused'))} },
    ttsClient: () => { operations.push('tts'); return {open: () => Promise.reject(new Error('unused'))} },
    arkFactory: ({config}) => {
      operations.push(`ark:${config.arkModel}`)
      return new EmptyArk(operations)
    },
  }))

  assert.deepEqual(operations, [])
  assert.ok(realtime.provider instanceof CascadedRealtimeProvider)
  assert.equal(realtime.core.runtime.clock, clock)
  assert.equal(realtime.core.frameSource, frameSource)
  assert.equal(realtime.core.mediaStore, mediaStore)
  assert.equal(realtime.service.session, realtime.session)
  assert.equal(realtime.service.internals.runtime, realtime.runtime)
  assert.equal(realtime.service.internals.tools, realtime.tools)
  assert.equal(realtime.tools.bindings.has('memory__recall'), true)
  assert.deepEqual([...realtime.runtime.executors.keys()].slice(0, 4), [
    'search', 'cam', 'watch', 'guard',
  ])
  assert.deepEqual(realtime.service.guardConfiguration, {
    controlledReconnect: false, historyRecovery: 'none', historyPairs: 4,
  })

  let serveCalls = 0
  const originalServe = realtime.runtime.serve.bind(realtime.runtime)
  Object.defineProperty(realtime.runtime, 'serve', {
    configurable: true,
    value: (signal: AbortSignal): Promise<void> => { serveCalls += 1; return originalServe(signal) },
  })
  const first = realtime.start()
  const second = realtime.start()
  assert.equal(first, second)
  await settleNamed('Volc assembly start', Promise.all([first, second]))
  assert.deepEqual(operations.slice(0, 4), [
    'capability', 'asr', 'tts', 'ark:ark-realtime-distinct',
  ])
  assert.equal(serveCalls, 1)
  assert.equal(frameSource.starts, 1)
  assert.ok(ids.calls.includes('volcengine'))
  await settleNamed('Volc assembly stop', realtime.stop())
  await settleNamed('Volc assembly repeated stop', realtime.stop())
  assert.equal(frameSource.stops, 1)
  assert.equal(telemetryCloses, 0)
})

test('Volc credentials validate before composition-only resource mismatches', () => {
  const configured = settings({
    ARK_API_KEY: '',
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
  })
  assert.throws(
    () => buildVolcengineRealtimeAssembly(assemblyOptions(configured)),
    error => error instanceof ConfigurationError && error.message === '缺少 ARK_API_KEY',
  )
})

test('core gateway preserves generic models or applies all Ark support overrides immutably',
  async () => {
    const cases = [
      {
        name: 'generic',
        environment: {
          NOVA_AUDIO_AGENT_MODEL_API_KEY: 'generic-safe-key',
          NOVA_AUDIO_AGENT_MODEL_BASE_URL: 'https://generic.example/v9',
        },
        endpoint: 'https://generic.example/v9/chat/completions',
        authorization: 'Bearer generic-safe-key',
        models: {watch: 'watch-original', surrogate: 'surrogate-original', compressor: 'compressor-original'},
      },
      {
        name: 'Python-whitespace Ark fallback',
        environment: {
          NOVA_AUDIO_AGENT_MODEL_API_KEY: '\u001c\u0085',
          NOVA_AUDIO_AGENT_MODEL_BASE_URL: 'https://generic.example/v9',
        },
        endpoint: 'https://ark-support.example/api/v3/chat/completions',
        authorization: 'Bearer ark-test-key',
        models: {watch: 'ark-support-distinct', surrogate: 'ark-support-distinct', compressor: 'ark-support-distinct'},
      },
    ] as const
    for (const scenario of cases) {
      const records: GatewayRequest[] = []
      const restoreFetch = installRecordingFetch(records)
      const configured = settings({
        NOVA_AUDIO_AGENT_FAST_MODEL: 'fast-original',
        NOVA_AUDIO_AGENT_WATCH_MODEL: 'watch-original',
        NOVA_AUDIO_AGENT_SURROGATE_MODEL: 'surrogate-original',
        NOVA_AUDIO_AGENT_COMPRESSOR_MODEL: 'compressor-original',
        NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL: 'https://ark-support.example/api/v3',
        NOVA_AUDIO_AGENT_VOLCENGINE_ARK_MODEL: 'ark-realtime-distinct',
        NOVA_AUDIO_AGENT_VOLCENGINE_ARK_SUPPORT_MODEL: 'ark-support-distinct',
        ...scenario.environment,
      })
      const beforeModels = {
        fast: configured.fast_model,
        watch: configured.watch_model,
        surrogate: configured.surrogate_model,
        compressor: configured.compressor_model,
      }
      let realtime: ReturnType<typeof buildVolcengineRealtimeAssembly>
      try {
        realtime = buildVolcengineRealtimeAssembly(assemblyOptions(configured, {
          clock: new VirtualClock(),
          frameSource: new RecordingFrameSource(),
          executors: [modelProbeAdapter],
        }))
      } finally {
        restoreFetch()
      }
      await exerciseCoreModels(realtime, records)
      assert.deepEqual({
        fast: configured.fast_model,
        watch: configured.watch_model,
        surrogate: configured.surrogate_model,
        compressor: configured.compressor_model,
      }, beforeModels, scenario.name)
      assert.deepEqual(records.map(record => record.role).sort(), [
        'compressor', 'gateway', 'surrogate', 'watch',
      ])
      for (const record of records) {
        assert.equal(record.endpoint, scenario.endpoint, `${scenario.name}:${record.role}`)
        assert.equal(record.authorization, scenario.authorization, `${scenario.name}:${record.role}`)
        if (record.role !== 'gateway') assert.equal(record.model, scenario.models[record.role])
      }
      assert.equal(configured.fast_model, 'fast-original')
    }
  })
