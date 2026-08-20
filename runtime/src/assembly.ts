/**
 * Production assembly: settings in, a serving runtime out.
 *
 * This is the piece Stage 1 acceptance was missing. Everything below it was already
 * ported and tested in isolation; this wires the model gateway, the three model ports,
 * the executor adapters, and `CausalRuntime` into one object a desktop entry can serve.
 *
 * The FastBrain port is deliberately NOT a plain completion. It streams, and it opens the
 * Floor at its first non-empty text chunk through `CoreRuntime.openFloor`, which is where
 * the oracle arbitrates. Folding the stream first and deciding at completion would consult
 * a Floor that has already moved on -- see `calls.ts` and the runtime's Floor tests.
 */

import {
  CausalRuntime,
  type ExecutorAdapter,
  type ModelPort,
} from './causal-runtime.js'
import { RealClock, type Clock } from './clock.js'
import { resolveProactivity, type Settings } from './config.js'
import { MonotonicIdFactory, type IdFactory } from './ids.js'
import {
  GatewayCompressor,
  GatewayFastBrain,
  GatewaySurrogate,
  type MediaSelector,
} from './model-adapters.js'
import { OpenAIModelGateway, type MetricsSink, type ModelGateway } from './model-gateway.js'
import { runFastBrainCall, runSurrogateCall, type SpeechSink } from './calls.js'
import { CamAdapter } from './executors/camera.js'
import { DisabledFrameSource } from './executors/frame-source.js'
import {
  SearchAdapter,
  TavilyTransport,
  type SearchTransport,
} from './executors/search.js'
import {
  GUARD_MANIFEST,
  WATCH_MANIFEST,
  WatchAdapter,
  type FrameSource,
} from './executors/watcher.js'
import { MediaStore } from './media-store.js'
import type { ExecutorManifest } from './ports.js'
import { stripLikePython } from './python-text.js'
import { buildSimulator, simManifestRegistry } from './sims.js'
import { compileToolSchema, type CompiledTools } from './tool-schema.js'
import type { ModelCall } from './runtime.js'
import type { Slot } from './slots.js'

export class AssemblyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssemblyError'
  }
}

/** A sink that drops speech, used when no output device is attached yet. */
export const NULL_SPEECH_SINK: SpeechSink = {
  emit: () => undefined,
  end: () => undefined,
}

export interface AssemblyOptions {
  readonly settings: Settings
  readonly clock?: Clock
  readonly ids?: IdFactory
  readonly sink?: SpeechSink
  readonly gateway?: ModelGateway
  readonly metrics?: MetricsSink
  readonly media?: MediaSelector
  /** Extra adapters beyond the simulators, keyed by the manifest name they serve. */
  readonly executors?: readonly ExecutorAdapter[]
  /** Test/host seam below SearchAdapter; production constructs TavilyTransport. */
  readonly searchTransport?: SearchTransport
  /** Host capture seam; production is disabled until the desktop capture task wires one. */
  readonly frameSource?: FrameSource
  readonly mediaStore?: MediaStore
  readonly includeMemoryRecall?: boolean
  /** Qwen/other provider frontbrains own the user turn, so no competing fast text port is built. */
  readonly realtimeFrontbrain?: boolean
}

export interface Assembly {
  readonly runtime: CausalRuntime
  readonly gateway: ModelGateway
  readonly tools: CompiledTools
  readonly manifests: readonly ExecutorManifest[]
  readonly mediaStore: MediaStore
  readonly frameSource: FrameSource
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * Resolve the executor adapters the configured names require.
 *
 * A configured name with no adapter is an assembly failure rather than a silent
 * omission: the tool schema would still advertise it to the model, and the first
 * delegation would then fail at dispatch instead of at startup.
 */
function resolveExecutors(
  settings: Settings,
  supplied: readonly ExecutorAdapter[],
): readonly ExecutorAdapter[] {
  const byName = new Map<string, ExecutorAdapter>()
  for (const adapter of supplied) {
    if (byName.has(adapter.manifest.name)) {
      throw new AssemblyError(`duplicate executor adapter: ${adapter.manifest.name}`)
    }
    byName.set(adapter.manifest.name, adapter)
  }
  const resolved: ExecutorAdapter[] = []
  const missing: string[] = []
  for (const name of settings.executors) {
    const adapter = byName.get(name) ?? buildSimulator(name)
    if (adapter === undefined) {
      missing.push(name)
      continue
    }
    resolved.push(adapter)
  }
  if (missing.length > 0) {
    throw new AssemblyError(`no adapter for configured executor(s): ${missing.join(', ')}`)
  }
  return resolved
}

function requireApiKey(settings: Settings): string {
  const key = stripLikePython(settings.model_api_key ?? '')
  if (key.length === 0) {
    // Never echo configuration values; the name is enough to act on.
    throw new AssemblyError('缺少 NOVA_AUDIO_AGENT_MODEL_API_KEY')
  }
  return key
}

function requireTavilyApiKey(settings: Settings): string {
  const key = stripLikePython(settings.tavily_api_key ?? '')
  if (key.length === 0) {
    throw new AssemblyError('缺少 TAVILY_API_KEY')
  }
  return key
}

export interface FileBackedFrameSource extends FrameSource {
  readonly isFileBackedFrameSource: true
  restart(): Promise<void>
}

export function isFileBackedFrameSource(source: FrameSource): source is FileBackedFrameSource {
  return 'isFileBackedFrameSource' in source
    && source.isFileBackedFrameSource === true
    && 'restart' in source
    && typeof source.restart === 'function'
}

/**
 * Build the runtime the desktop entry serves.
 *
 * The three model ports are wired as `ModelPort`s over one gateway. Only the fast slot
 * streams; the surrogate and compressor are single completions, matching the oracle.
 */
export function buildAssembly(options: AssemblyOptions): Assembly {
  const {settings} = options
  const clock = options.clock ?? new RealClock()
  const ids = options.ids ?? new MonotonicIdFactory()
  const sink = options.sink ?? NULL_SPEECH_SINK

  // Preserve Python's validation order: the model credential is checked before
  // Tavily when neither production transport is injected.
  const gateway = options.gateway ?? new OpenAIModelGateway({
    baseUrl: settings.model_base_url,
    apiKey: requireApiKey(settings),
    clock,
    ...(options.metrics === undefined ? {} : {metrics: options.metrics}),
  })
  const searchTransport = options.searchTransport
    ?? new TavilyTransport(requireTavilyApiKey(settings))
  const mediaStore = options.mediaStore ?? new MediaStore()
  const frameSource = options.frameSource ?? new DisabledFrameSource()
  const captureEnabled = !(frameSource instanceof DisabledFrameSource)
  const watchModel = stripLikePython(settings.watch_model ?? '') || settings.fast_model

  const search = new SearchAdapter(searchTransport)
  const camera = new CamAdapter(frameSource, mediaStore)
  const watch = new WatchAdapter({
    manifest: WATCH_MANIFEST,
    source: frameSource,
    gateway,
    mediaStore,
    model: watchModel,
    captureEnabled,
  })
  const guard = new WatchAdapter({
    manifest: GUARD_MANIFEST,
    source: frameSource,
    gateway,
    mediaStore,
    model: watchModel,
    captureEnabled,
    ...(isFileBackedFrameSource(frameSource)
      ? {prepareObservation: () => frameSource.restart()}
      : {}),
  })
  const configuredExecutors = resolveExecutors(settings, options.executors ?? [])
  const executors = [search, camera, watch, guard, ...configuredExecutors]
  const manifests = executors.map(adapter => adapter.manifest)
  const tools = compileToolSchema(manifests, {
    includeMemoryRecall: options.realtimeFrontbrain === true
      ? true
      : (options.includeMemoryRecall ?? false),
  })

  const surrogate = new GatewaySurrogate({gateway, model: settings.surrogate_model})
  const compressor = new GatewayCompressor({gateway, model: settings.compressor_model})

  const proactivity = resolveProactivity(settings)
  // The model ports need the runtime that owns them, and the runtime needs the ports to be
  // constructed. One holder breaks the cycle without exposing a half-built runtime.
  const holder: {runtime?: CausalRuntime} = {}
  const requireRuntime = (): CausalRuntime => {
    if (holder.runtime === undefined) throw new AssemblyError('assembly is not built yet')
    return holder.runtime
  }

  const models: Partial<Record<Slot, ModelPort>> = {
    'surrogate.watch': {
      complete: async (call: ModelCall, signal: AbortSignal) => {
        const view = call.context_view
        if (view === undefined) throw new AssemblyError('surrogate slot requires a ContextView')
        const record = await runSurrogateCall(surrogate, {view, reason: call.reason, signal})
        return record.output
      },
    },
    compress: {
      complete: async (call: ModelCall, signal: AbortSignal) => {
        const channel = call.channel
        const items = call.compression_items
        if (channel === undefined || items === undefined) {
          throw new AssemblyError('compress slot requires a channel and its items')
        }
        return {
          channel,
          summary: await compressor.compress(items, signal),
        }
      },
    },
  }
  if (options.realtimeFrontbrain !== true) {
    const fastBrain = new GatewayFastBrain({
      gateway,
      model: settings.fast_model,
      tools,
      ...(options.media === undefined ? {} : {media: options.media}),
    })
    models.fast = {
      complete: async (call: ModelCall, signal: AbortSignal) => {
        const view = call.context_view
        if (view === undefined) throw new AssemblyError('fast slot requires a ContextView')
        const utteranceId = call.utterance_id
        if (utteranceId === undefined) {
          throw new AssemblyError('fast slot requires an utterance id')
        }
        const core = requireRuntime().core
        const record = await runFastBrainCall(fastBrain, {
          view,
          reason: call.reason,
          utteranceId,
          sink,
          // Arbitration happens here, at the first chunk, not after the fold.
          openFloor: (utterance, priority) =>
            core.openFloor(call.job_id, utterance, priority, clock.now()),
          closeFloor: utterance => { core.closeFloor(utterance, clock.now()) },
          signal,
        })
        return foldFastBrainRecord(record)
      },
    }
  }

  holder.runtime = new CausalRuntime({
    clock,
    ids,
    models,
    executors,
    suggestionCooldown: proactivity.cooldown,
    freshWindow: proactivity.fresh_window,
  })

  let started = false
  let lifecycle = Promise.resolve()
  const serializeLifecycle = (operation: () => Promise<void>): Promise<void> => {
    const pending = lifecycle.catch(() => undefined).then(operation)
    lifecycle = pending
    return pending
  }
  return {
    runtime: holder.runtime,
    gateway,
    tools,
    manifests,
    mediaStore,
    frameSource,
    start(): Promise<void> {
      return serializeLifecycle(async () => {
        if (started) return
        await frameSource.start()
        started = true
      })
    },
    stop(): Promise<void> {
      return serializeLifecycle(async () => {
        if (!started) return
        await frameSource.stop()
        started = false
      })
    },
  }
}

/**
 * Fold one streamed FastBrain call into the single output the reducer validates.
 *
 * The speech axis has already been voiced by the time this runs, so the fold only has to
 * describe what happened. A deferred utterance still reports its text, because the
 * suggestion pool needs it, and the action axis is independent of that verdict. The
 * contract failures and the surplus-action count travel with it because the reducer uses
 * each to suppress the action entirely, exactly as `Runtime._consume` does.
 */
export function foldFastBrainRecord(record: {
  readonly spoken_text: string
  readonly speak_act: 'say' | 'ask'
  readonly action: {readonly act: string}
  readonly extra_actions: number
  readonly contract_failures: readonly {readonly code: string, readonly tool_name: string | null}[]
}): unknown {
  return {
    speak: record.spoken_text.length === 0
      ? {act: 'none'}
      : {act: record.speak_act, text: record.spoken_text},
    action: record.action,
    // Both of these suppress the action in the reducer, so dropping them here would
    // dispatch work the oracle refuses -- an unknown tool alongside a valid delegate, or
    // two conflicting delegates where only the first would survive.
    contract_failures: record.contract_failures.map(failure => ({...failure})),
    extra_actions: record.extra_actions,
  }
}

export { simManifestRegistry }
