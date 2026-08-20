import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAssembly } from '../src/assembly.js'
import { VirtualClock } from '../src/clock.js'
import { ConfigurationError, loadSettings, type Settings } from '../src/config.js'
import type { Frame, FrameSource } from '../src/executors/watcher.js'
import type { SearchTransport } from '../src/executors/search.js'
import type { IdFactory } from '../src/ids.js'
import type {
  CompleteRequest,
  GatewayCompletion,
  GatewayDelta,
  ModelGateway,
  StreamRequest,
} from '../src/model-gateway.js'
import {
  buildQwenRealtimeAssembly,
  type BuildQwenRealtimeAssemblyOptions,
} from '../src/qwen-realtime-assembly.js'
import {
  QwenAudioRealtimeAdapter,
  QwenSocketClosedError,
  type QwenConnector,
  type QwenConnectorOptions,
  type QwenSocket,
} from '../src/realtime/qwen.js'
import type { CompiledTools } from '../src/tool-schema.js'

async function settleNamed<T>(
  name: string,
  promise: Promise<T>,
  timeoutMs = 1_500,
): Promise<T> {
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

  start(): Promise<void> {
    this.starts += 1
    return Promise.resolve()
  }

  stop(): Promise<void> {
    this.stops += 1
    return Promise.resolve()
  }

  snapshot(): Promise<Frame | null> {
    return Promise.resolve(null)
  }
}

class NeverSearch implements SearchTransport {
  search(): Promise<Record<string, unknown>> {
    return Promise.reject(new Error('search was not expected'))
  }
}

class NeverGateway implements ModelGateway {
  async *stream(request: StreamRequest): AsyncIterable<GatewayDelta> {
    void request
    await Promise.resolve()
    throw new Error('fast gateway path reached')
  }

  complete(request: CompleteRequest): Promise<GatewayCompletion> {
    void request
    return Promise.reject(new Error('completion was not expected'))
  }
}

class HandshakeSocket implements QwenSocket {
  readonly sent: string[] = []
  readonly #messages: string[]
  #closed = false
  #parkedReject: ((error: Error) => void) | undefined

  constructor(sessionId: string) {
    this.#messages = [
      JSON.stringify({type: 'session.created', session: {id: sessionId}}),
      JSON.stringify({type: 'session.updated', session: {id: sessionId}}),
    ]
  }

  send(payload: string): Promise<void> {
    this.sent.push(payload)
    return Promise.resolve()
  }

  receive(): Promise<string> {
    const message = this.#messages.shift()
    if (message !== undefined) return Promise.resolve(message)
    if (this.#closed) return Promise.reject(new QwenSocketClosedError())
    return new Promise<string>((_resolve, reject) => { this.#parkedReject = reject })
  }

  close(): Promise<void> {
    this.#closed = true
    this.#parkedReject?.(new QwenSocketClosedError())
    this.#parkedReject = undefined
    return Promise.resolve()
  }
}

interface RecordingConnector {
  readonly connector: QwenConnector
  readonly calls: QwenConnectorOptions[]
  readonly sockets: HandshakeSocket[]
}

function recordingConnector(options: {readonly failFirstWith?: Error} = {}): RecordingConnector {
  const calls: QwenConnectorOptions[] = []
  const sockets: HandshakeSocket[] = []
  let remainingFailures = options.failFirstWith === undefined ? 0 : 1
  const firstFailure = options.failFirstWith
  const connector: QwenConnector = input => {
    calls.push(input)
    if (remainingFailures > 0) {
      remainingFailures -= 1
      return Promise.reject(firstFailure ?? new Error('recording connector failed'))
    }
    const socket = new HandshakeSocket(`session-${calls.length}`)
    sockets.push(socket)
    return Promise.resolve(socket)
  }
  return {connector, calls, sockets}
}

function settings(environment: NodeJS.ProcessEnv = {}): Settings {
  return loadSettings({
    TAVILY_API_KEY: 'tavily-test-key',
    ...environment,
  })
}

function qwenOptions(
  configured: Settings,
  connector: QwenConnector,
  overrides: Partial<BuildQwenRealtimeAssemblyOptions> = {},
): BuildQwenRealtimeAssemblyOptions {
  return {
    settings: configured,
    connector,
    searchTransport: new NeverSearch(),
    frameSource: new RecordingFrameSource(),
    metrics: {record: () => undefined},
    onDiagnostic: () => undefined,
    ...overrides,
  }
}

function installRecordingFetch(authorizations: string[]): () => void {
  const previous = globalThis.fetch
  globalThis.fetch = (_input, init) => {
    const headers = new Headers(init?.headers)
    authorizations.push(headers.get('authorization') ?? '')
    return Promise.resolve(new Response(JSON.stringify({
      id: 'gateway-response',
      choices: [{finish_reason: 'stop', message: {content: '{}'}}],
      usage: {prompt_tokens: 1, completion_tokens: 1},
    }), {status: 200, headers: {'content-type': 'application/json'}}))
  }
  return () => { globalThis.fetch = previous }
}

async function exerciseGateway(gateway: ModelGateway): Promise<void> {
  await gateway.complete({
    model: 'gateway-test',
    system: 'system',
    prompt: 'prompt',
  })
}

test('Qwen factory builds a realtime-frontbrain core while ordinary assembly keeps fast', () => {
  const connector = recordingConnector()
  const realtime = buildQwenRealtimeAssembly(qwenOptions(
    settings({NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key'}),
    connector.connector,
  ))
  const qwenBindings = realtime.tools.bindings
  assert.equal(qwenBindings.has('memory__recall'), true)
  assert.deepEqual([...realtime.core.runtime.executors.keys()].slice(0, 4), [
    'search', 'cam', 'watch', 'guard',
  ])
  const qwenInput = realtime.runtime.core.post({kind: 'user_input', payload: {text: 'hello'}}, 0)
  realtime.runtime.core.apply(qwenInput)
  assert.equal(realtime.runtime.core.slots.inflight.fast, false)

  const ordinary = buildAssembly({
    settings: settings({NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key'}),
    gateway: new NeverGateway(),
    searchTransport: new NeverSearch(),
  })
  assert.equal(ordinary.tools.bindings.has('memory__recall'), false)
  const ordinaryInput = ordinary.runtime.core.post({kind: 'user_input', payload: {text: 'hello'}}, 0)
  ordinary.runtime.core.apply(ordinaryInput)
  assert.equal(ordinary.runtime.core.slots.inflight.fast, true)
  assert.equal(connector.calls.length, 0)
})

test('Qwen factory preserves resource identity, explicit Guard settings, and one start path', async () => {
  const connector = recordingConnector()
  const clock = new VirtualClock(10)
  const ids = new RecordingIds()
  const frame = new RecordingFrameSource()
  const realtime = buildQwenRealtimeAssembly(qwenOptions(settings({
    NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key',
    DASHSCOPE_API_KEY: 'dash-key',
    NOVA_AUDIO_AGENT_QWEN_REALTIME_URL: 'wss://qwen.example/realtime',
    NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL: 'qwen-test',
    NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE: 'voice-test',
    NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT: 'true',
    NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_RECOVERY: 'packed',
    NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS: '1',
  }), connector.connector, {clock, ids, frameSource: frame}))

  assert.ok(realtime.provider instanceof QwenAudioRealtimeAdapter)
  assert.equal(realtime.core.runtime.clock, clock)
  assert.equal(realtime.service.session, realtime.session)
  assert.equal(realtime.service.internals.runtime, realtime.runtime)
  assert.equal(realtime.service.internals.tools, realtime.tools)
  assert.deepEqual(realtime.service.guardConfiguration, {
    controlledReconnect: true,
    historyRecovery: 'packed',
    historyPairs: 1,
  })
  assert.equal(connector.calls.length, 0)
  realtime.playback.openResponse({sessionEpoch: 1, responseId: 'identity'})
  assert.ok(ids.calls.includes('realtime'))

  let serveCalls = 0
  const originalServe = realtime.runtime.serve.bind(realtime.runtime)
  Object.defineProperty(realtime.runtime, 'serve', {
    configurable: true,
    value: (signal: AbortSignal): Promise<void> => {
      serveCalls += 1
      return originalServe(signal)
    },
  })
  const firstStart = realtime.start()
  const secondStart = realtime.start()
  assert.equal(firstStart, secondStart)
  await settleNamed('shared Qwen factory start', Promise.all([firstStart, secondStart]))
  assert.equal(connector.calls.length, 1)
  assert.equal(serveCalls, 1)
  assert.equal(frame.starts, 1)
  assert.equal(connector.calls[0]?.endpoint, 'wss://qwen.example/realtime?model=qwen-test')
  assert.equal(connector.calls[0]?.headers.Authorization, 'Bearer dash-key')
  const update = JSON.parse(connector.sockets[0]?.sent[0] ?? '{}') as {
    readonly session?: {readonly voice?: string}
  }
  assert.equal(update.session?.voice, 'voice-test')
  assert.ok(ids.calls.includes('qwen'))

  await settleNamed('Qwen factory stop', realtime.stop())
  assert.equal(frame.stops, 1)
})

test('Qwen factory passes default and every Guard history pair arm to the service', () => {
  const defaults = buildQwenRealtimeAssembly(qwenOptions(
    settings({NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key'}),
    recordingConnector().connector,
  ))
  assert.deepEqual(defaults.service.guardConfiguration, {
    controlledReconnect: false,
    historyRecovery: 'none',
    historyPairs: 4,
  })
  for (const pairs of ['1', '2', '4']) {
    const realtime = buildQwenRealtimeAssembly(qwenOptions(settings({
      NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key',
      NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT: 'true',
      NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_RECOVERY: 'packed',
      NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS: pairs,
    }), recordingConnector().connector))
    assert.deepEqual(realtime.service.guardConfiguration, {
      controlledReconnect: true,
      historyRecovery: 'packed',
      historyPairs: Number(pairs),
    })
  }
})

test('Qwen factory keeps websocket and model-gateway credential priorities distinct', async () => {
  const cases = [
    {
      name: 'both',
      environment: {
        DASHSCOPE_API_KEY: 'dash-key',
        NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key',
      },
      websocket: 'dash-key',
      gateway: 'model-key',
    },
    {
      name: 'model only',
      environment: {NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key'},
      websocket: 'model-key',
      gateway: 'model-key',
    },
    {
      name: 'DashScope only',
      environment: {DASHSCOPE_API_KEY: 'dash-key'},
      websocket: 'dash-key',
      gateway: 'dash-key',
    },
    {
      name: 'Python-whitespace DashScope',
      environment: {
        DASHSCOPE_API_KEY: '\u001c\u0085',
        NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key',
      },
      websocket: 'model-key',
      gateway: 'model-key',
    },
  ] as const
  for (const scenario of cases) {
    const authorizations: string[] = []
    const restoreFetch = installRecordingFetch(authorizations)
    const connector = recordingConnector()
    let realtime
    try {
      realtime = buildQwenRealtimeAssembly(qwenOptions(
        settings(scenario.environment),
        connector.connector,
      ))
    } finally {
      restoreFetch()
    }
    await exerciseGateway(realtime.core.gateway)
    await settleNamed(`${scenario.name} start`, realtime.start())
    assert.equal(connector.calls[0]?.headers.Authorization, `Bearer ${scenario.websocket}`)
    assert.deepEqual(authorizations, [`Bearer ${scenario.gateway}`])
    await settleNamed(`${scenario.name} stop`, realtime.stop())
  }
})

test('Qwen factory forwards only the reviewed provider tool subset', async () => {
  const connector = recordingConnector()
  const realtime = buildQwenRealtimeAssembly(qwenOptions(
    settings({NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key'}),
    connector.connector,
    {providerToolView: tools => ({schemas: tools.schemas.slice(0, 2), bindings: tools.bindings})},
  ))
  await settleNamed('subset Qwen start', realtime.start())
  const update = JSON.parse(connector.sockets[0]?.sent[0] ?? '{}') as {
    readonly session?: {readonly tools?: readonly unknown[]}
  }
  assert.deepEqual(update.session?.tools, realtime.tools.schemas.slice(0, 2))
  assert.equal(realtime.service.internals.tools.bindings, realtime.tools.bindings)
  await settleNamed('subset Qwen stop', realtime.stop())

  const copiedBindings = (tools: CompiledTools): CompiledTools => ({
    schemas: tools.schemas,
    bindings: new Map(tools.bindings),
  })
  assert.throws(
    () => buildQwenRealtimeAssembly(qwenOptions(
      settings({NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key'}),
      connector.connector,
      {providerToolView: copiedBindings},
    )),
    /provider tool view must reuse core tool bindings/u,
  )
  assert.equal(connector.calls.length, 1)
})

test('Qwen factory validates synchronously without connecting or leaking secrets', () => {
  const connector = recordingConnector()
  const sentinel = 'synchronous-sentinel-secret'
  assert.throws(
    () => buildQwenRealtimeAssembly(qwenOptions(settings({
      NOVA_AUDIO_AGENT_MODEL_API_KEY: sentinel,
      NOVA_AUDIO_AGENT_QWEN_REALTIME_URL: `https://invalid/?secret=${sentinel}`,
    }), connector.connector)),
    error => error instanceof ConfigurationError
      && error.message === 'NOVA_AUDIO_AGENT_QWEN_REALTIME_URL 必须使用 wss://'
      && !error.message.includes(sentinel),
  )
  assert.equal(connector.calls.length, 0)
})

test('Qwen connector failure rolls core back safely and permits one later retry', async () => {
  const sentinel = 'connector-sentinel-secret'
  const connector = recordingConnector({failFirstWith: new Error(
    `failed endpoint wss://example.invalid/?credential=${sentinel}`,
  )})
  const frame = new RecordingFrameSource()
  const realtime = buildQwenRealtimeAssembly(qwenOptions(
    settings({NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key'}),
    connector.connector,
    {frameSource: frame},
  ))

  await assert.rejects(
    settleNamed('first failing Qwen start', realtime.start()),
    error => error instanceof Error && !error.message.includes(sentinel),
  )
  assert.equal(frame.starts, 1)
  assert.equal(frame.stops, 1)
  assert.equal(connector.calls.length, 1)

  await settleNamed('retried Qwen start', realtime.start())
  assert.equal(frame.starts, 2)
  assert.equal(connector.calls.length, 2)
  await settleNamed('retried Qwen stop', realtime.stop())
  assert.equal(frame.stops, 2)
})
