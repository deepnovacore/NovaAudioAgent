import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {createServer, type Server, type Socket} from 'node:net'
import {test} from 'node:test'
import {WebSocket, type RawData} from 'ws'
import {buildAssembly} from '../src/assembly.js'
import {VirtualClock} from '../src/clock.js'
import {settingsSchema} from '../src/config.js'
import {announceReadiness, type DesktopReadiness} from '../src/desktop.js'
import type {
  CameraCaptureTransport,
  CapturedCameraFrame,
} from '../src/desktop.js'
import {
  buildDesktopRealtimeComposition,
  installDesktopStopSources,
  isDesktopShutdownMessage,
  RealtimeDesktopService,
  runDesktopEntry,
  runDesktopEntryWithStopSources,
  type DesktopRealtimeOwner,
  type DesktopRealtimeTransportOwner,
  type DesktopOutputCallbacks,
} from '../src/desktop-service.js'
import {decodeAudioFrame} from '../src/desktop-wire.js'
import type {EventRecord} from '../src/events.js'
import type {
  CompleteRequest,
  GatewayCompletion,
  GatewayDelta,
  ModelGateway,
  StreamRequest,
} from '../src/model-gateway.js'
import {buildRealtimeAssembly} from '../src/realtime-assembly.js'
import type {PlaybackCompletion} from '../src/playback.js'
import type {
  HostContextItem,
  HostResponseIntent,
  RealtimeProvider,
} from '../src/realtime/protocol.js'
import {memoryBoardMessage} from '../src/realtime/memory-board.js'

const TOKEN = '0123456789abcdef0123456789abcdef'
const SETTLE_MS = 1_500

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined
  let reject: ((error: unknown) => void) | undefined
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return {promise, resolve: resolve!, reject: reject!}
}

async function settleNamed<T>(label: string, work: Promise<T>, timeoutMs = SETTLE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle in time`)), timeoutMs)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function readiness(): DesktopReadiness {
  return {token: TOKEN, host: '127.0.0.1', port: 43123}
}

class ControlledRealtime implements DesktopRealtimeOwner {
  readonly trace: string[]
  readonly stopped = deferred<void>()
  readonly startCalled = deferred<void>()
  starts = 0
  stops = 0
  waitCalls = 0
  startFailure: Error | undefined
  stopFailure: Error | undefined
  waitFailure: Error | undefined
  startWork: Promise<void> | undefined
  stopWork: Promise<void> | undefined
  readonly service = {waitStopped: (): Promise<void> => {
    this.waitCalls += 1
    return this.waitFailure === undefined
      ? this.stopped.promise
      : Promise.reject(this.waitFailure)
  }}

  constructor(trace: string[]) { this.trace = trace }

  async start(): Promise<void> {
    this.starts += 1
    this.trace.push('realtime:start')
    this.startCalled.resolve()
    if (this.startWork !== undefined) await this.startWork
    if (this.startFailure !== undefined) throw this.startFailure
  }

  async stop(): Promise<void> {
    this.stops += 1
    this.trace.push('realtime:stop')
    if (this.stopWork !== undefined) await this.stopWork
    if (this.stopFailure !== undefined) throw this.stopFailure
  }
}

class ControlledDesktop implements DesktopRealtimeTransportOwner {
  readonly trace: string[]
  readonly startCalled = deferred<void>()
  starts = 0
  closes = 0
  startFailure: Error | undefined
  closeFailure: Error | undefined
  startWork: Promise<void> | undefined
  closeWork: Promise<void> | undefined
  readonly server = {
    start: async (): Promise<DesktopReadiness> => {
      this.starts += 1
      this.trace.push('server:start')
      this.startCalled.resolve()
      if (this.startWork !== undefined) await this.startWork
      if (this.startFailure !== undefined) throw this.startFailure
      return readiness()
    },
    close: async (): Promise<void> => {
      this.closes += 1
      this.trace.push('server:close')
      if (this.closeWork !== undefined) await this.closeWork
      if (this.closeFailure !== undefined) throw this.closeFailure
    },
  }

  constructor(trace: string[]) { this.trace = trace }
}

function controlledOwner(options: {
  readonly trace?: string[]
  readonly stop?: AbortController
  readonly cleanupGraceMs?: number
  readonly closeAuxiliary?: () => void | Promise<void>
  readonly onDiagnostic?: (line: string) => void
  readonly readyEndpoint?: string
  readonly announce?: (
    signal: AbortSignal,
    endpoint: string,
    readiness: DesktopReadiness,
  ) => void | Promise<void>
} = {}): {
  readonly owner: RealtimeDesktopService
  readonly realtime: ControlledRealtime
  readonly desktop: ControlledDesktop
  readonly stop: AbortController
  readonly trace: string[]
  readonly announced: Promise<void>
} {
  const trace = options.trace ?? []
  const stop = options.stop ?? new AbortController()
  const realtime = new ControlledRealtime(trace)
  const desktop = new ControlledDesktop(trace)
  const announced = deferred<void>()
  const owner = new RealtimeDesktopService({
    realtime,
    desktop,
    readyEndpoint: options.readyEndpoint ?? '127.0.0.1:51515',
    stop,
    announce: async (_endpoint, _readiness, signal?: AbortSignal) => {
      trace.push('ready')
      announced.resolve()
      await options.announce?.(signal!, _endpoint, _readiness)
    },
    ...(options.closeAuxiliary === undefined ? {} : {closeAuxiliary: options.closeAuxiliary}),
    ...(options.cleanupGraceMs === undefined ? {} : {cleanupGraceMs: options.cleanupGraceMs}),
    ...(options.onDiagnostic === undefined ? {} : {onDiagnostic: options.onDiagnostic}),
  })
  return {owner, realtime, desktop, stop, trace, announced: announced.promise}
}

test('realtime starts before listener/readiness and service self-stop owns one shutdown', async () => {
  const harness = controlledOwner()
  const running = harness.owner.run()
  assert.equal(harness.owner.run(), running, 'concurrent run shares one start operation')
  await settleNamed('desktop readiness order', harness.announced)
  assert.deepEqual(harness.trace, ['realtime:start', 'server:start', 'ready'])

  harness.realtime.stopped.resolve()
  await settleNamed('service self-stop shutdown', running)
  assert.equal(harness.stop.signal.aborted, true)
  assert.deepEqual(harness.trace, [
    'realtime:start', 'server:start', 'ready', 'server:close', 'realtime:stop',
  ])
  assert.equal(harness.realtime.stops, 1)
  assert.equal(harness.desktop.closes, 1)
  await settleNamed('repeated desktop owner stop', harness.owner.stop())
  assert.equal(harness.realtime.stops, 1)
  assert.equal(harness.desktop.closes, 1)
})

test('an already-stopped service never opens the listener or announces readiness', async () => {
  const harness = controlledOwner()
  harness.realtime.stopped.resolve()

  await settleNamed('pre-resolved service shutdown', harness.owner.run())

  assert.equal(harness.realtime.waitCalls, 1)
  assert.equal(harness.desktop.starts, 0)
  assert.deepEqual(harness.trace, ['realtime:start', 'server:close', 'realtime:stop'])
})

test('a service failure is observed before listener startup and remains the primary failure', async () => {
  const failure = new Error('service stopped unexpectedly')
  const harness = controlledOwner()
  harness.realtime.waitFailure = failure

  await assert.rejects(harness.owner.run(), error => error === failure)

  assert.equal(harness.realtime.waitCalls, 1)
  assert.equal(harness.desktop.starts, 0)
  assert.deepEqual(harness.trace, ['realtime:start', 'server:close', 'realtime:stop'])
})

test('service stop while listener startup is held cancels startup and cleans up without resurrection', async () => {
  const listenerGate = deferred<void>()
  const harness = controlledOwner({cleanupGraceMs: 15})
  harness.desktop.startWork = listenerGate.promise
  const running = harness.owner.run()
  await settleNamed('held listener entered', harness.desktop.startCalled.promise)
  harness.realtime.stopped.resolve()

  try {
    await settleNamed('held listener service shutdown', running, 250)
    assert.deepEqual(harness.trace, [
      'realtime:start', 'server:start', 'server:close', 'realtime:stop',
    ])
  } finally {
    listenerGate.resolve()
    await Promise.allSettled([running, harness.owner.stop()])
  }
})

test('external stop during realtime start is bounded and cannot start the listener late', async () => {
  const startGate = deferred<void>()
  const diagnostics: string[] = []
  const harness = controlledOwner({
    cleanupGraceMs: 15,
    onDiagnostic: line => diagnostics.push(line),
  })
  harness.realtime.startWork = startGate.promise
  const running = harness.owner.run()
  await settleNamed('held realtime start entered', harness.realtime.startCalled.promise)
  const stopping = harness.owner.stop()

  try {
    await settleNamed('held realtime start shutdown', Promise.all([running, stopping]), 250)
    assert.equal(harness.desktop.starts, 0)
    assert.deepEqual(diagnostics, ['[runtime-diagnostic] desktop_realtime_start_abandoned'])
  } finally {
    startGate.resolve()
    await Promise.allSettled([running, stopping])
  }
  assert.equal(harness.desktop.starts, 0, 'late realtime start cannot resurrect the listener')
})

test('external stop during listener start is bounded and cannot announce readiness late', async () => {
  const listenerGate = deferred<void>()
  const diagnostics: string[] = []
  const harness = controlledOwner({
    cleanupGraceMs: 15,
    onDiagnostic: line => diagnostics.push(line),
  })
  harness.desktop.startWork = listenerGate.promise
  const running = harness.owner.run()
  await settleNamed('held desktop listener entered', harness.desktop.startCalled.promise)
  const stopping = harness.owner.stop()

  try {
    await settleNamed('held desktop listener shutdown', Promise.all([running, stopping]), 250)
    assert.equal(harness.trace.includes('ready'), false)
    assert.deepEqual(diagnostics, ['[runtime-diagnostic] desktop_server_start_abandoned'])
  } finally {
    listenerGate.resolve()
    await Promise.allSettled([running, stopping])
  }
  assert.equal(harness.trace.includes('ready'), false, 'late listener start cannot announce readiness')
})

test('external stop aborts a deferred readiness announcement and prevents a late ready result', async () => {
  const announceGate = deferred<void>()
  let announcedSignal: AbortSignal | undefined
  const diagnostics: string[] = []
  const harness = controlledOwner({
    cleanupGraceMs: 15,
    onDiagnostic: line => diagnostics.push(line),
    announce: signal => {
      announcedSignal = signal
      return announceGate.promise
    },
  })
  const running = harness.owner.run()
  await settleNamed('deferred readiness entered', harness.announced)
  const stopping = harness.owner.stop()

  try {
    await settleNamed('deferred readiness shutdown', Promise.all([running, stopping]), 250)
    assert.equal(announcedSignal?.aborted, true)
    assert.deepEqual(diagnostics, [
      '[runtime-diagnostic] desktop_readiness_announcement_abandoned',
    ])
  } finally {
    announceGate.resolve()
    await Promise.allSettled([running, stopping])
  }
  assert.equal(harness.trace.filter(item => item === 'ready').length, 1)
})

interface HeldReadinessParent {
  readonly listener: Server
  readonly endpoint: string
  readonly sockets: Socket[]
  readonly received: Uint8Array[]
}

async function heldReadinessParent(onData?: (text: string) => void): Promise<HeldReadinessParent> {
  const sockets: Socket[] = []
  const received: Uint8Array[] = []
  const listener = createServer(socket => {
    sockets.push(socket)
    socket.on('data', chunk => {
      received.push(new Uint8Array(chunk))
      onData?.(Buffer.concat(received.map(value => Buffer.from(value))).toString('utf8'))
    })
  })
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen({host: '127.0.0.1', port: 0}, resolve)
  })
  const address = listener.address()
  assert.ok(address !== null && typeof address === 'object')
  return {listener, endpoint: `127.0.0.1:${address.port}`, sockets, received}
}

async function closeHeldReadinessParent(parent: HeldReadinessParent): Promise<void> {
  for (const socket of parent.sockets) socket.destroy()
  await new Promise<void>((resolve, reject) => parent.listener.close(error => {
    if (error !== undefined) reject(error)
    else resolve()
  }))
}

test('pre-write terminal abort sends zero readiness bytes and remains a normal owner stop', async () => {
  const parent = await heldReadinessParent()
  const diagnostics: string[] = []
  const harness = controlledOwner({
    readyEndpoint: parent.endpoint,
    onDiagnostic: line => diagnostics.push(line),
    announce: (signal, endpoint, value) => {
      harness.stop.abort()
      return announceReadiness(endpoint, value, {timeoutMs: 250, signal})
    },
  })
  try {
    await settleNamed('pre-write readiness owner stop', harness.owner.run())
    assert.equal(Buffer.concat(parent.received.map(value => Buffer.from(value))).byteLength, 0)
    assert.deepEqual(diagnostics, [])
    assert.deepEqual(harness.trace, [
      'realtime:start', 'server:start', 'ready', 'server:close', 'realtime:stop',
    ])
  } finally {
    await Promise.allSettled([harness.owner.stop()])
    await closeHeldReadinessParent(parent)
  }
})

test('post-write terminal abort commits one exact readiness line and cleans up normally', async () => {
  const holder: {harness?: ReturnType<typeof controlledOwner>} = {}
  let aborted = false
  const parent = await heldReadinessParent(textValue => {
    if (!aborted && textValue.endsWith('\n')) {
      aborted = true
      holder.harness?.stop.abort()
    }
  })
  const diagnostics: string[] = []
  let announceResult = 'pending'
  const harness = controlledOwner({
    readyEndpoint: parent.endpoint,
    onDiagnostic: line => diagnostics.push(line),
    announce: async (signal, endpoint, value) => {
      try {
        await announceReadiness(endpoint, value, {timeoutMs: 250, signal})
        announceResult = 'committed'
      } catch (error) {
        announceResult = error instanceof Error ? error.message : 'unknown failure'
        throw error
      }
    },
  })
  holder.harness = harness
  try {
    await settleNamed('post-write readiness owner stop', harness.owner.run())
    assert.equal(
      Buffer.concat(parent.received.map(value => Buffer.from(value))).toString('utf8'),
      `${JSON.stringify(readiness())}\n`,
    )
    assert.equal(announceResult, 'committed')
    assert.deepEqual(diagnostics, [])
    assert.deepEqual(harness.trace, [
      'realtime:start', 'server:start', 'ready', 'server:close', 'realtime:stop',
    ])
  } finally {
    await Promise.allSettled([harness.owner.stop()])
    await closeHeldReadinessParent(parent)
  }
})

test('startup failures rollback in listener-first shutdown order without readiness', async () => {
  const startFailure = new Error('start failed secret=/private/start')
  const start = controlledOwner()
  start.realtime.startFailure = startFailure
  await assert.rejects(start.owner.run(), error => error === startFailure)
  assert.deepEqual(start.trace, ['realtime:start', 'server:close', 'realtime:stop'])

  const serverFailure = new Error('listen failed secret=/private/listener')
  const server = controlledOwner()
  server.desktop.startFailure = serverFailure
  await assert.rejects(server.owner.run(), error => error === serverFailure)
  assert.deepEqual(server.trace, [
    'realtime:start', 'server:start', 'server:close', 'realtime:stop',
  ])

  const announceFailure = new Error('ready failed secret=/private/readiness')
  const announce = controlledOwner({announce: () => Promise.reject(announceFailure)})
  await assert.rejects(announce.owner.run(), error => error === announceFailure)
  assert.deepEqual(announce.trace, [
    'realtime:start', 'server:start', 'ready', 'server:close', 'realtime:stop',
  ])
})

test('external stop racing service stop shares cleanup and preserves the first failure', async () => {
  const auxiliaryFailure = new Error('auxiliary failed')
  const trace: string[] = []
  const harness = controlledOwner({
    trace,
    closeAuxiliary: () => { trace.push('auxiliary:close'); throw auxiliaryFailure },
  })
  const running = harness.owner.run()
  await settleNamed('racing owner startup', harness.announced)
  const stopped = harness.owner.stop()
  harness.realtime.stopped.resolve()
  await assert.rejects(running, error => error === auxiliaryFailure)
  await assert.rejects(stopped, error => error === auxiliaryFailure)
  assert.deepEqual(trace, [
    'realtime:start', 'server:start', 'ready',
    'server:close', 'realtime:stop', 'auxiliary:close',
  ])
  assert.equal(harness.realtime.stops, 1)
  assert.equal(harness.desktop.closes, 1)
})

test('cleanup attempts every owner in order and keeps the first actual failure', async () => {
  const trace: string[] = []
  const serverFailure = new Error('server close failed')
  const realtimeFailure = new Error('realtime stop failed')
  const auxiliaryFailure = new Error('auxiliary close failed')
  const harness = controlledOwner({
    trace,
    closeAuxiliary: () => { trace.push('auxiliary:close'); throw auxiliaryFailure },
  })
  harness.desktop.closeFailure = serverFailure
  harness.realtime.stopFailure = realtimeFailure
  const running = harness.owner.run()
  await settleNamed('cleanup ordering startup', harness.announced)
  harness.stop.abort()
  await assert.rejects(running, error => error === serverFailure)
  assert.deepEqual(trace.slice(-3), ['server:close', 'realtime:stop', 'auxiliary:close'])
})

test('stalled cleanup is bounded and diagnostics contain only fixed labels', async () => {
  const never = new Promise<void>(() => undefined)
  const diagnostics: string[] = []
  const trace: string[] = []
  const harness = controlledOwner({
    trace,
    cleanupGraceMs: 15,
    onDiagnostic: line => diagnostics.push(line),
    closeAuxiliary: () => { trace.push('auxiliary:close'); return never },
  })
  harness.desktop.closeWork = never
  const running = harness.owner.run()
  await settleNamed('bounded cleanup startup', harness.announced)
  harness.stop.abort()
  await settleNamed('bounded desktop cleanup', running, 250)
  assert.deepEqual(trace.slice(-3), ['server:close', 'realtime:stop', 'auxiliary:close'])
  assert.deepEqual(diagnostics, [
    '[runtime-diagnostic] desktop_server_close_abandoned',
    '[runtime-diagnostic] desktop_auxiliary_close_abandoned',
  ])
  assert.equal(diagnostics.join('\n').includes('/private'), false)
})

test('entry maps invalid construction to one fixed diagnostic and no readiness', async () => {
  const diagnostics: string[] = []
  let announced = false
  const exitCode = await runDesktopEntry({
    token: TOKEN,
    readyEndpoint: '127.0.0.1:51515',
    stop: new AbortController(),
    construct: () => { throw new Error('DASHSCOPE_API_KEY=secret /private/workspace') },
    announce: () => { announced = true; return Promise.resolve() },
    onDiagnostic: line => diagnostics.push(line),
  })
  assert.equal(exitCode, 2)
  assert.equal(announced, false)
  assert.deepEqual(diagnostics, ['[runtime-diagnostic] assembly_failed'])
})

test('utility shutdown messages and parent EOF converge on the shared abort owner', () => {
  assert.equal(isDesktopShutdownMessage({type: 'nova.shutdown'}), true)
  assert.equal(isDesktopShutdownMessage({data: {type: 'nova.shutdown'}}), true)
  assert.equal(isDesktopShutdownMessage({type: 'other'}), false)
  const stop = new AbortController()
  const shutdown = (): void => stop.abort()
  if (isDesktopShutdownMessage({data: {type: 'nova.shutdown'}})) shutdown()
  shutdown() // the parent-EOF seam invokes the same idempotent owner
  assert.equal(stop.signal.aborted, true)
})

class FakeStdin extends EventEmitter {
  resumes = 0
  pauses = 0
  resume(): this { this.resumes += 1; return this }
  pause(): this { this.pauses += 1; return this }
}

class FakeParentPort extends EventEmitter {
  starts = 0
  start(): void { this.starts += 1 }
}

test('desktop stop sources bind and dispose SIGINT and SIGTERM callbacks exactly', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const processEvents = new EventEmitter()
    const stdin = new FakeStdin()
    const stop = new AbortController()
    const binding = installDesktopStopSources({stop, processEvents, stdin})
    assert.equal(stdin.resumes, 1)
    processEvents.emit(signal)
    assert.equal(stop.signal.aborted, true, signal)
    binding.dispose()
    binding.dispose()
    assert.equal(processEvents.listenerCount(signal), 0)
    assert.equal(stdin.listenerCount('end'), 0)
    assert.equal(stdin.pauses, 1)
  }
})

test('utility parent message and close callbacks stop once and are all unbound', () => {
  for (const source of ['direct-message', 'wrapped-message', 'close'] as const) {
    const processEvents = new EventEmitter()
    const stdin = new FakeStdin()
    const parentPort = new FakeParentPort()
    const stop = new AbortController()
    const binding = installDesktopStopSources({stop, processEvents, stdin, parentPort})
    assert.equal(parentPort.starts, 1)
    assert.equal(stdin.resumes, 0)
    parentPort.emit('message', {type: 'other'})
    assert.equal(stop.signal.aborted, false)
    if (source === 'direct-message') parentPort.emit('message', {type: 'nova.shutdown'})
    else if (source === 'wrapped-message') {
      parentPort.emit('message', {data: {type: 'nova.shutdown'}})
    } else parentPort.emit('close')
    assert.equal(stop.signal.aborted, true, source)

    binding.dispose()
    assert.equal(parentPort.listenerCount('message'), 0)
    assert.equal(parentPort.listenerCount('close'), 0)
    assert.equal(processEvents.listenerCount('SIGINT'), 0)
    assert.equal(processEvents.listenerCount('SIGTERM'), 0)
  }
})

test('plain Node disconnect and stdin EOF share one stop and dispose resumed stdin', () => {
  for (const source of ['disconnect', 'end'] as const) {
    const processEvents = new EventEmitter()
    const stdin = new FakeStdin()
    const stop = new AbortController()
    const binding = installDesktopStopSources({stop, processEvents, stdin})
    if (source === 'disconnect') processEvents.emit(source)
    else stdin.emit(source)
    assert.equal(stop.signal.aborted, true, source)
    binding.dispose()
    assert.equal(processEvents.listenerCount('disconnect'), 0)
    assert.equal(stdin.listenerCount('end'), 0)
    assert.equal(stdin.pauses, 1)
  }
})

test('entry wrapper always disposes stop sources after construction failure and service self-stop', async () => {
  const failedProcess = new EventEmitter()
  const failedStdin = new FakeStdin()
  const failedStop = new AbortController()
  const failed = await runDesktopEntryWithStopSources({
    token: TOKEN,
    readyEndpoint: '127.0.0.1:51515',
    stop: failedStop,
    construct: () => { throw new Error('configuration failed') },
    announce: () => Promise.resolve(),
    onDiagnostic: () => undefined,
  }, {processEvents: failedProcess, stdin: failedStdin})
  assert.equal(failed, 2)
  assert.equal(failedProcess.listenerCount('SIGINT'), 0)
  assert.equal(failedProcess.listenerCount('disconnect'), 0)
  assert.equal(failedStdin.listenerCount('end'), 0)
  assert.equal(failedStdin.pauses, 1)

  const stoppedProcess = new EventEmitter()
  const stoppedStdin = new FakeStdin()
  const harness = controlledOwner()
  harness.realtime.stopped.resolve()
  const stopped = await runDesktopEntryWithStopSources({
    token: TOKEN,
    readyEndpoint: '127.0.0.1:51515',
    stop: harness.stop,
    construct: () => ({realtime: harness.realtime, desktop: harness.desktop}),
    announce: () => Promise.resolve(),
    onDiagnostic: () => undefined,
  }, {processEvents: stoppedProcess, stdin: stoppedStdin})
  assert.equal(stopped, 0)
  assert.equal(stoppedProcess.listenerCount('SIGTERM'), 0)
  assert.equal(stoppedProcess.listenerCount('disconnect'), 0)
  assert.equal(stoppedStdin.listenerCount('end'), 0)
  assert.equal(stoppedStdin.pauses, 1)
})

class NeverGateway implements ModelGateway {
  async *stream(request: StreamRequest): AsyncIterable<GatewayDelta> {
    void request
    await Promise.resolve()
    throw new Error('model gateway was not expected')
  }

  complete(request: CompleteRequest): Promise<GatewayCompletion> {
    void request
    return Promise.reject(new Error('model gateway was not expected'))
  }
}

class ScriptedProvider implements RealtimeProvider {
  readonly trace: string[]
  readonly audio: Uint8Array[] = []
  readonly audioSent = deferred<void>()
  connectCalls = 0
  closeCalls = 0
  #closed = false
  #events: unknown[] = []
  #eventReady: ((event: unknown) => void) | undefined

  constructor(trace: string[]) { this.trace = trace }

  connect(): Promise<unknown> {
    this.connectCalls += 1
    this.trace.push('provider:connect')
    return Promise.resolve({epoch: 1, provider_session_id: 'provider-1'})
  }

  sendAudio(pcm: Uint8Array): Promise<void> {
    this.audio.push(pcm.slice())
    this.audioSent.resolve()
    return Promise.resolve()
  }

  injectHostItem(item: HostContextItem): Promise<unknown> {
    return Promise.resolve({
      session_epoch: 1,
      host_item_id: item.host_item_id,
      provider_item_id: `provider-${item.host_item_id}`,
    })
  }

  createResponse(intent: HostResponseIntent): Promise<void> {
    void intent
    return Promise.resolve()
  }
  cancelResponse(): Promise<void> { return Promise.resolve() }

  emit(event: unknown): void {
    if (this.#eventReady !== undefined) {
      const ready = this.#eventReady
      this.#eventReady = undefined
      ready(event)
    } else this.#events.push(event)
  }

  async *events(signal: AbortSignal): AsyncIterable<unknown> {
    while (!this.#closed && !signal.aborted) {
      const queued = this.#events.shift()
      const event = queued ?? await new Promise<unknown>(resolve => {
        const onAbort = (): void => { this.#eventReady = undefined; resolve(null) }
        signal.addEventListener('abort', onAbort, {once: true})
        this.#eventReady = value => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        }
      })
      if (event === null) return
      yield event
    }
  }

  close(): Promise<void> {
    this.closeCalls += 1
    this.#closed = true
    this.#eventReady?.(null)
    this.#eventReady = undefined
    return Promise.resolve()
  }
}

interface ReceivedFrame {readonly binary: boolean; readonly bytes: Uint8Array}

function connectDesktop(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`)
  return settleNamed('production desktop connect', new Promise<WebSocket>((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })).catch(error => { socket.terminate(); throw error })
}

function sendDesktop(socket: WebSocket, raw: string | Uint8Array, label: string): Promise<void> {
  return settleNamed(label, new Promise<void>((resolve, reject) => {
    socket.send(raw, error => error == null ? resolve() : reject(error))
  }))
}

function receiveFrames(socket: WebSocket, count: number, label: string): Promise<ReceivedFrame[]> {
  return settleNamed(label, new Promise((resolve, reject) => {
    const frames: ReceivedFrame[] = []
    const cleanup = (): void => { socket.off('message', onMessage); socket.off('close', onClose) }
    const onClose = (): void => { cleanup(); reject(new Error(`${label} socket closed`)) }
    const onMessage = (data: RawData, binary: boolean): void => {
      const bytes = Buffer.isBuffer(data)
        ? new Uint8Array(data)
        : new Uint8Array(Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]))
      frames.push({binary, bytes})
      if (frames.length === count) { cleanup(); resolve(frames) }
    }
    socket.on('message', onMessage)
    socket.once('close', onClose)
  }))
}

function closeDesktop(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
  socket.close()
  return settleNamed('production desktop close', closed)
    .catch(error => { socket.terminate(); throw error })
}

function text(frame: ReceivedFrame): string {
  assert.equal(frame.binary, false)
  return Buffer.from(frame.bytes).toString('utf8')
}

test('authenticated fake-provider loopback uses one service for duplex audio and reconnect', async t => {
  const trace: string[] = []
  const provider = new ScriptedProvider(trace)
  const core = buildAssembly({
    settings: settingsSchema.parse({
      executors: ['fast_sim'], model_api_key: 'model-key', tavily_api_key: 'search-key',
    }),
    gateway: new NeverGateway(),
    searchTransport: {search: () => Promise.reject(new Error('search was not expected'))},
    realtimeFrontbrain: true,
  })
  let serveCalls = 0
  const originalServe = core.runtime.serve.bind(core.runtime)
  Object.defineProperty(core.runtime, 'serve', {
    configurable: true,
    value: (signal: AbortSignal): Promise<void> => {
      serveCalls += 1
      return originalServe(signal)
    },
  })
  const stop = new AbortController()
  const composition = buildDesktopRealtimeComposition({
    token: TOKEN,
    stop,
    buildRealtime: callbacks => buildRealtimeAssembly({
      core,
      provider,
      ...callbacks,
      onDiagnostic: () => undefined,
    }),
  })
  const onset = deferred<void>()
  const playback = deferred<void>()
  const originalOnset = composition.realtime.session.localSpeechOnset
    .bind(composition.realtime.session)
  const originalPlayback = composition.realtime.service.playbackStarted
    .bind(composition.realtime.service)
  Object.defineProperty(composition.realtime.session, 'localSpeechOnset', {
    configurable: true,
    value: async (speechId: string): Promise<void> => {
      assert.equal(speechId, 'speech-1')
      onset.resolve()
      await originalOnset(speechId)
    },
  })
  Object.defineProperty(composition.realtime.service, 'playbackStarted', {
    configurable: true,
    value: (utteranceId: string, epoch: number): boolean => {
      const result = originalPlayback(utteranceId, epoch)
      playback.resolve()
      return result
    },
  })
  const announcedReady = deferred<DesktopReadiness>()
  const owner = new RealtimeDesktopService({
    realtime: composition.realtime,
    desktop: composition.desktop,
    readyEndpoint: '127.0.0.1:51515',
    stop,
    announce: (_endpoint, value) => {
      trace.push('ready')
      announcedReady.resolve(value)
      return Promise.resolve()
    },
  })
  const running = owner.run()
  const opened = new Set<WebSocket>()
  t.after(async () => {
    await Promise.allSettled([...opened]
      .filter(socket => socket.readyState !== WebSocket.CLOSED)
      .map(socket => closeDesktop(socket)))
    await settleNamed('loopback failure cleanup', Promise.allSettled([owner.stop(), running]))
  })
  const announced = await settleNamed('production desktop readiness', announcedReady.promise)
  assert.deepEqual(trace.slice(0, 2), ['provider:connect', 'ready'])

  const first = await connectDesktop(announced.port)
  opened.add(first)
  try {
    const initial = receiveFrames(first, 2, 'desktop ready and current state')
    await sendDesktop(first, JSON.stringify({type: 'hello', token: TOKEN}), 'desktop hello')
    assert.deepEqual((await initial).map(frame => text(frame)), [
      '{"type":"desktop.ready"}',
      '{"type":"codex.state","state":"idle"}',
    ])

    const board = receiveFrames(first, 1, 'exact runtime memory board')
    await sendDesktop(first, JSON.stringify({
      type: 'memory.board.request', request_id: 'board-1',
    }), 'desktop memory board request')
    assert.equal(text((await board)[0]!), memoryBoardMessage('board-1', core.runtime.memory))

    await sendDesktop(first, new Uint8Array([1, 2, 3, 4]), 'desktop PCM')
    await sendDesktop(first, JSON.stringify({
      type: 'speech.onset', speech_id: 'speech-1',
    }), 'desktop onset')
    await settleNamed('provider audio received', provider.audioSent.promise)
    await settleNamed('service onset received', onset.promise)
    assert.deepEqual(provider.audio, [new Uint8Array([1, 2, 3, 4])])

    const downlink = receiveFrames(first, 3, 'provider audio caption and terminal')
    provider.emit({kind: 'response_started', session_epoch: 1, response_id: 'response-1'})
    provider.emit({
      kind: 'response_audio_delta', session_epoch: 1, response_id: 'response-1',
      pcm: new Uint8Array([5, 6]),
    })
    provider.emit({
      kind: 'response_transcript_final', session_epoch: 1, response_id: 'response-1', text: '你好',
    })
    provider.emit({
      kind: 'response_terminal', session_epoch: 1, response_id: 'response-1',
      status: 'completed', reason: 'done',
    })
    const frames = await downlink
    assert.equal(frames[0]?.binary, true)
    const audio = decodeAudioFrame(frames[0].bytes)
    assert.deepEqual(audio.pcm, new Uint8Array([5, 6]))
    assert.match(text(frames[1]!), /"type":"caption".*"text":"你好"/u)
    assert.match(text(frames[2]!), /"type":"playback\.terminal"/u)
    await sendDesktop(first, JSON.stringify({
      type: 'playback.started',
      utterance_id: audio.utterance_id,
      generation_epoch: audio.generation_epoch,
    }), 'desktop playback acknowledgement')
    await settleNamed('same service playback acknowledgement', playback.promise)
  } finally {
    await closeDesktop(first)
  }
  assert.equal(stop.signal.aborted, false, 'renderer disconnect does not stop the app')

  const second = await connectDesktop(announced.port)
  opened.add(second)
  try {
    const current = receiveFrames(second, 2, 'reconnected desktop current state')
    await sendDesktop(second, JSON.stringify({type: 'hello', token: TOKEN}), 'reconnect hello')
    assert.deepEqual((await current).map(frame => text(frame)), [
      '{"type":"desktop.ready"}',
      '{"type":"codex.state","state":"idle"}',
    ])
    assert.equal(provider.connectCalls, 1)
  } finally {
    await closeDesktop(second)
    await settleNamed('loopback owner stop', owner.stop())
    await settleNamed('loopback owner run', running)
  }
  assert.equal(provider.closeCalls, 1)
  assert.equal(serveCalls, 1)
})

test('composition posts only audible delivery events into the exact runtime and memory board', () => {
  const clock = new VirtualClock(12.5)
  const core = buildAssembly({
    settings: settingsSchema.parse({
      executors: ['fast_sim'], model_api_key: 'model-key', tavily_api_key: 'search-key',
    }),
    clock,
    gateway: new NeverGateway(),
    searchTransport: {search: () => Promise.reject(new Error('search was not expected'))},
    realtimeFrontbrain: true,
  })
  type DeliveryCallbacks = DesktopOutputCallbacks & {
    readonly onDelivery?: (completion: PlaybackCompletion) => void
  }
  let captured: DeliveryCallbacks | undefined
  const composition = buildDesktopRealtimeComposition({
    token: TOKEN,
    stop: new AbortController(),
    buildRealtime: callbacks => {
      captured = callbacks
      return buildRealtimeAssembly({
        core,
        provider: new ScriptedProvider([]),
        ...callbacks,
        onDiagnostic: () => undefined,
      })
    },
  })
  const onDelivery = captured?.onDelivery
  assert.notEqual(onDelivery, undefined, 'production composition must capture delivery reports')
  const completion = (
    textValue: string,
    disposition: PlaybackCompletion['disposition'],
    playedMs: number | null,
    utteranceId: string,
  ): PlaybackCompletion => ({
    session_epoch: 1,
    response_id: `response-${utteranceId}`,
    utterance_id: utteranceId,
    generation_epoch: 1,
    text: textValue,
    disposition,
    started: disposition !== 'suppressed',
    played_ms: playedMs,
  })

  onDelivery!(completion('已播放', 'spoken', 520, 'utterance-spoken'))
  onDelivery!(completion('被打断', 'interrupted', 140, 'utterance-interrupted'))
  onDelivery!(completion('没有播放', 'suppressed', 0, 'utterance-suppressed'))
  onDelivery!(completion('', 'spoken', 10, 'utterance-empty'))

  const applied: EventRecord[] = []
  for (;;) {
    const event = core.runtime.core.queue.popReady(clock.now())
    if (event === undefined) break
    applied.push(event)
    core.runtime.core.apply(event)
  }
  assert.deepEqual(applied.map(event => event.kind), ['assistant_spoken', 'assistant_spoken'])
  assert.deepEqual(
    core.runtime.memory.channels.get('conversation')?.items.map(item => item.content),
    [{
      text: '已播放', utterance_id: 'utterance-spoken', delivery: 'spoken', played_ms: 520,
    }, {
      text: '被打断', utterance_id: 'utterance-interrupted', delivery: 'interrupted', played_ms: 140,
    }],
  )
  const board = memoryBoardMessage('delivery-board', composition.realtime.runtime.memory)
  assert.match(board, /已播放/u)
  assert.match(board, /被打断/u)
  assert.doesNotMatch(board, /没有播放/u)
})

test('captured composition callbacks preserve clear alert Codex project clock and telemetry routing', async () => {
  const clock = new VirtualClock(30)
  const telemetryRecords: {readonly kind: string; readonly payload: unknown}[] = []
  const telemetry = {
    record: (kind: string, payload: unknown): void => { telemetryRecords.push({kind, payload}) },
    close: (): void => undefined,
  }
  const core = buildAssembly({
    settings: settingsSchema.parse({
      executors: ['fast_sim'], model_api_key: 'model-key', tavily_api_key: 'search-key',
    }),
    clock,
    gateway: new NeverGateway(),
    searchTransport: {search: () => Promise.reject(new Error('search was not expected'))},
    realtimeFrontbrain: true,
  })
  let callbacks: DesktopOutputCallbacks | undefined
  const composition = buildDesktopRealtimeComposition({
    token: TOKEN,
    stop: new AbortController(),
    telemetry,
    buildRealtime: output => {
      callbacks = output
      return buildRealtimeAssembly({
        core,
        provider: new ScriptedProvider([]),
        telemetry,
        ...output,
        onDiagnostic: () => undefined,
      })
    },
  })
  assert.equal(composition.realtime.runtime.clock, clock)
  assert.equal(composition.desktop.bridge.claim(), true)
  composition.desktop.bridge.markAuthenticated()
  assert.equal(composition.desktop.bridge.takeNextDelivery()?.frame, '{"type":"codex.state","state":"idle"}')

  callbacks!.onAudioClear('utterance-clear', 2)
  callbacks!.onAudioAlert('utterance-alert', 3)
  callbacks!.onCodexState('running')
  callbacks!.onProjectView({
    workspace_display_name: '项目甲', session_title: '会话乙', pending_confirmation: true,
  })
  assert.deepEqual(composition.desktop.bridge.sendClockPings(1), ['ping-0'])
  clock.advanceTo(30.25)
  await composition.desktop.bridge.receiveControl({
    type: 'clock.pong', ping_id: 'ping-0', t_render_ms: 200,
  })

  const frames: (string | Uint8Array)[] = []
  for (;;) {
    const delivery = composition.desktop.bridge.takeNextDelivery()
    if (delivery === null) break
    frames.push(delivery.frame)
  }
  assert.deepEqual(frames, [
    '{"type":"playback.clear","utterance_id":"utterance-clear","generation_epoch":2}',
    '{"type":"playback.alert","utterance_id":"utterance-alert","generation_epoch":3}',
    '{"type":"clock.ping","ping_id":"ping-0"}',
    '{"type":"codex.state","state":"running"}',
    '{"type":"codex.project","workspace_display_name":"项目甲","session_title":"会话乙","pending_confirmation":true}',
  ])
  assert.deepEqual(telemetryRecords.map(record => record.kind), [
    'playback.clear_sent',
    'renderer.alert_tone_sent',
    'renderer.ack',
    'renderer.clock_sync',
  ])
})

test('composition rejects output callbacks fired before the desktop bridge exists', () => {
  const core = buildAssembly({
    settings: settingsSchema.parse({
      executors: ['fast_sim'], model_api_key: 'model-key', tavily_api_key: 'search-key',
    }),
    gateway: new NeverGateway(),
    searchTransport: {search: () => Promise.reject(new Error('search was not expected'))},
    realtimeFrontbrain: true,
  })
  assert.throws(() => buildDesktopRealtimeComposition({
    token: TOKEN,
    stop: new AbortController(),
    buildRealtime: callbacks => {
      callbacks.onCaption({role: 'assistant', text: 'too early', final: true})
      throw new Error(`unreachable ${core.runtime.clock.now()}`)
    },
  }), /desktop realtime bridge is unavailable during construction/u)
})

test('composition rejects synchronous delivery before the realtime holder exists without a TDZ leak', () => {
  const completion: PlaybackCompletion = {
    session_epoch: 1,
    response_id: 'response-early',
    utterance_id: 'utterance-early',
    generation_epoch: 1,
    text: 'too early',
    disposition: 'spoken',
    started: true,
    played_ms: 10,
  }
  assert.throws(() => buildDesktopRealtimeComposition({
    token: TOKEN,
    stop: new AbortController(),
    buildRealtime: callbacks => {
      callbacks.onDelivery(completion)
      throw new Error('unreachable after synchronous delivery')
    },
  }), error => error instanceof Error
    && !(error instanceof ReferenceError)
    && error.message === 'desktop realtime runtime is unavailable during construction')
})

test('composition camera transport rejects construction-time use with a fixed non-TDZ error', async () => {
  const core = buildAssembly({
    settings: settingsSchema.parse({
      executors: ['fast_sim'], model_api_key: 'model-key', tavily_api_key: 'search-key',
    }),
    gateway: new NeverGateway(),
    searchTransport: {search: () => Promise.reject(new Error('search was not expected'))},
    realtimeFrontbrain: true,
  })
  let earlyCapture: Promise<CapturedCameraFrame> | undefined
  buildDesktopRealtimeComposition({
    token: TOKEN,
    stop: new AbortController(),
    buildRealtime: (callbacks, cameraTransport) => {
      earlyCapture = cameraTransport.captureCamera({source: 'local'})
      void earlyCapture.catch(() => undefined)
      return buildRealtimeAssembly({
        core,
        provider: new ScriptedProvider([]),
        ...callbacks,
        onDiagnostic: () => undefined,
      })
    },
  })
  assert.ok(earlyCapture !== undefined)
  await assert.rejects(
    earlyCapture,
    error => error instanceof Error
      && !(error instanceof ReferenceError)
      && error.message === 'desktop realtime bridge is unavailable during construction',
  )
})

test('composition camera transport is one stable proxy to the final desktop server owner', async () => {
  const core = buildAssembly({
    settings: settingsSchema.parse({
      executors: ['fast_sim'], model_api_key: 'model-key', tavily_api_key: 'search-key',
    }),
    gateway: new NeverGateway(),
    searchTransport: {search: () => Promise.reject(new Error('search was not expected'))},
    realtimeFrontbrain: true,
  })
  const requests: unknown[] = []
  let capturedTransport: CameraCaptureTransport | undefined
  const fakeServer = {
    sendText: () => Promise.resolve(),
    sendBinary: () => Promise.resolve(),
    disconnectClient: () => Promise.resolve(),
    start: () => Promise.resolve(readiness()),
    close: () => Promise.resolve(),
    captureCamera: (request: unknown): Promise<CapturedCameraFrame> => {
      requests.push(request)
      return Promise.resolve({
        payload: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        media_type: 'image/jpeg',
        width: 1280,
        height: 720,
      })
    },
  }
  const composition = buildDesktopRealtimeComposition({
    token: TOKEN,
    stop: new AbortController(),
    createServer: () => fakeServer,
    buildRealtime: (callbacks, cameraTransport) => {
      capturedTransport = cameraTransport
      return buildRealtimeAssembly({
        core,
        provider: new ScriptedProvider([]),
        ...callbacks,
        onDiagnostic: () => undefined,
      })
    },
  })
  assert.notEqual(capturedTransport, undefined)
  assert.equal(composition.desktop.server, fakeServer)
  const first = await capturedTransport!.captureCamera({source: 'local'})
  const second = await capturedTransport!.captureCamera({source: 'file', positionMs: 25})
  assert.deepEqual(requests, [{source: 'local'}, {source: 'file', positionMs: 25}])
  assert.deepEqual(first.payload, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
  assert.deepEqual(second.payload, first.payload)
})
