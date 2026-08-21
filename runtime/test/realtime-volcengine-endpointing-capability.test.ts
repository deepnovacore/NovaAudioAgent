import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {ReadableStream} from 'node:stream/web'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'
import type {Clock} from '../src/clock.js'
import type {RealtimeTelemetry} from '../src/realtime/telemetry.js'
import {
  createEndpointingCapabilityCache,
  probeEndpointingCapability,
  type EndpointingCapabilityFixtures,
  type LiveKitAgentsPublicSurface,
  type LiveKitAudioFrame,
  type LiveKitExecutor,
  type LiveKitTurnDetector,
  type LiveKitTurnStream,
  type LiveKitVad,
  type LiveKitVadEvent,
  type LiveKitVadStream,
} from '../src/realtime/volcengine/endpointing-capability.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const FIXTURE_DIRECTORY = join(
  REPOSITORY_ROOT,
  'fixtures',
  'realtime',
  'volcengine',
  'v1',
  'endpointing',
)
const SUPPORTED_RUNTIME = Object.freeze({platform: 'darwin', arch: 'arm64'})

interface Scenario {
  readonly vad?: 'differentiated' | 'identical' | 'noop' | 'deferred'
  readonly eot?:
    | 'differentiated'
    | 'identical'
    | 'wrong_direction'
    | 'out_of_range'
    | 'default_positive'
    | 'zero_call_differentiated'
    | 'hang'
    | 'late'
  readonly model?: string
  readonly language?: boolean
  readonly threshold?: number | undefined
  readonly closeFails?: boolean
  readonly jobExecutor?: LiveKitExecutor
  readonly metadataHang?: () => void
  readonly secondTurnCloseGate?: Promise<void>
}

interface SurfaceState {
  loggerCalls: number
  loaderCalls: number
  jobContextArgs: boolean[]
  vadConstructors: Readonly<Record<string, boolean | number | string>>[]
  turnConstructors: {
    readonly version: 'v1-mini'
    readonly sampleRate: 16_000
    readonly executor: LiveKitExecutor
  }[]
  vadStreams: number
  turnStreams: number
  vadStreamCloses: number
  vadStreamFlushes: number
  vadCloses: number
  turnStreamCloses: number
  detectorCloses: number
  audioFrames: number
  turnEndInputs: number
  predictionsAfterEndInput: number
  latePredictionResolvers: ((prediction: {readonly endOfTurnProbability: number}) => void)[]
  turnStreamClosePending: number
  turnStreamDoubleCloses: number
  detectorClosesWhileTurnStreamPending: number
}

class ProbeClock implements Clock {
  readonly #timeout: 'none' | 'prediction' | 'total' | 'manual'
  readonly #cadenceGate: Promise<void> | undefined
  readonly #cadenceRelease: (() => void) | undefined
  #totalResolve: (() => void) | undefined
  #totalReject: ((error: Error) => void) | undefined
  #totalSettled = false
  #cadenceWaits = 0
  waits = 0
  active = 0

  constructor(
    timeout: 'none' | 'prediction' | 'total' | 'manual' = 'none',
    gateCadence = false,
  ) {
    this.#timeout = timeout
    if (gateCadence) {
      let release: (() => void) | undefined
      this.#cadenceGate = new Promise(resolve => { release = resolve })
      this.#cadenceRelease = release
    }
  }

  now(): number {
    return 0
  }

  releaseCadence(): void {
    this.#cadenceRelease?.()
  }

  expireTotal(): void {
    this.#totalResolve?.()
  }

  sleep(duration: number, signal?: AbortSignal): Promise<void> {
    this.waits += 1
    if (signal?.aborted === true) return Promise.reject(abortError())
    if (this.#timeout === 'prediction' && duration === 1.25) {
      return Promise.resolve()
    }
    if ((this.#timeout === 'total' || this.#timeout === 'manual') && duration === 10) {
      this.active += 1
      return new Promise((resolve, reject) => {
        this.#totalResolve = () => {
          if (this.#totalSettled) return
          this.#totalSettled = true
          this.active -= 1
          resolve()
        }
        this.#totalReject = error => {
          if (this.#totalSettled) return
          this.#totalSettled = true
          this.active -= 1
          reject(error)
        }
        signal?.addEventListener('abort', () => { this.#totalReject?.(abortError()) }, {once: true})
      })
    }
    if (duration === 0.032) {
      return (this.#cadenceGate ?? Promise.resolve()).then(async () => {
        await new Promise<void>(resolve => { setImmediate(resolve) })
        this.#cadenceWaits += 1
        if (this.#timeout === 'total' && this.#cadenceWaits === 4) this.#totalResolve?.()
      })
    }
    this.active += 1
    return new Promise((_resolve, reject) => {
      const onAbort = (): void => {
        this.active -= 1
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, {once: true})
    })
  }
}

class RecordingTelemetry implements RealtimeTelemetry {
  readonly records: {readonly kind: string; readonly payload: Readonly<Record<string, unknown>>}[] = []

  record(kind: string, payload: Readonly<Record<string, unknown>>): void {
    this.records.push({kind, payload})
  }

  close(): void {
    return
  }
}

class RecordingExecutor implements LiveKitExecutor {
  calls = 0
  readonly seen: {readonly method: string; readonly data: unknown}[] = []
  readonly #modelUnavailable: boolean
  readonly #nonce: string

  constructor(options: {readonly modelUnavailable?: boolean; readonly nonce?: string} = {}) {
    this.#modelUnavailable = options.modelUnavailable ?? false
    this.#nonce = options.nonce ?? 'executor-payload'
  }

  doInference(method: string, data: unknown): Promise<unknown> {
    this.calls += 1
    this.seen.push({method, data})
    if (this.#modelUnavailable) {
      const error = new Error(this.#nonce) as Error & {code: string}
      error.code = 'model_unavailable'
      return Promise.reject(error)
    }
    const speech = isRecord(data) && data.speech === true
    return Promise.resolve({
      probability: speech ? 0.85 : 0.10,
      inferenceDurationMs: 3,
      ignored: this.#nonce,
    })
  }
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fixtures(): Promise<EndpointingCapabilityFixtures> {
  const [speech, silence] = await Promise.all([
    readFile(join(FIXTURE_DIRECTORY, 'speech-16k-s16le.pcm')),
    readFile(join(FIXTURE_DIRECTORY, 'silence-16k-s16le.pcm')),
  ])
  return {speech, silence}
}

function createSurface(
  scenario: Scenario,
): {readonly surface: LiveKitAgentsPublicSurface; readonly state: SurfaceState} {
  const state: SurfaceState = {
    loggerCalls: 0,
    loaderCalls: 0,
    jobContextArgs: [],
    vadConstructors: [],
    turnConstructors: [],
    vadStreams: 0,
    turnStreams: 0,
    vadStreamCloses: 0,
    vadStreamFlushes: 0,
    vadCloses: 0,
    turnStreamCloses: 0,
    detectorCloses: 0,
    audioFrames: 0,
    turnEndInputs: 0,
    predictionsAfterEndInput: 0,
    latePredictionResolvers: [],
    turnStreamClosePending: 0,
    turnStreamDoubleCloses: 0,
    detectorClosesWhileTurnStreamPending: 0,
  }

  class FrameByteStream {
    #pending = new Uint8Array()

    write(input: ArrayBufferLike | ArrayBufferView): readonly LiveKitAudioFrame[] {
      const inputBytes = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input)
      const joined = new Uint8Array(this.#pending.byteLength + inputBytes.byteLength)
      joined.set(this.#pending)
      joined.set(inputBytes, this.#pending.byteLength)
      this.#pending = joined
      const frames: LiveKitAudioFrame[] = []
      while (this.#pending.byteLength >= 1_024) {
        frames.push(this.#makeFrame(this.#pending.slice(0, 1_024)))
        this.#pending = this.#pending.slice(1_024)
      }
      return frames
    }

    flush(): readonly LiveKitAudioFrame[] {
      if (this.#pending.byteLength === 0) return []
      const frame = this.#makeFrame(this.#pending)
      this.#pending = new Uint8Array()
      return [frame]
    }

    #makeFrame(bytes: Uint8Array): LiveKitAudioFrame {
      state.audioFrames += 1
      const copy = bytes.slice()
      return Object.freeze({
        data: new Int16Array(copy.buffer),
        sampleRate: 16_000,
        channels: 1,
        samplesPerChannel: copy.byteLength / 2,
      })
    }
  }

  class VadStream implements LiveKitVadStream, AsyncIterator<LiveKitVadEvent> {
    readonly #events: LiveKitVadEvent[] = []
    readonly #waiters: ((result: IteratorResult<LiveKitVadEvent>) => void)[] = []
    readonly #boundaryFrames: LiveKitAudioFrame[] = []
    #closed = false

    updateInputStream(audioStream: ReadableStream<LiveKitAudioFrame>): void {
      void this.#consume(audioStream)
    }

    async #consume(audioStream: ReadableStream<LiveKitAudioFrame>): Promise<void> {
      const frames: LiveKitAudioFrame[] = []
      let started = false
      let ended = false
      let trailingSilenceFrames = 0
      for await (const frame of audioStream) {
        frames.push(frame)
        if (scenario.vad === 'deferred') {
          await new Promise<void>(resolve => { setImmediate(resolve) })
          await new Promise<void>(resolve => { setImmediate(resolve) })
        }
        if (this.#closed || frame.samplesPerChannel < 512) continue
        const speech = frame.data.some(sample => sample !== 0)
        const probability = scenario.vad === 'noop'
          ? 0
          : scenario.vad === 'identical' ? 0.5 : speech ? 0.9 : 0.1
        this.#emit({type: 1, probability, frames: [frame]})
        if (scenario.vad === 'noop') continue
        if (speech && !started) {
          started = true
          this.#boundaryFrames.push(frame)
          this.#emit({type: 0, probability, frames: [frame]})
        }
        if (started && !ended) {
          trailingSilenceFrames = speech ? 0 : trailingSilenceFrames + 1
          if (trailingSilenceFrames >= 18) {
            ended = true
            this.#boundaryFrames.push(...frames)
            this.#emit({type: 2, probability, frames: frames.slice()})
          }
        }
      }
    }

    endInput(): void {
      return
    }

    flush(): void {
      state.vadStreamFlushes += 1
      if (scenario.vad === 'deferred') {
        for (const frame of this.#boundaryFrames) frame.data.fill(0)
      }
    }

    close(): void {
      if (this.#closed) return
      this.#closed = true
      state.vadStreamCloses += 1
      for (const waiter of this.#waiters.splice(0)) {
        waiter({done: true, value: undefined})
      }
    }

    next(): Promise<IteratorResult<LiveKitVadEvent>> {
      const event = this.#events.shift()
      if (event !== undefined) return Promise.resolve({done: false, value: event})
      if (this.#closed) return Promise.resolve({done: true, value: undefined})
      return new Promise(resolve => { this.#waiters.push(resolve) })
    }

    [Symbol.asyncIterator](): AsyncIterator<LiveKitVadEvent> {
      return this
    }

    #emit(event: LiveKitVadEvent): void {
      const waiter = this.#waiters.shift()
      if (waiter !== undefined) waiter({done: false, value: event})
      else this.#events.push(event)
    }
  }

  class Vad implements LiveKitVad {
    constructor(options: Readonly<Record<string, boolean | number | string>>) {
      state.vadConstructors.push(options)
    }

    stream(): LiveKitVadStream {
      state.vadStreams += 1
      return new VadStream()
    }

    close(): Promise<void> {
      state.vadCloses += 1
      if (scenario.closeFails) return Promise.reject(new Error('/secret/native/vad/close'))
      return Promise.resolve()
    }
  }

  class TurnStream implements LiveKitTurnStream {
    readonly model = scenario.model ?? 'turn-detector-v1-mini'
    readonly #executor: LiveKitExecutor
    readonly #ordinal: number
    #speech = false
    #ended = false
    #closeStarted = false
    #closed = false

    constructor(executor: LiveKitExecutor, ordinal: number) {
      this.#executor = executor
      this.#ordinal = ordinal
    }

    pushAudio(frame: LiveKitAudioFrame): void {
      if (!this.#speech) this.#speech = frame.data.some(sample => sample !== 0)
    }

    endInput(): void {
      this.#ended = true
      state.turnEndInputs += 1
    }

    predict(): {readonly await: PromiseLike<{readonly endOfTurnProbability: number}>} {
      if (this.#ended) state.predictionsAfterEndInput += 1
      if (scenario.eot === 'hang') {
        return {await: new Promise(() => undefined)}
      }
      if (scenario.eot === 'late') {
        return {
          await: new Promise(resolve => { state.latePredictionResolvers.push(resolve) }),
        }
      }
      if (scenario.eot === 'default_positive') {
        return {await: Promise.resolve({endOfTurnProbability: 1})}
      }
      if (scenario.eot === 'zero_call_differentiated') {
        return {
          await: Promise.resolve({endOfTurnProbability: this.#speech ? 0.85 : 0.1}),
        }
      }
      if (scenario.eot === 'identical') {
        return {
          await: this.#executor.doInference('turn_detector_v1_mini', {
            speech: this.#speech,
          }).then(() => ({endOfTurnProbability: 0.5})),
        }
      }
      if (scenario.eot === 'wrong_direction' || scenario.eot === 'out_of_range') {
        return {
          await: this.#executor.doInference('turn_detector_v1_mini', {
            speech: this.#speech,
          }).then(() => ({
            endOfTurnProbability: scenario.eot === 'out_of_range'
              ? 1.1
              : this.#speech ? 0.1 : 0.85,
          })),
        }
      }
      return {
        await: this.#executor.doInference('turn_detector_v1_mini', {
          speech: this.#speech,
        }).then(result => ({
          endOfTurnProbability: isRecord(result) && typeof result.probability === 'number'
            ? result.probability
            : Number.NaN,
        })),
      }
    }

    async aclose(): Promise<void> {
      if (this.#closeStarted) {
        state.turnStreamDoubleCloses += 1
        throw new Error('ERR_INVALID_STATE: WritableStream is closed')
      }
      this.#closeStarted = true
      state.turnStreamCloses += 1
      try {
        if (scenario.secondTurnCloseGate !== undefined && this.#ordinal === 2) {
          state.turnStreamClosePending += 1
          try {
            await scenario.secondTurnCloseGate
          } finally {
            state.turnStreamClosePending -= 1
          }
        }
        if (scenario.closeFails) throw new Error('/secret/eot/stream/close')
      } finally {
        this.#closed = true
      }
    }

    get closed(): boolean {
      return this.#closed
    }
  }

  class Detector implements LiveKitTurnDetector {
    readonly model = scenario.model ?? 'turn-detector-v1-mini'
    readonly #executor: LiveKitExecutor
    readonly #streams: TurnStream[] = []

    constructor(options: {
      readonly version: 'v1-mini'
      readonly sampleRate: 16_000
      readonly executor: LiveKitExecutor
    }) {
      state.turnConstructors.push(options)
      this.#executor = options.executor
    }

    supportsLanguage(language: string): Promise<boolean> {
      void language
      if (scenario.metadataHang !== undefined) {
        scenario.metadataHang()
        return new Promise(() => undefined)
      }
      return Promise.resolve(scenario.language ?? true)
    }

    unlikelyThreshold(language: string): Promise<number | undefined> {
      void language
      if (scenario.metadataHang !== undefined) return new Promise(() => undefined)
      return Promise.resolve(Object.hasOwn(scenario, 'threshold') ? scenario.threshold : 0.45)
    }

    stream(): LiveKitTurnStream {
      state.turnStreams += 1
      const stream = new TurnStream(this.#executor, state.turnStreams)
      this.#streams.push(stream)
      return stream
    }

    async aclose(): Promise<void> {
      if (state.turnStreamClosePending > 0) {
        state.detectorClosesWhileTurnStreamPending += 1
      }
      state.detectorCloses += 1
      await Promise.allSettled(this.#streams.filter(stream => !stream.closed).map(async stream => {
        await stream.aclose()
      }))
      if (scenario.closeFails) throw new Error('/secret/eot/detector/close')
    }
  }

  return {
    state,
    surface: {
      version: '1.6.4',
      initializeLogger: options => {
        assert.deepEqual(options, {pretty: false, level: 'silent'})
        state.loggerCalls += 1
      },
      getJobContext: required => {
        state.jobContextArgs.push(required)
        return scenario.jobExecutor === undefined
          ? undefined
          : {inferenceExecutor: scenario.jobExecutor}
      },
      inference: {VAD: Vad, TurnDetector: Detector},
      AudioByteStream: FrameByteStream,
      VADEventType: {
        START_OF_SPEECH: 0,
        INFERENCE_DONE: 1,
        END_OF_SPEECH: 2,
      },
    },
  }
}

function loaderFor(
  surface: LiveKitAgentsPublicSurface,
  state: SurfaceState,
): () => Promise<LiveKitAgentsPublicSurface> {
  return () => {
    state.loaderCalls += 1
    return Promise.resolve(surface)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const STILL_PENDING = Symbol('still_pending')

async function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T | typeof STILL_PENDING> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<typeof STILL_PENDING>(resolve => {
        timer = setTimeout(() => { resolve(STILL_PENDING) }, milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function readyProbe(options: {
  readonly scenario?: Scenario
  readonly executor?: LiveKitExecutor
  readonly telemetry?: RealtimeTelemetry
  readonly clock?: Clock
  readonly signal?: AbortSignal
  readonly cache?: ReturnType<typeof createEndpointingCapabilityCache>
} = {}) {
  const executor = options.executor ?? new RecordingExecutor()
  const created = createSurface(options.scenario ?? {})
  const result = await probeEndpointingCapability({
    executor,
    signal: options.signal ?? new AbortController().signal,
    ...(options.telemetry === undefined ? {} : {telemetry: options.telemetry}),
    agentsLoader: loaderFor(created.surface, created.state),
    clock: options.clock ?? new ProbeClock(),
    fixtures: await fixtures(),
    runtime: SUPPORTED_RUNTIME,
    cache: options.cache ?? createEndpointingCapabilityCache(),
  })
  return {result, executor, ...created}
}

test('pinned endpointing fixtures preserve authority, format, length, and hashes', async () => {
  const manifest = JSON.parse(await readFile(join(FIXTURE_DIRECTORY, 'MANIFEST.json'), 'utf8')) as {
    readonly schema_version: number
    readonly source: Readonly<Record<string, unknown>>
    readonly extraction: Readonly<Record<string, unknown>>
    readonly outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    readonly license: Readonly<Record<string, unknown>>
  }
  const loaded = await fixtures()

  assert.equal(manifest.schema_version, 1)
  assert.deepEqual(manifest.source, {
    repository: 'https://github.com/snakers4/silero-vad',
    commit: '806dcba3f0b5d95282d0889a074954a2f8c6397b',
    path: 'tests/data/test.wav',
    sha256: '89f17d9c94c4b31eb320f424628bcbc920abaddbee6e2760fd868bfb1d9a2e47',
  })
  assert.deepEqual(manifest.extraction, {
    source_samples: 32_000,
    appended_zero_samples: 10_240,
    total_samples: 42_240,
    sample_rate_hz: 16_000,
    channels: 1,
    sample_format: 'pcm_s16le',
    bytes_per_sample: 2,
    byte_count: 84_480,
  })
  assert.equal(loaded.speech.byteLength, 84_480)
  assert.equal(loaded.silence.byteLength, 84_480)
  assert.equal(sha256(loaded.speech), '5ecb547c0ffbfba27f9705bf4de7ecafd5343c3a86c23ecd2d347a7618a8a962')
  assert.equal(sha256(loaded.silence), '354c4c84336b04e0bd855bd6a2be99d114760ee7f398953471694f42cb88f30e')
  assert.equal(loaded.speech.some(byte => byte !== 0), true)
  assert.equal(loaded.silence.every(byte => byte === 0), true)
  assert.deepEqual(manifest.outputs, {
    'speech-16k-s16le.pcm': {sha256: sha256(loaded.speech)},
    'silence-16k-s16le.pcm': {sha256: sha256(loaded.silence)},
  })
  assert.deepEqual(manifest.license, {spdx: 'MIT', file: 'LICENSE.silero-vad.txt'})
  assert.match(await readFile(join(FIXTURE_DIRECTORY, 'LICENSE.silero-vad.txt'), 'utf8'), /^MIT License\n/u)
})

test('a packaged runtime loads only its fixed resourcesPath endpointing assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-endpointing-resources-'))
  const directory = join(root, 'endpointing', 'volcengine-v1')
  const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  try {
    await mkdir(directory, {recursive: true})
    const loaded = await fixtures()
    await Promise.all([
      writeFile(join(directory, 'speech-16k-s16le.pcm'), loaded.speech),
      writeFile(join(directory, 'silence-16k-s16le.pcm'), loaded.silence),
    ])
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      enumerable: false,
      value: root,
    })
    const created = createSurface({vad: 'differentiated'})
    const result = await probeEndpointingCapability({
      executor: new RecordingExecutor(),
      signal: new AbortController().signal,
      agentsLoader: loaderFor(created.surface, created.state),
      clock: new ProbeClock(),
      runtime: SUPPORTED_RUNTIME,
      cache: createEndpointingCapabilityCache(),
    })
    assert.deepEqual(result.vad, {available: true, reason: 'ready'})

    await writeFile(join(directory, 'speech-16k-s16le.pcm'), Buffer.alloc(84_480))
    const rejected = await probeEndpointingCapability({
      executor: new RecordingExecutor(),
      signal: new AbortController().signal,
      agentsLoader: loaderFor(created.surface, created.state),
      clock: new ProbeClock(),
      runtime: SUPPORTED_RUNTIME,
      cache: createEndpointingCapabilityCache(),
    })
    assert.deepEqual(rejected.vad, {available: false, reason: 'inconclusive'})
  } finally {
    if (original === undefined) delete (process as NodeJS.Process & {resourcesPath?: string}).resourcesPath
    else Object.defineProperty(process, 'resourcesPath', original)
    await rm(root, {recursive: true, force: true})
  }
})

test('unsupported platform and musl Linux fail before package loading', async () => {
  for (const runtime of [
    {platform: 'darwin', arch: 'ppc64'},
    {platform: 'linux', arch: 'x64'},
    {platform: 'linux', arch: 'arm64', glibcVersionRuntime: ' \t\n'},
    {platform: 'win32', arch: 'arm64'},
  ]) {
    let loaderCalls = 0
    const result = await probeEndpointingCapability({
      executor: new RecordingExecutor(),
      signal: new AbortController().signal,
      agentsLoader: () => {
        loaderCalls += 1
        return Promise.reject(new Error('loader must remain cold'))
      },
      runtime,
      cache: createEndpointingCapabilityCache(),
    })
    assert.equal(result.mode, 'bounded_silence')
    assert.equal(result.eot.reason, 'unsupported_platform')
    assert.equal(result.vad.reason, 'unsupported_platform')
    assert.equal(loaderCalls, 0)
  }
})

test('unsupported platform resolution is immutable, cached, and telemetried once', async () => {
  const cache = createEndpointingCapabilityCache()
  const telemetry = new RecordingTelemetry()
  const options = {
    executor: new RecordingExecutor(),
    signal: new AbortController().signal,
    telemetry,
    agentsLoader: () => Promise.reject(new Error('loader must remain cold')),
    runtime: {platform: 'freebsd', arch: 'x64'},
    cache,
  }
  const [first, second] = await Promise.all([
    probeEndpointingCapability(options),
    probeEndpointingCapability(options),
  ])

  assert.equal(first, second)
  assert.equal(Object.isFrozen(first), true)
  assert.deepEqual(telemetry.records, [
    {
      kind: 'volcengine.endpointing.capability',
      payload: {
        mode: 'bounded_silence',
        eot_reason: 'unsupported_platform',
        vad_reason: 'unsupported_platform',
        platform: 'freebsd',
        arch: 'x64',
      },
    },
    {
      kind: 'volcengine.endpointing.fallback',
      payload: {
        eot_reason: 'unsupported_platform',
        vad_reason: 'unsupported_platform',
      },
    },
  ])
})

test('supported Linux requires nonblank glibc and root import failure is package_unavailable', async () => {
  let loaderCalls = 0
  const result = await probeEndpointingCapability({
    executor: new RecordingExecutor(),
    signal: new AbortController().signal,
    agentsLoader: () => {
      loaderCalls += 1
      return Promise.reject(new Error('/Users/secret/node_modules/native-loader'))
    },
    runtime: {platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.39'},
    cache: createEndpointingCapabilityCache(),
  })

  assert.equal(loaderCalls, 1)
  assert.deepEqual(result.eot, {available: false, reason: 'package_unavailable'})
  assert.deepEqual(result.vad, {available: false, reason: 'package_unavailable'})
  assert.doesNotMatch(JSON.stringify(result), /secret|native-loader/u)
})

test('an absent executor uses getJobContext(false) and cannot accept positive defaults', async () => {
  const created = createSurface({vad: 'differentiated'})
  const result = await probeEndpointingCapability({
    signal: new AbortController().signal,
    agentsLoader: loaderFor(created.surface, created.state),
    clock: new ProbeClock(),
    fixtures: await fixtures(),
    runtime: SUPPORTED_RUNTIME,
    cache: createEndpointingCapabilityCache(),
  })

  assert.deepEqual(created.state.jobContextArgs, [false])
  assert.deepEqual(result.eot, {available: false, reason: 'executor_unavailable'})
  assert.deepEqual(result.vad, {available: true, reason: 'ready'})
  assert.equal(result.mode, 'bounded_silence')
  assert.equal(created.state.turnConstructors.length, 0)
})

test('a supported job-context executor is resolved after the injected executor seam', async () => {
  const jobExecutor = new RecordingExecutor()
  const created = createSurface({jobExecutor})
  const result = await probeEndpointingCapability({
    signal: new AbortController().signal,
    agentsLoader: loaderFor(created.surface, created.state),
    clock: new ProbeClock(),
    fixtures: await fixtures(),
    runtime: SUPPORTED_RUNTIME,
    cache: createEndpointingCapabilityCache(),
  })

  assert.equal(result.mode, 'livekit_v1_mini')
  assert.deepEqual(created.state.jobContextArgs, [false])
  assert.equal(jobExecutor.calls, 2)
})

test('only differentiated VAD and delegated EOT inference can report ready', async () => {
  const executor = new RecordingExecutor()
  const {result, state} = await readyProbe({executor})

  assert.deepEqual(result, {
    schema_version: 1,
    mode: 'livekit_v1_mini',
    eot: {available: true, reason: 'ready'},
    vad: {available: true, reason: 'ready'},
    platform: 'darwin',
    arch: 'arm64',
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.eot), true)
  assert.equal(Object.isFrozen(result.vad), true)
  assert.equal(executor.calls, 2)
  assert.deepEqual(executor.seen.map(call => call.method), [
    'turn_detector_v1_mini',
    'turn_detector_v1_mini',
  ])
  assert.equal(state.vadStreams, 2)
  assert.equal(state.turnStreams, 2)
  assert.equal(state.audioFrames, 166)
  assert.equal(state.turnEndInputs, 0)
  assert.equal(state.predictionsAfterEndInput, 0)
  assert.deepEqual(state.vadConstructors, [
    {
      model: 'silero',
      minSpeechDuration: 250,
      minSilenceDuration: 560,
      prefixPaddingDuration: 260,
      maxBufferedSpeech: 15_000,
      activationThreshold: 0.5,
      deactivationThreshold: 0.35,
    },
    {
      model: 'silero',
      minSpeechDuration: 250,
      minSilenceDuration: 560,
      prefixPaddingDuration: 260,
      maxBufferedSpeech: 15_000,
      activationThreshold: 0.5,
      deactivationThreshold: 0.35,
    },
  ])
  assert.equal(state.turnConstructors.every(options => (
    options.version === 'v1-mini'
      && options.sampleRate === 16_000
      && options.executor !== executor
  )), true)
})

test('async VAD input pumping completes before the probe flushes and closes', async () => {
  const {result, state} = await readyProbe({scenario: {vad: 'deferred'}})

  assert.equal(result.mode, 'livekit_v1_mini')
  assert.deepEqual(result.vad, {available: true, reason: 'ready'})
  assert.deepEqual(result.eot, {available: true, reason: 'ready'})
  assert.equal(state.vadStreamFlushes, 2)
  assert.equal(state.vadStreamCloses, 2)
})

test('constructor-only/no-op VAD and zero-call default-positive EOT fail closed', async () => {
  const executor = new RecordingExecutor()
  const {result, state} = await readyProbe({
    executor,
    scenario: {vad: 'noop', eot: 'default_positive'},
  })

  assert.equal(result.mode, 'bounded_silence')
  assert.deepEqual(result.vad, {available: false, reason: 'native_unavailable'})
  assert.deepEqual(result.eot, {available: false, reason: 'inconclusive'})
  assert.equal(executor.calls, 0)
  assert.equal(state.vadStreamCloses, 2)
  assert.equal(state.vadCloses, 2)
  assert.equal(state.turnStreamCloses, 2)
  assert.equal(state.detectorCloses, 2)
})

test('differentiated EOT outputs with zero delegated executor calls cannot become ready', async () => {
  const executor = new RecordingExecutor()
  const {result} = await readyProbe({
    executor,
    scenario: {eot: 'zero_call_differentiated'},
  })

  assert.equal(executor.calls, 0)
  assert.deepEqual(result.vad, {available: true, reason: 'ready'})
  assert.deepEqual(result.eot, {available: false, reason: 'inconclusive'})
  assert.equal(result.mode, 'bounded_silence')
})

test('identical or wrong-direction probabilities and invalid public metadata are inconclusive', async () => {
  for (const scenario of [
    {eot: 'identical' as const},
    {eot: 'wrong_direction' as const},
    {eot: 'out_of_range' as const},
    {vad: 'identical' as const},
    {model: 'turn-detector-v1'},
    {language: false},
    {threshold: Number.NaN},
    {threshold: 1.1},
  ]) {
    const {result} = await readyProbe({scenario})
    assert.equal(result.mode, 'bounded_silence')
    assert.equal(result.eot.available && result.vad.available, false)
    assert.equal(
      result.eot.reason === 'inconclusive' || result.vad.reason === 'inconclusive',
      true,
    )
  }
})

test('the 10-second total deadline includes loading and returns a stable timeout', async () => {
  const clock = new ProbeClock('total')
  const {result, state} = await readyProbe({clock})

  assert.equal(result.mode, 'bounded_silence')
  assert.deepEqual(result.eot, {available: false, reason: 'timeout'})
  assert.deepEqual(result.vad, {available: false, reason: 'timeout'})
  assert.equal(state.vadStreams, 1)
  assert.equal(state.turnStreams, 1)
  assert.equal(state.vadStreamCloses, state.vadStreams)
  assert.equal(state.vadCloses, 1)
  assert.equal(state.turnStreamCloses, state.turnStreams)
  assert.equal(state.detectorCloses, 1)
  assert.equal(clock.active, 0)
})

test('the total deadline interrupts never-settling detector metadata', async () => {
  const clock = new ProbeClock('manual')
  const completion = await settleWithin(readyProbe({
    clock,
    scenario: {metadataHang: () => { clock.expireTotal() }},
  }), 100)

  assert.notEqual(completion, STILL_PENDING)
  if (completion === STILL_PENDING) return
  assert.deepEqual(completion.result.eot, {available: false, reason: 'timeout'})
  assert.deepEqual(completion.result.vad, {available: false, reason: 'timeout'})
  assert.equal(completion.state.vadStreamFlushes, 1)
  assert.equal(completion.state.vadStreamCloses, 1)
  assert.equal(completion.state.detectorCloses, 1)
  assert.equal(clock.active, 0)
})

test('typed executor model unavailability is stable and never includes its payload', async () => {
  const nonce = 'MODEL-NONCE-/private/model.bin-transcript'
  const executor = new RecordingExecutor({modelUnavailable: true, nonce})
  const telemetry = new RecordingTelemetry()
  const {result} = await readyProbe({executor, telemetry})

  assert.deepEqual(result.eot, {available: false, reason: 'model_unavailable'})
  assert.doesNotMatch(JSON.stringify({result, records: telemetry.records}), new RegExp(nonce, 'u'))
})

test('per-prediction timeout is bounded and closes every created public resource', async () => {
  const clock = new ProbeClock('prediction')
  const {result, state} = await readyProbe({scenario: {eot: 'hang'}, clock})

  assert.deepEqual(result.eot, {available: false, reason: 'timeout'})
  assert.equal(result.mode, 'bounded_silence')
  assert.equal(state.vadStreamCloses, 2)
  assert.equal(state.vadCloses, 2)
  assert.equal(state.turnStreamCloses, 2)
  assert.equal(state.detectorCloses, 2)
  assert.equal(clock.active, 0)
})

test('owner abort keeps stream and detector cleanup strictly sequenced', async () => {
  const clock = new ProbeClock('manual')
  let releaseSecondClose: (() => void) | undefined
  const secondCloseGate = new Promise<void>(resolve => { releaseSecondClose = resolve })
  let executorCalls = 0
  const executor: LiveKitExecutor = {
    doInference(_method: string, data: unknown): Promise<unknown> {
      executorCalls += 1
      if (executorCalls === 2) {
        clock.expireTotal()
        return new Promise(() => undefined)
      }
      return Promise.resolve({
        probability: isRecord(data) && data.speech === true ? 0.85 : 0.1,
      })
    },
  }
  const probe = readyProbe({
    clock,
    executor,
    scenario: {secondTurnCloseGate: secondCloseGate},
  })

  try {
    const completion = await settleWithin(probe, 100)
    assert.notEqual(completion, STILL_PENDING)
    if (completion === STILL_PENDING) return
    assert.deepEqual(completion.result.eot, {available: false, reason: 'timeout'})
    assert.deepEqual(completion.result.vad, {available: false, reason: 'timeout'})
    assert.equal(executorCalls, 2)
    assert.equal(completion.state.vadStreamFlushes, 2)
    assert.equal(completion.state.detectorClosesWhileTurnStreamPending, 0)
    assert.equal(completion.state.turnStreamDoubleCloses, 0)
    assert.equal(completion.state.detectorCloses, 1)
  } finally {
    releaseSecondClose?.()
  }

  await new Promise<void>(resolve => { setImmediate(resolve) })
  const completed = await probe
  assert.equal(completed.state.turnStreamCloses, 2)
  assert.equal(completed.state.detectorCloses, 2)
  assert.equal(completed.state.detectorClosesWhileTurnStreamPending, 0)
  assert.equal(completed.state.turnStreamDoubleCloses, 0)
  assert.equal(clock.active, 0)
})

test('late prediction completion cannot mutate a timed-out result or telemetry', async () => {
  const clock = new ProbeClock('prediction')
  const telemetry = new RecordingTelemetry()
  const {result, state} = await readyProbe({scenario: {eot: 'late'}, clock, telemetry})
  const recordsAtResolution = structuredClone(telemetry.records)

  assert.deepEqual(result.eot, {available: false, reason: 'timeout'})
  assert.equal(Object.isFrozen(result), true)
  assert.equal(state.latePredictionResolvers.length, 2)
  assert.equal(state.turnStreamCloses, 2)
  assert.equal(state.detectorCloses, 2)

  for (const resolve of state.latePredictionResolvers) {
    resolve({endOfTurnProbability: 0.99})
  }
  await new Promise<void>(resolve => { setImmediate(resolve) })

  assert.deepEqual(result.eot, {available: false, reason: 'timeout'})
  assert.deepEqual(telemetry.records, recordsAtResolution)
  assert.equal(clock.active, 0)
})

test('cleanup failure remains content-free and cannot turn a probe ready', async () => {
  const nonce = '/secret/path/API_KEY=capability-secret/transcript'
  const telemetry = new RecordingTelemetry()
  const {result} = await readyProbe({scenario: {closeFails: true}, telemetry})

  assert.equal(result.mode, 'bounded_silence')
  assert.equal(result.eot.reason, 'inconclusive')
  assert.equal(result.vad.reason, 'inconclusive')
  assert.doesNotMatch(JSON.stringify({result, records: telemetry.records}), new RegExp(nonce, 'u'))
})

test('concurrent callers share one immutable process-cache resolution and safe telemetry', async () => {
  const cache = createEndpointingCapabilityCache()
  const telemetry = new RecordingTelemetry()
  const executor = new RecordingExecutor({nonce: 'IPC-PAYLOAD-SECRET'})
  const created = createSurface({})
  const loadedFixtures = await fixtures()
  const options = {
    executor,
    signal: new AbortController().signal,
    telemetry,
    agentsLoader: loaderFor(created.surface, created.state),
    clock: new ProbeClock(),
    fixtures: loadedFixtures,
    runtime: SUPPORTED_RUNTIME,
    cache,
  }

  const [first, second] = await Promise.all([
    probeEndpointingCapability(options),
    probeEndpointingCapability(options),
  ])

  assert.equal(first, second)
  assert.equal(created.state.loaderCalls, 1)
  assert.equal(created.state.loggerCalls, 1)
  assert.equal(executor.calls, 2)
  assert.deepEqual(telemetry.records, [{
    kind: 'volcengine.endpointing.capability',
    payload: {
      mode: 'livekit_v1_mini',
      eot_reason: 'ready',
      vad_reason: 'ready',
      platform: 'darwin',
      arch: 'arm64',
    },
  }])
})

test('an aborted caller stops waiting without poisoning another shared caller', async () => {
  const cache = createEndpointingCapabilityCache()
  const clock = new ProbeClock('none', true)
  const executor = new RecordingExecutor()
  const created = createSurface({})
  const loadedFixtures = await fixtures()
  const firstAbort = new AbortController()
  const common = {
    executor,
    agentsLoader: loaderFor(created.surface, created.state),
    clock,
    fixtures: loadedFixtures,
    runtime: SUPPORTED_RUNTIME,
    cache,
  }
  const first = probeEndpointingCapability({...common, signal: firstAbort.signal})
  const second = probeEndpointingCapability({...common, signal: new AbortController().signal})

  await Promise.resolve()
  firstAbort.abort()
  const firstResult = await first
  assert.equal(firstResult.eot.reason, 'aborted')
  assert.equal(firstResult.vad.reason, 'aborted')
  clock.releaseCadence()
  const secondResult = await second
  assert.equal(secondResult.mode, 'livekit_v1_mini')
  assert.equal(created.state.loaderCalls, 1)
})

test('fallback telemetry contains only stable safe fields and is recorded once', async () => {
  const telemetry = new RecordingTelemetry()
  const nonce = 'SECRET_API_KEY_/private/native/transcript'
  const executor = new RecordingExecutor({nonce})
  const {result} = await readyProbe({
    executor,
    telemetry,
    scenario: {vad: 'noop', eot: 'default_positive'},
  })

  assert.equal(result.mode, 'bounded_silence')
  assert.deepEqual(telemetry.records, [
    {
      kind: 'volcengine.endpointing.capability',
      payload: {
        mode: 'bounded_silence',
        eot_reason: 'inconclusive',
        vad_reason: 'native_unavailable',
        platform: 'darwin',
        arch: 'arm64',
      },
    },
    {
      kind: 'volcengine.endpointing.fallback',
      payload: {eot_reason: 'inconclusive', vad_reason: 'native_unavailable'},
    },
  ])
  assert.doesNotMatch(JSON.stringify(telemetry.records), new RegExp(nonce, 'u'))
})
