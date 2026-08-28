import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { test } from 'node:test'
import { WebSocket, type RawData } from 'ws'
import {
  DesktopCameraError,
  DesktopProtocolError,
  MAX_DESKTOP_JSON_BYTES,
  MAX_DESKTOP_OUTBOUND_BINARY_BYTES,
  MAX_DESKTOP_PENDING_SENDS,
  MAX_DESKTOP_PCM_BYTES,
  NodeDesktopServer,
  announceReadiness,
  authenticateDesktopFrame,
  parseDesktopControl,
  parseReadyEndpoint,
} from '../src/desktop.js'
import {
  CAMERA_CAPTURE_TIMEOUT_MS,
  CAMERA_FRAME_MAGIC,
  MAX_CAMERA_JPEG_BYTES,
  MAX_CAMERA_LATE_RESPONSES,
  MAX_CAMERA_WIRE_BYTES,
  MAX_DESKTOP_INBOUND_BYTES,
  MAX_PENDING_CAMERA_REQUESTS,
  encodeCameraFrame,
  serializeCameraError,
  serializeCameraPermissionResult,
} from '../src/desktop-camera.js'

const TOKEN = '0123456789abcdef0123456789abcdef'

interface CloseVerdict {
  readonly code: number
  readonly reason: string
}

interface ReceivedFrame {
  readonly binary: boolean
  readonly bytes: Uint8Array
}

function text(data: RawData): string {
  return Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString('utf8')
}

async function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`)
  const opened = new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('desktop socket closed before connecting'))
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
  try {
    await settleWithin('desktop client connection', opened)
  } catch (error) {
    socket.terminate()
    throw error
  }
  return socket
}

function nextTextFrames(socket: WebSocket, count: number): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    const frames: string[] = []
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) {
        cleanup()
        reject(new Error('expected a text desktop frame'))
        return
      }
      frames.push(text(data))
      if (frames.length === count) {
        cleanup()
        resolve(frames)
      }
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('desktop socket closed before all frames arrived'))
    }
    const cleanup = (): void => {
      socket.off('message', onMessage)
      socket.off('close', onClose)
    }
    socket.on('message', onMessage)
    socket.once('close', onClose)
  })
}

function waitForClose(socket: WebSocket): Promise<CloseVerdict> {
  return new Promise(resolve => {
    socket.once('close', (code, reason) => resolve({
      code,
      reason: reason.toString('utf8'),
    }))
  })
}

async function closeClient(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  const closed = waitForClose(socket)
  if (socket.readyState < WebSocket.CLOSING) socket.close(1000)
  try {
    await settleWithin('desktop client close', closed)
  } catch (error) {
    socket.terminate()
    throw error
  }
}

function settleWithin<T>(label: string, promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle in time`)), timeoutMs)
    void promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(`${label} rejected`))
      },
    )
  })
}

async function startDesktopServer(server: NodeDesktopServer): Promise<{readonly port: number}> {
  try {
    return await settleWithin('desktop server start', server.start())
  } catch (error) {
    await closeDesktopServer(server)
    throw error
  }
}

function closeDesktopServer(server: NodeDesktopServer): Promise<void> {
  return settleWithin('desktop server close', server.close())
}

async function connectDesktopClient(server: NodeDesktopServer, port: number): Promise<WebSocket> {
  try {
    return await connect(port)
  } catch (error) {
    await closeDesktopServer(server)
    throw error
  }
}

async function closeDesktopClientAndServer(socket: WebSocket, server: NodeDesktopServer): Promise<void> {
  try {
    await closeClient(socket)
  } finally {
    await closeDesktopServer(server)
  }
}

function nextFrames(socket: WebSocket, count: number): Promise<readonly ReceivedFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: ReceivedFrame[] = []
    const onMessage = (data: RawData, isBinary: boolean): void => {
      const bytes = Buffer.isBuffer(data)
        ? new Uint8Array(data)
        : new Uint8Array(Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]))
      frames.push({binary: isBinary, bytes})
      if (frames.length === count) {
        cleanup()
        resolve(frames)
      }
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('desktop socket closed before all frames arrived'))
    }
    const cleanup = (): void => {
      socket.off('message', onMessage)
      socket.off('close', onClose)
    }
    socket.on('message', onMessage)
    socket.once('close', onClose)
  })
}

async function authenticate(socket: WebSocket, bootstrapCount = 2): Promise<void> {
  const bootstrap = nextFrames(socket, bootstrapCount)
  socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
  await settleWithin('desktop authentication bootstrap', bootstrap)
}

async function cameraResult(promise: ReturnType<NodeDesktopServer['captureCamera']>): Promise<unknown> {
  try {
    return await promise
  } catch (error: unknown) {
    return error
  }
}

class FakeCameraTimer {
  readonly delays: number[] = []
  readonly #callbacks = new Map<number, () => void>()
  #sequence = 0

  set(delayMs: number, callback: () => void): number {
    this.delays.push(delayMs)
    const handle = ++this.#sequence
    this.#callbacks.set(handle, callback)
    return handle
  }

  clear(handle: unknown): void {
    if (typeof handle === 'number') this.#callbacks.delete(handle)
  }

  fireOldest(): void {
    const first = this.#callbacks.entries().next().value as [number, () => void] | undefined
    assert.ok(first !== undefined, 'a camera deadline is armed')
    this.#callbacks.delete(first[0])
    first[1]()
  }

  get active(): number {
    return this.#callbacks.size
  }
}

function captureError(error: unknown): boolean {
  return error instanceof DesktopCameraError
    && error.code === 'capture_unavailable'
    && !error.message.includes(TOKEN)
    && !error.message.includes('/private/camera')
}

test('desktop parsers validate credentials without echoing them', () => {
  authenticateDesktopFrame(
    JSON.stringify({type: 'hello', token: TOKEN, ignored: 'compatible-with-python'}),
    TOKEN,
  )
  const secret = 'wrong-secret'
  assert.throws(
    () => authenticateDesktopFrame(JSON.stringify({type: 'hello', token: secret}), TOKEN),
    error => error instanceof DesktopProtocolError && !error.message.includes(secret),
  )
  assert.throws(() => authenticateDesktopFrame(' '.repeat(MAX_DESKTOP_JSON_BYTES + 1), TOKEN),
    /too large/u)
  assert.throws(() => parseReadyEndpoint('localhost:4000'), /invalid/u)
  assert.deepEqual(parseReadyEndpoint('127.0.0.1:4000'), {host: '127.0.0.1', port: 4000})
  assert.deepEqual(parseReadyEndpoint('\u001c127.0.0.1:4000\u0085'),
    {host: '127.0.0.1', port: 4000})
})

test('desktop identifiers use Python blank and code-point limits', () => {
  assert.throws(() => parseDesktopControl(JSON.stringify({
    type: 'speech.onset',
    speech_id: '\u001c\u0085',
  })), /unsupported/u)
  const speechId = '😀'.repeat(256)
  const parsed = parseDesktopControl(JSON.stringify({
    type: 'speech.onset',
    speech_id: speechId,
  }))
  assert.equal(parsed.type, 'speech.onset')
  if (parsed.type === 'speech.onset') assert.equal(parsed.speech_id, speechId)
})

test('desktop parses only the bounded read-only workspace graph request shape', () => {
  assert.deepEqual(parseDesktopControl(JSON.stringify({
    type: 'workspace_graph.board.request',
    request_id: 'graph-请求',
  })), {
    type: 'workspace_graph.board.request',
    request_id: 'graph-请求',
  })
  assert.throws(() => parseDesktopControl(JSON.stringify({
    type: 'workspace_graph.board.request',
    request_id: ' ',
  })), /workspace graph request is invalid/u)
  assert.throws(() => parseDesktopControl(JSON.stringify({
    type: 'workspace_graph.board.delete',
    request_id: 'graph-1',
  })), /unsupported/u)
  assert.throws(() => parseDesktopControl(JSON.stringify({
    type: 'workspace_graph.board.request',
    request_id: '\ud800',
  })), /workspace graph request is invalid/u)
})

test('desktop accepts only an exact bounded project confirmation decision', () => {
  assert.deepEqual(parseDesktopControl(JSON.stringify({
    type: 'project.confirmation_decision',
    proposal_id: 'proposal-1',
    confirmed: false,
  })), {
    type: 'project.confirmation_decision',
    proposal_id: 'proposal-1',
    confirmed: false,
  })
  for (const decision of [
    {type: 'project.confirmation_decision', proposal_id: '', confirmed: true},
    {type: 'project.confirmation_decision', proposal_id: 'x'.repeat(129), confirmed: true},
    {type: 'project.confirmation_decision', proposal_id: 'proposal-1', confirmed: 'true'},
    {type: 'project.confirmation_decision', proposal_id: 'proposal-1', confirmed: true, extra: 1},
  ]) assert.throws(() => parseDesktopControl(JSON.stringify(decision)), /unsupported/u)
})

test('a malformed graph request is ignored without tearing down authenticated voice transport', async () => {
  let receivedSpeech = false
  let acknowledge: (() => void) | undefined
  const acknowledged = new Promise<void>(resolve => { acknowledge = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onControl: control => {
      if (control.type === 'speech.onset' && control.speech_id === 'still-live') {
        receivedSpeech = true
        acknowledge?.()
      }
    },
  })
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)
  try {
    await authenticate(socket)
    socket.send(JSON.stringify({
      type: 'workspace_graph.board.request', request_id: 'bad', extra: 'not allowed',
    }))
    socket.send(JSON.stringify({type: 'speech.onset', speech_id: 'still-live'}))
    await settleWithin('post-malformed graph control', acknowledged)
    assert.equal(receivedSpeech, true)
    assert.equal(socket.readyState, WebSocket.OPEN)
  } finally {
    await closeDesktopClientAndServer(socket, server)
  }
})

test('a transient audio host failure does not misclassify valid renderer PCM as a protocol violation', async () => {
  let audioCalls = 0
  let secondAudioArrived: (() => void) | undefined
  const secondAudio = new Promise<void>(resolve => { secondAudioArrived = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onAudio: () => {
      audioCalls += 1
      if (audioCalls === 1) return Promise.reject(new Error('provider reconnecting'))
      secondAudioArrived?.()
      return Promise.resolve()
    },
  })
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)
  try {
    await authenticate(socket)
    const closed = waitForClose(socket).then(() => 'closed' as const)
    socket.send(Buffer.from([0, 0]))
    socket.send(Buffer.from([1, 0]))
    const outcome = await settleWithin(
      'post-reconnect desktop audio',
      Promise.race([secondAudio.then(() => 'delivered' as const), closed]),
    )
    assert.equal(outcome, 'delivered')
    assert.equal(socket.readyState, WebSocket.OPEN)
    assert.equal(audioCalls, 2)
  } finally {
    await closeDesktopClientAndServer(socket, server)
  }
})

test('a transient control host failure does not misclassify a valid renderer command as a protocol violation', async () => {
  let controlCalls = 0
  let secondControlArrived: (() => void) | undefined
  const secondControl = new Promise<void>(resolve => { secondControlArrived = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onControl: () => {
      controlCalls += 1
      if (controlCalls === 1) return Promise.reject(new Error('provider reconnecting'))
      secondControlArrived?.()
      return Promise.resolve()
    },
  })
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)
  try {
    await authenticate(socket)
    const closed = waitForClose(socket).then(() => 'closed' as const)
    socket.send(JSON.stringify({type: 'speech.onset', speech_id: 'during-reconnect'}))
    socket.send(JSON.stringify({type: 'speech.onset', speech_id: 'after-reconnect'}))
    const outcome = await settleWithin(
      'post-reconnect desktop control',
      Promise.race([secondControl.then(() => 'delivered' as const), closed]),
    )
    assert.equal(outcome, 'delivered')
    assert.equal(socket.readyState, WebSocket.OPEN)
    assert.equal(controlCalls, 2)
  } finally {
    await closeDesktopClientAndServer(socket, server)
  }
})

test('desktop controls preserve the Python accepted shape and strip unknown evidence', () => {
  assert.deepEqual(parseDesktopControl(JSON.stringify({
    type: 'playback.started',
    utterance_id: 'u-1',
    generation_epoch: 2,
    played_ms: 'ignored-on-start',
    extra: true,
  })), {
    type: 'playback.started',
    utterance_id: 'u-1',
    generation_epoch: 2,
  })
  const onset = parseDesktopControl(JSON.stringify({
    type: 'speech.onset',
    speech_id: 'x'.repeat(256),
  }))
  assert.equal(onset.type, 'speech.onset')
  if (onset.type === 'speech.onset') assert.equal(onset.speech_id, 'x'.repeat(256))
  assert.throws(() => parseDesktopControl(JSON.stringify({
    type: 'speech.onset',
    speech_id: '   ',
  })), /unsupported/u)
  assert.throws(() => parseDesktopControl(JSON.stringify({
    type: 'playback.done',
    utterance_id: 'u-1',
    generation_epoch: 1,
    played_ms: -1,
  })), /unsupported/u)
})

test('readiness is announced as one authenticated line over loopback TCP', async () => {
  let received = Buffer.alloc(0)
  let receiveLine: ((line: string) => void) | undefined
  const lineReceived = new Promise<string>(resolve => { receiveLine = resolve })
  const listener = createServer(socket => {
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk])
      const textValue = received.toString('utf8')
      if (textValue.endsWith('\n')) receiveLine?.(textValue)
    })
  })
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen({host: '127.0.0.1', port: 0}, resolve)
  })
  const address = listener.address()
  assert.ok(address !== null && typeof address === 'object')

  try {
    await announceReadiness(`127.0.0.1:${address.port}`, {
      token: TOKEN,
      host: '127.0.0.1',
      port: 51_515,
    })
    assert.equal(await settleWithin('readiness parent receives line', lineReceived), `${JSON.stringify({
      token: TOKEN,
      host: '127.0.0.1',
      port: 51_515,
    })}\n`)
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => {
      if (error !== undefined) reject(error)
      else resolve()
    }))
  }
})

test('authenticated desktop client receives bootstrap and forwards validated input', async () => {
  let resolveAudio: ((value: Uint8Array) => void) | undefined
  let resolveControl: ((value: string) => void) | undefined
  const audio = new Promise<Uint8Array>(resolve => { resolveAudio = resolve })
  const control = new Promise<string>(resolve => { resolveControl = resolve })
  let disconnects = 0
  const server = new NodeDesktopServer({
    token: TOKEN,
    onAudio: pcm => resolveAudio?.(pcm),
    onControl: value => resolveControl?.(value.type),
    onClientDisconnect: () => { disconnects += 1 },
  })
  const readiness = await server.start()
  const socket = await connect(readiness.port)

  try {
    const bootstrap = nextTextFrames(socket, 2)
    socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
    assert.deepEqual(await bootstrap, [
      '{"type":"desktop.ready"}',
      '{"type":"codex.state","state":"idle"}',
    ])

    socket.send(Buffer.from([0, 1, 2, 3]))
    socket.send(JSON.stringify({type: 'speech.onset', speech_id: 'speech-1'}))
    assert.deepEqual([...await audio], [0, 1, 2, 3])
    assert.equal(await control, 'speech.onset')
  } finally {
    await closeClient(socket)
    await server.close()
  }
  assert.equal(disconnects, 1)
})

test('authenticated desktop camera capture correlates one exact framed JPEG', async () => {
  const server = new NodeDesktopServer({token: TOKEN})
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)
  try {
    await authenticate(socket)
    const rendererRequest = nextTextFrames(socket, 1)
    let capture: ReturnType<NodeDesktopServer['captureCamera']>
    try {
      capture = server.captureCamera({source: 'local'})
    } catch (error) {
      void rendererRequest.catch(() => undefined)
      throw error
    }
    const [request] = await settleWithin('desktop camera request', rendererRequest)
    assert.equal(request, '{"type":"camera.capture","request_id":"camera-1","source":"local"}')
    socket.send(encodeCameraFrame({
      request_id: 'camera-1',
      payload: new Uint8Array([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]),
    }))
    const frame = await settleWithin('desktop camera capture', capture)
    assert.deepEqual(frame, {
      payload: new Uint8Array([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]),
      media_type: 'image/jpeg',
      width: 1280,
      height: 720,
    })
  } finally {
    await closeDesktopClientAndServer(socket, server)
  }
})

test('authenticated desktop camera permission admission correlates one exact result', async () => {
  const timer = new FakeCameraTimer()
  const server = new NodeDesktopServer({token: TOKEN, cameraTimer: timer})
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)
  try {
    await authenticate(socket)
    const rendererRequest = nextTextFrames(socket, 1)
    const admission = server.requestCameraPermission()
    const [request] = await settleWithin('desktop camera permission request', rendererRequest)
    assert.equal(
      request,
      '{"type":"camera.permission","request_id":"camera-permission-1"}',
    )
    socket.send(serializeCameraPermissionResult({
      request_id: 'camera-permission-1',
      status: 'denied',
    }))
    assert.equal(await settleWithin('desktop camera permission result', admission), 'denied')
    assert.equal(timer.active, 0)
  } finally {
    await closeDesktopClientAndServer(socket, server)
  }
})

test('camera permission admission is unavailable without an authenticated desktop owner', async () => {
  const server = new NodeDesktopServer({token: TOKEN})
  await assert.rejects(
    settleWithin('disconnected camera permission', server.requestCameraPermission()),
    captureError,
  )
  await server.close()
})

test('camera errors isolate requests and concurrent frames may settle out of order', async () => {
  const timer = new FakeCameraTimer()
  const server = new NodeDesktopServer({token: TOKEN, cameraTimer: timer})
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)
  try {
    await authenticate(socket)
    const requests = nextTextFrames(socket, 3)
    const first = server.captureCamera({source: 'local'})
    const second = server.captureCamera({source: 'file', positionMs: 2500})
    const third = server.captureCamera({source: 'local'})
    const [firstRaw, secondRaw, thirdRaw] = await settleWithin('three camera requests', requests)
    const firstRequest = JSON.parse(firstRaw!) as {request_id: string}
    const secondRequest = JSON.parse(secondRaw!) as {request_id: string}
    const thirdRequest = JSON.parse(thirdRaw!) as {request_id: string}
    assert.deepEqual([firstRequest.request_id, secondRequest.request_id, thirdRequest.request_id],
      ['camera-1', 'camera-2', 'camera-3'])
    assert.equal(secondRaw,
      '{"type":"camera.capture","request_id":"camera-2","source":"file","position_ms":2500}')

    socket.send(encodeCameraFrame({
      request_id: thirdRequest.request_id,
      payload: new Uint8Array([0xff, 0xd8, 3, 3, 0xff, 0xd9]),
    }))
    socket.send(serializeCameraError({request_id: firstRequest.request_id}))
    socket.send(encodeCameraFrame({
      request_id: secondRequest.request_id,
      payload: new Uint8Array([0xff, 0xd8, 2, 2, 0xff, 0xd9]),
    }))

    await assert.rejects(settleWithin('isolated camera error', first), captureError)
    assert.deepEqual([...((await settleWithin('third camera frame', third)).payload)],
      [0xff, 0xd8, 3, 3, 0xff, 0xd9])
    assert.deepEqual([...((await settleWithin('second camera frame', second)).payload)],
      [0xff, 0xd8, 2, 2, 0xff, 0xd9])
    assert.equal(timer.active, 0)
  } finally {
    await closeDesktopClientAndServer(socket, server)
  }
})

test('camera capture validates before socket state and bounds pending requests', async () => {
  const timer = new FakeCameraTimer()
  const server = new NodeDesktopServer({token: TOKEN, cameraTimer: timer})
  assert.throws(
    () => server.captureCamera({source: 'file'}),
    error => error instanceof DesktopCameraError && error.code === 'invalid_request',
  )
  assert.throws(
    () => server.captureCamera({source: 'local', positionMs: 0}),
    error => error instanceof DesktopCameraError && error.code === 'invalid_request',
  )
  await assert.rejects(
    settleWithin('disconnected camera request', server.captureCamera({source: 'local'})),
    captureError,
  )
  assert.equal(timer.active, 0)

  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)
  try {
    await assert.rejects(
      settleWithin('unauthenticated camera request', server.captureCamera({source: 'local'})),
      captureError,
    )
    await authenticate(socket)
    const requests = nextTextFrames(socket, MAX_PENDING_CAMERA_REQUESTS)
    const pending = Array.from({length: MAX_PENDING_CAMERA_REQUESTS}, () =>
      cameraResult(server.captureCamera({source: 'local'})),
    )
    await assert.rejects(
      settleWithin('ninth camera request', server.captureCamera({source: 'local'})),
      captureError,
    )
    assert.equal((await settleWithin('bounded camera requests', requests)).length,
      MAX_PENDING_CAMERA_REQUESTS)
    assert.equal(timer.active, MAX_PENDING_CAMERA_REQUESTS)
    await settleWithin('pending camera disconnect', server.disconnectClient())
    const errors = await settleWithin('pending camera cleanup', Promise.all(pending))
    assert.equal(errors.filter(captureError).length, MAX_PENDING_CAMERA_REQUESTS)
    assert.equal(timer.active, 0)
  } finally {
    await closeDesktopServer(server)
  }
  await assert.rejects(
    settleWithin('stopped camera request', server.captureCamera({source: 'local'})),
    captureError,
  )
})

test('camera timeout is exactly five seconds and a valid late reply is ignored', async () => {
  const timer = new FakeCameraTimer()
  let passBarrier: (() => void) | undefined
  const barrier = new Promise<void>(resolve => { passBarrier = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    cameraTimer: timer,
    onControl: () => passBarrier?.(),
  })
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)
  try {
    await authenticate(socket)
    const firstRequest = nextTextFrames(socket, 1)
    const first = server.captureCamera({source: 'local'})
    const [raw] = await settleWithin('timed camera request', firstRequest)
    const requestId = (JSON.parse(raw!) as {request_id: string}).request_id
    assert.deepEqual(timer.delays, [CAMERA_CAPTURE_TIMEOUT_MS])
    timer.fireOldest()
    await assert.rejects(settleWithin('camera timeout result', first), captureError)
    assert.equal(timer.active, 0)

    socket.send(encodeCameraFrame({request_id: requestId, payload: JPEG_BYTES}))
    socket.send(JSON.stringify({type: 'speech.onset', speech_id: 'after-late-camera'}))
    await settleWithin('late camera processing barrier', barrier)
    assert.equal(socket.readyState, WebSocket.OPEN)

    const secondRequest = nextTextFrames(socket, 1)
    const second = server.captureCamera({source: 'local'})
    const secondId = (JSON.parse((await settleWithin('post-timeout camera request', secondRequest))[0]!) as {
      request_id: string
    }).request_id
    assert.notEqual(secondId, requestId)
    socket.send(encodeCameraFrame({request_id: secondId, payload: JPEG_BYTES}))
    await settleWithin('post-timeout camera success', second)
    assert.equal(timer.active, 0)
  } finally {
    await closeDesktopClientAndServer(socket, server)
  }
})

test('a timeout tombstone belongs only to its original socket generation', async () => {
  const timer = new FakeCameraTimer()
  let observeDisconnect: (() => void) | undefined
  const disconnected = new Promise<void>(resolve => { observeDisconnect = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    cameraTimer: timer,
    onClientDisconnect: () => observeDisconnect?.(),
  })
  const readiness = await startDesktopServer(server)
  const first = await connectDesktopClient(server, readiness.port)
  let second: WebSocket | undefined
  try {
    await authenticate(first)
    const request = nextTextFrames(first, 1)
    const capture = server.captureCamera({source: 'local'})
    const requestId = (JSON.parse((await settleWithin('generation tombstone request', request))[0]!) as {
      request_id: string
    }).request_id
    timer.fireOldest()
    await assert.rejects(settleWithin('generation tombstone timeout', capture), captureError)
    await closeClient(first)
    await settleWithin('generation tombstone disconnect', disconnected)

    second = await connect(readiness.port)
    await authenticate(second)
    const closed = waitForClose(second)
    second.send(encodeCameraFrame({request_id: requestId, payload: JPEG_BYTES}))
    assert.deepEqual(await settleWithin('wrong generation tombstone close', closed), {
      code: 4003, reason: 'desktop protocol rejected',
    })
  } finally {
    if (second !== undefined) await closeClient(second)
    await closeDesktopServer(server)
  }
})

test('camera timeout tombstones retain only the newest bounded FIFO', async () => {
  const timer = new FakeCameraTimer()
  let passBarrier: (() => void) | undefined
  const barrier = new Promise<void>(resolve => { passBarrier = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    cameraTimer: timer,
    onControl: () => passBarrier?.(),
  })
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)
  const ids: string[] = []
  try {
    await authenticate(socket)
    for (let index = 0; index <= MAX_CAMERA_LATE_RESPONSES; index += 1) {
      const request = nextTextFrames(socket, 1)
      const capture = server.captureCamera({source: 'local'})
      ids.push((JSON.parse((await settleWithin('bounded tombstone request', request))[0]!) as {
        request_id: string
      }).request_id)
      timer.fireOldest()
      await assert.rejects(settleWithin('bounded tombstone timeout', capture), captureError)
    }
    socket.send(encodeCameraFrame({request_id: ids.at(-1)!, payload: JPEG_BYTES}))
    socket.send(JSON.stringify({type: 'speech.onset', speech_id: 'after-newest-tombstone'}))
    await settleWithin('newest tombstone processing barrier', barrier)
    assert.equal(socket.readyState, WebSocket.OPEN)

    const closed = waitForClose(socket)
    socket.send(encodeCameraFrame({request_id: ids[0]!, payload: JPEG_BYTES}))
    assert.deepEqual(await settleWithin('evicted tombstone close', closed), {
      code: 4003, reason: 'desktop protocol rejected',
    })
  } finally {
    await closeDesktopServer(server)
  }
})

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0x44, 0x55, 0xff, 0xd9])

test('unknown and duplicate successful camera replies are protocol violations', async t => {
  await t.test('unknown request id', async () => {
    const server = new NodeDesktopServer({token: TOKEN})
    const readiness = await startDesktopServer(server)
    const socket = await connectDesktopClient(server, readiness.port)
    try {
      await authenticate(socket)
      const closed = waitForClose(socket)
      socket.send(encodeCameraFrame({request_id: 'camera-never-issued', payload: JPEG_BYTES}))
      assert.deepEqual(await settleWithin('unknown camera close', closed), {
        code: 4003, reason: 'desktop protocol rejected',
      })
    } finally {
      await closeDesktopServer(server)
    }
  })

  await t.test('duplicate successful response', async () => {
    const server = new NodeDesktopServer({token: TOKEN})
    const readiness = await startDesktopServer(server)
    const socket = await connectDesktopClient(server, readiness.port)
    try {
      await authenticate(socket)
      const request = nextTextFrames(socket, 1)
      const capture = server.captureCamera({source: 'local'})
      const requestId = (JSON.parse((await settleWithin('duplicate camera request', request))[0]!) as {
        request_id: string
      }).request_id
      const response = encodeCameraFrame({request_id: requestId, payload: JPEG_BYTES})
      socket.send(response)
      await settleWithin('first camera response', capture)
      const closed = waitForClose(socket)
      socket.send(response)
      assert.deepEqual(await settleWithin('duplicate camera close', closed), {
        code: 4003, reason: 'desktop protocol rejected',
      })
    } finally {
      await closeDesktopServer(server)
    }
  })
})

test('camera requests are cleaned on disconnect, explicit disconnect and server close', async () => {
  const timer = new FakeCameraTimer()
  const server = new NodeDesktopServer({token: TOKEN, cameraTimer: timer})
  const readiness = await startDesktopServer(server)
  let socket = await connectDesktopClient(server, readiness.port)
  try {
    await authenticate(socket)
    let requests = nextTextFrames(socket, 2)
    const first = server.captureCamera({source: 'local'})
    const second = server.captureCamera({source: 'file', positionMs: 0})
    const firstResult = cameraResult(first)
    const secondResult = cameraResult(second)
    await settleWithin('disconnect cleanup requests', requests)
    await closeClient(socket)
    assert.ok(captureError(await settleWithin('first disconnect cleanup', firstResult)))
    assert.ok(captureError(await settleWithin('second disconnect cleanup', secondResult)))
    assert.equal(timer.active, 0)

    socket = await connect(readiness.port)
    await authenticate(socket)
    requests = nextTextFrames(socket, 1)
    const explicit = server.captureCamera({source: 'local'})
    const explicitResult = cameraResult(explicit)
    await settleWithin('explicit disconnect camera request', requests)
    await settleWithin('explicit camera disconnect', server.disconnectClient())
    assert.ok(captureError(await settleWithin('explicit disconnect cleanup', explicitResult)))
    assert.equal(timer.active, 0)

    socket = await connect(readiness.port)
    await authenticate(socket)
    requests = nextTextFrames(socket, 1)
    const closing = server.captureCamera({source: 'local'})
    const closingResult = cameraResult(closing)
    await settleWithin('server close camera request', requests)
    await closeDesktopServer(server)
    assert.ok(captureError(await settleWithin('server close camera cleanup', closingResult)))
    assert.equal(timer.active, 0)
  } finally {
    await closeDesktopServer(server)
  }
})

test('camera send callback failure rejects its request and clears its deadline', async () => {
  const timer = new FakeCameraTimer()
  const server = new NodeDesktopServer({token: TOKEN, cameraTimer: timer})
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)
  const prototype = WebSocket.prototype as unknown as {
    send(data: unknown, options: unknown, callback: (error?: Error) => void): void
  }
  // Captured so the patched method can delegate with the server-side socket as `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalSend = prototype.send
  try {
    await authenticate(socket)
    const closed = waitForClose(socket)
    prototype.send = function failCameraSend(data, options, callback): void {
      if (typeof data === 'string' && data.includes('camera.capture')) {
        callback(new Error('injected /private/camera send failure'))
        return
      }
      originalSend.call(this, data, options, callback)
    }
    const capture = server.captureCamera({source: 'local'})
    await assert.rejects(settleWithin('camera send failure', capture), captureError)
    assert.equal(timer.active, 0)
    assert.deepEqual(await settleWithin('camera send failure socket close', closed), {
      code: 4003, reason: 'desktop protocol rejected',
    })
  } finally {
    prototype.send = originalSend
    await closeDesktopServer(server)
  }
})

test('stale generation response cannot settle or close a fresh camera request', async () => {
  let releaseAudio: (() => void) | undefined
  const heldAudio = new Promise<void>(resolve => { releaseAudio = resolve })
  let observeDisconnect: (() => void) | undefined
  const disconnected = new Promise<void>(resolve => { observeDisconnect = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onAudio: () => heldAudio,
    onClientDisconnect: () => observeDisconnect?.(),
  })
  const readiness = await startDesktopServer(server)
  const firstSocket = await connectDesktopClient(server, readiness.port)
  let secondSocket: WebSocket | undefined
  try {
    await authenticate(firstSocket)
    const oldRequest = nextTextFrames(firstSocket, 1)
    const oldCapture = server.captureCamera({source: 'local'})
    const oldResult = cameraResult(oldCapture)
    const oldId = (JSON.parse((await settleWithin('old generation camera request', oldRequest))[0]!) as {
      request_id: string
    }).request_id
    firstSocket.send(Buffer.from([0, 0]))
    firstSocket.send(encodeCameraFrame({request_id: oldId, payload: JPEG_BYTES}))
    firstSocket.terminate()
    await settleWithin('old generation server disconnect', disconnected)
    assert.ok(captureError(await settleWithin('old generation camera cleanup', oldResult)))

    secondSocket = await connect(readiness.port)
    await authenticate(secondSocket)
    const freshRequest = nextTextFrames(secondSocket, 1)
    const freshCapture = server.captureCamera({source: 'local'})
    const freshId = (JSON.parse((await settleWithin('fresh generation camera request', freshRequest))[0]!) as {
      request_id: string
    }).request_id
    releaseAudio?.()
    await settleWithin('stale generation processing turn', new Promise<void>(resolve => {
      setImmediate(resolve)
    }))
    assert.equal(secondSocket.readyState, WebSocket.OPEN)
    secondSocket.send(encodeCameraFrame({request_id: freshId, payload: JPEG_BYTES}))
    await settleWithin('fresh generation camera result', freshCapture)
    assert.equal(secondSocket.readyState, WebSocket.OPEN)
  } finally {
    releaseAudio?.()
    if (secondSocket !== undefined) await closeClient(secondSocket)
    await closeDesktopServer(server)
  }
})

test('camera binary dispatch preserves PCM prefixes and rejects malformed full magic', async () => {
  const audio: Uint8Array[] = []
  let resolveAudio: (() => void) | undefined
  const allAudio = new Promise<void>(resolve => { resolveAudio = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onAudio: pcm => {
      audio.push(pcm)
      if (audio.length === 8) resolveAudio?.()
    },
  })
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)
  try {
    await authenticate(socket)
    socket.send(Buffer.from([0, 1]))
    for (let prefix = 1; prefix < CAMERA_FRAME_MAGIC.byteLength; prefix += 1) {
      const length = prefix % 2 === 0 ? prefix : prefix + 1
      const pcm = new Uint8Array(length)
      pcm.set(CAMERA_FRAME_MAGIC.subarray(0, prefix))
      socket.send(pcm)
    }
    await settleWithin('partial camera magic PCM delivery', allAudio)
    assert.equal(audio.length, 8)
    assert.deepEqual([...audio[7]!.subarray(0, 7)], [...CAMERA_FRAME_MAGIC.subarray(0, 7)])
    const closed = waitForClose(socket)
    socket.send(CAMERA_FRAME_MAGIC)
    assert.deepEqual(await settleWithin('malformed camera frame close', closed), {
      code: 4003, reason: 'desktop protocol rejected',
    })
    assert.equal(audio.length, 8)
  } finally {
    await closeDesktopServer(server)
  }
})

test('full camera magic rejects truncated and oversized JPEG without PCM fallback', async t => {
  async function expectProtocolClose(name: string, payload: Uint8Array): Promise<void> {
    let audioCalls = 0
    const server = new NodeDesktopServer({token: TOKEN, onAudio: () => { audioCalls += 1 }})
    const readiness = await startDesktopServer(server)
    const socket = await connectDesktopClient(server, readiness.port)
    try {
      await authenticate(socket)
      const closed = waitForClose(socket)
      socket.send(payload)
      assert.deepEqual(await settleWithin(name, closed), {
        code: 4003, reason: 'desktop protocol rejected',
      })
      assert.equal(audioCalls, 0)
    } finally {
      await closeDesktopServer(server)
    }
  }

  await t.test('truncated JPEG', async () => {
    const valid = encodeCameraFrame({request_id: 'camera-1', payload: JPEG_BYTES})
    await expectProtocolClose('truncated camera JPEG close', valid.subarray(0, valid.byteLength - 1))
  })

  await t.test('one byte over JPEG limit', async () => {
    const jpeg = new Uint8Array(MAX_CAMERA_JPEG_BYTES)
    jpeg.set([0xff, 0xd8])
    jpeg.set([0xff, 0xd9], jpeg.byteLength - 2)
    const valid = encodeCameraFrame({request_id: 'camera-1', payload: jpeg})
    const oversized = new Uint8Array(valid.byteLength + 1)
    oversized.set(valid)
    oversized[valid.byteLength - 2] = 0
    oversized[valid.byteLength - 1] = 0xff
    oversized[valid.byteLength] = 0xd9
    assert.ok(oversized.byteLength <= MAX_CAMERA_WIRE_BYTES)
    await expectProtocolClose('oversized camera JPEG close', oversized)
  })
})

test('malformed camera error text closes with the stable protocol verdict', async () => {
  const server = new NodeDesktopServer({token: TOKEN})
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)
  try {
    await authenticate(socket)
    const closed = waitForClose(socket)
    socket.send(JSON.stringify({
      type: 'camera.error',
      request_id: 'camera-1',
      error: 'capture_unavailable',
      path: '/private/camera/secret-device',
    }))
    assert.deepEqual(await settleWithin('malformed camera error close', closed), {
      code: 4003, reason: 'desktop protocol rejected',
    })
  } finally {
    await closeDesktopServer(server)
  }
})

test('desktop applies separate PCM, camera wire and aggregate inbound bounds', async t => {
  await t.test('raw PCM remains limited to 64 KiB', async () => {
    const server = new NodeDesktopServer({token: TOKEN})
    const readiness = await startDesktopServer(server)
    const socket = await connectDesktopClient(server, readiness.port)
    try {
      await authenticate(socket)
      const closed = waitForClose(socket)
      socket.send(Buffer.alloc(MAX_DESKTOP_PCM_BYTES + 2))
      assert.deepEqual(await settleWithin('application PCM limit close', closed), {
        code: 4003, reason: 'desktop protocol rejected',
      })
    } finally {
      await closeDesktopServer(server)
    }
  })

  await t.test('WebSocket rejects bytes above the camera wire maximum', async () => {
    const server = new NodeDesktopServer({token: TOKEN})
    const readiness = await startDesktopServer(server)
    const socket = await connectDesktopClient(server, readiness.port)
    try {
      await authenticate(socket)
      const closed = waitForClose(socket)
      socket.send(Buffer.alloc(MAX_CAMERA_WIRE_BYTES + 1))
      assert.equal((await settleWithin('WebSocket camera limit close', closed)).code, 1009)
    } finally {
      await closeDesktopServer(server)
    }
  })

  await t.test('queued inbound camera bytes cannot exceed four MiB', async () => {
    let releaseAudio: (() => void) | undefined
    const heldAudio = new Promise<void>(resolve => { releaseAudio = resolve })
    const server = new NodeDesktopServer({token: TOKEN, onAudio: () => heldAudio})
    const readiness = await startDesktopServer(server)
    const socket = await connectDesktopClient(server, readiness.port)
    try {
      await authenticate(socket)
      const requests = nextTextFrames(socket, 2)
      const first = cameraResult(server.captureCamera({source: 'local'}))
      const second = cameraResult(server.captureCamera({source: 'local'}))
      const ids = (await settleWithin('aggregate camera requests', requests)).map(raw =>
        (JSON.parse(raw) as {request_id: string}).request_id)
      const jpeg = new Uint8Array(MAX_CAMERA_JPEG_BYTES)
      jpeg.set([0xff, 0xd8])
      jpeg.set([0xff, 0xd9], jpeg.byteLength - 2)
      const firstFrame = encodeCameraFrame({request_id: ids[0]!, payload: jpeg})
      const secondFrame = encodeCameraFrame({request_id: ids[1]!, payload: jpeg})
      assert.ok(firstFrame.byteLength + secondFrame.byteLength > MAX_DESKTOP_INBOUND_BYTES)
      socket.send(Buffer.from([0, 0]))
      const closed = waitForClose(socket)
      socket.send(firstFrame)
      socket.send(secondFrame)
      assert.deepEqual(await settleWithin('aggregate inbound close', closed), {
        code: 4003, reason: 'desktop protocol rejected',
      })
      releaseAudio?.()
      assert.ok(captureError(await settleWithin('aggregate first cleanup', first)))
      assert.ok(captureError(await settleWithin('aggregate second cleanup', second)))
    } finally {
      releaseAudio?.()
      await closeDesktopServer(server)
    }
  })
})

test('invalid credentials and malformed PCM fail closed with no credential disclosure', async () => {
  const server = new NodeDesktopServer({token: TOKEN})
  const readiness = await server.start()
  const invalid = await connect(readiness.port)

  const invalidClosed = waitForClose(invalid)
  invalid.send(JSON.stringify({type: 'hello', token: 'not-the-token'}))
  const invalidVerdict = await invalidClosed
  assert.deepEqual(invalidVerdict, {code: 4003, reason: 'desktop protocol rejected'})

  const malformed = await connect(readiness.port)
  const bootstrap = nextTextFrames(malformed, 2)
  malformed.send(JSON.stringify({type: 'hello', token: TOKEN}))
  await bootstrap
  const malformedClosed = waitForClose(malformed)
  malformed.send(Buffer.from([0]))
  assert.deepEqual(await malformedClosed, {code: 4003, reason: 'desktop protocol rejected'})
  await server.close()
})

test('a second desktop client cannot take over the active connection', async () => {
  const server = new NodeDesktopServer({token: TOKEN})
  const readiness = await server.start()
  const primary = await connect(readiness.port)
  const bootstrap = nextTextFrames(primary, 2)
  primary.send(JSON.stringify({type: 'hello', token: TOKEN}))
  await bootstrap

  const duplicate = new WebSocket(`ws://127.0.0.1:${readiness.port}/`)
  const duplicateClosed = waitForClose(duplicate)
  assert.deepEqual(await duplicateClosed, {
    code: 4009,
    reason: 'desktop client already connected',
  })

  await closeClient(primary)
  await server.close()
})

test('an unauthenticated desktop client is dropped on its own deadline', async () => {
  const server = new NodeDesktopServer({token: TOKEN, authTimeoutMs: 25})
  const readiness = await server.start()
  const silent = await connect(readiness.port)

  assert.deepEqual(await waitForClose(silent), {
    code: 4003,
    reason: 'desktop protocol rejected',
  })
  await server.close()
})

test('oversized PCM is rejected by the application PCM bound', async () => {
  const server = new NodeDesktopServer({token: TOKEN})
  const readiness = await server.start()
  const socket = await connect(readiness.port)
  const bootstrap = nextTextFrames(socket, 2)
  socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
  await bootstrap

  const closed = waitForClose(socket)
  socket.send(Buffer.alloc(MAX_DESKTOP_PCM_BYTES + 2))
  assert.deepEqual(await closed, {code: 4003, reason: 'desktop protocol rejected'})
  await server.close()
})

test('a renderer that disconnects can reconnect to the same live runtime', async () => {
  // Python's realtime/desktop.py drains only on parent EOF or a signal, so a
  // window reload must find the backend still serving.
  let disconnects = 0
  let observeDisconnect: (() => void) | undefined
  const serverSawDisconnect = new Promise<void>(resolve => { observeDisconnect = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onClientDisconnect: () => {
      disconnects += 1
      observeDisconnect?.()
    },
  })
  const readiness = await server.start()

  try {
    const first = await connect(readiness.port)
    const firstBootstrap = nextTextFrames(first, 2)
    first.send(JSON.stringify({type: 'hello', token: TOKEN}))
    await firstBootstrap
    await closeClient(first)
    // The client resolving its own close says nothing about the server having
    // observed it, and only the server releasing its active slot admits a
    // replacement. Wait for the server's own verdict.
    await serverSawDisconnect
    assert.equal(disconnects, 1)

    const second = await connect(readiness.port)
    const secondBootstrap = nextTextFrames(second, 2)
    second.send(JSON.stringify({type: 'hello', token: TOKEN}))
    assert.deepEqual(await secondBootstrap, [
      '{"type":"desktop.ready"}',
      '{"type":"codex.state","state":"idle"}',
    ])
    await closeClient(second)
  } finally {
    await server.close()
  }
})

test('desktop outbound sends fail closed before authentication and after disconnect', async () => {
  let observeDisconnect: (() => void) | undefined
  const disconnected = new Promise<void>(resolve => { observeDisconnect = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onClientDisconnect: () => observeDisconnect?.(),
  })
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)

  try {
    await assert.rejects(
      settleWithin('pre-auth desktop outbound send', server.sendText('{"type":"before-auth"}')),
      error => error instanceof DesktopProtocolError && !error.message.includes('before-auth'),
    )
    await authenticate(socket)
    await closeClient(socket)
    await settleWithin('server observes desktop disconnect', disconnected)
    await assert.rejects(
      settleWithin('post-disconnect desktop outbound send', server.sendBinary(new Uint8Array([9, 8, 7]))),
      error => error instanceof DesktopProtocolError,
    )
  } finally {
    await closeDesktopClientAndServer(socket, server)
  }
})

test('desktop outbound writer preserves accepted text and binary frame order', async () => {
  const server = new NodeDesktopServer({token: TOKEN})
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)

  try {
    await authenticate(socket)
    const received = nextFrames(socket, 3)
    await settleWithin('ordered desktop outbound sends', Promise.all([
      server.sendText('{"type":"outbound.one"}'),
      server.sendBinary(new Uint8Array([0, 255, 3, 128])),
      server.sendText('{"type":"outbound.two"}'),
    ]))
    const frames = await settleWithin('ordered desktop outbound frames', received)
    assert.deepEqual(frames.map(frame => ({
      binary: frame.binary,
      bytes: [...frame.bytes],
    })), [
      {binary: false, bytes: [...Buffer.from('{"type":"outbound.one"}', 'utf8')]},
      {binary: true, bytes: [0, 255, 3, 128]},
      {binary: false, bytes: [...Buffer.from('{"type":"outbound.two"}', 'utf8')]},
    ])
  } finally {
    await closeDesktopClientAndServer(socket, server)
  }
})

test('configured bootstrap frames precede the authenticated notification', async () => {
  let authenticatedNotifications = 0
  const server = new NodeDesktopServer({
    token: TOKEN,
    bootstrapTextFrames: ['{"type":"desktop.ready"}'],
    onClientAuthenticated: async () => {
      authenticatedNotifications += 1
      await settleWithin(
        'desktop authentication notification send',
        server.sendText('{"type":"desktop.authenticated"}'),
      )
    },
  })
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)

  try {
    const received = nextFrames(socket, 2)
    socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
    const frames = await settleWithin('configured bootstrap and authentication notification', received)
    assert.equal(authenticatedNotifications, 1)
    assert.deepEqual(frames.map(frame => text(Buffer.from(frame.bytes))), [
      '{"type":"desktop.ready"}',
      '{"type":"desktop.authenticated"}',
    ])
  } finally {
    await closeDesktopClientAndServer(socket, server)
  }
})

test('desktop outbound applies size and pending-send bounds', async () => {
  const server = new NodeDesktopServer({token: TOKEN})
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)

  try {
    await authenticate(socket)
    const delivered = nextFrames(socket, MAX_DESKTOP_PENDING_SENDS)
    const pending = Array.from({length: MAX_DESKTOP_PENDING_SENDS}, (_, index) =>
      server.sendText(`{"type":"pending","index":${index}}`),
    )
    await assert.rejects(
      settleWithin('full desktop outbound queue send', server.sendText('{"type":"pending","index":128}')),
      error => error instanceof DesktopProtocolError,
    )
    await settleWithin('accepted pending desktop sends', Promise.all(pending))
    await settleWithin('bounded pending desktop sends', delivered)
    await assert.rejects(
      settleWithin('oversized desktop text send', server.sendText('x'.repeat(MAX_DESKTOP_JSON_BYTES + 1))),
      error => error instanceof DesktopProtocolError,
    )
    await assert.rejects(
      settleWithin(
        'oversized desktop binary send',
        server.sendBinary(new Uint8Array(MAX_DESKTOP_OUTBOUND_BINARY_BYTES + 1)),
      ),
      error => error instanceof DesktopProtocolError,
    )
  } finally {
    await closeDesktopClientAndServer(socket, server)
  }
})

test('a failed desktop outbound send releases only that socket and notifies once', async () => {
  let disconnects = 0
  let observeDisconnect: (() => void) | undefined
  const disconnected = new Promise<void>(resolve => { observeDisconnect = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onClientDisconnect: () => {
      disconnects += 1
      observeDisconnect?.()
    },
  })
  const readiness = await startDesktopServer(server)
  const socket = await connectDesktopClient(server, readiness.port)
  const prototype = WebSocket.prototype as unknown as {
    send(data: unknown, options: unknown, callback: (error?: Error) => void): void
  }
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalSend = prototype.send

  try {
    await authenticate(socket)
    prototype.send = function failOutboundSend(data, options, callback): void {
      if (typeof data !== 'string') {
        callback(new Error('injected private outbound send failure'))
        return
      }
      originalSend.call(this, data, options, callback)
    }
    const sending = server.sendBinary(
      new Uint8Array(MAX_DESKTOP_OUTBOUND_BINARY_BYTES),
    )
    await assert.rejects(
      settleWithin('failed desktop outbound send', sending),
      error => error instanceof DesktopProtocolError,
    )
    await settleWithin('failed send disconnect notification', disconnected)
    assert.equal(disconnects, 1)
  } finally {
    prototype.send = originalSend
    await closeDesktopServer(server)
  }
})

test('a throwing disconnect observer cannot terminate desktop socket ownership', async () => {
  let disconnects = 0
  let observeDisconnect: (() => void) | undefined
  const nextDisconnect = (): Promise<void> => new Promise(resolve => {
    observeDisconnect = resolve
  })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onClientDisconnect: () => {
      disconnects += 1
      observeDisconnect?.()
      observeDisconnect = undefined
      throw new Error('private observer failure')
    },
  })
  const readiness = await startDesktopServer(server)

  try {
    const first = await connectDesktopClient(server, readiness.port)
    await authenticate(first)
    const firstDisconnected = nextDisconnect()
    await closeClient(first)
    await settleWithin('first throwing disconnect observer', firstDisconnected)

    const second = await connectDesktopClient(server, readiness.port)
    await authenticate(second)
    const secondDisconnected = nextDisconnect()
    await closeClient(second)
    await settleWithin('second throwing disconnect observer', secondDisconnected)
    assert.equal(disconnects, 2)
  } finally {
    await closeDesktopServer(server)
  }
})

test('desktop outbound uses a fresh authenticated socket after reconnect', async () => {
  let disconnects = 0
  let observeFirstDisconnect: (() => void) | undefined
  const firstDisconnected = new Promise<void>(resolve => { observeFirstDisconnect = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onClientDisconnect: () => {
      disconnects += 1
      if (disconnects === 1) observeFirstDisconnect?.()
    },
  })
  const readiness = await startDesktopServer(server)

  try {
    const first = await connect(readiness.port)
    await authenticate(first)
    const firstMessage = nextFrames(first, 1)
    await settleWithin('first desktop outbound send', server.sendText('{"type":"first-connection"}'))
    const firstFrames = await settleWithin('first outbound send', firstMessage)
    assert.equal(firstFrames.length, 1)
    assert.equal(text(Buffer.from(firstFrames[0]!.bytes)),
      '{"type":"first-connection"}')
    await closeClient(first)
    await settleWithin('first server disconnect', firstDisconnected)

    const second = await connect(readiness.port)
    try {
      await authenticate(second)
      const secondMessage = nextFrames(second, 1)
      await settleWithin('second desktop outbound send', server.sendText('{"type":"second-connection"}'))
      const secondFrames = await settleWithin('second outbound send', secondMessage)
      assert.equal(secondFrames.length, 1)
      assert.equal(text(Buffer.from(secondFrames[0]!.bytes)),
        '{"type":"second-connection"}')
    } finally {
      await closeClient(second)
    }
  } finally {
    await closeDesktopServer(server)
  }
})

test('explicit desktop disconnect retires the captured client once and leaves reconnect usable', async () => {
  let disconnects = 0
  let observeDisconnect: (() => void) | undefined
  const disconnected = new Promise<void>(resolve => { observeDisconnect = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onClientDisconnect: () => {
      disconnects += 1
      observeDisconnect?.()
    },
  })
  const readiness = await startDesktopServer(server)
  const first = await connectDesktopClient(server, readiness.port)

  try {
    await authenticate(first)
    const firstClosed = settleWithin('explicitly disconnected desktop client close', waitForClose(first))
    await settleWithin(
      'generation-scoped desktop disconnect',
      server.disconnectClient(),
    )
    await firstClosed
    await settleWithin('explicit desktop disconnect notification', disconnected)
    assert.equal(disconnects, 1)

    const second = await connect(readiness.port)
    try {
      await authenticate(second)
      const received = nextFrames(second, 1)
      await settleWithin(
        'post-explicit-disconnect fresh send',
        server.sendText('{"type":"fresh-after-disconnect"}'),
      )
      assert.equal(
        text(Buffer.from((await settleWithin('fresh reconnect frame', received))[0]!.bytes)),
        '{"type":"fresh-after-disconnect"}',
      )
    } finally {
      await closeClient(second)
    }
  } finally {
    await closeDesktopServer(server)
  }
})

test('forwarded PCM is a copy that a later frame cannot overwrite', async () => {
  // `ws` allocates receive buffers from a shared pool, so a view would alias
  // bytes the next frame reuses.
  const received: Uint8Array[] = []
  const server = new NodeDesktopServer({
    token: TOKEN,
    onAudio: pcm => { received.push(pcm) },
  })
  const readiness = await server.start()
  const socket = await connect(readiness.port)

  try {
    const bootstrap = nextTextFrames(socket, 2)
    socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
    await bootstrap

    for (let frame = 1; frame <= 8; frame += 1) {
      socket.send(Buffer.alloc(64, frame))
    }
    while (received.length < 8) await new Promise(resolve => setTimeout(resolve, 10))

    received.forEach((pcm, index) => {
      assert.deepEqual([...new Set(pcm)], [index + 1], `frame ${index + 1} was overwritten`)
    })
  } finally {
    await closeClient(socket)
    await server.close()
  }
})

test('readiness announcement commits after its line flush even when the parent holds the socket', async () => {
  const held: Socket[] = []
  let received = Buffer.alloc(0)
  let receiveLine: ((line: string) => void) | undefined
  const lineReceived = new Promise<string>(resolve => { receiveLine = resolve })
  const listener = createServer(socket => {
    held.push(socket)
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk])
      const textValue = received.toString('utf8')
      if (textValue.endsWith('\n')) receiveLine?.(textValue)
    })
  })
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen({host: '127.0.0.1', port: 0}, resolve)
  })
  const address = listener.address()
  assert.ok(address !== null && typeof address === 'object')

  try {
    await settleWithin(
      'held readiness write commit',
      announceReadiness(
        `127.0.0.1:${address.port}`,
        {token: TOKEN, host: '127.0.0.1', port: 51_515},
        50,
      ),
    )
    assert.equal(await settleWithin('held readiness parent receives line', lineReceived), `${JSON.stringify({
      token: TOKEN, host: '127.0.0.1', port: 51_515,
    })}\n`)
  } finally {
    for (const socket of held) socket.destroy()
    await new Promise<void>((resolve, reject) => listener.close(error => {
      if (error !== undefined) reject(error)
      else resolve()
    }))
  }
})

test('readiness announcement abort destroys the held socket with a stable safe error', async () => {
  const held: Socket[] = []
  const listener = createServer(socket => {
    held.push(socket)
  })
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen({host: '127.0.0.1', port: 0}, resolve)
  })
  const address = listener.address()
  assert.ok(address !== null && typeof address === 'object')
  const abort = new AbortController()
  const endpoint = `127.0.0.1:${address.port}`
  abort.abort()
  const announcing = announceReadiness(
    endpoint,
    {token: TOKEN, host: '127.0.0.1', port: 51_515},
    {timeoutMs: 1_000, signal: abort.signal},
  )

  try {
    await assert.rejects(
      settleWithin('readiness abort result', announcing),
      (error: unknown) => error instanceof DesktopProtocolError
        && error.message === 'desktop readiness announcement cancelled'
        && !error.message.includes(endpoint)
        && !error.message.includes(TOKEN),
    )
    assert.equal(held.length, 0)
  } finally {
    abort.abort()
    for (const socket of held) socket.destroy()
    await new Promise<void>((resolve, reject) => listener.close(error => {
      if (error !== undefined) reject(error)
      else resolve()
    }))
  }
})

test('desktop shutdown terminates a peer that does not acknowledge close', async () => {
  const server = new NodeDesktopServer({token: TOKEN, closeGraceMs: 25})
  const readiness = await server.start()
  const socket = await connect(readiness.port)
  const bootstrap = nextTextFrames(socket, 2)
  socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
  await bootstrap

  const transport = (socket as WebSocket & {readonly _socket: Socket})._socket
  transport.pause()
  const started = Date.now()
  await server.close()
  assert.ok(Date.now() - started < 500)
  transport.destroy()
})
