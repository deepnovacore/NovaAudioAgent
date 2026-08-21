import { MAX_REALTIME_PCM_BYTES } from '../protocol.js'

export const MAX_VOLCENGINE_WIRE_FRAME_BYTES = 10 * 1_024 * 1_024
export const VOLCENGINE_INPUT_AUDIO_FORMAT = Object.freeze({
  encoding: 'pcm_s16le' as const,
  sampleRate: 16_000 as const,
  channels: 1 as const,
})
export const VOLCENGINE_OUTPUT_AUDIO_FORMAT = Object.freeze({
  encoding: 'pcm_s16le' as const,
  sampleRate: 24_000 as const,
  channels: 1 as const,
})

export interface Pcm16MonoFrame<Rate extends 16_000 | 24_000> {
  readonly format: Readonly<{
    readonly encoding: 'pcm_s16le'
    readonly sampleRate: Rate
    readonly channels: 1
  }>
  readonly pcm: Uint8Array
}

export function volcengineInputPcm(pcm: Uint8Array): Pcm16MonoFrame<16_000> {
  return frame(pcm, MAX_REALTIME_PCM_BYTES, VOLCENGINE_INPUT_AUDIO_FORMAT)
}

export function volcengineOutputPcm(pcm: Uint8Array): Pcm16MonoFrame<24_000> {
  return frame(pcm, MAX_VOLCENGINE_WIRE_FRAME_BYTES, VOLCENGINE_OUTPUT_AUDIO_FORMAT)
}

export function pcm16BytesForDuration(sampleRate: number, durationMs: number): number {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0
    || !Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new RangeError('PCM duration inputs must be positive safe integers')
  }
  const product = sampleRate * durationMs
  if (!Number.isSafeInteger(product)) throw new RangeError('PCM duration is too large')
  const bytes = Math.floor(product / 1_000) * 2
  if (!Number.isSafeInteger(bytes) || bytes < 2) throw new RangeError('PCM duration is too small')
  return bytes
}

function frame<Rate extends 16_000 | 24_000>(
  pcm: Uint8Array,
  maximum: number,
  format: Pcm16MonoFrame<Rate>['format'],
): Pcm16MonoFrame<Rate> {
  if (!(pcm instanceof Uint8Array) || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0
    || pcm.byteLength > maximum) {
    throw new RangeError('PCM must be non-empty aligned bounded PCM16 bytes')
  }
  return {format, pcm: new Uint8Array(pcm)}
}
