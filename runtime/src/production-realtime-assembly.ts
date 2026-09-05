/** Product-level realtime pipeline selector. */

import {
  buildCascadedRealtimeAssembly,
  type BuildCascadedRealtimeAssemblyOptions,
} from './cascaded-realtime-assembly.js'
import {ConfigurationError} from './config.js'
import {
  buildIntegratedRealtimeAssembly,
  type BuildIntegratedRealtimeAssemblyOptions,
} from './integrated-realtime-assembly.js'
import {filterDisabledCoding, type RealtimeAssembly} from './realtime-assembly.js'

export type BuildProductionRealtimeAssemblyOptions =
  BuildIntegratedRealtimeAssemblyOptions & BuildCascadedRealtimeAssemblyOptions

export interface ProductionRealtimeAssemblyBuilders {
  readonly integrated?: (
    options: BuildIntegratedRealtimeAssemblyOptions,
  ) => RealtimeAssembly
  readonly cascaded?: (
    options: BuildCascadedRealtimeAssemblyOptions,
  ) => RealtimeAssembly
}

export function buildProductionRealtimeAssembly(
  options: BuildProductionRealtimeAssemblyOptions,
  builders: ProductionRealtimeAssemblyBuilders = {},
): RealtimeAssembly {
  const composition = productionCodingComposition(filterDisabledCoding(options))
  if (options.settings.pipeline_mode === 'integrated') {
    return (builders.integrated ?? buildIntegratedRealtimeAssembly)(composition)
  }
  if (options.settings.pipeline_mode === 'cascaded') {
    return (builders.cascaded ?? buildCascadedRealtimeAssembly)(composition)
  }
  throw new ConfigurationError('NOVA_AUDIO_AGENT_PIPELINE_MODE 无效')
}

function productionCodingComposition(
  options: BuildProductionRealtimeAssemblyOptions,
): BuildProductionRealtimeAssemblyOptions {
  const resource = options.codexResource
  if (resource === undefined) return options
  const descriptor = resource.agentDescriptor
  if (descriptor === undefined) throw new ConfigurationError('coding resource must supply its agent descriptor')
  const descriptors = options.agentDescriptors ?? []
  if (descriptors.some(value => value.name === descriptor.name
    || value.ownedChannels.includes(resource.adapter.manifest.name))) {
    throw new ConfigurationError('production coding descriptor cannot be overridden')
  }
  const factory = options.codingAgentControllerFactory ?? resource.agentControllerFactory
  if (factory === undefined) throw new ConfigurationError('coding resource must supply its agent controller factory')
  return {
    ...options,
    codingAgentControllerFactory: factory,
    agentDescriptors: [...descriptors, descriptor],
  }
}
