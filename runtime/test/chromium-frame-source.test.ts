import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {ExecutorDispatchContext} from '../src/causal-runtime.js'
import type {Clock} from '../src/clock.js'
import {
  CAMERA_HEIGHT,
  CAMERA_WIDTH,
  MAX_CAMERA_POSITION_MS,
} from '../src/desktop-camera.js'
import {
  DesktopCameraError,
  type CameraCaptureRequest,
  type CameraCaptureTransport,
  type CapturedCameraFrame,
} from '../src/desktop.js'
import {CamAdapter, CameraError} from '../src/executors/camera.js'
import {
  ChromiumFrameSource,
  isFileBackedChromiumFrameSource,
} from '../src/executors/chromium-frame-source.js'
import {MediaStore} from '../src/media-store.js'

const JPEG = new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9])

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

async function settleNamed<T>(name: string, promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
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

class MutableClock implements Clock {
  current: number

  constructor(start = 0) { this.current = start }

  now(): number { return this.current }

  sleep(): Promise<void> { return Promise.resolve() }
}

class RecordingCameraTransport implements CameraCaptureTransport {
  readonly calls: CameraCaptureRequest[] = []
  handler: (request: CameraCaptureRequest) => Promise<CapturedCameraFrame>

  constructor(handler: (
    request: CameraCaptureRequest,
  ) => Promise<CapturedCameraFrame> = () => Promise.resolve(validFrame())) {
    this.handler = handler
  }

  captureCamera(request: CameraCaptureRequest): Promise<CapturedCameraFrame> {
    this.calls.push({...request})
    return this.handler(request)
  }
}

function validFrame(payload = JPEG): CapturedCameraFrame {
  return {
    payload,
    media_type: 'image/jpeg',
    width: CAMERA_WIDTH,
    height: CAMERA_HEIGHT,
  }
}

test('local Chromium source is lazy, lifecycle-bound, copying, and timestamps after capture', async () => {
  const capture = deferred<CapturedCameraFrame>()
  const transport = new RecordingCameraTransport(() => capture.promise)
  const clock = new MutableClock(10)
  const source = new ChromiumFrameSource({source: 'local', transport, clock})

  await assert.rejects(source.snapshot(), CameraError)
  await assert.rejects(source.restart(), CameraError)
  await settleNamed('overlapping lazy starts', Promise.all([source.start(), source.start()]))
  assert.deepEqual(transport.calls, [], 'start does not require a renderer or capture')
  assert.equal(isFileBackedChromiumFrameSource(source), false)

  const snapshot = source.snapshot()
  await Promise.resolve()
  assert.deepEqual(transport.calls, [{source: 'local'}])
  clock.current = 11.25
  capture.resolve(validFrame())
  const frame = await settleNamed('deferred local capture', snapshot)
  JPEG[2] = 0x7f
  try {
    assert.deepEqual(frame.payload, new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9]))
  } finally {
    JPEG[2] = 0x01
  }
  assert.equal(frame.media_type, 'image/jpeg')
  assert.equal(frame.width, CAMERA_WIDTH)
  assert.equal(frame.height, CAMERA_HEIGHT)
  assert.equal(frame.captured_at, 11.25)

  await settleNamed('local restart no-op', source.restart())
  assert.equal(transport.calls.length, 1)
  await settleNamed('repeated local stops', Promise.all([source.stop(), source.stop()]))
  await assert.rejects(source.snapshot(), CameraError)
  assert.equal(transport.calls.length, 1)
})

test('expected desktop capture failure becomes fresh safe CameraError and Cam unavailable', async () => {
  for (const code of ['capture_unavailable', 'invalid_request'] as const) {
    const transportFailure = new DesktopCameraError(code)
    const transport = new RecordingCameraTransport(() => Promise.reject(transportFailure))
    const source = new ChromiumFrameSource({
      source: 'local', transport, clock: new MutableClock(),
    })
    await source.start()

    let mapped: unknown
    try {
      await source.snapshot()
    } catch (error) {
      mapped = error
    }
    assert.ok(mapped instanceof CameraError)
    assert.notEqual(mapped, transportFailure)
    assert.equal(String(mapped), 'CameraError: camera capture is unavailable')

    const handoff = await new CamAdapter(source, new MediaStore()).dispatch(
      'snapshot', {}, {} as ExecutorDispatchContext,
    )
    assert.equal(handoff.outcome, 'unknown')
    assert.equal(handoff.content.error, 'capture_unavailable')
  }
})

test('malformed transport frames and impossible clocks remain programming defects', async () => {
  const malformed: readonly unknown[] = [
    {...validFrame(), payload: [1, 2, 3]},
    {...validFrame(), media_type: 'image/png'},
    {...validFrame(), width: CAMERA_WIDTH - 1},
    {...validFrame(), height: CAMERA_HEIGHT - 1},
  ]
  for (const response of malformed) {
    const source = new ChromiumFrameSource({
      source: 'local',
      transport: new RecordingCameraTransport(
        () => Promise.resolve(response as CapturedCameraFrame),
      ),
      clock: new MutableClock(),
    })
    await source.start()
    await assert.rejects(source.snapshot(), error => !(error instanceof CameraError))
    const handoff = await new CamAdapter(source, new MediaStore()).dispatch(
      'snapshot', {}, {} as ExecutorDispatchContext,
    )
    assert.equal(handoff.content.error, 'adapter_exception')
  }

  const clock = new MutableClock(Number.NaN)
  const source = new ChromiumFrameSource({
    source: 'file', transport: new RecordingCameraTransport(), clock,
  })
  await source.start()
  await assert.rejects(source.restart(), error => !(error instanceof CameraError))
})

test('an unexpected transport rejection remains the exact programming failure', async () => {
  const defect = new Error('programming-defect-sentinel')
  const source = new ChromiumFrameSource({
    source: 'local',
    transport: new RecordingCameraTransport(() => Promise.reject(defect)),
    clock: new MutableClock(),
  })
  await source.start()
  await assert.rejects(source.snapshot(), error => error === defect)
  const handoff = await new CamAdapter(source, new MediaStore()).dispatch(
    'snapshot', {}, {} as ExecutorDispatchContext,
  )
  assert.equal(handoff.content.error, 'adapter_exception')
})

test('file Chromium source holds frame zero until restart and computes a bounded floor position', async () => {
  const clock = new MutableClock(0)
  const transport = new RecordingCameraTransport()
  const source = new ChromiumFrameSource({source: 'file', transport, clock})
  assert.equal(isFileBackedChromiumFrameSource(source), true)
  await source.start()

  await source.snapshot()
  clock.current = 45
  await source.snapshot()
  assert.deepEqual(transport.calls, [
    {source: 'file', positionMs: 0},
    {source: 'file', positionMs: 0},
  ])

  transport.calls.length = 0
  clock.current = 100
  await source.restart()
  assert.deepEqual(transport.calls, [], 'restart does not ask the renderer to capture')
  await source.snapshot()
  clock.current = 110.999
  await source.snapshot()
  clock.current = 90
  await source.snapshot()
  clock.current = 100 + (MAX_CAMERA_POSITION_MS / 1000) + 100
  await source.snapshot()
  assert.deepEqual(transport.calls, [
    {source: 'file', positionMs: 0},
    {source: 'file', positionMs: 10_999},
    {source: 'file', positionMs: 0},
    {source: 'file', positionMs: MAX_CAMERA_POSITION_MS},
  ])
})

test('snapshot, restart, and stop serialize without half-committed file epochs', async () => {
  const firstCapture = deferred<CapturedCameraFrame>()
  const clock = new MutableClock(1)
  let captures = 0
  const transport = new RecordingCameraTransport(() => {
    captures += 1
    return captures === 1 ? firstCapture.promise : Promise.resolve(validFrame())
  })
  const source = new ChromiumFrameSource({source: 'file', transport, clock})
  await source.start()

  const beforeRestart = source.snapshot()
  const restarting = source.restart()
  const afterRestart = source.snapshot()
  await Promise.resolve()
  assert.deepEqual(transport.calls, [{source: 'file', positionMs: 0}])
  clock.current = 20
  firstCapture.resolve(validFrame())
  await settleNamed('serialized snapshot restart snapshot', Promise.all([
    beforeRestart, restarting, afterRestart,
  ]))
  assert.deepEqual(transport.calls, [
    {source: 'file', positionMs: 0},
    {source: 'file', positionMs: 0},
  ])

  const held = deferred<CapturedCameraFrame>()
  transport.handler = () => held.promise
  const inFlight = source.snapshot()
  const stopping = source.stop()
  const afterStop = source.snapshot()
  await Promise.resolve()
  const callsBeforeSettle = transport.calls.length
  held.resolve(validFrame())
  await settleNamed('stop waits for capture', Promise.all([inFlight, stopping]))
  await assert.rejects(afterStop, CameraError)
  assert.equal(transport.calls.length, callsBeforeSettle)

  transport.handler = () => Promise.resolve(validFrame())
  await settleNamed('restartable source lifecycle', Promise.all([source.start(), source.start()]))
  await source.snapshot()
  await source.stop()
})

test('queued start then stop has deterministic call-order linearization', async () => {
  const transport = new RecordingCameraTransport()
  const source = new ChromiumFrameSource({
    source: 'local', transport, clock: new MutableClock(),
  })
  await settleNamed('start then stop', Promise.all([source.start(), source.stop()]))
  await assert.rejects(source.snapshot(), CameraError)
  assert.deepEqual(transport.calls, [])

  await source.start()
  await source.snapshot()
  assert.deepEqual(transport.calls, [{source: 'local'}])
})
