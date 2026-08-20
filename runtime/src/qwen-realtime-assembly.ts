/** Production Qwen composition above the provider-neutral realtime owner. */

import { buildAssembly, type AssemblyOptions } from './assembly.js'
import { RealClock } from './clock.js'
import { requireQwenRealtime } from './config.js'
import { MonotonicIdFactory } from './ids.js'
import { OpenAIModelGateway } from './model-gateway.js'
import {
  buildRealtimeAssembly,
  type RealtimeAssembly,
  type RealtimeAssemblyOptions,
} from './realtime-assembly.js'
import { QwenAudioRealtimeAdapter, type QwenConnector } from './realtime/qwen.js'
import { webSocketQwenConnector } from './realtime/qwen-transport.js'
import { stripLikePython } from './python-text.js'

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
}

/**
 * Build one Qwen realtime ownership graph without opening a socket.
 *
 * Host settings are resolved before any resource construction. Connection and rollback remain
 * exclusively owned by `RealtimeAssembly.start()`.
 */
export function buildQwenRealtimeAssembly(
  options: BuildQwenRealtimeAssemblyOptions,
): RealtimeAssembly {
  const qwen = requireQwenRealtime(options.settings)
  const clock = options.clock ?? new RealClock()
  const ids = options.ids ?? new MonotonicIdFactory()
  const configuredModelKey = stripLikePython(options.settings.model_api_key ?? '')
  const gateway = new OpenAIModelGateway({
    baseUrl: options.settings.model_base_url,
    apiKey: configuredModelKey || qwen.apiKey,
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
    ...(options.executors === undefined ? {} : {executors: options.executors}),
    ...(options.searchTransport === undefined ? {} : {searchTransport: options.searchTransport}),
    ...(options.frameSource === undefined ? {} : {frameSource: options.frameSource}),
    ...(options.mediaStore === undefined ? {} : {mediaStore: options.mediaStore}),
  })
  const provider = new QwenAudioRealtimeAdapter({
    url: qwen.url,
    apiKey: qwen.apiKey,
    model: qwen.model,
    voice: qwen.voice,
    connector: options.connector ?? webSocketQwenConnector,
    idFactory: () => ids.next('qwen'),
    now: () => clock.now(),
  })
  return buildRealtimeAssembly({
    core,
    provider,
    idFactory: () => ids.next('realtime'),
    controlledGuardReconnect: options.settings.qwen_controlled_guard_reconnect,
    guardHistoryRecovery: options.settings.qwen_guard_history_recovery,
    guardHistoryPairs: options.settings.qwen_guard_history_pairs,
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
  })
}
