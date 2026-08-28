export const CAMERA_FRAME_MAGIC = new Uint8Array([
  0x4e, 0x56, 0x43, 0x41, 0x4d, 0x01, 0x0d, 0x0a,
])
export const CAMERA_WIDTH = 1280
export const CAMERA_HEIGHT = 720
export const CAMERA_JPEG_QUALITY = 0.8
export const MAX_CAMERA_HEADER_BYTES = 1024
export const MAX_CAMERA_JPEG_BYTES = 2 * 1024 * 1024
export const MAX_CAMERA_WIRE_BYTES = CAMERA_FRAME_MAGIC.byteLength + 2
  + MAX_CAMERA_HEADER_BYTES + MAX_CAMERA_JPEG_BYTES
export const CAMERA_CAPTURE_TIMEOUT_MS = 5_000
export const CAMERA_PERMISSION_TIMEOUT_MS = 30_000
export const MAX_PENDING_CAMERA_REQUESTS = 8
export const MAX_CAMERA_POSITION_MS = 86_400_000
export const MAX_CAMERA_LATE_RESPONSES = 32
export const MAX_DESKTOP_INBOUND_BYTES = 4 * 1024 * 1024

const requestIdPattern = /^camera-[A-Za-z0-9_-]+$/u
const frameHeaderKeys = ['height', 'media_type', 'request_id', 'type', 'width'] as const
const cameraErrorKeys = ['error', 'request_id', 'type'] as const
const localCaptureKeys = ['request_id', 'source', 'type'] as const
const fileCaptureKeys = ['position_ms', 'request_id', 'source', 'type'] as const
const cameraPermissionRequestKeys = ['request_id', 'type'] as const
const cameraPermissionResultKeys = ['request_id', 'status', 'type'] as const

export type CameraPermissionStatus = 'granted' | 'denied' | 'restricted' | 'unavailable'

export class CameraWireError extends Error {
  constructor() {
    super('desktop camera protocol is invalid')
    this.name = 'CameraWireError'
  }
}

export interface CameraFrameHeader {
  readonly type: 'camera.frame'
  readonly request_id: string
  readonly media_type: 'image/jpeg'
  readonly width: typeof CAMERA_WIDTH
  readonly height: typeof CAMERA_HEIGHT
}

export interface CameraFrame extends CameraFrameHeader {
  readonly payload: Uint8Array
}

export interface CameraFrameInput {
  readonly request_id: string
  readonly payload: Uint8Array
}

export interface LocalCameraCapture {
  readonly type: 'camera.capture'
  readonly request_id: string
  readonly source: 'local'
}

export interface FileCameraCapture {
  readonly type: 'camera.capture'
  readonly request_id: string
  readonly source: 'file'
  readonly position_ms: number
}

export type CameraCapture = LocalCameraCapture | FileCameraCapture
export type CameraCaptureInput = Omit<LocalCameraCapture, 'type'> | Omit<FileCameraCapture, 'type'>

export interface CameraErrorFrame {
  readonly type: 'camera.error'
  readonly request_id: string
  readonly error: 'capture_unavailable'
}

export interface CameraPermissionRequest {
  readonly type: 'camera.permission'
  readonly request_id: string
}

export interface CameraPermissionResult {
  readonly type: 'camera.permission_result'
  readonly request_id: string
  readonly status: CameraPermissionStatus
}

export function encodeCameraFrame(input: CameraFrameInput): Uint8Array {
  validateRequestId(input.request_id)
  validateJpeg(input.payload)
  const header = JSON.stringify({
    type: 'camera.frame',
    request_id: input.request_id,
    media_type: 'image/jpeg',
    width: CAMERA_WIDTH,
    height: CAMERA_HEIGHT,
  })
  const headerBytes = new TextEncoder().encode(header)
  if (headerBytes.byteLength < 2 || headerBytes.byteLength > MAX_CAMERA_HEADER_BYTES) invalid()
  const wireLength = CAMERA_FRAME_MAGIC.byteLength + 2 + headerBytes.byteLength + input.payload.byteLength
  if (wireLength > MAX_CAMERA_WIRE_BYTES) invalid()
  const wire = new Uint8Array(wireLength)
  wire.set(CAMERA_FRAME_MAGIC, 0)
  new DataView(wire.buffer).setUint16(CAMERA_FRAME_MAGIC.byteLength, headerBytes.byteLength, false)
  wire.set(headerBytes, CAMERA_FRAME_MAGIC.byteLength + 2)
  wire.set(input.payload, CAMERA_FRAME_MAGIC.byteLength + 2 + headerBytes.byteLength)
  return wire
}

export function decodeCameraFrame(raw: Uint8Array): CameraFrame {
  if (!(raw instanceof Uint8Array) || raw.byteLength > MAX_CAMERA_WIRE_BYTES) invalid()
  const prefixBytes = CAMERA_FRAME_MAGIC.byteLength
  if (raw.byteLength < prefixBytes + 2) invalid()
  for (let index = 0; index < prefixBytes; index += 1) {
    if (raw[index] !== CAMERA_FRAME_MAGIC[index]) invalid()
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const headerLength = view.getUint16(prefixBytes, false)
  if (headerLength < 2 || headerLength > MAX_CAMERA_HEADER_BYTES) invalid()
  const payloadOffset = prefixBytes + 2 + headerLength
  if (payloadOffset > raw.byteLength) invalid()
  let headerText: string
  try {
    headerText = new TextDecoder('utf-8', {fatal: true}).decode(raw.subarray(prefixBytes + 2, payloadOffset))
  } catch {
    invalid()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(headerText!) as unknown
  } catch {
    invalid()
  }
  if (!isExactObject(parsed, frameHeaderKeys)) invalid()
  if (parsed.type !== 'camera.frame' || parsed.media_type !== 'image/jpeg') invalid()
  validateRequestId(parsed.request_id)
  if (parsed.width !== CAMERA_WIDTH || !Number.isInteger(parsed.width)) invalid()
  if (parsed.height !== CAMERA_HEIGHT || !Number.isInteger(parsed.height)) invalid()
  const payload = raw.subarray(payloadOffset)
  validateJpeg(payload)
  return {
    type: 'camera.frame',
    request_id: parsed.request_id,
    media_type: 'image/jpeg',
    width: CAMERA_WIDTH,
    height: CAMERA_HEIGHT,
    payload: new Uint8Array(payload),
  }
}

export function serializeCameraCapture(input: CameraCaptureInput): string {
  validateRequestId(input.request_id)
  if (input.source === 'local') {
    if ('position_ms' in input) invalid()
    return JSON.stringify({type: 'camera.capture', request_id: input.request_id, source: 'local'})
  }
  if (input.source !== 'file' || !('position_ms' in input)) invalid()
  validatePosition(input.position_ms)
  return JSON.stringify({
    type: 'camera.capture',
    request_id: input.request_id,
    source: 'file',
    position_ms: input.position_ms,
  })
}

export function parseCameraCapture(raw: string): CameraCapture {
  const {value, integerSources} = parseCameraJson(raw, ['position_ms'])
  if (!isPlainObject(value) || value.type !== 'camera.capture') invalid()
  validateRequestId(value.request_id)
  if (value.source === 'local') {
    if (!hasExactKeys(value, localCaptureKeys)) invalid()
    return {type: 'camera.capture', request_id: value.request_id, source: 'local'}
  }
  if (value.source !== 'file' || !hasExactKeys(value, fileCaptureKeys)) invalid()
  validatePosition(value.position_ms)
  if (!/^(?:-?0|[1-9]\d*)$/u.test(integerSources.get('position_ms') ?? '')) invalid()
  return {
    type: 'camera.capture',
    request_id: value.request_id,
    source: 'file',
    position_ms: value.position_ms,
  }
}

export function serializeCameraError(input: {readonly request_id: string}): string {
  validateRequestId(input.request_id)
  return JSON.stringify({
    type: 'camera.error',
    request_id: input.request_id,
    error: 'capture_unavailable',
  })
}

export function parseCameraError(raw: string): CameraErrorFrame {
  const {value} = parseCameraJson(raw, [])
  if (!isExactObject(value, cameraErrorKeys)) invalid()
  if (value.type !== 'camera.error' || value.error !== 'capture_unavailable') invalid()
  validateRequestId(value.request_id)
  return {type: 'camera.error', request_id: value.request_id, error: 'capture_unavailable'}
}

export function serializeCameraPermissionRequest(input: {readonly request_id: string}): string {
  validateRequestId(input.request_id)
  return JSON.stringify({type: 'camera.permission', request_id: input.request_id})
}

export function parseCameraPermissionRequest(raw: string): CameraPermissionRequest {
  const {value} = parseCameraJson(raw, [])
  if (!isExactObject(value, cameraPermissionRequestKeys)) invalid()
  if (value.type !== 'camera.permission') invalid()
  validateRequestId(value.request_id)
  return {type: 'camera.permission', request_id: value.request_id}
}

export function serializeCameraPermissionResult(input: {
  readonly request_id: string
  readonly status: CameraPermissionStatus
}): string {
  validateRequestId(input.request_id)
  validateCameraPermissionStatus(input.status)
  return JSON.stringify({
    type: 'camera.permission_result',
    request_id: input.request_id,
    status: input.status,
  })
}

export function parseCameraPermissionResult(raw: string): CameraPermissionResult {
  const {value} = parseCameraJson(raw, [])
  if (!isExactObject(value, cameraPermissionResultKeys)) invalid()
  if (value.type !== 'camera.permission_result') invalid()
  validateRequestId(value.request_id)
  validateCameraPermissionStatus(value.status)
  return {
    type: 'camera.permission_result',
    request_id: value.request_id,
    status: value.status,
  }
}

export function hasCameraFrameMagic(raw: Uint8Array): boolean {
  if (raw.byteLength < CAMERA_FRAME_MAGIC.byteLength) return false
  for (let index = 0; index < CAMERA_FRAME_MAGIC.byteLength; index += 1) {
    if (raw[index] !== CAMERA_FRAME_MAGIC[index]) return false
  }
  return true
}

function validateRequestId(value: unknown): asserts value is string {
  if (typeof value !== 'string'
    || !requestIdPattern.test(value)
    || new TextEncoder().encode(value).byteLength > 64) invalid()
}

function validatePosition(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)
    || value < 0 || value > MAX_CAMERA_POSITION_MS) invalid()
}

function validateCameraPermissionStatus(value: unknown): asserts value is CameraPermissionStatus {
  if (
    value !== 'granted'
    && value !== 'denied'
    && value !== 'restricted'
    && value !== 'unavailable'
  ) invalid()
}

function validateJpeg(payload: unknown): asserts payload is Uint8Array {
  if (!(payload instanceof Uint8Array)
    || payload.byteLength < 4
    || payload.byteLength > MAX_CAMERA_JPEG_BYTES
    || payload[0] !== 0xff
    || payload[1] !== 0xd8
    || payload[payload.byteLength - 2] !== 0xff
    || payload[payload.byteLength - 1] !== 0xd9) invalid()
}

function parseCameraJson(raw: string, integerFields: readonly string[]): {
  readonly value: unknown
  readonly integerSources: ReadonlyMap<string, string>
} {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_CAMERA_HEADER_BYTES) invalid()
  const fields = new Set(integerFields)
  const candidates: {readonly holder: object; readonly key: string; readonly source: string}[] = []
  let value: unknown
  try {
    value = JSON.parse(raw, function cameraReviver(
      this: unknown,
      key: string,
      parsed: unknown,
      context?: {readonly source?: string},
    ): unknown {
      if (fields.has(key) && typeof this === 'object' && this !== null && context?.source !== undefined) {
        candidates.push({holder: this, key, source: context.source})
      }
      return parsed
    }) as unknown
  } catch {
    invalid()
  }
  const integerSources = new Map<string, string>()
  if (typeof value === 'object' && value !== null) {
    for (const candidate of candidates) {
      if (candidate.holder === value) integerSources.set(candidate.key, candidate.source)
    }
  }
  return {value, integerSources}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactObject<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): value is Record<Keys[number], unknown> {
  return isPlainObject(value) && hasExactKeys(value, keys)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function invalid(): never {
  throw new CameraWireError()
}
