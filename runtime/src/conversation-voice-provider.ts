import {StreamingAsrClient} from './realtime/cascaded/streaming-asr.js'
import {committedConversationPairsSchema} from './realtime/history.js'
import {cascadedProviderRegistries,type CascadedProviderRegistries} from './composition/cascaded-realtime-assembly.js'
import {BreezeTtsClient} from './realtime/cascaded/http-speech.js'
import {requireSelectedCascadedLlmConfig,resolveEndpointingConfig} from './config/cascaded-realtime-config.js'
import {requireSelectedCascadedRealtimeConfig} from './config/cascaded-realtime-config.js'
import type {buildCascadedTextProvider} from './cascaded-text-provider.js'
import {capabilitiesFromSettings,requireIntegratedRealtime} from './config/config.js'
import {integratedProviderRegistry} from './composition/cascaded-realtime-assembly.js'
import {CascadedRealtimeProvider} from './realtime/cascaded/provider.js'
import type {CascadedRealtimeProviderOptions} from './realtime/cascaded/provider.js'
import {frontendInstructions} from './realtime/frontend-instructions.js'
import type {RealtimeProvider} from './realtime/protocol.js'
import {usageReporterForEndpoint} from './realtime/usage.js'

export type ConversationVoiceProviderOptions=Parameters<typeof buildCascadedTextProvider>[0]&Pick<CascadedRealtimeProviderOptions,'captureFrame'|'prerecall'|'telemetry'>

/** Provider-only voice ownership; the global host chooses which conversation may connect it. */
export function buildCascadedVoiceProvider(options:ConversationVoiceProviderOptions,registry:CascadedProviderRegistries=cascadedProviderRegistries):RealtimeProvider {
  const history=options.history===undefined?undefined:committedConversationPairsSchema.parse(options.history)
  const local=options.settings.local_serving
  const selected=local?undefined:requireSelectedCascadedRealtimeConfig(options.settings),ids={next:options.idFactory}
  const selectedLlm=requireSelectedCascadedLlmConfig(options.settings)
  const capabilities=capabilitiesFromSettings(options.settings)
  const metering=(endpoint:string)=>options.onUsage===undefined?{}:{onUsage:usageReporterForEndpoint(options.onUsage,endpoint)!}
  const instructions=frontendInstructions({search:capabilities.modules.search.enabled,camera:options.captureFrame!==undefined,coding:capabilities.modules.coding.enabled,knowledge:capabilities.modules.knowledge.enabled},options.executorApproval===true)
  const llm=registry.llm[selectedLlm.provider === 'deepseek' ? 'qwen' : selectedLlm.provider]({config:selectedLlm.config,clock:options.clock,ids,instructions,...metering(selectedLlm.config.baseUrl)})
  return new CascadedRealtimeProvider({
    language:options.settings.language,
    endpointingFactory:registry.endpointing.auto({config:selected?.endpointing??resolveEndpointingConfig(options.settings),clock:options.clock}),
    asrFactory:local?{openClient:()=>new StreamingAsrClient(local.asr)}:registry.asr.volcengine({config:selected!.asr,ids,...metering(selected!.asr.endpoint)}),
    ttsFactory:local?{openClient:()=>new BreezeTtsClient(local.tts)}:registry.tts.volcengine({config:selected!.tts,ids,...metering(selected!.tts.endpoint)}),
    llmFactory:{open:()=>llm.open(history===undefined?undefined:{history})},
    idFactory:options.idFactory,
    ...(options.captureFrame===undefined?{}:{captureFrame:options.captureFrame}),
    ...(options.prerecall===undefined?{}:{prerecall:options.prerecall}),
    ...(options.telemetry===undefined?{}:{telemetry:options.telemetry}),
  })
}

export function buildConversationVoiceProvider(options:ConversationVoiceProviderOptions):RealtimeProvider {
  if(options.settings.pipeline_mode==='cascaded')return buildCascadedVoiceProvider(options)
  const capabilities=capabilitiesFromSettings(options.settings)
  return integratedProviderRegistry[options.settings.integrated_provider]({
    language:options.settings.language,config:requireIntegratedRealtime(options.settings),idFactory:options.idFactory,now:()=>options.clock.now(),
    executorApproval:options.executorApproval===true,
    modules:{search:capabilities.modules.search.enabled,camera:false,coding:capabilities.modules.coding.enabled,knowledge:capabilities.modules.knowledge.enabled},
    ...(options.onUsage===undefined?{}:{onUsage:options.onUsage}),
    ...(options.history===undefined?{}:{history:options.history}),
  })
}
