import {readBoundedResponse} from '../../http/bounded-response.js'
import { randomUUID } from 'node:crypto'
import {reportUsage, type UsageReporter} from '../usage.js'
import { gzipSync, gunzipSync } from 'node:zlib'
import { isWellFormed, stripLikePython } from '../../text/python-text.js'
import type {AsrClient, AsrSession, AsrTranscript} from '../cascaded/ports.js'
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

export type {AsrTranscript} from '../cascaded/ports.js'

export class DoubaoAsrError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DoubaoAsrError'
  }
}

export interface AsrVoiceprint {
  readonly id: string
  readonly name: string
}

export class DoubaoAsrProtocol {
  constructor(readonly voiceprint?: AsrVoiceprint) {
    if (voiceprint && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(voiceprint.id)
      || !voiceprint.name.trim() || /^\d+$/.test(voiceprint.name)
      || voiceprint.name.length > 128 || /[\u0000-\u001f\u007f]/.test(voiceprint.name))) {
      throw new DoubaoAsrError('声纹 ID 或名称无效')
    }
  }

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
        ...(this.voiceprint ? {
          enable_nonstream: true, enable_speaker_info: true, ssd_mode: 2,
          voiceprints: [{id: this.voiceprint.id}],
        } : {}),
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

  decode(frame: Uint8Array, onFinalDuration?: (duration: number | undefined) => void): AsrTranscript | null {
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
    const final = flags === 0x03 || sequence < 0 || decoded.is_last_package === true
    if (final) {
      const info = nested.audio_info ?? decoded.audio_info
      const duration = isObject(info) ? info.duration : undefined
      onFinalDuration?.(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
        ? duration : undefined)
    }
    // Do not leak provisional or unidentified text to speculative recall or the LLM.
    if (this.voiceprint && !final) return null
    const text = this.voiceprint ? verifiedText(nested, this.voiceprint.name) : extractText(decoded)
    return text !== '' || final ? {text, final} : null
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
  readonly voiceprintHealthUrl?: string
  readonly voiceprint?: AsrVoiceprint
  readonly onUsage?: UsageReporter
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

export class DoubaoAsrClient implements AsrClient {
  readonly #options: Required<Omit<DoubaoAsrClientOptions, 'connector' | 'idFactory' | 'onUsage' | 'voiceprint' | 'voiceprintHealthUrl'>>
  readonly #onUsage: UsageReporter | undefined
  readonly #connector: VolcBinaryConnector
  readonly #idFactory: () => string
  readonly #chunkBytes: number
  readonly #protocol: DoubaoAsrProtocol
  readonly #plainProtocol = new DoubaoAsrProtocol()
  readonly #voiceprintEndpoint: string | undefined
  readonly #voiceprintHealthUrl: string | undefined
  #healthCheckedAt = 0
  #health = false
  #healthRefresh: Promise<void> | undefined

  constructor(options: DoubaoAsrClientOptions) {
    this.#protocol = new DoubaoAsrProtocol(options.voiceprint)
    this.#voiceprintHealthUrl = options.voiceprintHealthUrl
    if (this.#voiceprintHealthUrl && new URL(this.#voiceprintHealthUrl).protocol !== 'https:') throw new DoubaoAsrFailure('configuration')
    if (options.voiceprint && nonblank(options.endpoint)) {
      // Speaker verification needs the async endpoint; ordinary sessions keep the configured one.
      try {
        const url = new URL(options.endpoint)
        url.pathname = '/api/v3/sauc/bigmodel_async'
        this.#voiceprintEndpoint = url.href
      } catch {
        throw new DoubaoAsrFailure('configuration')
      }
    }
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
    this.#onUsage = options.onUsage
    this.#connector = options.connector ?? webSocketVolcBinaryConnector
    this.#idFactory = options.idFactory ?? randomUUID
    this.#chunkBytes = chunkBytes
  }

  async open(signal?: AbortSignal): Promise<DoubaoAsrSession> {
    throwIfAborted(signal)
    let protocol = this.#protocol
    if (protocol.voiceprint && this.#voiceprintHealthUrl) {
      // Only the first session waits; later ones use the cached verdict while it refreshes.
      if (this.#healthCheckedAt === 0) await this.#refreshHealth()
      else if (Date.now() - this.#healthCheckedAt > 30_000) void this.#refreshHealth()
      // Explicit product policy: upload-service failure disables the whole voiceprint feature.
      if (!this.#health) protocol = this.#plainProtocol
    }
    throwIfAborted(signal)
    const connectionSignal = signal ?? new AbortController().signal
    let socket: VolcBinarySocket | undefined
    let phase: DoubaoAsrFailureCode = 'connect'
    try {
      socket = await this.#connector({
        endpoint: protocol.voiceprint ? this.#voiceprintEndpoint! : this.#options.endpoint,
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
      await socket.send(protocol.fullRequest({
        sequence: 1,
        sampleRate: this.#options.sampleRate,
        userId,
      }), signal)
      const acknowledgement = await receiveWithTimeout(
        socket, this.#options.receiveTimeoutMs, signal, 'handshake',
      )
      protocol.decode(acknowledgement)
      return new DoubaoAsrSession({
        model: this.#options.resourceId,
        ...(this.#onUsage === undefined ? {} : {onUsage: this.#onUsage}),
        socket,
        protocol,
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

  #refreshHealth(): Promise<void> {
    this.#healthRefresh ??= (async () => {
      try {
        const healthSignal = AbortSignal.timeout(2500)
        const response = await fetch(this.#voiceprintHealthUrl!, {signal:healthSignal,redirect:'error',headers:{'Cache-Control':'no-store'}})
        const body = await readBoundedResponse(response, {limit:4096,signal:healthSignal,failure:code=>new Error(code)})
        const status = JSON.parse(new TextDecoder().decode(body)) as unknown
        this.#health = response.ok && isObject(status) && status.ok === true
      } catch {this.#health = false} finally {
        this.#healthCheckedAt = Date.now()
        this.#healthRefresh = undefined
      }
    })()
    return this.#healthRefresh
  }
}

export class DoubaoAsrSession implements AsrSession {
  readonly #onUsage: UsageReporter | undefined
  readonly #model: string
  readonly #usageId = randomUUID()
  #dispatched = false
  #usageReported = false
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
    readonly onUsage?: UsageReporter
    readonly model?: string
    readonly socket: VolcBinarySocket
    readonly protocol: DoubaoAsrProtocol
    readonly sequence: number
    readonly chunkBytes: number
    readonly receiveTimeoutMs: number
  }) {
    this.#onUsage = input.onUsage
    this.#model = input.model ?? 'volc.seedasr.sauc.duration'
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
          this.#dispatched = true
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
        this.#dispatched = true
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
    try {
      while (!this.#closed) {
        const raw = await receiveWithTimeout(
          this.#socket, this.#receiveTimeoutMs, signal, 'receive',
        )
        let event: AsrTranscript | null
        try {
          event = this.#protocol.decode(raw, duration => this.#reportUsage(duration))
        } catch {
          throw new DoubaoAsrFailure('receive')
        }
        if (event === null) continue
        yield event
        if (event.final) return
      }
    } finally {
      this.#reportUsage()
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closed = true
    this.#reportUsage()
    this.#pending = new Uint8Array()
    this.#closePromise = this.#socket.close().catch(() => {
      throw new DoubaoAsrFailure('session')
    })
    return this.#closePromise
  }

  #reportUsage(audioDurationMs?: number): void {
    if (!this.#dispatched || this.#usageReported) return
    this.#usageReported = true
    reportUsage(this.#onUsage, {
      id: this.#usageId, service: 'asr', provider: 'volcengine', model: this.#model,
      status: audioDurationMs === undefined ? 'missing' : 'complete',
      ...(audioDurationMs === undefined ? {} : {audioDurationMs}),
    })
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
  return typeof value === 'string' && stripLikePython(value) !== ''
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

function verifiedText(body: Record<string, unknown>, speakerName: string): string {
  const results = Array.isArray(body.result) ? body.result : [body.result]
  let text = ''
  for (const result of results) {
    if (!isObject(result) || !Array.isArray(result.utterances)) continue
    for (const utterance of result.utterances) {
      if (!isObject(utterance) || utterance.definite !== true) continue
      const additions = utterance.additions
      // Registered SpeakerName replaces speaker_id; numeric diarization IDs are not identity.
      if (isObject(additions) && additions.speaker_id === speakerName
        && typeof utterance.text === 'string') text += utterance.text
    }
  }
  return stripLikePython(text)
}
