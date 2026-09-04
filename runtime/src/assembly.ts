/**
 * Production assembly: settings in, a serving runtime out.
 *
 * This is the piece Stage 1 acceptance was missing. Everything below it was already
 * ported and tested in isolation; this wires the model gateway, the support model ports,
 * the executor adapters, and `CausalRuntime` into one object a desktop entry can serve.
 *
 * The `fast` slot is deliberately left unwired: v0.2 has no text front brain, and the
 * realtime owner supplies that port along with its own Floor arbitration.
 */

import {
  CausalRuntime,
  type ExecutorAdapter,
  type ModelPort,
} from './causal-runtime.js'
import { RealClock, type Clock } from './clock.js'
import { resolveProactivity, type Settings } from './config.js'
import { MonotonicIdFactory, type IdFactory } from './ids.js'
import { GatewayCompressor, GatewaySurrogate } from './model-adapters.js'
import { OpenAIModelGateway, type MetricsSink, type ModelGateway } from './model-gateway.js'
import { classifySurrogateVerdict, runSurrogateCall } from './calls.js'
import { CameraMcpAdapter, MCP_CAMERA_EXECUTOR } from './executors/mcp-camera.js'
import {
  CODEX_AGENT_DESCRIPTOR,
  VisionAgentController,
  VisionAgentControllerCore,
  VisionLifecycleBridge,
  VISION_AGENT_DESCRIPTOR,
} from './executors/index.js'
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
  type ObservationAdmission,
} from './executors/watcher.js'
import { MediaStore } from './media-store.js'
import type { ExecutorManifest } from './ports.js'
import type {AgentDescriptor} from './agent-controller.js'
import { stripLikePython } from './python-text.js'
import { buildSimulator, simManifestRegistry } from './sims.js'
import { compileToolSchema, type CompiledTools } from './tool-schema.js'
import type { ModelCall } from './runtime.js'
import type { Slot } from './slots.js'
import type {RealtimeTelemetry} from './realtime/telemetry.js'
import {USER_PRIORITY} from './memory.js'

export class AssemblyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssemblyError'
  }
}

export interface AssemblyOptions {
  readonly settings: Settings
  readonly clock?: Clock
  readonly ids?: IdFactory
  readonly gateway?: ModelGateway
  readonly metrics?: MetricsSink
  /** Extra adapters beyond the simulators, keyed by the manifest name they serve. */
  readonly executors?: readonly ExecutorAdapter[]
  /** Test/host seam below SearchAdapter; production constructs TavilyTransport. */
  readonly searchTransport?: SearchTransport
  /** Host capture seam; production is disabled until the desktop capture task wires one. */
  readonly frameSource?: FrameSource
  readonly mediaStore?: MediaStore
  readonly telemetry?: RealtimeTelemetry
  /** False removes all camera-facing model tools, including watch and guard. */
  readonly cameraModuleEnabled?: boolean
  /** Public host-agent descriptors. Codex is registered by the production composition when enabled. */
  readonly agentDescriptors?: readonly AgentDescriptor[]
}

export interface Assembly {
  readonly runtime: CausalRuntime
  readonly gateway: ModelGateway
  readonly tools: CompiledTools
  readonly manifests: readonly ExecutorManifest[]
  readonly mediaStore: MediaStore
  readonly frameSource: FrameSource
  readonly visionController: VisionAgentController | undefined
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
  if (key === '') {
    // Never echo configuration values; the name is enough to act on.
    throw new AssemblyError('缺少 NOVA_AUDIO_AGENT_MODEL_API_KEY')
  }
  return key
}

function requireTavilyApiKey(settings: Settings): string {
  const key = stripLikePython(settings.tavily_api_key ?? '')
  if (key === '') {
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

interface AdmissionGatedFrameSource extends FrameSource {
  admitObservation(): Promise<ObservationAdmission>
}

function isAdmissionGatedFrameSource(source: FrameSource): source is AdmissionGatedFrameSource {
  return 'admitObservation' in source && typeof source.admitObservation === 'function'
}

/**
 * Build the runtime the desktop entry serves.
 *
 * The support model ports are wired as `ModelPort`s over one gateway; the surrogate and
 * compressor are single completions, matching the oracle.
 */
export function buildAssembly(options: AssemblyOptions): Assembly {
  const {settings} = options
  const clock = options.clock ?? new RealClock()
  const ids = options.ids ?? new MonotonicIdFactory()

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
  const cameraModuleEnabled = options.cameraModuleEnabled ?? true
  if ((options.executors ?? []).some(adapter => adapter.manifest.name === MCP_CAMERA_EXECUTOR)) {
    throw new AssemblyError(`built-in executor cannot be overridden: ${MCP_CAMERA_EXECUTOR}`)
  }
  const watchModel = stripLikePython(settings.watch_model ?? '') || settings.fast_model
  const visionLifecycle = cameraModuleEnabled ? new VisionLifecycleBridge() : undefined

  const search = new SearchAdapter(searchTransport)
  const camera = cameraModuleEnabled ? new CameraMcpAdapter({
    source: frameSource, mediaStore, gateway, model: watchModel,
  }) : undefined
  const admissionOptions = isAdmissionGatedFrameSource(frameSource)
    ? {
        admitObservation: () => frameSource.admitObservation(),
        ...(options.telemetry === undefined
          ? {}
          : {onObservationAdmission: (
              status: ObservationAdmission,
              executor: 'watch' | 'guard',
            ): void => {
              try {
                options.telemetry?.record('camera.admission', {
                  executor,
                  status,
                  phase: 'pre_arm',
                  admitted: status === 'granted',
                })
              } catch { /* telemetry cannot change admission */ }
            }}),
      }
    : {}
  const captureEnabled = !(frameSource instanceof DisabledFrameSource)
  const watch = cameraModuleEnabled ? new WatchAdapter({
    manifest: WATCH_MANIFEST, source: frameSource, gateway, mediaStore, model: watchModel,
    captureEnabled, ...admissionOptions,
    ...(visionLifecycle === undefined ? {} : {onMonitorLifecycle: {
      admission: (delegateId, status) => visionLifecycle.admission(delegateId, status),
      hit: delegateId => visionLifecycle.hit(delegateId),
      terminal: delegateId => visionLifecycle.terminal(delegateId),
    }}),
  }) : undefined
  const guard = cameraModuleEnabled ? new WatchAdapter({
    manifest: GUARD_MANIFEST, source: frameSource, gateway, mediaStore, model: watchModel,
    captureEnabled, ...admissionOptions,
    ...(isFileBackedFrameSource(frameSource) ? {prepareObservation: () => frameSource.restart()} : {}),
    ...(visionLifecycle === undefined ? {} : {onMonitorLifecycle: {
      admission: (delegateId, status) => visionLifecycle.admission(delegateId, status),
      hit: delegateId => visionLifecycle.hit(delegateId),
      terminal: delegateId => visionLifecycle.terminal(delegateId),
    }}),
  }) : undefined
  const configuredExecutors = resolveExecutors(settings, options.executors ?? [])
  const executors = [
    search,
    ...(camera === undefined || watch === undefined || guard === undefined ? [] : [camera, watch, guard]),
    ...configuredExecutors,
  ]
  const manifests = executors.map(adapter => adapter.manifest)
  const agentDescriptors = [
    ...(manifests.some(manifest => manifest.name === 'codex') ? [CODEX_AGENT_DESCRIPTOR] : []),
    ...(cameraModuleEnabled ? [VISION_AGENT_DESCRIPTOR] : []),
    ...(options.agentDescriptors ?? []),
  ]
  const tools = compileToolSchema(manifests, {includeMemoryRecall: true, agentDescriptors})

  const surrogate = new GatewaySurrogate({
    gateway,
    model: settings.surrogate_model,
    proactivityPreset: settings.proactivity_preset,
  })
  const compressor = new GatewayCompressor({gateway, model: settings.compressor_model})

  const proactivity = resolveProactivity(settings)
  const models: Partial<Record<Slot, ModelPort>> = {
    'surrogate.watch': {
      complete: async (call: ModelCall, signal: AbortSignal) => {
        const view = call.context_view
        if (view === undefined) throw new AssemblyError('surrogate slot requires a ContextView')
        const record = await runSurrogateCall(surrogate, {view, reason: call.reason, signal})
        try {
          options.telemetry?.record('surrogate.verdict', {
            disposition: classifySurrogateVerdict(record),
            offered_count: record.offered.length,
            preset: settings.proactivity_preset,
            progress_class: record.output.progress_class,
            suppressed: call.reason.kind === 'progress'
              && record.output.speak
              && record.output.progress_class === 'routine_delta',
            trigger_kind: call.reason.kind,
          })
        } catch { /* telemetry cannot change arbitration */ }
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

  const runtime = new CausalRuntime({
    clock,
    ids,
    models,
    executors,
    suggestionCooldown: proactivity.cooldown,
    freshWindow: proactivity.fresh_window,
  })
  const visionController = visionLifecycle === undefined ? undefined : (() => {
    const vision = new VisionAgentControllerCore({
      gateway, watchModel, requestIdFactory: () => ids.next('vision'), lifecycleSink: visionLifecycle,
      runtimePort: {dispatch: request => {
        if (!request.stillWanted()) return {accepted: false, delegate_id: null}
        return runtime.dispatchExternal({
          executor: request.channel, op: request.op, request: request.request, origin_ref: request.origin_ref,
        }, {
          kind: 'realtime_tool', priority: USER_PRIORITY, routing_class: 'user_awaited',
          origin: null, selected_suggestion: null,
        })
      }},
    })
    visionLifecycle.attach(vision)
    return new VisionAgentController({core: vision})
  })()

  let started = false
  let lifecycle = Promise.resolve()
  const serializeLifecycle = (operation: () => Promise<void>): Promise<void> => {
    const pending = lifecycle.catch(() => undefined).then(operation)
    lifecycle = pending
    return pending
  }
  return {
    runtime,
    gateway,
    tools,
    manifests,
    mediaStore,
    frameSource,
    visionController,
    start(): Promise<void> {
      return serializeLifecycle(async () => {
        if (started) return
        if (!cameraModuleEnabled) {
          started = true
          return
        }
        let frameStarted = false
        try {
          await frameSource.start()
          frameStarted = true
          await camera!.connect()
        } catch {
          if (frameStarted) {
            try { await frameSource.stop() } catch { /* the setup error is authoritative */ }
          }
          throw new AssemblyError('camera MCP startup failed')
        }
        started = true
      })
    },
    stop(): Promise<void> {
      return serializeLifecycle(async () => {
        if (!started) return
        if (cameraModuleEnabled) {
          try { await camera!.close() } finally { await frameSource.stop() }
        }
        started = false
      })
    },
  }
}

export { simManifestRegistry }
