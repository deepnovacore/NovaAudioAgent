import assert from 'node:assert/strict'
import {test} from 'node:test'
import {WebSocket, type RawData} from 'ws'
import {VirtualClock} from '../src/clock.js'
import {
  DesktopRealtime,
  type DesktopServerTransport,
} from '../src/desktop-realtime.js'
import type {BridgeService} from '../src/desktop-bridge.js'
import {decodeAudioFrame} from '../src/desktop-wire.js'
import {
  DesktopOutboundValidationError,
  type DesktopServerOptions,
} from '../src/desktop.js'
import type {JsonValue} from '../src/events.js'
import type {RealtimeTelemetry} from '../src/realtime/telemetry.js'

const TOKEN = '1'.repeat(32)
const SETTLE_MS = 1_000

interface ServiceHarness {
  readonly service: BridgeService
  readonly calls: string[]
}

interface TelemetryRecord {
  readonly kind: string
  readonly payload: Readonly<Record<string, JsonValue>>
}

class RecordingTelemetry implements RealtimeTelemetry {
  readonly records: TelemetryRecord[] = []
  record(kind: string, payload: Readonly<Record<string, JsonValue>>): void {
    this.records.push({kind, payload})
  }
  close(): void {
    // Nothing to release.
  }
}

function serviceHarness(): ServiceHarness {
  const calls: string[] = []
  return {
    calls,
    service: {
      codexState: 'running',
      sendAudio: pcm => { calls.push(`audio:${[...pcm].join(',')}`); return Promise.resolve() },
      localSpeechOnset: speechId => { calls.push(`onset:${speechId}`); return Promise.resolve() },
      playbackStarted: (utteranceId, epoch) => { calls.push(`started:${utteranceId}:${epoch}`); return true },
      playbackStopped: (utteranceId, epoch, playedMs) => {
        calls.push(`stopped:${utteranceId}:${epoch}:${playedMs ?? 'null'}`)
        return Promise.resolve(true)
      },
      playbackDisconnected: () => {
        calls.push('playback-disconnected')
        return Promise.resolve(true)
      },
      playbackDone: (utteranceId, epoch, playedMs) => {
        calls.push(`done:${utteranceId}:${epoch}:${playedMs ?? 'null'}`)
        return true
      },
      playbackCleared: (utteranceId, epoch, playedMs) => {
        calls.push(`cleared:${utteranceId}:${epoch}:${playedMs ?? 'null'}`)
        return true
      },
      projectConfirmationDecision: (proposalId, confirmed) => {
        calls.push(`project-decision:${proposalId}:${confirmed}`)
        return Promise.resolve()
      },
    },
  }
}

function settleWithin<T>(label: string, promise: Promise<T>, timeoutMs = SETTLE_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle in time`)), timeoutMs)
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
  return settleWithin('desktop realtime client connect', new Promise<WebSocket>((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })).catch(error => {
    socket.terminate()
    throw error
  })
}

function closeDesktop(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
  socket.close()
  return settleWithin('desktop realtime client close', closed).catch(error => {
    socket.terminate()
    throw error
  })
}

interface ReceivedFrame {readonly binary: boolean; readonly bytes: Uint8Array}

function nextFrames(socket: WebSocket, count: number, label: string): Promise<readonly ReceivedFrame[]> {
  const receiving = new Promise<readonly ReceivedFrame[]>((resolve, reject) => {
    const frames: ReceivedFrame[] = []
    const onMessage = (data: RawData, binary: boolean): void => {
      const bytes = Buffer.isBuffer(data)
        ? new Uint8Array(data)
        : new Uint8Array(Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]))
      frames.push({binary, bytes})
      if (frames.length === count) { cleanup(); resolve(frames) }
    }
    const onClose = (): void => { cleanup(); reject(new Error(`${label} socket closed early`)) }
    const cleanup = (): void => { socket.off('message', onMessage); socket.off('close', onClose) }
    socket.on('message', onMessage)
    socket.once('close', onClose)
  })
  return settleWithin(label, receiving)
}

function sendClient(socket: WebSocket, raw: string | Uint8Array, label: string): Promise<void> {
  return settleWithin(label, new Promise<void>((resolve, reject) => {
    socket.send(raw, error => error == null ? resolve() : reject(error))
  }))
}

function nextClose(socket: WebSocket, label: string): Promise<{readonly code: number; readonly reason: string}> {
  return settleWithin(label, new Promise(resolve => {
    socket.once('close', (code, reason) => resolve({code, reason: reason.toString('utf8')}))
  }))
}

function text(frame: ReceivedFrame): string {
  assert.equal(frame.binary, false)
  return Buffer.from(frame.bytes).toString('utf8')
}

test('real loopback drains ready, preempt, current state, project, and duplex traffic', async () => {
  const {service, calls} = serviceHarness()
  const stop = new AbortController()
  const clock = new VirtualClock()
  const telemetry = new RecordingTelemetry()
  const realtime = new DesktopRealtime({
    token: TOKEN,
    service,
    stop,
    projectView: {
      workspace_display_name: 'project-a',
      session_title: 'session-a',
      pending_confirmation: false,
      pending_confirmation_busy: false,
    },
    memoryBoard: requestId => JSON.stringify({type: 'memory.board', request_id: requestId}),
    clock,
    telemetry,
  })
  realtime.bridge.onAudioFrame({
    utterance_id: 'stale', generation_epoch: 1, sequence: 0, pcm: new Uint8Array([0, 1]),
  })
  realtime.bridge.onAudioClear('stale', 1)
  const readiness = await settleWithin('desktop realtime server start', realtime.server.start())
  const socket = await connectDesktop(readiness.port)

  try {
    const initial = nextFrames(socket, 4, 'desktop ready and current bridge state')
    await sendClient(socket, JSON.stringify({type: 'hello', token: TOKEN}), 'desktop hello send')
    assert.deepEqual((await initial).map(frame => text(frame)), [
      '{"type":"desktop.ready"}',
      '{"type":"playback.clear","utterance_id":"stale","generation_epoch":1}',
      '{"type":"codex.state","state":"running"}',
      '{"type":"codex.project","workspace_display_name":"project-a","session_title":"session-a","pending_confirmation":false,"pending_confirmation_busy":false,"pending_action":null,"pending_workspace_display_name":null,"pending_session_title":null,"pending_expires_in_seconds":null}',
    ])

    const downlink = nextFrames(socket, 6, 'desktop bridge downlink families')
    realtime.bridge.onAudioFrame({
      utterance_id: 'u-2', generation_epoch: 2, sequence: 0, pcm: new Uint8Array([2, 3]),
    })
    realtime.bridge.onAudioTerminal('u-2', 2)
    realtime.bridge.onCaption({role: 'user', text: 'caption', final: true})
    realtime.bridge.onCodexState('idle')
    realtime.bridge.onCodexProject({
      workspace_display_name: 'project-b', session_title: null, pending_confirmation: true,
      pending_confirmation_busy: false,
    })
    realtime.bridge.onAudioAlert(null, null)
    const frames = await downlink
    // The first audio write is already in flight when the later alert is enqueued. Preemption applies
    // to queued work (proved above by the pre-auth clear), never to a write the socket has accepted.
    assert.equal(frames[0]?.binary, true)
    assert.deepEqual(decodeAudioFrame(frames[0].bytes), {
      utterance_id: 'u-2', generation_epoch: 2, sequence: 0, pcm: new Uint8Array([2, 3]),
    })
    assert.equal(text(frames[1]!), '{"type":"playback.alert"}')
    assert.match(text(frames[2]!), /"type":"playback\.terminal"/u)
    assert.match(text(frames[3]!), /"type":"caption"/u)
    assert.equal(text(frames[4]!), '{"type":"codex.state","state":"idle"}')
    assert.match(text(frames[5]!), /"workspace_display_name":"project-b"/u)

    realtime.bridge.registerPing('p-1')
    clock.advanceTo(0.25)
    const board = nextFrames(socket, 1, 'desktop memory board response')
    for (const [label, value] of [
      ['desktop PCM send', new Uint8Array([4, 5, 6, 7])],
      ['desktop speech onset send', JSON.stringify({type: 'speech.onset', speech_id: 's-1'})],
      ['desktop playback started send', JSON.stringify({type: 'playback.started', utterance_id: 'u-2', generation_epoch: 2})],
      ['desktop playback stopped send', JSON.stringify({type: 'playback.stopped', utterance_id: 'u-2', generation_epoch: 2, played_ms: 12})],
      ['desktop playback done send', JSON.stringify({type: 'playback.done', utterance_id: 'u-2', generation_epoch: 2})],
      ['desktop playback cleared send', JSON.stringify({type: 'playback.cleared', utterance_id: 'u-2', generation_epoch: 2, played_ms: 0})],
      ['desktop clock pong send', JSON.stringify({type: 'clock.pong', ping_id: 'p-1', t_render_ms: 4.5})],
      ['desktop memory request send', JSON.stringify({type: 'memory.board.request', request_id: 'r-1'})],
    ] as const) await sendClient(socket, value, label)
    assert.equal(text((await board)[0]!), '{"type":"memory.board","request_id":"r-1"}')
    assert.deepEqual(calls, [
      'audio:4,5,6,7', 'onset:s-1', 'started:u-2:2', 'stopped:u-2:2:12',
      'done:u-2:2:null', 'cleared:u-2:2:0',
    ])
    assert.deepEqual(telemetry.records.filter(record => record.kind === 'renderer.clock_sync'), [{
      kind: 'renderer.clock_sync',
      payload: {ping_id: 'p-1', round_trip_ms: 250, t_render_ms: 4.5},
    }])
    assert.equal(stop.signal.aborted, false)
  } finally {
    await closeDesktop(socket)
    await settleWithin('desktop realtime server close', realtime.server.close())
  }
})

test('renderer reconnect receives current state and project without aborting the application', async () => {
  const {service, calls} = serviceHarness()
  const stop = new AbortController()
  let released: (() => void) | undefined
  const connectionReleased = new Promise<void>(resolve => { released = resolve })
  const realtime = new DesktopRealtime({
    token: TOKEN,
    service,
    stop,
    projectView: {
      workspace_display_name: 'one', session_title: null, pending_confirmation: false,
      pending_confirmation_busy: false,
    },
    onConnectionReleased: () => released?.(),
  })
  const readiness = await settleWithin('reconnect desktop server start', realtime.server.start())
  const first = await connectDesktop(readiness.port)
  try {
    const firstState = nextFrames(first, 3, 'first connection current state')
    await sendClient(first, JSON.stringify({type: 'hello', token: TOKEN}), 'first connection hello')
    await firstState
    const changedFrames = nextFrames(first, 2, 'first connection state changes')
    realtime.bridge.onCodexState('idle')
    realtime.bridge.onCodexProject({
      workspace_display_name: 'two', session_title: 'current', pending_confirmation: true,
      pending_confirmation_busy: false,
    })
    const changed = await changedFrames
    assert.equal(text(changed[0]!), '{"type":"codex.state","state":"idle"}')
    await closeDesktop(first)
    await settleWithin('bridge connection release', connectionReleased)
    assert.ok(calls.includes('playback-disconnected'))
    assert.equal(stop.signal.aborted, false)

    const second = await connectDesktop(readiness.port)
    try {
      const current = nextFrames(second, 3, 'reconnected current state')
      await sendClient(second, JSON.stringify({type: 'hello', token: TOKEN}), 'second connection hello')
      assert.deepEqual((await current).map(frame => text(frame)), [
        '{"type":"desktop.ready"}',
        '{"type":"codex.state","state":"idle"}',
        '{"type":"codex.project","workspace_display_name":"two","session_title":"current","pending_confirmation":true,"pending_confirmation_busy":false,"pending_action":null,"pending_workspace_display_name":null,"pending_session_title":null,"pending_expires_in_seconds":null}',
      ])
    } finally {
      await closeDesktop(second)
    }
  } finally {
    await settleWithin('reconnect desktop server close', realtime.server.close())
  }
})

test('debug board client transfers a large snapshot without owning the renderer connection', async () => {
  const {service} = serviceHarness()
  const stop = new AbortController()
  const realtime = new DesktopRealtime({
    token: TOKEN,
    service,
    stop,
    memoryBoard: (requestId, detail) => JSON.stringify({
      type: 'memory.board',
      request_id: requestId,
      detail,
      diagnostics: {version: 1, records: []},
      channels: [{items: [{content: 'x'.repeat(20 * 1024)}]}],
    }),
  })
  const readiness = await settleWithin('debug board server start', realtime.server.start())
  const renderer = await connectDesktop(readiness.port)
  let debug: WebSocket | undefined

  try {
    const initial = nextFrames(renderer, 2, 'debug board renderer initial state')
    await sendClient(renderer, JSON.stringify({type: 'hello', token: TOKEN}), 'renderer hello')
    await initial

    debug = await settleWithin('debug board client connect', new Promise<WebSocket>((resolve, reject) => {
      const candidate = new WebSocket(`ws://127.0.0.1:${readiness.port}/debug-board`)
      candidate.once('open', () => resolve(candidate))
      candidate.once('error', reject)
    }))
    const response = nextFrames(debug, 1, 'large debug board response')
    await sendClient(debug, JSON.stringify({type: 'hello', token: TOKEN}), 'debug hello')
    await sendClient(debug, JSON.stringify({
      type: 'debug.board.request',
      request_id: 'debug-1',
      board: 'memory',
      detail: 'compact',
    }), 'debug board request')
    const payload = text((await response)[0]!)
    assert.ok(Buffer.byteLength(payload, 'utf8') > 16 * 1024)
    assert.deepEqual(JSON.parse(payload), {
      type: 'memory.board',
      request_id: 'debug-1',
      detail: 'compact',
      diagnostics: {version: 1, records: []},
      channels: [{items: [{content: 'x'.repeat(20 * 1024)}]}],
    })

    const rendererState = nextFrames(renderer, 1, 'renderer survives debug board response')
    realtime.bridge.onCodexState('idle')
    assert.equal(text((await rendererState)[0]!), '{"type":"codex.state","state":"idle"}')
    assert.equal(stop.signal.aborted, false)
  } finally {
    if (debug) await closeDesktop(debug)
    await closeDesktop(renderer)
    await settleWithin('debug board server close', realtime.server.close())
  }
})

test('bridge uplink errors retain the server stable protocol rejection', async () => {
  const {service, calls} = serviceHarness()
  const realtime = new DesktopRealtime({token: TOKEN, service, stop: new AbortController()})
  const readiness = await settleWithin('protocol rejection server start', realtime.server.start())
  const socket = await connectDesktop(readiness.port)
  try {
    const initial = nextFrames(socket, 2, 'protocol rejection authentication state')
    await sendClient(socket, JSON.stringify({type: 'hello', token: TOKEN}), 'protocol rejection hello')
    await initial
    const closed = nextClose(socket, 'protocol rejection close')
    await sendClient(socket, new Uint8Array([1]), 'misaligned PCM send')
    assert.deepEqual(await closed, {code: 4003, reason: 'desktop protocol rejected'})
    assert.deepEqual(
      calls.filter(call => call.startsWith('audio:')),
      [],
      'invalid PCM never reaches the service',
    )
  } finally {
    await settleWithin('protocol rejection server close', realtime.server.close())
  }
})

class ControlledServer implements DesktopServerTransport {
  readonly sent: (string | Uint8Array)[] = []
  concurrent = 0
  maxConcurrent = 0
  #next: ((value: string | Uint8Array) => void) | undefined
  #fail = false
  #failValidation = false
  #hold: (() => void) | undefined
  #connected = false
  #clientGeneration = 0
  #disconnectGate: Promise<void> | undefined
  #releaseDisconnect: (() => void) | undefined
  #observeDisconnectStart: (() => void) | undefined
  #observeDisconnected: (() => void) | undefined

  constructor(readonly options: DesktopServerOptions) {}
  start(): Promise<never> { return Promise.reject(new Error('controlled server does not listen')) }
  close(): Promise<void> { return Promise.resolve() }
  nextSend(label: string): Promise<string | Uint8Array> {
    return settleWithin(label, new Promise(resolve => { this.#next = resolve }))
  }
  failNext(): void { this.#fail = true }
  failNextValidation(): void { this.#failValidation = true }
  async connectClient(): Promise<void> {
    if (this.#connected) throw new Error('controlled desktop client already connected')
    this.#connected = true
    this.#clientGeneration += 1
    try {
      await this.options.onClientAuthenticated?.()
    } catch (error) {
      this.#connected = false
      throw error
    }
  }
  holdDisconnect(): void {
    this.#disconnectGate = new Promise(resolve => { this.#releaseDisconnect = resolve })
  }
  releaseDisconnect(): void {
    this.#releaseDisconnect?.()
    this.#releaseDisconnect = undefined
  }
  nextDisconnectStart(label: string): Promise<void> {
    return settleWithin(label, new Promise(resolve => { this.#observeDisconnectStart = resolve }))
  }
  nextDisconnected(label: string): Promise<void> {
    return settleWithin(label, new Promise(resolve => { this.#observeDisconnected = resolve }))
  }
  async disconnectClient(): Promise<void> {
    if (!this.#connected) return
    const generation = this.#clientGeneration
    this.#observeDisconnectStart?.()
    this.#observeDisconnectStart = undefined
    await this.#disconnectGate
    if (!this.#connected || generation !== this.#clientGeneration) return
    this.#connected = false
    this.options.onClientDisconnect?.()
    this.#observeDisconnected?.()
    this.#observeDisconnected = undefined
  }
  holdNext(): Promise<void> { return new Promise(resolve => { this.#hold = resolve }) }
  releaseHeld(): void { this.#hold?.(); this.#hold = undefined }
  sendText(raw: string): Promise<void> { return this.#send(raw) }
  sendBinary(raw: Uint8Array): Promise<void> { return this.#send(raw) }
  async #send(raw: string | Uint8Array): Promise<void> {
    this.concurrent += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent)
    this.sent.push(raw)
    this.#next?.(raw)
    this.#next = undefined
    try {
      if (this.#failValidation) {
        this.#failValidation = false
        throw new DesktopOutboundValidationError('controlled outbound validation failure')
      }
      if (this.#fail) { this.#fail = false; throw new Error('sensitive controlled failure') }
      if (this.#hold !== undefined) await new Promise<void>(resolve => {
        const release = this.#hold
        this.#hold = () => { release?.(); resolve() }
      })
    } finally {
      this.concurrent -= 1
    }
  }
}

function controlledRealtime(stop: AbortController): {
  readonly realtime: DesktopRealtime
  readonly server: ControlledServer
} {
  const {service} = serviceHarness()
  let server: ControlledServer | undefined
  const realtime = new DesktopRealtime({
    token: TOKEN,
    service,
    stop,
    createServer: options => {
      server = new ControlledServer(options)
      return server
    },
  })
  assert.ok(server !== undefined)
  return {realtime, server}
}

test('one serialized drain retains a wake that arrives while a socket send is held', async () => {
  const stop = new AbortController()
  const {realtime, server} = controlledRealtime(stop)
  const initial = server.nextSend('controlled initial state send')
  await server.connectClient()
  assert.equal(await initial, '{"type":"codex.state","state":"running"}')

  const held = server.holdNext()
  const audioSend = server.nextSend('controlled held audio send')
  realtime.bridge.onAudioFrame({
    utterance_id: 'held', generation_epoch: 1, sequence: 0, pcm: new Uint8Array([0, 1]),
  })
  assert.ok(await audioSend instanceof Uint8Array)
  realtime.bridge.onCaption({role: 'user', text: 'wake-during-send', final: true})
  assert.equal(server.concurrent, 1)
  const captionSend = server.nextSend('controlled retained wake send')
  server.releaseHeld()
  await settleWithin('controlled held send release', held)
  assert.match(String(await captionSend), /wake-during-send/u)
  assert.equal(server.maxConcurrent, 1)
  assert.equal(stop.signal.aborted, false)
})

test('connection ownership refuses a second claim and fences an old held generation', async () => {
  const stop = new AbortController()
  const {realtime, server} = controlledRealtime(stop)
  const initial = server.nextSend('owned connection initial state')
  await server.connectClient()
  await initial
  await assert.rejects(
    server.connectClient(),
    /controlled desktop client already connected/u,
  )

  const oldHeld = server.holdNext()
  const oldSend = server.nextSend('old generation held caption')
  realtime.bridge.onCaption({role: 'user', text: 'old-generation', final: true})
  await oldSend
  await server.disconnectClient()

  const freshState = server.nextSend('fresh generation current state')
  await server.connectClient()
  server.releaseHeld()
  await settleWithin('old generation held send release', oldHeld)
  assert.equal(await freshState, '{"type":"codex.state","state":"running"}')
  assert.equal(server.maxConcurrent, 1, 'the fresh generation never shares the old writer')
  assert.equal(stop.signal.aborted, false)
})

test('required send failure and bridge overflow abort, while droppable/latest failures survive', async () => {
  const requiredStop = new AbortController()
  const required = controlledRealtime(requiredStop)
  const requiredInitial = required.server.nextSend('required failure initial state')
  await required.server.connectClient()
  await requiredInitial
  required.server.failNext()
  const requiredAttempt = required.server.nextSend('required failing send attempt')
  required.realtime.bridge.onAudioFrame({
    utterance_id: 'required', generation_epoch: 1, sequence: 0, pcm: new Uint8Array([0, 1]),
  })
  await requiredAttempt
  await settleWithin('required failure application abort', new Promise<void>(resolve => {
    if (requiredStop.signal.aborted) resolve()
    else requiredStop.signal.addEventListener('abort', () => resolve(), {once: true})
  }))

  const softStop = new AbortController()
  const soft = controlledRealtime(softStop)
  const softInitial = soft.server.nextSend('soft failure initial state')
  await soft.server.connectClient()
  await softInitial
  soft.server.holdDisconnect()
  const disconnectStarted = soft.server.nextDisconnectStart('soft failure transport disconnect start')
  soft.server.failNext()
  const captionAttempt = soft.server.nextSend('droppable failing send attempt')
  soft.realtime.bridge.onCaption({role: 'user', text: 'droppable', final: true})
  await captionAttempt
  assert.equal(softStop.signal.aborted, false)
  await disconnectStarted
  await assert.rejects(
    soft.server.connectClient(),
    /controlled desktop client already connected/u,
  )
  const disconnected = soft.server.nextDisconnected('soft failure transport disconnected')
  soft.server.releaseDisconnect()
  await disconnected

  const reconnectState = soft.server.nextSend('soft failure reconnect state')
  await soft.server.connectClient()
  assert.equal(await reconnectState, '{"type":"codex.state","state":"running"}')
  soft.server.failNext()
  const latestAttempt = soft.server.nextSend('latest failing send attempt')
  soft.server.holdDisconnect()
  const latestDisconnected = soft.server.nextDisconnected('latest failure transport disconnected')
  soft.realtime.bridge.onCodexState('idle')
  await latestAttempt
  assert.equal(softStop.signal.aborted, false)
  soft.server.releaseDisconnect()
  await latestDisconnected
  const currentState = soft.server.nextSend('latest failure current state retry')
  await soft.server.connectClient()
  assert.equal(await currentState, '{"type":"codex.state","state":"idle"}')

  const overflowStop = new AbortController()
  const overflowService = serviceHarness().service
  const overflow = new DesktopRealtime({
    token: TOKEN, service: overflowService, stop: overflowStop, maxOutboundFrames: 1,
    createServer: options => new ControlledServer(options),
  })
  overflow.bridge.onAudioFrame({
    utterance_id: 'overflow', generation_epoch: 1, sequence: 0, pcm: new Uint8Array([0, 1]),
  })
  overflow.bridge.onAudioFrame({
    utterance_id: 'overflow', generation_epoch: 1, sequence: 1, pcm: new Uint8Array([2, 3]),
  })
  assert.equal(overflowStop.signal.aborted, true)
})

test('droppable local validation failure is diagnosed without disconnecting a healthy client', async () => {
  const stop = new AbortController()
  const telemetry = new RecordingTelemetry()
  const clock = new VirtualClock(5)
  const {service} = serviceHarness()
  let server: ControlledServer | undefined
  const realtime = new DesktopRealtime({
    token: TOKEN,
    service,
    stop,
    clock,
    telemetry,
    createServer: options => {
      server = new ControlledServer(options)
      return server
    },
  })
  const controlled = server!
  const initial = controlled.nextSend('validation failure initial state')
  await controlled.connectClient()
  await initial

  controlled.failNextValidation()
  const rejectedCaption = controlled.nextSend('locally rejected caption attempt')
  realtime.bridge.onCaption({role: 'user', text: 'droppable', final: true})
  await rejectedCaption

  const currentState = controlled.nextSend('state after local validation failure')
  realtime.bridge.onCodexState('idle')
  assert.equal(await currentState, '{"type":"codex.state","state":"idle"}')
  assert.equal(stop.signal.aborted, false)
  assert.deepEqual(telemetry.records.at(-1), {
    kind: 'desktop.outbound_validation_dropped',
    payload: {policy: 'droppable', frame_kind: 'text'},
  })
})
