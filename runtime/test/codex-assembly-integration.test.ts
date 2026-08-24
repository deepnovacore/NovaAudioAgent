import assert from 'node:assert/strict'
import {setImmediate as yieldImmediate} from 'node:timers/promises'
import {test} from 'node:test'

import {buildAssembly} from '../src/assembly.js'
import type {
  CodexAppServerTransport,
  SafePreflightReport,
  SteerTransportResult,
  TransportObserver,
  TransportOutcome,
} from '../src/codex-app-server-transport.js'
import {RealClock} from '../src/clock.js'
import {settingsSchema} from '../src/config.js'
import {CodexAdapter} from '../src/executors/codex.js'
import {ProjectCodexAdapter} from '../src/executors/codex-project-live.js'
import type {EventRecord} from '../src/events.js'
import type {SearchTransport} from '../src/executors/search.js'
import type {
  CompleteRequest,
  GatewayCompletion,
  GatewayDelta,
  ModelGateway,
  StreamRequest,
} from '../src/model-gateway.js'
import {buildRealtimeAssembly} from '../src/realtime-assembly.js'
import type {
  HostContextItem,
  JsonObject,
  RealtimeProvider,
} from '../src/realtime/protocol.js'

const PREFLIGHT: SafePreflightReport = Object.freeze({
  version: '0.145.0', root_matches: true,
  mount: 'workspace_only', subprocess: 'contained', network: 'blocked',
  credential: {present: true, identity: 'chatgpt', policy: 'saved_login'},
  limits: {cpu: 'finite'},
})

class IntegrationTransport implements CodexAppServerTransport {
  readonly calls: string[] = []
  runBarrier: Promise<void> | null = null
  runEntered: (() => void) | null = null

  preflight(): Promise<SafePreflightReport> {
    this.calls.push('preflight')
    return Promise.resolve(PREFLIGHT)
  }

  prewarm(): Promise<SafePreflightReport | null> {
    this.calls.push('prewarm')
    return Promise.resolve(PREFLIGHT)
  }

  async run(
    input: {readonly workOrder: string},
    observer: TransportObserver,
  ): Promise<TransportOutcome> {
    assert.equal(input.workOrder, 'compile the runtime')
    this.calls.push('run')
    observer.onThreadReady?.('thread-fake')
    observer.onTurnStartWritten?.()
    observer.onProgress?.({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
    this.runEntered?.()
    if (this.runBarrier !== null) await this.runBarrier
    await yieldImmediate()
    return {
      classification: 'completed', code: 'completed', turnStartWritten: true,
      completion: {status: 'completed', final_text: 'done', internal_activity: 1},
    }
  }

  steer(): Promise<SteerTransportResult> {
    this.calls.push('steer')
    return Promise.resolve({code: 'no_active_turn', written: false})
  }

  close(): Promise<void> {
    this.calls.push('close')
    return Promise.resolve()
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => { resolvePromise = resolve })
  return {promise, resolve: resolvePromise}
}

class NeverCalledGateway implements ModelGateway {
  async *stream(request: StreamRequest): AsyncIterable<GatewayDelta> {
    void request
    await Promise.resolve()
    throw new Error('model gateway stream was not expected')
  }

  complete(request: CompleteRequest): Promise<GatewayCompletion> {
    void request
    return Promise.reject(new Error('model gateway completion was not expected'))
  }
}

class NeverCalledSearch implements SearchTransport {
  search(query: string, options: {readonly maxResults: number}): Promise<Record<string, unknown>> {
    void query
    void options
    return Promise.reject(new Error('search was not expected'))
  }
}

class IdleProvider implements RealtimeProvider {
  #epoch = 0
  readonly connectedTools: (readonly JsonObject[])[] = []

  connect(options: {readonly tools: readonly JsonObject[]; readonly signal: AbortSignal}): Promise<unknown> {
    assert.equal(options.signal.aborted, false)
    this.connectedTools.push(structuredClone(options.tools))
    this.#epoch += 1
    return Promise.resolve({epoch: this.#epoch, provider_session_id: `provider-${this.#epoch}`})
  }

  sendAudio(): Promise<void> { return Promise.resolve() }

  injectHostItem(
    item: HostContextItem,
    options: {
      readonly confirmationTimeout: number | null
      readonly asUserActivation: boolean
      readonly signal: AbortSignal
    },
  ): Promise<unknown> {
    assert.equal(options.signal.aborted, false)
    return Promise.resolve({
      session_epoch: this.#epoch,
      host_item_id: item.host_item_id,
      provider_item_id: `provider-${item.host_item_id}`,
    })
  }

  createResponse(): Promise<void> {
    return Promise.resolve()
  }

  cancelResponse(): Promise<void> {
    return Promise.resolve()
  }

  async *events(signal: AbortSignal): AsyncIterable<unknown> {
    if (signal.aborted) return
    await new Promise<void>(resolve => {
      signal.addEventListener('abort', () => { resolve() }, {once: true})
    })
  }

  close(): Promise<void> { return Promise.resolve() }
}

test('connected realtime provider exposes only the project Codex public surface', async () => {
  // This fails if ordinary run leaks into realtime, a project action disappears, or structured
  // confirmation stops requiring one exact ID plus a JSON boolean.
  const adapter = new ProjectCodexAdapter({} as never)
  const core = buildAssembly({
    settings: settingsSchema.parse({executors: ['codex']}),
    clock: new RealClock(),
    gateway: new NeverCalledGateway(),
    searchTransport: new NeverCalledSearch(),
    executors: [adapter],
  })
  const provider = new IdleProvider()
  const realtime = buildRealtimeAssembly({core, provider, onDiagnostic: () => undefined})
  await realtime.start()
  try {
    const codexTools = provider.connectedTools[0]?.filter(schema => {
      const declaration = schema.function
      return typeof declaration === 'object'
        && declaration !== null
        && !Array.isArray(declaration)
        && typeof declaration.name === 'string'
        && declaration.name.startsWith('codex__')
    }) ?? []
    const declarations = codexTools.map(schema => schema.function as Record<string, unknown>)
    assert.deepEqual(declarations.map(declaration => declaration.name), [
      'codex__project',
      'codex__confirm_project_action',
      'codex__steer',
      'codex__status',
    ])
    assert.equal(declarations.some(declaration => declaration.name === 'codex__run'), false)

    const project = declarations[0]?.parameters as Record<string, unknown>
    const projectProperties = project.properties as Record<string, Record<string, unknown>>
    assert.deepEqual(projectProperties.action?.enum, [
      'list_workspaces', 'create_workspace', 'select_workspace',
      'list_sessions', 'start_session', 'resume_session',
    ])

    const confirmation = declarations[1]?.parameters as Record<string, unknown>
    assert.deepEqual(confirmation, {
      type: 'object',
      properties: {
        proposal_id: {type: 'string', minLength: 1, maxLength: 128},
        confirmed: {type: 'boolean'},
      },
      required: ['proposal_id', 'confirmed'],
      additionalProperties: false,
    })
  } finally {
    await realtime.stop()
  }
})

async function waitNamed(name: string, condition: () => boolean, timeoutMs = 1_500): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`${name} did not settle`)) }, timeoutMs)
  })
  try {
    await Promise.race([(async () => {
      while (!condition()) await yieldImmediate()
    })(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function createCore(transport: IntegrationTransport, adapter: CodexAdapter) {
  void transport
  return buildAssembly({
    settings: settingsSchema.parse({executors: ['codex']}),
    clock: new RealClock(),
    gateway: new NeverCalledGateway(),
    searchTransport: new NeverCalledSearch(),
    executors: [adapter],
  })
}

function appendOrigin(core: ReturnType<typeof createCore>): string {
  const item = core.runtime.memory.append('conversation', {
    ts: core.runtime.clock.now(),
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'compile the runtime'},
  })
  return `${item.channel}:${item.seq}`
}

const reason = {
  kind: 'realtime_tool', priority: 100, routing_class: 'user_awaited' as const,
  origin: null, selected_suggestion: null,
}

test('buildAssembly preserves adapter identity and real CausalRuntime dispatches app-server transport', async () => {
  // This fails if assembly simulates Codex, copies a structural adapter, or bypasses the runtime handoff path.
  const transport = new IntegrationTransport()
  const adapter = new CodexAdapter(transport)
  const core = createCore(transport, adapter)
  assert.equal(core.runtime.executors.get('codex'), adapter)
  assert.equal(core.manifests.at(-1), adapter.manifest)
  assert.equal(core.tools.bindings.get('codex__run')?.executor, 'codex')

  const events: EventRecord[] = []
  core.runtime.observe(event => { events.push(event) })
  const stop = new AbortController()
  const serving = core.runtime.serve(stop.signal)
  try {
    const admission = core.runtime.dispatchExternal({
      executor: 'codex', op: 'run', request: {work_order: 'compile the runtime'},
      origin_ref: appendOrigin(core),
    }, reason)
    assert.equal(admission.accepted, true)
    await waitNamed('Codex handoff', () => events.some(event => event.kind === 'handoff'))
    const handoff = events.find(event => event.kind === 'handoff')
    assert.equal(handoff?.kind, 'handoff')
    if (handoff?.kind === 'handoff') {
      assert.equal(handoff.payload.outcome, 'ok')
      assert.equal(handoff.payload.content.code, 'completed')
    }
    assert.deepEqual(transport.calls, ['preflight', 'run'])
  } finally {
    stop.abort()
    await serving
  }
})

test('RealtimeService alone publishes selected Codex idle-running-idle with no duplicate side channel', async () => {
  // This fails if the adapter publishes state itself or if runtime progress/handoff projection duplicates it.
  const transport = new IntegrationTransport()
  const adapter = new CodexAdapter(transport)
  const core = createCore(transport, adapter)
  const states = ['idle']
  const realtime = buildRealtimeAssembly({
    core,
    provider: new IdleProvider(),
    onCodexState: state => { states.push(state) },
    onDiagnostic: () => undefined,
    idFactory: (() => {
      let next = 0
      return () => `integration-${++next}`
    })(),
  })
  await realtime.start()
  try {
    const rejected = core.runtime.dispatchExternal({
      executor: 'codex', op: 'missing', request: {}, origin_ref: appendOrigin(core),
    }, reason)
    assert.equal(rejected.accepted, false)
    assert.deepEqual(states, ['idle'])

    const accepted = core.runtime.dispatchExternal({
      executor: 'codex', op: 'run', request: {work_order: 'compile the runtime'},
      origin_ref: appendOrigin(core),
    }, reason)
    assert.equal(accepted.accepted, true)
    await waitNamed('Codex state settlement', () => states.at(-1) === 'idle' && states.includes('running'))
    assert.deepEqual(states, ['idle', 'running', 'idle'])
    assert.equal(realtime.service.codexState, 'idle')
  } finally {
    await realtime.stop()
  }
})

test('RealtimeService suppresses duplicate running state for busy and unselected Codex work', async () => {
  // This fails if adapter-local busy/rejected work manufactures a second state transition.
  const transport = new IntegrationTransport()
  const gate = deferred<void>()
  const entered = deferred<void>()
  transport.runBarrier = gate.promise
  transport.runEntered = () => { entered.resolve() }
  const adapter = new CodexAdapter(transport)
  const core = createCore(transport, adapter)
  const states = ['idle']
  const realtime = buildRealtimeAssembly({
    core,
    provider: new IdleProvider(),
    onCodexState: state => { states.push(state) },
    onDiagnostic: () => undefined,
  })
  await realtime.start()
  try {
    assert.equal(core.runtime.dispatchExternal({
      executor: 'codex', op: 'run', request: {work_order: 'compile the runtime'},
      origin_ref: appendOrigin(core),
    }, reason).accepted, true)
    await entered.promise
    await waitNamed('selected Codex running', () => states.at(-1) === 'running')

    core.runtime.dispatchExternal({
      executor: 'codex', op: 'run', request: {work_order: 'compile the runtime'},
      origin_ref: appendOrigin(core),
    }, reason)
    const unselected = core.runtime.dispatchExternal({
      executor: 'codex', op: 'not_selected', request: {}, origin_ref: appendOrigin(core),
    }, reason)
    assert.equal(unselected.accepted, false)
    assert.deepEqual(states, ['idle', 'running'])
    assert.equal(transport.calls.filter(call => call === 'run').length, 1)

    gate.resolve()
    await waitNamed('selected Codex idle', () => states.at(-1) === 'idle')
    assert.deepEqual(states, ['idle', 'running', 'idle'])
  } finally {
    gate.resolve()
    await realtime.stop()
  }
})
