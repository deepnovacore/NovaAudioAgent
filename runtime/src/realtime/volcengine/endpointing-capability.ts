import type * as LiveKitAgents from '@livekit/agents'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {ReadableStream} from 'node:stream/web'
import {fileURLToPath} from 'node:url'
import type {Clock} from '../../clock.js'
import {stripLikePython} from '../../python-text.js'
import type {RealtimeTelemetry} from '../telemetry.js'

export type EndpointingCapabilityReason =
  | 'ready'
  | 'unsupported_platform'
  | 'package_unavailable'
  | 'native_unavailable'
  | 'executor_unavailable'
  | 'model_unavailable'
  | 'timeout'
  | 'inconclusive'
  | 'aborted'

export interface EndpointingCapabilityResult {
  readonly schema_version: 1
  readonly mode: 'livekit_v1_mini' | 'bounded_silence'
  readonly eot: {
    readonly available: boolean
    readonly reason: EndpointingCapabilityReason
  }
  readonly vad: {
    readonly available: boolean
    readonly reason: EndpointingCapabilityReason
  }
  readonly platform: string
  readonly arch: string
}

export type LiveKitExecutor = LiveKitAgents.ipc.InferenceExecutor
export type LiveKitAgentsLoader = () => Promise<LiveKitAgentsPublicSurface>

export interface LiveKitAudioFrame {
  readonly data: Int16Array
  readonly sampleRate: number
  readonly channels: number
  readonly samplesPerChannel: number
}

export interface LiveKitVadEvent {
  readonly type: number
  readonly probability: number
  readonly frames: readonly LiveKitAudioFrame[]
}

export interface LiveKitVadStream extends AsyncIterable<LiveKitVadEvent> {
  updateInputStream(audioStream: ReadableStream<LiveKitAudioFrame>): void
  close(): void
}

export interface LiveKitVad {
  stream(): LiveKitVadStream
  close(): Promise<void>
}

export interface LiveKitTurnPrediction {
  readonly endOfTurnProbability: number
}

export interface LiveKitTurnFuture {
  readonly await: PromiseLike<LiveKitTurnPrediction>
}

export interface LiveKitTurnStream {
  readonly model: string
  pushAudio(frame: LiveKitAudioFrame): void
  predict(): LiveKitTurnFuture
  aclose(): Promise<void>
}

export interface LiveKitTurnDetector {
  readonly model: string
  supportsLanguage(language: string): Promise<boolean>
  unlikelyThreshold(language: string): Promise<number | undefined>
  stream(): LiveKitTurnStream
  aclose(): Promise<void>
}

export interface LiveKitAudioByteStream {
  write(data: ArrayBufferLike | ArrayBufferView): readonly LiveKitAudioFrame[]
  flush(): readonly LiveKitAudioFrame[]
}

export interface LiveKitAgentsPublicSurface {
  readonly version: string
  initializeLogger(options: {readonly pretty: false; readonly level: 'silent'}): void
  getJobContext(required: false): {readonly inferenceExecutor: LiveKitExecutor} | undefined
  readonly inference: {
    readonly VAD: new (options: Readonly<Record<string, boolean | number | string>>) => LiveKitVad
    readonly TurnDetector: new (options: {
      readonly version: 'v1-mini'
      readonly sampleRate: 16_000
      readonly executor: LiveKitExecutor
    }) => LiveKitTurnDetector
  }
  readonly AudioByteStream: new (
    sampleRate: 16_000,
    channels: 1,
    samplesPerChannel: 512,
  ) => LiveKitAudioByteStream
  readonly VADEventType: {
    readonly START_OF_SPEECH: number
    readonly INFERENCE_DONE: number
    readonly END_OF_SPEECH: number
  }
}

export interface EndpointingCapabilityFixtures {
  readonly speech: Uint8Array
  readonly silence: Uint8Array
}

export interface EndpointingProbeRuntime {
  readonly platform: string
  readonly arch: string
  readonly glibcVersionRuntime?: unknown
}

export interface EndpointingCapabilityCache {
  readonly kind: 'volcengine_endpointing_capability_cache'
}

export interface EndpointingCapabilityOptions {
  readonly executor?: LiveKitExecutor
  readonly signal: AbortSignal
  readonly telemetry?: RealtimeTelemetry
  readonly agentsLoader?: LiveKitAgentsLoader
  readonly clock?: Clock
  readonly fixtures?: EndpointingCapabilityFixtures
  readonly runtime?: EndpointingProbeRuntime
  readonly cache?: EndpointingCapabilityCache
}

export interface PlaceholderEndpointingCapabilityOptions {
  readonly agentsLoader: LiveKitAgentsLoader
}

export interface LiveKitProductionSource {
  readonly path: string
  readonly source: string
}

export interface LiveKitPackageManifest {
  readonly path: string
  readonly manifest: unknown
}

export interface LiveKitPolicyInventory {
  readonly productionSources: readonly LiveKitProductionSource[]
  readonly packageManifests: readonly LiveKitPackageManifest[]
}

export type LiveKitPolicyViolationCode =
  | 'forbidden_import'
  | 'forbidden_source_api'
  | 'forbidden_dependency'
  | 'unsupported_dependency_version'

export interface LiveKitPolicyViolation {
  readonly code: LiveKitPolicyViolationCode
  readonly path: string
  readonly value: string
}

const LIVEKIT_AGENTS_ROOT = '@livekit/agents'
const LIVEKIT_LOCAL_INFERENCE = '@livekit' + '/local-inference'
const LIVEKIT_RTC_NODE = '@livekit' + '/rtc-node'
const LIVEKIT_DEPENDENCY_VERSIONS = Object.freeze({
  [LIVEKIT_AGENTS_ROOT]: '1.6.4',
  [LIVEKIT_RTC_NODE]: '0.13.33',
})
const DEPENDENCY_SECTIONS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const)
const FORBIDDEN_SOURCE_APIS = Object.freeze([
  'Inference' + 'ProcExecutor',
  '_' + 'warmup',
  'inference' + '_' + 'proc',
])
const LIVEKIT_STRING_LITERAL =
  /'(@livekit\/[^'\r\n]*)'|"(@livekit\/[^"\r\n]*)"|`(@livekit\/[^`\r\n]*)`/gu
const AGENTS_VERSION = '1.6.4'
const FRAME_BYTES = 1_024
const FRAME_CADENCE_SECONDS = 0.032
const TOTAL_TIMEOUT_SECONDS = 10
const PREDICTION_TIMEOUT_SECONDS = 1.25
const FIXTURE_BYTES = 84_480
const SPEECH_SHA256 = '5ecb547c0ffbfba27f9705bf4de7ecafd5343c3a86c23ecd2d347a7618a8a962'
const SILENCE_SHA256 = '354c4c84336b04e0bd855bd6a2be99d114760ee7f398953471694f42cb88f30e'
class CapabilityTimeoutError extends Error {
  constructor() {
    super('endpointing capability deadline reached')
    this.name = 'CapabilityTimeoutError'
  }
}

class CapabilityAbortError extends Error {
  constructor() {
    super('endpointing capability aborted')
    this.name = 'CapabilityAbortError'
  }
}

const TIMEOUT = new CapabilityTimeoutError()
const ABORTED = new CapabilityAbortError()

interface CapabilityComponent {
  readonly available: boolean
  readonly reason: EndpointingCapabilityReason
}

interface CacheEntry {
  readonly controller: AbortController
  readonly promise: Promise<EndpointingCapabilityResult>
  waiters: number
}

interface CapabilityCacheState {
  readonly entries: Map<string, CacheEntry>
  loggerInitialized: boolean
}

interface VadObservation {
  readonly inferenceCount: number
  readonly probabilities: readonly number[]
  readonly startCount: number
  readonly endCount: number
  readonly startBeforeEnd: boolean
  readonly speechFramesContainAudio: boolean
}

interface EotObservation {
  readonly probability: number | undefined
  readonly calls: number
  readonly modelUnavailable: boolean
  readonly modelValid: boolean
  readonly metadataValid: boolean
  readonly timedOut: boolean
}

interface FixtureObservation {
  readonly vad: VadObservation
  readonly eot: EotObservation | undefined
  readonly vadNativeMissing: boolean
  readonly cleanupFailed: boolean
}

const CACHE_STATES = new WeakMap<EndpointingCapabilityCache, CapabilityCacheState>()
const PROCESS_CACHE = createEndpointingCapabilityCache()

export function placeholderEndpointingCapability(
  options: PlaceholderEndpointingCapabilityOptions,
): EndpointingCapabilityResult {
  void options.agentsLoader
  const unavailable = Object.freeze({available: false, reason: 'inconclusive' as const})
  return Object.freeze({
    schema_version: 1,
    mode: 'bounded_silence',
    eot: unavailable,
    vad: unavailable,
    platform: process.platform,
    arch: process.arch,
  })
}

export function createEndpointingCapabilityCache(): EndpointingCapabilityCache {
  const cache: EndpointingCapabilityCache = Object.freeze({
    kind: 'volcengine_endpointing_capability_cache',
  })
  CACHE_STATES.set(cache, {
    entries: new Map(),
    loggerInitialized: false,
  })
  return cache
}

export async function probeEndpointingCapability(
  options: EndpointingCapabilityOptions,
): Promise<EndpointingCapabilityResult> {
  const runtime = options.runtime ?? currentProbeRuntime()
  if (options.signal.aborted) {
    return unavailableCapability(runtime.platform, runtime.arch, 'aborted')
  }
  const libc = supportedLibc(runtime)
  const cache = options.cache ?? PROCESS_CACHE
  const state = cacheState(cache)
  const supported = isSupportedRuntime(runtime, libc)
  const key = [
    AGENTS_VERSION,
    runtime.platform,
    runtime.arch,
    libc,
    supported ? 'supported' : 'unsupported',
    options.executor === undefined ? 'executor_context' : 'executor_injected',
  ].join('|')
  let entry = state.entries.get(key)
  if (entry === undefined) {
    const controller = new AbortController()
    const promise = supported
      ? runSharedProbe(options, runtime, state, controller)
      : Promise.resolve(unavailableCapability(
        runtime.platform,
        runtime.arch,
        'unsupported_platform',
      )).then(result => {
        recordResolution(options.telemetry, result)
        return result
      })
    entry = {controller, promise, waiters: 0}
    state.entries.set(key, entry)
    void promise.then(result => {
      if (result.eot.reason === 'aborted' && result.vad.reason === 'aborted') {
        state.entries.delete(key)
      }
    })
  }
  entry.waiters += 1
  let callerAborted = false
  try {
    return await waitForCaller(entry.promise, options.signal, () => { callerAborted = true })
  } catch (error) {
    if (error !== ABORTED) throw error
    return unavailableCapability(runtime.platform, runtime.arch, 'aborted')
  } finally {
    entry.waiters -= 1
    if (callerAborted && entry.waiters === 0) entry.controller.abort()
  }
}

async function runSharedProbe(
  options: EndpointingCapabilityOptions,
  runtime: EndpointingProbeRuntime,
  cache: CapabilityCacheState,
  controller: AbortController,
): Promise<EndpointingCapabilityResult> {
  const clock = options.clock ?? UNREF_CLOCK
  let totalTimedOut = false
  const timerController = new AbortController()
  const totalTimer = clock.sleep(TOTAL_TIMEOUT_SECONDS, timerController.signal).then(() => {
    totalTimedOut = true
    controller.abort()
  })
  totalTimer.catch(() => undefined)
  let result: EndpointingCapabilityResult
  try {
    result = await probeUnderDeadline(options, runtime, cache, clock, controller.signal)
  } catch {
    const reason: EndpointingCapabilityReason = totalTimedOut
      ? 'timeout'
      : controller.signal.aborted
        ? 'aborted'
        : 'inconclusive'
    result = unavailableCapability(runtime.platform, runtime.arch, reason)
  } finally {
    timerController.abort()
    await totalTimer.catch(() => undefined)
  }
  recordResolution(options.telemetry, result)
  return result
}

async function probeUnderDeadline(
  options: EndpointingCapabilityOptions,
  runtime: EndpointingProbeRuntime,
  cache: CapabilityCacheState,
  clock: Clock,
  signal: AbortSignal,
): Promise<EndpointingCapabilityResult> {
  const surface = await loadAgents(options.agentsLoader, cache, signal)
  if (surface === null) {
    return unavailableCapability(runtime.platform, runtime.arch, 'package_unavailable')
  }
  if (signal.aborted) throw ABORTED

  let executor = options.executor
  if (executor === undefined) {
    try {
      executor = surface.getJobContext(false)?.inferenceExecutor
    } catch {
      executor = undefined
    }
  }

  const fixtureSet = options.fixtures === undefined
    ? await loadCapabilityFixtures(signal)
    : copyAndValidateFixtures(options.fixtures)
  if (fixtureSet === null) {
    return unavailableCapability(runtime.platform, runtime.arch, 'inconclusive')
  }

  const counting = executor === undefined ? undefined : countingExecutor(executor)
  const speech = await observeFixture(surface, fixtureSet.speech, counting, clock, signal)
  const silence = await observeFixture(surface, fixtureSet.silence, counting, clock, signal)
  const vad = classifyVad(speech, silence)
  const eot = executor === undefined
    ? unavailableComponent('executor_unavailable')
    : classifyEot(speech, silence)
  const cleanupFailed = speech.cleanupFailed || silence.cleanupFailed
  return capabilityResult(
    runtime.platform,
    runtime.arch,
    cleanupFailed ? unavailableComponent('inconclusive') : eot,
    cleanupFailed ? unavailableComponent('inconclusive') : vad,
  )
}

async function loadAgents(
  loader: LiveKitAgentsLoader | undefined,
  cache: CapabilityCacheState,
  signal: AbortSignal,
): Promise<LiveKitAgentsPublicSurface | null> {
  try {
    const loaded = await raceAbort((loader ?? defaultAgentsLoader)(), signal)
    if (loaded.version !== AGENTS_VERSION) return null
    if (!cache.loggerInitialized) {
      loaded.initializeLogger({pretty: false, level: 'silent'})
      cache.loggerInitialized = true
    }
    return loaded
  } catch (error) {
    if (error === ABORTED) throw error
    return null
  }
}

async function defaultAgentsLoader(): Promise<LiveKitAgentsPublicSurface> {
  return await import('@livekit/agents') as unknown as LiveKitAgentsPublicSurface
}

async function observeFixture(
  surface: LiveKitAgentsPublicSurface,
  fixture: Uint8Array,
  executor: CountingExecutor | undefined,
  clock: Clock,
  signal: AbortSignal,
): Promise<FixtureObservation> {
  let vad: LiveKitVad | undefined
  let vadStream: LiveKitVadStream | undefined
  let detector: LiveKitTurnDetector | undefined
  let turnStream: LiveKitTurnStream | undefined
  let vadNativeMissing = false
  let cleanupFailed = false
  const vadEvents: LiveKitVadEvent[] = []
  let readerTask: Promise<void> | undefined
  let eotObservation: EotObservation | undefined
  try {
    try {
      vad = new surface.inference.VAD({
        model: 'silero',
        minSpeechDuration: 250,
        minSilenceDuration: 560,
        prefixPaddingDuration: 260,
        maxBufferedSpeech: 15_000,
        activationThreshold: 0.5,
        deactivationThreshold: 0.35,
      })
      vadStream = vad.stream()
      readerTask = readVadEvents(vadStream, vadEvents)
    } catch {
      vadNativeMissing = true
    }

    let metadataValid = false
    let modelValid = false
    if (executor !== undefined) {
      try {
        detector = new surface.inference.TurnDetector({
          version: 'v1-mini',
          sampleRate: 16_000,
          executor,
        })
        modelValid = detector.model === 'turn-detector-v1-mini'
        const [language, threshold] = await Promise.all([
          detector.supportsLanguage('zh'),
          detector.unlikelyThreshold('zh'),
        ])
        metadataValid = language && finiteProbability(threshold)
        turnStream = detector.stream()
        modelValid = modelValid && turnStream.model === 'turn-detector-v1-mini'
      } catch {
        metadataValid = false
      }
    }

    let vadInput: ReadableStream<LiveKitAudioFrame> | undefined
    let vadController: ReadableStreamDefaultController<LiveKitAudioFrame> | undefined
    if (vadStream !== undefined) {
      vadInput = new ReadableStream<LiveKitAudioFrame>({
        start: controller => { vadController = controller },
      })
      vadStream.updateInputStream(vadInput)
    }
    const byteStream = new surface.AudioByteStream(16_000, 1, 512)
    for (let offset = 0; offset < fixture.byteLength; offset += FRAME_BYTES) {
      const frames = byteStream.write(fixture.subarray(offset, offset + FRAME_BYTES))
      for (const frame of frames) {
        vadController?.enqueue(frame)
        turnStream?.pushAudio(frame)
        await clock.sleep(FRAME_CADENCE_SECONDS, signal)
      }
    }
    for (const frame of byteStream.flush()) {
      vadController?.enqueue(frame)
      turnStream?.pushAudio(frame)
      await clock.sleep(FRAME_CADENCE_SECONDS, signal)
    }
    vadController?.close()
    await Promise.resolve()
    await Promise.resolve()

    if (turnStream !== undefined) {
      const callsBefore = executor?.calls ?? 0
      const modelUnavailableBefore = executor?.modelUnavailable ?? false
      let probability: number | undefined
      let timedOut = false
      try {
        const prediction = await predictionWithDeadline(turnStream, clock, signal)
        probability = prediction.endOfTurnProbability
      } catch (error) {
        timedOut = error === TIMEOUT
      }
      eotObservation = {
        probability,
        calls: (executor?.calls ?? callsBefore) - callsBefore,
        modelUnavailable: (executor?.modelUnavailable ?? false) && !modelUnavailableBefore,
        modelValid,
        metadataValid,
        timedOut,
      }
    }
  } finally {
    if (vadStream !== undefined) {
      try {
        vadStream.close()
      } catch {
        cleanupFailed = true
      }
    }
    if (readerTask !== undefined && !await settleUnderSignal(readerTask, signal)) cleanupFailed = true
    if (turnStream !== undefined) {
      const ownedTurnStream = turnStream
      if (!await closeUnderSignal(() => ownedTurnStream.aclose(), signal)) cleanupFailed = true
    }
    if (detector !== undefined) {
      const ownedDetector = detector
      if (!await closeUnderSignal(() => ownedDetector.aclose(), signal)) cleanupFailed = true
    }
    if (vad !== undefined) {
      const ownedVad = vad
      if (!await closeUnderSignal(() => ownedVad.close(), signal)) cleanupFailed = true
    }
  }
  return {
    vad: summarizeVad(surface, vadEvents),
    eot: eotObservation,
    vadNativeMissing,
    cleanupFailed,
  }
}

async function readVadEvents(
  stream: LiveKitVadStream,
  target: LiveKitVadEvent[],
): Promise<void> {
  for await (const event of stream) target.push(event)
}

function summarizeVad(
  surface: LiveKitAgentsPublicSurface,
  events: readonly LiveKitVadEvent[],
): VadObservation {
  const starts = events.flatMap((event, index) => (
    event.type === surface.VADEventType.START_OF_SPEECH ? [index] : []
  ))
  const ends = events.flatMap((event, index) => (
    event.type === surface.VADEventType.END_OF_SPEECH ? [index] : []
  ))
  const inference = events.filter(event => event.type === surface.VADEventType.INFERENCE_DONE)
  return {
    inferenceCount: inference.length,
    probabilities: Object.freeze(inference.map(event => event.probability)),
    startCount: starts.length,
    endCount: ends.length,
    startBeforeEnd: starts.length === 1 && ends.length === 1 && starts[0]! < ends[0]!,
    speechFramesContainAudio: events
      .filter(event => event.type === surface.VADEventType.START_OF_SPEECH
        || event.type === surface.VADEventType.END_OF_SPEECH)
      .some(event => event.frames.some(frame => frame.data.some(sample => sample !== 0))),
  }
}

function classifyVad(
  speech: FixtureObservation,
  silence: FixtureObservation,
): CapabilityComponent {
  if (speech.vadNativeMissing || silence.vadNativeMissing) {
    return unavailableComponent('native_unavailable')
  }
  const speechMax = maximumProbability(speech.vad.probabilities)
  const silenceMax = maximumProbability(silence.vad.probabilities)
  if (speech.vad.inferenceCount === 0 || silence.vad.inferenceCount === 0
    || speech.vad.startCount !== 1 || speech.vad.endCount !== 1
    || !speech.vad.startBeforeEnd || !speech.vad.speechFramesContainAudio
    || silence.vad.startCount !== 0 || silence.vad.endCount !== 0) {
    return unavailableComponent('native_unavailable')
  }
  if (speechMax === undefined || silenceMax === undefined
    || speechMax < silenceMax + 0.05) {
    return unavailableComponent('inconclusive')
  }
  return readyComponent()
}

function classifyEot(
  speech: FixtureObservation,
  silence: FixtureObservation,
): CapabilityComponent {
  const speechEot = speech.eot
  const silenceEot = silence.eot
  if (speechEot?.modelUnavailable === true || silenceEot?.modelUnavailable === true) {
    return unavailableComponent('model_unavailable')
  }
  if (speechEot?.timedOut === true || silenceEot?.timedOut === true) {
    return unavailableComponent('timeout')
  }
  if (speechEot === undefined || silenceEot === undefined
    || !speechEot.metadataValid || !silenceEot.metadataValid
    || !speechEot.modelValid || !silenceEot.modelValid
    || speechEot.calls < 1 || silenceEot.calls < 1
    || !finiteProbability(speechEot.probability)
    || !finiteProbability(silenceEot.probability)
    || (speechEot.probability === 1 && silenceEot.probability === 1)
    || speechEot.probability < silenceEot.probability + 0.05) {
    return unavailableComponent('inconclusive')
  }
  return readyComponent()
}

interface CountingExecutor extends LiveKitExecutor {
  readonly calls: number
  readonly modelUnavailable: boolean
}

function countingExecutor(delegate: LiveKitExecutor): CountingExecutor {
  let calls = 0
  let modelUnavailable = false
  return {
    get calls() { return calls },
    get modelUnavailable() { return modelUnavailable },
    async doInference(method: string, data: unknown): Promise<unknown> {
      calls += 1
      try {
        return await delegate.doInference(method, data)
      } catch (error) {
        if (isModelUnavailable(error)) modelUnavailable = true
        throw error
      }
    },
  }
}

function isModelUnavailable(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'model_unavailable'
}

async function predictionWithDeadline(
  stream: LiveKitTurnStream,
  clock: Clock,
  signal: AbortSignal,
): Promise<LiveKitTurnPrediction> {
  const timerController = new AbortController()
  const timer = clock.sleep(PREDICTION_TIMEOUT_SECONDS, timerController.signal).then(() => {
    throw TIMEOUT
  })
  timer.catch(() => undefined)
  try {
    return await Promise.race([
      Promise.resolve(stream.predict().await),
      timer,
      abortPromise(signal),
    ])
  } finally {
    timerController.abort()
    await timer.catch(() => undefined)
  }
}

async function closeUnderSignal(operation: () => Promise<void>, signal: AbortSignal): Promise<boolean> {
  try {
    return await settleUnderSignal(operation(), signal)
  } catch {
    return false
  }
}

async function settleUnderSignal(promise: Promise<void>, signal: AbortSignal): Promise<boolean> {
  promise.catch(() => undefined)
  try {
    await Promise.race([promise, abortPromise(signal)])
    return true
  } catch {
    return false
  }
}

function waitForCaller(
  promise: Promise<EndpointingCapabilityResult>,
  signal: AbortSignal,
  onAbort: () => void,
): Promise<EndpointingCapabilityResult> {
  if (signal.aborted) {
    onAbort()
    return Promise.reject(ABORTED)
  }
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      onAbort()
      reject(ABORTED)
    }
    signal.addEventListener('abort', aborted, {once: true})
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return await Promise.race([promise, abortPromise(signal)])
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(ABORTED)
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(ABORTED), {once: true})
  })
}

function recordResolution(
  telemetry: RealtimeTelemetry | undefined,
  result: EndpointingCapabilityResult,
): void {
  if (telemetry === undefined) return
  try {
    telemetry.record('volcengine.endpointing.capability', {
      mode: result.mode,
      eot_reason: result.eot.reason,
      vad_reason: result.vad.reason,
      platform: result.platform,
      arch: result.arch,
    })
    if (result.mode === 'bounded_silence') {
      telemetry.record('volcengine.endpointing.fallback', {
        eot_reason: result.eot.reason,
        vad_reason: result.vad.reason,
      })
    }
  } catch {
    return
  }
}

function capabilityResult(
  platform: string,
  arch: string,
  eot: CapabilityComponent,
  vad: CapabilityComponent,
): EndpointingCapabilityResult {
  const ready = eot.available && vad.available
  return Object.freeze({
    schema_version: 1,
    mode: ready ? 'livekit_v1_mini' : 'bounded_silence',
    eot: Object.freeze({...eot}),
    vad: Object.freeze({...vad}),
    platform,
    arch,
  })
}

function readyComponent(): CapabilityComponent {
  return Object.freeze({available: true, reason: 'ready'})
}

function unavailableComponent(reason: EndpointingCapabilityReason): CapabilityComponent {
  return Object.freeze({available: false, reason})
}

function maximumProbability(values: readonly number[]): number | undefined {
  let maximum: number | undefined
  for (const value of values) {
    if (!finiteProbability(value)) return undefined
    maximum = maximum === undefined ? value : Math.max(maximum, value)
  }
  return maximum
}

function finiteProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function supportedLibc(runtime: EndpointingProbeRuntime): string {
  if (runtime.platform !== 'linux') return 'not_linux'
  return typeof runtime.glibcVersionRuntime === 'string'
    && stripLikePython(runtime.glibcVersionRuntime) !== ''
    ? 'glibc'
    : 'unknown'
}

function isSupportedRuntime(runtime: EndpointingProbeRuntime, libc: string): boolean {
  if (runtime.platform === 'darwin') return runtime.arch === 'arm64' || runtime.arch === 'x64'
  if (runtime.platform === 'win32') return runtime.arch === 'x64'
  if (runtime.platform === 'linux') {
    return libc === 'glibc' && (runtime.arch === 'arm64' || runtime.arch === 'x64')
  }
  return false
}

function currentProbeRuntime(): EndpointingProbeRuntime {
  let glibcVersionRuntime: unknown
  if (process.platform === 'linux') {
    try {
      const report = process.report?.getReport() as {
        readonly header?: {readonly glibcVersionRuntime?: unknown}
      } | undefined
      glibcVersionRuntime = report?.header?.glibcVersionRuntime
    } catch {
      glibcVersionRuntime = undefined
    }
  }
  return {
    platform: process.platform,
    arch: process.arch,
    ...(glibcVersionRuntime === undefined ? {} : {glibcVersionRuntime}),
  }
}

function cacheState(cache: EndpointingCapabilityCache): CapabilityCacheState {
  let state = CACHE_STATES.get(cache)
  if (state === undefined) {
    state = {entries: new Map(), loggerInitialized: false}
    CACHE_STATES.set(cache, state)
  }
  return state
}

function copyAndValidateFixtures(
  fixtures: EndpointingCapabilityFixtures,
): EndpointingCapabilityFixtures | null {
  const speech = Uint8Array.from(fixtures.speech)
  const silence = Uint8Array.from(fixtures.silence)
  if (speech.byteLength !== FIXTURE_BYTES || silence.byteLength !== FIXTURE_BYTES
    || digest(speech) !== SPEECH_SHA256 || digest(silence) !== SILENCE_SHA256) {
    return null
  }
  return Object.freeze({speech, silence})
}

async function loadCapabilityFixtures(
  signal: AbortSignal,
): Promise<EndpointingCapabilityFixtures | null> {
  if (signal.aborted) throw ABORTED
  const relative = join('fixtures', 'realtime', 'volcengine', 'v1', 'endpointing')
  const candidates = [
    join(process.cwd(), relative),
    fileURLToPath(new URL('../../../../../fixtures/realtime/volcengine/v1/endpointing/', import.meta.url)),
  ]
  for (const directory of candidates) {
    try {
      const [speech, silence] = await Promise.all([
        readFile(join(directory, 'speech-16k-s16le.pcm')),
        readFile(join(directory, 'silence-16k-s16le.pcm')),
      ])
      return copyAndValidateFixtures({speech, silence})
    } catch {
      continue
    }
  }
  return null
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const UNREF_CLOCK: Clock = Object.freeze({
  now: () => performance.now() / 1_000,
  sleep: (duration: number, signal?: AbortSignal) => {
    if (!Number.isFinite(duration) || duration < 0) return Promise.reject(new RangeError('invalid delay'))
    if (signal?.aborted === true) return Promise.reject(ABORTED)
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(ABORTED)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, duration * 1_000)
      timer.unref()
      signal?.addEventListener('abort', onAbort, {once: true})
    })
  },
})

function unavailableCapability(
  platform: string,
  arch: string,
  reason: EndpointingCapabilityReason,
): EndpointingCapabilityResult {
  const unavailable = Object.freeze({available: false, reason})
  return Object.freeze({
    schema_version: 1,
    mode: 'bounded_silence',
    eot: unavailable,
    vad: unavailable,
    platform,
    arch,
  })
}

export function scanLiveKitPublicSurface(
  inventory: LiveKitPolicyInventory,
): readonly LiveKitPolicyViolation[] {
  const violations: LiveKitPolicyViolation[] = []

  for (const source of inventory.productionSources) {
    for (const specifier of liveKitLiteralSpecifiers(source.source)) {
      if (specifier !== LIVEKIT_AGENTS_ROOT) {
        violations.push(Object.freeze({
          code: 'forbidden_import',
          path: source.path,
          value: specifier,
        }))
      }
    }
    for (const blockedApi of FORBIDDEN_SOURCE_APIS) {
      if (source.source.includes(blockedApi)) {
        violations.push(Object.freeze({
          code: 'forbidden_source_api',
          path: source.path,
          value: blockedApi,
        }))
      }
    }
  }

  for (const manifestEntry of inventory.packageManifests) {
    const manifest = asStringRecord(manifestEntry.manifest)
    if (manifest === null) continue
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = asStringRecord(manifest[section])
      if (dependencies === null) continue
      if (Object.hasOwn(dependencies, LIVEKIT_LOCAL_INFERENCE)) {
        violations.push(Object.freeze({
          code: 'forbidden_dependency',
          path: manifestEntry.path,
          value: LIVEKIT_LOCAL_INFERENCE,
        }))
      }
      for (const [dependency, expectedVersion] of Object.entries(LIVEKIT_DEPENDENCY_VERSIONS)) {
        if (!Object.hasOwn(dependencies, dependency)) continue
        const actualVersion = dependencies[dependency]
        if (actualVersion !== expectedVersion) {
          violations.push(Object.freeze({
            code: 'unsupported_dependency_version',
            path: manifestEntry.path,
            value: `${dependency}@${String(actualVersion)}`,
          }))
        }
      }
    }
  }

  return Object.freeze(violations)
}

function liveKitLiteralSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(LIVEKIT_STRING_LITERAL)) {
    const specifier = match[1] ?? match[2] ?? match[3]
    if (specifier !== undefined) specifiers.push(specifier)
  }
  return Object.freeze(specifiers)
}

function asStringRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
