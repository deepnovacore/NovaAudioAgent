/** Integrated realtime selection over closed, host-owned provider factories. */

import {
  ConfigurationError,
  requireIntegratedRealtime,
  type IntegratedProviderName,
  type QwenRealtimeConfig,
} from './config.js'
import {
  buildQwenRealtimeAssembly,
  type BuildQwenRealtimeAssemblyOptions,
} from './qwen-realtime-assembly.js'
import type {RealtimeAssembly} from './realtime-assembly.js'

export type BuildIntegratedRealtimeAssemblyOptions = Omit<
  BuildQwenRealtimeAssemblyOptions,
  'qwenConfig'
>

export interface IntegratedQwenFactoryInput {
  readonly options: BuildIntegratedRealtimeAssemblyOptions
  readonly config: QwenRealtimeConfig
}

export type IntegratedProviderRegistry = Readonly<Record<
  IntegratedProviderName,
  (input: IntegratedQwenFactoryInput) => RealtimeAssembly
>>

export const integratedProviderRegistry: IntegratedProviderRegistry = Object.freeze({
  qwen: input => buildQwenRealtimeAssembly({
    ...input.options,
    qwenConfig: input.config,
  }),
})

export function buildIntegratedRealtimeAssembly(
  options: BuildIntegratedRealtimeAssemblyOptions,
  registry: IntegratedProviderRegistry = integratedProviderRegistry,
): RealtimeAssembly {
  const provider = options.settings.integrated_provider
  if (provider !== 'qwen') {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER 无效')
  }
  const config = Object.freeze({...requireIntegratedRealtime(options.settings)})
  return registry.qwen({options, config})
}
