import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {RealtimeProviderEvent} from '../src/realtime/protocol.js'
import {CascadedRealtimeAdapter} from '../src/realtime/cascaded/adapter.js'
import type {AsrClient, AsrSession, TtsClient} from '../src/realtime/cascaded/ports.js'
import type {
  CascadedLlmEvent,
  CascadedLlmSession,
} from '../src/realtime/cascaded/llm.js'

type LlmStreamInput = Parameters<CascadedLlmSession['stream']>[0]
import type {
  LiveKitAgentsPublicSurface,
  LiveKitAudioByteStream,
  LiveKitAudioFrame,
  LiveKitExecutor,
  LiveKitTurnDetector,
  LiveKitTurnStream,
  LiveKitVad,
  LiveKitVadEvent,
  LiveKitVadStream,
} from '../src/realtime/volcengine/endpointing-capability.js'
import {
  LiveKitVolcEndpointing,
  type LiveKitVolcEndpointingConfig,
} from '../src/realtime/volcengine/livekit-endpointing.js'

const FRAME_SAMPLES = 512
const FRAME_BYTES = FRAME_SAMPLES * 2
const TYPES = Object.freeze({START_OF_SPEECH: 1, INFERENCE_DONE: 2, END_OF_SPEECH: 3})

type VadEvent = LiveKitVadEvent & {
  readonly samplesIndex: number
  readonly speechDuration: number
  readonly silenceDuration: number
  readonly speaking: boolean
  readonly rawAccumulatedSilence: number
  readonly rawAccumulatedSpeech: number
  readonly defer?: boolean
  readonly closeAfter?: boolean
}

interface FakeState {
  readonly vadOptions: Readonly<Record<string, boolean | number | string>>[]
  readonly vadStreams: FakeVadStream[]
  readonly turnStreams: FakeTurnStream[]
  readonly cleanup: string[]
  readonly failedCleanup: string | null
  turnStreamClosePending: number
}

interface FakeBehavior {
  readonly turnCloseGate?: Promise<void>
  readonly turnCloseEntered?: () => void
  readonly rejectConcurrentDetectorClose?: boolean
  readonly vadCloseGate?: Promise<void>
  readonly vadCloseEntered?: () => void
}

function config(overrides: Partial<LiveKitVolcEndpointingConfig> = {}): LiveKitVolcEndpointingConfig {
  return {
    vadThreshold: 0.5,
    vadPreRollMs: 32,
    vadMinSpeechMs: 32,
    vadSilenceEndMs: 64,
    vadSpeechPadMs: 30,
    vadMaxUtteranceMs: 15_000,
    ...overrides,
  }
}

function pcmWindow(sample: number): Uint8Array {
  const pcm = new Uint8Array(FRAME_BYTES)
  const view = new DataView(pcm.buffer)
  for (let offset = 0; offset < pcm.byteLength; offset += 2) view.setInt16(offset, sample, true)
  return pcm
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function countSample(pcm: Uint8Array, expected: number): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let count = 0
  for (let offset = 0; offset < pcm.byteLength; offset += 2) {
    if (view.getInt16(offset, true) === expected) count += 1
  }
  return count
}

function deferred(): {readonly promise: Promise<void>; readonly resolve: () => void} {
  let resolve = (): void => undefined
  const promise = new Promise<void>(settle => { resolve = settle })
  return {promise, resolve}
}

function inference(frame: LiveKitAudioFrame, samplesIndex: number, probability: number): VadEvent {
  return {
    type: TYPES.INFERENCE_DONE,
    probability,
    frames: [frame],
    samplesIndex,
    speechDuration: 0,
    silenceDuration: 0,
    speaking: probability > 0.35,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech: 0,
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = []
  #waiter: ((result: IteratorResult<T>) => void) | null = null
  #closed = false

  push(item: T): void {
    if (this.#closed) return
    if (this.#waiter !== null) {
      const waiter = this.#waiter
      this.#waiter = null
      waiter({done: false, value: item})
      return
    }
    this.#items.push(item)
  }

  close(): void {
    this.#closed = true
    this.#waiter?.({done: true, value: undefined})
    this.#waiter = null
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {next: async () => {
      const item = this.#items.shift()
      if (item !== undefined) return {done: false, value: item}
      if (this.#closed) return {done: true, value: undefined}
      return await new Promise(resolve => { this.#waiter = resolve })
    }}
  }
}

type FrameScript = (
  frame: LiveKitAudioFrame,
  frameNumber: number,
  allFrames: readonly LiveKitAudioFrame[],
) => readonly VadEvent[]

class FakeVadStream implements LiveKitVadStream {
  readonly #events = new AsyncQueue<LiveKitVadEvent>()
  readonly #script: FrameScript
  readonly #state: FakeState
  readonly frames: LiveKitAudioFrame[] = []

  constructor(script: FrameScript, state: FakeState) {
    this.#script = script
    this.#state = state
  }

  updateInputStream(stream: ReadableStream<LiveKitAudioFrame>): void {
    void (async () => {
      for await (const frame of stream) {
        this.frames.push(frame)
        for (const event of this.#script(frame, this.frames.length, this.frames)) {
          if (event.defer === true) setImmediate(() => this.#events.push(event))
          else this.#events.push(event)
          if (event.closeAfter === true) this.#events.close()
        }
      }
    })()
  }

  flush(): void {
    this.#state.cleanup.push('vad.flush')
    if (this.#state.failedCleanup === 'vad.flush') throw new Error('cleanup failed')
  }
  emit(event: LiveKitVadEvent): void { this.#events.push(event) }
  close(): void {
    this.#state.cleanup.push('vad.stream.close')
    this.#events.close()
    if (this.#state.failedCleanup === 'vad.stream.close') throw new Error('cleanup failed')
  }
  [Symbol.asyncIterator](): AsyncIterator<LiveKitVadEvent> {
    return this.#events[Symbol.asyncIterator]()
  }
}

class FakeTurnStream implements LiveKitTurnStream {
  readonly model = 'turn-detector-v1-mini'
  readonly frames: LiveKitAudioFrame[] = []
  readonly #probabilities: (number | Promise<number>)[]
  readonly #state: FakeState
  readonly #behavior: FakeBehavior

  constructor(
    probabilities: readonly (number | Promise<number>)[],
    state: FakeState,
    behavior: FakeBehavior,
  ) {
    this.#probabilities = [...probabilities]
    this.#state = state
    this.#behavior = behavior
  }

  pushAudio(frame: LiveKitAudioFrame): void { this.frames.push(frame) }
  predict(): {readonly await: PromiseLike<{readonly endOfTurnProbability: number}>} {
    const probability = this.#probabilities.shift() ?? 1
    return {await: Promise.resolve(probability).then(endOfTurnProbability => ({
      endOfTurnProbability,
    }))}
  }
  async aclose(): Promise<void> {
    this.#state.cleanup.push('turn.stream.aclose')
    this.#state.turnStreamClosePending += 1
    this.#behavior.turnCloseEntered?.()
    try {
      await this.#behavior.turnCloseGate
      if (this.#state.failedCleanup === 'turn.stream.aclose') throw new Error('cleanup failed')
    } finally {
      this.#state.turnStreamClosePending -= 1
    }
  }
}

class FakeByteStream implements LiveKitAudioByteStream {
  #partial: Uint8Array<ArrayBufferLike> = new Uint8Array()

  write(data: ArrayBufferLike | ArrayBufferView): readonly LiveKitAudioFrame[] {
    const incoming = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)
    this.#partial = concat(this.#partial, incoming)
    const frames: LiveKitAudioFrame[] = []
    while (this.#partial.byteLength >= FRAME_BYTES) {
      const bytes = this.#partial.slice(0, FRAME_BYTES)
      this.#partial = this.#partial.slice(FRAME_BYTES)
      const samples = new Int16Array(FRAME_SAMPLES)
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = view.getInt16(index * 2, true)
      }
      frames.push({data: samples, sampleRate: 16_000, channels: 1, samplesPerChannel: FRAME_SAMPLES})
    }
    return frames
  }

  flush(): readonly LiveKitAudioFrame[] { return [] }
}

function fakeSurface(
  script: FrameScript,
  probabilities: readonly (number | Promise<number>)[] = [0.8],
  failedCleanup: string | null = null,
  unlikelyThreshold: number | Promise<number> = 0.5,
  behavior: FakeBehavior = {},
): {readonly surface: LiveKitAgentsPublicSurface; readonly state: FakeState} {
  const state: FakeState = {
    vadOptions: [], vadStreams: [], turnStreams: [], cleanup: [], failedCleanup,
    turnStreamClosePending: 0,
  }
  const Vad = class implements LiveKitVad {
    constructor(options: Readonly<Record<string, boolean | number | string>>) {
      state.vadOptions.push(options)
    }
    stream(): LiveKitVadStream {
      const stream = new FakeVadStream(script, state)
      state.vadStreams.push(stream)
      return stream
    }
    async close(): Promise<void> {
      state.cleanup.push('vad.close')
      behavior.vadCloseEntered?.()
      await behavior.vadCloseGate
      if (state.failedCleanup === 'vad.close') throw new Error('cleanup failed')
    }
  }
  const Detector = class implements LiveKitTurnDetector {
    readonly model = 'turn-detector-v1-mini'
    supportsLanguage(): Promise<boolean> { return Promise.resolve(true) }
    unlikelyThreshold(): Promise<number> { return Promise.resolve(unlikelyThreshold) }
    stream(): LiveKitTurnStream {
      const stream = new FakeTurnStream(probabilities, state, behavior)
      state.turnStreams.push(stream)
      return stream
    }
    aclose(): Promise<void> {
      state.cleanup.push('turn.detector.aclose')
      if (behavior.rejectConcurrentDetectorClose === true
        && state.turnStreamClosePending > 0) {
        return Promise.reject(new Error('ERR_INVALID_STATE: WritableStream is closed'))
      }
      return state.failedCleanup === 'turn.detector.aclose'
        ? Promise.reject(new Error('cleanup failed')) : Promise.resolve()
    }
  }
  return {
    state,
    surface: {
      version: '1.6.4',
      initializeLogger: () => undefined,
      getJobContext: () => undefined,
      inference: {VAD: Vad, TurnDetector: Detector},
      AudioByteStream: FakeByteStream,
      VADEventType: TYPES,
    },
  }
}

const executor: LiveKitExecutor = {doInference: () => Promise.resolve({})}

test('projects copied VAD start, active audio, exact speech pad, and one committed end', async () => {
  const first = pcmWindow(100)
  const second = pcmWindow(200)
  const third = pcmWindow(300)
  const fourth = pcmWindow(400)
  const {surface, state} = fakeSurface((frame, number, allFrames) => {
    const samplesIndex = number * FRAME_SAMPLES
    if (number === 1 && frame.data[0] === 100) return [
      inference(frame, samplesIndex, 0.9),
      {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
        frames: [frame], speechDuration: 32, speaking: true},
    ]
    if (number === 2 && frame.data[0] === 200) return [inference(frame, samplesIndex, 0.9)]
    if (number === 3 && frame.data[0] === 300) return [inference(frame, samplesIndex, 0.1)]
    if (number === 4 && frame.data[0] === 400) return [
      inference(frame, samplesIndex, 0.1),
      {...inference(frame, samplesIndex, 0.1), type: TYPES.END_OF_SPEECH,
        frames: allFrames, speechDuration: 64, silenceDuration: 64, speaking: false},
    ]
    return [inference(frame, samplesIndex, 0.1)]
  })
  const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
  const events = []
  for (const pcm of [first, second, third, fourth]) {
    events.push(...await endpointing.feed(pcm, new AbortController().signal))
  }

  assert.deepEqual(events.map(event => event.kind), [
    'speech_start', 'speech_audio', 'speech_audio', 'speech_end',
  ])
  assert.deepEqual(events[0]?.kind === 'speech_start' ? events[0].pcm : null, first)
  assert.deepEqual(events[1]?.kind === 'speech_audio' ? events[1].pcm : null, second)
  assert.deepEqual(events[2]?.kind === 'speech_audio' ? events[2].pcm : null,
    concat(third, fourth).slice(0, 960))
  assert.deepEqual(events[3], {kind: 'speech_end', commit: true})
  const expectedVadOptions = {
    model: 'silero', minSpeechDuration: 32, minSilenceDuration: 64,
    prefixPaddingDuration: 32, maxBufferedSpeech: 15_000,
    activationThreshold: 0.5, deactivationThreshold: 0.35,
  }
  assert.equal(state.vadOptions.length, 2)
  assert.ok(state.vadOptions.every(options => (
    JSON.stringify(options) === JSON.stringify(expectedVadOptions)
  )))
  first.fill(0)
  assert.equal(events[0]?.kind === 'speech_start' ? events[0].pcm[0] : 0, 100)
  await endpointing.close()
  assert.deepEqual(state.cleanup, [
    'vad.flush', 'vad.stream.close', 'turn.stream.aclose',
    'vad.close', 'turn.detector.aclose',
    'vad.flush', 'vad.stream.close', 'turn.stream.aclose',
    'vad.close', 'turn.detector.aclose',
  ])
})

test('an unlikely EOT holds one logical utterance and replays its pause exactly once', async () => {
  const first = pcmWindow(10)
  const pause = pcmWindow(20)
  const resumed = pcmWindow(30)
  const {surface} = fakeSurface((frame, number, allFrames) => {
    const samplesIndex = number * FRAME_SAMPLES
    if (number === 1) return [
      inference(frame, samplesIndex, 0.9),
      {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
        speechDuration: 32, speaking: true},
    ]
    if (number === 2) return [
      inference(frame, samplesIndex, 0.1),
      {...inference(frame, samplesIndex, 0.1), type: TYPES.END_OF_SPEECH,
        frames: allFrames, speechDuration: 32, silenceDuration: 32, speaking: false},
    ]
    return [
      inference(frame, samplesIndex, 0.9),
      {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
        speechDuration: 32, speaking: true},
    ]
  }, [0.2])
  const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
  const events = []
  for (const pcm of [first, pause, resumed]) {
    events.push(...await endpointing.feed(pcm, new AbortController().signal))
  }
  assert.deepEqual(events.map(event => event.kind), ['speech_start', 'speech_audio'])
  assert.deepEqual(events[1]?.kind === 'speech_audio' ? events[1].pcm : null,
    concat(pause, resumed))
  await endpointing.close()
})

test('feed waits for an asynchronous same-index END and its EOT before returning terminal events',
  async () => {
    const {surface} = fakeSurface((frame, number, allFrames) => {
      const samplesIndex = number * FRAME_SAMPLES
      if (number === 1) return [
        inference(frame, samplesIndex, 0.9),
        {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
          speechDuration: 32, speaking: true},
      ]
      return [
        {...inference(frame, samplesIndex, 0.1), speaking: true, rawAccumulatedSilence: 32},
        {...inference(frame, samplesIndex, 0.1), type: TYPES.END_OF_SPEECH,
          frames: allFrames, speechDuration: 32, silenceDuration: 32, speaking: false,
          rawAccumulatedSilence: 64, defer: true},
      ]
    })
    const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
    await endpointing.feed(pcmWindow(10), new AbortController().signal)
    const terminal = await endpointing.feed(pcmWindow(0), new AbortController().signal)
    assert.deepEqual(terminal.map(event => event.kind), ['speech_audio', 'speech_end'])
    await endpointing.close()
  })

test('feed waits for an asynchronous same-index START before returning the first speech event',
  async () => {
    const {surface} = fakeSurface((frame, number) => [
      {...inference(frame, number * FRAME_SAMPLES, 0.9), speaking: false,
        rawAccumulatedSpeech: 0},
      {...inference(frame, number * FRAME_SAMPLES, 0.9), type: TYPES.START_OF_SPEECH,
        speaking: true, speechDuration: 32, defer: true},
    ])
    const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
    const started = await endpointing.feed(pcmWindow(9), new AbortController().signal)
    assert.deepEqual(started.map(event => event.kind), ['speech_start'])
    await endpointing.close()
  })

test('epoch rotation preserves partial post-boundary PCM for the next utterance', async () => {
  const {surface} = fakeSurface((frame, number, allFrames) => {
    const samplesIndex = number * FRAME_SAMPLES
    if (number === 1) return [
      inference(frame, samplesIndex, 0.9),
      {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
        speechDuration: 32, speaking: true},
    ]
    return [
      {...inference(frame, samplesIndex, 0.1), speaking: true, rawAccumulatedSilence: 32},
      {...inference(frame, samplesIndex, 0.1), type: TYPES.END_OF_SPEECH,
        frames: allFrames, speechDuration: 32, silenceDuration: 32, speaking: false,
        rawAccumulatedSilence: 64},
    ]
  })
  const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
  await endpointing.feed(pcmWindow(11), new AbortController().signal)
  const next = pcmWindow(12)
  const ended = await endpointing.feed(concat(pcmWindow(0), next.slice(0, 512)),
    new AbortController().signal)
  assert.equal(ended.at(-1)?.kind, 'speech_end')
  const restarted = await endpointing.feed(next.slice(512), new AbortController().signal)
  assert.deepEqual(restarted.map(event => event.kind), ['speech_start'])
  assert.deepEqual(restarted[0]?.kind === 'speech_start' ? restarted[0].pcm : null,
    concat(new Uint8Array(64), next.slice(0, 960)))
  await endpointing.close()
})

test('completed tail beyond speech pad is replayed as bounded pre-roll into the fresh epoch',
  async () => {
    const {surface} = fakeSurface((frame, number, allFrames) => {
      const samplesIndex = number * FRAME_SAMPLES
      if (frame.data[0] === 0) {
        if (number === 2 && allFrames[0]?.data[0] !== 0) return [
          {...inference(frame, samplesIndex, 0.1), speaking: true, rawAccumulatedSilence: 32},
          {...inference(frame, samplesIndex, 0.1), type: TYPES.END_OF_SPEECH,
            frames: allFrames, speaking: false, speechDuration: 32, silenceDuration: 32},
        ]
        return [inference(frame, samplesIndex, 0.1)]
      }
      return [
        {...inference(frame, samplesIndex, 0.9), speaking: false, rawAccumulatedSpeech: 0},
        {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
          frames: allFrames, speaking: true, speechDuration: 32},
      ]
    })
    const endpointing = new LiveKitVolcEndpointing({
      surface, executor, config: config({vadPreRollMs: 64, vadSpeechPadMs: 0}),
    })
    await endpointing.feed(pcmWindow(1), new AbortController().signal)
    const terminal = await endpointing.feed(pcmWindow(0), new AbortController().signal)
    assert.equal(terminal.at(-1)?.kind, 'speech_end')
    const restarted = await endpointing.feed(pcmWindow(2), new AbortController().signal)
    assert.deepEqual(restarted.map(event => event.kind), ['speech_start'])
    assert.deepEqual(restarted[0]?.kind === 'speech_start' ? restarted[0].pcm : null,
      concat(pcmWindow(0), pcmWindow(2)))
    await endpointing.close()
  })

test('two non-frame-aligned rotations retain each pending tail without loss or duplication',
  async () => {
    let speaking = false
    const {surface} = fakeSurface((frame, number, allFrames) => {
      const samplesIndex = number * FRAME_SAMPLES
      if (!speaking) {
        speaking = true
        return [
          {...inference(frame, samplesIndex, 0.9), speaking: false, rawAccumulatedSpeech: 0},
          {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
            frames: allFrames, speaking: true, speechDuration: 32},
        ]
      }
      speaking = false
      return [
        {...inference(frame, samplesIndex, 0.1), speaking: true, rawAccumulatedSilence: 32},
        {...inference(frame, samplesIndex, 0.1), type: TYPES.END_OF_SPEECH,
          frames: allFrames, speaking: false, speechDuration: 32, silenceDuration: 32},
      ]
    })
    const endpointing = new LiveKitVolcEndpointing({
      surface, executor, config: config({vadPreRollMs: 64, vadSpeechPadMs: 30}),
    })
    await endpointing.feed(pcmWindow(1), new AbortController().signal)
    await endpointing.feed(pcmWindow(0), new AbortController().signal)
    const second = [
      ...await endpointing.feed(pcmWindow(2), new AbortController().signal),
      ...await endpointing.feed(pcmWindow(0), new AbortController().signal),
    ]
    assert.equal(second.filter(event => event.kind !== 'speech_end')
      .reduce((total, event) => total + countSample(event.pcm, 2), 0), FRAME_SAMPLES)
    const third = await endpointing.feed(pcmWindow(3), new AbortController().signal)
    assert.deepEqual(third.map(event => event.kind), ['speech_start'])
    assert.equal(third[0]?.kind === 'speech_start' ? countSample(third[0].pcm, 0) : -1, 64)
    assert.equal(third[0]?.kind === 'speech_start' ? countSample(third[0].pcm, 3) : -1, 448)
    await endpointing.close()
  })

test('unlikely EOT extension is forced once on the first frame at or after 2.5 seconds', async () => {
  const active = pcmWindow(40)
  const quiet = pcmWindow(0)
  const {surface} = fakeSurface((frame, number, allFrames) => {
    const samplesIndex = number * FRAME_SAMPLES
    if (number === 1 && frame.data[0] === 40) return [
      inference(frame, samplesIndex, 0.9),
      {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
        speechDuration: 32, speaking: true},
    ]
    if (number === 2 && frame.data[0] === 0) return [
      inference(frame, samplesIndex, 0.1),
      {...inference(frame, samplesIndex, 0.1), type: TYPES.END_OF_SPEECH,
        frames: allFrames, speechDuration: 32, silenceDuration: 32, speaking: false},
    ]
    return [inference(frame, samplesIndex, 0.1)]
  }, [0.1])
  const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
  const events = []
  events.push(...await endpointing.feed(active, new AbortController().signal))
  for (let index = 0; index < 80; index += 1) {
    const batch = await endpointing.feed(quiet, new AbortController().signal)
    events.push(...batch)
    if (batch.some(event => event.kind === 'speech_end')) break
  }
  assert.equal(events.filter(event => event.kind === 'speech_end').length, 1)
  assert.deepEqual(events.at(-1), {kind: 'speech_end', commit: true})
  assert.equal(events.find(event => event.kind === 'speech_audio')?.kind === 'speech_audio'
    ? events.find(event => event.kind === 'speech_audio')!.pcm.byteLength : -1, 960)
  await endpointing.close()
})

test('configured maximum utterance forces one end at the first complete frame after 15 seconds',
  async () => {
    const active = pcmWindow(50)
    const {surface} = fakeSurface((frame, number) => {
      const samplesIndex = number * FRAME_SAMPLES
      return number === 1 ? [
        inference(frame, samplesIndex, 0.9),
        {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
          speechDuration: 32, speaking: true},
      ] : [inference(frame, samplesIndex, 0.9)]
    })
    const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
    const events = []
    for (let index = 0; index < 469; index += 1) {
      events.push(...await endpointing.feed(active, new AbortController().signal))
    }
    assert.equal(events.filter(event => event.kind === 'speech_start').length, 1)
    assert.equal(events.filter(event => event.kind === 'speech_end').length, 1)
    assert.equal(events.filter(event => event.kind !== 'speech_end')
      .reduce((bytes, event) => bytes + event.pcm.byteLength, 0), 469 * FRAME_BYTES)
    await endpointing.close()
  })

test('a prediction timeout rejects the utterance and closes every accepted public resource',
  async () => {
    const never = new Promise<number>(() => undefined)
    const {surface, state} = fakeSurface((frame, number, allFrames) => {
      const samplesIndex = number * FRAME_SAMPLES
      if (number === 1) return [
        inference(frame, samplesIndex, 0.9),
        {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
          speechDuration: 32, speaking: true},
      ]
      return [
        inference(frame, samplesIndex, 0.1),
        {...inference(frame, samplesIndex, 0.1), type: TYPES.END_OF_SPEECH,
          frames: allFrames, speechDuration: 32, silenceDuration: 32, speaking: false},
      ]
    }, [never])
    const clock = {now: () => 0, sleep: () => Promise.resolve()}
    const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config(), clock})
    await endpointing.feed(pcmWindow(60), new AbortController().signal)
    await assert.rejects(endpointing.feed(pcmWindow(0), new AbortController().signal),
      /LiveKit endpointing failed/u)
    assert.deepEqual(state.cleanup, [
      'vad.flush', 'vad.stream.close', 'turn.stream.aclose',
      'vad.close', 'turn.detector.aclose',
    ])
    await endpointing.close()
  })

test('the zh unlikely-threshold lookup shares the same 1.25 second abort-aware EOT deadline',
  async () => {
    const never = new Promise<number>(() => undefined)
    const {surface} = fakeSurface((frame, number, allFrames) => {
      const samplesIndex = number * FRAME_SAMPLES
      if (number === 1) return [
        inference(frame, samplesIndex, 0.9),
        {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
          speechDuration: 32, speaking: true},
      ]
      return [
        inference(frame, samplesIndex, 0.1),
        {...inference(frame, samplesIndex, 0.1), type: TYPES.END_OF_SPEECH,
          frames: allFrames, speechDuration: 32, silenceDuration: 32, speaking: false},
      ]
    }, [0.8], null, never)
    const endpointing = new LiveKitVolcEndpointing({
      surface, executor, config: config(), clock: {now: () => 0, sleep: () => Promise.resolve()},
    })
    await endpointing.feed(pcmWindow(1), new AbortController().signal)
    await assert.rejects(endpointing.feed(pcmWindow(0), new AbortController().signal),
      /LiveKit endpointing failed/u)
    await endpointing.close()
  })

test('Task3 absolute timing ceilings are enforced before native construction', () => {
  const {surface, state} = fakeSurface(() => [])
  const cases: readonly [keyof LiveKitVolcEndpointingConfig, number, string][] = [
    ['vadPreRollMs', 2_001, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_PRE_ROLL_MS'],
    ['vadMinSpeechMs', 10_001, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MIN_SPEECH_MS'],
    ['vadSilenceEndMs', 10_001, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SILENCE_END_MS'],
    ['vadSpeechPadMs', 2_001, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SPEECH_PAD_MS'],
    ['vadMaxUtteranceMs', 60_001, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MAX_UTTERANCE_MS'],
  ]
  for (const [field, value, variable] of cases) {
    assert.throws(() => new LiveKitVolcEndpointing({
      surface, executor, config: config({[field]: value}),
    }), new RegExp(variable, 'u'))
  }
  assert.equal(state.vadOptions.length, 0)
})

test('reset aborts a pending prediction, fences the stale reader, and creates a fresh epoch',
  async () => {
    const never = new Promise<number>(() => undefined)
    const {surface, state} = fakeSurface((frame, number, allFrames) => {
      const samplesIndex = number * FRAME_SAMPLES
      if (number === 1) return [
        inference(frame, samplesIndex, 0.9),
        {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
          speechDuration: 32, speaking: true},
      ]
      return [
        inference(frame, samplesIndex, 0.1),
        {...inference(frame, samplesIndex, 0.1), type: TYPES.END_OF_SPEECH,
          frames: allFrames, speechDuration: 32, silenceDuration: 32, speaking: false},
      ]
    }, [never])
    const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
    await endpointing.feed(pcmWindow(70), new AbortController().signal)
    const pending = endpointing.feed(pcmWindow(0), new AbortController().signal)
    await new Promise(resolve => setImmediate(resolve))
    state.vadStreams[0]?.emit({
      ...inference({data: new Int16Array(FRAME_SAMPLES), sampleRate: 16_000, channels: 1,
        samplesPerChannel: FRAME_SAMPLES}, FRAME_SAMPLES, 0.9),
      type: TYPES.START_OF_SPEECH,
    })
    const resetting = endpointing.reset()
    await assert.rejects(pending, {name: 'AbortError'})
    await resetting
    assert.equal(state.vadStreams.length, 2)
    const fresh = await endpointing.feed(pcmWindow(0), new AbortController().signal)
    assert.deepEqual(fresh.map(event => event.kind), ['speech_start'])
    await endpointing.close()
  })

test('24 kHz public event frames are rejected and caller/event bytes never alias', async () => {
  let emittedFrame: LiveKitAudioFrame | null = null
  const {surface} = fakeSurface((frame, number) => {
    emittedFrame = frame
    return [{...inference(frame, number * FRAME_SAMPLES, 0.9), sampleRate: 24_000,
      frames: [{...frame, sampleRate: 24_000}]}]
  })
  const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
  await assert.rejects(settleWithin('24 kHz frame rejection',
    endpointing.feed(pcmWindow(80), new AbortController().signal)),
    /LiveKit endpointing failed/u)
  assert.ok(emittedFrame !== null)
  await endpointing.close()
})

test('an unexpectedly completed VAD iterator rejects the active feed without hanging', async () => {
  const {surface} = fakeSurface((frame, number) => [
    {...inference(frame, number * FRAME_SAMPLES, 0.1), closeAfter: true},
  ])
  const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
  await assert.rejects(settleWithin('completed VAD iterator rejection',
    endpointing.feed(pcmWindow(0), new AbortController().signal)),
  /LiveKit endpointing failed/u)
  await endpointing.close()
})

test('feeds are copied, serialized, bounded to 64 KiB, and one abort does not poison the next',
  async () => {
    const {surface} = fakeSurface((frame, number) => number === 1 ? [
      inference(frame, FRAME_SAMPLES, 0.9),
      {...inference(frame, FRAME_SAMPLES, 0.9), type: TYPES.START_OF_SPEECH,
        speechDuration: 32, speaking: true},
    ] : [inference(frame, number * FRAME_SAMPLES, 0.9)])
    const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
    await assert.rejects(endpointing.feed(new Uint8Array(65_538), new AbortController().signal))
    const first = pcmWindow(90)
    const second = pcmWindow(91)
    const firstCall = endpointing.feed(first, new AbortController().signal)
    const secondCall = endpointing.feed(second, new AbortController().signal)
    first.fill(0)
    second.fill(0)
    const events = [...await firstCall, ...await secondCall]
    assert.equal(events[0]?.kind === 'speech_start' ? events[0].pcm[0] : -1, 90)
    assert.equal(events[1]?.kind === 'speech_audio' ? events[1].pcm[0] : -1, 91)

    await endpointing.reset()
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(endpointing.feed(pcmWindow(92), aborted.signal), {name: 'AbortError'})
    const fresh = await endpointing.feed(pcmWindow(93), new AbortController().signal)
    assert.deepEqual(fresh.map(event => event.kind), ['speech_start'])
    await endpointing.close()
  })

test('cleanup failure still attempts every public close and close remains terminal and idempotent',
  async () => {
    const {surface, state} = fakeSurface((frame, number) => [
      inference(frame, number * FRAME_SAMPLES, 0),
    ], [0.8], 'turn.stream.aclose')
    const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
    await endpointing.feed(pcmWindow(1), new AbortController().signal)
    const firstClose = endpointing.close()
    assert.equal(endpointing.close(), firstClose)
    await assert.rejects(firstClose, /cleanup failed/u)
    assert.deepEqual(state.cleanup, [
      'vad.flush', 'vad.stream.close', 'turn.stream.aclose',
      'vad.close', 'turn.detector.aclose',
    ])
    await assert.rejects(endpointing.feed(pcmWindow(1), new AbortController().signal),
      /closed/u)
  })

test('turn stream settles before detector close so owned EOT resources are not double-closed',
  async () => {
    const gate = deferred()
    const entered = deferred()
    const {surface, state} = fakeSurface((frame, number) => [
      inference(frame, number * FRAME_SAMPLES, 0.1),
    ], [0.8], null, 0.5, {
      turnCloseGate: gate.promise,
      turnCloseEntered: entered.resolve,
      rejectConcurrentDetectorClose: true,
    })
    const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
    await endpointing.feed(pcmWindow(0), new AbortController().signal)
    const closing = endpointing.close()
    await settleWithin('turn stream close entry', entered.promise)
    assert.equal(state.cleanup.includes('turn.detector.aclose'), false)
    gate.resolve()
    await settleWithin('ordered EOT cleanup', closing)
    assert.ok(state.cleanup.indexOf('turn.stream.aclose')
      < state.cleanup.indexOf('turn.detector.aclose'))
  })

test('close fences rotation while old cleanup is pending and never constructs epoch two', async () => {
  const cleanupGate = deferred()
  const cleanupEntered = deferred()
  let committed = false
  const {surface, state} = fakeSurface((frame, number, allFrames) => {
    const samplesIndex = number * FRAME_SAMPLES
    if (committed) return []
    if (number === 1) return [
      inference(frame, samplesIndex, 0.9),
      {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
        speechDuration: 32, speaking: true},
    ]
    committed = true
    return [
      {...inference(frame, samplesIndex, 0.1), speaking: true, rawAccumulatedSilence: 32},
      {...inference(frame, samplesIndex, 0.1), type: TYPES.END_OF_SPEECH,
        frames: allFrames, speechDuration: 32, silenceDuration: 32, speaking: false},
    ]
  }, [0.8], null, 0.5, {
    vadCloseGate: cleanupGate.promise,
    vadCloseEntered: cleanupEntered.resolve,
  })
  const endpointing = new LiveKitVolcEndpointing({
    surface, executor, config: config({vadSpeechPadMs: 0}),
  })
  await endpointing.feed(pcmWindow(1), new AbortController().signal)
  const rotating = endpointing.feed(pcmWindow(0), new AbortController().signal)
  await settleWithin('old epoch cleanup entry', cleanupEntered.promise)
  const closing = endpointing.close()
  cleanupGate.resolve()
  await assert.rejects(settleWithin('fenced rotation feed', rotating), {name: 'AbortError'})
  await settleWithin('close during rotation cleanup', closing)
  assert.equal(state.vadStreams.length, 1)
})

test('close aborts a fresh epoch that is waiting for replay VAD progress', async () => {
  let committed = false
  const {surface, state} = fakeSurface((frame, number, allFrames) => {
    const samplesIndex = number * FRAME_SAMPLES
    if (committed) return []
    if (number === 1) return [
      inference(frame, samplesIndex, 0.9),
      {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
        speechDuration: 32, speaking: true},
    ]
    committed = true
    return [
      {...inference(frame, samplesIndex, 0.1), speaking: true, rawAccumulatedSilence: 32},
      {...inference(frame, samplesIndex, 0.1), type: TYPES.END_OF_SPEECH,
        frames: allFrames, speechDuration: 32, silenceDuration: 32, speaking: false},
    ]
  })
  const endpointing = new LiveKitVolcEndpointing({
    surface, executor, config: config({vadSpeechPadMs: 0}),
  })
  await endpointing.feed(pcmWindow(1), new AbortController().signal)
  const rotating = endpointing.feed(pcmWindow(0), new AbortController().signal)
  await waitFor('fresh replay epoch', () => state.vadStreams.length === 2)
  const closing = endpointing.close()
  await assert.rejects(settleWithin('aborted replay feed', rotating), {name: 'AbortError'})
  await settleWithin('close during replay progress', closing)
  assert.equal(state.vadStreams.length, 2)
})

test('wholesale VAD frames beyond max utterance plus pre-roll are rejected instead of retained',
  async () => {
    const {surface} = fakeSurface((frame, number, allFrames) => {
      const samplesIndex = number * FRAME_SAMPLES
      if (number < 490) return [inference(frame, samplesIndex, 0)]
      return [{...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
        frames: allFrames, speechDuration: 32, speaking: true}]
    })
    const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
    for (let index = 0; index < 489; index += 1) {
      await endpointing.feed(pcmWindow(0), new AbortController().signal)
    }
    await assert.rejects(endpointing.feed(pcmWindow(1), new AbortController().signal),
      /LiveKit endpointing failed/u)
    await endpointing.close()
  })

class OrderedAsrSession implements AsrSession {
  readonly operations: string[]
  readonly appended: Uint8Array[] = []
  #release: (() => void) | null = null
  readonly #finished = new Promise<void>(resolve => { this.#release = resolve })

  constructor(operations: string[]) { this.operations = operations }
  append(pcm: Uint8Array): Promise<void> {
    this.operations.push('asr.append')
    this.appended.push(pcm.slice())
    return Promise.resolve()
  }
  finish(): Promise<void> {
    this.operations.push('asr.finish')
    this.#release?.()
    return Promise.resolve()
  }
  async *events(): AsyncIterable<{readonly text: string; readonly final: boolean}> {
    await this.#finished
    yield {text: '你好', final: true}
  }
  close(): Promise<void> {
    this.operations.push('asr.close')
    this.#release?.()
    return Promise.resolve()
  }
}

class OrderedAsrClient implements AsrClient {
  readonly session: OrderedAsrSession
  readonly operations: string[]
  constructor(operations: string[]) {
    this.operations = operations
    this.session = new OrderedAsrSession(operations)
  }
  open(): Promise<AsrSession> {
    this.operations.push('asr.open')
    return Promise.resolve(this.session)
  }
}

class EmptyLlm implements CascadedLlmSession {
  async *stream(input: LlmStreamInput): AsyncIterable<CascadedLlmEvent> {
    void input
    await Promise.resolve()
  }
  close(): Promise<void> { return Promise.resolve() }
}

const unusedTts: TtsClient = {
  open: () => Promise.reject(new Error('TTS is not expected in endpointing integration')),
}

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} did not settle`)
    await new Promise(resolve => setImmediate(resolve))
  }
}

async function settleWithin<T>(label: string, promise: Promise<T>, milliseconds = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

test('real Task7B adapter preserves endpoint start/audio/end, ASR, and transcript ordering',
  async () => {
    const first = pcmWindow(100)
    const second = pcmWindow(200)
    const third = pcmWindow(300)
    const fourth = pcmWindow(400)
    const {surface} = fakeSurface((frame, number, allFrames) => {
      const samplesIndex = number * FRAME_SAMPLES
      if (number === 1 && frame.data[0] === 100) return [
        inference(frame, samplesIndex, 0.9),
        {...inference(frame, samplesIndex, 0.9), type: TYPES.START_OF_SPEECH,
          speechDuration: 32, speaking: true},
      ]
      if (number === 2 && frame.data[0] === 200) return [inference(frame, samplesIndex, 0.9)]
      if (number === 3 && frame.data[0] === 300) return [inference(frame, samplesIndex, 0.1)]
      if (number === 4 && frame.data[0] === 400) return [
        inference(frame, samplesIndex, 0.1),
        {...inference(frame, samplesIndex, 0.1), type: TYPES.END_OF_SPEECH,
          frames: allFrames, speechDuration: 64, silenceDuration: 64, speaking: false},
      ]
      return [inference(frame, samplesIndex, 0.1)]
    })
    const endpointing = new LiveKitVolcEndpointing({surface, executor, config: config()})
    const operations: string[] = []
    const asr = new OrderedAsrClient(operations)
    let nextId = 0
    const adapter = new CascadedRealtimeAdapter({
      endpointing, asr, tts: unusedTts, llm: new EmptyLlm(),
      idFactory: () => `livekit-order-${++nextId}`,
    })
    await adapter.connect({tools: [], signal: new AbortController().signal})
    const observerController = new AbortController()
    const observed: RealtimeProviderEvent[] = []
    const observer = (async () => {
      for await (const event of adapter.events(observerController.signal)) observed.push(event)
    })()
    try {
      for (const pcm of [first, second, third, fourth]) {
        await adapter.sendAudio(pcm, new AbortController().signal)
      }
      await waitFor('ASR transcript', () => observed.some(event => event.kind === 'user_transcript_final'))
      assert.deepEqual(operations.slice(0, 5), [
        'asr.open', 'asr.append', 'asr.append', 'asr.append', 'asr.finish',
      ])
      assert.deepEqual(asr.session.appended, [first, second, concat(third, fourth).slice(0, 960)])
      assert.deepEqual(observed.filter(event => event.kind.startsWith('user_')).map(event => event.kind), [
        'user_speech_started', 'user_speech_ended', 'user_transcript_final',
      ])
    } finally {
      observerController.abort()
      await observer
      await adapter.close().catch(() => undefined)
      await endpointing.close()
    }
  })
