import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
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
import {CODEX_LIVE_MANIFEST, CODEX_PROJECT_MANIFEST} from '../src/codex-contract.js'
import type {CodexAssemblyResource} from '../src/codex-factory.js'
import type {PublicProjectContext, WorkspaceRecord} from '../src/codex-project-store.js'
import { settingsSchema } from '../src/config.js'
import type {ExecutorAdapter, ExecutorDispatchContext, ExecutorHandoff} from '../src/causal-runtime.js'
import type {
  CommittedWorkspaceEvent,
  ProjectCodexAdapter,
  TerminalWorkOrderEvent,
} from '../src/executors/codex-project-live.js'
import type {
  RealtimeWorkspaceGraph,
} from '../src/realtime-assembly.js'
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
import {
  WorkspaceGraphService,
  type TaskCompletionInput,
} from '../src/workspace-graph/service.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function emptyPublishedGraphSnapshot(publicationRevision: number) {
  return Object.freeze({
    schema_version: 3 as const,
    publication_revision: publicationRevision,
    degraded: false,
    logical_workspaces: Object.freeze([]),
    workspace_instances: Object.freeze([]),
    relations: Object.freeze([]),
    aliases: Object.freeze([]),
  })
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

class WorkspaceContextProvider extends AbortAwareProvider {
  readonly workspaceItems: HostContextItem[] = []
  workspaceContextStep: (() => Promise<void>) | null = null
  workspaceContextProofStep: ((item: HostContextItem, proof: unknown) => Promise<unknown>) | null = null
  currentWorkspaceItem: HostContextItem | null = null
  #providerItemId: string | null = null

  async injectWorkspaceContext(
    item: HostContextItem,
    options: {readonly confirmationTimeout: number | null; readonly signal: AbortSignal},
  ): Promise<unknown> {
    void options.confirmationTimeout
    assert.equal(options.signal.aborted, false)
    this.workspaceItems.push(structuredClone(item))
    await (this.workspaceContextStep?.() ?? Promise.resolve())
    const priorProviderItemId = this.#providerItemId
    const providerItemId = `provider-${item.host_item_id}`
    this.#providerItemId = providerItemId
    this.currentWorkspaceItem = structuredClone(item)
    const proof = {
      item,
      asUserActivation: false,
      delivery: {
        capability: 'replace_provider_item',
        delivered: true,
        session_epoch: this.currentEpoch,
        workspace_instance_id: item.workspace_instance_id,
        revision: item.revision,
        prior_provider_item_id: priorProviderItemId,
        provider_item_id: providerItemId,
        superseded_provider_item_id: priorProviderItemId,
      },
    }
    return await (this.workspaceContextProofStep?.(item, proof) ?? Promise.resolve(proof))
  }

  override async close(): Promise<void> {
    this.#providerItemId = null
    this.currentWorkspaceItem = null
    await super.close()
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
    admission: {readonly accepted: boolean; readonly delegate_id: string | null} | null
  } = {operation: null, capability: null, context: null, origin: null, admission: null}
  let closeCalls = 0
  const viewObservers = new Set<(
    view: ProjectConfirmationView,
  ) => void | Promise<void>>()
  let activeWorkspace = 'alpha'
  let activeSession = 'Task'
  const adapterShape: ExecutorAdapter & {
    readonly confirmationController: ProjectConfirmationController
    commitConfirmed: ProjectCodexAdapter['commitConfirmed']
    publicProjectView: ProjectCodexAdapter['publicProjectView']
    publicProjectContext: ProjectCodexAdapter['publicProjectContext']
    initialize: ProjectCodexAdapter['initialize']
    activeCommittedWorkspace: ProjectCodexAdapter['activeCommittedWorkspace']
    observeProjectView: ProjectCodexAdapter['observeProjectView']
    observeProjectContext: ProjectCodexAdapter['observeProjectContext']
    observeCommittedWorkspace: ProjectCodexAdapter['observeCommittedWorkspace']
    observeTerminalWorkOrder: ProjectCodexAdapter['observeTerminalWorkOrder']
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
        op: 'project',
        request: {action: 'execute_confirmed'},
        origin_ref: originRef,
      }, {
        kind: 'realtime_tool',
        priority: 100,
        routing_class: 'user_awaited',
        origin: null,
        selected_suggestion: null,
      }, operation)
      captured.admission = {accepted: admission.accepted, delegate_id: admission.delegate_id}
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
    publicProjectContext: pending => Object.freeze({
      workspace_id: `host-${activeWorkspace}`,
      view: adapterShape.publicProjectView(pending),
    }),
    initialize: async () => {
      for (const observer of viewObservers) {
        await observer(adapterShape.publicProjectView(false))
      }
    },
    activeCommittedWorkspace: () => Promise.resolve(null),
    observeProjectView: observer => {
      viewObservers.add(observer)
      return () => { viewObservers.delete(observer) }
    },
    observeProjectContext: () => () => undefined,
    observeCommittedWorkspace: () => () => undefined,
    observeTerminalWorkOrder: () => () => undefined,
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
    provider: new WorkspaceContextProvider(),
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
      kind: 'response_started',
      session_epoch: 1,
      response_id: 'response-confirm',
    })
    await realtime.service.handleEvent({
      kind: 'user_transcript_final',
      session_epoch: 1,
      item_id: 'item-confirm',
      text: '确认',
    })
    await realtime.service.handleEvent({
      kind: 'user_speech_ended',
      session_epoch: 1,
      speech_id: 'speech-confirm',
      provider_item_id: 'item-confirm',
    })
    assert.deepEqual(realtime.service.confirmationItemsForTest, ['1:item-confirm'])
    assert.deepEqual(realtime.service.boundOriginsForTest, [
      ['1:response-confirm', 'item-confirm'],
    ])
    await realtime.service.handleEvent({
      kind: 'tool_call_ready',
      session_epoch: 1,
      call_id: 'call-confirm',
      item_id: 'function-confirm',
      response_id: 'response-confirm',
      name: 'codex__confirm_project_action',
      arguments: {proposal_id: proposal.proposal_id, confirmed: true},
    })
    assert.equal(confirmation.pending, false)
    assert.equal(captured.operation?.proposal_id, proposal.proposal_id)
    assert.equal(captured.admission?.accepted, true)
    assert.ok(captured.admission?.delegate_id !== null)
    await waitNamed('confirmed project executor dispatch', () => captured.capability !== null)
    assert.equal(captured.operation, captured.capability)
    assert.equal(captured.operation?.proposal_id, proposal.proposal_id)
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

test('active project views replace one provider context without publishing history', async () => {
  const clock = new VirtualClock(0)
  const confirmation = new ProjectConfirmationController({
    clock,
    idFactory: () => 'active-context-confirmation',
  })
  const provider = new WorkspaceContextProvider()
  const viewObservers = new Set<(view: ProjectConfirmationView) => void>()
  const contextObservers = new Set<(
    context: PublicProjectContext,
  ) => void | Promise<void>>()
  const workspaceObservers = new Set<(event: CommittedWorkspaceEvent) => void | Promise<void>>()
  let view: ProjectConfirmationView = Object.freeze({
    workspace_display_name: 'alpha',
    session_title: null,
    pending_confirmation: false,
  })
  let contextWorkspaceId = 'host-alpha'
  const alpha: WorkspaceRecord = Object.freeze({
    workspace_id: 'host-alpha', display_name: 'alpha', normalized_name: 'alpha',
    canonical_path: '/safe/alpha', origin: 'registered', codex_home_key: 'host-alpha',
    active_session_id: null, created_at: 1, last_used_at: 1,
  })
  const beta: WorkspaceRecord = Object.freeze({
    workspace_id: 'host-beta', display_name: 'beta', normalized_name: 'beta',
    canonical_path: '/safe/beta', origin: 'registered', codex_home_key: 'host-beta',
    active_session_id: null, created_at: 2, last_used_at: 2,
  })
  const adapterShape: ExecutorAdapter & Record<string, unknown> = {
    manifest: CODEX_PROJECT_MANIFEST,
    confirmationController: confirmation,
    dispatch: () => Promise.resolve({
      outcome: 'ok', trust: 'trusted_system', content: {code: 'completed'}, refs: [],
    }),
    commitConfirmed: () => Promise.resolve({accepted: false, code: 'not_used'}),
    publicProjectView: () => view,
    publicProjectContext: () => Object.freeze({workspace_id: contextWorkspaceId, view}),
    initialize: () => {
      for (const observer of viewObservers) observer(view)
      return Promise.resolve()
    },
    activeCommittedWorkspace: () => Promise.resolve(alpha),
    observeProjectView: (observer: (next: ProjectConfirmationView) => void) => {
      viewObservers.add(observer)
      return () => { viewObservers.delete(observer) }
    },
    observeProjectContext: (
      observer: (context: PublicProjectContext) => void | Promise<void>,
    ) => {
      contextObservers.add(observer)
      return () => { contextObservers.delete(observer) }
    },
    observeCommittedWorkspace: (
      observer: (event: CommittedWorkspaceEvent) => void | Promise<void>,
    ) => {
      workspaceObservers.add(observer)
      return () => { workspaceObservers.delete(observer) }
    },
    observeTerminalWorkOrder: () => () => undefined,
    close: () => Promise.resolve(),
  }
  const core = buildAssembly({
    settings: settingsSchema.parse({executors: ['codex']}),
    clock,
    gateway: new NeverCalledGateway(),
    searchTransport: new NeverCalledSearch(),
    executors: [adapterShape],
  })
  const realtime = buildRealtimeAssembly({
    core,
    provider,
    projectAdapter: adapterShape as unknown as ProjectCodexAdapter,
    idFactory: (() => {
      let sequence = 0
      return () => `active-context-${++sequence}`
    })(),
  })
  await realtime.start()
  try {
    const publishAtomicContext = async (): Promise<void> => {
      const context = Object.freeze({workspace_id: contextWorkspaceId, view})
      await Promise.all([...contextObservers].map(async observer => { await observer(context) }))
    }
    assert.equal(provider.workspaceItems.length, 1)
    assert.deepEqual(provider.workspaceItems[0], {
      kind: 'workspace_context',
      host_item_id: 'active-context-1',
      event_id: 'active-context-2',
      content: '<active_project_context>\nworkspace="alpha"\nsession=""\n</active_project_context>',
      call_id: null,
      session_epoch: 1,
      workspace_instance_id: 'host-alpha',
      revision: 1,
    })

    view = Object.freeze({...view, session_title: 'Login fix'})
    for (const observer of viewObservers) observer(view)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(provider.workspaceItems.length, 1,
      'advisory UI observers cannot stand in for the critical provider barrier')
    await publishAtomicContext()
    await waitNamed('active Session context replacement', () => provider.workspaceItems.length === 2)
    assert.equal(provider.workspaceItems[1]?.content, [
      '<active_project_context>',
      'workspace="alpha"',
      'session="Login fix"',
      '</active_project_context>',
    ].join('\n'))
    assert.equal(provider.workspaceItems[1]?.revision, 2)
    assert.equal(provider.workspaceItems[1]?.workspace_instance_id, 'host-alpha')
    assert.equal(provider.workspaceItems[1]?.content.includes('workspaces='), false)
    assert.equal(provider.workspaceItems[1]?.content.includes('sessions='), false)

    const committed = [...workspaceObservers][0]
    assert.ok(committed !== undefined)
    await committed({workspace: beta})
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(provider.workspaceItems.length, 2,
      'a new host id must not pair with the prior display view')
    contextWorkspaceId = 'host-beta'
    view = Object.freeze({
      workspace_display_name: 'beta', session_title: null, pending_confirmation: false,
    })
    for (const observer of viewObservers) observer(view)
    await publishAtomicContext()
    await waitNamed('active workspace context replacement', () => provider.workspaceItems.length === 3)
    assert.equal(provider.workspaceItems[2]?.workspace_instance_id, 'host-beta')
    assert.equal(provider.workspaceItems[2]?.revision, 3)
    assert.equal(provider.workspaceItems[2]?.content, [
      '<active_project_context>',
      'workspace="beta"',
      'session=""',
      '</active_project_context>',
    ].join('\n'))

    await realtime.providerSession.reconnect(core.tools.schemas)
    await waitNamed('active context republished after reconnect', () => (
      provider.workspaceItems.some(item => item.session_epoch === 2)
    ))
    const epochTwo = provider.workspaceItems.filter(item => item.session_epoch === 2)
    assert.equal(epochTwo.length, 1)
    assert.equal(epochTwo[0]?.workspace_instance_id, 'host-beta')
    assert.equal(epochTwo[0]?.revision, 4)
    assert.equal(epochTwo[0]?.content.includes('>alpha<'), false)

    const stable = view
    view = Object.freeze({...view, session_title: 'Mismatched proof'})
    provider.workspaceContextProofStep = async (_item, proof) => {
      const candidate = structuredClone(proof) as {
        delivery: {revision: number}
      }
      candidate.delivery.revision += 1
      return await Promise.resolve(candidate)
    }
    await assert.rejects(publishAtomicContext(), /workspace context injection failed/u)
    assert.equal(provider.currentWorkspaceItem?.content.includes('Mismatched proof'), true)
    const mismatchedRevision = provider.currentWorkspaceItem?.revision

    provider.workspaceContextProofStep = null
    view = stable
    await publishAtomicContext()
    assert.equal(provider.currentWorkspaceItem?.content.includes('Mismatched proof'), false)
    assert.equal(provider.currentWorkspaceItem?.content, epochTwo[0]?.content)
    assert.ok((provider.currentWorkspaceItem?.revision ?? 0) > (mismatchedRevision ?? 0))

    view = Object.freeze({...stable, session_title: 'Timed out proof'})
    provider.workspaceContextProofStep = () => Promise.reject(new Error('provider proof timeout'))
    await assert.rejects(publishAtomicContext(), /workspace context injection failed/u)
    assert.equal(provider.currentWorkspaceItem?.content.includes('Timed out proof'), true)
    const timedOutRevision = provider.currentWorkspaceItem?.revision

    provider.workspaceContextProofStep = null
    view = stable
    await publishAtomicContext()
    assert.equal(provider.currentWorkspaceItem?.content, epochTwo[0]?.content)
    assert.ok((provider.currentWorkspaceItem?.revision ?? 0) > (timedOutRevision ?? 0))

    view = Object.freeze({...stable, session_title: 'Rejected recovery'})
    provider.workspaceContextProofStep = async (_item, proof) => {
      const candidate = structuredClone(proof) as {
        delivery: {workspace_instance_id: string}
      }
      candidate.delivery.workspace_instance_id = 'wrong-workspace'
      return await Promise.resolve(candidate)
    }
    await assert.rejects(publishAtomicContext(), /workspace context injection failed/u)
    assert.equal(provider.currentWorkspaceItem?.content.includes('Rejected recovery'), true)

    provider.workspaceContextProofStep = null
    provider.workspaceContextStep = () => Promise.reject(new Error('provider rejected replacement'))
    view = stable
    await assert.rejects(publishAtomicContext(), /workspace context injection failed/u)
    assert.equal(provider.currentWorkspaceItem?.content.includes('Rejected recovery'), true)

    provider.workspaceContextStep = null
    await publishAtomicContext()
    assert.equal(provider.currentWorkspaceItem?.content, epochTwo[0]?.content)
  } finally {
    await realtime.stop()
  }
})

test('delayed atomic view never pairs an immediate new graph with the prior workspace display',
  async () => {
    const clock = new VirtualClock(0)
    const confirmation = new ProjectConfirmationController({
      clock,
      idFactory: () => 'atomic-graph-confirmation',
    })
    const provider = new WorkspaceContextProvider()
    const contextObservers = new Set<(
      context: PublicProjectContext,
    ) => void | Promise<void>>()
    const workspaceObservers = new Set<(
      event: CommittedWorkspaceEvent,
    ) => void | Promise<void>>()
    const alpha: WorkspaceRecord = Object.freeze({
      workspace_id: 'host-alpha', display_name: 'alpha', normalized_name: 'alpha',
      canonical_path: '/safe/alpha', origin: 'registered', codex_home_key: 'host-alpha',
      active_session_id: null, created_at: 1, last_used_at: 1,
    })
    const beta: WorkspaceRecord = Object.freeze({
      workspace_id: 'host-beta', display_name: 'beta', normalized_name: 'beta',
      canonical_path: '/safe/beta', origin: 'registered', codex_home_key: 'host-beta',
      active_session_id: null, created_at: 2, last_used_at: 2,
    })
    let atomicContext: PublicProjectContext = Object.freeze({
      workspace_id: alpha.workspace_id,
      view: Object.freeze({
        workspace_display_name: 'alpha', session_title: null, pending_confirmation: false,
      }),
    })
    const adapterShape: ExecutorAdapter & Record<string, unknown> = {
      manifest: CODEX_PROJECT_MANIFEST,
      confirmationController: confirmation,
      dispatch: () => Promise.resolve({
        outcome: 'ok', trust: 'trusted_system', content: {code: 'unused'}, refs: [],
      }),
      commitConfirmed: () => Promise.resolve({accepted: false, code: 'unused'}),
      publicProjectView: () => atomicContext.view,
      publicProjectContext: () => atomicContext,
      initialize: () => Promise.resolve(),
      activeCommittedWorkspace: () => Promise.resolve(alpha),
      observeProjectView: () => () => undefined,
      observeProjectContext: (
        observer: (context: PublicProjectContext) => void | Promise<void>,
      ) => {
        contextObservers.add(observer)
        return () => { contextObservers.delete(observer) }
      },
      observeCommittedWorkspace: (
        observer: (event: CommittedWorkspaceEvent) => void | Promise<void>,
      ) => {
        workspaceObservers.add(observer)
        return () => { workspaceObservers.delete(observer) }
      },
      observeTerminalWorkOrder: () => () => undefined,
      close: () => Promise.resolve(),
    }
    const graphOpens: string[] = []
    let graphScope = 0
    const graph: RealtimeWorkspaceGraph = {
      publishedSnapshot: emptyPublishedGraphSnapshot(1),
      open: () => Promise.resolve(),
      revokeCurrentWorkspaceScope: () => ++graphScope,
      breakWorkspaceTransitionAdjacency: () => undefined,
      openWorkspace: input => {
        const suffix = input.repository_fingerprint === beta.workspace_id ? 'beta' : 'alpha'
        graphOpens.push(input.repository_fingerprint ?? '')
        return Promise.resolve({
          kind: 'resolved',
          resolution_basis: 'repository_fingerprint',
          logical_workspace: Object.freeze({
            logical_workspace_id: `logical-${suffix}`,
            display_name: suffix,
            aliases: [] as string[],
            canonical_remote: null,
            created_at: 1,
            updated_at: 1,
            revision: 1,
          }),
          instance: Object.freeze({
            instance_id: `instance-${suffix}`,
            logical_workspace_id: `logical-${suffix}`,
            display_name: suffix,
            path_label: suffix,
            repository_fingerprint: input.repository_fingerprint,
            branch: null,
            status: 'active',
            first_seen_at: 1,
            last_seen_at: 1,
            revision: 1,
          }),
          deltas: Object.freeze([]),
        })
      },
      recordTaskCompletion: () => Promise.resolve(),
      contextForTurn: input => Object.freeze({
        header: `graph=${input.workspace_instance_id}`,
        recall_pack: null,
        omitted_preferences: 0,
        omitted_hints: 0,
        degraded: false,
        diagnostic: null,
      }),
      close: () => Promise.resolve(),
    }
    const core = buildAssembly({
      settings: settingsSchema.parse({executors: ['codex']}),
      clock,
      gateway: new NeverCalledGateway(),
      searchTransport: new NeverCalledSearch(),
      executors: [adapterShape],
    })
    const realtime = buildRealtimeAssembly({
      core,
      provider,
      projectAdapter: adapterShape as unknown as ProjectCodexAdapter,
      workspaceGraph: graph,
    })

    await realtime.start()
    try {
      const beforeSwitch = provider.workspaceItems.length
      const committed = [...workspaceObservers][0]
      assert.ok(committed !== undefined)
      await committed({workspace: beta})
      await waitNamed('immediate beta graph completion', () => graphOpens.includes(beta.workspace_id))
      await yieldImmediate()
      await yieldImmediate()
      assert.equal(provider.workspaceItems.slice(beforeSwitch).some(item => (
        item.workspace_instance_id === beta.workspace_id
        && item.content.includes('workspace="alpha"')
        && item.content.includes('graph=instance-beta')
      )), false)

      atomicContext = Object.freeze({
        workspace_id: beta.workspace_id,
        view: Object.freeze({
          workspace_display_name: 'beta', session_title: null, pending_confirmation: false,
        }),
      })
      await Promise.all([...contextObservers].map(async observer => {
        await observer(atomicContext)
      }))
      await waitNamed('atomic beta graph context', () => (
        provider.workspaceItems.at(-1)?.workspace_instance_id === beta.workspace_id
      ))
      const current = provider.workspaceItems.at(-1)
      assert.ok(current !== undefined)
      assert.equal(current.content.includes('workspace="beta"'), true)
      assert.equal(current.content.includes('graph=instance-beta'), true)
    } finally {
      await realtime.stop()
    }
  })

test('project-mode startup fails closed before core/provider work without context capability',
  async () => {
    const clock = new VirtualClock(0)
    const confirmation = new ProjectConfirmationController({
      clock, idFactory: () => 'unsupported-context-confirmation',
    })
    const frameSource = new RecordingFrameSource()
    const provider = new AbortAwareProvider()
    const adapterShape: ExecutorAdapter & Record<string, unknown> = {
      manifest: CODEX_PROJECT_MANIFEST,
      confirmationController: confirmation,
      dispatch: () => Promise.resolve({
        outcome: 'ok', trust: 'trusted_system', content: {code: 'unused'}, refs: [],
      }),
      commitConfirmed: () => Promise.resolve({accepted: false, code: 'unused'}),
      publicProjectView: () => Object.freeze({
        workspace_display_name: null, session_title: null, pending_confirmation: false,
      }),
      publicProjectContext: () => Object.freeze({
        workspace_id: null,
        view: Object.freeze({
          workspace_display_name: null, session_title: null, pending_confirmation: false,
        }),
      }),
      initialize: () => Promise.resolve(),
      activeCommittedWorkspace: () => Promise.resolve(null),
      observeProjectView: () => () => undefined,
      observeProjectContext: () => () => undefined,
      observeCommittedWorkspace: () => () => undefined,
      observeTerminalWorkOrder: () => () => undefined,
      close: () => Promise.resolve(),
    }
    const core = buildAssembly({
      settings: settingsSchema.parse({executors: ['codex']}),
      clock,
      gateway: new NeverCalledGateway(),
      searchTransport: new NeverCalledSearch(),
      frameSource,
      executors: [adapterShape],
    })
    const realtime = buildRealtimeAssembly({
      core,
      provider,
      projectAdapter: adapterShape as unknown as ProjectCodexAdapter,
    })

    await assert.rejects(realtime.start(), /cannot deliver active project context/u)
    assert.equal(frameSource.starts, 0)
    assert.equal(provider.connectCalls, 0)
  })

test('workspace graph opens before project initialization, injects only the current Header, and owns hooks', async () => {
  const clock = new VirtualClock(50)
  const actions: string[] = []
  const provider = new WorkspaceContextProvider(actions)
  const workspaceObservers = new Set<(event: CommittedWorkspaceEvent) => void | Promise<void>>()
  const terminalObservers = new Set<(event: TerminalWorkOrderEvent) => void | Promise<void>>()
  const confirmation = new ProjectConfirmationController({clock, idFactory: () => 'graph-confirmation'})
  const workspace: WorkspaceRecord = Object.freeze({
    workspace_id: 'workspace-authoritative',
    display_name: 'alpha',
    normalized_name: 'alpha',
    canonical_path: '/safe/alpha',
    origin: 'registered' as const,
    codex_home_key: 'workspace-authoritative',
    active_session_id: null,
    created_at: 10,
    last_used_at: 20,
  })
  let projectClosed = 0
  const adapterShape: ExecutorAdapter & Record<string, unknown> = {
    manifest: CODEX_PROJECT_MANIFEST,
    confirmationController: confirmation,
    dispatch: () => Promise.resolve({
      outcome: 'ok', trust: 'trusted_system', content: {code: 'completed'}, refs: [],
    }),
    commitConfirmed: () => Promise.resolve({accepted: false, code: 'not_used'}),
    publicProjectView: () => Object.freeze({
      workspace_display_name: 'alpha', session_title: null, pending_confirmation: false,
    }),
    publicProjectContext: () => Object.freeze({
      workspace_id: workspace.workspace_id,
      view: Object.freeze({
        workspace_display_name: 'alpha', session_title: null, pending_confirmation: false,
      }),
    }),
    initialize: () => {
      actions.push('project:initialize')
      return Promise.resolve()
    },
    activeCommittedWorkspace: () => Promise.resolve(workspace),
    observeProjectView: () => () => undefined,
    observeProjectContext: () => () => undefined,
    observeCommittedWorkspace: (observer: (event: CommittedWorkspaceEvent) => void) => {
      workspaceObservers.add(observer)
      return () => { workspaceObservers.delete(observer) }
    },
    observeTerminalWorkOrder: (observer: (event: TerminalWorkOrderEvent) => void) => {
      terminalObservers.add(observer)
      return () => { terminalObservers.delete(observer) }
    },
    close: () => { projectClosed += 1; return Promise.resolve() },
  }
  const projectAdapter = adapterShape as unknown as ProjectCodexAdapter
  const graphCalls: unknown[] = []
  let graphClosed = 0
  let contextFailure = true
  let holdLifecycle = false
  const lifecycleGate = deferred<void>()
  let holdTerminal = false
  const terminalGate = deferred<void>()
  let workspaceQueueFailures = 0
  let graphScopeGeneration = 0
  const diagnostics: string[] = []
  const graph: RealtimeWorkspaceGraph = {
    publishedSnapshot: emptyPublishedGraphSnapshot(7),
    open: () => { actions.push('graph:open'); return Promise.resolve() },
    revokeCurrentWorkspaceScope: () => ++graphScopeGeneration,
    breakWorkspaceTransitionAdjacency: () => undefined,
    openWorkspace: async input => {
      actions.push('graph:workspace')
      graphCalls.push(input)
      if (workspaceQueueFailures > 0) {
        workspaceQueueFailures -= 1
        throw Object.assign(new Error('bounded service admission overflow'), {
          code: 'GRAPH_SERVICE_QUEUE_FULL',
        })
      }
      if (holdLifecycle) await lifecycleGate.promise
      return Promise.resolve({
        kind: 'resolved',
        resolution_basis: 'repository_fingerprint',
        logical_workspace: Object.freeze({
          logical_workspace_id: 'logical-alpha',
          display_name: 'alpha',
          aliases: [] as string[],
          canonical_remote: null,
          created_at: 20,
          updated_at: 20,
          revision: 1,
        }),
        instance: Object.freeze({
          instance_id: 'instance-alpha',
          logical_workspace_id: 'logical-alpha',
          display_name: 'alpha',
          path_label: 'alpha',
          repository_fingerprint: 'workspace-authoritative',
          branch: null,
          status: 'active',
          first_seen_at: 20,
          last_seen_at: 20,
          revision: 1,
        }),
        deltas: Object.freeze([]),
      })
    },
    recordTaskCompletion: async input => {
      graphCalls.push(input)
      if (holdTerminal) await terminalGate.promise
    },
    contextForTurn: input => {
      if (contextFailure) throw new Error('sensitive graph context failure')
      graphCalls.push(input)
      return Object.freeze({
        header: '<workspace_context kind="data">current alpha</workspace_context>',
        recall_pack: null,
        omitted_preferences: 0,
        omitted_hints: 0,
        degraded: false,
        diagnostic: null,
      })
    },
    close: () => { graphClosed += 1; actions.push('graph:close'); return Promise.resolve() },
  }
  const core = buildAssembly({
    settings: settingsSchema.parse({executors: ['codex']}),
    clock,
    gateway: new NeverCalledGateway(),
    searchTransport: new NeverCalledSearch(),
    frameSource: new RecordingFrameSource(actions),
    executors: [adapterShape],
  })
  let id = 0
  const realtime = buildRealtimeAssembly({
    core,
    provider,
    projectAdapter,
    workspaceGraph: graph,
    idFactory: () => `graph-host-${++id}`,
    wallClockNow: () => 1_800_000_000,
    onDiagnostic: line => { diagnostics.push(line) },
  })
  assert.throws(
    () => core.runtime.bindGraphContextProvider(() => null),
    /already bound/u,
    'RealtimeAssembly must own the sole runtime graph-context binding',
  )

  await realtime.start()
  assert.deepEqual(actions.slice(0, 6), [
    'graph:open',
    'project:initialize',
    'graph:workspace',
    'core:start',
    'provider:connect',
    'provider:events',
  ])
  assert.deepEqual(diagnostics, ['[realtime-diagnostic] workspace_graph_header_delivery_failed'])
  assert.equal(diagnostics.join('\n').includes('sensitive'), false)
  assert.equal(provider.workspaceItems.length, 1)
  assert.deepEqual(provider.workspaceItems[0], {
    kind: 'workspace_context',
    host_item_id: 'graph-host-1',
    event_id: 'graph-host-2',
    content: '<active_project_context>\nworkspace="alpha"\nsession=""\n</active_project_context>',
    call_id: null,
    session_epoch: 1,
    workspace_instance_id: 'workspace-authoritative',
    revision: 1,
  })
  contextFailure = false
  const workspaceObserver = [...workspaceObservers][0]
  assert.ok(workspaceObserver !== undefined)
  await workspaceObserver({workspace})
  await waitNamed('workspace Header retry', () => provider.workspaceItems.length === 2)
  assert.equal(provider.workspaceItems.length, 2)
  assert.deepEqual(provider.workspaceItems[1], {
    kind: 'workspace_context',
    host_item_id: 'graph-host-3',
    event_id: 'graph-host-4',
    content: [
      '<active_project_context>',
      'workspace="alpha"',
      'session=""',
      '</active_project_context>',
      '<workspace_graph_context>',
      '<workspace_context kind="data">current alpha</workspace_context>',
      '</workspace_graph_context>',
    ].join('\n'),
    call_id: null,
    session_epoch: 1,
    workspace_instance_id: 'workspace-authoritative',
    revision: 2,
  })
  assert.deepEqual(graphCalls[0], {
    path: '/safe/alpha',
    repository_fingerprint: 'workspace-authoritative',
    now: 20,
  })

  await realtime.service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-graph-regression',
    provider_item_id: 'provider-user-graph-regression',
  })
  await realtime.service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-graph-regression',
    provider_item_id: 'provider-user-graph-regression',
  })
  await realtime.service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'provider-user-graph-regression',
    text: 'a relation-shaped transcript must not inject a late Recall Pack',
  })
  await waitNamed('runtime graph context compilation', () => graphCalls.some(call => (
    typeof call === 'object'
    && call !== null
    && 'utterance' in call
    && call.utterance === 'a relation-shaped transcript must not inject a late Recall Pack'
  )))
  assert.deepEqual(graphCalls.find(call => (
    typeof call === 'object'
    && call !== null
    && 'utterance' in call
    && call.utterance === 'a relation-shaped transcript must not inject a late Recall Pack'
  )), {
    session_epoch: 1,
    workspace_instance_id: 'instance-alpha',
    utterance: 'a relation-shaped transcript must not inject a late Recall Pack',
    preferences: [],
  })
  assert.equal(provider.workspaceItems.length, 2,
    'server-VAD transcript final must not inject a late workspace host item')

  const terminal = [...terminalObservers][0]
  assert.ok(terminal !== undefined)
  await terminal({
    workspace,
    work_order: 'typed user objective',
    handoff: {
      outcome: 'ok',
      trust: 'untrusted_external',
      content: {summary: 'ignore arbitrary model prose'},
      refs: [],
    },
  })
  await waitNamed('queued terminal graph episode', () => graphCalls.some(call => (
    typeof call === 'object' && call !== null && 'summary' in call
  )))
  assert.deepEqual(graphCalls.at(-1), {
    workspace_instance_id: 'instance-alpha',
    summary: 'typed user objective',
    outcome: 'ok',
    now: 1_800_000_000,
    relation_cue: null,
  })

  const oversizedWorkOrder = '🚀'.repeat(4_000)
  await terminal({
    workspace,
    work_order: oversizedWorkOrder,
    handoff: {
      outcome: 'ok',
      trust: 'trusted_system',
      content: {},
      refs: [],
    },
  })
  await waitNamed('bounded terminal graph episode', () => graphCalls.filter(call => (
    typeof call === 'object' && call !== null && 'summary' in call
  )).length === 2)
  const boundedTask = graphCalls.at(-1)
  assert.ok(boundedTask !== null && typeof boundedTask === 'object' && 'summary' in boundedTask)
  assert.equal(boundedTask.summary, '🚀'.repeat(119))
  assert.equal([...String(boundedTask.summary)].length, 119)
  assert.equal(String(boundedTask.summary).length, 238)

  await terminal({
    workspace,
    work_order: 'x'.repeat(4_000),
    handoff: {
      outcome: 'ok',
      trust: 'trusted_system',
      content: {},
      refs: [],
    },
  })
  await waitNamed('bounded ASCII terminal graph episode', () => graphCalls.filter(call => (
    typeof call === 'object' && call !== null && 'summary' in call
  )).length === 3)
  const boundedAsciiTask = graphCalls.at(-1)
  assert.ok(
    boundedAsciiTask !== null
    && typeof boundedAsciiTask === 'object'
    && 'summary' in boundedAsciiTask,
  )
  assert.equal(boundedAsciiTask.summary, 'x'.repeat(239))

  await terminal({
    workspace,
    work_order: ' \t\n ',
    handoff: {
      outcome: 'ok',
      trust: 'trusted_system',
      content: {},
      refs: [],
    },
  })
  await waitNamed('empty terminal graph episode', () => graphCalls.filter(call => (
    typeof call === 'object' && call !== null && 'summary' in call
  )).length === 4)
  const emptyTask = graphCalls.at(-1)
  assert.ok(emptyTask !== null && typeof emptyTask === 'object' && 'summary' in emptyTask)
  assert.equal(emptyTask.summary, null)

  holdLifecycle = true
  const promptObserverResult = workspaceObserver({workspace})
  try {
    assert.equal(promptObserverResult, undefined,
      'authoritative project observers must enqueue graph work without awaiting it')
  } finally {
    holdLifecycle = false
    lifecycleGate.resolve(undefined)
  }

  holdTerminal = true
  for (let index = 0; index < 64; index += 1) {
    terminal({
      workspace,
      work_order: `queued terminal ${index}`,
      handoff: {outcome: 'ok', trust: 'trusted_system', content: {}, refs: []},
    })
  }
  await yieldImmediate()
  const latestWorkspace = Object.freeze({
    ...workspace,
    workspace_id: 'workspace-authoritative-latest',
    canonical_path: '/safe/latest',
    last_used_at: 60,
  })
  for (let index = 0; index < 8; index += 1) {
    workspaceObserver({
      workspace: Object.freeze({
        ...latestWorkspace,
        workspace_id: index === 7
          ? latestWorkspace.workspace_id
          : `workspace-authoritative-intermediate-${index}`,
        canonical_path: index === 7 ? latestWorkspace.canonical_path : `/safe/intermediate-${index}`,
      }),
    })
  }
  holdTerminal = false
  terminalGate.resolve(undefined)
  await waitNamed('coalesced latest workspace switch', () => graphCalls.some(call => (
    typeof call === 'object'
    && call !== null
    && 'repository_fingerprint' in call
    && call.repository_fingerprint === latestWorkspace.workspace_id
  )))

  workspaceQueueFailures = 2
  const retryWorkspace = Object.freeze({
    ...workspace,
    workspace_id: 'workspace-authoritative-retry',
    canonical_path: '/safe/retry',
    last_used_at: 70,
  })
  workspaceObserver({workspace: retryWorkspace})
  await waitNamed('service-admission workspace switch retry', () => graphCalls.filter(call => (
    typeof call === 'object'
    && call !== null
    && 'repository_fingerprint' in call
    && call.repository_fingerprint === retryWorkspace.workspace_id
  )).length === 3)

  await realtime.stop()
  const releaseReboundProvider = core.runtime.bindGraphContextProvider(() => null)
  releaseReboundProvider()
  assert.equal(graphClosed, 1)
  assert.equal(projectClosed, 1)
  assert.equal(workspaceObservers.size, 0)
  assert.equal(terminalObservers.size, 0)
})

test('real assembly and graph service infer only weak metadata from committed adjacent workspaces', async t => {
  const graphEventuallyMs = 5_000
  const directory = await mkdtemp(join(tmpdir(), 'nova-realtime-graph-transition-'))
  const workspaceObservers = new Set<(event: CommittedWorkspaceEvent) => void | Promise<void>>()
  const terminalObservers = new Set<(event: TerminalWorkOrderEvent) => void | Promise<void>>()
  const clock = new VirtualClock(3)
  const confirmation = new ProjectConfirmationController({clock, idFactory: () => 'transition-confirm'})
  const alpha: WorkspaceRecord = Object.freeze({
    workspace_id: 'host-alpha', display_name: 'alpha', normalized_name: 'alpha',
    canonical_path: '/safe/assembly-alpha', origin: 'registered', codex_home_key: 'host-alpha',
    active_session_id: null, created_at: 1, last_used_at: 1,
  })
  const beta: WorkspaceRecord = Object.freeze({
    workspace_id: 'host-beta', display_name: 'beta', normalized_name: 'beta',
    canonical_path: '/safe/assembly-beta', origin: 'registered', codex_home_key: 'host-beta',
    active_session_id: null, created_at: 2, last_used_at: 2,
  })
  const gamma: WorkspaceRecord = Object.freeze({
    workspace_id: 'host-gamma', display_name: 'gamma', normalized_name: 'gamma',
    canonical_path: '/safe/assembly-gamma', origin: 'registered', codex_home_key: 'host-gamma',
    active_session_id: null, created_at: 3, last_used_at: 3,
  })
  const delta: WorkspaceRecord = Object.freeze({
    workspace_id: 'host-delta', display_name: 'delta', normalized_name: 'delta',
    canonical_path: '/safe/assembly-delta', origin: 'registered', codex_home_key: 'host-delta',
    active_session_id: null, created_at: 4, last_used_at: 4,
  })
  const epsilon: WorkspaceRecord = Object.freeze({
    workspace_id: 'host-epsilon', display_name: 'epsilon', normalized_name: 'epsilon',
    canonical_path: '/safe/assembly-epsilon', origin: 'registered', codex_home_key: 'host-epsilon',
    active_session_id: null, created_at: 5, last_used_at: 5,
  })
  const adapterShape: ExecutorAdapter & Record<string, unknown> = {
    manifest: CODEX_PROJECT_MANIFEST,
    confirmationController: confirmation,
    dispatch: () => Promise.resolve({
      outcome: 'ok', trust: 'trusted_system', content: {code: 'completed'}, refs: [],
    }),
    commitConfirmed: () => Promise.resolve({accepted: false, code: 'not_used'}),
    publicProjectView: () => Object.freeze({
      workspace_display_name: 'alpha', session_title: null, pending_confirmation: false,
    }),
    publicProjectContext: () => Object.freeze({
      workspace_id: alpha.workspace_id,
      view: Object.freeze({
        workspace_display_name: 'alpha', session_title: null, pending_confirmation: false,
      }),
    }),
    initialize: () => Promise.resolve(),
    activeCommittedWorkspace: () => Promise.resolve(alpha),
    observeProjectView: () => () => undefined,
    observeProjectContext: () => () => undefined,
    observeCommittedWorkspace: (observer: (event: CommittedWorkspaceEvent) => void) => {
      workspaceObservers.add(observer)
      return () => { workspaceObservers.delete(observer) }
    },
    observeTerminalWorkOrder: (observer: (event: TerminalWorkOrderEvent) => void) => {
      terminalObservers.add(observer)
      return () => { terminalObservers.delete(observer) }
    },
    close: () => Promise.resolve(),
  }
  const projectAdapter = adapterShape as unknown as ProjectCodexAdapter
  let observation = 0
  let providerScopeLookups = 0
  const graph = new WorkspaceGraphService({
    path: join(directory, 'graph.sqlite'),
    id_factory: () => `assembly-transition-${++observation}`,
    personal_context_provider: {
      lookupWorkspaceEvidence: () => {
        providerScopeLookups += 1
        return Promise.resolve(Object.freeze({
          evidence: Object.freeze([]), omitted_evidence: 0,
          degraded: false, diagnostic: null,
        }))
      },
    },
  })
  const revokeGraphScope = graph.revokeCurrentWorkspaceScope.bind(graph)
  let graphScopeRevocations = 0
  graph.revokeCurrentWorkspaceScope = () => {
    graphScopeRevocations += 1
    return revokeGraphScope()
  }
  const recordGraphTaskCompletion = graph.recordTaskCompletion.bind(graph)
  const graphTaskCompletions: TaskCompletionInput[] = []
  graph.recordTaskCompletion = input => {
    graphTaskCompletions.push(input)
    return recordGraphTaskCompletion(input)
  }
  const diagnostics: string[] = []
  const core = buildAssembly({
    settings: settingsSchema.parse({executors: ['codex']}),
    clock,
    gateway: new NeverCalledGateway(),
    searchTransport: new NeverCalledSearch(),
    executors: [adapterShape],
    realtimeFrontbrain: true,
  })
  const realtime = buildRealtimeAssembly({
    core,
    provider: new WorkspaceContextProvider(),
    projectAdapter,
    workspaceGraph: graph,
    onDiagnostic: line => { diagnostics.push(line) },
  })
  t.after(async () => {
    await realtime.stop()
    await rm(directory, {recursive: true, force: true})
  })

  await realtime.start()
  await waitNamed('authoritative alpha graph open', () => (
    graph.publishedSnapshot.logical_workspaces.length === 1
  ), graphEventuallyMs)
  assert.equal(graph.publishedSnapshot.relations.length, 0)
  const alphaInstance = graph.publishedSnapshot.workspace_instances[0]
  assert.ok(alphaInstance !== undefined)
  const alphaProviderInput = {
    workspace_instance_id: alphaInstance.instance_id,
    query: 'explain current workspace evidence',
    limit: 1,
  } as const
  await settleNamed('authoritative alpha provider scope', (async () => {
    while ((await graph.enrichAfterExplicitRecall(alphaProviderInput)).degraded) {
      await yieldImmediate()
    }
  })())
  assert.equal(providerScopeLookups, 1)
  const committed = [...workspaceObservers][0]
  const terminal = [...terminalObservers][0]
  assert.ok(committed !== undefined)
  assert.ok(terminal !== undefined)
  const revocationsBeforeSwitch = graphScopeRevocations
  committed({workspace: beta})
  terminal({
    workspace: beta,
    work_order: 'beta objective committed before gamma became current',
    handoff: {outcome: 'ok', trust: 'trusted_system', content: {}, refs: []},
  })
  committed({workspace: gamma})
  assert.equal(graphScopeRevocations, revocationsBeforeSwitch + 2)
  assert.deepEqual(await graph.enrichAfterExplicitRecall(alphaProviderInput), {
    evidence: [], omitted_evidence: 0, degraded: true, diagnostic: 'protocol',
  }, 'committed-event admission must revoke old provider scope synchronously')
  assert.equal(providerScopeLookups, 1)
  await waitNamed('ordered authoritative alpha-to-beta-to-gamma transitions', () => (
    graph.publishedSnapshot.relations.length === 2
  ), graphEventuallyMs)
  await waitNamed('terminal event for the resolved stale-generation beta mapping', () => (
    graphTaskCompletions.length === 1
  ), graphEventuallyMs)
  assert.equal(graphTaskCompletions[0]?.workspace_instance_id, (
    graph.publishedSnapshot.workspace_instances.find(instance => (
      instance.repository_fingerprint === beta.workspace_id
    ))?.instance_id
  ))
  const idsByHost = new Map(graph.publishedSnapshot.workspace_instances.map(instance => (
    [instance.repository_fingerprint, instance.logical_workspace_id]
  )))
  assert.deepEqual(graph.publishedSnapshot.relations.map(relation => ({
    source: relation.source_logical_id,
    target: relation.target_logical_id,
    type: relation.relation_type,
    confidence: relation.confidence,
    status: relation.status,
  })), [
    {
      source: idsByHost.get('host-alpha'), target: idsByHost.get('host-beta'),
      type: 'discussed_with', confidence: 0.4, status: 'weak',
    },
    {
      source: idsByHost.get('host-beta'), target: idsByHost.get('host-gamma'),
      type: 'discussed_with', confidence: 0.4, status: 'weak',
    },
  ])
  assert.equal(JSON.stringify(graph.publishedSnapshot.relations).includes('/safe/'), false)

  committed({workspace: Object.freeze({...gamma, canonical_path: 'speculative-relative-path'})})
  await waitNamed('rejected speculative transition', () => (
    diagnostics.some(line => line.endsWith('workspace_graph_lifecycle_failed'))
  ), graphEventuallyMs)
  assert.equal(graph.publishedSnapshot.relations.length, 2)
  assert.ok(graph.publishedSnapshot.relations.every(relation => (
    relation.revision === 0 && relation.evidence_refs.length === 1
  )))

  committed({workspace: delta})
  await waitNamed('successful workspace after a rejected admitted transition', () => (
    graph.publishedSnapshot.workspace_instances.some(instance => (
      instance.repository_fingerprint === delta.workspace_id
    ))
  ), graphEventuallyMs)
  assert.equal(
    graph.publishedSnapshot.relations.length,
    2,
    'a processing failure must break adjacency instead of inferring gamma-to-delta',
  )

  committed({workspace: epsilon})
  await waitNamed('new adjacency after the post-gap workspace becomes the anchor', () => (
    graph.publishedSnapshot.relations.length === 3
  ), graphEventuallyMs)
  const postGapIds = new Map(graph.publishedSnapshot.workspace_instances.map(instance => (
    [instance.repository_fingerprint, instance.logical_workspace_id]
  )))
  const postGapRelation = graph.publishedSnapshot.relations.find(relation => (
    relation.source_logical_id === postGapIds.get('host-delta')
    && relation.target_logical_id === postGapIds.get('host-epsilon')
  ))
  assert.ok(postGapRelation !== undefined)
  assert.deepEqual({
    type: postGapRelation.relation_type,
    reason: postGapRelation.reason,
    confidence: postGapRelation.confidence,
    status: postGapRelation.status,
    first_seen_at: postGapRelation.first_seen_at,
    last_seen_at: postGapRelation.last_seen_at,
    evidence: postGapRelation.evidence_refs.map(evidence => ({
      source: evidence.source,
      observed_at: evidence.observed_at,
    })),
    revision: postGapRelation.revision,
  }, {
    type: 'discussed_with',
    reason: 'adjacent confirmed workspace transition',
    confidence: 0.4,
    status: 'weak',
    first_seen_at: 5,
    last_seen_at: 5,
    evidence: [{source: 'runtime', observed_at: 5}],
    revision: 0,
  })
})

test('never-settling graph open is bounded and cannot block voice startup', async () => {
  const openGate = deferred<void>()
  const diagnostics: string[] = []
  let closes = 0
  const graph = {
    publishedSnapshot: emptyPublishedGraphSnapshot(0),
    open: () => openGate.promise,
    revokeCurrentWorkspaceScope: () => 1,
    breakWorkspaceTransitionAdjacency: () => undefined,
    openWorkspace: () => Promise.reject(new Error('not expected')),
    recordTaskCompletion: () => Promise.reject(new Error('not expected')),
    contextForTurn: () => null,
    close: () => { closes += 1; return Promise.resolve() },
  } as RealtimeWorkspaceGraph
  const provider = new AbortAwareProvider()
  const realtime = buildRealtimeAssembly({
    core: realCore(), provider, workspaceGraph: graph,
    onDiagnostic: line => { diagnostics.push(line) },
  })
  const start = realtime.start()
  try {
    await settleNamed('bounded graph open', start, 1_750)
    assert.equal(provider.connectCalls, 1)
    assert.ok(diagnostics.includes('[realtime-diagnostic] workspace_graph_open_abandoned'))
    await settleNamed('bounded stop with graph open pending', realtime.stop(), 2_750)
    assert.equal(closes, 1)
    assert.ok(diagnostics.filter(line => (
      line === '[realtime-diagnostic] workspace_graph_open_abandoned'
    )).length >= 2)
    openGate.resolve(undefined)
    await yieldImmediate()
    await realtime.stop()
    assert.equal(closes, 2)
  } finally {
    openGate.resolve(undefined)
    await Promise.allSettled([start])
    await realtime.stop()
  }
})

test('never-settling initial Header delivery cannot block voice startup', async () => {
  const headerGate = deferred<void>()
  const diagnostics: string[] = []
  const provider = new WorkspaceContextProvider()
  // Epochs are monotonic provider identities, not a promise that the first one is exactly 1.
  provider.currentEpoch = 6
  provider.workspaceContextStep = () => headerGate.promise
  const clock = new VirtualClock(50)
  const confirmation = new ProjectConfirmationController({
    clock,
    idFactory: () => 'header-confirmation',
  })
  const workspace: WorkspaceRecord = Object.freeze({
    workspace_id: 'workspace-header',
    display_name: 'header',
    normalized_name: 'header',
    canonical_path: '/safe/header',
    origin: 'registered',
    codex_home_key: 'workspace-header',
    active_session_id: null,
    created_at: 10,
    last_used_at: 20,
  })
  const adapterShape: ExecutorAdapter & Record<string, unknown> = {
    manifest: CODEX_PROJECT_MANIFEST,
    confirmationController: confirmation,
    dispatch: () => Promise.resolve({
      outcome: 'ok', trust: 'trusted_system', content: {code: 'completed'}, refs: [],
    }),
    commitConfirmed: () => Promise.resolve({accepted: false, code: 'not_used'}),
    publicProjectView: () => Object.freeze({
      workspace_display_name: 'header', session_title: null, pending_confirmation: false,
    }),
    publicProjectContext: () => Object.freeze({
      workspace_id: workspace.workspace_id,
      view: Object.freeze({
        workspace_display_name: 'header', session_title: null, pending_confirmation: false,
      }),
    }),
    initialize: () => Promise.resolve(),
    activeCommittedWorkspace: () => Promise.resolve(workspace),
    observeProjectView: () => () => undefined,
    observeProjectContext: () => () => undefined,
    observeCommittedWorkspace: () => () => undefined,
    observeTerminalWorkOrder: () => () => undefined,
    close: () => Promise.resolve(),
  }
  const projectAdapter = adapterShape as unknown as ProjectCodexAdapter
  const graph: RealtimeWorkspaceGraph = {
    publishedSnapshot: emptyPublishedGraphSnapshot(7),
    open: () => Promise.resolve(),
    revokeCurrentWorkspaceScope: () => 1,
    breakWorkspaceTransitionAdjacency: () => undefined,
    openWorkspace: () => Promise.resolve({
      kind: 'resolved',
      resolution_basis: 'repository_fingerprint',
      logical_workspace: Object.freeze({
        logical_workspace_id: 'logical-header', display_name: 'header', aliases: [],
        canonical_remote: null, created_at: 20, updated_at: 20, revision: 1,
      }),
      instance: Object.freeze({
        instance_id: 'instance-header', logical_workspace_id: 'logical-header',
        display_name: 'header', path_label: 'header',
        repository_fingerprint: 'workspace-header', branch: null, status: 'active',
        first_seen_at: 20, last_seen_at: 20, revision: 1,
      }),
      deltas: Object.freeze([]),
    }),
    recordTaskCompletion: () => Promise.resolve(),
    contextForTurn: () => Object.freeze({
      header: '<workspace_context kind="data">current header</workspace_context>',
      recall_pack: null, omitted_preferences: 0, omitted_hints: 0, degraded: false,
      diagnostic: null,
    }),
    close: () => Promise.resolve(),
  }
  const core = buildAssembly({
    settings: settingsSchema.parse({executors: ['codex']}),
    clock,
    gateway: new NeverCalledGateway(),
    searchTransport: new NeverCalledSearch(),
    executors: [adapterShape],
  })
  const realtime = buildRealtimeAssembly({
    core, provider, projectAdapter, workspaceGraph: graph,
    onDiagnostic: line => { diagnostics.push(line) },
  })
  const start = realtime.start()
  try {
    await settleNamed('bounded initial Header delivery', start, 1_750)
    assert.equal(provider.connectCalls, 1)
    assert.ok(provider.workspaceItems.length >= 1)
    assert.ok(diagnostics.includes(
      '[realtime-diagnostic] workspace_graph_header_delivery_abandoned',
    ))
  } finally {
    headerGate.resolve(undefined)
    await Promise.allSettled([start])
    await realtime.stop()
  }
})

test('abandoned graph close remains cleanup-incomplete and is retried by the assembly owner', async () => {
  const closeGate = deferred<void>()
  const diagnostics: string[] = []
  let closes = 0
  const graph = {
    publishedSnapshot: emptyPublishedGraphSnapshot(0),
    open: () => Promise.resolve(),
    revokeCurrentWorkspaceScope: () => 1,
    breakWorkspaceTransitionAdjacency: () => undefined,
    openWorkspace: () => Promise.reject(new Error('not expected')),
    recordTaskCompletion: () => Promise.reject(new Error('not expected')),
    contextForTurn: () => null,
    close: () => {
      closes += 1
      return closes === 1 ? closeGate.promise : Promise.resolve()
    },
  } as RealtimeWorkspaceGraph
  const realtime = buildRealtimeAssembly({
    core: realCore(), provider: new AbortAwareProvider(), workspaceGraph: graph,
    onDiagnostic: line => { diagnostics.push(line) },
  })
  await realtime.start()
  await settleNamed('first bounded graph close', realtime.stop(), 1_750)
  assert.equal(closes, 1)
  assert.ok(diagnostics.includes('[realtime-diagnostic] workspace_graph_close_abandoned'))
  closeGate.resolve(undefined)
  await yieldImmediate()
  await realtime.stop()
  assert.equal(closes, 2)
})

test('workspace graph open failure is diagnostic-only and never blocks voice startup', async () => {
  const diagnostics: string[] = []
  let closes = 0
  const graph = {
    publishedSnapshot: emptyPublishedGraphSnapshot(0),
    open: () => Promise.reject(new Error('sensitive graph failure detail')),
    revokeCurrentWorkspaceScope: () => 1,
    breakWorkspaceTransitionAdjacency: () => undefined,
    openWorkspace: () => Promise.reject(new Error('not expected')),
    recordTaskCompletion: () => Promise.reject(new Error('not expected')),
    contextForTurn: () => null,
    close: () => { closes += 1; return Promise.resolve() },
  } as RealtimeWorkspaceGraph
  const provider = new AbortAwareProvider()
  const realtime = buildRealtimeAssembly({
    core: realCore(),
    provider,
    workspaceGraph: graph,
    onDiagnostic: line => { diagnostics.push(line) },
  })

  await realtime.start()
  assert.equal(provider.connectCalls, 1)
  assert.deepEqual(diagnostics, ['[realtime-diagnostic] workspace_graph_open_failed'])
  assert.equal(diagnostics.join('\n').includes('sensitive'), false)
  await realtime.stop()
  assert.equal(closes, 1)
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

test('Codex resource starts after provider service and closes after service and core', async () => {
  const actions: string[] = []
  const adapter: ExecutorAdapter = {
    manifest: CODEX_LIVE_MANIFEST,
    dispatch: (): Promise<ExecutorHandoff> => Promise.resolve({
      outcome: 'failed',
      trust: 'trusted_system',
      content: {code: 'not_run'},
    }),
  }
  const resource: CodexAssemblyResource = {
    adapter,
    mode: 'live',
    projectView: null,
    start: () => { actions.push('codex:start'); return Promise.resolve() },
    close: () => { actions.push('codex:close'); return Promise.resolve() },
  }
  const frame = new RecordingFrameSource(actions)
  const core = buildAssembly({
    settings: settingsSchema.parse({executors: ['codex']}),
    clock: new VirtualClock(),
    gateway: new NeverCalledGateway(),
    searchTransport: new NeverCalledSearch(),
    frameSource: frame,
    executors: [adapter],
  })
  const realtime = buildRealtimeAssembly({
    core,
    provider: new AbortAwareProvider(actions),
    codexResource: resource,
    onDiagnostic: () => undefined,
  })

  await realtime.start()
  assert.ok(actions.indexOf('provider:connect') < actions.indexOf('codex:start'))
  await realtime.stop()
  assert.ok(actions.indexOf('provider:close') < actions.indexOf('core:stop'))
  assert.ok(actions.indexOf('core:stop') < actions.indexOf('codex:close'))
  await realtime.stop()
  assert.equal(actions.filter(item => item === 'codex:close').length, 1)
})

test('a failed Codex close remains physically retryable through the realtime owner', async () => {
  const adapter: ExecutorAdapter = {
    manifest: CODEX_LIVE_MANIFEST,
    dispatch: (): Promise<ExecutorHandoff> => Promise.resolve({
      outcome: 'failed',
      trust: 'trusted_system',
      content: {code: 'not_run'},
    }),
  }
  const closeFailure = new Error('retained Codex cleanup')
  let closeCalls = 0
  const resource: CodexAssemblyResource = {
    adapter,
    mode: 'live',
    projectView: null,
    start: () => Promise.resolve(),
    close: () => {
      closeCalls += 1
      return closeCalls === 1 ? Promise.reject(closeFailure) : Promise.resolve()
    },
  }
  const realtime = buildRealtimeAssembly({
    core: buildAssembly({
      settings: settingsSchema.parse({executors: ['codex']}),
      clock: new VirtualClock(),
      gateway: new NeverCalledGateway(),
      searchTransport: new NeverCalledSearch(),
      frameSource: new RecordingFrameSource(),
      executors: [adapter],
    }),
    provider: new AbortAwareProvider(),
    codexResource: resource,
    onDiagnostic: () => undefined,
  })

  await realtime.start()
  await assert.rejects(realtime.stop(), error => error === closeFailure)
  await realtime.stop()
  assert.equal(closeCalls, 2)
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
