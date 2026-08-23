/** Integrated realtime selection over closed, host-owned provider factories. */

import {
  ConfigurationError,
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
import type {RealtimeAssembly} from './realtime-assembly.js'

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
  const provider = options.settings.integrated_provider
  if (provider !== 'qwen') {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER 无效')
  }
  const config = Object.freeze({...requireIntegratedRealtime(options.settings)})
  const clock = options.clock ?? new RealClock()
  const ids = options.ids ?? new MonotonicIdFactory()
  const qwenProvider = registry.qwen({
    config,
    ...(options.connector === undefined ? {} : {connector: options.connector}),
    idFactory: () => ids.next('qwen'),
    now: () => clock.now(),
  })
  return buildQwenRealtimeAssembly({
    ...options,
    clock,
    ids,
    qwenConfig: config,
    qwenProvider,
  })
}
