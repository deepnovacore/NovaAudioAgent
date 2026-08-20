import assert from 'node:assert/strict'
import {test} from 'node:test'
import {WebSocket, type RawData} from 'ws'
import type {ExecutorDispatchContext} from '../src/causal-runtime.js'
import {VirtualClock} from '../src/clock.js'
import {
  CAMERA_FRAME_MAGIC,
  MAX_CAMERA_POSITION_MS,
  MAX_CAMERA_WIRE_BYTES,
  encodeCameraFrame,
  parseCameraCapture,
  serializeCameraError,
} from '../src/desktop-camera.js'
import {
  NodeDesktopServer,
  type DesktopCameraTimer,
} from '../src/desktop.js'
import {CamAdapter, CameraError} from '../src/executors/camera.js'
import {ChromiumFrameSource} from '../src/executors/chromium-frame-source.js'
import {
  GUARD_MANIFEST,
  WATCH_MANIFEST,
  WatchAdapter,
} from '../src/executors/watcher.js'
import {MediaStore} from '../src/media-store.js'
import type {CompleteRequest, ModelGateway} from '../src/model-gateway.js'

const TOKEN = '0123456789abcdef0123456789abcdef'
const SETTLE_MS = 2_000

type RendererBehavior = 'ok' | 'error' | 'drop' | 'disconnect' | 'wrong_id' | 'malformed'
  | 'oversized'

interface CameraTrace {
  readonly requestId: string
  readonly source: 'local' | 'file'
  readonly positionMs: number | undefined
  readonly behavior: RendererBehavior
}

class ControlledTimer implements DesktopCameraTimer {
  readonly #callbacks = new Map<number, () => void>()
  #sequence = 0

  set(_delayMs: number, callback: () => void): number {
    this.#sequence += 1
    this.#callbacks.set(this.#sequence, callback)
    return this.#sequence
  }

  clear(handle: unknown): void {
    if (typeof handle === 'number') this.#callbacks.delete(handle)
  }

  get activeCount(): number { return this.#callbacks.size }

  fireOldest(): void {
    const oldest = this.#callbacks.entries().next()
    if (oldest.done) throw new Error('camera timer is empty')
    const [handle, callback] = oldest.value
    this.#callbacks.delete(handle)
    callback()
  }
}

class InjectedRenderer {
  readonly trace: CameraTrace[] = []
  readonly #behaviors: RendererBehavior[] = []

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      const raw = rawText(data)
      let request
      try {
        request = parseCameraCapture(raw)
      } catch {
        return
      }
      const behavior = this.#behaviors.shift() ?? 'ok'
      this.trace.push({
        requestId: request.request_id,
        source: request.source,
        positionMs: request.source === 'file' ? request.position_ms : undefined,
        behavior,
      })
      if (behavior === 'drop') return
      if (behavior === 'disconnect') {
        socket.close(1000)
        return
      }
      if (behavior === 'error') {
        socket.send(serializeCameraError({request_id: request.request_id}))
        return
      }
      if (behavior === 'wrong_id') {
        socket.send(encodeCameraFrame({request_id: 'camera-wrong', payload: jpegFor(0)}))
        return
      }
      if (behavior === 'malformed') {
        socket.send(new Uint8Array([...CAMERA_FRAME_MAGIC, 0, 2, 0x7b, 0x7d]))
        return
      }
      if (behavior === 'oversized') {
        const wire = new Uint8Array(MAX_CAMERA_WIRE_BYTES + 1)
        wire.set(CAMERA_FRAME_MAGIC)
        socket.send(wire)
        return
      }
      socket.send(encodeCameraFrame({
        request_id: request.request_id,
        payload: jpegFor(request.source === 'file' ? request.position_ms : 0),
      }))
    })
  }

  enqueue(...behaviors: RendererBehavior[]): void {
    this.#behaviors.push(...behaviors)
  }
}

class ScriptedGateway implements ModelGateway {
  readonly calls: CompleteRequest[] = []
  readonly #verdicts: ('hit' | 'miss')[]

  constructor(verdicts: readonly ('hit' | 'miss')[]) {
    this.#verdicts = [...verdicts]
  }

  async *stream(): AsyncIterable<never> { await Promise.resolve() }

  complete(request: CompleteRequest): Promise<{readonly text: string}> {
    const verdict = this.#verdicts.shift()
    if (verdict === undefined) return Promise.reject(new Error('unexpected gateway call'))
    this.calls.push(request)
    return Promise.resolve({
      text: verdict === 'hit'
        ? '{"hit":true,"observation":"猫进入了沙发区域"}'
        : '{"hit":false,"observation":""}',
    })
  }
}

test('production server/source/shared executors preserve epoch and restart ownership', async () => {
  const server = new NodeDesktopServer({token: TOKEN, closeGraceMs: 100})
  const readiness = await settleWithin('camera composition server start', server.start())
  let renderer: InjectedRenderer | undefined
  const clock = new VirtualClock(100)
  const source = new ChromiumFrameSource({source: 'file', transport: server, clock})
  let mediaSequence = 0
  const mediaStore = new MediaStore(undefined, {idFactory: () => `camera-${++mediaSequence}`})
  try {
    renderer = await connectRenderer(readiness.port)
    await source.start()

    await source.snapshot()
    await source.snapshot()
    await source.restart()
    clock.advanceTo(102.5)
    await source.snapshot()
    clock.advanceTo(105)
    await source.snapshot()
    await source.restart()
    await source.snapshot()
    clock.advanceTo(105 + (MAX_CAMERA_POSITION_MS / 1_000))
    await source.snapshot()
    assert.deepEqual(renderer.trace.slice(0, 6).map(item => item.positionMs), [
      0, 0, 2_500, 5_000, 0, MAX_CAMERA_POSITION_MS,
    ])

    const camResult = await new CamAdapter(source, mediaStore).dispatch(
      'snapshot', {}, executorContext(clock),
    )
    assert.equal(camResult.outcome, 'ok')
    const camRef = camResult.content.media_ref
    assertString(camRef)
    const camEntry = mediaStore.peek(camRef)
    assert.ok(camEntry)
    assert.equal(camEntry.digest, camResult.content.digest)
    assert.deepEqual(camEntry.payload, jpegFor(MAX_CAMERA_POSITION_MS))

    await source.restart()
    clock.advanceTo(clock.now() + 10)
    const watchGateway = new ScriptedGateway(['miss', 'hit'])
    const watch = new WatchAdapter({
      manifest: WATCH_MANIFEST,
      source,
      gateway: watchGateway,
      mediaStore,
      model: 'camera-composition-model',
      captureEnabled: true,
    })
    const beforeWatch = renderer.trace.length
    const watchStartedAt = clock.now()
    const watchRun = watch.dispatch('start', {
      condition: '猫进入沙发区域', interval_s: 2, duration_s: 30,
    }, executorContext(clock))
    await waitUntil('watch first injected sample',
      () => watchGateway.calls.length === 1 && clock.waiterCount() === 1)
    clock.advanceTo(watchStartedAt + 2)
    await waitUntil('watch second injected sample',
      () => watchGateway.calls.length === 2 && clock.waiterCount() === 1)
    clock.advanceTo(watchStartedAt + 30)
    const watchResult = await settleWithin('watch injected window', watchRun)
    assert.equal(watchResult.content.reason, 'window_elapsed')
    assert.deepEqual(renderer.trace.slice(beforeWatch).map(item => item.positionMs), [10_000, 12_000])
    assertGatewayImages(watchGateway.calls)

    let guardRestarts = 0
    const guardGateway = new ScriptedGateway(['hit'])
    const observations: Parameters<NonNullable<ExecutorDispatchContext['observe']>>[0][] = []
    const guard = new WatchAdapter({
      manifest: GUARD_MANIFEST,
      source,
      gateway: guardGateway,
      mediaStore,
      model: 'camera-composition-model',
      captureEnabled: true,
      prepareObservation: async () => {
        guardRestarts += 1
        await source.restart()
      },
    })
    const beforeGuard = renderer.trace.length
    const guardStartedAt = clock.now()
    const guardRun = guard.dispatch('start', {
      condition: '猫进入沙发区域', interval_s: 2, duration_s: 30,
    }, executorContext(clock, observations))
    await waitUntil('guard injected sample',
      () => guardGateway.calls.length === 1 && clock.waiterCount() === 1)
    clock.advanceTo(guardStartedAt + 30)
    await settleWithin('guard injected window', guardRun)
    assert.equal(guardRestarts, 1)
    assert.equal(renderer.trace[beforeGuard]?.positionMs, 0)
    const hit = observations.find(item => item.content.state === 'hit')
    assert.ok(hit)
    const guardRef = hit.content.media_ref
    assertString(guardRef)
    const guardEntry = mediaStore.peek(guardRef)
    assert.ok(guardEntry)
    assert.deepEqual(guardEntry.payload, guardGateway.calls[0]?.images?.[0]?.payload)

    renderer.enqueue('error', 'ok', 'error', 'error', 'error')
    const recoveryGateway = new ScriptedGateway(['miss'])
    const recovery = new WatchAdapter({
      manifest: WATCH_MANIFEST,
      source,
      gateway: recoveryGateway,
      mediaStore,
      model: 'camera-composition-model',
      captureEnabled: true,
    })
    const beforeRecovery = renderer.trace.length
    const recoveryRun = recovery.dispatch('start', {
      condition: '猫进入沙发区域', interval_s: 2, duration_s: 30,
    }, executorContext(clock))
    for (let interval = 0; interval < 4; interval += 1) {
      await waitUntil(`watch recovery pause ${interval}`, () => clock.waiterCount() === 1)
      clock.advanceTo(clock.now() + 2)
    }
    const recoveryResult = await settleWithin('watch injected recovery', recoveryRun)
    assert.equal(recoveryResult.outcome, 'unknown')
    assert.equal(recoveryResult.content.error, 'capture_unavailable')
    assert.equal(renderer.trace.slice(beforeRecovery).length, 5)
    assert.equal(recoveryGateway.calls.length, 1)
  } finally {
    await closeRenderer(renderer)
    await settleWithin('camera composition source stop', source.stop())
    await settleWithin('camera composition server close', server.close())
  }
})

test('injected renderer failures reject only their request and fresh generations recover', async () => {
  const timer = new ControlledTimer()
  const server = new NodeDesktopServer({token: TOKEN, closeGraceMs: 100, cameraTimer: timer})
  const readiness = await settleWithin('failure composition server start', server.start())
  const source = new ChromiumFrameSource({
    source: 'file', transport: server, clock: new VirtualClock(),
  })
  let renderer: InjectedRenderer | undefined
  try {
    await source.start()
    for (const behavior of ['error', 'wrong_id', 'malformed', 'oversized', 'disconnect'] as const) {
      renderer = await connectRenderer(readiness.port)
      renderer.enqueue(behavior)
      await assertSafeCameraFailure(`${behavior} capture`, source.snapshot())
      await closeRenderer(renderer)
      renderer = await connectRenderer(readiness.port)
      await settleWithin(`${behavior} recovery capture`, source.snapshot())
      await closeRenderer(renderer)
      renderer = undefined
      assert.equal(timer.activeCount, 0)
    }

    renderer = await connectRenderer(readiness.port)
    renderer.enqueue('drop')
    const timedOut = source.snapshot()
    await waitUntil('timeout request issued', () => renderer!.trace.length === 1)
    timer.fireOldest()
    await assertSafeCameraFailure('timeout capture', timedOut)
    await settleWithin('post-timeout capture', source.snapshot())
    assert.equal(timer.activeCount, 0)

    renderer.enqueue('drop')
    const pending = source.snapshot()
    await waitUntil('shutdown request issued', () => renderer!.trace.length === 3)
    await settleWithin('failure composition server close', server.close())
    await assertSafeCameraFailure('shutdown capture', pending)
    await settleWithin('failure composition source stop', source.stop())
    await settleWithin('failure composition repeated source stop', source.stop())
    await settleWithin('failure composition repeated server close', server.close())
    assert.equal(timer.activeCount, 0)
  } finally {
    await closeRenderer(renderer)
    await settleWithin('failure composition source cleanup', source.stop())
    await settleWithin('failure composition server cleanup', server.close())
  }
})

function jpegFor(positionMs: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, positionMs % 251, 0xff, 0xd9])
}

function rawText(data: RawData): string {
  return Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString('utf8')
}

async function connectRenderer(port: number): Promise<InjectedRenderer> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`)
  await settleWithin('injected renderer socket open', new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  }))
  const bootstrap = nextTextFrames(socket, 2)
  socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
  await settleWithin('injected renderer authentication', bootstrap)
  return new InjectedRenderer(socket)
}

function nextTextFrames(socket: WebSocket, count: number): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    const frames: string[] = []
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) return
      frames.push(rawText(data))
      if (frames.length === count) {
        cleanup()
        resolve(frames)
      }
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('injected renderer closed before authentication'))
    }
    const cleanup = (): void => {
      socket.off('message', onMessage)
      socket.off('close', onClose)
    }
    socket.on('message', onMessage)
    socket.once('close', onClose)
  })
}

async function closeRenderer(renderer: InjectedRenderer | undefined): Promise<void> {
  if (renderer === undefined || renderer.socket.readyState === WebSocket.CLOSED) return
  const closed = new Promise<void>(resolve => renderer.socket.once('close', () => resolve()))
  if (renderer.socket.readyState < WebSocket.CLOSING) renderer.socket.close(1000)
  await settleWithin('injected renderer close', closed).catch(() => renderer.socket.terminate())
}

function executorContext(
  clock: VirtualClock,
  observations: Parameters<NonNullable<ExecutorDispatchContext['observe']>>[0][] = [],
): ExecutorDispatchContext {
  return {
    clock,
    delegate: {} as ExecutorDispatchContext['delegate'],
    signal: new AbortController().signal,
    progress: () => undefined,
    observe: observation => { observations.push(observation) },
  }
}

function assertGatewayImages(calls: readonly CompleteRequest[]): void {
  assert.ok(calls.length > 0)
  for (const call of calls) {
    assert.equal(call.images?.length, 1)
    assert.equal(call.images?.[0]?.ref, 'watch-frame')
    assert.equal(call.images?.[0]?.media_type, 'image/jpeg')
    assert.ok(call.images?.[0]?.payload instanceof Uint8Array)
  }
}

function assertString(value: unknown): asserts value is string {
  assert.equal(typeof value, 'string')
}

async function assertSafeCameraFailure(label: string, capture: Promise<unknown>): Promise<void> {
  await assert.rejects(settleWithin(label, capture), error => {
    assert.ok(error instanceof CameraError)
    assert.equal(String(error), 'CameraError: camera capture is unavailable')
    return true
  })
}

async function waitUntil(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + SETTLE_MS
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.fail(`${label} did not settle in time`)
}

function settleWithin<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle in time`)), SETTLE_MS)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}
