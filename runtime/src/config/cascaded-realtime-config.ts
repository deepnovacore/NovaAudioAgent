/** Pure normalization and validation for one selected cascaded provider graph. */

import {
  ConfigurationError,
  DASHSCOPE_COMPATIBLE_BASE_URL,
  requireCascadedCredentials,
  resolveCascadedSelection,
  type CascadedSelection,
  type Settings,
} from './config.js'
import {stripLikePython} from '../text/python-text.js'

export {DASHSCOPE_COMPATIBLE_BASE_URL} from './config.js'

export interface AutoEndpointingConfig {
  readonly vadThreshold: number
  readonly vadPreRollMs: number
  readonly vadMinSpeechMs: number
  readonly vadSilenceEndMs: number
  readonly vadSpeechPadMs: number
  readonly vadMaxUtteranceMs: number
}

export interface VolcengineAsrConfig {
  readonly endpoint: string
  readonly resourceId: string
  readonly apiKey: string
  readonly voiceprintHealthUrl?: string
  readonly voiceprint?: {readonly id: string; readonly name: string}
  readonly chunkMs: number
}

export interface QwenCascadedLlmConfig {
  readonly provider?: 'qwen' | 'deepseek' | 'openai-compatible'
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
}

export interface ArkCascadedLlmConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
}

export interface VolcengineTtsConfig {
  readonly endpoint: string
  readonly resourceId: string
  readonly voice: string
  readonly apiKey: string
  readonly outputSampleRate: 24_000
}

export type SelectedCascadedLlmConfig =
  | {readonly provider: 'qwen' | 'deepseek'; readonly config: QwenCascadedLlmConfig}
  | {readonly provider: 'ark'; readonly config: ArkCascadedLlmConfig}

export interface SelectedCascadedRealtimeConfig {
  readonly selection: CascadedSelection
  readonly endpointing: AutoEndpointingConfig
  readonly asr: VolcengineAsrConfig
  readonly llm: SelectedCascadedLlmConfig
  readonly tts: VolcengineTtsConfig
}

export function requireSelectedCascadedRealtimeConfig(
  settings: Settings,
): SelectedCascadedRealtimeConfig {
  const selection = resolveCascadedSelection(settings)
  const credentials = requireCascadedCredentials(settings, selection)
  const endpointing = resolveEndpointingConfig(settings)
  const asr = resolveAsrConfig(settings, credentials.asrApiKey)
  const llm = requireSelectedCascadedLlmConfig(settings)
  const tts = resolveTtsConfig(settings, credentials.ttsApiKey)
  return Object.freeze({selection, endpointing, asr, llm, tts})
}

/** Text sessions require only their selected LLM, independent of speech configuration. */
export function requireSelectedCascadedLlmConfig(settings:Settings):SelectedCascadedLlmConfig {
  if(settings.local_serving)return {provider:'qwen',config:{...settings.local_serving.llm,provider:'openai-compatible'}}
  const selection=resolveCascadedSelection(settings)
  const apiKey=stripLikePython((selection.llmProvider==='qwen'?settings.dashscope_api_key:selection.llmProvider==='deepseek'?settings.deepseek_api_key:settings.ark_api_key)??'')
  if(!apiKey)throw new ConfigurationError(`缺少 ${selection.llmProvider==='qwen'?'DASHSCOPE_API_KEY':selection.llmProvider==='deepseek'?'DEEPSEEK_API_KEY':'ARK_API_KEY'}`)
  return selection.llmProvider !== 'ark'
    ? Object.freeze({
      provider: selection.llmProvider,
      config: Object.freeze({
        baseUrl: selection.llmProvider === 'deepseek' ? 'https://api.deepseek.com' : DASHSCOPE_COMPATIBLE_BASE_URL,
        ...(selection.llmProvider === 'deepseek' ? {provider: 'deepseek' as const} : {}),
        apiKey: apiKey,
        model: selection.llmModel,
      }),
    })
    : Object.freeze({
      provider: 'ark' as const,
      config: Object.freeze({
        baseUrl: secureEndpoint(
          settings.volcengine_ark_base_url,
          'https',
          'NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL',
        ),
        apiKey: apiKey,
        model: selection.llmModel,
      }),
    })
}

export function resolveEndpointingConfig(settings: Settings): AutoEndpointingConfig {
  if (!(settings.volcengine_vad_threshold > 0 && settings.volcengine_vad_threshold <= 1)) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_VOLCENGINE_VAD_THRESHOLD 必须在 (0, 1] 内')
  }
  if (settings.volcengine_vad_pre_roll_ms < 0 || settings.volcengine_vad_speech_pad_ms < 0) {
    throw new ConfigurationError('火山 VAD pre-roll 与 speech pad 不能为负数')
  }
  if (settings.volcengine_vad_min_speech_ms <= 0 || settings.volcengine_vad_silence_end_ms <= 0) {
    throw new ConfigurationError('火山 VAD min speech 与 silence end 必须为正整数')
  }
  if (settings.volcengine_vad_max_utterance_ms < settings.volcengine_vad_min_speech_ms) {
    throw new ConfigurationError('火山 VAD max utterance 不能短于 min speech')
  }
  return Object.freeze({
    vadThreshold: settings.volcengine_vad_threshold,
    vadPreRollMs: settings.volcengine_vad_pre_roll_ms,
    vadMinSpeechMs: settings.volcengine_vad_min_speech_ms,
    vadSilenceEndMs: settings.volcengine_vad_silence_end_ms,
    vadSpeechPadMs: settings.volcengine_vad_speech_pad_ms,
    vadMaxUtteranceMs: settings.volcengine_vad_max_utterance_ms,
  })
}

export function requireSelectedCascadedAsrConfig(settings:Settings):VolcengineAsrConfig {
  const key=stripLikePython(settings.doubao_asr_api_key??'')||stripLikePython(settings.doubao_bigmodel_api_key??'')
  if(!key)throw new ConfigurationError('缺少 DOUBAO_ASR_API_KEY')
  return resolveAsrConfig(settings,key)
}

function resolveAsrConfig(settings: Settings, apiKey: string): VolcengineAsrConfig {
  if (settings.doubao_asr_chunk_ms <= 0) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_DOUBAO_ASR_CHUNK_MS 必须为正整数')
  }
  const voiceprint = settings.doubao_asr_voiceprint_enabled
    ? {id: settings.doubao_asr_voiceprint_id, name: settings.doubao_asr_voiceprint_name} : undefined
  if (voiceprint && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(voiceprint.id)
    || !voiceprint.name.trim() || /^\d+$/.test(voiceprint.name)
    || voiceprint.name.length > 128 || /[\u0000-\u001f\u007f]/.test(voiceprint.name))) {
    throw new ConfigurationError('请先注册有效声纹，再开启火山 ASR 声纹验证')
  }
  return Object.freeze({
    ...(voiceprint ? {voiceprint} : {}),
    ...(settings.doubao_asr_voiceprint_health_url ? {voiceprintHealthUrl:secureEndpoint(settings.doubao_asr_voiceprint_health_url, 'https', 'NOVA_AUDIO_AGENT_DOUBAO_ASR_VOICEPRINT_HEALTH_URL')} : {}),
    endpoint: secureEndpoint(
      settings.doubao_asr_endpoint,
      'wss',
      'NOVA_AUDIO_AGENT_DOUBAO_ASR_ENDPOINT',
    ),
    resourceId: requiredSetting(
      settings.doubao_asr_resource_id,
      'NOVA_AUDIO_AGENT_DOUBAO_ASR_RESOURCE_ID',
    ),
    apiKey,
    chunkMs: settings.doubao_asr_chunk_ms,
  })
}

function resolveTtsConfig(settings: Settings, apiKey: string): VolcengineTtsConfig {
  if (settings.doubao_tts_output_sample_rate !== 24_000) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_DOUBAO_TTS_OUTPUT_SAMPLE_RATE 必须为 24000')
  }
  return Object.freeze({
    endpoint: secureEndpoint(
      settings.doubao_tts_endpoint,
      'wss',
      'NOVA_AUDIO_AGENT_DOUBAO_TTS_ENDPOINT',
    ),
    resourceId: requiredSetting(
      settings.doubao_tts_resource_id,
      'NOVA_AUDIO_AGENT_DOUBAO_TTS_RESOURCE_ID',
    ),
    voice: requiredSetting(settings.doubao_tts_voice, 'NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE'),
    apiKey,
    outputSampleRate: 24_000,
  })
}

function requiredSetting(value: string, name: string): string {
  const normalized = stripLikePython(value)
  if (normalized === '') throw new ConfigurationError(`${name} 不能为空`)
  return normalized
}

function secureEndpoint(value: string, scheme: 'https' | 'wss', name: string): string {
  let normalized = stripLikePython(value)
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  const separator = normalized.indexOf('://')
  const tail = separator < 0 ? '' : normalized.slice(separator + 3)
  const end = tail.search(/[/?#]/u)
  const authority = end < 0 ? tail : tail.slice(0, end)
  let parsed: URL | null = null
  try { parsed = new URL(normalized) } catch { /* stable field-only error below */ }
  const valid = parsed?.protocol === `${scheme}:` && parsed.hostname !== ''
    && !authority.includes('@') && parsed.username === '' && parsed.password === ''
    && parsed.hash === ''
  if (!valid) throw new ConfigurationError(`${name} 必须是安全的 ${scheme}:// 地址`)
  return normalized
}

/** Validate the selected graph without requiring credentials for unselected cloud services. */
export function validateSelectedCascadedRealtimeConfig(settings:Settings):void {
  if(settings.local_serving){resolveEndpointingConfig(settings);requireSelectedCascadedLlmConfig(settings);return}
  requireSelectedCascadedRealtimeConfig(settings)
}
