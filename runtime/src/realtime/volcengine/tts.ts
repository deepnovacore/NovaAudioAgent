import { randomUUID } from 'node:crypto'
import { isWellFormed, stripLikePython } from '../../python-text.js'
import { MAX_REALTIME_TEXT } from '../protocol.js'
import { MAX_VOLCENGINE_WIRE_FRAME_BYTES, volcengineOutputPcm } from './audio.js'
import { EventType, MessageType, VolcMessage } from './protocol.js'
import {
  DEFAULT_VOLC_CLOSE_TIMEOUT_MS,
  DEFAULT_VOLC_CONNECT_TIMEOUT_MS,
  DEFAULT_VOLC_RECEIVE_TIMEOUT_MS,
  webSocketVolcBinaryConnector,
  type VolcBinaryConnector,
  type VolcBinarySocket,
} from './websocket.js'

const boundaries = new Set([...`，。！？；：,.!?;:\n`])

export class TextChunker {
  readonly #softLimit: number
  readonly #hardLimit: number
  #pending: string[] = []
  #first = true

  constructor(options: {readonly softLimit?: number; readonly hardLimit?: number} = {}) {
    const softLimit = options.softLimit ?? 18
    const hardLimit = options.hardLimit ?? 48
    if (!Number.isSafeInteger(softLimit) || !Number.isSafeInteger(hardLimit)
      || softLimit < 1 || hardLimit < softLimit) {
      throw new RangeError('invalid TTS text limits')
    }
    this.#softLimit = softLimit
    this.#hardLimit = hardLimit
  }

  push(text: unknown): readonly string[] {
    if (typeof text !== 'string') throw new TypeError('TTS text delta must be a string')
    const delta = [...text]
    if (delta.length > MAX_REALTIME_TEXT) throw new RangeError('TTS text delta is too large')
    this.#pending.push(...delta)
    const chunks: string[] = []
    while (this.#pending.length > 0) {
      const boundary = this.flushBoundary()
      if (boundary === null && this.#pending.length < this.#hardLimit) break
      const end = boundary === null ? this.#hardLimit : Math.min(boundary, this.#hardLimit)
      chunks.push(this.#pending.slice(0, end).join(''))
      this.#pending = this.#pending.slice(end)
      this.#first = false
    }
    return chunks
  }

  finish(): readonly string[] {
    if (this.#pending.length === 0) return []
    const pending = this.#pending.join('')
    this.#pending = []
    this.#first = false
    return [pending]
  }

  private flushBoundary(): number | null {
    for (let index = 0; index < this.#pending.length; index += 1) {
      if (!boundaries.has(this.#pending[index]!)) continue
      const end = index + 1
      if (this.#first || end >= this.#softLimit) return end
    }
    return null
  }
}

export type DoubaoTtsFailureCode =
  | 'configuration'
  | 'connect'
  | 'handshake'
  | 'session'
  | 'receive'
  | 'close'

export class DoubaoTtsFailure extends Error {
  readonly code: DoubaoTtsFailureCode

  constructor(code: DoubaoTtsFailureCode) {
    super(`Doubao TTS ${code} failure`)
    this.name = 'DoubaoTtsFailure'
    this.code = code
  }
}

export interface TtsAudio {
  readonly pcm: Uint8Array
}

export function ttsHeaders(input: {
  readonly apiKey: string
  readonly resourceId: string
  readonly idFactory?: () => string
}): Readonly<Record<string, string>> {
  const idFactory = input.idFactory ?? randomUUID
  if (!ttsNonblank(input.apiKey) || !ttsNonblank(input.resourceId)) {
    throw new DoubaoTtsFailure('configuration')
  }
  let connectId: string
  try {
    connectId = idFactory()
  } catch {
    throw new DoubaoTtsFailure('configuration')
  }
  if (!ttsNonblank(connectId) || !isWellFormed(connectId)) {
    throw new DoubaoTtsFailure('configuration')
  }
  return Object.freeze({
    'X-Api-Key': input.apiKey,
    'X-Api-Resource-Id': input.resourceId,
    'X-Api-Connect-Id': connectId,
  })
}

export interface DoubaoTtsClientOptions {
  readonly endpoint: string
  readonly apiKey: string
  readonly resourceId: string
  readonly voice: string
  readonly outputSampleRate?: 24_000
  readonly connectTimeoutMs?: number
  readonly receiveTimeoutMs?: number
  readonly connector?: VolcBinaryConnector
  readonly idFactory?: () => string
}

export class DoubaoTtsClient {
  readonly #options: Required<Omit<DoubaoTtsClientOptions, 'connector' | 'idFactory'>>
  readonly #connector: VolcBinaryConnector
  readonly #idFactory: () => string

  constructor(options: DoubaoTtsClientOptions) {
    const outputSampleRate = options.outputSampleRate ?? 24_000
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_VOLC_CONNECT_TIMEOUT_MS
    const receiveTimeoutMs = options.receiveTimeoutMs ?? DEFAULT_VOLC_RECEIVE_TIMEOUT_MS
    if (!ttsNonblank(options.endpoint) || !ttsNonblank(options.apiKey)
      || !ttsNonblank(options.resourceId) || !ttsNonblank(options.voice)
      || outputSampleRate !== 24_000 || !ttsPositiveMilliseconds(connectTimeoutMs)
      || !ttsPositiveMilliseconds(receiveTimeoutMs)) {
      throw new DoubaoTtsFailure('configuration')
    }
    this.#options = {
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      resourceId: options.resourceId,
      voice: options.voice,
      outputSampleRate,
      connectTimeoutMs,
      receiveTimeoutMs,
    }
    this.#connector = options.connector ?? webSocketVolcBinaryConnector
    this.#idFactory = options.idFactory ?? randomUUID
  }

  async open(signal?: AbortSignal): Promise<DoubaoTtsSession> {
    throwTtsIfAborted(signal)
    const connectionSignal = signal ?? new AbortController().signal
    let socket: VolcBinarySocket | undefined
    let phase: DoubaoTtsFailureCode = 'connect'
    try {
      socket = await this.#connector({
        endpoint: this.#options.endpoint,
        headers: {...ttsHeaders({
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
      await socket.send(message(EventType.START_CONNECTION), signal)
      await expectTtsEvent(
        socket, EventType.CONNECTION_STARTED, null, this.#options.receiveTimeoutMs, signal,
      )
      const sessionId = ttsId(this.#idFactory)
      await socket.send(message(EventType.START_SESSION, sessionId, ttsPayload({
        voice: this.#options.voice,
        sampleRate: this.#options.outputSampleRate,
        event: EventType.START_SESSION,
        userId: ttsId(this.#idFactory),
      })), signal)
      await expectTtsEvent(
        socket, EventType.SESSION_STARTED, sessionId, this.#options.receiveTimeoutMs, signal,
      )
      return new DoubaoTtsSession({
        socket,
        sessionId,
        voice: this.#options.voice,
        sampleRate: this.#options.outputSampleRate,
        receiveTimeoutMs: this.#options.receiveTimeoutMs,
        idFactory: this.#idFactory,
      })
    } catch (error) {
      if (socket !== undefined) {
        try {
          await socket.close()
        } catch {
          // The original connection or handshake verdict remains authoritative.
        }
      }
      throwTtsIfAborted(signal)
      if (error instanceof DoubaoTtsFailure) throw error
      throw new DoubaoTtsFailure(phase)
    }
  }
}

export class DoubaoTtsSession {
  readonly #socket: VolcBinarySocket
  readonly #sessionId: string
  readonly #voice: string
  readonly #sampleRate: 24_000
  readonly #receiveTimeoutMs: number
  readonly #idFactory: () => string
  #writing: Promise<void> = Promise.resolve()
  #terminal: 'finish' | 'cancel' | undefined
  #closed = false
  #eventsClaimed = false
  #closePromise: Promise<void> | undefined

  constructor(input: {
    readonly socket: VolcBinarySocket
    readonly sessionId: string
    readonly voice: string
    readonly sampleRate: 24_000
    readonly receiveTimeoutMs: number
    readonly idFactory: () => string
  }) {
    this.#socket = input.socket
    this.#sessionId = input.sessionId
    this.#voice = input.voice
    this.#sampleRate = input.sampleRate
    this.#receiveTimeoutMs = input.receiveTimeoutMs
    this.#idFactory = input.idFactory
  }

  sendText(text: string, signal?: AbortSignal): Promise<void> {
    if (!ttsNonblank(text) || !isWellFormed(text) || [...text].length > MAX_REALTIME_TEXT) {
      return Promise.reject(new DoubaoTtsFailure('session'))
    }
    return this.#serialized(async () => {
      throwTtsIfAborted(signal)
      if (this.#terminal !== undefined || this.#closed) throw new DoubaoTtsFailure('session')
      try {
        await this.#socket.send(message(EventType.TASK_REQUEST, this.#sessionId, ttsPayload({
          voice: this.#voice,
          sampleRate: this.#sampleRate,
          event: EventType.TASK_REQUEST,
          userId: ttsId(this.#idFactory),
          text,
        })), signal)
      } catch {
        throwTtsIfAborted(signal)
        throw new DoubaoTtsFailure('session')
      }
    })
  }

  finish(signal?: AbortSignal): Promise<void> {
    return this.#terminalAction('finish', EventType.FINISH_SESSION, signal)
  }

  cancel(signal?: AbortSignal): Promise<void> {
    return this.#terminalAction('cancel', EventType.CANCEL_SESSION, signal)
  }

  async *events(signal?: AbortSignal): AsyncIterable<TtsAudio> {
    if (this.#eventsClaimed) throw new DoubaoTtsFailure('session')
    this.#eventsClaimed = true
    while (!this.#closed) {
      const raw = await ttsReceiveWithTimeout(
        this.#socket, this.#receiveTimeoutMs, signal, 'receive',
      )
      let decoded: VolcMessage
      try {
        decoded = VolcMessage.unmarshal(raw)
      } catch {
        throw new DoubaoTtsFailure('receive')
      }
      if (decoded.sessionId !== null && decoded.sessionId !== this.#sessionId) continue
      if (decoded.messageType === MessageType.AUDIO_ONLY_SERVER) {
        if (decoded.payload.byteLength === 0) continue
        try {
          yield {pcm: volcengineOutputPcm(decoded.payload).pcm}
        } catch {
          throw new DoubaoTtsFailure('receive')
        }
        continue
      }
      if (decoded.event === EventType.SESSION_FINISHED) return
      if (decoded.messageType === MessageType.ERROR
        || decoded.event === EventType.SESSION_FAILED
        || decoded.event === EventType.CONNECTION_FAILED) {
        throw new DoubaoTtsFailure('receive')
      }
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closed = true
    this.#closePromise = this.#performClose()
    return this.#closePromise
  }

  #terminalAction(
    terminal: 'finish' | 'cancel',
    event: typeof EventType.FINISH_SESSION | typeof EventType.CANCEL_SESSION,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#serialized(async () => {
      throwTtsIfAborted(signal)
      if (this.#closed) throw new DoubaoTtsFailure('session')
      if (this.#terminal !== undefined) return
      this.#terminal = terminal
      try {
        await this.#socket.send(message(event, this.#sessionId), signal)
      } catch {
        throwTtsIfAborted(signal)
        throw new DoubaoTtsFailure('session')
      }
    })
  }

  async #performClose(): Promise<void> {
    let failed = false
    try {
      await this.#serialized(async () => {
        try {
          await this.#socket.send(message(EventType.FINISH_CONNECTION))
        } catch {
          failed = true
        }
      })
    } finally {
      try {
        await this.#socket.close()
      } catch {
        failed = true
      }
    }
    if (failed) throw new DoubaoTtsFailure('close')
  }

  #serialized(operation: () => Promise<void>): Promise<void> {
    const result = this.#writing.then(operation)
    this.#writing = result.then(() => undefined, () => undefined)
    return result
  }
}

async function expectTtsEvent(
  socket: VolcBinarySocket,
  expected: EventType,
  sessionId: string | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const raw = await ttsReceiveWithTimeout(socket, timeoutMs, signal, 'handshake')
  let decoded: VolcMessage
  try {
    decoded = VolcMessage.unmarshal(raw)
  } catch {
    throw new DoubaoTtsFailure('handshake')
  }
  if (decoded.messageType !== MessageType.FULL_SERVER_RESPONSE || decoded.event !== expected
    || sessionId !== null && decoded.sessionId !== sessionId) {
    throw new DoubaoTtsFailure('handshake')
  }
}

async function ttsReceiveWithTimeout(
  socket: VolcBinarySocket,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  code: 'handshake' | 'receive',
): Promise<Uint8Array> {
  throwTtsIfAborted(signal)
  const timeout = new AbortController()
  const combined = signal === undefined ? timeout.signal : AbortSignal.any([timeout.signal, signal])
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  try {
    return await socket.receive(combined)
  } catch {
    throwTtsIfAborted(signal)
    throw new DoubaoTtsFailure(code)
  } finally {
    clearTimeout(timer)
  }
}

function throwTtsIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('This operation was aborted', 'AbortError')
}

function ttsPositiveMilliseconds(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function ttsNonblank(value: unknown): value is string {
  return typeof value === 'string' && stripLikePython(value).length > 0
}

function ttsId(idFactory: () => string): string {
  let value: string
  try {
    value = idFactory()
  } catch {
    throw new DoubaoTtsFailure('configuration')
  }
  if (!ttsNonblank(value) || !isWellFormed(value)) throw new DoubaoTtsFailure('configuration')
  return value
}

function message(event: EventType, sessionId?: string, payload?: object): Uint8Array {
  return new VolcMessage({
    messageType: MessageType.FULL_CLIENT_REQUEST,
    event,
    payload: new TextEncoder().encode(JSON.stringify(payload ?? {})),
    ...(sessionId === undefined ? {} : {sessionId}),
  }).marshal()
}

function ttsPayload(input: {
  readonly voice: string
  readonly sampleRate: 24_000
  readonly event: EventType
  readonly userId: string
  readonly text?: string
}): object {
  return {
    event: input.event,
    user: {uid: input.userId},
    namespace: 'BidirectionalTTS',
    req_params: {
      speaker: input.voice,
      audio_params: {
        format: 'pcm', sample_rate: input.sampleRate, enable_timestamp: false,
      },
      additions: JSON.stringify({disable_markdown_filter: false}),
      ...(input.text === undefined ? {} : {text: input.text}),
    },
  }
}
