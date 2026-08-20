export const CAMERA_FRAME_MAGIC = new Uint8Array([
  0x4e, 0x56, 0x43, 0x41, 0x4d, 0x01, 0x0d, 0x0a,
])
export const CAMERA_FILE_URL = 'nova://orb/camera-source'
export const CAMERA_WIDTH = 1280
export const CAMERA_HEIGHT = 720
export const CAMERA_JPEG_QUALITY = 0.8
export const MAX_CAMERA_HEADER_BYTES = 1024
export const MAX_CAMERA_JPEG_BYTES = 2 * 1024 * 1024
export const MAX_CAMERA_WIRE_BYTES = 8 + 2 + MAX_CAMERA_HEADER_BYTES + MAX_CAMERA_JPEG_BYTES
export const MAX_CAMERA_POSITION_MS = 86_400_000
export const RENDERER_CAMERA_DEADLINE_MS = 4_500
// A requested end position is held one millisecond inside the media timeline.
export const CAMERA_FINAL_FRAME_EPSILON_SECONDS = 0.001

const requestIdPattern = /^camera-[A-Za-z0-9_-]+$/u
const localKeys = ['request_id', 'source', 'type']
const fileKeys = ['position_ms', 'request_id', 'source', 'type']
const encoder = new TextEncoder()

export function parseCameraCapture(raw) {
  const parsed = parseFlatJsonObject(raw)
  if (!parsed || parsed.value.type !== 'camera.capture' || !validRequestId(parsed.value.request_id)) {
    return null
  }
  if (parsed.value.source === 'local') {
    if (!hasExactKeys(parsed.value, localKeys)) return null
    return Object.freeze({
      type: 'camera.capture',
      request_id: parsed.value.request_id,
      source: 'local',
    })
  }
  if (parsed.value.source !== 'file' || !hasExactKeys(parsed.value, fileKeys)) return null
  const positionSource = parsed.sources.get('position_ms')
  if (!/^(?:0|[1-9]\d*)$/u.test(positionSource ?? '')
    || !Number.isSafeInteger(parsed.value.position_ms)
    || parsed.value.position_ms < 0
    || parsed.value.position_ms > MAX_CAMERA_POSITION_MS) return null
  return Object.freeze({
    type: 'camera.capture',
    request_id: parsed.value.request_id,
    source: 'file',
    position_ms: parsed.value.position_ms,
  })
}

export function encodeCameraFrame({requestId, jpeg} = {}) {
  if (!validRequestId(requestId)) throw new TypeError('invalid camera frame')
  validateJpeg(jpeg)
  const header = JSON.stringify({
    type: 'camera.frame',
    request_id: requestId,
    media_type: 'image/jpeg',
    width: CAMERA_WIDTH,
    height: CAMERA_HEIGHT,
  })
  const headerBytes = encoder.encode(header)
  if (headerBytes.byteLength < 2 || headerBytes.byteLength > MAX_CAMERA_HEADER_BYTES) {
    throw new TypeError('invalid camera frame')
  }
  const wireBytes = CAMERA_FRAME_MAGIC.byteLength + 2 + headerBytes.byteLength + jpeg.byteLength
  if (wireBytes > MAX_CAMERA_WIRE_BYTES) throw new TypeError('invalid camera frame')
  const wire = new Uint8Array(wireBytes)
  wire.set(CAMERA_FRAME_MAGIC)
  new DataView(wire.buffer).setUint16(CAMERA_FRAME_MAGIC.byteLength, headerBytes.byteLength, false)
  wire.set(headerBytes, CAMERA_FRAME_MAGIC.byteLength + 2)
  wire.set(jpeg, CAMERA_FRAME_MAGIC.byteLength + 2 + headerBytes.byteLength)
  return wire
}

export function cameraUnavailableMessage(requestId) {
  if (!validRequestId(requestId)) throw new TypeError('invalid camera request')
  return JSON.stringify({
    type: 'camera.error',
    request_id: requestId,
    error: 'capture_unavailable',
  })
}

export function isCameraCaptureText(raw) {
  return classifyCameraCaptureText(raw).kind !== 'other'
}

export function classifyCameraCaptureText(raw) {
  const request = parseCameraCapture(raw)
  if (request) return Object.freeze({kind: 'valid', request})
  const fields = scanTopLevelJsonFields(raw)
  if (!fields.some(field => field.key === 'type' && field.value === 'camera.capture')) {
    return Object.freeze({kind: 'other'})
  }
  const requestIds = fields
    .filter(field => field.key === 'request_id' && validRequestId(field.value))
    .map(field => field.value)
  return Object.freeze({
    kind: 'malformed',
    requestId: requestIds.length === 1 ? requestIds[0] : null,
  })
}

export class RendererSocketRouter {
  #cameraController
  #handleGeneric
  #onGenericError
  #onCurrentClose
  #cameraTail = Promise.resolve()
  #genericTail = Promise.resolve()
  #current = null
  #disposed = false

  constructor({
    cameraController,
    handleGeneric,
    onGenericError = () => {},
    onCurrentClose = () => {},
  } = {}) {
    if (!cameraController || typeof cameraController.enqueue !== 'function'
      || typeof cameraController.closeGeneration !== 'function'
      || typeof handleGeneric !== 'function'
      || typeof onGenericError !== 'function'
      || typeof onCurrentClose !== 'function') throw new TypeError('invalid renderer socket router')
    this.#cameraController = cameraController
    this.#handleGeneric = handleGeneric
    this.#onGenericError = onGenericError
    this.#onCurrentClose = onCurrentClose
  }

  connect(socket) {
    if (this.#disposed || !socket || typeof socket.send !== 'function') {
      throw new TypeError('invalid renderer socket')
    }
    if (this.#current) this.#retireCamera(this.#current)
    const generation = Object.freeze({})
    const record = {
      socket,
      generation,
      cameraClosed: false,
      closed: false,
    }
    const delivery = Object.freeze({
      generation,
      isCurrent: () => this.#isCurrent(record) && socket.readyState === 1,
      sendText: value => socket.send(value),
      sendBinary: value => socket.send(value),
    })
    record.delivery = delivery
    this.#current = record
    return Object.freeze({
      generation,
      delivery,
      isCurrent: () => this.#isCurrent(record),
      onMessage: event => this.#route(record, event),
      close: (notify = true) => this.#close(record, notify),
    })
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#current) this.#close(this.#current, false)
  }

  #route(record, event) {
    if (!this.#isCurrent(record)) return
    if (typeof event?.data === 'string'
      && classifyCameraCaptureText(event.data).kind !== 'other') {
      const runCamera = () => {
        if (!this.#isCurrent(record)) return
        try {
          // `enqueue` owns and contains its async work. Its return value is
          // deliberately discarded so a thenable fake/implementation cannot
          // merge the camera tail with renderer playback scheduling.
          void this.#cameraController.enqueue(event.data, record.delivery)
        } catch { /* one camera failure cannot poison either renderer tail */ }
      }
      this.#cameraTail = this.#cameraTail.then(runCamera, runCamera).catch(() => {})
      return
    }
    const runGeneric = () => {
      if (!this.#isCurrent(record)) return undefined
      return this.#handleGeneric(event, record.delivery)
    }
    this.#genericTail = this.#genericTail.then(runGeneric, runGeneric).catch(error => {
      if (!this.#isCurrent(record)) return
      try { this.#onGenericError(error, record.delivery) } catch { /* renderer event boundary */ }
    }).catch(() => {})
  }

  #close(record, notify) {
    this.#retireCamera(record)
    record.closed = true
    if (this.#current !== record) return false
    this.#current = null
    if (notify) {
      try {
        this.#onCurrentClose(Object.freeze({
          socket: record.socket,
          generation: record.generation,
        }))
      } catch { /* renderer event boundary */ }
    }
    return true
  }

  #retireCamera(record) {
    if (record.cameraClosed) return
    record.cameraClosed = true
    try { this.#cameraController.closeGeneration(record.generation) } catch { /* cleanup boundary */ }
  }

  #isCurrent(record) {
    return !this.#disposed && !record.closed && this.#current === record
  }
}

export class RendererCameraController {
  #mediaDevices
  #ImageCapture
  #OffscreenCanvas
  #createVideo
  #setTimeout
  #clearTimeout
  #deadlineMs
  #maxPositionMs
  #states = new Map()
  #closedGenerations = new WeakSet()
  #captureTail = Promise.resolve()
  #disposed = false

  constructor({
    mediaDevices,
    ImageCapture,
    OffscreenCanvas,
    createVideo,
    setTimeout: scheduleTimeout = globalThis.setTimeout?.bind(globalThis),
    clearTimeout: cancelTimeout = globalThis.clearTimeout?.bind(globalThis),
    deadlineMs = RENDERER_CAMERA_DEADLINE_MS,
    maxPositionMs = MAX_CAMERA_POSITION_MS,
  } = {}) {
    this.#mediaDevices = mediaDevices
    this.#ImageCapture = ImageCapture
    this.#OffscreenCanvas = OffscreenCanvas
    this.#createVideo = createVideo
    this.#setTimeout = scheduleTimeout
    this.#clearTimeout = cancelTimeout
    this.#deadlineMs = deadlineMs
    this.#maxPositionMs = Number.isSafeInteger(maxPositionMs)
      && maxPositionMs >= 0
      && maxPositionMs <= MAX_CAMERA_POSITION_MS
      ? maxPositionMs
      : MAX_CAMERA_POSITION_MS
  }

  enqueue(rawText, delivery) {
    if (this.#disposed || !validDelivery(delivery)) return
    if (this.#closedGenerations.has(delivery.generation)) return
    let state = this.#states.get(delivery.generation)
    if (!state) {
      state = makeGenerationState()
      this.#states.set(delivery.generation, state)
    }
    const request = parseCameraCapture(rawText)
    if (!request) {
      const requestId = safeMalformedRequestId(rawText)
      if (requestId) this.#append(() => {
        if (!state.closed) this.#sendUnavailable(requestId, delivery)
      })
      return
    }
    this.#append(() => this.#capture(request, delivery, state))
  }

  closeGeneration(generation) {
    if (isGenerationToken(generation)) this.#closedGenerations.add(generation)
    const state = this.#states.get(generation)
    if (!state || state.closed) return
    state.closed = true
    for (const cancel of [...state.cancels]) cancel()
    state.cancels.clear()
    this.#releaseLocal(state)
    this.#releaseFile(state)
    this.#states.delete(generation)
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    for (const generation of [...this.#states.keys()]) this.closeGeneration(generation)
  }

  #append(operation) {
    this.#captureTail = this.#captureTail.then(operation, operation).catch(() => {})
  }

  async #capture(request, delivery, state) {
    if (this.#disposed || state.closed || !safeIsCurrent(delivery)) return
    const operation = this.#beginOperation(state)
    let responseAttempted = false
    try {
      const jpegBytes = request.source === 'local'
        ? await this.#captureLocal(state, operation)
        : await this.#captureFile(state, operation, request.position_ms)
      const wire = encodeCameraFrame({requestId: request.request_id, jpeg: jpegBytes})
      if (!operation.active() || state.closed || this.#disposed) return
      if (!safeIsCurrent(delivery)) return
      responseAttempted = true
      delivery.sendBinary(wire)
    } catch {
      if (operation.cancelled() && !state.closed) this.#releaseLocal(state)
      if (!responseAttempted && !state.closed && !this.#disposed) {
        this.#sendUnavailable(request.request_id, delivery)
      }
    } finally {
      operation.finish()
    }
  }

  async #captureLocal(state, operation) {
    if (!state.localStream) {
      if (typeof this.#mediaDevices?.getUserMedia !== 'function'
        || typeof this.#ImageCapture !== 'function') throw new Error('unavailable')
      const stream = await operation.wait(
        Promise.resolve().then(() => this.#mediaDevices.getUserMedia({video: true, audio: false})),
        lateStream => this.#stopStream(state, lateStream),
      )
      const track = usableVideoTrack(stream)
      if (!track) {
        this.#stopStream(state, stream)
        throw new Error('unavailable')
      }
      let capture
      try {
        capture = new this.#ImageCapture(track)
      } catch {
        this.#stopStream(state, stream)
        throw new Error('unavailable')
      }
      if (!operation.active() || state.closed) {
        this.#stopStream(state, stream)
        throw new Error('unavailable')
      }
      state.localStream = stream
      state.imageCapture = capture
    }
    const bitmap = await operation.wait(
      Promise.resolve().then(() => state.imageCapture.grabFrame()),
      lateBitmap => safeCloseBitmap(lateBitmap),
    )
    return this.#encodeDrawable(bitmap, operation, true)
  }

  async #encodeDrawable(drawable, operation, closeDrawable = false) {
    try {
      if (typeof this.#OffscreenCanvas !== 'function') throw new Error('unavailable')
      const canvas = new this.#OffscreenCanvas(CAMERA_WIDTH, CAMERA_HEIGHT)
      const context = canvas.getContext?.('2d')
      if (!context || typeof context.drawImage !== 'function'
        || typeof canvas.convertToBlob !== 'function') throw new Error('unavailable')
      context.drawImage(drawable, 0, 0, CAMERA_WIDTH, CAMERA_HEIGHT)
      const blob = await operation.wait(canvas.convertToBlob({
        type: 'image/jpeg', quality: CAMERA_JPEG_QUALITY,
      }))
      if (!blob || blob.type !== 'image/jpeg'
        || !Number.isFinite(blob.size)
        || blob.size < 4
        || blob.size > MAX_CAMERA_JPEG_BYTES
        || typeof blob.arrayBuffer !== 'function') throw new Error('unavailable')
      const buffer = await operation.wait(blob.arrayBuffer())
      if (!(buffer instanceof ArrayBuffer)) throw new Error('unavailable')
      const bytes = new Uint8Array(buffer.slice(0))
      if (bytes.byteLength !== blob.size) throw new Error('unavailable')
      validateJpeg(bytes)
      return bytes
    } finally {
      if (closeDrawable) safeCloseBitmap(drawable)
    }
  }

  async #captureFile(state, operation, requestedPositionMs) {
    try {
      if (!state.video) {
        if (typeof this.#createVideo !== 'function') throw new Error('unavailable')
        const video = this.#createVideo()
        if (!video || typeof video.addEventListener !== 'function'
          || typeof video.removeEventListener !== 'function') throw new Error('unavailable')
        state.video = video
        video.preload = 'auto'
        video.muted = true
        video.playsInline = true
        video.src = CAMERA_FILE_URL
        video.pause?.()
        video.load?.()
      }
      const video = state.video
      if (!(video.readyState >= 1)) {
        await this.#waitForVideo(video, 'loadedmetadata', operation)
      }
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('unavailable')
      if (!(video.readyState >= 2)) await this.#waitForVideo(video, 'loadeddata', operation)

      const durationLimitMs = Math.min(
        this.#maxPositionMs,
        Math.floor(video.duration * 1_000),
      )
      const boundedPositionMs = Math.max(0, Math.min(requestedPositionMs, durationLimitMs))
      let targetSeconds = boundedPositionMs / 1_000
      if (targetSeconds >= video.duration) {
        targetSeconds = Math.max(0, video.duration - CAMERA_FINAL_FRAME_EPSILON_SECONDS)
      }
      const previousTime = video.currentTime
      video.pause?.()
      video.currentTime = targetSeconds
      if (!(video.readyState >= 2 && previousTime === targetSeconds)) {
        await this.#waitForVideo(video, 'seeked', operation)
      }
      if (video.paused !== true || !(video.readyState >= 2)) throw new Error('unavailable')
      return await this.#encodeDrawable(video, operation)
    } catch (error) {
      this.#releaseFile(state)
      throw error
    }
  }

  async #waitForVideo(video, successType, operation) {
    let cleanup = () => {}
    const event = new Promise((resolve, reject) => {
      const onSuccess = () => { cleanup(); resolve() }
      const onError = () => { cleanup(); reject(new Error('unavailable')) }
      cleanup = () => {
        video.removeEventListener(successType, onSuccess)
        video.removeEventListener('error', onError)
      }
      video.addEventListener(successType, onSuccess, {once: true})
      video.addEventListener('error', onError, {once: true})
    })
    const removeCleanup = operation.addCleanup(cleanup)
    try {
      await operation.wait(event)
    } finally {
      cleanup()
      removeCleanup()
    }
  }

  #beginOperation(state) {
    let active = true
    let didCancel = false
    let rejectCancellation
    const cleanups = new Set()
    const cancellation = new Promise((_, reject) => { rejectCancellation = reject })
    cancellation.catch(() => {})
    const cancel = () => {
      if (!active) return
      active = false
      didCancel = true
      for (const cleanup of [...cleanups]) safeRelease(cleanup)
      cleanups.clear()
      rejectCancellation(new Error('camera operation cancelled'))
    }
    state.cancels.add(cancel)
    const timer = this.#setTimeout?.(cancel, this.#deadlineMs)
    return {
      active: () => active,
      cancelled: () => didCancel,
      addCleanup: cleanup => {
        if (!active) {
          safeRelease(cleanup)
          return () => {}
        }
        cleanups.add(cleanup)
        return () => cleanups.delete(cleanup)
      },
      wait: async (promise, releaseLate = () => {}) => {
        let returned = false
        let released = false
        const releaseOnce = value => {
          if (returned || released) return
          released = true
          safeRelease(releaseLate, value)
        }
        const task = Promise.resolve(promise)
        task.then(value => {
          if (!active) releaseOnce(value)
        }, () => {})
        const value = await Promise.race([task, cancellation])
        if (!active) {
          releaseOnce(value)
          throw new Error('camera operation cancelled')
        }
        returned = true
        return value
      },
      finish: () => {
        if (timer !== undefined) this.#clearTimeout?.(timer)
        state.cancels.delete(cancel)
        for (const cleanup of [...cleanups]) safeRelease(cleanup)
        cleanups.clear()
        active = false
      },
    }
  }

  #sendUnavailable(requestId, delivery) {
    if (!safeIsCurrent(delivery)) return
    try {
      delivery.sendText(cameraUnavailableMessage(requestId))
    } catch { /* transport owns its socket */ }
  }

  #releaseLocal(state) {
    if (state.localStream) this.#stopStream(state, state.localStream)
    state.localStream = null
    state.imageCapture = null
  }

  #stopStream(state, stream) {
    let tracks = []
    try {
      tracks = typeof stream?.getTracks === 'function'
        ? stream.getTracks()
        : typeof stream?.getVideoTracks === 'function' ? stream.getVideoTracks() : []
    } catch { /* an invalid stream owns no usable track */ }
    for (const track of tracks) {
      if (!track || state.stoppedTracks.has(track)) continue
      state.stoppedTracks.add(track)
      try { track.stop?.() } catch { /* cleanup is best effort */ }
    }
  }

  #releaseFile(state) {
    const video = state.video
    if (!video) return
    state.video = null
    try { video.pause?.() } catch { /* decoder release is best effort */ }
    try {
      if (typeof video.removeAttribute === 'function') video.removeAttribute('src')
      else video.src = ''
    } catch { /* decoder release is best effort */ }
    try { video.load?.() } catch { /* decoder release is best effort */ }
  }
}

function makeGenerationState() {
  return {
    closed: false,
    cancels: new Set(),
    stoppedTracks: new Set(),
    localStream: null,
    imageCapture: null,
    video: null,
  }
}

function usableVideoTrack(stream) {
  try {
    const tracks = stream?.getVideoTracks?.()
    if (!Array.isArray(tracks)) return null
    return tracks.find(track => track && track.readyState !== 'ended') ?? null
  } catch {
    return null
  }
}

function safeMalformedRequestId(raw) {
  const classified = classifyCameraCaptureText(raw)
  return classified.kind === 'malformed' ? classified.requestId : null
}

function validDelivery(delivery) {
  return delivery
    && Object.hasOwn(delivery, 'generation')
    && isGenerationToken(delivery.generation)
    && typeof delivery.isCurrent === 'function'
    && typeof delivery.sendText === 'function'
    && typeof delivery.sendBinary === 'function'
}

function isGenerationToken(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function safeIsCurrent(delivery) {
  try {
    return delivery.isCurrent() === true
  } catch {
    return false
  }
}

function safeCloseBitmap(bitmap) {
  try { bitmap?.close?.() } catch { /* ownership still ends here */ }
}

function safeRelease(release, value) {
  try { release(value) } catch { /* late cleanup is best effort */ }
}

function validRequestId(value) {
  return typeof value === 'string'
    && requestIdPattern.test(value)
    && encoder.encode(value).byteLength <= 64
}

function validateJpeg(jpeg) {
  if (!(jpeg instanceof Uint8Array)
    || jpeg.byteLength < 4
    || jpeg.byteLength > MAX_CAMERA_JPEG_BYTES
    || jpeg[0] !== 0xff
    || jpeg[1] !== 0xd8
    || jpeg[jpeg.byteLength - 2] !== 0xff
    || jpeg[jpeg.byteLength - 1] !== 0xd9) {
    throw new TypeError('invalid camera frame')
  }
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function parseFlatJsonObject(raw) {
  if (typeof raw !== 'string' || encoder.encode(raw).byteLength > MAX_CAMERA_HEADER_BYTES) return null
  let offset = skipWhitespace(raw, 0)
  if (raw[offset] !== '{') return null
  offset = skipWhitespace(raw, offset + 1)
  const value = Object.create(null)
  const sources = new Map()
  const keys = new Set()
  if (raw[offset] === '}') {
    offset = skipWhitespace(raw, offset + 1)
    return offset === raw.length ? {value, sources} : null
  }
  while (offset < raw.length) {
    const keyToken = readJsonString(raw, offset)
    if (!keyToken) return null
    const key = parseJsonToken(keyToken.source)
    if (typeof key !== 'string' || keys.has(key)) return null
    keys.add(key)
    offset = skipWhitespace(raw, keyToken.end)
    if (raw[offset] !== ':') return null
    offset = skipWhitespace(raw, offset + 1)
    const valueToken = raw[offset] === '"'
      ? readJsonString(raw, offset)
      : readPrimitive(raw, offset)
    if (!valueToken) return null
    const fieldValue = parseJsonToken(valueToken.source)
    if (fieldValue === invalidToken) return null
    value[key] = fieldValue
    sources.set(key, valueToken.source)
    offset = skipWhitespace(raw, valueToken.end)
    if (raw[offset] === '}') {
      offset = skipWhitespace(raw, offset + 1)
      return offset === raw.length ? {value, sources} : null
    }
    if (raw[offset] !== ',') return null
    offset = skipWhitespace(raw, offset + 1)
  }
  return null
}

function scanTopLevelJsonFields(raw) {
  if (typeof raw !== 'string') return []
  const fields = []
  let offset = skipWhitespace(raw, 0)
  if (raw[offset] !== '{') return fields
  offset = skipWhitespace(raw, offset + 1)
  while (offset < raw.length && raw[offset] !== '}') {
    const keyToken = readJsonString(raw, offset)
    if (!keyToken) return fields
    const key = parseJsonToken(keyToken.source)
    if (typeof key !== 'string') return fields
    offset = skipWhitespace(raw, keyToken.end)
    if (raw[offset] !== ':') return fields
    offset = skipWhitespace(raw, offset + 1)
    const valueToken = readJsonValue(raw, offset)
    if (!valueToken) return fields
    const value = parseJsonToken(valueToken.source)
    fields.push({key, value: value === invalidToken ? null : value})
    offset = skipWhitespace(raw, valueToken.end)
    if (raw[offset] === '}') return fields
    if (raw[offset] !== ',') return fields
    offset = skipWhitespace(raw, offset + 1)
  }
  return fields
}

function readJsonValue(raw, start) {
  if (raw[start] === '"') return readJsonString(raw, start)
  if (raw[start] !== '{' && raw[start] !== '[') return readPrimitive(raw, start)
  const stack = [raw[start]]
  let offset = start + 1
  while (offset < raw.length) {
    if (raw[offset] === '"') {
      const stringToken = readJsonString(raw, offset)
      if (!stringToken) return null
      offset = stringToken.end
      continue
    }
    const character = raw[offset]
    if (character === '{' || character === '[') stack.push(character)
    else if (character === '}' || character === ']') {
      const opening = stack.pop()
      if ((opening === '{' && character !== '}') || (opening === '[' && character !== ']')) {
        return null
      }
      if (stack.length === 0) return {source: raw.slice(start, offset + 1), end: offset + 1}
    }
    offset += 1
  }
  return null
}

const invalidToken = Symbol('invalid-json-token')

function parseJsonToken(source) {
  try {
    return JSON.parse(source)
  } catch {
    return invalidToken
  }
}

function readJsonString(raw, start) {
  if (raw[start] !== '"') return null
  let escaped = false
  for (let offset = start + 1; offset < raw.length; offset += 1) {
    const character = raw[offset]
    if (escaped) {
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '"') {
      return {source: raw.slice(start, offset + 1), end: offset + 1}
    } else if (character.charCodeAt(0) <= 0x1f) {
      return null
    }
  }
  return null
}

function readPrimitive(raw, start) {
  let end = start
  while (end < raw.length && raw[end] !== ',' && raw[end] !== '}') end += 1
  let tokenStart = start
  let tokenEnd = end
  while (tokenStart < tokenEnd && /[\t\n\r ]/u.test(raw[tokenStart])) tokenStart += 1
  while (tokenEnd > tokenStart && /[\t\n\r ]/u.test(raw[tokenEnd - 1])) tokenEnd -= 1
  const source = raw.slice(tokenStart, tokenEnd)
  return source ? {source, end} : null
}

function skipWhitespace(raw, start) {
  let offset = start
  while (offset < raw.length && /[\t\n\r ]/u.test(raw[offset])) offset += 1
  return offset
}
