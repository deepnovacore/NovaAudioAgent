import {cascadedProviderRegistries,type CascadedProviderRegistries} from './composition/cascaded-realtime-assembly.js'
import {requireSelectedCascadedLlmConfig} from './config/cascaded-realtime-config.js'
import {capabilitiesFromSettings,type Settings} from './config/config.js'
import type {Clock} from './core/clock.js'
import {CascadedRealtimeAdapter,type CascadedRealtimeAdapterOptions} from './realtime/cascaded/adapter.js'
import {frontendInstructions} from './realtime/frontend-instructions.js'
import type {CommittedConversationPair} from './realtime/history.js'
import type {RealtimeProvider} from './realtime/protocol.js'
import {usageReporterForEndpoint,type UsageReporter} from './realtime/usage.js'

/** One independent text conversation. Construct no endpointing, recognition, or synthesis nodes. */
export function buildCascadedTextProvider(options:{
  readonly settings:Settings
  readonly clock:Clock
  readonly idFactory:()=>string
  readonly onUsage?:UsageReporter
  readonly history?:readonly CommittedConversationPair[]
  readonly executorApproval?:boolean
}&Pick<CascadedRealtimeAdapterOptions,'prerecall'|'captureFrame'|'telemetry'>,registry:CascadedProviderRegistries=cascadedProviderRegistries):RealtimeProvider {
  const selected=requireSelectedCascadedLlmConfig(options.settings)
  const capabilities=capabilitiesFromSettings(options.settings)
  const input={config:selected.config,clock:options.clock,ids:{next:options.idFactory},instructions:frontendInstructions({
    search:capabilities.modules.search.enabled,camera:options.captureFrame!==undefined,coding:capabilities.modules.coding.enabled,knowledge:capabilities.modules.knowledge.enabled,
  },options.executorApproval===true),...(options.onUsage===undefined?{}:{onUsage:usageReporterForEndpoint(options.onUsage,selected.config.baseUrl)!})}
  const factory=registry.llm[selected.provider === 'ark' ? 'ark' : 'qwen'](input)
  return new CascadedRealtimeAdapter({language:options.settings.language,textOnly:true,llm:factory.open(),llmFactory:factory,idFactory:options.idFactory,...(options.prerecall===undefined?{}:{prerecall:options.prerecall}),...(options.captureFrame===undefined?{}:{captureFrame:options.captureFrame}),...(options.telemetry===undefined?{}:{telemetry:options.telemetry}),...(options.history===undefined?{}:{history:options.history})})
}
