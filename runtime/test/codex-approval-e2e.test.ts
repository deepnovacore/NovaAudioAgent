import assert from 'node:assert/strict'
import {setImmediate as yieldImmediate} from 'node:timers/promises'
import {test, type TestContext} from 'node:test'

import {WebSocket, type RawData} from 'ws'

import {VirtualClock, type Clock} from '../src/clock.js'
import {CODEX_PROJECT_APPROVAL_MANIFEST} from '../src/codex-contract.js'
import {OwnedCodexAppServerTransport} from '../src/codex-app-server-transport.js'
import {DesktopRealtime} from '../src/desktop-realtime.js'
import {
  NodeDesktopServer,
  type DesktopControl,
  type DesktopServerOptions,
} from '../src/desktop.js'
import {Memory} from '../src/memory.js'
import {
  hostBinaryForTest,
  hostCodexHomeForTest,
  hostWorkspaceForTest,
} from '../src/codex-process-owner.js'
import {PlaybackRegistry} from '../src/playback.js'
import {RealtimeRuntimeBridge} from '../src/realtime/bridge.js'
import {CodexApprovalController} from '../src/realtime/codex-approval.js'
import type {HostContextItem, HostResponseIntent} from '../src/realtime/protocol.js'
import {RealtimeService, type ServiceProvider} from '../src/realtime/service.js'
import {RealtimeSession, type SessionProvider} from '../src/realtime/session.js'
import {compileToolSchema} from '../src/tool-schema.js'
import {
  FakeAppServerOwnerFactory,
  type FakeAppServerScenario,
} from './fixtures/codex/fake-app-server-owner.js'
import {supportedSchemaBundle} from './fixtures/codex/supported-schema-bundle.js'

const DESKTOP_TOKEN = '1'.repeat(32)
const TEST_TIMEOUT_MS = 5_000

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => { resolvePromise = resolve })
  return {promise, resolve: resolvePromise}
}

class FakeRealtimeProvider implements SessionProvider, ServiceProvider {
  readonly injected: HostContextItem[] = []
  readonly responseIntents: HostResponseIntent[] = []
  #epoch = 0
  #endEvents = deferred<void>()

  connect(): Promise<{readonly epoch: number}> {
    this.#epoch += 1
    return Promise.resolve({epoch: this.#epoch})
  }

  injectHostItem(item: HostContextItem): Promise<{
    readonly session_epoch: number
    readonly host_item_id: string
    readonly provider_item_id: string
  }> {
    this.injected.push(structuredClone(item))
    return Promise.resolve({
      session_epoch: this.#epoch,
      host_item_id: item.host_item_id,
      provider_item_id: `provider-${item.host_item_id}`,
    })
  }

  createResponse(intent: HostResponseIntent): Promise<void> {
    this.responseIntents.push(structuredClone(intent))
    return Promise.resolve()
  }

  cancelResponse(): Promise<void> { return Promise.resolve() }
  sendAudio(): Promise<void> { return Promise.resolve() }

  async *events(signal: AbortSignal): AsyncIterable<never> {
    await Promise.race([
      this.#endEvents.promise,
      new Promise<void>(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, {once: true})
      }),
    ])
  }

  endNonrecoverably(): void { this.#endEvents.resolve() }
  close(): Promise<void> { return Promise.resolve() }
}

class DesktopInboundObserver {
  readonly controls: DesktopControl[] = []
  #changed = deferred<void>()

  createServer(options: DesktopServerOptions): NodeDesktopServer {
    return new NodeDesktopServer({
      ...options,
      onControl: async control => {
        await options.onControl?.(control)
        this.controls.push(structuredClone(control))
        this.#changed.resolve()
        this.#changed = deferred()
      },
    })
  }

  async waitForCount(count: number, label: string): Promise<void> {
    while (this.controls.length < count) {
      const changed = this.#changed.promise
      await within(changed, label)
    }
  }
}

interface RealtimeHarness {
  readonly service: RealtimeService
  readonly provider: FakeRealtimeProvider
}

function realtimeHarness(
  controller: CodexApprovalController,
  clock: Clock,
): RealtimeHarness {
  const provider = new FakeRealtimeProvider()
  const memory = new Memory({policies: [CODEX_PROJECT_APPROVAL_MANIFEST.policy]})
  const executors = new Map([[
    CODEX_PROJECT_APPROVAL_MANIFEST.name,
    {manifest: CODEX_PROJECT_APPROVAL_MANIFEST},
  ]])
  const tools = compileToolSchema([CODEX_PROJECT_APPROVAL_MANIFEST])
  let nextId = 0
  const idFactory = (): string => `e2e-${++nextId}`
  const playback = new PlaybackRegistry({
    idFactory,
    onFrame: () => undefined,
    onClear: () => undefined,
    onAlert: () => undefined,
  })
  const session = new RealtimeSession({provider, playback, idFactory, clock})
  let inputSequence = 0
  const bridge = new RealtimeRuntimeBridge({
    runtime: {
      clock,
      memory,
      executors,
      ingestUserInput: input => {
        inputSequence += 1
        const item = memory.append('conversation', {
          ts: inputSequence,
          trust: 'trusted_user',
          priority: 100,
          content: {text: input.text},
        })
        return Promise.resolve(`${item.channel}:${item.seq}`)
      },
      updateExternal: () => true,
      dispatchExternal: () => ({accepted: false, delegate_id: null}),
    },
    tools,
    idFactory,
  })
  const parkedRuntime = (signal: AbortSignal): Promise<void> => new Promise(resolve => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, {once: true})
  })
  const service = new RealtimeService({
    provider,
    runtime: {
      clock,
      executors,
      observe: () => () => undefined,
      serve: parkedRuntime,
      claimedHandoff: () => undefined,
      terminatedByDeadline: () => false,
      delegateFor: () => undefined,
      inFlightDelegate: () => undefined,
    },
    tools,
    session,
    bridge,
    codexApproval: controller,
    idFactory,
    onDiagnostic: () => undefined,
  })
  return {service, provider}
}

function createFakeTransport(
  factory: FakeAppServerOwnerFactory,
  controller: CodexApprovalController,
): OwnedCodexAppServerTransport {
  const workspace = process.cwd()
  return new OwnedCodexAppServerTransport({
    config: {
      binary: hostBinaryForTest(process.execPath),
      workspace: hostWorkspaceForTest(workspace),
      codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
      apiKey: null,
      developerInstructions: null,
      resumeThreadId: null,
      persistent: false,
      approvalPolicy: 'on-request',
      approvalController: controller,
    },
    processFactory: factory,
    credentialSnapshotter: {
      prepare: () => Promise.resolve({} as never),
      environment: () => ({
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        CODEX_HOME: workspace,
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      }),
      removeEphemeralHome: () => Promise.resolve(),
    },
    preflightRunner: {run: () => Promise.resolve({
      version: '0.149.1',
      root_matches: true,
      mount: 'workspace_only',
      subprocess: 'contained',
      network: 'blocked',
      credential: {present: true, identity: 'chatgpt', policy: 'saved_login'},
      limits: {cpu: 'finite', as: 'finite', nofile: 'finite'},
    })},
    schemaProbe: {generate: () => Promise.resolve(supportedSchemaBundle())},
  })
}

interface ApprovalE2e {
  readonly controller: CodexApprovalController
  readonly factory: FakeAppServerOwnerFactory
  readonly provider: FakeRealtimeProvider
  readonly running: ReturnType<OwnedCodexAppServerTransport['run']>
  readonly service: RealtimeService
  readonly transport: OwnedCodexAppServerTransport
}

async function startApprovalE2e(
  t: TestContext,
  scenario: FakeAppServerScenario,
  options: {readonly clock?: Clock; readonly startService?: boolean} = {},
): Promise<ApprovalE2e> {
  const clock = options.clock ?? new VirtualClock(100)
  const factory = new FakeAppServerOwnerFactory(scenario)
  const controller = new CodexApprovalController({
    clock,
    idFactory: () => `public-${scenario}`,
  })
  const transport = createFakeTransport(factory, controller)
  const {service, provider} = realtimeHarness(controller, clock)
  if (options.startService === true) await service.start()
  else await service.connect()
  const running = transport.run(
    {workOrder: 'credential-free approval E2E'},
    {},
    {expiresAtMs: Date.now() + 10_000},
  )
  t.after(async () => {
    await service.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
    await factory.owner?.killTree().catch(() => undefined)
    await factory.owner?.dispose().catch(() => undefined)
  })
  await waitUntil(() => factory.owner !== null, `${scenario} owner`)
  await within(factory.owner!.waitForBarrier('approval_request'), `${scenario} request`)
  return {controller, factory, provider, running, service, transport}
}

async function reserveUserDecision(
  service: RealtimeService,
  input: {readonly itemId: string; readonly responseId: string; readonly transcript?: string},
): Promise<void> {
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: `speech-${input.itemId}`,
    provider_item_id: input.itemId,
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: `speech-${input.itemId}`,
    provider_item_id: input.itemId,
  })
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: input.responseId,
  })
  if (input.transcript !== undefined) {
    await service.handleEvent({
      kind: 'user_transcript_final',
      session_epoch: 1,
      item_id: input.itemId,
      text: input.transcript,
    })
  }
}

async function sendApprovalTool(
  service: RealtimeService,
  input: {
    readonly approvalId: string
    readonly approved: boolean
    readonly itemId: string
    readonly responseId: string
    readonly transcript: string
  },
): Promise<void> {
  await reserveUserDecision(service, {itemId: input.itemId, responseId: input.responseId})
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: `call-${input.itemId}`,
    item_id: `function-${input.itemId}`,
    response_id: input.responseId,
    name: 'codex__confirm_codex_approval',
    arguments: {approval_id: input.approvalId, approved: input.approved},
  })
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: input.itemId,
    text: input.transcript,
  })
}

async function finishResponse(service: RealtimeService, responseId: string): Promise<void> {
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: responseId,
    status: 'completed',
    reason: 'completed',
  })
}

test('Windows file approval crosses fake app-server, Codex function authority, and terminal completion', async t => {
  const e2e = await startApprovalE2e(t, 'file-approval')
  await waitUntil(() => e2e.controller.pending, 'voice controller pending')
  const approvalId = e2e.controller.view.pending_approval_id!
  const prompt = e2e.service.queuedHostItems().find(item => (
    item.intent.item.event_id === `codex-approval:${approvalId}:requested`
  ))?.intent.item.content
  assert.deepEqual(JSON.parse(prompt ?? ''), {
    approval_id: approvalId,
    kind: 'file_change',
    operation_summary: 'Codex 请求修改工作区文件。',
  })

  await reserveUserDecision(e2e.service, {
    itemId: 'voice-accept',
    responseId: 'response-voice-accept',
  })
  await e2e.service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1,
    call_id: 'call-voice-accept', item_id: 'function-voice-accept',
    response_id: 'response-voice-accept', name: 'codex__confirm_codex_approval',
    arguments: {approval_id: approvalId, approved: true},
  })
  assert.equal(e2e.controller.pending, false, 'the function settles before any transcript')
  assert.equal(await within(e2e.factory.owner!.approvalDecision, 'voice wire decision'), 'accept')
  assert.equal(e2e.controller.pending, false, 'the exact structured carrier settles the request')
  await e2e.service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'voice-accept', text: '确认。',
  })
  assert.equal(
    await within(
      e2e.factory.owner!.probeApprovalResponseCountForTest(),
      'voice approval response count',
    ),
    1,
    'voice authority writes exactly one JSON-RPC response',
  )
  await finishResponse(e2e.service, 'response-voice-accept')
  const result = await within(e2e.running, 'voice terminal completion')
  assert.equal(result.classification, 'completed')
  assert.equal(result.completion?.final_text, 'fixture result')
})

test('Windows renderer decision crosses real desktop loopback into the same transport controller', async t => {
  const clock = new VirtualClock(100)
  const e2e = await startApprovalE2e(t, 'file-approval-held-terminal', {clock})
  const stop = new AbortController()
  const inbound = new DesktopInboundObserver()
  const desktop = new DesktopRealtime({
    token: DESKTOP_TOKEN,
    service: e2e.service,
    stop,
    clock,
    approvalView: e2e.controller.view,
    createServer: options => inbound.createServer(options),
  })
  const unsubscribe = e2e.controller.observe(view => { desktop.bridge.onCodexApproval(view) })
  let socket: WebSocket | null = null
  const readiness = await within(desktop.server.start(), 'desktop server start')
  t.after(async () => {
    unsubscribe()
    if (socket !== null) await closeDesktop(socket)
    await desktop.server.close()
  })
  socket = await connectDesktop(readiness.port)
  const approvalFrame = nextTextFrame(socket, frame => frame.type === 'codex.approval')
  await sendSocket(socket, JSON.stringify({type: 'hello', token: DESKTOP_TOKEN}))
  desktop.bridge.onCodexApproval(e2e.controller.view)
  const publicView = await within(approvalFrame, 'desktop approval frame')
  assert.equal(publicView.pending_approval, true)
  const approvalId = String(publicView.pending_approval_id)

  await sendSocket(socket, JSON.stringify({
    type: 'codex.approval_decision', approval_id: 'stale-public-id', approved: false,
  }))
  await inbound.waitForCount(1, 'stale desktop inbound decision')
  assert.equal(e2e.controller.pending, true, 'stale renderer ID has no authority')
  await sendSocket(socket, JSON.stringify({
    type: 'codex.approval_decision', approval_id: approvalId, approved: true,
  }))
  await inbound.waitForCount(2, 'valid desktop inbound decision')
  assert.equal(await within(e2e.factory.owner!.approvalDecision, 'desktop wire decision'), 'accept')
  await sendSocket(socket, JSON.stringify({
    type: 'codex.approval_decision', approval_id: approvalId, approved: false,
  }))
  await inbound.waitForCount(3, 'duplicate desktop inbound decision')

  assert.deepEqual(inbound.controls, [
    {type: 'codex.approval_decision', approval_id: 'stale-public-id', approved: false},
    {type: 'codex.approval_decision', approval_id: approvalId, approved: true},
    {type: 'codex.approval_decision', approval_id: approvalId, approved: false},
  ])
  assert.equal(
    await within(
      e2e.factory.owner!.probeApprovalResponseCountForTest(),
      'desktop approval response count',
    ),
    1,
    'duplicate renderer decision never writes a second JSON-RPC response',
  )
  e2e.factory.owner!.release('approval_turn_completion')
  const result = await within(e2e.running, 'desktop terminal completion')
  assert.equal(result.classification, 'completed')
  assert.equal(e2e.service.codexApprovalDecision(approvalId, false), false, 'duplicate is spent')
  assert.equal(stop.signal.aborted, false)
})

test('explicit Realtime refusal writes one decline and still reaches server terminal', async t => {
  const e2e = await startApprovalE2e(t, 'file-approval-decline')
  await waitUntil(() => e2e.controller.pending, 'decline controller pending')
  const approvalId = e2e.controller.view.pending_approval_id!
  await sendApprovalTool(e2e.service, {
    approvalId,
    approved: false,
    itemId: 'voice-decline',
    responseId: 'response-voice-decline',
    transcript: '拒绝。',
  })
  assert.equal(await within(e2e.factory.owner!.approvalDecision, 'decline wire decision'), 'decline')
  const result = await within(e2e.running, 'decline terminal completion')
  assert.equal(result.classification, 'completed')
  assert.equal(e2e.service.codexApprovalDecision(approvalId, true), false)
})

test('expiry and provider reconnect each revoke authority and write decline through the real transport', async t => {
  for (const mode of ['expiry', 'reconnect'] as const) {
    await t.test(mode, async t => {
      const clock = new VirtualClock(100)
      const e2e = await startApprovalE2e(t, 'file-approval-decline', {clock})
      await waitUntil(() => e2e.controller.pending, `${mode} controller pending`)
      const approvalId = e2e.controller.view.pending_approval_id!
      if (mode === 'expiry') clock.advanceTo(e2e.controller.view.expires_at!)
      else assert.equal(await e2e.service.reconnectForTest(1), true)
      assert.equal(await within(e2e.factory.owner!.approvalDecision, `${mode} wire decision`), 'decline')
      assert.equal((await within(e2e.running, `${mode} terminal completion`)).classification, 'completed')
      assert.equal(e2e.service.codexApprovalDecision(approvalId, true), false)
    })
  }
})

test('a duplicate Codex function arriving after settlement cannot spend the request twice', async t => {
  const e2e = await startApprovalE2e(t, 'file-approval-held-terminal')
  await waitUntil(() => e2e.controller.pending, 'late tool controller pending')
  const approvalId = e2e.controller.view.pending_approval_id!
  await sendApprovalTool(e2e.service, {
    approvalId, approved: true,
    itemId: 'late-tool', responseId: 'response-late-tool', transcript: '确认。',
  })
  assert.equal(await within(e2e.factory.owner!.approvalDecision, 'function voice accept'), 'accept')
  assert.equal(e2e.controller.pending, false)
  await finishResponse(e2e.service, 'response-late-tool')
  await e2e.service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-late-tool',
    item_id: 'function-late-tool',
    response_id: 'response-late-tool',
    name: 'codex__confirm_codex_approval',
    arguments: {approval_id: approvalId, approved: true},
  })
  assert.equal(e2e.controller.pending, false)
  assert.equal(e2e.service.codexApprovalDecision(approvalId, false), false)
  assert.equal(
    await within(
      e2e.factory.owner!.probeApprovalResponseCountForTest(),
      'late tool approval response count',
    ),
    1,
    'the late compatibility tool never writes a second JSON-RPC response',
  )
  e2e.factory.owner!.release('approval_turn_completion')
  assert.equal((await within(e2e.running, 'late tool terminal completion')).classification, 'completed')
})

test('service close and nonrecoverable provider end revoke pending transport authority', async t => {
  for (const mode of ['close', 'provider-end'] as const) {
    await t.test(mode, async t => {
      const e2e = await startApprovalE2e(t, 'file-approval-decline', {
        startService: mode === 'provider-end',
      })
      await waitUntil(() => e2e.controller.pending, `${mode} controller pending`)
      const approvalId = e2e.controller.view.pending_approval_id!
      if (mode === 'close') await e2e.service.close()
      else {
        e2e.provider.endNonrecoverably()
        await waitUntil(() => e2e.service.stopped, 'provider failure stops service')
      }
      assert.equal(await within(e2e.factory.owner!.approvalDecision, `${mode} wire decline`), 'decline')
      assert.equal((await within(e2e.running, `${mode} terminal completion`)).classification, 'completed')
      assert.equal(e2e.service.codexApprovalDecision(approvalId, true), false)
    })
  }
})

test('turn interruption and process exit clear pending authority before any late acceptance', async t => {
  const interrupted = await startApprovalE2e(t, 'file-approval-turn-interrupted')
  assert.equal(
    await within(interrupted.factory.owner!.approvalDecision, 'interrupted wire decision'),
    'decline',
  )
  const interruptedResult = await within(interrupted.running, 'interrupted turn result')
  assert.notEqual(interruptedResult.classification, 'completed')
  assert.equal(interrupted.controller.pending, false)
  assert.equal(interrupted.service.codexApprovalDecision(
    'public-file-approval-turn-interrupted', true,
  ), false)

  const exited = await startApprovalE2e(t, 'file-approval-process-exit')
  await waitUntil(() => exited.controller.pending, 'process exit controller pending')
  const exitedApprovalId = exited.controller.view.pending_approval_id!
  exited.factory.owner!.release('approval_process_exit')
  const exitedResult = await within(exited.running, 'process exit result')
  assert.equal(exitedResult.code, 'transport_lost')
  assert.equal(exited.controller.pending, false)
  assert.equal(exited.service.codexApprovalDecision(exitedApprovalId, true), false)
})

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + TEST_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (predicate()) return
    await yieldImmediate()
  }
  assert.fail(`${label} did not settle`)
}

function within<T>(promise: Promise<T>, label: string, timeoutMs = TEST_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`${label} did not settle`)) }, timeoutMs)
    void promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(`${label} rejected`))
      },
    )
  })
}

function connectDesktop(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`)
  return within(new Promise<WebSocket>((resolve, reject) => {
    socket.once('open', () => { resolve(socket) })
    socket.once('error', reject)
  }), 'desktop connect').catch(error => {
    socket.terminate()
    throw error
  })
}

function closeDesktop(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  const closed = new Promise<void>(resolve => { socket.once('close', () => { resolve() }) })
  socket.close()
  return within(closed, 'desktop close').catch(() => { socket.terminate() })
}

function sendSocket(socket: WebSocket, raw: string): Promise<void> {
  return within(new Promise<void>((resolve, reject) => {
    socket.send(raw, error => { if (error == null) resolve(); else reject(error) })
  }), 'desktop send')
}

function nextTextFrame(
  socket: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData, binary: boolean): void => {
      if (binary) return
      try {
        const parsed = JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as unknown
        if (
          typeof parsed === 'object'
          && parsed !== null
          && !Array.isArray(parsed)
          && predicate(parsed as Record<string, unknown>)
        ) {
          cleanup()
          resolve(parsed as Record<string, unknown>)
        }
      } catch (error) {
        cleanup()
        reject(error instanceof Error ? error : new Error('desktop frame parsing failed'))
      }
    }
    const onClose = (): void => { cleanup(); reject(new Error('desktop closed before frame')) }
    const cleanup = (): void => {
      socket.off('message', onMessage)
      socket.off('close', onClose)
    }
    socket.on('message', onMessage)
    socket.once('close', onClose)
  })
}
