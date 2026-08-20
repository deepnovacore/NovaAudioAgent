import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  CAMERA_FRAME_MAGIC,
  CAMERA_HEIGHT,
  CAMERA_JPEG_QUALITY,
  CAMERA_WIDTH,
  MAX_CAMERA_HEADER_BYTES,
  MAX_CAMERA_JPEG_BYTES,
  MAX_CAMERA_POSITION_MS,
  MAX_CAMERA_WIRE_BYTES,
  CameraWireError,
  decodeCameraFrame,
  encodeCameraFrame,
  parseCameraCapture,
  parseCameraError,
  serializeCameraCapture,
  serializeCameraError,
} from '../src/desktop-camera.js'

const REQUEST_ID = 'camera-17'
const JPEG = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])
const HEADER = {
  type: 'camera.frame',
  request_id: REQUEST_ID,
  media_type: 'image/jpeg',
  width: CAMERA_WIDTH,
  height: CAMERA_HEIGHT,
} as const

function frameWithHeader(header: unknown, jpeg = JPEG): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  return frameWithHeaderBytes(headerBytes, jpeg)
}

function frameWithHeaderBytes(headerBytes: Uint8Array, jpeg = JPEG): Uint8Array {
  const wire = new Uint8Array(CAMERA_FRAME_MAGIC.byteLength + 2 + headerBytes.byteLength + jpeg.byteLength)
  wire.set(CAMERA_FRAME_MAGIC)
  new DataView(wire.buffer).setUint16(CAMERA_FRAME_MAGIC.byteLength, headerBytes.byteLength, false)
  wire.set(headerBytes, CAMERA_FRAME_MAGIC.byteLength + 2)
  wire.set(jpeg, CAMERA_FRAME_MAGIC.byteLength + 2 + headerBytes.byteLength)
  return wire
}

function errorIsSafe(injected: string): (error: unknown) => boolean {
  return error => error instanceof CameraWireError
    && !error.message.includes(injected)
}

test('camera frame codec emits the exact v1 wire layout and copies decoded JPEG', () => {
  assert.deepEqual([...CAMERA_FRAME_MAGIC], [0x4e, 0x56, 0x43, 0x41, 0x4d, 0x01, 0x0d, 0x0a])
  assert.equal(CAMERA_WIDTH, 1280)
  assert.equal(CAMERA_HEIGHT, 720)
  assert.equal(CAMERA_JPEG_QUALITY, 0.8)
  assert.equal(MAX_CAMERA_WIRE_BYTES, 8 + 2 + 1024 + 2 * 1024 * 1024)

  const wire = encodeCameraFrame({request_id: REQUEST_ID, payload: JPEG})
  const expectedHeader = JSON.stringify(HEADER)
  const expectedHeaderBytes = new TextEncoder().encode(expectedHeader)
  assert.deepEqual([...wire.subarray(0, 8)], [...CAMERA_FRAME_MAGIC])
  assert.equal(new DataView(wire.buffer, wire.byteOffset, wire.byteLength).getUint16(8, false), expectedHeaderBytes.byteLength)
  assert.equal(new TextDecoder().decode(wire.subarray(10, 10 + expectedHeaderBytes.byteLength)), expectedHeader)
  assert.deepEqual([...wire.subarray(10 + expectedHeaderBytes.byteLength)], [...JPEG])

  const decoded = decodeCameraFrame(wire)
  assert.deepEqual(decoded, {...HEADER, payload: JPEG})
  assert.notEqual(decoded.payload.buffer, wire.buffer)
  const firstPayloadByte = decoded.payload[0]
  wire[wire.byteLength - JPEG.byteLength] = 0
  assert.equal(decoded.payload[0], firstPayloadByte)
})

test('camera frame codec enforces request id, exact header keys and literals', () => {
  assert.equal(decodeCameraFrame(encodeCameraFrame({
    request_id: `camera-${'x'.repeat(57)}`,
    payload: JPEG,
  })).request_id.length, 64)
  const invalidHeaders: readonly unknown[] = [
    {...HEADER, extra: true},
    {type: 'camera.frame', request_id: REQUEST_ID, media_type: 'image/jpeg', width: 1280},
    {...HEADER, type: 'camera.other'},
    {...HEADER, media_type: 'image/png'},
    {...HEADER, request_id: 'other-17'},
    {...HEADER, request_id: 'camera-一'},
    {...HEADER, request_id: `camera-${'x'.repeat(58)}`},
    {...HEADER, width: '1280'},
    {...HEADER, width: 1280.5},
    {...HEADER, width: 1279},
    {...HEADER, height: '720'},
    {...HEADER, height: 720.5},
    {...HEADER, height: 719},
    null,
    [],
  ]
  for (const header of invalidHeaders) {
    assert.throws(() => decodeCameraFrame(frameWithHeader(header)), CameraWireError)
  }
  assert.throws(() => encodeCameraFrame({request_id: 'camera-device-/private/camera', payload: JPEG}),
    errorIsSafe('/private/camera'))
})

test('camera frame decoder fails closed at framing, UTF-8, JSON and JPEG boundaries', () => {
  const valid = encodeCameraFrame({request_id: REQUEST_ID, payload: JPEG})
  for (let length = 0; length < CAMERA_FRAME_MAGIC.byteLength + 2; length += 1) {
    assert.throws(() => decodeCameraFrame(valid.subarray(0, length)), CameraWireError)
  }
  const badMagic = new Uint8Array(valid)
  badMagic[0] = (badMagic[0] ?? 0) ^ 0xff
  assert.throws(() => decodeCameraFrame(badMagic), CameraWireError)
  const badVersion = new Uint8Array(valid)
  badVersion[5] = 2
  assert.throws(() => decodeCameraFrame(badVersion), CameraWireError)

  const zeroHeader = new Uint8Array(valid)
  new DataView(zeroHeader.buffer).setUint16(8, 0, false)
  assert.throws(() => decodeCameraFrame(zeroHeader), CameraWireError)
  const oneHeader = new Uint8Array(valid)
  new DataView(oneHeader.buffer).setUint16(8, 1, false)
  assert.throws(() => decodeCameraFrame(oneHeader), CameraWireError)
  const hugeHeader = new Uint8Array(valid)
  new DataView(hugeHeader.buffer).setUint16(8, MAX_CAMERA_HEADER_BYTES + 1, false)
  assert.throws(() => decodeCameraFrame(hugeHeader), CameraWireError)

  const invalidUtf8 = frameWithHeader(HEADER)
  const headerLength = new DataView(invalidUtf8.buffer).getUint16(8, false)
  invalidUtf8[10] = 0xc0
  invalidUtf8[11] = 0xaf
  assert.ok(headerLength > 2)
  assert.throws(() => decodeCameraFrame(invalidUtf8), CameraWireError)
  const invalidJsonHeader = new TextEncoder().encode('{]')
  const invalidJson = new Uint8Array(10 + invalidJsonHeader.byteLength + JPEG.byteLength)
  invalidJson.set(CAMERA_FRAME_MAGIC)
  new DataView(invalidJson.buffer).setUint16(8, invalidJsonHeader.byteLength, false)
  invalidJson.set(invalidJsonHeader, 10)
  invalidJson.set(JPEG, 10 + invalidJsonHeader.byteLength)
  assert.throws(() => decodeCameraFrame(invalidJson), CameraWireError)

  const missingPayload = frameWithHeader(HEADER, new Uint8Array())
  assert.throws(() => decodeCameraFrame(missingPayload), CameraWireError)
  assert.throws(() => decodeCameraFrame(frameWithHeader(HEADER, new Uint8Array([0xff, 0xd8, 0x00]))), CameraWireError)
  assert.throws(() => decodeCameraFrame(frameWithHeader(HEADER, new Uint8Array([0x00, 0xd8, 0xff, 0xd9]))), CameraWireError)
  assert.throws(() => decodeCameraFrame(frameWithHeader(HEADER, new Uint8Array([0xff, 0xd8, 0xff, 0x00]))), CameraWireError)
})

test('camera frame codec accepts each byte limit and rejects one byte over', () => {
  const canonicalHeader = new TextEncoder().encode(JSON.stringify(HEADER))
  const maximumHeader = new Uint8Array(MAX_CAMERA_HEADER_BYTES)
  maximumHeader.fill(0x20)
  maximumHeader.set(canonicalHeader)
  assert.equal(decodeCameraFrame(frameWithHeaderBytes(maximumHeader)).request_id, REQUEST_ID)
  const oversizedHeader = new Uint8Array(MAX_CAMERA_HEADER_BYTES + 1)
  oversizedHeader.fill(0x20)
  oversizedHeader.set(canonicalHeader)
  assert.throws(() => decodeCameraFrame(frameWithHeaderBytes(oversizedHeader)), CameraWireError)

  const maximumJpeg = new Uint8Array(MAX_CAMERA_JPEG_BYTES)
  maximumJpeg.set([0xff, 0xd8])
  maximumJpeg.set([0xff, 0xd9], maximumJpeg.byteLength - 2)
  const maximumWire = frameWithHeaderBytes(maximumHeader, maximumJpeg)
  assert.equal(maximumWire.byteLength, MAX_CAMERA_WIRE_BYTES)
  assert.equal(decodeCameraFrame(maximumWire).payload.byteLength, MAX_CAMERA_JPEG_BYTES)

  assert.equal(decodeCameraFrame(frameWithHeader(HEADER, new Uint8Array([0xff, 0xd8, 0xff, 0xd9])))
    .payload.byteLength, 4)

  const oversizedJpeg = new Uint8Array(MAX_CAMERA_JPEG_BYTES + 1)
  oversizedJpeg.set([0xff, 0xd8])
  oversizedJpeg.set([0xff, 0xd9], oversizedJpeg.byteLength - 2)
  assert.throws(() => encodeCameraFrame({request_id: REQUEST_ID, payload: oversizedJpeg}), CameraWireError)

  const overWire = new Uint8Array(MAX_CAMERA_WIRE_BYTES + 1)
  overWire.set(CAMERA_FRAME_MAGIC)
  assert.throws(() => decodeCameraFrame(overWire), CameraWireError)
})

test('camera capture text grammar is compact, deterministic and exact', () => {
  const local = '{"type":"camera.capture","request_id":"camera-17","source":"local"}'
  const file = '{"type":"camera.capture","request_id":"camera-18","source":"file","position_ms":2500}'
  assert.equal(serializeCameraCapture({request_id: 'camera-17', source: 'local'}), local)
  assert.equal(serializeCameraCapture({request_id: 'camera-18', source: 'file', position_ms: 2500}), file)
  assert.deepEqual(parseCameraCapture(local), {type: 'camera.capture', request_id: 'camera-17', source: 'local'})
  assert.deepEqual(parseCameraCapture(file), {
    type: 'camera.capture', request_id: 'camera-18', source: 'file', position_ms: 2500,
  })
  assert.equal(parseCameraCapture(
    '{"type":"camera.capture","request_id":"camera-18","source":"file","position_ms":-0}',
  ).source, 'file')

  for (const raw of [
    '{"type":"camera.capture","request_id":"camera-17","source":"local","position_ms":0}',
    '{"type":"camera.capture","request_id":"camera-17","source":"file"}',
    '{"type":"camera.capture","request_id":"camera-17","source":"file","position_ms":-1}',
    `{"type":"camera.capture","request_id":"camera-17","source":"file","position_ms":${MAX_CAMERA_POSITION_MS + 1}}`,
    '{"type":"camera.capture","request_id":"camera-17","source":"file","position_ms":1.0}',
    '{"type":"camera.capture","request_id":"camera-17","source":"file","position_ms":"1"}',
    '{"type":"camera.capture","request_id":"camera-17","source":"device"}',
    '{"type":"camera.capture","request_id":"camera-一","source":"local"}',
    '{"type":"camera.capture","request_id":"camera-17","source":"local","extra":true}',
  ]) assert.throws(() => parseCameraCapture(raw), CameraWireError)

  const upperBound = parseCameraCapture(
    `{"type":"camera.capture","request_id":"camera-17","source":"file","position_ms":${MAX_CAMERA_POSITION_MS}}`,
  )
  assert.equal(upperBound.source, 'file')
  if (upperBound.source === 'file') assert.equal(upperBound.position_ms, MAX_CAMERA_POSITION_MS)
  assert.throws(() => serializeCameraCapture({request_id: 'camera-17', source: 'file', position_ms: -1}), CameraWireError)
})

test('camera error text grammar has one stable credential-free error', () => {
  const raw = '{"type":"camera.error","request_id":"camera-17","error":"capture_unavailable"}'
  assert.equal(serializeCameraError({request_id: REQUEST_ID}), raw)
  assert.deepEqual(parseCameraError(raw), {
    type: 'camera.error', request_id: REQUEST_ID, error: 'capture_unavailable',
  })
  for (const invalid of [
    '{"type":"camera.error","request_id":"camera-17","error":"permission_denied"}',
    '{"type":"camera.error","request_id":"camera-17","error":"capture_unavailable","path":"/secret/file"}',
    '{"type":"camera.error","request_id":"other-17","error":"capture_unavailable"}',
    '[]',
  ]) assert.throws(() => parseCameraError(invalid), errorIsSafe('/secret/file'))
})
