import { randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { isWellFormed, stripLikePython } from '../../python-text.js'
import { MAX_REALTIME_PCM_BYTES } from '../protocol.js'
import {
  MAX_VOLCENGINE_WIRE_FRAME_BYTES,
  pcm16BytesForDuration,
  volcengineInputPcm,
  type Pcm16MonoFrame,
} from './audio.js'
import {
  DEFAULT_VOLC_CLOSE_TIMEOUT_MS,
  DEFAULT_VOLC_CONNECT_TIMEOUT_MS,
  DEFAULT_VOLC_RECEIVE_TIMEOUT_MS,
  webSocketVolcBinaryConnector,
  type VolcBinaryConnector,
  type VolcBinarySocket,
} from './websocket.js'

export const MAX_VOLCENGINE_JSON_BYTES = 1_024 * 1_024

export interface AsrTranscript {
  readonly text: string
  readonly final: boolean
}

export class DoubaoAsrError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DoubaoAsrError'
  }
}

export class DoubaoAsrProtocol {
  fullRequest(input: {
    readonly sequence: number
    readonly sampleRate: 16_000
    readonly userId: string
  }): Uint8Array {
    requirePositiveSequence(input.sequence)
    if (input.sampleRate !== 16_000 || !isWellFormed(input.userId)) {
      throw new DoubaoAsrError('豆包 ASR 请求参数无效')
    }
    const payload = {
      user: {uid: input.userId},
      audio: {format: 'pcm', rate: 16_000, bits: 16, channel: 1, codec: 'raw'},
      request: {
        model_name: 'bigmodel',
        enable_punc: true,
        enable_itn: true,
        show_utterances: true,
        result_type: 'full',
      },
    }
    const plain = new TextEncoder().encode(JSON.stringify(payload))
    if (plain.byteLength > MAX_VOLCENGINE_JSON_BYTES) {
      throw new DoubaoAsrError('豆包 ASR 请求数据过大')
    }
    return outboundFrame([0x11, 0x11, 0x11, 0], input.sequence, gzipSync(plain))
  }

  audio(input: {
    readonly sequence: number
    readonly audio: Pcm16MonoFrame<16_000>
    readonly final: boolean
  }): Uint8Array {
    requirePositiveSequence(input.sequence)
    if (input.audio.format.sampleRate !== 16_000
      || input.audio.format.encoding !== 'pcm_s16le' || input.audio.format.channels !== 1
      || !(input.audio.pcm instanceof Uint8Array) || input.audio.pcm.byteLength === 0
      || input.audio.pcm.byteLength % 2 !== 0
      || input.audio.pcm.byteLength > MAX_REALTIME_PCM_BYTES) {
      throw new DoubaoAsrError('豆包 ASR 音频参数无效')
    }
    const flags = input.final ? 0x03 : 0x01
    const sequence = input.final ? -input.sequence : input.sequence
    return outboundFrame([0x11, 0x20 | flags, 0x11, 0], sequence, gzipSync(input.audio.pcm))
  }

  decode(frame: Uint8Array): AsrTranscript | null {
    if (!(frame instanceof Uint8Array) || frame.byteLength > MAX_VOLCENGINE_WIRE_FRAME_BYTES
      || frame.byteLength < 12 || frame[0] !== 0x11) {
      throw new DoubaoAsrError('豆包 ASR 返回了无效协议帧')
    }
    const messageType = frame[1]! >> 4
    const flags = frame[1]! & 0x0f
    const compression = frame[2]! & 0x0f
    if (messageType === 0x0f) throw new DoubaoAsrError('豆包 ASR 请求失败')
    if (messageType !== 0x09 || (flags !== 0x01 && flags !== 0x03)) return null
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const sequence = view.getInt32(4)
    const size = view.getUint32(8)
    if (size > frame.byteLength - 12) {
      throw new DoubaoAsrError('豆包 ASR 返回了截断协议帧')
    }
    const encoded = frame.subarray(12, 12 + size)
    let payload: Uint8Array
    if (compression === 0x01) {
      try {
        payload = gunzipSync(encoded, {maxOutputLength: MAX_VOLCENGINE_JSON_BYTES + 1})
      } catch {
        throw new DoubaoAsrError('豆包 ASR 返回了无效压缩数据')
      }
    } else {
      payload = new Uint8Array(encoded)
    }
    if (payload.byteLength > MAX_VOLCENGINE_JSON_BYTES) {
      throw new DoubaoAsrError('豆包 ASR 返回了无效结果')
    }
    let decoded: unknown
    try {
      const text = new TextDecoder('utf-8', {fatal: true}).decode(payload)
      decoded = JSON.parse(text) as unknown
    } catch {
      throw new DoubaoAsrError('豆包 ASR 返回了无效 JSON')
    }
    if (!isObject(decoded)) throw new DoubaoAsrError('豆包 ASR 返回了无效结果')
    raiseProviderError(decoded)
    const nested = nestedBody(decoded)
    if (nested !== decoded) raiseProviderError(nested)
    const text = extractText(decoded)
    const final = flags === 0x03 || sequence < 0 || decoded.is_last_package === true
    return text.length > 0 || final ? {text, final} : null
  }
}

export const MAX_ASR_STAGED_BYTES = MAX_REALTIME_PCM_BYTES * 2

export type DoubaoAsrFailureCode =
  | 'configuration'
  | 'connect'
  | 'handshake'
  | 'session'
  | 'receive'

export class DoubaoAsrFailure extends Error {
  readonly code: DoubaoAsrFailureCode

  constructor(code: DoubaoAsrFailureCode) {
    super(`Doubao ASR ${code} failure`)
    this.name = 'DoubaoAsrFailure'
    this.code = code
  }
}

export function asrHeaders(input: {
  readonly apiKey: string
  readonly resourceId: string
  readonly idFactory?: () => string
}): Readonly<Record<string, string>> {
  const idFactory = input.idFactory ?? randomUUID
  if (!nonblank(input.apiKey) || !nonblank(input.resourceId)) {
    throw new DoubaoAsrFailure('configuration')
  }
  const connectId = idFactory()
  if (!nonblank(connectId) || !isWellFormed(connectId)) {
    throw new DoubaoAsrFailure('configuration')
  }
  return Object.freeze({
    'X-Api-Key': input.apiKey,
    'X-Api-Resource-Id': input.resourceId,
    'X-Api-Connect-Id': connectId,
  })
}

export interface DoubaoAsrClientOptions {
  readonly endpoint: string
  readonly apiKey: string
  readonly resourceId: string
  readonly sampleRate?: 16_000
  readonly chunkMs: number
  readonly connectTimeoutMs?: number
  readonly receiveTimeoutMs?: number
  readonly connector?: VolcBinaryConnector
  readonly idFactory?: () => string
}

export class DoubaoAsrClient {
  readonly #options: Required<Omit<DoubaoAsrClientOptions, 'connector' | 'idFactory'>>
  readonly #connector: VolcBinaryConnector
  readonly #idFactory: () => string
  readonly #chunkBytes: number
  readonly #protocol = new DoubaoAsrProtocol()

  constructor(options: DoubaoAsrClientOptions) {
    const sampleRate = options.sampleRate ?? 16_000
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_VOLC_CONNECT_TIMEOUT_MS
    const receiveTimeoutMs = options.receiveTimeoutMs ?? DEFAULT_VOLC_RECEIVE_TIMEOUT_MS
    if (!nonblank(options.endpoint) || !nonblank(options.apiKey) || !nonblank(options.resourceId)
      || sampleRate !== 16_000 || !Number.isSafeInteger(options.chunkMs) || options.chunkMs < 1
      || !positiveMilliseconds(connectTimeoutMs) || !positiveMilliseconds(receiveTimeoutMs)) {
      throw new DoubaoAsrFailure('configuration')
    }
    let chunkBytes: number
    try {
      chunkBytes = pcm16BytesForDuration(sampleRate, options.chunkMs)
    } catch {
      throw new DoubaoAsrFailure('configuration')
    }
    if (chunkBytes > MAX_REALTIME_PCM_BYTES) throw new DoubaoAsrFailure('configuration')
    this.#options = {
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      resourceId: options.resourceId,
      sampleRate,
      chunkMs: options.chunkMs,
      connectTimeoutMs,
      receiveTimeoutMs,
    }
    this.#connector = options.connector ?? webSocketVolcBinaryConnector
    this.#idFactory = options.idFactory ?? randomUUID
    this.#chunkBytes = chunkBytes
  }

  async open(signal?: AbortSignal): Promise<DoubaoAsrSession> {
    throwIfAborted(signal)
    const connectionSignal = signal ?? new AbortController().signal
    let socket: VolcBinarySocket | undefined
    let phase: DoubaoAsrFailureCode = 'connect'
    try {
      socket = await this.#connector({
        endpoint: this.#options.endpoint,
        headers: {...asrHeaders({
          apiKey: this.#options.apiKey,
          resourceId: this.#options.resourceId,
          idFactory: this.#idFactory,
        })},
        openTimeoutMs: this.#options.connectTimeoutMs,
        closeTimeoutMs: DEFAULT_VOLC_CLOSE_TIMEOUT_MS,
        maxFrameBytes: MAX_VOLCENGINE_WIRE_FRAME_BYTES,
        signal: connectionSignal,
      })
      phase = 'handshake'
      const userId = this.#idFactory()
      if (!nonblank(userId) || !isWellFormed(userId)) throw new DoubaoAsrFailure('configuration')
      await socket.send(this.#protocol.fullRequest({
        sequence: 1,
        sampleRate: this.#options.sampleRate,
        userId,
      }), signal)
      const acknowledgement = await receiveWithTimeout(
        socket, this.#options.receiveTimeoutMs, signal, 'handshake',
      )
      this.#protocol.decode(acknowledgement)
      return new DoubaoAsrSession({
        socket,
        protocol: this.#protocol,
        sequence: 2,
        chunkBytes: this.#chunkBytes,
        receiveTimeoutMs: this.#options.receiveTimeoutMs,
      })
    } catch (error) {
      if (socket !== undefined) {
        try {
          await socket.close()
        } catch {
          // The original connection or handshake verdict remains authoritative.
        }
      }
      throwIfAborted(signal)
      if (error instanceof DoubaoAsrFailure) throw error
      throw new DoubaoAsrFailure(phase)
    }
  }
}

export class DoubaoAsrSession {
  readonly #socket: VolcBinarySocket
  readonly #protocol: DoubaoAsrProtocol
  readonly #chunkBytes: number
  readonly #receiveTimeoutMs: number
  #sequence: number
  #pending = new Uint8Array()
  #writing: Promise<void> = Promise.resolve()
  #finished = false
  #closed = false
  #eventsClaimed = false
  #closePromise: Promise<void> | undefined

  constructor(input: {
    readonly socket: VolcBinarySocket
    readonly protocol: DoubaoAsrProtocol
    readonly sequence: number
    readonly chunkBytes: number
    readonly receiveTimeoutMs: number
  }) {
    this.#socket = input.socket
    this.#protocol = input.protocol
    this.#sequence = input.sequence
    this.#chunkBytes = input.chunkBytes
    this.#receiveTimeoutMs = input.receiveTimeoutMs
  }

  append(pcm: Uint8Array, signal?: AbortSignal): Promise<void> {
    let owned: Pcm16MonoFrame<16_000>
    try {
      owned = volcengineInputPcm(pcm)
    } catch {
      return Promise.reject(new DoubaoAsrFailure('session'))
    }
    return this.#serialized(async () => {
      throwIfAborted(signal)
      if (this.#finished || this.#closed) throw new DoubaoAsrFailure('session')
      const staged = new Uint8Array(this.#pending.byteLength + owned.pcm.byteLength)
      staged.set(this.#pending)
      staged.set(owned.pcm, this.#pending.byteLength)
      if (staged.byteLength > this.#chunkBytes + MAX_REALTIME_PCM_BYTES
        || staged.byteLength > MAX_ASR_STAGED_BYTES) {
        throw new DoubaoAsrFailure('session')
      }
      this.#pending = staged
      while (this.#pending.byteLength > this.#chunkBytes) {
        const chunk = volcengineInputPcm(this.#pending.subarray(0, this.#chunkBytes))
        try {
          await this.#socket.send(this.#protocol.audio({
            sequence: this.#sequence,
            audio: chunk,
            final: false,
          }), signal)
        } catch {
          throwIfAborted(signal)
          throw new DoubaoAsrFailure('session')
        }
        this.#pending = new Uint8Array(this.#pending.subarray(this.#chunkBytes))
        this.#sequence += 1
      }
    })
  }

  finish(signal?: AbortSignal): Promise<void> {
    return this.#serialized(async () => {
      throwIfAborted(signal)
      if (this.#closed) throw new DoubaoAsrFailure('session')
      if (this.#finished) return
      if (this.#pending.byteLength === 0) throw new DoubaoAsrFailure('session')
      try {
        await this.#socket.send(this.#protocol.audio({
          sequence: this.#sequence,
          audio: volcengineInputPcm(this.#pending),
          final: true,
        }), signal)
      } catch {
        throwIfAborted(signal)
        throw new DoubaoAsrFailure('session')
      }
      this.#pending = new Uint8Array()
      this.#finished = true
    })
  }

  async *events(signal?: AbortSignal): AsyncIterable<AsrTranscript> {
    if (this.#eventsClaimed) throw new DoubaoAsrFailure('session')
    this.#eventsClaimed = true
    while (!this.#closed) {
      const raw = await receiveWithTimeout(
        this.#socket, this.#receiveTimeoutMs, signal, 'receive',
      )
      let event: AsrTranscript | null
      try {
        event = this.#protocol.decode(raw)
      } catch {
        throw new DoubaoAsrFailure('receive')
      }
      if (event === null) continue
      yield event
      if (event.final) return
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closed = true
    this.#pending = new Uint8Array()
    this.#closePromise = this.#socket.close().catch(() => {
      throw new DoubaoAsrFailure('session')
    })
    return this.#closePromise
  }

  #serialized(operation: () => Promise<void>): Promise<void> {
    const result = this.#writing.then(operation)
    this.#writing = result.then(() => undefined, () => undefined)
    return result
  }
}

async function receiveWithTimeout(
  socket: VolcBinarySocket,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  code: 'handshake' | 'receive',
): Promise<Uint8Array> {
  throwIfAborted(signal)
  const timeout = new AbortController()
  const combined = signal === undefined ? timeout.signal : AbortSignal.any([timeout.signal, signal])
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  try {
    return await socket.receive(combined)
  } catch {
    throwIfAborted(signal)
    throw new DoubaoAsrFailure(code)
  } finally {
    clearTimeout(timer)
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('This operation was aborted', 'AbortError')
}

function positiveMilliseconds(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && stripLikePython(value).length > 0
}

const MAX_SIGNED_SEQUENCE = 2_147_483_647

function requirePositiveSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > MAX_SIGNED_SEQUENCE) {
    throw new DoubaoAsrError('豆包 ASR 请求序号无效')
  }
}

function outboundFrame(
  header: readonly [number, number, number, number],
  sequence: number,
  payload: Uint8Array,
): Uint8Array {
  const size = 12 + payload.byteLength
  if (size > MAX_VOLCENGINE_WIRE_FRAME_BYTES) throw new DoubaoAsrError('豆包 ASR 请求数据过大')
  const frame = new Uint8Array(size)
  frame.set(header, 0)
  const view = new DataView(frame.buffer)
  view.setInt32(4, sequence)
  view.setUint32(8, payload.byteLength)
  frame.set(payload, 12)
  return frame
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function raiseProviderError(body: Record<string, unknown>): void {
  const code = body.code
  if (code !== undefined && code !== null && code !== 0 && code !== '0'
    && code !== 20_000_000 && code !== '20000000') {
    throw new DoubaoAsrError('豆包 ASR 请求失败')
  }
}

function nestedBody(body: Record<string, unknown>): Record<string, unknown> {
  let nested = body.payload_msg
  if (typeof nested === 'string') {
    try {
      nested = JSON.parse(nested) as unknown
    } catch {
      nested = null
    }
  }
  return isObject(nested) ? nested : body
}

function extractText(outer: Record<string, unknown>): string {
  const body = nestedBody(outer)
  const result = body.result
  if (Array.isArray(result)) {
    let joined = ''
    for (const item of result) {
      if (!isObject(item)) continue
      const value = item.text
      if (value === undefined) continue
      if (typeof value !== 'string') throw new DoubaoAsrError('豆包 ASR 返回了无效结果')
      joined += value
    }
    return stripLikePython(joined)
  }
  if (isObject(result)) {
    if (result.text !== undefined) {
      if (typeof result.text !== 'string') throw new DoubaoAsrError('豆包 ASR 返回了无效结果')
      return stripLikePython(result.text)
    }
    if (result.utterances !== undefined) {
      if (!Array.isArray(result.utterances)) {
        throw new DoubaoAsrError('豆包 ASR 返回了无效结果')
      }
      let joined = ''
      for (const item of result.utterances) {
        if (!isObject(item)) continue
        const value = item.text
        if (value === undefined) continue
        if (typeof value !== 'string') throw new DoubaoAsrError('豆包 ASR 返回了无效结果')
        joined += value
      }
      return stripLikePython(joined)
    }
  }
  if (body.text === undefined) return ''
  if (typeof body.text !== 'string') throw new DoubaoAsrError('豆包 ASR 返回了无效结果')
  return stripLikePython(body.text)
}
