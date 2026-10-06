export type DictationFailureCode = 'no_audio' | 'no_speech'

export class DictationError extends Error {
  constructor(readonly code: DictationFailureCode, message: string) {
    super(message)
    this.name = 'DictationError'
  }
}

/** Below this peak (of 32768) a recording is digital silence: the microphone delivered nothing. */
export const DICTATION_SILENCE_PEAK = 64
/** 0.2 s of PCM16 mono at 16 kHz; shorter presses cannot contain a word. */
export const DICTATION_MIN_BYTES = 6400

export function pcmLevel(pcm: Uint8Array): {readonly peak: number; readonly rms: number} {
  const samples = pcm.length >> 1
  if (samples === 0) return {peak: 0, rms: 0}
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2)
  let peak = 0, sum = 0
  for (let index = 0; index < samples; index++) {
    const value = view.getInt16(index * 2, true)
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
    sum += value * value
  }
  return {peak, rms: Math.round(Math.sqrt(sum / samples))}
}
