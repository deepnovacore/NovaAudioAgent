/** Production Qwen composition above the provider-neutral realtime owner. */

import {AssemblyError, buildAssembly, type AssemblyOptions} from './assembly.js'
import type {CodexAssemblyResource} from './codex-factory.js'
import { RealClock } from './clock.js'
import {
  DASHSCOPE_COMPATIBLE_BASE_URL,
  requireQwenRealtime,
  resolveSupportModelConnection,
  type QwenRealtimeConfig,
} from './config.js'
import { MonotonicIdFactory } from './ids.js'
import { OpenAIModelGateway } from './model-gateway.js'
import {
  buildRealtimeAssembly,
  type RealtimeAssembly,
  type RealtimeAssemblyOptions,
} from './realtime-assembly.js'
import type {RealtimeProvider} from './realtime/protocol.js'
import { QwenAudioRealtimeAdapter, type QwenConnector } from './realtime/qwen.js'
import { webSocketQwenConnector } from './realtime/qwen-transport.js'
import {workspaceGraphServiceFromSettings} from './workspace-graph/factory.js'

export interface BuildQwenRealtimeAssemblyOptions
  extends Omit<
    AssemblyOptions,
    'gateway' | 'includeMemoryRecall' | 'realtimeFrontbrain'
  >, Omit<
    RealtimeAssemblyOptions,
    | 'core'
    | 'provider'
    | 'idFactory'
    | 'controlledGuardReconnect'
    | 'guardHistoryRecovery'
    | 'guardHistoryPairs'
  > {
  /** Deterministic test seam; production uses the bounded WebSocket connector. */
  readonly connector?: QwenConnector
  /** Host-resolved selected-provider config; integrated production never re-resolves settings. */
  readonly qwenConfig?: QwenRealtimeConfig
  /** Host-selected provider; integrated registries never receive host composition options. */
  readonly qwenProvider?: RealtimeProvider
  /** Host-resolved Codex resource; never derived from provider or renderer input. */
  readonly codexResource?: CodexAssemblyResource
}

/** Narrow provider-only form used by the integrated provider registry. */
export interface BuildQwenRealtimeProviderOptions {
  readonly config: QwenRealtimeConfig
  readonly connector?: QwenConnector
  readonly idFactory: () => string
  readonly now: () => number
  readonly workspaceGraphPolicy: boolean
}

/**
 * Build the narrow Qwen provider selected by a registry, or one complete ownership graph.
 *
 * The narrow overload cannot see host settings or core resources. Full composition resolves host
 * settings before construction. Connection and rollback remain owned by `RealtimeAssembly.start()`.
 */
export function buildQwenRealtimeAssembly(
  options: BuildQwenRealtimeProviderOptions,
): QwenAudioRealtimeAdapter
export function buildQwenRealtimeAssembly(
  options: BuildQwenRealtimeAssemblyOptions,
): RealtimeAssembly
export function buildQwenRealtimeAssembly(
  options: BuildQwenRealtimeAssemblyOptions | BuildQwenRealtimeProviderOptions,
): RealtimeAssembly | QwenAudioRealtimeAdapter {
  if ('config' in options) {
    return new QwenAudioRealtimeAdapter({
      url: options.config.url,
      apiKey: options.config.apiKey,
      model: options.config.model,
      voice: options.config.voice,
      connector: options.connector ?? webSocketQwenConnector,
      idFactory: options.idFactory,
      now: options.now,
      workspaceGraphPolicy: options.workspaceGraphPolicy,
    })
  }
  const codexSelected = options.settings.executors.includes('codex')
  if (codexSelected !== (options.codexResource !== undefined)) {
    throw new AssemblyError('realtime Codex resource selection mismatch')
  }
  if (options.codexResource?.mode === 'ordinary') {
    throw new AssemblyError('ordinary Codex resource cannot enter realtime composition')
  }
  if (
    options.codexResource !== undefined
    && options.settings.codex_projects_enabled !== (options.codexResource.mode === 'project')
  ) throw new AssemblyError('realtime Codex project mode mismatch')
  const qwen = options.qwenConfig ?? requireQwenRealtime(options.settings)
  const clock = options.clock ?? new RealClock()
  const ids = options.ids ?? new MonotonicIdFactory()
  const support = resolveSupportModelConnection(options.settings, {
    baseUrl: DASHSCOPE_COMPATIBLE_BASE_URL,
    apiKey: qwen.apiKey,
  })
  const gateway = new OpenAIModelGateway({
    baseUrl: support.baseUrl,
    apiKey: support.apiKey,
    clock,
    ...(options.metrics === undefined ? {} : {metrics: options.metrics}),
  })
  const core = buildAssembly({
    settings: options.settings,
    clock,
    ids,
    gateway,
    realtimeFrontbrain: true,
    ...(options.sink === undefined ? {} : {sink: options.sink}),
    ...(options.metrics === undefined ? {} : {metrics: options.metrics}),
    ...(options.media === undefined ? {} : {media: options.media}),
    ...((options.executors === undefined && options.codexResource === undefined)
      ? {}
      : {executors: [
          ...(options.executors ?? []),
          ...(options.codexResource === undefined ? [] : [options.codexResource.adapter]),
        ]}),
    ...(options.searchTransport === undefined ? {} : {searchTransport: options.searchTransport}),
    ...(options.frameSource === undefined ? {} : {frameSource: options.frameSource}),
    ...(options.mediaStore === undefined ? {} : {mediaStore: options.mediaStore}),
  })
  const provider = options.qwenProvider ?? buildQwenRealtimeAssembly({
    config: qwen,
    ...(options.connector === undefined ? {} : {connector: options.connector}),
    idFactory: () => ids.next('qwen'),
    now: () => clock.now(),
    workspaceGraphPolicy: options.settings.workspace_graph_enabled,
  })
  const workspaceGraph = workspaceGraphServiceFromSettings(
    options.settings,
    code => {
      if (code === 'workspace_graph_open_failed') return
      try { options.onDiagnostic?.(`[realtime-diagnostic] ${code}`) } catch { /* advisory */ }
    },
  )
  return buildRealtimeAssembly({
    core,
    provider,
    idFactory: () => ids.next('realtime'),
    controlledGuardReconnect: options.settings.qwen_controlled_guard_reconnect,
    guardHistoryRecovery: options.settings.qwen_guard_history_recovery,
    guardHistoryPairs: options.settings.qwen_guard_history_pairs,
    ...(workspaceGraph === undefined ? {} : {workspaceGraph}),
    ...(options.providerToolView === undefined
      ? {}
      : {providerToolView: options.providerToolView}),
    ...(options.onAudioFrame === undefined ? {} : {onAudioFrame: options.onAudioFrame}),
    ...(options.onAudioClear === undefined ? {} : {onAudioClear: options.onAudioClear}),
    ...(options.onAudioAlert === undefined ? {} : {onAudioAlert: options.onAudioAlert}),
    ...(options.onAudioTerminal === undefined ? {} : {onAudioTerminal: options.onAudioTerminal}),
    ...(options.onSpoken === undefined ? {} : {onSpoken: options.onSpoken}),
    ...(options.onDelivery === undefined ? {} : {onDelivery: options.onDelivery}),
    ...(options.onCaption === undefined ? {} : {onCaption: options.onCaption}),
    ...(options.onCodexState === undefined ? {} : {onCodexState: options.onCodexState}),
    ...(options.onProjectView === undefined ? {} : {onProjectView: options.onProjectView}),
    ...(options.telemetry === undefined ? {} : {telemetry: options.telemetry}),
    ...(options.onDiagnostic === undefined ? {} : {onDiagnostic: options.onDiagnostic}),
    ...(options.projectConfirmation === undefined
      ? {}
      : {projectConfirmation: options.projectConfirmation}),
    ...(options.commitProjectOperation === undefined
      ? {}
      : {commitProjectOperation: options.commitProjectOperation}),
    ...(options.projectExpiryStepTimeoutMs === undefined
      ? {}
      : {projectExpiryStepTimeoutMs: options.projectExpiryStepTimeoutMs}),
    ...(options.codexResource === undefined ? {} : {codexResource: options.codexResource}),
  })
}
