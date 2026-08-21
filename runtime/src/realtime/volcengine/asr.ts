import { gzipSync, gunzipSync } from 'node:zlib'
import { isWellFormed, stripLikePython } from '../../python-text.js'
import { MAX_VOLCENGINE_WIRE_FRAME_BYTES, type Pcm16MonoFrame } from './audio.js'

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
      || input.audio.pcm.byteLength % 2 !== 0) {
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
