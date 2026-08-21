import assert from 'node:assert/strict'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import {
  AssemblyError,
  buildAssembly,
  type Assembly,
} from '../src/assembly.js'
import {
  REALTIME_ASSEMBLY_SHUTDOWN_GRACE_MS,
  buildRealtimeAssembly,
} from '../src/realtime-assembly.js'
import { VirtualClock } from '../src/clock.js'
import {CODEX_PROJECT_MANIFEST} from '../src/codex-contract.js'
import { settingsSchema } from '../src/config.js'
import type {ExecutorAdapter, ExecutorDispatchContext, ExecutorHandoff} from '../src/causal-runtime.js'
import type {ProjectCodexAdapter} from '../src/executors/codex-project-live.js'
import type { Frame, FrameSource } from '../src/executors/watcher.js'
import type { JsonValue } from '../src/events.js'
import {consumeHostExecutorCapability} from '../src/host-executor-capability.js'
import type {
  CompleteRequest,
  GatewayCompletion,
  GatewayDelta,
  ModelGateway,
  StreamRequest,
} from '../src/model-gateway.js'
import {
  PlaybackRegistry,
  type PlaybackCompletion,
  type PlaybackFrame,
} from '../src/playback.js'
import type { SearchTransport } from '../src/executors/search.js'
import { RealtimeRuntimeBridge } from '../src/realtime/bridge.js'
import {
  ProjectConfirmationController,
  type ConfirmedProjectOperation,
  type ProjectConfirmationView,
} from '../src/realtime/project-confirmation.js'
import type {
  HostContextItem,
  HostResponseIntent,
  JsonObject,
  RealtimeProvider,
} from '../src/realtime/protocol.js'
import { RealtimeProviderSession } from '../src/realtime/provider-session.js'
import { RealtimeService } from '../src/realtime/service.js'
import type { CodexState } from '../src/realtime/service-state.js'
import { RealtimeSession } from '../src/realtime/session.js'
import type { CaptionFrame } from '../src/realtime/session-state.js'
import type { RealtimeTelemetry } from '../src/realtime/telemetry.js'
import type { CompiledTools } from '../src/tool-schema.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined
  let rejectPromise: ((error: unknown) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: value => { resolvePromise?.(value) },
    reject: error => { rejectPromise?.(error) },
  }
}

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

async function waitNamed(
  name: string,
  condition: () => boolean,
  timeoutMs = 1_500,
): Promise<void> {
  await settleNamed(name, (async () => {
    while (!condition()) await yieldImmediate()
  })(), timeoutMs)
}

async function assertPending(name: string, promise: Promise<unknown>): Promise<void> {
  const turn = deferred<'turn'>()
  setImmediate(() => turn.resolve('turn'))
  const winner = await settleNamed(name, Promise.race([
    promise.then(() => 'settled' as const, () => 'settled' as const),
    turn.promise,
  ]))
  assert.equal(winner, 'turn', `${name} settled before its deferred dependency`)
}

class RecordingFrameSource implements FrameSource {
  starts = 0
  stops = 0
  readonly startSteps: (() => Promise<void>)[] = []
  readonly stopSteps: (() => Promise<void>)[] = []

  constructor(readonly actions: string[] = []) {}

  async start(): Promise<void> {
    this.starts += 1
    this.actions.push('core:start')
    await (this.startSteps.shift()?.() ?? Promise.resolve())
  }

  async stop(): Promise<void> {
    this.stops += 1
    this.actions.push('core:stop')
    await (this.stopSteps.shift()?.() ?? Promise.resolve())
  }

  snapshot(): Promise<Frame | null> {
    return Promise.resolve(null)
  }
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

function realCore(frameSource = new RecordingFrameSource()): Assembly {
  return buildAssembly({
    settings: settingsSchema.parse({executors: ['fast_sim']}),
    clock: new VirtualClock(0),
    gateway: new NeverCalledGateway(),
    searchTransport: new NeverCalledSearch(),
    frameSource,
  })
}

class AbortAwareProvider implements RealtimeProvider {
  connectCalls = 0
  closeCalls = 0
  eventConsumers = 0
  currentEpoch = 0
  readonly connectedTools: (readonly JsonObject[])[] = []
  readonly connectSteps: (() => Promise<unknown>)[] = []
  readonly closeSteps: (() => Promise<void>)[] = []

  constructor(readonly actions: string[] = []) {}

  async connect(options: {
    readonly tools: readonly JsonObject[]
    readonly signal: AbortSignal
  }): Promise<unknown> {
    assert.equal(options.signal.aborted, false)
    this.connectCalls += 1
    this.actions.push('provider:connect')
    this.connectedTools.push(structuredClone(options.tools))
    const step = this.connectSteps.shift()
    const result = step === undefined
      ? {epoch: this.currentEpoch + 1, provider_session_id: `provider-${this.currentEpoch + 1}`}
      : await step()
    if (
      typeof result === 'object'
      && result !== null
      && 'epoch' in result
      && typeof result.epoch === 'number'
    ) this.currentEpoch = result.epoch
    return result
  }

  sendAudio(pcm: Uint8Array, signal: AbortSignal): Promise<void> {
    assert.equal(signal.aborted, false)
    assert.ok(pcm.byteLength > 0)
    return Promise.resolve()
  }

  injectHostItem(
    item: HostContextItem,
    options: {
      readonly confirmationTimeout: number | null
      readonly asUserActivation: boolean
      readonly signal: AbortSignal
    },
  ): Promise<unknown> {
    void options.confirmationTimeout
    void options.asUserActivation
    assert.equal(options.signal.aborted, false)
    return Promise.resolve({
      session_epoch: this.currentEpoch,
      host_item_id: item.host_item_id,
      provider_item_id: `provider-${item.host_item_id}`,
    })
  }

  createResponse(intent: HostResponseIntent, signal: AbortSignal): Promise<void> {
    void intent
    assert.equal(signal.aborted, false)
    return Promise.resolve()
  }

  cancelResponse(responseId: string, signal: AbortSignal): Promise<void> {
    void responseId
    assert.equal(signal.aborted, false)
    return Promise.resolve()
  }

  async *events(signal: AbortSignal): AsyncIterable<unknown> {
    this.eventConsumers += 1
    this.actions.push('provider:events')
    if (signal.aborted) return
    await new Promise<void>(resolve => {
      signal.addEventListener('abort', () => resolve(), {once: true})
    })
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    this.actions.push('provider:close')
    await (this.closeSteps.shift()?.() ?? Promise.resolve())
  }
}

test('one provider session supports the realtime session connect and reconnect contract', async () => {
  // Mutation caught: RealtimeSession calling terminal close()+connect() instead of the shared
  // provider-session reconnect path closes the only provider owner and makes the second epoch fail.
  const core = realCore()
  const provider = new AbortAwareProvider()
  const providerSession = new RealtimeProviderSession(provider)
  const playback = new PlaybackRegistry({
    idFactory: (() => {
      let id = 0
      return () => `shared-${++id}`
    })(),
    onFrame: () => undefined,
    onClear: () => undefined,
  })
  const session = new RealtimeSession({
    provider: providerSession,
    playback,
    idFactory: () => 'host-id',
    clock: core.runtime.clock,
    onDiagnostic: () => undefined,
  })
  try {
    await session.connect({tools: core.tools.schemas})
    await session.reconnect({tools: core.tools.schemas})

    assert.equal(session.sessionEpoch, 2)
    assert.equal(provider.connectCalls, 2)
    assert.equal(provider.closeCalls, 1)
  } finally {
    await providerSession.close().catch(() => undefined)
  }
})

test('factory exposes one ordered object graph with shared tools, ids, and provider session', async () => {
  // Mutations caught: a copied tools view, a second bridge/service/session graph, provider bypass,
  // or allocating any component from a different id factory changes these observed identities/ids.
  const actions: string[] = []
  const frame = new RecordingFrameSource(actions)
  const core = realCore(frame)
  const provider = new AbortAwareProvider(actions)
  let id = 0
  const realtime = buildRealtimeAssembly({
    core,
    provider,
    idFactory: () => `factory-${++id}`,
    controlledGuardReconnect: true,
    guardHistoryRecovery: 'packed',
    guardHistoryPairs: 2,
    onDiagnostic: () => undefined,
  })

  assert.equal(realtime.core, core)
  assert.equal(realtime.provider, provider)
  assert.ok(realtime.providerSession instanceof RealtimeProviderSession)
  assert.ok(realtime.playback instanceof PlaybackRegistry)
  assert.ok(realtime.session instanceof RealtimeSession)
  assert.ok(realtime.bridge instanceof RealtimeRuntimeBridge)
  assert.ok(realtime.service instanceof RealtimeService)
  assert.equal(realtime.runtime, core.runtime)
  assert.equal(realtime.tools, core.tools)
  assert.equal(realtime.service.session, realtime.session)
  assert.equal(realtime.service.internals.bridge, realtime.bridge)
  assert.equal(realtime.service.internals.runtime, realtime.runtime)
  assert.equal(realtime.service.internals.tools, realtime.tools)
  assert.deepEqual(realtime.service.guardConfiguration, {
    controlledReconnect: true,
    historyRecovery: 'packed',
    historyPairs: 2,
  })

  const generation = realtime.playback.openResponse({sessionEpoch: 1, responseId: 'identity'})
  assert.equal(generation.generation_id, 'factory-1')
  assert.equal(generation.utterance_id, 'factory-2')
  const refusal = realtime.bridge.acceptToolCall({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'item-1',
    name: 'unknown',
    arguments: {},
    response_id: null,
  })
  assert.equal(refusal.host_item.host_item_id, 'factory-3')
  assert.equal(refusal.host_item.event_id, 'factory-4')
  assert.equal(realtime.service.internals.idFactory(), 'factory-5')

  await settleNamed('ordered assembly start', realtime.start())
  assert.deepEqual(actions.slice(0, 2), ['core:start', 'provider:connect'])
  assert.equal(realtime.providerSession.state, 'connected')
  assert.deepEqual(provider.connectedTools[0], core.tools.schemas)

  await settleNamed('ordered assembly stop', realtime.stop())
  assert.ok(actions.indexOf('provider:close') < actions.indexOf('core:stop'))
  assert.equal(realtime.providerSession.state, 'closed')
})

test('provider tool view narrows schemas without copying host authority', async () => {
  // Mutations caught: defaulting to an empty view, passing full schemas after narrowing, accepting a
  // copied binding map, retaining a caller-mutable view, or reading untrusted schema names into an
  // error all fail literal assertions.
  const core = realCore()
  const provider = new AbortAwareProvider()
  const canonicalSelection = core.tools.schemas.slice(0, 2)
  const selected = structuredClone(canonicalSelection)
  const realtime = buildRealtimeAssembly({
    core,
    provider,
    providerToolView: tools => ({schemas: selected, bindings: tools.bindings}),
    onDiagnostic: () => undefined,
  })
  const selectedDeclaration = selected[0]?.function
  assert.ok(
    typeof selectedDeclaration === 'object'
      && selectedDeclaration !== null
      && !Array.isArray(selectedDeclaration),
  )
  const mutableSelectedDeclaration = selectedDeclaration as Record<string, JsonValue>
  mutableSelectedDeclaration.description = 'mutated after factory construction'
  await settleNamed('narrowed provider start', realtime.start())
  assert.deepEqual(provider.connectedTools[0], canonicalSelection)
  assert.equal(realtime.tools, core.tools)
  assert.equal(realtime.service.internals.tools.bindings, core.tools.bindings)
  await settleNamed('narrowed provider stop', realtime.stop())

  const copiedBindings = (): CompiledTools => ({
    schemas: core.tools.schemas,
    bindings: new Map(core.tools.bindings),
  })
  assert.throws(
    () => buildRealtimeAssembly({core, provider: new AbortAwareProvider(), providerToolView: copiedBindings}),
    error => error instanceof AssemblyError
      && error.message === 'provider tool view must reuse core tool bindings',
  )
  const malformed = (): CompiledTools => ({
    schemas: [{type: 'function'}],
    bindings: core.tools.bindings,
  })
  assert.throws(
    () => buildRealtimeAssembly({core, provider: new AbortAwareProvider(), providerToolView: malformed}),
    error => error instanceof AssemblyError
      && error.message === 'provider tool view contains a malformed schema',
  )
  const missingSchemaList = (): CompiledTools => ({
    schemas: null,
    bindings: core.tools.bindings,
  }) as unknown as CompiledTools
  assert.throws(
    () => buildRealtimeAssembly({
      core,
      provider: new AbortAwareProvider(),
      providerToolView: missingSchemaList,
    }),
    error => error instanceof AssemblyError
      && error.message === 'provider tool view contains a malformed schema',
  )
  const unknown = structuredClone(core.tools.schemas[0]!) as Record<string, JsonValue>
  const declaration = unknown.function as Record<string, JsonValue>
  declaration.name = 'credential-shaped-unknown-name'
  assert.throws(
    () => buildRealtimeAssembly({
      core,
      provider: new AbortAwareProvider(),
      providerToolView: tools => ({schemas: [unknown], bindings: tools.bindings}),
    }),
    error => error instanceof AssemblyError
      && error.message === 'provider tool view contains an unknown schema',
  )
})

test('provider tool view rejects deep non-JSON, malformed, and altered known schemas', () => {
  // Mutations caught: shallow name-only validation accepts every case below and defers failure to a
  // lower layer; comparing object identity instead of behavior also rejects the exact clone above.
  const core = realCore()
  const cloneFirstSchema = (): Record<string, unknown> => (
    structuredClone(core.tools.schemas[0]!)
  )
  const declarationOf = (schema: Record<string, unknown>): Record<string, unknown> => {
    const declaration = schema.function
    assert.ok(typeof declaration === 'object' && declaration !== null && !Array.isArray(declaration))
    return declaration as Record<string, unknown>
  }
  const parametersOf = (schema: Record<string, unknown>): Record<string, unknown> => {
    const parameters = declarationOf(schema).parameters
    assert.ok(typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters))
    return parameters as Record<string, unknown>
  }
  const expectRejected = (
    schema: Record<string, unknown>,
    message: 'provider tool view contains a malformed schema'
      | 'provider tool view schema must match core schema',
  ): void => {
    assert.throws(
      () => buildRealtimeAssembly({
        core,
        provider: new AbortAwareProvider(),
        providerToolView: tools => ({
          schemas: [schema] as unknown as CompiledTools['schemas'],
          bindings: tools.bindings,
        }),
      }),
      error => error instanceof AssemblyError && error.message === message,
    )
  }

  const nonJson = cloneFirstSchema()
  parametersOf(nonJson).non_json_value = undefined
  expectRejected(nonJson, 'provider tool view contains a malformed schema')

  const malformedNestedParameters = cloneFirstSchema()
  parametersOf(malformedNestedParameters).properties = []
  expectRejected(malformedNestedParameters, 'provider tool view contains a malformed schema')

  const alteredDescription = cloneFirstSchema()
  declarationOf(alteredDescription).description = 'credential-shaped altered description'
  expectRejected(alteredDescription, 'provider tool view schema must match core schema')

  const alteredParameters = cloneFirstSchema()
  parametersOf(alteredParameters).required = []
  expectRejected(alteredParameters, 'provider tool view schema must match core schema')
})

test('callbacks route once through the single playback, session, bridge, and service graph', async () => {
  // Mutations caught: missing callback forwarding or constructing a parallel graph changes the
  // literal one-event callback ledgers below.
  const core = realCore()
  const provider = new AbortAwareProvider()
  const audioFrames: PlaybackFrame[] = []
  const clears: (readonly [string, number])[] = []
  const alerts: (readonly [string | null, number | null])[] = []
  const terminals: (readonly [string, number])[] = []
  const spoken: string[] = []
  const deliveries: PlaybackCompletion[] = []
  const captions: CaptionFrame[] = []
  const codexStates: CodexState[] = []
  const projectViews: ProjectConfirmationView[] = []
  const diagnostics: string[] = []
  const telemetryRecords: {readonly kind: string; readonly payload: Readonly<Record<string, JsonValue>>}[] = []
  const telemetry: RealtimeTelemetry = {
    record: (kind, payload) => { telemetryRecords.push({kind, payload}) },
    close: () => undefined,
  }
  let id = 0
  const confirmation = new ProjectConfirmationController({
    clock: core.runtime.clock,
    idFactory: () => `confirmation-${++id}`,
  })
  const realtime = buildRealtimeAssembly({
    core,
    provider,
    idFactory: () => `callback-${++id}`,
    onAudioFrame: frame => { audioFrames.push(frame) },
    onAudioClear: (utteranceId, generationEpoch) => { clears.push([utteranceId, generationEpoch]) },
    onAudioAlert: (utteranceId, generationEpoch) => { alerts.push([utteranceId, generationEpoch]) },
    onAudioTerminal: (utteranceId, generationEpoch) => {
      terminals.push([utteranceId, generationEpoch])
    },
    onSpoken: text => { spoken.push(text) },
    onDelivery: completion => { deliveries.push(completion) },
    onCaption: frame => { captions.push(frame) },
    onCodexState: state => { codexStates.push(state) },
    onProjectView: view => { projectViews.push(view) },
    telemetry,
    onDiagnostic: line => { diagnostics.push(line) },
    projectConfirmation: confirmation,
    commitProjectOperation: () => Promise.resolve({accepted: true, code: 'accepted'}),
  })

  await settleNamed('callback provider connect', realtime.service.connect())
  await realtime.service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await realtime.service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([1, 2]),
  })
  await realtime.service.handleEvent({
    kind: 'response_transcript_delta',
    session_epoch: 1,
    response_id: 'r-1',
    text: 'hel',
  })
  await realtime.service.handleEvent({
    kind: 'response_transcript_final',
    session_epoch: 1,
    response_id: 'r-1',
    text: 'hello',
  })
  const first = realtime.session.currentGeneration
  assert.ok(first !== null)
  await realtime.service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-1',
    status: 'completed',
    reason: 'done',
  })
  assert.equal(realtime.service.playbackStarted(first.utterance_id, first.generation_epoch), true)
  assert.equal(realtime.service.playbackDone(first.utterance_id, first.generation_epoch, 25), true)
  realtime.service.internals.setCodexState('running')
  realtime.service.invalidateProjectConfirmationForTest('callback-test')

  const second = realtime.playback.openResponse({sessionEpoch: 1, responseId: 'r-2'})
  realtime.playback.pushAudio({
    sessionEpoch: 1,
    responseId: 'r-2',
    pcm: new Uint8Array([3, 4]),
  })
  assert.deepEqual(realtime.playback.fenceCurrent({alert: true}), second)
  assert.equal(realtime.playback.retireClearUnknown(second), true)
  const third = realtime.playback.openResponse({sessionEpoch: 1, responseId: 'r-3'})
  realtime.playback.pushAudio({
    sessionEpoch: 1,
    responseId: 'r-3',
    pcm: new Uint8Array([5, 6]),
  })
  assert.deepEqual(realtime.playback.fenceCurrent(), third)

  assert.equal(audioFrames.length, 3)
  assert.deepEqual(clears, [[third.utterance_id, third.generation_epoch]])
  assert.deepEqual(alerts, [[second.utterance_id, second.generation_epoch]])
  assert.deepEqual(terminals, [[first.utterance_id, first.generation_epoch]])
  assert.deepEqual(spoken, ['hello'])
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0]?.text, 'hello')
  assert.deepEqual(captions, [
    {role: 'assistant', text: 'hel', final: false},
    {role: 'assistant', text: 'hello', final: true},
  ])
  assert.deepEqual(codexStates, ['running'])
  assert.deepEqual(projectViews, [{
    pending_confirmation: false,
    workspace_display_name: null,
    session_title: null,
  }])
  assert.ok(telemetryRecords.some(record => record.kind === 'provider.response_started'))
  assert.deepEqual(diagnostics, [])

  await settleNamed('callback assembly stop', realtime.stop())
})

test('project adapter wiring carries one confirmed identity through the real realtime runtime', async () => {
  const clock = new VirtualClock(0)
  const confirmation = new ProjectConfirmationController({
    clock,
    idFactory: () => 'assembly-confirmation',
  })
  const captured: {
    operation: ConfirmedProjectOperation | null
    capability: object | null
    context: ExecutorDispatchContext | null
    origin: string | null
  } = {operation: null, capability: null, context: null, origin: null}
  let closeCalls = 0
  const viewObservers = new Set<(view: ProjectConfirmationView) => void>()
  let activeWorkspace = 'alpha'
  let activeSession = 'Task'
  const adapterShape: ExecutorAdapter & {
    readonly confirmationController: ProjectConfirmationController
    commitConfirmed: ProjectCodexAdapter['commitConfirmed']
    publicProjectView: ProjectCodexAdapter['publicProjectView']
    initialize: ProjectCodexAdapter['initialize']
    observeProjectView: ProjectCodexAdapter['observeProjectView']
    close: ProjectCodexAdapter['close']
  } = {
    manifest: CODEX_PROJECT_MANIFEST,
    confirmationController: confirmation,
    dispatch: (
      op: string,
      _request: Readonly<Record<string, JsonValue>>,
      context: ExecutorDispatchContext,
    ): Promise<ExecutorHandoff> => {
      captured.context = context
      captured.capability = consumeHostExecutorCapability(context) ?? null
      return Promise.resolve({
        outcome: 'ok', trust: 'trusted_system', content: {op, code: 'completed'}, refs: [],
      })
    },
    commitConfirmed: (operation, originRef, runtimeDispatch) => {
      captured.operation = operation
      captured.origin = originRef
      if (!confirmation.claimConfirmed(operation)) {
        return Promise.resolve({accepted: false, code: 'confirmation_invalid'})
      }
      const admission = runtimeDispatch({
        executor: 'codex',
        op: 'run',
        request: {work_order: operation.work_order ?? ''},
        origin_ref: originRef,
      }, {
        kind: 'realtime_tool',
        priority: 100,
        routing_class: 'user_awaited',
        origin: null,
        selected_suggestion: null,
      }, operation)
      return Promise.resolve({
        accepted: admission.accepted,
        code: admission.accepted ? 'accepted' : 'runtime_rejected',
        ...(admission.delegate_id === null ? {} : {delegate_id: admission.delegate_id}),
      })
    },
    publicProjectView: pending => Object.freeze({
      workspace_display_name: activeWorkspace,
      session_title: activeSession,
      pending_confirmation: pending,
    }),
    initialize: () => {
      for (const observer of viewObservers) observer(adapterShape.publicProjectView(false))
      return Promise.resolve()
    },
    observeProjectView: observer => {
      viewObservers.add(observer)
      return () => { viewObservers.delete(observer) }
    },
    close: () => {
      closeCalls += 1
      return Promise.resolve()
    },
  }
  const projectAdapter = adapterShape as unknown as ProjectCodexAdapter
  const core = buildAssembly({
    settings: settingsSchema.parse({executors: ['codex']}),
    clock,
    gateway: new NeverCalledGateway(),
    searchTransport: new NeverCalledSearch(),
    executors: [adapterShape],
  })
  const views: ProjectConfirmationView[] = []
  const realtime = buildRealtimeAssembly({
    core,
    provider: new AbortAwareProvider(),
    projectAdapter,
    onProjectView: view => { views.push(view) },
  })
  await realtime.start()
  try {
    const proposal = confirmation.prepare({
      action: 'create',
      workspace_display_name: 'beta',
      workspace_id: null,
      session_title: null,
      session_id: null,
      work_order: 'exact work',
      origin_ref: 'conversation:proposal',
    })
    await realtime.service.handleEvent({
      kind: 'user_speech_started',
      session_epoch: 1,
      speech_id: 'speech-confirm',
      provider_item_id: 'item-confirm',
    })
    await realtime.service.handleEvent({
      kind: 'user_speech_ended',
      session_epoch: 1,
      speech_id: 'speech-confirm',
      provider_item_id: 'item-confirm',
    })
    await realtime.service.handleEvent({
      kind: 'user_transcript_final',
      session_epoch: 1,
      item_id: 'item-confirm',
      text: '确认',
    })
    await waitNamed('confirmed project executor dispatch', () => captured.capability !== null)
    assert.equal(captured.operation, captured.capability)
    assert.equal(captured.operation?.nonce, proposal.nonce)
    assert.equal(captured.context?.delegate.origin_ref, captured.origin)
    assert.equal(captured.context?.delegate.routing_class, 'user_awaited')
    assert.deepEqual(views.at(-1), {
      workspace_display_name: 'alpha',
      session_title: 'Task',
      pending_confirmation: false,
    })
    assert.deepEqual(Object.keys(views.at(-1) ?? {}).sort(), [
      'pending_confirmation', 'session_title', 'workspace_display_name',
    ])
    activeWorkspace = 'beta'
    activeSession = 'New task'
    for (const observer of viewObservers) observer(adapterShape.publicProjectView(false))
    assert.deepEqual(views.at(-1), {
      workspace_display_name: 'beta',
      session_title: 'New task',
      pending_confirmation: false,
    })
  } finally {
    await realtime.stop()
  }
  assert.equal(closeCalls, 1)
})

test('concurrent starts acquire core, provider, and runtime serving exactly once', async () => {
  // Mutations caught: dropping start serialization or constructing a second service increments one
  // of these real resource counters.
  const coreStart = deferred<void>()
  const frame = new RecordingFrameSource()
  frame.startSteps.push(() => coreStart.promise)
  const core = realCore(frame)
  const provider = new AbortAwareProvider()
  const originalServe = core.runtime.serve.bind(core.runtime)
  let serveCalls = 0
  Object.defineProperty(core.runtime, 'serve', {
    configurable: true,
    value: (signal: AbortSignal): Promise<void> => {
      serveCalls += 1
      return originalServe(signal)
    },
  })
  const realtime = buildRealtimeAssembly({core, provider, onDiagnostic: () => undefined})

  const first = realtime.start()
  const second = realtime.start()
  assert.equal(first, second)
  await waitNamed('core start entry', () => frame.starts === 1)
  assert.equal(provider.connectCalls, 0)
  coreStart.resolve(undefined)
  await settleNamed('concurrent starts', Promise.all([first, second]))
  assert.equal(frame.starts, 1)
  assert.equal(provider.connectCalls, 1)
  assert.equal(provider.eventConsumers, 1)
  assert.equal(serveCalls, 1)

  await settleNamed('concurrent start cleanup', realtime.stop())
})

test('service start failure rolls core back, preserves the primary error, and remains retryable', async () => {
  // Mutations caught: swallowing/replacing the connect error, omitting rollback, terminally closing
  // the shared provider session, or retaining a rejected start promise breaks this retry.
  const frame = new RecordingFrameSource()
  const core = realCore(frame)
  const provider = new AbortAwareProvider()
  const primary = new Error('synthetic primary start failure')
  const realtime = buildRealtimeAssembly({core, provider, onDiagnostic: () => undefined})
  const originalStart = realtime.service.start.bind(realtime.service)
  let failServiceStart = true
  Object.defineProperty(realtime.service, 'start', {
    configurable: true,
    value: (): Promise<void> => {
      if (failServiceStart) {
        failServiceStart = false
        return Promise.reject(primary)
      }
      return originalStart()
    },
  })

  await assert.rejects(realtime.start(), error => error === primary)
  assert.equal(frame.starts, 1)
  assert.equal(frame.stops, 1)
  assert.equal(realtime.providerSession.state, 'new')

  await settleNamed('retry after start rollback', realtime.start())
  assert.equal(frame.starts, 2)
  assert.equal(provider.connectCalls, 1)
  assert.equal(realtime.providerSession.state, 'connected')
  await settleNamed('retry cleanup', realtime.stop())
})

test('stop during start waits, then closes service before core', async () => {
  // Mutation caught: independent start/stop paths either activate service after stop owns the
  // lifecycle, stop core before the provider owner, or let stop return while core start is held.
  const actions: string[] = []
  const coreStart = deferred<void>()
  const frame = new RecordingFrameSource(actions)
  frame.startSteps.push(() => coreStart.promise)
  const provider = new AbortAwareProvider(actions)
  const realtime = buildRealtimeAssembly({
    core: realCore(frame),
    provider,
    onDiagnostic: () => undefined,
  })

  const starting = realtime.start()
  await waitNamed('held core start', () => frame.starts === 1)
  const stopping = realtime.stop()
  await assertPending('stop held behind start', stopping)
  assert.equal(provider.closeCalls, 0)
  assert.equal(frame.stops, 0)

  coreStart.resolve(undefined)
  await assert.rejects(
    settleNamed('abandoned overlapping start', starting),
    error => error instanceof AssemblyError
      && error.message === 'realtime assembly start was abandoned by stop',
  )
  await settleNamed('overlapping stop', stopping)
  assert.equal(provider.connectCalls, 0)
  assert.ok(actions.indexOf('provider:close') < actions.indexOf('core:stop'))
})

test('never-settling start has bounded shutdown with stable ordered cleanup diagnostics', async () => {
  // Mutations caught: directly awaiting the in-flight start blocks forever; skipping either grace
  // or reversing service/core cleanup changes the bounded result, literals, or action order.
  assert.equal(REALTIME_ASSEMBLY_SHUTDOWN_GRACE_MS, 1_000)
  const actions: string[] = []
  const diagnostics: string[] = []
  const heldCoreStart = deferred<void>()
  const frame = new RecordingFrameSource(actions)
  frame.startSteps.push(() => heldCoreStart.promise)
  const core = realCore(frame)
  const originalCoreStop = core.stop.bind(core)
  Object.defineProperty(core, 'stop', {
    configurable: true,
    value: (): Promise<void> => {
      actions.push('assembly:core-stop-call')
      return originalCoreStop()
    },
  })
  const provider = new AbortAwareProvider(actions)
  const realtime = buildRealtimeAssembly({
    core,
    provider,
    onDiagnostic: line => { diagnostics.push(line) },
  })

  const starting = realtime.start()
  await waitNamed('never-settling core start entry', () => frame.starts === 1)
  const stopping = realtime.stop()
  try {
    await settleNamed('bounded stop behind never-settling start', stopping, 2_750)
    assert.equal(provider.closeCalls, 1)
    assert.ok(
      actions.indexOf('provider:close') < actions.indexOf('assembly:core-stop-call'),
      'service close must be attempted before core stop',
    )
    assert.deepEqual(diagnostics, [
      '[realtime-diagnostic] assembly_start_abandoned',
      '[realtime-diagnostic] assembly_core_stop_abandoned',
    ])
  } finally {
    heldCoreStart.reject(new Error('release never-settling start after bounded assertion'))
    await settleNamed(
      'never-settling start cleanup observation',
      Promise.allSettled([starting, stopping]),
      1_500,
    )
  }
})

test('late resolving and rejecting starts are observed without activating service after stop', async () => {
  // Mutations caught: removing the post-core ownership check connects the provider and starts the
  // runtime after stop; dropping rejection observation turns the late failure into an unhandled one.
  const makeHeldAssembly = () => {
    const heldCoreStart = deferred<void>()
    const frame = new RecordingFrameSource()
    frame.startSteps.push(() => heldCoreStart.promise)
    const core = realCore(frame)
    const originalServe = core.runtime.serve.bind(core.runtime)
    let serveCalls = 0
    Object.defineProperty(core.runtime, 'serve', {
      configurable: true,
      value: (signal: AbortSignal): Promise<void> => {
        serveCalls += 1
        return originalServe(signal)
      },
    })
    const provider = new AbortAwareProvider()
    const realtime = buildRealtimeAssembly({core, provider, onDiagnostic: () => undefined})
    return {heldCoreStart, frame, provider, realtime, serveCalls: () => serveCalls}
  }
  const resolving = makeHeldAssembly()
  const rejecting = makeHeldAssembly()
  const lateFailure = new Error('late core start failure')
  const resolvingStart = resolving.realtime.start()
  const rejectingStart = rejecting.realtime.start()
  await waitNamed('late resolving start entry', () => resolving.frame.starts === 1)
  await waitNamed('late rejecting start entry', () => rejecting.frame.starts === 1)
  const resolvingStop = resolving.realtime.stop()
  const rejectingStop = rejecting.realtime.stop()
  let released = false
  try {
    await settleNamed(
      'parallel bounded stops before late starts settle',
      Promise.all([resolvingStop, rejectingStop]),
      2_750,
    )
    resolving.heldCoreStart.resolve(undefined)
    rejecting.heldCoreStart.reject(lateFailure)
    released = true

    await assert.rejects(
      settleNamed('late resolving start observation', resolvingStart),
      error => error instanceof AssemblyError
        && error.message === 'realtime assembly start was abandoned by stop',
    )
    await assert.rejects(
      settleNamed('late rejecting start observation', rejectingStart),
      error => error === lateFailure,
    )
    await waitNamed('late resolving core cleanup', () => resolving.frame.stops === 1)
    assert.equal(resolving.provider.connectCalls, 0)
    assert.equal(rejecting.provider.connectCalls, 0)
    assert.equal(resolving.serveCalls(), 0)
    assert.equal(rejecting.serveCalls(), 0)
  } finally {
    if (!released) {
      resolving.heldCoreStart.resolve(undefined)
      rejecting.heldCoreStart.reject(lateFailure)
    }
    await settleNamed(
      'late start final observation',
      Promise.allSettled([resolvingStart, rejectingStart, resolvingStop, rejectingStop]),
      3_500,
    )
  }
})

test('service close failure still stops core and preserves the first actual failure', async () => {
  // Mutation caught: a finally-less shutdown skips core cleanup, while last-error-wins replaces the
  // service failure with a later core result.
  const frame = new RecordingFrameSource()
  const provider = new AbortAwareProvider()
  provider.closeSteps.push(() => Promise.reject(new Error('provider-secret-shaped failure')))
  const realtime = buildRealtimeAssembly({
    core: realCore(frame),
    provider,
    onDiagnostic: () => undefined,
  })
  await settleNamed('close failure setup', realtime.start())

  await assert.rejects(
    realtime.stop(),
    error => error instanceof Error && error.message === 'provider close failed',
  )
  assert.equal(frame.stops, 1)
  assert.equal(realtime.providerSession.state, 'closed')
})

test('outer service and core shutdown timeouts are bounded and content-safe', async () => {
  // Mutations caught: awaiting either cleanup forever, omitting the second cleanup, changing the
  // fixed grace, or interpolating an underlying failure into diagnostics.
  assert.equal(REALTIME_ASSEMBLY_SHUTDOWN_GRACE_MS, 1_000)
  const diagnostics: string[] = []
  const coreStop = deferred<void>()
  const serviceTail = deferred<void>()
  const frame = new RecordingFrameSource()
  frame.stopSteps.push(() => coreStop.promise)
  const realtime = buildRealtimeAssembly({
    core: realCore(frame),
    provider: new AbortAwareProvider(),
    onDiagnostic: line => {
      diagnostics.push(line)
      throw new Error('diagnostic observer failed with secret-shaped content')
    },
  })
  await settleNamed('timeout setup', realtime.start())
  const originalClose = realtime.service.close.bind(realtime.service)
  Object.defineProperty(realtime.service, 'close', {
    configurable: true,
    value: async (): Promise<void> => {
      await originalClose()
      await serviceTail.promise
    },
  })

  await settleNamed('bounded outer shutdown', realtime.stop(), 2_750)
  assert.equal(frame.stops, 1)
  assert.deepEqual(diagnostics.filter(line => line.includes('assembly_')), [
    '[realtime-diagnostic] assembly_service_close_abandoned',
    '[realtime-diagnostic] assembly_core_stop_abandoned',
  ])
  assert.ok(diagnostics.every(line => !line.includes('secret') && !line.includes('/')))

  serviceTail.resolve(undefined)
  coreStop.resolve(undefined)
  await settleNamed('abandoned cleanup release', yieldImmediate())
})

test('concurrent and repeated stops share cleanup and a completed stop refuses restart', async () => {
  // Mutations caught: duplicate close ownership increments the provider count; clearing terminal
  // lifecycle state lets the closed provider session reach an unstable lower-level error.
  const providerClose = deferred<void>()
  const frame = new RecordingFrameSource()
  const provider = new AbortAwareProvider()
  provider.closeSteps.push(() => providerClose.promise)
  const realtime = buildRealtimeAssembly({
    core: realCore(frame),
    provider,
    onDiagnostic: () => undefined,
  })
  await settleNamed('repeated stop setup', realtime.start())

  const first = realtime.stop()
  const second = realtime.stop()
  assert.equal(first, second)
  await waitNamed('provider close entry', () => provider.closeCalls === 1)
  providerClose.resolve(undefined)
  await settleNamed('shared concurrent stops', Promise.all([first, second]))
  await settleNamed('completed repeated stop', realtime.stop())
  assert.equal(provider.closeCalls, 1)
  assert.equal(frame.stops, 1)

  await assert.rejects(
    realtime.start(),
    error => error instanceof AssemblyError
      && error.message === 'realtime assembly cannot restart after stop',
  )
  assert.equal(provider.connectCalls, 1)
})
