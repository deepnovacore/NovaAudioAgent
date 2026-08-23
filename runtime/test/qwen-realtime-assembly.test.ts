import assert from 'node:assert/strict'
import {chmod, mkdtemp, readFile, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import { test } from 'node:test'
import { buildAssembly } from '../src/assembly.js'
import type {CodexAssemblyResource} from '../src/codex-factory.js'
import type {
  CodexAppServerTransport,
  SafePreflightReport,
  SteerTransportResult,
  TransportOutcome,
} from '../src/codex-app-server-transport.js'
import { VirtualClock } from '../src/clock.js'
import { ConfigurationError, loadSettings, type Settings } from '../src/config.js'
import {buildDesktopRealtimeComposition} from '../src/desktop-service.js'
import type {CapturedCameraFrame} from '../src/desktop.js'
import {ChromiumFrameSource} from '../src/executors/chromium-frame-source.js'
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
  workspaceGraphFrontendInstructions,
  type QwenConnector,
  type QwenConnectorOptions,
  type QwenSocket,
} from '../src/realtime/qwen.js'
import type { CompiledTools } from '../src/tool-schema.js'
import {CodexLiveAdapter} from '../src/executors/codex-live.js'

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

function deferred<T = void>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined
  const promise = new Promise<T>(promiseResolve => { resolve = promiseResolve })
  return {promise, resolve: resolve!}
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

class CompositionCodexTransport implements CodexAppServerTransport {
  preflight(): Promise<SafePreflightReport> {
    return Promise.resolve({
      version: '0.145.0', root_matches: true, mount: 'workspace_only',
      subprocess: 'contained', network: 'blocked',
    })
  }
  prewarm(): Promise<SafePreflightReport | null> {
    return Promise.resolve(null)
  }
  run(): Promise<TransportOutcome> {
    return Promise.reject(new Error('Codex run was not expected'))
  }
  steer(): Promise<SteerTransportResult> {
    return Promise.resolve({code: 'no_active_turn', written: false})
  }
  close(): Promise<void> { return Promise.resolve() }
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
  assert.equal(realtime.workspaceGraph, undefined)

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

test('Qwen factory owns enabled graph storage while unsafe graph config stays voice-only', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-qwen-graph-')))
  try {
    await chmod(root, 0o700)
    const connector = recordingConnector()
    const enabled = buildQwenRealtimeAssembly(qwenOptions(settings({
      NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key',
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED: 'true',
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH: join(root, 'graph.sqlite'),
    }), connector.connector))
    assert.ok(enabled.workspaceGraph !== undefined)
    await enabled.start()
    const update = JSON.parse(connector.sockets[0]?.sent[0] ?? '{}') as {
      readonly session?: {readonly instructions?: string}
    }
    assert.equal(update.session?.instructions, workspaceGraphFrontendInstructions)
    await enabled.stop()

    const diagnostics: string[] = []
    const unsafeConnector = recordingConnector()
    const unsafe = buildQwenRealtimeAssembly(qwenOptions(settings({
      NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key',
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED: 'true',
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH: '/private/tmp/sensitive-graph.sqlite',
    }), unsafeConnector.connector, {
      onDiagnostic: line => { diagnostics.push(line) },
    }))
    assert.equal(unsafe.workspaceGraph, undefined)
    assert.deepEqual(diagnostics, [
      '[realtime-diagnostic] workspace_graph_configuration_invalid',
    ])
    await unsafe.start()
    assert.equal(unsafeConnector.calls.length, 1)
    await unsafe.stop()
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('Qwen factory construction does not invoke an unrelated LiveKit agents loader', () => {
  const connector = recordingConnector()
  let agentsLoaderCalls = 0
  const input = {
    ...qwenOptions(
      settings({NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key'}),
      connector.connector,
    ),
    agentsLoader: () => {
      agentsLoaderCalls += 1
      return Promise.reject(new Error('LiveKit agents loader was not expected'))
    },
  }

  buildQwenRealtimeAssembly(input)

  assert.equal(agentsLoaderCalls, 0)
  assert.equal(connector.calls.length, 0)
})

test('Qwen composition registers the exact Codex resource and starts prewarm after service', async () => {
  const connector = recordingConnector()
  const adapter = new CodexLiveAdapter(new CompositionCodexTransport())
  const prewarmEntered = deferred<void>()
  const prewarmGate = deferred<void>()
  let closes = 0
  const resource: CodexAssemblyResource = {
    adapter,
    mode: 'live',
    projectView: null,
    start: () => {
      prewarmEntered.resolve()
      return prewarmGate.promise
    },
    close: () => { closes += 1; return adapter.close() },
  }
  const input = {
    ...qwenOptions(settings({
      NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key',
      NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    }), connector.connector),
    codexResource: resource,
  }
  const realtime = buildQwenRealtimeAssembly(input)
  assert.equal(realtime.runtime.executors.get('codex'), adapter)

  const starting = realtime.start()
  await settleNamed('provider service before Codex prewarm', prewarmEntered.promise)
  await settleNamed('Codex prewarm does not delay realtime start', starting)
  assert.equal(connector.calls.length, 1)

  prewarmGate.resolve()
  await realtime.stop()
  assert.equal(closes, 1)
})

test('desktop entry leaves Codex prewarm to the realtime owner instead of blocking readiness', async () => {
  const entry = await readFile(resolve(import.meta.dirname, '../../src/desktop-entry.ts'), 'utf8')
  assert.match(entry, /ownership\.own\(\(\) => codexResource\.close\(\)\)/u)
  assert.doesNotMatch(entry, /await codexResource\.start\(\)/u)
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

test('desktop Qwen composition shares one clock, Chromium source, and camera server owner', async () => {
  const connector = recordingConnector()
  const clock = new VirtualClock(5)
  const stop = new AbortController()
  const captures: unknown[] = []
  let source: ChromiumFrameSource | undefined
  const server = {
    sendText: () => Promise.resolve(),
    sendBinary: () => Promise.resolve(),
    disconnectClient: () => Promise.resolve(),
    start: () => Promise.resolve({
      token: '0123456789abcdef0123456789abcdef' as const,
      host: '127.0.0.1' as const,
      port: 43123,
    }),
    close: () => Promise.resolve(),
    captureCamera: (request: unknown): Promise<CapturedCameraFrame> => {
      captures.push(request)
      return Promise.resolve({
        payload: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        media_type: 'image/jpeg',
        width: 1280,
        height: 720,
      })
    },
  }
  const composition = buildDesktopRealtimeComposition({
    token: '0123456789abcdef0123456789abcdef',
    stop,
    createServer: () => server,
    buildRealtime: (callbacks, transport) => {
      source = new ChromiumFrameSource({source: 'file', transport, clock})
      return buildQwenRealtimeAssembly(qwenOptions(
        settings({NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key'}),
        connector.connector,
        {clock, frameSource: source, ...callbacks},
      ))
    },
  })
  assert.ok(source !== undefined)
  assert.equal(composition.realtime.core.frameSource, source)
  assert.equal(composition.realtime.runtime.clock, clock)
  assert.equal(composition.desktop.server, server)

  await settleNamed('desktop Qwen start before renderer', composition.realtime.start())
  assert.deepEqual(captures, [], 'source start does not capture before desktop readiness/auth')
  const frame = await source.snapshot()
  assert.deepEqual(captures, [{source: 'file', positionMs: 0}])
  assert.equal(frame.captured_at, 5)
  await settleNamed('desktop Qwen source stop', composition.realtime.stop())
  await assert.rejects(source.snapshot(), /camera source is unavailable/u)
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

test('integrated Qwen support requests never send DashScope credentials to a generic override',
  async () => {
    const sentinel = 'hostile-support-route-secret'
    const cases = [
      {
        name: 'DashScope fallback',
        environment: {
          DASHSCOPE_API_KEY: 'dash-support-key',
          NOVA_AUDIO_AGENT_MODEL_BASE_URL: `https://hostile.example/private?sentinel=${sentinel}`,
        },
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        authorization: 'Bearer dash-support-key',
      },
      {
        name: 'generic override',
        environment: {
          DASHSCOPE_API_KEY: 'dash-provider-key',
          NOVA_AUDIO_AGENT_MODEL_API_KEY: 'generic-support-key',
          NOVA_AUDIO_AGENT_MODEL_BASE_URL: 'https://generic.example/compatible/v9',
        },
        endpoint: 'https://generic.example/compatible/v9/chat/completions',
        authorization: 'Bearer generic-support-key',
      },
    ] as const

    for (const scenario of cases) {
      const requests: {endpoint: string; authorization: string; body: string}[] = []
      const previous = globalThis.fetch
      globalThis.fetch = (input, init) => {
        requests.push({
          endpoint: typeof input === 'string' ? input
            : input instanceof URL ? input.href : input.url,
          authorization: new Headers(init?.headers).get('authorization') ?? '',
          body: typeof init?.body === 'string' ? init.body : '',
        })
        return Promise.resolve(new Response(JSON.stringify({
          id: 'gateway-response',
          choices: [{finish_reason: 'stop', message: {content: '{}'}}],
          usage: {prompt_tokens: 1, completion_tokens: 1},
        }), {status: 200, headers: {'content-type': 'application/json'}}))
      }
      let realtime
      try {
        realtime = buildQwenRealtimeAssembly(qwenOptions(
          settings(scenario.environment),
          recordingConnector().connector,
        ))
      } finally {
        globalThis.fetch = previous
      }

      await exerciseGateway(realtime.core.gateway)
      assert.deepEqual(requests.map(({endpoint, authorization}) => ({endpoint, authorization})), [{
        endpoint: scenario.endpoint,
        authorization: scenario.authorization,
      }], scenario.name)
      assert.doesNotMatch(requests[0]?.body ?? '',
        /dash-support-key|dash-provider-key|generic-support-key|hostile-support-route-secret/u)
      assert.doesNotMatch(JSON.stringify(requests),
        scenario.name === 'DashScope fallback' ? /hostile\.example|hostile-support-route-secret/u : /never-match/u)
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
