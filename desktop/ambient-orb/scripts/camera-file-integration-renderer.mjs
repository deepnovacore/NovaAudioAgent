import {
  CAMERA_FRAME_MAGIC,
  RendererCameraController,
  RendererSocketRouter,
  parseCameraCapture,
} from '../src/renderer/camera.mjs'

const FIRST_REFERENCE_URL = 'nova://orb/reference-first.png'
const LAST_REFERENCE_URL = 'nova://orb/reference-last.png'
const GRID_COLUMNS = 32
const GRID_ROWS = 18
const WAIT_MS = 2_000

let active

export function createEncodeBarrier() {
  const pending = new Set()
  return Object.freeze({
    hold(encoded) {
      return Promise.resolve(encoded).then(value => new Promise(resolve => {
        const release = () => {
          pending.delete(release)
          resolve(value)
        }
        pending.add(release)
      }))
    },
    pendingCount: () => pending.size,
    releaseAll() {
      const count = pending.size
      for (const release of [...pending]) release()
      return count
    },
  })
}

export function supportsLockedFileCodec(canPlayType) {
  if (typeof canPlayType !== 'function') throw new Error('camera codec probe unavailable')
  const support = canPlayType('video/mp4; codecs="avc1.64001f"')
  return support === 'probably' || support === 'maybe'
}

export function compareLandmarks(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length
    || left.length !== GRID_COLUMNS * GRID_ROWS) throw new TypeError('invalid landmarks')
  let absolute = 0
  let maximum = 0
  let within = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftPixel = left[index]
    const rightPixel = right[index]
    const differences = [
      Math.abs(((leftPixel >>> 16) & 0xff) - ((rightPixel >>> 16) & 0xff)),
      Math.abs(((leftPixel >>> 8) & 0xff) - ((rightPixel >>> 8) & 0xff)),
      Math.abs((leftPixel & 0xff) - (rightPixel & 0xff)),
    ]
    absolute += differences[0] + differences[1] + differences[2]
    maximum = Math.max(maximum, ...differences)
    if (differences.every(value => value <= 48)) within += 1
  }
  return Object.freeze({
    meanAbsoluteError: absolute / (left.length * 3),
    maxAbsoluteError: maximum,
    within48Ratio: within / left.length,
  })
}

async function start(config) {
  if (active) throw new Error('camera integration renderer already started')
  if (!config || (config.sourceMode !== 'file' && config.sourceMode !== 'local')) {
    throw new Error('camera integration renderer config rejected')
  }
  const requestHooks = new Map()
  const captures = new Map()
  const requests = []
  const controls = []
  const controlWaiters = new Map()
  const heldSeekListeners = new Set()
  const encodeBarrier = createEncodeBarrier()
  const stats = {
    videoPause: 0,
    videoLoad: 0,
    videoPlay: 0,
    videoSourceCleared: 0,
  }
  const hooks = Array.isArray(config.failureSequence) ? [...config.failureSequence] : []
  let captureIndex = 0
  let pendingCanvasHook = 'ok'

  class IntegrationCanvas {
    constructor(width, height) {
      const hook = pendingCanvasHook
      pendingCanvasHook = 'ok'
      if (hook === 'canvas_unavailable') throw new Error('unavailable')
      this.canvas = new globalThis.OffscreenCanvas(width, height)
      this.hook = hook
    }

    getContext(kind) {
      return this.canvas.getContext(kind)
    }

    convertToBlob(options) {
      if (this.hook === 'encode_unavailable') return Promise.reject(new Error('unavailable'))
      const encoded = this.canvas.convertToBlob(options)
      return this.hook === 'hold_encode' ? encodeBarrier.hold(encoded) : encoded
    }
  }

  const createVideo = () => {
    if (pendingCanvasHook === 'metadata_unavailable') {
      pendingCanvasHook = 'ok'
      return unavailableVideo()
    }
    if (pendingCanvasHook === 'decode_unavailable') {
      pendingCanvasHook = 'ok'
      return decodeUnavailableVideo()
    }
    const seekUnavailable = pendingCanvasHook === 'seek_unavailable'
    if (seekUnavailable) pendingCanvasHook = 'ok'
    const video = document.createElement('video')
    const originalAdd = video.addEventListener.bind(video)
    const originalRemove = video.removeEventListener.bind(video)
    const originalPause = video.pause.bind(video)
    const originalLoad = video.load.bind(video)
    const originalRemoveAttribute = video.removeAttribute.bind(video)
    video.addEventListener = (type, listener, options) => {
      if (type === 'seeked' && seekUnavailable) {
        return
      }
      if (type === 'error' && seekUnavailable) {
        queueMicrotask(() => listener(new Event('error')))
        return
      }
      if (type === 'seeked' && config.holdSeek === true) {
        heldSeekListeners.add(listener)
        return
      }
      originalAdd(type, listener, options)
    }
    video.removeEventListener = (type, listener, options) => {
      heldSeekListeners.delete(listener)
      originalRemove(type, listener, options)
    }
    video.pause = () => {
      stats.videoPause += 1
      return originalPause()
    }
    video.load = () => {
      stats.videoLoad += 1
      return originalLoad()
    }
    video.play = () => {
      stats.videoPlay += 1
      throw new Error('play is forbidden')
    }
    video.removeAttribute = name => {
      if (name === 'src') stats.videoSourceCleared += 1
      return originalRemoveAttribute(name)
    }
    return video
  }

  const controller = new RendererCameraController({
    mediaDevices: config.permissionDenied === true
      ? {getUserMedia: () => Promise.reject(new DOMException('/Users/path-sentinel'))}
      : navigator.mediaDevices,
    ImageCapture: config.imageCaptureUnavailable === true ? undefined : globalThis.ImageCapture,
    OffscreenCanvas: IntegrationCanvas,
    createVideo,
  })
  controller.setSourceMode(config.sourceMode)
  const nativeSocket = new WebSocket(config.endpoint)
  nativeSocket.binaryType = 'arraybuffer'
  const socketFacade = {
    get readyState() { return nativeSocket.readyState },
    send(value) {
      if (value instanceof Uint8Array) {
        const decoded = decodeRendererFrame(value)
        const hook = requestHooks.get(decoded.requestId) ?? 'ok'
        if (hook === 'wrong_id') {
          const wrong = new Uint8Array(value)
          const headerLength = new DataView(wrong.buffer).getUint16(CAMERA_FRAME_MAGIC.byteLength)
          const headerStart = CAMERA_FRAME_MAGIC.byteLength + 2
          const header = JSON.parse(new TextDecoder().decode(
            wrong.subarray(headerStart, headerStart + headerLength),
          ))
          const requestIdBytes = new TextEncoder().encode(header.request_id).byteLength
          const prefixBytes = new TextEncoder().encode('camera-').byteLength
          const suffixBytes = Math.max(1, requestIdBytes - prefixBytes)
          header.request_id = `camera-${'9'.repeat(suffixBytes)}`
          const changed = new TextEncoder().encode(JSON.stringify(header))
          if (changed.byteLength === headerLength) wrong.set(changed, headerStart)
          nativeSocket.send(wrong)
          return
        }
        if (hook === 'malformed') {
          nativeSocket.send(new Uint8Array([...CAMERA_FRAME_MAGIC, 0, 2, 0x7b, 0x7d]))
          return
        }
        if (hook === 'oversized') {
          const oversized = new Uint8Array(2_098_187)
          oversized.set(CAMERA_FRAME_MAGIC)
          nativeSocket.send(oversized)
          return
        }
        if (hook === 'drop') return
        const position = requestHooks.get(`${decoded.requestId}:position`)
        captures.set(position, decoded.jpeg)
      }
      nativeSocket.send(value)
    },
  }
  const router = new RendererSocketRouter({
    cameraController: controller,
    handleGeneric: event => {
      if (typeof event.data !== 'string') return
      let message
      try { message = JSON.parse(event.data) } catch { return }
      controls.push(message.type)
      const waiters = controlWaiters.get(message.type) ?? []
      controlWaiters.delete(message.type)
      for (const settle of waiters) settle()
    },
  })
  const connection = router.connect(socketFacade)
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('renderer socket open timed out')), WAIT_MS)
    nativeSocket.onopen = () => {
      clearTimeout(timer)
      connection.delivery.sendText(JSON.stringify({type: 'hello', token: config.token}))
      resolve()
    }
    nativeSocket.onerror = () => {
      clearTimeout(timer)
      reject(new Error('renderer socket failed'))
    }
  })
  nativeSocket.onmessage = event => {
    if (typeof event.data === 'string') {
      const request = parseCameraCapture(event.data)
      if (request) {
        const hook = hooks[captureIndex] ?? 'ok'
        captureIndex += 1
        requestHooks.set(request.request_id, hook)
        requestHooks.set(`${request.request_id}:position`, request.position_ms ?? 0)
        pendingCanvasHook = hook
        requests.push(Object.freeze({
          source: request.source,
          positionMs: request.position_ms ?? null,
          hook,
        }))
      }
    }
    connection.onMessage(event)
  }
  nativeSocket.onclose = () => connection.close()
  await opened

  active = {
    captures,
    connection,
    controller,
    controls,
    controlWaiters,
    heldSeekListeners,
    encodeBarrier,
    nativeSocket,
    requests,
    router,
    stats,
  }
  window.addEventListener('beforeunload', () => cleanup(), {once: true})
  return true
}

function supportsFileCodec() {
  const video = document.createElement('video')
  return supportsLockedFileCodec(video.canPlayType?.bind(video))
}

async function waitForControl(type) {
  if (!active) throw new Error('camera integration renderer not started')
  if (active.controls.includes(type)) return true
  return new Promise((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      const current = active?.controlWaiters.get(type) ?? []
      active?.controlWaiters.set(type, current.filter(value => value !== settle))
      reject(new Error('renderer control timed out'))
    }, WAIT_MS)
    const waiters = active.controlWaiters.get(type) ?? []
    waiters.push(settle)
    active.controlWaiters.set(type, waiters)
  })
}

function releaseSeek() {
  if (!active) return false
  for (const listener of [...active.heldSeekListeners]) listener(new Event('seeked'))
  active.heldSeekListeners.clear()
  return true
}

async function waitForEncodeBarrier() {
  if (!active) throw new Error('camera integration renderer not started')
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    if (active.encodeBarrier.pendingCount() > 0) return true
    await new Promise(resolveWait => setTimeout(resolveWait, 0))
  }
  throw new Error('renderer encode barrier timed out')
}

function releaseEncode() {
  return active?.encodeBarrier.releaseAll() ?? 0
}

function requestTrace() {
  return active ? active.requests.map(request => ({...request})) : []
}

async function visualEvidence() {
  if (!active) throw new Error('camera integration renderer not started')
  const [firstA, firstB, lastA, lastB] = await Promise.all([
    sampleUrl(FIRST_REFERENCE_URL), sampleUrl(FIRST_REFERENCE_URL),
    sampleUrl(LAST_REFERENCE_URL), sampleUrl(LAST_REFERENCE_URL),
  ])
  const capture0 = await sampleJpeg(active.captures.get(0))
  const capture2500 = await sampleJpeg(active.captures.get(2_500))
  const capture5000 = await sampleJpeg(active.captures.get(5_000))
  const capturePast = await sampleJpeg(active.captures.get(86_400_000))
  return Object.freeze({
    referenceSelfFirst: compareLandmarks(firstA, firstB),
    referenceSelfLast: compareLandmarks(lastA, lastB),
    capture0ToFirst: compareLandmarks(capture0, firstA),
    capturePastEndToLast: compareLandmarks(capturePast, lastA),
    capture0To2500: compareLandmarks(capture0, capture2500),
    capture0To5000: compareLandmarks(capture0, capture5000),
    capture2500To5000: compareLandmarks(capture2500, capture5000),
    landmarks: Object.freeze({
      capture0, capture2500, capture5000, capturePast,
    }),
  })
}

function cleanup() {
  if (!active) return Object.freeze({})
  const current = active
  active = undefined
  current.router.dispose()
  current.controller.dispose()
  current.encodeBarrier.releaseAll()
  try { current.nativeSocket.close() } catch { /* closed renderer socket */ }
  return Object.freeze({...current.stats})
}

async function sampleUrl(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error('reference unavailable')
  return sampleBitmap(await createImageBitmap(await response.blob()))
}

async function sampleJpeg(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('capture unavailable')
  return sampleBitmap(await createImageBitmap(new Blob([bytes], {type: 'image/jpeg'})))
}

async function sampleBitmap(bitmap) {
  try {
    const canvas = new OffscreenCanvas(1280, 720)
    const context = canvas.getContext('2d', {willReadFrequently: true})
    context.drawImage(bitmap, 0, 0, 1280, 720)
    const pixels = []
    for (let row = 0; row < GRID_ROWS; row += 1) {
      const y = Math.min(719, Math.floor(((row + 0.5) * 720) / GRID_ROWS))
      for (let column = 0; column < GRID_COLUMNS; column += 1) {
        const x = Math.min(1279, Math.floor(((column + 0.5) * 1280) / GRID_COLUMNS))
        const data = context.getImageData(x, y, 1, 1).data
        if (data[3] !== 255) throw new Error('non-opaque sample')
        pixels.push((data[0] << 16) | (data[1] << 8) | data[2])
      }
    }
    return Object.freeze(pixels)
  } finally {
    bitmap.close?.()
  }
}

function decodeRendererFrame(wire) {
  if (!(wire instanceof Uint8Array) || wire.byteLength < CAMERA_FRAME_MAGIC.byteLength + 2) {
    throw new Error('invalid renderer frame')
  }
  for (let index = 0; index < CAMERA_FRAME_MAGIC.byteLength; index += 1) {
    if (wire[index] !== CAMERA_FRAME_MAGIC[index]) throw new Error('invalid renderer frame')
  }
  const headerLength = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
    .getUint16(CAMERA_FRAME_MAGIC.byteLength)
  const payloadOffset = CAMERA_FRAME_MAGIC.byteLength + 2 + headerLength
  const header = JSON.parse(new TextDecoder().decode(
    wire.subarray(CAMERA_FRAME_MAGIC.byteLength + 2, payloadOffset),
  ))
  return Object.freeze({
    requestId: header.request_id,
    jpeg: new Uint8Array(wire.subarray(payloadOffset)),
  })
}

function unavailableVideo() {
  const listeners = new Map()
  const video = {
    preload: '',
    muted: false,
    playsInline: false,
    src: '',
    readyState: 0,
    duration: Number.NaN,
    currentTime: 0,
    paused: true,
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? []
      values.push(listener)
      listeners.set(type, values)
      if (type === 'loadedmetadata') queueMicrotask(() => {
        for (const errorListener of listeners.get('error') ?? []) {
          errorListener(new Event('error'))
        }
      })
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter(value => value !== listener))
    },
    pause() {},
    load() {},
    removeAttribute(name) { if (name === 'src') this.src = '' },
  }
  return video
}

function decodeUnavailableVideo() {
  const listeners = new Map()
  const video = {
    preload: '',
    muted: false,
    playsInline: false,
    src: '',
    readyState: 0,
    duration: 7.033,
    currentTime: 0,
    paused: true,
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? []
      values.push(listener)
      listeners.set(type, values)
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter(value => value !== listener))
    },
    pause() {},
    load() {
      if (!this.src) return
      queueMicrotask(() => {
        this.readyState = 1
        for (const listener of listeners.get('loadedmetadata') ?? []) {
          listener(new Event('loadedmetadata'))
        }
        setTimeout(() => {
          for (const listener of listeners.get('error') ?? []) listener(new Event('error'))
        }, 0)
      })
    },
    removeAttribute(name) { if (name === 'src') this.src = '' },
  }
  return video
}

const api = Object.freeze({
  start,
  supportsFileCodec,
  waitForControl,
  releaseSeek,
  waitForEncodeBarrier,
  releaseEncode,
  requestTrace,
  visualEvidence,
  cleanup,
})

if (typeof window !== 'undefined') window.novaCameraFileIntegration = api

export {api as cameraFileIntegrationRenderer}
