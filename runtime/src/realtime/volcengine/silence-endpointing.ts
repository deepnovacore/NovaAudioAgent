import {ConfigurationError, type VolcengineRealtimeConfig} from '../../config.js'
import {volcengineInputPcm} from './audio.js'
import type {VolcEndpointingEvent, VolcEndpointingPort} from './adapter.js'

const SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 2
const WINDOW_SAMPLES = 512
const WINDOW_BYTES = WINDOW_SAMPLES * BYTES_PER_SAMPLE
const ACTIVATION_RMS = 0.035
const CONTINUATION_RMS = 0.020

const TIMING_FIELDS = Object.freeze({
  vadPreRollMs: 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_PRE_ROLL_MS',
  vadMinSpeechMs: 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MIN_SPEECH_MS',
  vadSilenceEndMs: 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SILENCE_END_MS',
  vadSpeechPadMs: 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SPEECH_PAD_MS',
  vadMaxUtteranceMs: 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MAX_UTTERANCE_MS',
} as const)

export type SilenceVolcEndpointingConfig = Pick<VolcengineRealtimeConfig,
  | 'vadPreRollMs'
  | 'vadMinSpeechMs'
  | 'vadSilenceEndMs'
  | 'vadSpeechPadMs'
  | 'vadMaxUtteranceMs'
>

export class SilenceVolcEndpointing implements VolcEndpointingPort {
  readonly #preRollByteLimit: number
  readonly #minimumSpeechSamples: number
  readonly #silenceEndSamples: number
  readonly #speechPadBytes: number
  readonly #maximumUtteranceSamples: number
  #state: 'idle' | 'candidate' | 'active' = 'idle'
  #partial = new Uint8Array()
  #preRoll: Uint8Array[] = []
  #preRollBytes = 0
  #candidate: Uint8Array[] = []
  #candidateSamples = 0
  #pendingTail: Uint8Array[] = []
  #pendingTailSamples = 0
  #utteranceSamples = 0
  #tail: Promise<void> = Promise.resolve()
  #closed = false

  constructor(config: SilenceVolcEndpointingConfig) {
    validateTiming(config.vadPreRollMs, 0, 2_000, TIMING_FIELDS.vadPreRollMs)
    validateTiming(config.vadMinSpeechMs, 1, 10_000, TIMING_FIELDS.vadMinSpeechMs)
    validateTiming(config.vadSilenceEndMs, 1, 10_000, TIMING_FIELDS.vadSilenceEndMs)
    validateTiming(config.vadSpeechPadMs, 0, 2_000, TIMING_FIELDS.vadSpeechPadMs)
    validateTiming(config.vadMaxUtteranceMs, 1, 60_000, TIMING_FIELDS.vadMaxUtteranceMs)
    if (config.vadMaxUtteranceMs < config.vadMinSpeechMs) {
      throw configurationError(TIMING_FIELDS.vadMaxUtteranceMs)
    }
    this.#preRollByteLimit = samplesForMilliseconds(config.vadPreRollMs) * BYTES_PER_SAMPLE
    this.#minimumSpeechSamples = samplesForMilliseconds(config.vadMinSpeechMs)
    this.#silenceEndSamples = samplesForMilliseconds(config.vadSilenceEndMs)
    this.#speechPadBytes = samplesForMilliseconds(config.vadSpeechPadMs) * BYTES_PER_SAMPLE
    this.#maximumUtteranceSamples = samplesForMilliseconds(config.vadMaxUtteranceMs)
  }

  feed(pcm: Uint8Array, signal: AbortSignal): Promise<readonly VolcEndpointingEvent[]> {
    if (this.#closed) return Promise.reject(new Error('Silence endpointing is closed'))
    const owned = volcengineInputPcm(pcm).pcm
    const operation = this.#tail.then(() => {
      if (this.#closed) throw new Error('Silence endpointing is closed')
      throwIfAborted(signal)
      return this.#process(owned)
    })
    this.#tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  reset(): Promise<void> {
    const operation = this.#tail.then(() => this.#clearState())
    this.#tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#closed = true
    this.#clearState()
    return Promise.resolve()
  }

  #process(pcm: Uint8Array): readonly VolcEndpointingEvent[] {
    const available = this.#partial.byteLength === 0 ? pcm : joinBytes([this.#partial, pcm])
    const events: VolcEndpointingEvent[] = []
    let offset = 0
    while (available.byteLength - offset >= WINDOW_BYTES) {
      const window = available.slice(offset, offset + WINDOW_BYTES)
      offset += WINDOW_BYTES
      this.#processWindow(window, events)
    }
    this.#partial = available.slice(offset)
    return events
  }

  #processWindow(window: Uint8Array, events: VolcEndpointingEvent[]): void {
    const rms = normalizedRms(window)
    if (this.#state === 'idle') {
      if (rms < ACTIVATION_RMS) {
        this.#appendPreRoll(window)
        return
      }
      this.#state = 'candidate'
      this.#candidate = [window]
      this.#candidateSamples = WINDOW_SAMPLES
      this.#utteranceSamples = WINDOW_SAMPLES
      this.#commitCandidateIfReady(events)
      return
    }

    if (this.#state === 'candidate') {
      if (rms < CONTINUATION_RMS) {
        for (const candidate of this.#candidate) this.#appendPreRoll(candidate)
        this.#appendPreRoll(window)
        this.#candidate = []
        this.#candidateSamples = 0
        this.#utteranceSamples = 0
        this.#state = 'idle'
        return
      }
      this.#candidate.push(window)
      this.#candidateSamples += WINDOW_SAMPLES
      this.#utteranceSamples += WINDOW_SAMPLES
      this.#commitCandidateIfReady(events)
      return
    }

    this.#utteranceSamples += WINDOW_SAMPLES
    if (rms >= CONTINUATION_RMS) {
      if (this.#pendingTailSamples > 0) {
        events.push({kind: 'speech_audio', pcm: joinBytes(this.#pendingTail)})
        this.#pendingTail = []
        this.#pendingTailSamples = 0
      }
      events.push({kind: 'speech_audio', pcm: window.slice()})
      if (this.#utteranceSamples >= this.#maximumUtteranceSamples) {
        events.push({kind: 'speech_end', commit: true})
        this.#clearUtterance()
      }
      return
    }

    this.#pendingTail.push(window)
    this.#pendingTailSamples += WINDOW_SAMPLES
    if (this.#pendingTailSamples >= this.#silenceEndSamples
      || this.#utteranceSamples >= this.#maximumUtteranceSamples) {
      this.#endActive(events)
    }
  }

  #commitCandidateIfReady(events: VolcEndpointingEvent[]): void {
    if (this.#candidateSamples < this.#minimumSpeechSamples) return
    events.push({kind: 'speech_start', pcm: joinBytes([...this.#preRoll, ...this.#candidate])})
    this.#preRoll = []
    this.#preRollBytes = 0
    this.#candidate = []
    this.#candidateSamples = 0
    this.#state = 'active'
    if (this.#utteranceSamples >= this.#maximumUtteranceSamples) {
      events.push({kind: 'speech_end', commit: true})
      this.#clearUtterance()
    }
  }

  #endActive(events: VolcEndpointingEvent[]): void {
    const tail = joinBytes(this.#pendingTail)
    const padBytes = Math.min(this.#speechPadBytes, tail.byteLength)
    if (padBytes > 0) events.push({kind: 'speech_audio', pcm: tail.slice(0, padBytes)})
    if (padBytes < tail.byteLength) this.#appendPreRoll(tail.slice(padBytes))
    events.push({kind: 'speech_end', commit: true})
    this.#clearUtterance()
  }

  #appendPreRoll(pcm: Uint8Array): void {
    if (this.#preRollByteLimit === 0 || pcm.byteLength === 0) return
    this.#preRoll.push(pcm)
    this.#preRollBytes += pcm.byteLength
    let excess = this.#preRollBytes - this.#preRollByteLimit
    while (excess > 0) {
      const first = this.#preRoll[0]
      if (first === undefined) throw new Error('Silence endpointing pre-roll invariant failed')
      if (first.byteLength <= excess) {
        this.#preRoll.shift()
        this.#preRollBytes -= first.byteLength
        excess -= first.byteLength
      } else {
        this.#preRoll[0] = first.slice(excess)
        this.#preRollBytes -= excess
        excess = 0
      }
    }
  }

  #clearUtterance(): void {
    this.#state = 'idle'
    this.#candidate = []
    this.#candidateSamples = 0
    this.#pendingTail = []
    this.#pendingTailSamples = 0
    this.#utteranceSamples = 0
  }

  #clearState(): void {
    this.#partial = new Uint8Array()
    this.#preRoll = []
    this.#preRollBytes = 0
    this.#clearUtterance()
  }
}

function validateTiming(value: number, minimum: number, maximum: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw configurationError(field)
  }
}

function configurationError(field: string): ConfigurationError {
  return new ConfigurationError(`invalid configuration: ${field}`)
}

function samplesForMilliseconds(milliseconds: number): number {
  return milliseconds * (SAMPLE_RATE / 1_000)
}

function normalizedRms(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let sum = 0
  for (let offset = 0; offset < pcm.byteLength; offset += BYTES_PER_SAMPLE) {
    const sample = view.getInt16(offset, true)
    sum += sample * sample
  }
  return Math.sqrt(sum / WINDOW_SAMPLES) / 32_768
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  let byteLength = 0
  for (const part of parts) byteLength += part.byteLength
  const result = new Uint8Array(byteLength)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('This operation was aborted', 'AbortError')
}
