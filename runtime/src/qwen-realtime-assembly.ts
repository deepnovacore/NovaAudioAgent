/** Production Qwen composition above the provider-neutral realtime owner. */

import {buildAssembly, type AssemblyOptions} from './assembly.js'
import type {CodingExecutorResource} from './coding-executor.js'
import { RealClock } from './clock.js'
import {
  DASHSCOPE_COMPATIBLE_BASE_URL,
  requireQwenRealtime,
  resolveSupportModelConnection,
  type QwenRealtimeConfig,
} from './config.js'
import { MonotonicIdFactory } from './ids.js'
import { OpenAIModelGateway } from './model-gateway.js'
import {personalMemoryFactory} from './memory/factory.js'
import {
  composeRealtime,
  validateCodingResource,
  filterDisabledCoding,
  defaultIntake,
  type RealtimeAssembly,
  type RealtimeAssemblyOptions,
} from './realtime-assembly.js'
import type {RealtimeProvider} from './realtime/protocol.js'
import { QwenAudioRealtimeAdapter, type QwenConnector } from './realtime/qwen.js'
import { webSocketQwenConnector } from './realtime/qwen-transport.js'

export interface BuildQwenRealtimeAssemblyOptions
  extends Omit<AssemblyOptions, 'gateway'>, Omit<
    RealtimeAssemblyOptions,
    | 'core'
    | 'provider'
    | 'idFactory'
    | 'controlledPreemptiveAlertReconnect'
    | 'preemptiveAlertHistoryRecovery'
    | 'preemptiveAlertHistoryPairs'
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
  readonly codexResource?: CodingExecutorResource
}

/** Narrow provider-only form used by the integrated provider registry. */
export interface BuildQwenRealtimeProviderOptions {
  readonly config: QwenRealtimeConfig
  readonly connector?: QwenConnector
  readonly idFactory: () => string
  readonly now: () => number
  readonly workspaceGraphPolicy: boolean
  readonly executorApproval: boolean
  readonly modules?: {readonly search: boolean; readonly camera: boolean; readonly coding: boolean; readonly knowledge?: boolean}
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
      executorApproval: options.executorApproval,
      ...(options.modules === undefined ? {} : {modules: options.modules}),
    })
  }
  options = filterDisabledCoding(options)
  validateCodingResource(options)
  const qwen = options.qwenConfig ?? requireQwenRealtime(options.settings)
  const createPersonalMemory = options.createPersonalMemory
    ?? personalMemoryFactory(options.settings)
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
    ...options,
    settings: options.settings,
    clock,
    ids,
    gateway: gateway,
    ...((options.executors === undefined && options.codexResource === undefined)
      ? {}
      : {executors: [...(options.executors ?? []), ...(options.codexResource === undefined ? [] : [options.codexResource.adapter])]}),
  })
  const provider = options.qwenProvider ?? buildQwenRealtimeAssembly({
    config: qwen,
    ...(options.connector === undefined ? {} : {connector: options.connector}),
    idFactory: () => ids.next('qwen'),
    now: () => clock.now(),
    modules: {
      search: core.capabilities.modules.search.enabled,
      camera: options.cameraModuleEnabled ?? core.capabilities.modules.camera.enabled,
      coding: core.capabilities.modules.coding.enabled,
      knowledge: core.capabilities.modules.knowledge.enabled,
    },
    workspaceGraphPolicy: options.settings.workspace_graph_enabled,
    executorApproval: options.codexResource?.approvalController !== null
      && options.codexResource?.approvalController !== undefined,
  })
  const intake = options.intake ?? defaultIntake(core, gateway, options.settings)
  return composeRealtime(core, provider, {
    ...options,
    ...(intake === undefined ? {} : {intake}),
    idFactory: () => ids.next('realtime'),
  }, {
    controlledPreemptiveAlertReconnect: options.settings.qwen_controlled_guard_reconnect,
    preemptiveAlertHistoryRecovery: options.settings.qwen_guard_history_recovery,
    preemptiveAlertHistoryPairs: options.settings.qwen_guard_history_pairs,
    ...(createPersonalMemory === undefined ? {} : {createPersonalMemory}),
  })
}
