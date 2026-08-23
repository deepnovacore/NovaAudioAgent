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
import type {RealtimeAssembly} from './realtime-assembly.js'

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
  if (options.settings.pipeline_mode === 'integrated') {
    return (builders.integrated ?? buildIntegratedRealtimeAssembly)(options)
  }
  if (options.settings.pipeline_mode === 'cascaded') {
    return (builders.cascaded ?? buildCascadedRealtimeAssembly)(options)
  }
  throw new ConfigurationError('NOVA_AUDIO_AGENT_PIPELINE_MODE 无效')
}
