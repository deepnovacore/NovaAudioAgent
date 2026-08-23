import {ReadableStream} from 'node:stream/web'
import type {Clock} from '../../clock.js'
import {ConfigurationError, type VolcengineRealtimeConfig} from '../../config.js'
import type {EndpointingEvent, EndpointingPort} from '../cascaded/ports.js'
import {volcengineInputPcm} from './audio.js'
import type {
  LiveKitAgentsPublicSurface, LiveKitAudioByteStream, LiveKitAudioFrame, LiveKitExecutor,
  LiveKitTurnDetector, LiveKitTurnStream, LiveKitVad, LiveKitVadEvent, LiveKitVadStream,
} from './endpointing-capability.js'

const SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 2
const FRAME_SAMPLES = 512
const EXTENSION_SAMPLES = 2_500 * (SAMPLE_RATE / 1_000)
const PREDICTION_TIMEOUT_SECONDS = 1.25
const CLEANUP_TIMEOUT_MS = 1_000
const TIMING_LIMITS = Object.freeze([
  ['vadPreRollMs', 0, 2_000, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_PRE_ROLL_MS'],
  ['vadMinSpeechMs', 1, 10_000, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MIN_SPEECH_MS'],
  ['vadSilenceEndMs', 1, 10_000, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SILENCE_END_MS'],
  ['vadSpeechPadMs', 0, 2_000, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SPEECH_PAD_MS'],
  ['vadMaxUtteranceMs', 1, 60_000, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MAX_UTTERANCE_MS'],
] as const)

export type LiveKitVolcEndpointingConfig = Pick<VolcengineRealtimeConfig,
  | 'vadThreshold' | 'vadPreRollMs' | 'vadMinSpeechMs' | 'vadSilenceEndMs'
  | 'vadSpeechPadMs' | 'vadMaxUtteranceMs'>

export interface LiveKitVolcEndpointingOptions {
  readonly surface: LiveKitAgentsPublicSurface
  readonly executor: LiveKitExecutor
  readonly config: LiveKitVolcEndpointingConfig
  readonly clock?: Clock
}

interface PublicVadEvent extends LiveKitVadEvent {
  readonly samplesIndex?: unknown
  readonly speechDuration?: unknown
  readonly silenceDuration?: unknown
  readonly speaking?: unknown
  readonly rawAccumulatedSilence?: unknown
  readonly rawAccumulatedSpeech?: unknown
}
type PublicVadStream = LiveKitVadStream
type PublicTurnStream = LiveKitTurnStream
interface FrameRecord {readonly start: number; readonly end: number; readonly pcm: Uint8Array}
interface UtteranceState {
  phase: 'active' | 'extension'
  readonly firstSpeech: number
  outputCursor: number
  lastSpeech: number
}
interface LiveEpoch {
  readonly token: number
  readonly controller: AbortController
  readonly vad: LiveKitVad
  readonly vadStream: PublicVadStream
  readonly detector: LiveKitTurnDetector
  readonly turnStream: PublicTurnStream
  readonly byteStream: LiveKitAudioByteStream
  readonly producer: OwnedFrameProducer
  framingPartial: Uint8Array
  readerTask: Promise<void>
  handlerTask: Promise<void> | null
  vadCursor: number
  pendingBoundaryPosition: number | null
  readonly progressWaiters: Set<ProgressWaiter>
  rotateRequested: boolean
  failure: Error | null
}
interface ProgressWaiter {readonly position: number; readonly resolve: () => void; readonly reject: (error: Error) => void}

export class LiveKitVolcEndpointing implements EndpointingPort {
  readonly #surface: LiveKitAgentsPublicSurface
  readonly #executor: LiveKitExecutor
  readonly #config: LiveKitVolcEndpointingConfig
  readonly #clock: Clock
  readonly #deactivationThreshold: number
  readonly #speechPadSamples: number
  readonly #maximumUtteranceSamples: number
  readonly #retainedSampleLimit: number
  #token = 0
  #cursor = 0
  #partial = new Uint8Array()
  #rotationReplay = new Uint8Array()
  #records: FrameRecord[] = []
  #utterance: UtteranceState | null = null
  #events: EndpointingEvent[] = []
  #epoch: LiveEpoch | null = null
  #tail: Promise<void> = Promise.resolve()
  #closePromise: Promise<void> | null = null
  #closed = false

  constructor(options: LiveKitVolcEndpointingOptions) {
    validateConfig(options.config)
    this.#surface = options.surface
    this.#executor = options.executor
    this.#config = Object.freeze({...options.config})
    this.#clock = options.clock ?? REAL_CLOCK
    this.#deactivationThreshold = Math.max(options.config.vadThreshold - 0.15, 0.01)
    this.#speechPadSamples = samplesForMilliseconds(options.config.vadSpeechPadMs)
    this.#maximumUtteranceSamples = samplesForMilliseconds(options.config.vadMaxUtteranceMs)
    this.#retainedSampleLimit = this.#maximumUtteranceSamples
      + samplesForMilliseconds(options.config.vadPreRollMs) + FRAME_SAMPLES
  }

  feed(pcm: Uint8Array, signal: AbortSignal): Promise<readonly EndpointingEvent[]> {
    if (this.#closed) return Promise.reject(new Error('LiveKit endpointing is closed'))
    let owned: Uint8Array
    try { owned = volcengineInputPcm(pcm).pcm } catch (error) {
      return Promise.reject(error instanceof Error ? error : new RangeError('invalid input PCM'))
    }
    const result = this.#tail.then(async () => {
      if (this.#closed) throw new Error('LiveKit endpointing is closed')
      throwIfAborted(signal)
      let epoch = this.#epoch ?? this.#createEpoch()
      try {
        if (epoch.handlerTask !== null) await epoch.handlerTask
        if (epoch.failure !== null) await this.#failEpoch(epoch)
        const available = this.#partial.byteLength === 0 ? owned : joinBytes([this.#partial, owned])
        const completeBytes = available.byteLength - (available.byteLength % (FRAME_SAMPLES * 2))
        const frameInputs: Uint8Array[] = []
        for (let offset = 0; offset < completeBytes; offset += FRAME_SAMPLES * 2) {
          frameInputs.push(available.slice(offset, offset + FRAME_SAMPLES * 2))
        }
        this.#partial = available.slice(completeBytes)
        for (const input of frameInputs) {
          for (const frame of this.#writeFrames(epoch, input)) {
            throwIfAborted(signal)
            this.#acceptFrame(epoch, frame)
            await epoch.producer.enqueue(frame, AbortSignal.any([signal, epoch.controller.signal]))
            await this.#waitForVadPosition(epoch, this.#cursor, signal)
            if (epoch.handlerTask !== null) await epoch.handlerTask
            if (epoch.controller.signal.aborted || !this.#isCurrent(epoch)) {
              throw abortReason(epoch.controller.signal)
            }
            if (epoch.failure !== null) await this.#failEpoch(epoch)
            if (epoch.rotateRequested) epoch = await this.#rotateEpoch(epoch, signal)
          }
        }
        if (epoch.handlerTask !== null) await epoch.handlerTask
        if (epoch.failure !== null) await this.#failEpoch(epoch)
      } catch (error) {
        if (!signal.aborted && epoch.failure !== null && this.#epoch === epoch) {
          await this.#failEpoch(epoch)
        }
        throw error
      }
      const events = this.#events.map(copyEndpointEvent)
      this.#events = []
      return Object.freeze(events)
    })
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }

  reset(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    const admitted = this.#epoch
    admitted?.controller.abort()
    this.#token += 1
    const operation = this.#tail.then(async () => {
      const old = this.#epoch ?? admitted
      this.#epoch = null
      this.#clearAudioState()
      if (old !== null) await this.#closeEpoch(old)
      if (!this.#closed) this.#createEpoch()
    })
    this.#tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    this.#closed = true
    const admitted = this.#epoch
    admitted?.controller.abort()
    this.#token += 1
    this.#closePromise = this.#tail.then(async () => {
      const old = this.#epoch ?? admitted
      this.#epoch = null
      this.#clearAudioState()
      if (old !== null) await this.#closeEpoch(old)
    })
    return this.#closePromise
  }

  #createEpoch(): LiveEpoch {
    const token = ++this.#token
    const vad = new this.#surface.inference.VAD({
      model: 'silero', minSpeechDuration: this.#config.vadMinSpeechMs,
      minSilenceDuration: this.#config.vadSilenceEndMs,
      prefixPaddingDuration: this.#config.vadPreRollMs,
      maxBufferedSpeech: this.#config.vadMaxUtteranceMs,
      activationThreshold: this.#config.vadThreshold,
      deactivationThreshold: this.#deactivationThreshold,
    })
    const vadStream = vad.stream()
    const detector = new this.#surface.inference.TurnDetector({
      version: 'v1-mini', sampleRate: 16_000, executor: this.#executor,
    })
    const turnStream = detector.stream()
    const producer = new OwnedFrameProducer()
    vadStream.updateInputStream(producer.stream)
    const epoch: LiveEpoch = {
      token, controller: new AbortController(), vad, vadStream, detector, turnStream,
      byteStream: new this.#surface.AudioByteStream(16_000, 1, 512), producer,
      framingPartial: new Uint8Array(),
      readerTask: Promise.resolve(), handlerTask: null, vadCursor: 0, pendingBoundaryPosition: null,
      progressWaiters: new Set(), rotateRequested: false, failure: null,
    }
    epoch.readerTask = this.#readVad(epoch)
    void epoch.readerTask.catch(() => undefined)
    this.#epoch = epoch
    return epoch
  }

  #acceptFrame(epoch: LiveEpoch, frame: LiveKitAudioFrame): void {
    const pcm = audioFrameBytes(frame)
    const start = this.#cursor
    this.#cursor += frame.samplesPerChannel
    this.#records.push({start, end: this.#cursor, pcm})
    epoch.turnStream.pushAudio(frame)
    this.#pruneRecords()
  }

  #writeFrames(epoch: LiveEpoch, input: Uint8Array): readonly LiveKitAudioFrame[] {
    const available = epoch.framingPartial.byteLength === 0
      ? input : joinBytes([epoch.framingPartial, input])
    const completeBytes = available.byteLength - (available.byteLength % (FRAME_SAMPLES * 2))
    epoch.framingPartial = available.slice(completeBytes)
    const frames: LiveKitAudioFrame[] = []
    for (let offset = 0; offset < completeBytes; offset += FRAME_SAMPLES * 2) {
      const output = epoch.byteStream.write(available.slice(offset, offset + FRAME_SAMPLES * 2))
      if (output.length !== 1) throw new Error('LiveKit byte stream frame invariant failed')
      frames.push(output[0]!)
    }
    return frames
  }

  async #readVad(epoch: LiveEpoch): Promise<void> {
    try {
      for await (const event of epoch.vadStream) {
        if (!this.#isCurrent(epoch)) return
        const publicEvent = event as PublicVadEvent
        const task = this.#handleVadEvent(epoch, publicEvent)
        epoch.handlerTask = task
        await task
        if (epoch.handlerTask === task) epoch.handlerTask = null
        this.#noteVadProgress(epoch, eventPosition(publicEvent))
      }
      if (this.#isCurrent(epoch) && !epoch.controller.signal.aborted) {
        epoch.failure = new Error('LiveKit endpointing reader ended')
        this.#rejectProgress(epoch, epoch.failure)
      }
    } catch {
      if (this.#isCurrent(epoch) && !epoch.controller.signal.aborted) {
        epoch.failure = new Error('LiveKit endpointing failed')
        this.#rejectProgress(epoch, epoch.failure)
      }
    }
  }

  async #handleVadEvent(epoch: LiveEpoch, event: PublicVadEvent): Promise<void> {
    const position = eventPosition(event)
    const frameRange = this.#validateEventFrames(event, position)
    if (event.type === this.#surface.VADEventType.START_OF_SPEECH) {
      this.#startSpeech(event, frameRange.start, position)
      if (epoch.pendingBoundaryPosition === position) epoch.pendingBoundaryPosition = null
    } else if (event.type === this.#surface.VADEventType.INFERENCE_DONE) {
      if (this.#expectsStartEvent(event) || this.#expectsEndEvent(event)) {
        epoch.pendingBoundaryPosition = position
      }
      this.#inferenceDone(event, frameRange.start, position)
    } else if (event.type === this.#surface.VADEventType.END_OF_SPEECH) {
      await this.#endOfSpeech(epoch, event, position)
      if (epoch.pendingBoundaryPosition === position) epoch.pendingBoundaryPosition = null
    }
  }

  #startSpeech(event: PublicVadEvent, frameStart: number, position: number): void {
    const current = this.#utterance
    if (current === null) {
      const duration = samplesForMilliseconds(requiredMilliseconds(event.speechDuration))
      const firstSpeech = Math.max(frameStart, position - duration)
      this.#events.push({kind: 'speech_start', pcm: this.#slice(frameStart, position)})
      this.#utterance = {phase: 'active', firstSpeech, outputCursor: position, lastSpeech: position}
      return
    }
    if (current.phase !== 'extension') return
    if (position > current.outputCursor) {
      this.#events.push({kind: 'speech_audio', pcm: this.#slice(current.outputCursor, position)})
    }
    current.phase = 'active'
    current.outputCursor = position
    current.lastSpeech = position
    this.#forceAtCaps(position)
  }

  #inferenceDone(event: PublicVadEvent, frameStart: number, position: number): void {
    const current = this.#utterance
    if (current === null) return
    if (!finiteProbability(event.probability)) throw new Error('invalid VAD probability')
    if (current.phase === 'active' && event.probability > this.#deactivationThreshold) {
      const start = Math.max(current.outputCursor, frameStart)
      if (position > start) this.#events.push({kind: 'speech_audio', pcm: this.#slice(start, position)})
      current.outputCursor = Math.max(current.outputCursor, position)
      current.lastSpeech = position
    }
    this.#forceAtCaps(position)
  }

  #expectsEndEvent(event: PublicVadEvent): boolean {
    const accumulated = event.rawAccumulatedSilence
    return event.speaking === true
      && typeof accumulated === 'number' && Number.isFinite(accumulated) && accumulated >= 0
      && event.probability <= this.#deactivationThreshold
      && accumulated + (FRAME_SAMPLES / (SAMPLE_RATE / 1_000)) >= this.#config.vadSilenceEndMs
  }

  #expectsStartEvent(event: PublicVadEvent): boolean {
    const accumulated = event.rawAccumulatedSpeech
    return event.speaking === false
      && typeof accumulated === 'number' && Number.isFinite(accumulated) && accumulated >= 0
      && event.probability >= this.#config.vadThreshold
      && accumulated + (FRAME_SAMPLES / (SAMPLE_RATE / 1_000)) >= this.#config.vadMinSpeechMs
  }

  async #endOfSpeech(epoch: LiveEpoch, event: PublicVadEvent, position: number): Promise<void> {
    const current = this.#utterance
    if (current?.phase !== 'active') return
    const silence = requiredMilliseconds(event.silenceDuration)
    current.lastSpeech = Math.min(current.lastSpeech, position - samplesForMilliseconds(silence))
    const threshold = await this.#predictionThreshold(epoch)
    if (!this.#isCurrent(epoch) || this.#utterance !== current) return
    if (threshold.probability >= threshold.unlikely) this.#commitEnd(position)
    else {
      current.phase = 'extension'
      this.#forceAtCaps(position)
    }
  }

  async #predictionThreshold(epoch: LiveEpoch): Promise<{
    readonly probability: number; readonly unlikely: number
  }> {
    const [value, unlikely] = await withDeadline(Promise.all([
      Promise.resolve(epoch.turnStream.predict().await),
      epoch.detector.unlikelyThreshold('zh'),
    ]), this.#clock, epoch.controller.signal)
    if (!finiteProbability(value.endOfTurnProbability) || !finiteProbability(unlikely)) {
      throw new Error('invalid EOT result')
    }
    return {probability: value.endOfTurnProbability, unlikely}
  }

  #forceAtCaps(position: number): void {
    const current = this.#utterance
    if (current === null) return
    const maximumReached = position - current.firstSpeech >= this.#maximumUtteranceSamples
    const extensionReached = current.phase === 'extension'
      && position - current.lastSpeech >= EXTENSION_SAMPLES
    if (maximumReached || extensionReached) this.#commitEnd(position)
  }

  #commitEnd(position: number): void {
    const current = this.#utterance
    if (current === null) return
    const padEnd = Math.min(position, current.outputCursor + this.#speechPadSamples)
    if (padEnd > current.outputCursor) {
      this.#events.push({kind: 'speech_audio', pcm: this.#slice(current.outputCursor, padEnd)})
    }
    this.#events.push({kind: 'speech_end', commit: true})
    const preRollBytes = samplesForMilliseconds(this.#config.vadPreRollMs) * BYTES_PER_SAMPLE
    const remainder = this.#slice(padEnd, position)
    this.#rotationReplay = remainder.slice(Math.max(0, remainder.byteLength - preRollBytes))
    this.#utterance = null
    if (this.#epoch !== null) this.#epoch.rotateRequested = true
    this.#pruneRecords()
  }

  #validateEventFrames(event: PublicVadEvent, position: number): {readonly start: number} {
    let samples = 0
    const bytes: Uint8Array[] = []
    for (const frame of event.frames) {
      bytes.push(audioFrameBytes(frame))
      samples += frame.samplesPerChannel
    }
    if (samples <= 0 || samples > this.#retainedSampleLimit) throw new Error('invalid VAD frames')
    const start = position - samples
    if (start < 0 || !equalBytes(this.#slice(start, position), joinBytes(bytes))) {
      throw new Error('VAD frame cursor mismatch')
    }
    return {start}
  }

  #slice(start: number, end: number): Uint8Array {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new Error('invalid endpointing cursor')
    }
    const result = new Uint8Array((end - start) * BYTES_PER_SAMPLE)
    let copied = 0
    for (const record of this.#records) {
      if (record.end <= start || record.start >= end) continue
      const from = Math.max(start, record.start)
      const to = Math.min(end, record.end)
      const sourceStart = (from - record.start) * BYTES_PER_SAMPLE
      const sourceEnd = (to - record.start) * BYTES_PER_SAMPLE
      result.set(record.pcm.subarray(sourceStart, sourceEnd), copied)
      copied += sourceEnd - sourceStart
    }
    if (copied !== result.byteLength) throw new Error('endpointing audio is outside retained ring')
    return result
  }

  #pruneRecords(): void {
    const configuredPreRoll = samplesForMilliseconds(this.#config.vadPreRollMs)
    const candidate = samplesForMilliseconds(this.#config.vadMinSpeechMs)
    const floor = this.#utterance === null
      ? Math.max(0, this.#cursor - configuredPreRoll - candidate - FRAME_SAMPLES)
      : Math.max(0, this.#cursor - this.#retainedSampleLimit)
    while (this.#records[0] !== undefined && this.#records[0].end <= floor) this.#records.shift()
  }

  async #failEpoch(epoch: LiveEpoch): Promise<never> {
    if (this.#epoch === epoch) this.#epoch = null
    this.#token += 1
    this.#clearAudioState()
    await this.#closeEpoch(epoch).catch(() => undefined)
    throw new Error('LiveKit endpointing failed')
  }

  async #rotateEpoch(epoch: LiveEpoch, signal: AbortSignal): Promise<LiveEpoch> {
    const replay = joinBytes([this.#rotationReplay, epoch.framingPartial])
    this.#rotationReplay = new Uint8Array()
    if (this.#epoch === epoch) this.#epoch = null
    const rotationToken = ++this.#token
    this.#cursor = 0
    this.#records = []
    this.#utterance = null
    await this.#closeEpoch(epoch)
    if (this.#closed || this.#token !== rotationToken) throw rotationAborted()
    const fresh = this.#createEpoch()
    for (const frame of this.#writeFrames(fresh, replay)) {
      this.#acceptFrame(fresh, frame)
      await fresh.producer.enqueue(frame, AbortSignal.any([signal, fresh.controller.signal]))
      await this.#waitForVadPosition(fresh, this.#cursor, signal)
      if (fresh.handlerTask !== null) await fresh.handlerTask
      if (fresh.failure !== null) await this.#failEpoch(fresh)
    }
    return fresh
  }

  #waitForVadPosition(epoch: LiveEpoch, position: number, signal: AbortSignal): Promise<void> {
    if (epoch.failure !== null) return Promise.reject(epoch.failure)
    if (epoch.vadCursor >= position
      && (epoch.pendingBoundaryPosition === null || position < epoch.pendingBoundaryPosition)) {
      return Promise.resolve()
    }
    const combined = AbortSignal.any([signal, epoch.controller.signal])
    return new Promise((resolve, reject) => {
      const aborted = (): void => {
        epoch.progressWaiters.delete(waiter)
        reject(abortReason(combined))
      }
      const waiter: ProgressWaiter = {
        position,
        resolve: () => { combined.removeEventListener('abort', aborted); resolve() },
        reject: error => { combined.removeEventListener('abort', aborted); reject(error) },
      }
      if (combined.aborted) { aborted(); return }
      epoch.progressWaiters.add(waiter)
      combined.addEventListener('abort', aborted, {once: true})
      if (epoch.failure !== null) {
        epoch.progressWaiters.delete(waiter)
        waiter.reject(epoch.failure)
      } else if (combined.aborted) aborted()
    })
  }

  #noteVadProgress(epoch: LiveEpoch, position: number): void {
    epoch.vadCursor = Math.max(epoch.vadCursor, position)
    setImmediate(() => {
      for (const waiter of [...epoch.progressWaiters]) {
        if (waiter.position > epoch.vadCursor) continue
        if (epoch.pendingBoundaryPosition !== null
          && waiter.position >= epoch.pendingBoundaryPosition) continue
        epoch.progressWaiters.delete(waiter)
        waiter.resolve()
      }
    })
  }

  #rejectProgress(epoch: LiveEpoch, error: Error): void {
    for (const waiter of epoch.progressWaiters) waiter.reject(error)
    epoch.progressWaiters.clear()
  }

  async #closeEpoch(epoch: LiveEpoch): Promise<void> {
    epoch.controller.abort()
    this.#rejectProgress(epoch, abortReason(epoch.controller.signal))
    let failed = false
    for (const operation of [
      () => epoch.producer.close(), () => epoch.vadStream.flush(),
      () => epoch.vadStream.close(),
    ]) {
      try { operation() } catch { failed = true }
    }
    const eotCleanup = (async () => {
      let successful = await callOutcome(() => epoch.turnStream.aclose())
      successful = await callOutcome(() => epoch.detector.aclose()) && successful
      return successful
    })()
    const tasks = [outcome(epoch.readerTask), eotCleanup, callOutcome(() => epoch.vad.close())]
    const settled = await settleWithin(Promise.all(tasks), CLEANUP_TIMEOUT_MS)
    failed = !settled || failed
    if (settled) failed = (await Promise.all(tasks)).some(success => !success) || failed
    if (failed) throw new Error('LiveKit endpointing cleanup failed')
  }

  #isCurrent(epoch: LiveEpoch): boolean {
    return this.#epoch === epoch && epoch.token === this.#token && !epoch.controller.signal.aborted
  }
  #clearAudioState(): void {
    this.#cursor = 0
    this.#partial = new Uint8Array()
    this.#rotationReplay = new Uint8Array()
    this.#records = []
    this.#utterance = null
    this.#events = []
  }
}

class OwnedFrameProducer {
  readonly stream: ReadableStream<LiveKitAudioFrame>
  #controller: ReadableStreamDefaultController<LiveKitAudioFrame> | null = null
  #capacityWaiter: (() => void) | null = null
  #closed = false
  constructor() {
    this.stream = new ReadableStream<LiveKitAudioFrame>({
      start: controller => { this.#controller = controller },
      pull: () => {
        this.#capacityWaiter?.()
        this.#capacityWaiter = null
      },
    }, {highWaterMark: 1})
  }
  async enqueue(frame: LiveKitAudioFrame, signal: AbortSignal): Promise<void> {
    if (this.#closed || this.#controller === null) throw new Error('VAD input is closed')
    while ((this.#controller.desiredSize ?? 0) <= 0) {
      await new Promise<void>((resolve, reject) => {
        const aborted = (): void => {
          this.#capacityWaiter = null
          reject(abortReason(signal))
        }
        this.#capacityWaiter = () => {
          signal.removeEventListener('abort', aborted)
          resolve()
        }
        if (signal.aborted) { aborted(); return }
        signal.addEventListener('abort', aborted, {once: true})
      })
      if (this.#closed) throw new Error('VAD input is closed')
    }
    this.#controller.enqueue(frame)
    await yieldToReaders()
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#capacityWaiter?.()
    this.#capacityWaiter = null
    this.#controller?.close()
  }
}

function validateConfig(config: LiveKitVolcEndpointingConfig): void {
  if (!Number.isFinite(config.vadThreshold) || config.vadThreshold <= 0 || config.vadThreshold > 1) {
    throw new ConfigurationError(
      'invalid configuration: NOVA_AUDIO_AGENT_VOLCENGINE_VAD_THRESHOLD',
    )
  }
  for (const [field, minimum, maximum, variable] of TIMING_LIMITS) {
    const value = config[field]
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new ConfigurationError(`invalid configuration: ${variable}`)
    }
  }
  if (config.vadMaxUtteranceMs < config.vadMinSpeechMs) {
    throw new ConfigurationError(
      'invalid configuration: NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MAX_UTTERANCE_MS',
    )
  }
}

function eventPosition(event: PublicVadEvent): number {
  if (!Number.isSafeInteger(event.samplesIndex) || (event.samplesIndex as number) < 0) {
    throw new Error('invalid VAD sample index')
  }
  return event.samplesIndex as number
}
function requiredMilliseconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('invalid VAD duration')
  }
  return value
}
function audioFrameBytes(frame: LiveKitAudioFrame): Uint8Array {
  if (frame.sampleRate !== SAMPLE_RATE || frame.channels !== 1
    || !Number.isSafeInteger(frame.samplesPerChannel) || frame.samplesPerChannel <= 0
    || frame.samplesPerChannel !== frame.data.length) {
    throw new Error('invalid LiveKit audio frame format')
  }
  const pcm = new Uint8Array(frame.data.length * BYTES_PER_SAMPLE)
  const view = new DataView(pcm.buffer)
  frame.data.forEach((sample, index) => view.setInt16(index * BYTES_PER_SAMPLE, sample, true))
  return pcm
}
function copyEndpointEvent(event: EndpointingEvent): EndpointingEvent {
  return event.kind === 'speech_end' ? {...event} : {...event, pcm: event.pcm.slice()}
}
function samplesForMilliseconds(milliseconds: number): number {
  return milliseconds * (SAMPLE_RATE / 1_000)
}
function finiteProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}
function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.byteLength }
  return result
}
async function withDeadline<T>(promise: Promise<T>, clock: Clock, signal: AbortSignal): Promise<T> {
  const timerController = new AbortController()
  const timer = clock.sleep(PREDICTION_TIMEOUT_SECONDS, timerController.signal).then(() => {
    throw new Error('LiveKit endpointing prediction timeout')
  })
  timer.catch(() => undefined)
  try { return await Promise.race([promise, timer, abortPromise(signal)]) }
  finally { timerController.abort(); await timer.catch(() => undefined) }
}
function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortReason(signal)), {once: true})
  })
}
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw abortReason(signal) }
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason : new DOMException('This operation was aborted', 'AbortError')
}
function rotationAborted(): DOMException {
  return new DOMException('Endpointing rotation was aborted', 'AbortError')
}
function callOutcome(operation: () => Promise<void>): Promise<boolean> {
  try { return outcome(operation()) } catch { return Promise.resolve(false) }
}
function outcome(promise: Promise<unknown>): Promise<boolean> {
  return promise.then(() => true, () => false)
}
async function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  promise.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds) }),
    ])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
function yieldToReaders(): Promise<void> { return new Promise(resolve => setImmediate(resolve)) }

const REAL_CLOCK: Clock = Object.freeze({
  now: () => performance.now() / 1_000,
  sleep: (duration: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (!Number.isFinite(duration) || duration < 0) { reject(new RangeError('invalid delay')); return }
    if (signal?.aborted === true) { reject(abortReason(signal)); return }
    const aborted = (): void => {
      clearTimeout(timer)
      reject(signal === undefined ? new Error('aborted') : abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }, duration * 1_000)
    timer.unref()
    signal?.addEventListener('abort', aborted, {once: true})
  }),
})
