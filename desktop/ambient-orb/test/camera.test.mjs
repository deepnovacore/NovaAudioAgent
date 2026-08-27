import assert from 'node:assert/strict'
import test from 'node:test'

import * as cameraModule from '../src/renderer/camera.mjs'
import {
  CAMERA_FILE_URL,
  CAMERA_FINAL_FRAME_EPSILON_SECONDS,
  CAMERA_FRAME_MAGIC,
  CAMERA_HEIGHT,
  CAMERA_JPEG_QUALITY,
  CAMERA_WIDTH,
  MAX_CAMERA_JPEG_BYTES,
  MAX_CAMERA_POSITION_MS,
  RendererCameraController,
  cameraUnavailableMessage,
  classifyCameraCaptureText,
  encodeCameraFrame,
  parseCameraCapture,
} from '../src/renderer/camera.mjs'

const {RendererCameraToggle} = cameraModule

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const jpeg = new Uint8Array([0xff, 0xd8, 0x12, 0x34, 0xff, 0xd9])

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return {promise, resolve, reject}
}

async function settleWithin(promise, name = 'camera operation', timeoutMs = 1_000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not settle`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function makeDelivery(generation = Object.freeze({})) {
  const response = deferred()
  const sent = []
  let current = true
  return {
    delivery: {
      generation,
      isCurrent: () => current,
      sendText: value => {
        sent.push(value)
        response.resolve({kind: 'text', value})
      },
      sendBinary: value => {
        sent.push(value)
        response.resolve({kind: 'binary', value})
      },
    },
    response,
    sent,
    close: () => { current = false },
  }
}

function makeLocalHarness(overrides = {}) {
  const calls = {
    constraints: [], captures: [], canvases: [], draws: [], conversions: [], bitmapCloses: 0,
  }
  const track = {readyState: 'live', stops: 0, stop() { this.stops += 1 }}
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  }
  const bitmap = {close: () => { calls.bitmapCloses += 1 }}
  const blob = {
    type: 'image/jpeg',
    size: jpeg.byteLength,
    arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength),
  }
  const mediaDevices = {
    async getUserMedia(constraints) {
      calls.constraints.push(constraints)
      if (overrides.getUserMedia) return overrides.getUserMedia(constraints)
      return stream
    },
  }
  class ImageCapture {
    constructor(nextTrack) {
      if (overrides.imageCaptureConstructor) return overrides.imageCaptureConstructor(nextTrack)
      calls.captures.push(nextTrack)
    }

    async grabFrame() {
      if (overrides.grabFrame) return overrides.grabFrame()
      return bitmap
    }
  }
  class OffscreenCanvas {
    constructor(width, height) {
      calls.canvases.push([width, height])
    }

    getContext(kind) {
      if (overrides.getContext) return overrides.getContext(kind)
      return {
        drawImage: (...args) => {
          calls.draws.push(args)
          if (overrides.drawImage) return overrides.drawImage(...args)
        },
      }
    }

    async convertToBlob(options) {
      calls.conversions.push(options)
      if (overrides.convertToBlob) return overrides.convertToBlob(options)
      return overrides.blob ?? blob
    }
  }
  return {calls, track, stream, bitmap, blob, mediaDevices, ImageCapture, OffscreenCanvas}
}

async function makeController(options, sourceMode = 'local') {
  const controller = new RendererCameraController(options)
  controller.setSourceMode(sourceMode)
  if (sourceMode === 'local') await controller.enableLocal()
  return controller
}

function localRequest(id = 'camera-local') {
  return JSON.stringify({type: 'camera.capture', request_id: id, source: 'local'})
}

function makeFakeVideo({
  duration = 10,
  metadata = 'success',
  decode = 'success',
  seek = 'success',
  readyAfterSeek = 2,
} = {}) {
  const listeners = new Map()
  const video = {
    preload: '',
    muted: false,
    playsInline: false,
    src: '',
    duration,
    readyState: 0,
    paused: true,
    loadCalls: 0,
    pauseCalls: 0,
    playCalls: 0,
    removeSourceCalls: 0,
    seeks: [],
    _currentTime: 0,
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? new Set()
      values.add(listener)
      listeners.set(type, values)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({type})
    },
    load() {
      this.loadCalls += 1
      if (metadata === 'success' && this.src) queueMicrotask(() => {
        this.readyState = 1
        this.dispatch('loadedmetadata')
        setImmediate(() => {
          if (decode === 'success') {
            this.readyState = 2
            this.dispatch('loadeddata')
          }
          if (decode === 'error') this.dispatch('error')
        })
      })
      if (metadata === 'error' && this.src) queueMicrotask(() => this.dispatch('error'))
    },
    pause() { this.pauseCalls += 1; this.paused = true },
    play() { this.playCalls += 1; this.paused = false },
    removeAttribute(name) {
      if (name === 'src') {
        this.removeSourceCalls += 1
        this.src = ''
      }
    },
    listenerCount() {
      return [...listeners.values()].reduce((sum, values) => sum + values.size, 0)
    },
  }
  Object.defineProperty(video, 'currentTime', {
    get() { return this._currentTime },
    set(value) {
      this._currentTime = value
      this.seeks.push(value)
      if (seek === 'success') queueMicrotask(() => {
        this.readyState = readyAfterSeek
        this.dispatch('seeked')
      })
      if (seek === 'error') queueMicrotask(() => this.dispatch('error'))
    },
  })
  return video
}

function fileRequest(positionMs, id = `camera-file-${positionMs}`) {
  return JSON.stringify({
    type: 'camera.capture', request_id: id, source: 'file', position_ms: positionMs,
  })
}

function decodeGoldenFrame(wire) {
  assert.ok(wire instanceof Uint8Array)
  assert.deepEqual(wire.subarray(0, 8), CAMERA_FRAME_MAGIC)
  const headerLength = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
    .getUint16(8, false)
  const header = decoder.decode(wire.subarray(10, 10 + headerLength))
  return {headerLength, header, jpeg: wire.subarray(10 + headerLength)}
}

test('camera renderer constants and frame bytes match the independent v1 golden', () => {
  assert.equal(CAMERA_FILE_URL, 'nova://orb/camera-source')
  assert.equal(CAMERA_WIDTH, 1280)
  assert.equal(CAMERA_HEIGHT, 720)
  assert.equal(CAMERA_JPEG_QUALITY, 0.8)
  assert.deepEqual(
    CAMERA_FRAME_MAGIC,
    new Uint8Array([0x4e, 0x56, 0x43, 0x41, 0x4d, 0x01, 0x0d, 0x0a]),
  )

  const wire = encodeCameraFrame({requestId: 'camera-17', jpeg})
  const decoded = decodeGoldenFrame(wire)
  const header = '{"type":"camera.frame","request_id":"camera-17","media_type":"image/jpeg","width":1280,"height":720}'
  assert.equal(decoded.headerLength, encoder.encode(header).byteLength)
  assert.equal(decoded.header, header)
  assert.deepEqual(decoded.jpeg, jpeg)
  assert.equal(wire.byteLength, 10 + encoder.encode(header).byteLength + jpeg.byteLength)

  jpeg[2] = 0x99
  assert.equal(decoded.jpeg[2], 0x12, 'wire owns a copy of the caller JPEG')
})

test('strict camera capture parsing accepts and freezes only exact local/file requests', () => {
  assert.deepEqual(
    parseCameraCapture('{"type":"camera.capture","request_id":"camera-local_1","source":"local"}'),
    {type: 'camera.capture', request_id: 'camera-local_1', source: 'local'},
  )
  const file = parseCameraCapture(' { "position_ms" : 2500, "source" : "file", "request_id" : "camera-file-1", "type" : "camera.capture" } ')
  assert.deepEqual(file, {
    type: 'camera.capture', request_id: 'camera-file-1', source: 'file', position_ms: 2500,
  })
  assert.ok(Object.isFrozen(file))
  assert.equal(parseCameraCapture('{"type":"camera.capture","request_id":"camera-x","source":"file","position_ms":1.0}'), null)
})

test('strict camera capture parsing rejects the complete malformed grammar matrix', () => {
  const invalid = [
    '', 'null', '[]', '{}',
    '{"type":"camera.capture","request_id":"camera-x","source":"local","extra":true}',
    '{"type":"camera.capture","request_id":"camera-x","source":"local","position_ms":0}',
    '{"type":"camera.capture","request_id":"camera-x","source":"file"}',
    '{"type":"camera.capture","request_id":"camera-x","source":"file","position_ms":-1}',
    '{"type":"camera.capture","request_id":"camera-x","source":"file","position_ms":1.5}',
    '{"type":"camera.capture","request_id":"camera-x","source":"file","position_ms":1e3}',
    `{"type":"camera.capture","request_id":"camera-x","source":"file","position_ms":${MAX_CAMERA_POSITION_MS + 1}}`,
    '{"type":"camera.capture","request_id":"","source":"local"}',
    '{"type":"camera.capture","request_id":"camera-é","source":"local"}',
    `{"type":"camera.capture","request_id":"camera-${'a'.repeat(58)}","source":"local"}`,
    '{"type":"camera.capture","request_id":"camera-x","request_id":"camera-y","source":"local"}',
    '{"type":"camera.capture","request_id":"camera-x","source":"local","source":"file"}',
  ]
  for (const raw of invalid) assert.equal(parseCameraCapture(raw), null, raw)
  assert.deepEqual(
    parseCameraCapture(`{"type":"camera.capture","request_id":"camera-x","source":"file","position_ms":${MAX_CAMERA_POSITION_MS}}`),
    {type: 'camera.capture', request_id: 'camera-x', source: 'file', position_ms: MAX_CAMERA_POSITION_MS},
  )
})

test('camera text classification contains every top-level camera intent without last-key wins', () => {
  const valid = classifyCameraCaptureText(localRequest('camera-classified'))
  assert.equal(valid.kind, 'valid')
  assert.deepEqual(valid.request, {
    type: 'camera.capture', request_id: 'camera-classified', source: 'local',
  })

  const attacks = [
    '{"type":"camera.capture","type":"playback.clear","request_id":"camera-dupe-a","source":"local"}',
    '{"type":"playback.clear","type":"camera.capture","request_id":"camera-dupe-b","source":"local"}',
    '{"type":"camera.capture","request_id":"camera-extra","source":"local","path":"/Users/sentinel"}',
    '{"type":"camera.capture","request_id":"camera-missing"}',
    '{"type":"camera.capture","request_id":"camera-float","source":"file","position_ms":1.0}',
    '{"type":"camera.capture","request_id":"camera-truncated"',
  ]
  for (const raw of attacks) {
    const classified = classifyCameraCaptureText(raw)
    assert.equal(classified.kind, 'malformed', raw)
    assert.match(classified.requestId ?? '', /^camera-/u)
  }
  assert.deepEqual(
    classifyCameraCaptureText('{"type":"playback.clear","utterance_id":"u","generation_epoch":1}'),
    {kind: 'other'},
  )
})

test('camera framing rejects invalid ids and JPEG boundaries', () => {
  const maximumId = `camera-${'a'.repeat(57)}`
  assert.equal(encoder.encode(maximumId).byteLength, 64)
  assert.doesNotThrow(() => encodeCameraFrame({requestId: maximumId, jpeg}))
  const maximumJpeg = new Uint8Array(MAX_CAMERA_JPEG_BYTES)
  maximumJpeg.set([0xff, 0xd8])
  maximumJpeg.set([0xff, 0xd9], maximumJpeg.byteLength - 2)
  assert.doesNotThrow(() => encodeCameraFrame({requestId: 'camera-max', jpeg: maximumJpeg}))
  const oversizedJpeg = new Uint8Array(MAX_CAMERA_JPEG_BYTES + 1)
  oversizedJpeg.set([0xff, 0xd8])
  oversizedJpeg.set([0xff, 0xd9], oversizedJpeg.byteLength - 2)
  const invalidJpegs = [
    undefined,
    new Uint8Array(),
    new Uint8Array([0xff, 0xd8, 0xff]),
    new Uint8Array([0, 0xd8, 0, 0xff, 0xd9]),
    new Uint8Array([0xff, 0xd8, 0, 0, 0]),
    oversizedJpeg,
  ]
  for (const candidate of invalidJpegs) {
    assert.throws(() => encodeCameraFrame({requestId: 'camera-x', jpeg: candidate}))
  }
  assert.throws(() => encodeCameraFrame({requestId: 'camera-é', jpeg}))
})

test('camera unavailable response is compact, ordered, and leak-free', () => {
  assert.equal(
    cameraUnavailableMessage('camera-17'),
    '{"type":"camera.error","request_id":"camera-17","error":"capture_unavailable"}',
  )
  const text = cameraUnavailableMessage('camera-path-sentinel')
  assert.doesNotMatch(text, /device|DOMException|nova:\/\/|credential|\/Users\//u)
})

test('local camera starts privacy-gated and rejects capture without touching the device', async () => {
  const harness = makeLocalHarness()
  const controller = new RendererCameraController(harness)
  controller.setSourceMode('local')
  const response = makeDelivery()

  controller.enqueue(localRequest('camera-disabled'), response.delivery)

  assert.equal(
    (await settleWithin(response.response.promise, 'disabled local camera')).value,
    cameraUnavailableMessage('camera-disabled'),
  )
  assert.deepEqual(harness.calls.constraints, [])
  assert.deepEqual(harness.calls.captures, [])
  controller.dispose()
})

test('explicit enable acquires once and disable releases the device and hard-gates later capture', async () => {
  const harness = makeLocalHarness()
  const controller = new RendererCameraController(harness)
  controller.setSourceMode('local')

  assert.equal(await controller.enableLocal(), true)
  assert.deepEqual(harness.calls.constraints, [{video: true, audio: false}])
  assert.deepEqual(harness.calls.captures, [harness.track])

  const enabled = makeDelivery()
  controller.enqueue(localRequest('camera-enabled'), enabled.delivery)
  assert.equal((await settleWithin(enabled.response.promise, 'enabled local camera')).kind, 'binary')
  assert.equal(harness.calls.constraints.length, 1, 'capture reuses the explicitly acquired stream')

  controller.disableLocal()
  assert.equal(harness.track.stops, 1)

  const disabled = makeDelivery(enabled.delivery.generation)
  controller.enqueue(localRequest('camera-disabled-again'), disabled.delivery)
  assert.equal(
    (await settleWithin(disabled.response.promise, 'disabled camera after use')).value,
    cameraUnavailableMessage('camera-disabled-again'),
  )
  assert.equal(harness.calls.constraints.length, 1, 'disabled capture never reacquires the device')
  controller.dispose()
  assert.equal(harness.track.stops, 1)
})

test('failed explicit enable leaves local capture disabled and releases an unusable stream', async () => {
  const badTrack = {readyState: 'ended', stops: 0, stop() { this.stops += 1 }}
  const badStream = {getVideoTracks: () => [badTrack], getTracks: () => [badTrack]}
  const harness = makeLocalHarness({getUserMedia: async () => badStream})
  const controller = new RendererCameraController(harness)
  controller.setSourceMode('local')

  assert.equal(await controller.enableLocal(), false)
  assert.equal(badTrack.stops, 1)

  const response = makeDelivery()
  controller.enqueue(localRequest('camera-after-denial'), response.delivery)
  assert.equal(
    (await settleWithin(response.response.promise, 'capture after failed enable')).value,
    cameraUnavailableMessage('camera-after-denial'),
  )
  assert.equal(harness.calls.constraints.length, 1, 'failed enable is not retried by a host request')
  controller.dispose()
})

test('camera toggle asks on the user action, enables the real controller, and releases on off', async () => {
  assert.equal(typeof RendererCameraToggle, 'function')
  const harness = makeLocalHarness()
  const controller = new RendererCameraController(harness)
  controller.setSourceMode('local')
  const states = []
  let permissionRequests = 0
  const toggle = new RendererCameraToggle({
    cameraController: controller,
    requestPermission: async () => {
      permissionRequests += 1
      return {status: 'granted'}
    },
    onState: state => states.push(state),
  })

  assert.equal(toggle.state, 'off')
  assert.equal(await toggle.toggle(), 'on')
  assert.equal(permissionRequests, 1)
  assert.deepEqual(harness.calls.constraints, [{video: true, audio: false}])
  assert.deepEqual(states, ['requesting', 'on'])

  assert.equal(await toggle.toggle(), 'off')
  assert.equal(harness.track.stops, 1)
  assert.equal(permissionRequests, 1, 'turning off never asks for permission')
  assert.deepEqual(states, ['requesting', 'on', 'off'])
  controller.dispose()
})

test('camera toggle keeps the hard gate closed when system permission is denied', async () => {
  assert.equal(typeof RendererCameraToggle, 'function')
  const harness = makeLocalHarness()
  const controller = new RendererCameraController(harness)
  controller.setSourceMode('local')
  const toggle = new RendererCameraToggle({
    cameraController: controller,
    requestPermission: async () => ({status: 'denied'}),
  })

  assert.equal(await toggle.toggle(), 'denied')
  assert.deepEqual(harness.calls.constraints, [])
  const response = makeDelivery()
  controller.enqueue(localRequest('camera-denied'), response.delivery)
  assert.equal(
    (await settleWithin(response.response.promise, 'denied camera capture')).value,
    cameraUnavailableMessage('camera-denied'),
  )
  controller.dispose()
})

test('bootstrap source mode catches both mismatch directions before media or canvas work', async () => {
  for (const [allowed, requested] of [['file', 'local'], ['local', 'file']]) {
    const harness = makeLocalHarness()
    let videoCalls = 0
    const controller = new RendererCameraController({
      ...harness,
      createVideo: () => { videoCalls += 1; return makeFakeVideo() },
    })
    assert.equal(typeof controller.setSourceMode, 'function')
    controller.setSourceMode(allowed)
    const response = makeDelivery()
    const request = requested === 'local'
      ? localRequest(`camera-mismatch-${allowed}`)
      : fileRequest(0, `camera-mismatch-${allowed}`)
    controller.enqueue(request, response.delivery)
    const outbound = await settleWithin(response.response.promise, `${allowed}/${requested} mismatch`)

    assert.equal(outbound.kind, 'text')
    assert.equal(outbound.value, cameraUnavailableMessage(`camera-mismatch-${allowed}`))
    assert.deepEqual(harness.calls.constraints, [], `${allowed}/${requested}: no getUserMedia`)
    assert.deepEqual(harness.calls.captures, [], `${allowed}/${requested}: no ImageCapture`)
    assert.deepEqual(harness.calls.canvases, [], `${allowed}/${requested}: no canvas`)
    assert.equal(videoCalls, 0, `${allowed}/${requested}: no video element`)
    controller.dispose()
  }

  const harness = makeLocalHarness()
  const controller = new RendererCameraController(harness)
  const response = makeDelivery()
  controller.enqueue(localRequest('camera-mode-unset'), response.delivery)
  assert.equal(
    (await settleWithin(response.response.promise, 'unset mode rejection')).value,
    cameraUnavailableMessage('camera-mode-unset'),
  )
  assert.deepEqual(harness.calls.constraints, [])
  assert.deepEqual(harness.calls.canvases, [])
  controller.dispose()
})

test('bootstrap source mode is immutable and matching local/file requests still capture', async () => {
  for (const sourceMode of ['local', 'file']) {
    const harness = makeLocalHarness()
    const video = makeFakeVideo()
    const controller = new RendererCameraController({ ...harness, createVideo: () => video })
    assert.throws(() => controller.setSourceMode('invalid'), /camera source mode/u)
    controller.setSourceMode(sourceMode)
    assert.throws(() => controller.setSourceMode(sourceMode), /already set/u)
    assert.throws(() => controller.setSourceMode(sourceMode === 'local' ? 'file' : 'local'), /already set/u)
    if (sourceMode === 'local') assert.equal(await controller.enableLocal(), true)

    const response = makeDelivery()
    controller.enqueue(
      sourceMode === 'local'
        ? localRequest('camera-mode-local')
        : fileRequest(0, 'camera-mode-file'),
      response.delivery,
    )
    assert.equal(
      (await settleWithin(response.response.promise, `${sourceMode} matching capture`)).kind,
      'binary',
    )
    controller.dispose()
  }
})

test('explicitly enabled local capture is fixed-size, retained, and closes every owned bitmap/track', async () => {
  const harness = makeLocalHarness()
  const controller = await makeController(harness)
  const first = makeDelivery()

  assert.equal(harness.calls.constraints.length, 1)
  assert.equal(harness.calls.captures.length, 1)
  assert.equal(harness.calls.canvases.length, 0)
  controller.enqueue(localRequest('camera-local-1'), first.delivery)
  const firstResponse = await settleWithin(first.response.promise, 'first local capture')
  assert.equal(firstResponse.kind, 'binary')
  assert.deepEqual(harness.calls.constraints, [{video: true, audio: false}])
  assert.deepEqual(harness.calls.captures, [harness.track])
  assert.deepEqual(harness.calls.canvases, [[1280, 720]])
  assert.deepEqual(harness.calls.draws[0], [harness.bitmap, 0, 0, 1280, 720])
  assert.deepEqual(harness.calls.conversions, [{type: 'image/jpeg', quality: 0.8}])
  assert.equal(harness.calls.bitmapCloses, 1)
  assert.deepEqual(decodeGoldenFrame(firstResponse.value).jpeg, jpeg)

  const second = makeDelivery(first.delivery.generation)
  controller.enqueue(localRequest('camera-local-2'), second.delivery)
  await settleWithin(second.response.promise, 'second local capture')
  assert.equal(harness.calls.constraints.length, 1, 'the retained stream is not reprompted')
  assert.equal(harness.calls.captures.length, 1, 'one ImageCapture belongs to the retained stream')
  assert.equal(harness.calls.bitmapCloses, 2)

  controller.closeGeneration(first.delivery.generation)
  controller.closeGeneration(first.delivery.generation)
  assert.equal(harness.track.stops, 1)
  controller.dispose()
  assert.equal(harness.track.stops, 1)
})

test('local failure stages emit one stable error and never leak the thrown detail', async t => {
  const cases = [
    ['permission', {getUserMedia: async () => { throw new Error('/Users/path-sentinel') }}],
    ['missing track', {getUserMedia: async () => ({getVideoTracks: () => [], getTracks: () => []})}],
    ['image capture constructor', {imageCaptureConstructor: () => { throw new Error('device-sentinel') }}],
    ['grab', {grabFrame: async () => { throw new Error('DOMException credential') }}],
    ['draw', {drawImage: () => { throw new Error('nova://leak') }}],
    ['convert', {convertToBlob: async () => { throw new Error('/private/file') }}],
    ['mime', {blob: {type: 'image/png', size: 6, arrayBuffer: async () => jpeg.buffer}}],
    ['declared size', {blob: {type: 'image/jpeg', size: MAX_CAMERA_JPEG_BYTES + 1, arrayBuffer: async () => jpeg.buffer}}],
    ['array buffer', {blob: {type: 'image/jpeg', size: 6, arrayBuffer: async () => { throw new Error('path-sentinel') }}}],
    ['markers', {blob: {type: 'image/jpeg', size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer}}],
  ]
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const harness = makeLocalHarness(overrides)
      const controller = await makeController(harness)
      const response = makeDelivery()
      controller.enqueue(localRequest(`camera-${name.replaceAll(' ', '-')}`), response.delivery)
      const outbound = await settleWithin(response.response.promise, `${name} failure`)
      assert.equal(outbound.kind, 'text')
      assert.equal(
        outbound.value,
        cameraUnavailableMessage(`camera-${name.replaceAll(' ', '-')}`),
      )
      assert.equal(response.sent.length, 1)
      assert.doesNotMatch(outbound.value, /path|device|DOMException|credential|nova:\/\/|private/u)
      controller.dispose()
    })
  }
})

test('bitmap ownership survives draw and conversion failures', async () => {
  for (const overrides of [
    {drawImage: () => { throw new Error('draw') }},
    {convertToBlob: async () => { throw new Error('convert') }},
  ]) {
    const harness = makeLocalHarness(overrides)
    const controller = await makeController(harness)
    const response = makeDelivery()
    controller.enqueue(localRequest(), response.delivery)
    await settleWithin(response.response.promise, 'owned bitmap failure')
    assert.equal(harness.calls.bitmapCloses, 1)
    controller.dispose()
  }
})

test('an already-resolved bitmap is released exactly once when its generation closes first', async () => {
  const generation = Object.freeze({name: 'bitmap-race'})
  const harness = makeLocalHarness()
  let controller
  harness.ImageCapture.prototype.grabFrame = () => ({
    then(resolve) {
      resolve(harness.bitmap)
      controller.closeGeneration(generation)
    },
  })
  controller = await makeController(harness)
  const response = makeDelivery(generation)
  controller.enqueue(localRequest('camera-bitmap-race'), response.delivery)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(response.sent.length, 0)
  assert.equal(harness.calls.bitmapCloses, 1)
  controller.dispose()
})

test('a controlled enable deadline cleans a late stream and leaves capture disabled', async () => {
  const capture = deferred()
  const callbacks = new Map()
  let nextTimer = 0
  const scheduler = {
    setTimeout(callback) {
      const id = ++nextTimer
      callbacks.set(id, callback)
      return id
    },
    clearTimeout(id) { callbacks.delete(id) },
  }
  const harness = makeLocalHarness({getUserMedia: () => capture.promise})
  const controller = new RendererCameraController({...harness, ...scheduler, deadlineMs: 4_500})
  controller.setSourceMode('local')
  const enabling = controller.enableLocal()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(callbacks.size, 1)
  callbacks.values().next().value()
  assert.equal(await settleWithin(enabling, 'local enable deadline'), false)
  assert.equal(callbacks.size, 0)
  capture.resolve(harness.stream)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.track.stops, 1, 'a stream resolving after timeout is relinquished')
  const response = makeDelivery()
  controller.enqueue(localRequest('camera-timeout'), response.delivery)
  assert.equal(
    (await settleWithin(response.response.promise, 'capture after enable timeout')).value,
    cameraUnavailableMessage('camera-timeout'),
  )
  assert.equal(harness.calls.constraints.length, 1)
  controller.dispose()
})

test('file capture is lazy, fixed-url, paused, deterministic, and reuses one decoder', async () => {
  const video = makeFakeVideo({duration: 10})
  const harness = makeLocalHarness()
  let createCalls = 0
  const controller = await makeController({
    ...harness,
    createVideo: () => { createCalls += 1; return video },
  }, 'file')
  const generation = Object.freeze({})
  assert.equal(createCalls, 0)

  for (const [position, expected] of [
    [0, 0],
    [2_500, 2.5],
    [10_000, 10 - CAMERA_FINAL_FRAME_EPSILON_SECONDS],
    [MAX_CAMERA_POSITION_MS, 10 - CAMERA_FINAL_FRAME_EPSILON_SECONDS],
  ]) {
    const response = makeDelivery(generation)
    controller.enqueue(fileRequest(position), response.delivery)
    const outbound = await settleWithin(response.response.promise, `file position ${position}`)
    assert.equal(outbound.kind, 'binary')
    assert.equal(video.seeks.at(-1), expected)
  }

  assert.equal(createCalls, 1)
  assert.equal(video.src, CAMERA_FILE_URL)
  assert.equal(video.preload, 'auto')
  assert.equal(video.muted, true)
  assert.equal(video.playsInline, true)
  assert.equal(video.playCalls, 0)
  assert.equal(video.paused, true)
  assert.equal(video.loadCalls, 1)
  assert.equal(harness.calls.canvases.length, 4)
  controller.closeGeneration(generation)
  assert.equal(video.removeSourceCalls, 1)
  assert.equal(video.loadCalls, 2, 'decoder release reloads the cleared source')
  assert.equal(video.listenerCount(), 0)
  controller.dispose()
})

test('file seek honors the injected controller position ceiling', async () => {
  const video = makeFakeVideo({duration: 10})
  const harness = makeLocalHarness()
  const controller = await makeController({
    ...harness, createVideo: () => video, maxPositionMs: 1_000,
  }, 'file')
  const response = makeDelivery()
  controller.enqueue(fileRequest(2_500, 'camera-injected-limit'), response.delivery)
  assert.equal((await settleWithin(response.response.promise, 'injected file limit')).kind, 'binary')
  assert.equal(video.seeks.at(-1), 1)
  controller.dispose()
})

test('file metadata/seek/frame failures are stable and failed decoders can be retried', async t => {
  const cases = [
    ['invalid duration', {duration: Number.NaN}],
    ['metadata error', {metadata: 'error'}],
    ['seek error', {seek: 'error'}],
    ['frame unavailable', {readyAfterSeek: 1}],
  ]
  for (const [name, videoOptions] of cases) {
    await t.test(name, async () => {
      const first = makeFakeVideo(videoOptions)
      const second = makeFakeVideo()
      const harness = makeLocalHarness()
      let createCalls = 0
      const controller = await makeController({
        ...harness,
        createVideo: () => (++createCalls === 1 ? first : second),
      }, 'file')
      const generation = Object.freeze({})
      const failed = makeDelivery(generation)
      controller.enqueue(fileRequest(2_000, `camera-${name.replaceAll(' ', '-')}`), failed.delivery)
      const error = await settleWithin(failed.response.promise, `${name} response`)
      assert.equal(error.kind, 'text')
      assert.equal(
        error.value,
        cameraUnavailableMessage(`camera-${name.replaceAll(' ', '-')}`),
      )

      const retry = makeDelivery(generation)
      controller.enqueue(fileRequest(0, `camera-${name.replaceAll(' ', '-')}-retry`), retry.delivery)
      assert.equal((await settleWithin(retry.response.promise, `${name} retry`)).kind, 'binary')
      assert.equal(createCalls, 2)
      assert.equal(first.listenerCount(), 0)
      assert.equal(first.removeSourceCalls, 1)
      controller.dispose()
    })
  }
})

test('file decode failure after metadata is stable and the next decoder recovers', async () => {
  const failedDecoder = makeFakeVideo({metadata: 'success', decode: 'error'})
  const recoveredDecoder = makeFakeVideo()
  const harness = makeLocalHarness()
  let createCalls = 0
  const controller = await makeController({
    ...harness,
    createVideo: () => (++createCalls === 1 ? failedDecoder : recoveredDecoder),
  }, 'file')
  const generation = Object.freeze({})
  const failed = makeDelivery(generation)
  controller.enqueue(fileRequest(0, 'camera-decode-failed'), failed.delivery)
  assert.equal(
    (await settleWithin(failed.response.promise, 'decode failure')).value,
    cameraUnavailableMessage('camera-decode-failed'),
  )
  assert.equal(failedDecoder.removeSourceCalls, 1)

  const retry = makeDelivery(generation)
  controller.enqueue(fileRequest(0, 'camera-decode-retry'), retry.delivery)
  assert.equal((await settleWithin(retry.response.promise, 'decode recovery')).kind, 'binary')
  assert.equal(createCalls, 2)
  controller.dispose()
})

test('a controlled file metadata deadline removes listeners and ignores late events', async () => {
  const callbacks = new Map()
  let nextTimer = 0
  const scheduler = {
    setTimeout(callback) {
      const id = ++nextTimer
      callbacks.set(id, callback)
      return id
    },
    clearTimeout(id) { callbacks.delete(id) },
  }
  const video = makeFakeVideo({metadata: 'held'})
  const harness = makeLocalHarness()
  const controller = await makeController({
    ...harness, ...scheduler, deadlineMs: 4_500, createVideo: () => video,
  }, 'file')
  const response = makeDelivery()
  controller.enqueue(fileRequest(0, 'camera-file-timeout'), response.delivery)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(video.listenerCount() > 0)
  callbacks.values().next().value()
  assert.equal((await settleWithin(response.response.promise, 'file deadline')).kind, 'text')
  assert.equal(callbacks.size, 0)
  assert.equal(video.listenerCount(), 0)
  assert.equal(video.removeSourceCalls, 1)
  video.readyState = 2
  video.dispatch('loadedmetadata')
  video.dispatch('seeked')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(response.sent.length, 1)
  controller.dispose()
})

test('camera requests are FIFO without poisoning the independent capture tail', async () => {
  const firstGrab = deferred()
  let grabs = 0
  const harness = makeLocalHarness({
    grabFrame: () => {
      grabs += 1
      return grabs === 1 ? firstGrab.promise : harness.bitmap
    },
  })
  const controller = await makeController(harness)
  const generation = Object.freeze({})
  const first = makeDelivery(generation)
  const second = makeDelivery(generation)
  controller.enqueue(localRequest('camera-fifo-1'), first.delivery)
  controller.enqueue(localRequest('camera-fifo-2'), second.delivery)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(grabs, 1)
  firstGrab.resolve(harness.bitmap)
  assert.equal((await settleWithin(first.response.promise, 'first FIFO capture')).kind, 'binary')
  assert.equal((await settleWithin(second.response.promise, 'second FIFO capture')).kind, 'binary')
  assert.equal(grabs, 2)
  controller.dispose()
})

test('malformed camera capture is contained and a valid next request still succeeds', async () => {
  const harness = makeLocalHarness()
  const controller = await makeController(harness)
  const generation = Object.freeze({})
  const malformed = makeDelivery(generation)
  controller.enqueue(
    '{"type":"camera.capture","request_id":"camera-malformed","source":"local","path":"/Users/sentinel"}',
    malformed.delivery,
  )
  assert.equal(
    (await settleWithin(malformed.response.promise, 'malformed camera response')).value,
    cameraUnavailableMessage('camera-malformed'),
  )
  const unsafe = makeDelivery(generation)
  controller.enqueue('{"type":"camera.capture","request_id":"bad","source":"local"}', unsafe.delivery)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(unsafe.sent.length, 0)

  const valid = makeDelivery(generation)
  controller.enqueue(localRequest('camera-after-malformed'), valid.delivery)
  assert.equal((await settleWithin(valid.response.promise, 'capture after malformed')).kind, 'binary')
  controller.dispose()
})

test('closing generation A fences late work while generation B captures independently', async () => {
  const firstFrame = deferred()
  const trackA = {stops: 0, stop() { this.stops += 1 }}
  const trackB = {stops: 0, stop() { this.stops += 1 }}
  const streamA = {getVideoTracks: () => [trackA], getTracks: () => [trackA]}
  const streamB = {getVideoTracks: () => [trackB], getTracks: () => [trackB]}
  let acquisitions = 0
  let grabs = 0
  const harness = makeLocalHarness({
    getUserMedia: () => (++acquisitions === 1 ? streamA : streamB),
    grabFrame: () => (++grabs === 1 ? firstFrame.promise : harness.bitmap),
  })
  const controller = await makeController(harness)
  const generationA = Object.freeze({name: 'A'})
  const generationB = Object.freeze({name: 'B'})
  const responseA = makeDelivery(generationA)
  const responseB = makeDelivery(generationB)
  controller.enqueue(localRequest('camera-A'), responseA.delivery)
  await new Promise(resolve => setImmediate(resolve))
  controller.closeGeneration(generationA)
  responseA.close()
  controller.closeGeneration(generationA)
  controller.enqueue(localRequest('camera-B'), responseB.delivery)
  assert.equal((await settleWithin(responseB.response.promise, 'generation B capture')).kind, 'binary')
  firstFrame.resolve(harness.bitmap)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(responseA.sent.length, 0)
  assert.equal(trackA.stops, 1)
  assert.equal(trackB.stops, 0)
  controller.dispose()
  assert.equal(trackB.stops, 1)
})

test('closing a generation at the encode barrier releases FIFO and fences its late JPEG', async () => {
  const firstEncoding = deferred()
  let conversions = 0
  const harness = makeLocalHarness({
    convertToBlob: () => (++conversions === 1 ? firstEncoding.promise : harness.blob),
  })
  const controller = await makeController(harness)
  const generationA = Object.freeze({name: 'encode-A'})
  const generationB = Object.freeze({name: 'encode-B'})
  const responseA = makeDelivery(generationA)
  const responseB = makeDelivery(generationB)
  controller.enqueue(localRequest('camera-encode-A'), responseA.delivery)
  await settleWithin((async () => {
    while (harness.calls.conversions.length === 0) {
      await new Promise(resolveWait => setImmediate(resolveWait))
    }
  })(), 'encode barrier entrance')

  controller.closeGeneration(generationA)
  responseA.close()
  controller.enqueue(localRequest('camera-encode-B'), responseB.delivery)
  assert.equal(
    (await settleWithin(responseB.response.promise, 'generation B after encode close')).kind,
    'binary',
  )
  firstEncoding.resolve(harness.blob)
  await new Promise(resolveWait => setImmediate(resolveWait))
  assert.equal(responseA.sent.length, 0)
  assert.equal(responseB.sent.length, 1)
  controller.dispose()
})

test('a generation closed before its first capture can never be reopened by queued work', async () => {
  const harness = makeLocalHarness()
  const controller = await makeController(harness)
  const generation = Object.freeze({name: 'already-closed'})
  const response = makeDelivery(generation)
  controller.closeGeneration(generation)
  controller.enqueue(localRequest('camera-after-close'), response.delivery)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.calls.constraints.length, 1, 'only the explicit enable touches the device')
  assert.equal(response.sent.length, 0)
  controller.dispose()
})

test('isCurrent is rechecked immediately before response and send failures stay contained', async () => {
  const conversion = deferred()
  const harness = makeLocalHarness({convertToBlob: () => conversion.promise})
  const controller = await makeController(harness)
  const stale = makeDelivery()
  controller.enqueue(localRequest('camera-stale'), stale.delivery)
  await new Promise(resolve => setImmediate(resolve))
  stale.close()
  conversion.resolve(harness.blob)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stale.sent.length, 0)

  const throwing = {
    generation: stale.delivery.generation,
    isCurrent: () => true,
    sendText: () => { throw new Error('text socket failure') },
    sendBinary: () => { throw new Error('binary socket failure') },
  }
  controller.enqueue(localRequest('camera-send-throws'), throwing)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  controller.dispose()
})
