/** One validated production provider choice above the two reviewed realtime builders. */

import {ConfigurationError} from './config.js'
import {
  buildQwenRealtimeAssembly,
  type BuildQwenRealtimeAssemblyOptions,
} from './qwen-realtime-assembly.js'
import type {RealtimeAssembly} from './realtime-assembly.js'
import {
  buildVolcengineRealtimeAssembly,
  type BuildVolcengineRealtimeAssemblyOptions,
} from './volcengine-realtime-assembly.js'

export type BuildProductionRealtimeAssemblyOptions =
  BuildQwenRealtimeAssemblyOptions & BuildVolcengineRealtimeAssemblyOptions

export interface ProductionRealtimeAssemblyBuilders {
  readonly qwen?: (options: BuildQwenRealtimeAssemblyOptions) => RealtimeAssembly
  readonly volcengine?: (options: BuildVolcengineRealtimeAssemblyOptions) => RealtimeAssembly
}

export function buildProductionRealtimeAssembly(
  options: BuildProductionRealtimeAssemblyOptions,
  builders: ProductionRealtimeAssemblyBuilders = {},
): RealtimeAssembly {
  const qwen = builders.qwen ?? buildQwenRealtimeAssembly
  const volcengine = builders.volcengine ?? buildVolcengineRealtimeAssembly
  if (options.settings.realtime_provider === 'qwen') return qwen(options)
  if (options.settings.realtime_provider === 'volcengine') return volcengine(options)
  throw new ConfigurationError('NOVA_AUDIO_AGENT_REALTIME_PROVIDER 无效')
}
