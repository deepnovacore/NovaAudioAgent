/** Product-level realtime pipeline selector. */

import {
  buildCascadedRealtimeAssembly,
  type BuildCascadedRealtimeAssemblyOptions,
} from './cascaded-realtime-assembly.js'
import {ConfigurationError} from './config.js'
import {codexAgentDescriptor, CodexAgentController} from './executors/index.js'
import {
  buildIntegratedRealtimeAssembly,
  type BuildIntegratedRealtimeAssemblyOptions,
} from './integrated-realtime-assembly.js'
import type {CodingAgentControllerFactory, RealtimeAssembly} from './realtime-assembly.js'

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
  const composition = productionCodingComposition(options)
  if (options.settings.pipeline_mode === 'integrated') {
    return (builders.integrated ?? buildIntegratedRealtimeAssembly)(composition)
  }
  if (options.settings.pipeline_mode === 'cascaded') {
    return (builders.cascaded ?? buildCascadedRealtimeAssembly)(composition)
  }
  throw new ConfigurationError('NOVA_AUDIO_AGENT_PIPELINE_MODE 无效')
}

const productionCodingAgentControllerFactory: CodingAgentControllerFactory = {
  create: context => new CodexAgentController({
    channel: context.channel,
    ...(context.intake === undefined ? {} : {intake: context.intake}),
    ...(context.executor === undefined ? {} : {executor: context.executor}),
    dispatchPort: context.dispatchPort,
    resolveCancelTarget: context.resolveCancelTarget,
  }),
}

function productionCodingComposition(
  options: BuildProductionRealtimeAssemblyOptions,
): BuildProductionRealtimeAssemblyOptions {
  const resource = options.codexResource
  if (resource === undefined) return options
  const descriptor = codexAgentDescriptor(resource.adapter.manifest.name)
  const descriptors = options.agentDescriptors ?? []
  if (descriptors.some(value => value.name === descriptor.name
    || value.ownedChannels.includes(resource.adapter.manifest.name))) {
    throw new ConfigurationError('production coding descriptor cannot be overridden')
  }
  return {
    ...options,
    codingAgentControllerFactory: options.codingAgentControllerFactory ?? productionCodingAgentControllerFactory,
    agentDescriptors: [...descriptors, descriptor],
  }
}
