export const MessageType = Object.freeze({
  FULL_CLIENT_REQUEST: 0x01,
  FULL_SERVER_RESPONSE: 0x09,
  AUDIO_ONLY_SERVER: 0x0b,
  ERROR: 0x0f,
} as const)
export type MessageType = typeof MessageType[keyof typeof MessageType]

export const EventType = Object.freeze({
  START_CONNECTION: 1,
  FINISH_CONNECTION: 2,
  CONNECTION_STARTED: 50,
  CONNECTION_FAILED: 51,
  CONNECTION_FINISHED: 52,
  START_SESSION: 100,
  CANCEL_SESSION: 101,
  FINISH_SESSION: 102,
  SESSION_STARTED: 150,
  SESSION_CANCELED: 151,
  SESSION_FINISHED: 152,
  SESSION_FAILED: 153,
  TASK_REQUEST: 200,
  TTS_SENTENCE_START: 350,
  TTS_SENTENCE_END: 351,
  TTS_RESPONSE: 352,
  TTS_ENDED: 359,
} as const)
export type EventType = typeof EventType[keyof typeof EventType]

const messageTypes = new Set<number>(Object.values(MessageType))
const eventTypes = new Set<number>(Object.values(EventType))
const sessionEvents = new Set<number>([
  EventType.START_SESSION,
  EventType.CANCEL_SESSION,
  EventType.FINISH_SESSION,
  EventType.SESSION_STARTED,
  EventType.SESSION_CANCELED,
  EventType.SESSION_FINISHED,
  EventType.SESSION_FAILED,
  EventType.TASK_REQUEST,
  EventType.TTS_SENTENCE_START,
  EventType.TTS_SENTENCE_END,
  EventType.TTS_RESPONSE,
  EventType.TTS_ENDED,
])
const connectionResponseEvents = new Set<number>([
  EventType.CONNECTION_STARTED,
  EventType.CONNECTION_FAILED,
  EventType.CONNECTION_FINISHED,
])

export class VolcProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VolcProtocolError'
  }
}

export class VolcMessage {
  readonly messageType: MessageType
  readonly event: EventType | null
  readonly payload: Uint8Array
  readonly sessionId: string | null
  readonly connectId: string | null
  readonly sequence: number | null
  readonly errorCode: number | null

  constructor(input: {
    readonly messageType: MessageType
    readonly event?: EventType | null
    readonly payload?: Uint8Array
    readonly sessionId?: string | null
    readonly connectId?: string | null
    readonly sequence?: number | null
    readonly errorCode?: number | null
  }) {
    if (!messageTypes.has(input.messageType) || input.payload !== undefined
      && !(input.payload instanceof Uint8Array)) {
      throw new VolcProtocolError('豆包语音消息参数无效')
    }
    this.messageType = input.messageType
    this.event = input.event ?? null
    this.payload = input.payload === undefined ? new Uint8Array() : new Uint8Array(input.payload)
    this.sessionId = input.sessionId ?? null
    this.connectId = input.connectId ?? null
    this.sequence = input.sequence ?? null
    this.errorCode = input.errorCode ?? null
  }

  marshal(): Uint8Array {
    if (this.event === null || !eventTypes.has(this.event)) {
      throw new VolcProtocolError('client message requires event')
    }
    const body = new ByteWriter()
    body.int32(this.event)
    if (sessionEvents.has(this.event)) {
      if (this.sessionId === null || this.sessionId.length === 0 || !isWellFormed(this.sessionId)) {
        throw new VolcProtocolError('session event requires session_id')
      }
      body.sized(new TextEncoder().encode(this.sessionId))
    } else if (connectionResponseEvents.has(this.event)
      && this.messageType !== MessageType.FULL_CLIENT_REQUEST) {
      const connectId = this.connectId ?? ''
      if (!isWellFormed(connectId)) throw new VolcProtocolError('connection id is invalid')
      body.sized(new TextEncoder().encode(connectId))
    }
    body.sized(this.payload)
    const encodedBody = body.bytes()
    const frameSize = 4 + encodedBody.byteLength
    if (frameSize > MAX_VOLCENGINE_WIRE_FRAME_BYTES) {
      throw new VolcProtocolError('豆包语音协议帧过大')
    }
    const frame = new Uint8Array(frameSize)
    frame.set([
      0x11,
      (this.messageType << 4) | 0x04,
      this.messageType === MessageType.FULL_CLIENT_REQUEST ? 0x10 : 0,
      0,
    ])
    frame.set(encodedBody, 4)
    return frame
  }

  static unmarshal(raw: Uint8Array): VolcMessage {
    if (!(raw instanceof Uint8Array) || raw.byteLength > MAX_VOLCENGINE_WIRE_FRAME_BYTES
      || raw.byteLength < 8 || raw[0]! >> 4 !== 0x01) {
      throw new VolcProtocolError('豆包语音返回了无效协议帧')
    }
    const frame = new Uint8Array(raw)
    const headerSize = (frame[0]! & 0x0f) * 4
    const flag = frame[1]! & 0x0f
    if (headerSize < 4 || headerSize > frame.byteLength || flag > 4) {
      throw new VolcProtocolError('豆包语音返回了无效协议帧')
    }
    const rawMessageType = frame[1]! >> 4
    if (!messageTypes.has(rawMessageType)) {
      throw new VolcProtocolError('豆包语音返回了未知消息类型')
    }
    const messageType = rawMessageType as MessageType
    const reader = new ByteReader(frame, headerSize)
    let sequence: number | null = null
    let errorCode: number | null = null
    if (messageType === MessageType.ERROR) errorCode = reader.uint32()
    else if (flag === 1 || flag === 3) sequence = reader.int32()
    let event: EventType | null = null
    let sessionId: string | null = null
    let connectId: string | null = null
    if (flag === 4) {
      const rawEvent = reader.int32()
      if (!eventTypes.has(rawEvent)) throw new VolcProtocolError('豆包语音返回了未知协议事件')
      event = rawEvent as EventType
      if (sessionEvents.has(event)) {
        sessionId = decodeIdentifier(reader.sized(), '豆包语音返回了无效会话标识')
      } else if (connectionResponseEvents.has(event)) {
        connectId = decodeIdentifier(reader.sized(), '豆包语音返回了无效连接标识')
      }
    }
    const payload = reader.sized()
    if (!reader.finished) throw new VolcProtocolError('豆包语音返回了尾随协议数据')
    return new VolcMessage({
      messageType,
      event,
      payload,
      sessionId,
      connectId,
      sequence,
      errorCode,
    })
  }
}

class ByteWriter {
  readonly #parts: Uint8Array[] = []
  #size = 0

  int32(value: number): void {
    if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
      throw new VolcProtocolError('豆包语音协议整数越界')
    }
    const part = new Uint8Array(4)
    new DataView(part.buffer).setInt32(0, value)
    this.add(part)
  }

  uint32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 4_294_967_295) {
      throw new VolcProtocolError('豆包语音协议整数越界')
    }
    const part = new Uint8Array(4)
    new DataView(part.buffer).setUint32(0, value)
    this.add(part)
  }

  sized(value: Uint8Array): void {
    this.uint32(value.byteLength)
    this.add(new Uint8Array(value))
  }

  bytes(): Uint8Array {
    const result = new Uint8Array(this.#size)
    let offset = 0
    for (const part of this.#parts) {
      result.set(part, offset)
      offset += part.byteLength
    }
    return result
  }

  private add(part: Uint8Array): void {
    this.#parts.push(part)
    this.#size += part.byteLength
    if (this.#size > MAX_VOLCENGINE_WIRE_FRAME_BYTES) {
      throw new VolcProtocolError('豆包语音协议帧过大')
    }
  }
}

class ByteReader {
  #offset: number
  readonly #frame: Uint8Array

  constructor(frame: Uint8Array, offset: number) {
    this.#frame = frame
    this.#offset = offset
  }

  get finished(): boolean {
    return this.#offset === this.#frame.byteLength
  }

  int32(): number {
    return this.takeInt(true)
  }

  uint32(): number {
    return this.takeInt(false)
  }

  sized(): Uint8Array {
    const size = this.uint32()
    const end = this.#offset + size
    if (!Number.isSafeInteger(end) || end > this.#frame.byteLength) {
      throw new VolcProtocolError('豆包语音返回了截断协议帧')
    }
    const value = new Uint8Array(this.#frame.subarray(this.#offset, end))
    this.#offset = end
    return value
  }

  private takeInt(signed: boolean): number {
    const end = this.#offset + 4
    if (end > this.#frame.byteLength) throw new VolcProtocolError('豆包语音返回了截断协议帧')
    const view = new DataView(this.#frame.buffer, this.#frame.byteOffset + this.#offset, 4)
    const value = signed ? view.getInt32(0) : view.getUint32(0)
    this.#offset = end
    return value
  }
}

function decodeIdentifier(bytes: Uint8Array, message: string): string {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes)
  } catch {
    throw new VolcProtocolError(message)
  }
}
import { isWellFormed } from '../../python-text.js'
import { MAX_VOLCENGINE_WIRE_FRAME_BYTES } from './audio.js'
