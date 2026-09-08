/** Integrated realtime selection over closed, host-owned provider factories. */

import {
  ConfigurationError,
  capabilitiesFromSettings,
  requireIntegratedRealtime,
  type IntegratedProviderName,
} from './config.js'
import {RealClock} from './clock.js'
import {MonotonicIdFactory} from './ids.js'
import {
  buildQwenRealtimeAssembly,
  type BuildQwenRealtimeAssemblyOptions,
  type BuildQwenRealtimeProviderOptions,
} from './qwen-realtime-assembly.js'
import type {RealtimeProvider} from './realtime/protocol.js'
import {filterDisabledCoding, type RealtimeAssembly} from './realtime-assembly.js'

export type BuildIntegratedRealtimeAssemblyOptions = Omit<
  BuildQwenRealtimeAssemblyOptions,
  'qwenConfig' | 'qwenProvider'
>

export type IntegratedQwenFactoryInput = BuildQwenRealtimeProviderOptions

export type IntegratedProviderRegistry = Readonly<Record<
  IntegratedProviderName,
  (input: IntegratedQwenFactoryInput) => RealtimeProvider
>>

export const integratedProviderRegistry: IntegratedProviderRegistry = Object.freeze({
  qwen: input => buildQwenRealtimeAssembly(input),
})

export function buildIntegratedRealtimeAssembly(
  options: BuildIntegratedRealtimeAssemblyOptions,
  registry: IntegratedProviderRegistry = integratedProviderRegistry,
): RealtimeAssembly {
  options = filterDisabledCoding(options)
  const provider = options.settings.integrated_provider
  if (!Object.hasOwn(registry, provider)) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER 无效')
  }
  const config = Object.freeze({...requireIntegratedRealtime(options.settings)})
  const clock = options.clock ?? new RealClock()
  const ids = options.ids ?? new MonotonicIdFactory()
  const capabilities = options.capabilities ?? capabilitiesFromSettings(options.settings)
  const qwenProvider = registry[provider]({
    ...(options.onUsage === undefined ? {} : {onUsage: options.onUsage}),
    config,
    ...(options.connector === undefined ? {} : {connector: options.connector}),
    idFactory: () => ids.next('qwen'),
    now: () => clock.now(),
    modules: {
      search: capabilities.modules.search.enabled,
      camera: options.cameraModuleEnabled ?? capabilities.modules.camera.enabled,
      coding: capabilities.modules.coding.enabled,
      knowledge: capabilities.modules.knowledge.enabled,
    },
    workspaceGraphPolicy: options.settings.workspace_graph_enabled,
    executorApproval: (options.executorApproval ?? options.codexResource?.approvalController) != null,
  })
  return buildQwenRealtimeAssembly({
    ...options,
    clock,
    ids,
    qwenConfig: config,
    qwenProvider,
  })
}
