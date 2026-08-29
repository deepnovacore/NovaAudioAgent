import { z } from 'zod'
import { stripLikePython } from './python-text.js'
import {findRetiredConfiguration} from './environment-contract.js'

export const proactivityPresetSchema = z.enum(['conservative', 'balanced', 'eager'])
const pipelineModeSchema = z.enum(['integrated', 'cascaded'])
const integratedProviderNameSchema = z.enum(['qwen'])
const cascadedEndpointingProviderNameSchema = z.enum(['auto'])
const cascadedAsrProviderNameSchema = z.enum(['volcengine'])
const cascadedLlmProviderNameSchema = z.enum(['qwen', 'ark'])
const cascadedTtsProviderNameSchema = z.enum(['volcengine'])
const qwenGuardHistoryRecoverySchema = z.enum(['none', 'packed'])
const qwenGuardHistoryPairsSchema = z.union([z.literal(1), z.literal(2), z.literal(4)])
const executorNameSchema = z.enum(['fast_sim', 'slow_sim', 'codex'])
const volcFloatSchema = z.custom<number>(value => typeof value === 'number')
const loopbackUrlSchema = z.string().url().refine(value => {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === '127.0.0.1'
        || parsed.hostname === '::1'
        || parsed.hostname === '[::1]'
        || parsed.hostname === 'localhost')
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
  } catch {
    return false
  }
}, 'provider endpoint must be loopback-only')

export const DASHSCOPE_COMPATIBLE_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1'

export const settingsSchema = z.object({
  model_base_url: z.url().default(DASHSCOPE_COMPATIBLE_BASE_URL),
  model_api_key: z.string().nullable().default(null),
  tavily_api_key: z.string().nullable().default(null),
  fast_model: z.string().default('qwen3-vl-plus'),
  watch_model: z.string().nullable().default(null),
  surrogate_model: z.string().default('qwen-flash'),
  compressor_model: z.string().default('qwen-flash'),
  pipeline_mode: pipelineModeSchema.default('integrated'),
  integrated_provider: integratedProviderNameSchema.default('qwen'),
  cascade_endpointing_provider: cascadedEndpointingProviderNameSchema.default('auto'),
  cascade_asr_provider: cascadedAsrProviderNameSchema.default('volcengine'),
  cascade_llm_provider: cascadedLlmProviderNameSchema.default('qwen'),
  cascade_llm_model: z.string().nullable().default(null),
  cascade_tts_provider: cascadedTtsProviderNameSchema.default('volcengine'),
  qwen_realtime_url: z.string().default('wss://dashscope.aliyuncs.com/api-ws/v1/realtime'),
  qwen_realtime_model: z.string().default('qwen-audio-3.0-realtime-plus'),
  qwen_realtime_voice: z.string().default('longanqian'),
  dashscope_api_key: z.string().nullable().default(null),
  ark_api_key: z.string().nullable().default(null),
  doubao_asr_api_key: z.string().nullable().default(null),
  doubao_bigmodel_api_key: z.string().nullable().default(null),
  volcengine_ark_base_url: z.string().default('https://ark.cn-beijing.volces.com/api/v3'),
  volcengine_ark_model: z.string().default('doubao-seed-2-0-pro-260215'),
  volcengine_ark_support_model: z.string().default('doubao-seed-2-0-pro-260215'),
  doubao_asr_endpoint: z.string().default(
    'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
  ),
  doubao_asr_resource_id: z.string().default('volc.seedasr.sauc.duration'),
  doubao_asr_chunk_ms: z.number().int().default(200),
  doubao_tts_endpoint: z.string().default(
    'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
  ),
  doubao_tts_resource_id: z.string().default('seed-tts-2.0'),
  doubao_tts_voice: z.string().default('zh_female_vv_uranus_bigtts'),
  doubao_tts_output_sample_rate: z.number().int().default(24_000),
  volcengine_vad_threshold: volcFloatSchema.default(0.5),
  volcengine_vad_pre_roll_ms: z.number().int().default(260),
  volcengine_vad_min_speech_ms: z.number().int().default(250),
  volcengine_vad_silence_end_ms: z.number().int().default(560),
  volcengine_vad_speech_pad_ms: z.number().int().default(30),
  volcengine_vad_max_utterance_ms: z.number().int().default(15_000),
  qwen_controlled_guard_reconnect: z.boolean().default(false),
  qwen_guard_history_recovery: qwenGuardHistoryRecoverySchema.default('none'),
  qwen_guard_history_pairs: qwenGuardHistoryPairsSchema.default(4),
  executor: executorNameSchema.default('fast_sim'),
  executors: z.array(executorNameSchema).min(1),
  codex_workspace: z.string().nullable().default(null),
  codex_bin: z.string().default('codex'),
  codex_prefix_args: z.array(z.string().min(1).max(32_768)).max(1).default([]),
  codex_api_key: z.string().nullable().default(null),
  codex_prewarm: z.boolean().default(true),
  codex_managed_root: z.string().default('~/.nova-audio-agent/workspaces'),
  codex_project_state_root: z.string().default('~/.nova-audio-agent'),
  proactivity_preset: proactivityPresetSchema.default('balanced'),
  codex_working_interval: z.number().finite().min(5).max(600).default(30),
  suggestion_cooldown: z.number().finite().nonnegative().nullable().default(null),
  fresh_window: z.number().finite().nonnegative().nullable().default(null),
  workspace_graph_enabled: z.boolean().default(false),
  workspace_graph_path: z.string().min(1).default('~/.nova-audio-agent/workspace-graph.sqlite'),
  mycontext_provider_url: loopbackUrlSchema.nullable().default(null),
}).strict()

export type Settings = z.infer<typeof settingsSchema>
export type PipelineMode = z.infer<typeof pipelineModeSchema>
export type IntegratedProviderName = z.infer<typeof integratedProviderNameSchema>
export type CascadedEndpointingProviderName = z.infer<typeof cascadedEndpointingProviderNameSchema>
export type CascadedAsrProviderName = z.infer<typeof cascadedAsrProviderNameSchema>
export type CascadedLlmProviderName = z.infer<typeof cascadedLlmProviderNameSchema>
export type CascadedTtsProviderName = z.infer<typeof cascadedTtsProviderNameSchema>

export interface QwenRealtimeConfig {
  readonly url: string
  readonly model: string
  readonly voice: string
  readonly apiKey: string
}

export interface VolcengineRealtimeConfig {
  readonly arkBaseUrl: string
  readonly arkModel: string
  readonly arkSupportModel: string
  readonly arkApiKey: string
  readonly asrEndpoint: string
  readonly asrResourceId: string
  readonly asrApiKey: string
  readonly asrChunkMs: number
  readonly ttsEndpoint: string
  readonly ttsResourceId: string
  readonly ttsVoice: string
  readonly ttsApiKey: string
  readonly ttsOutputSampleRate: 24_000
  readonly vadThreshold: number
  readonly vadPreRollMs: number
  readonly vadMinSpeechMs: number
  readonly vadSilenceEndMs: number
  readonly vadSpeechPadMs: number
  readonly vadMaxUtteranceMs: number
}

export interface CascadedSelection {
  readonly endpointingProvider: 'auto'
  readonly asrProvider: 'volcengine'
  readonly llmProvider: 'qwen' | 'ark'
  readonly llmModel: string
  readonly ttsProvider: 'volcengine'
}

export interface CascadedCredentials {
  readonly llmApiKey: string
  readonly asrApiKey: string
  readonly ttsApiKey: string
}

export interface SupportModelConnection {
  readonly source: 'generic' | 'selected_provider'
  readonly baseUrl: string
  readonly apiKey: string
}

export interface ProactivityParams {
  readonly cooldown: number
  readonly fresh_window: number
}

export type ProactivityPreset = z.infer<typeof proactivityPresetSchema>

const proactivityPresets: Readonly<Record<Settings['proactivity_preset'], ProactivityParams>> = {
  conservative: {cooldown: 120, fresh_window: 20},
  balanced: {cooldown: 60, fresh_window: 30},
  eager: {cooldown: 30, fresh_window: 45},
}

export type ConfigurationErrorCode =
  | 'invalid_configuration'
  | 'retired_capability'
  | 'retired_configuration'

export class ConfigurationError extends Error {
  readonly fields: readonly string[] | undefined

  constructor(
    message: string,
    readonly code: ConfigurationErrorCode = 'invalid_configuration',
    fields?: readonly string[],
  ) {
    super(message)
    this.name = 'ConfigurationError'
    this.fields = fields === undefined ? undefined : Object.freeze([...fields])
  }
}

export function loadSettings(environment: NodeJS.ProcessEnv = process.env): Settings {
  const retired = findRetiredConfiguration(environment)
  if (retired !== null) {
    if (retired.fields.length === 0) {
      throw new ConfigurationError(
        `executor '${retired.capability}' was removed from the Node runtime`,
        'retired_capability',
      )
    }
    throw new ConfigurationError(
      `retired capability '${retired.capability}' configuration is not supported: ${retired.fields.join(', ')}`,
      'retired_configuration',
      retired.fields,
    )
  }
  const pipelineMode = parsePipelineMode(environment.NOVA_AUDIO_AGENT_PIPELINE_MODE)
  const integratedProvider = pipelineMode === 'integrated'
    ? parseIntegratedProvider(environment.NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER)
    : undefined
  const cascadedProviders = pipelineMode === 'cascaded'
    ? {
      endpointing: parseCascadedEndpointingProvider(
        environment.NOVA_AUDIO_AGENT_CASCADE_ENDPOINTING_PROVIDER,
      ),
      asr: parseCascadedAsrProvider(environment.NOVA_AUDIO_AGENT_CASCADE_ASR_PROVIDER),
      llm: parseCascadedLlmProvider(environment.NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER),
      tts: parseCascadedTtsProvider(environment.NOVA_AUDIO_AGENT_CASCADE_TTS_PROVIDER),
    }
    : undefined
  const configuredExecutor = optionalString(environment.NOVA_AUDIO_AGENT_EXECUTOR)
  const executor = configuredExecutor === undefined || configuredExecutor === ''
    ? 'fast_sim'
    : configuredExecutor
  const executors = parseExecutors(environment.NOVA_AUDIO_AGENT_EXECUTORS, executor)
  const codexSelected = executors.includes('codex')
  const candidate = {
    model_base_url: optionalString(environment.NOVA_AUDIO_AGENT_MODEL_BASE_URL),
    model_api_key: optionalSecret(environment.NOVA_AUDIO_AGENT_MODEL_API_KEY),
    tavily_api_key: optionalSecret(environment.TAVILY_API_KEY),
    fast_model: rawEnvironmentValue(environment.NOVA_AUDIO_AGENT_FAST_MODEL),
    watch_model: rawEnvironmentValue(environment.NOVA_AUDIO_AGENT_WATCH_MODEL),
    surrogate_model: rawEnvironmentValue(environment.NOVA_AUDIO_AGENT_SURROGATE_MODEL),
    compressor_model: rawEnvironmentValue(environment.NOVA_AUDIO_AGENT_COMPRESSOR_MODEL),
    pipeline_mode: pipelineMode,
    ...(pipelineMode === 'integrated' ? {
      integrated_provider: integratedProvider,
      qwen_realtime_url: optionalString(environment.NOVA_AUDIO_AGENT_QWEN_REALTIME_URL),
      qwen_realtime_model: optionalString(environment.NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL),
      qwen_realtime_voice: optionalString(environment.NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE),
      dashscope_api_key: optionalSecret(environment.DASHSCOPE_API_KEY),
      qwen_controlled_guard_reconnect: optionalBoolean(
        environment.NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT,
      ),
      qwen_guard_history_recovery: environment.NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_RECOVERY,
      qwen_guard_history_pairs: optionalQwenGuardHistoryPairs(
        environment.NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS,
      ),
    } : {
      cascade_endpointing_provider: cascadedProviders!.endpointing,
      cascade_asr_provider: cascadedProviders!.asr,
      cascade_llm_provider: cascadedProviders!.llm,
      cascade_llm_model: rawEnvironmentValue(environment.NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL),
      cascade_tts_provider: cascadedProviders!.tts,
      ...(cascadedProviders!.llm === 'qwen'
        ? {dashscope_api_key: optionalSecret(environment.DASHSCOPE_API_KEY)}
        : {ark_api_key: optionalSecret(environment.ARK_API_KEY)}),
      ...(cascadedProviders!.llm === 'ark' ? {
        volcengine_ark_base_url: rawEnvironmentValue(
          environment.NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL,
        ),
      } : {}),
      doubao_asr_api_key: optionalSecret(environment.DOUBAO_ASR_API_KEY),
      doubao_bigmodel_api_key: optionalSecret(environment.DOUBAO_BIGMODEL_API_KEY),
      doubao_asr_endpoint: rawEnvironmentValue(environment.NOVA_AUDIO_AGENT_DOUBAO_ASR_ENDPOINT),
      doubao_asr_resource_id: rawEnvironmentValue(
        environment.NOVA_AUDIO_AGENT_DOUBAO_ASR_RESOURCE_ID,
      ),
      doubao_asr_chunk_ms: optionalPydanticInteger(
        environment.NOVA_AUDIO_AGENT_DOUBAO_ASR_CHUNK_MS,
      ),
      doubao_tts_endpoint: rawEnvironmentValue(environment.NOVA_AUDIO_AGENT_DOUBAO_TTS_ENDPOINT),
      doubao_tts_resource_id: rawEnvironmentValue(
        environment.NOVA_AUDIO_AGENT_DOUBAO_TTS_RESOURCE_ID,
      ),
      doubao_tts_voice: rawEnvironmentValue(environment.NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE),
      doubao_tts_output_sample_rate: optionalPydanticInteger(
        environment.NOVA_AUDIO_AGENT_DOUBAO_TTS_OUTPUT_SAMPLE_RATE,
      ),
      volcengine_vad_threshold: optionalPydanticFloat(
        environment.NOVA_AUDIO_AGENT_VOLCENGINE_VAD_THRESHOLD,
      ),
      volcengine_vad_pre_roll_ms: optionalPydanticInteger(
        environment.NOVA_AUDIO_AGENT_VOLCENGINE_VAD_PRE_ROLL_MS,
      ),
      volcengine_vad_min_speech_ms: optionalPydanticInteger(
        environment.NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MIN_SPEECH_MS,
      ),
      volcengine_vad_silence_end_ms: optionalPydanticInteger(
        environment.NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SILENCE_END_MS,
      ),
      volcengine_vad_speech_pad_ms: optionalPydanticInteger(
        environment.NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SPEECH_PAD_MS,
      ),
      volcengine_vad_max_utterance_ms: optionalPydanticInteger(
        environment.NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MAX_UTTERANCE_MS,
      ),
    }),
    executor,
    executors,
    ...(codexSelected ? {
      codex_workspace: optionalSecret(environment.NOVA_AUDIO_AGENT_CODEX_WORKSPACE),
      codex_bin: optionalString(environment.NOVA_AUDIO_AGENT_CODEX_BIN),
      codex_prefix_args: optionalJsonStringArray(
        environment.NOVA_AUDIO_AGENT_CODEX_PREFIX_ARGS,
      ),
      codex_api_key: optionalSecret(environment.NOVA_AUDIO_AGENT_CODEX_API_KEY),
      codex_prewarm: optionalBoolean(environment.NOVA_AUDIO_AGENT_CODEX_PREWARM),
      codex_managed_root: optionalString(environment.NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT),
      codex_project_state_root: optionalString(
        environment.NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT,
      ),
    } : {}),
    proactivity_preset: optionalString(environment.NOVA_AUDIO_AGENT_PROACTIVITY_PRESET),
    codex_working_interval: optionalPydanticFloat(
      environment.NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL,
    ),
    suggestion_cooldown: optionalPydanticFloat(
      environment.NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN,
    ),
    fresh_window: optionalPydanticFloat(environment.NOVA_AUDIO_AGENT_FRESH_WINDOW),
    workspace_graph_enabled: optionalBoolean(
      environment.NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED,
    ),
    workspace_graph_path: optionalString(environment.NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH),
    mycontext_provider_url: optionalSecret(
      environment.NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL,
    ),
  }
  const withoutUndefined = Object.fromEntries(
    Object.entries(candidate).filter(([, value]) => value !== undefined),
  )
  const result = settingsSchema.safeParse(withoutUndefined)
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map(issue => String(issue.path[0] ?? 'settings')))]
      .sort(compareStrings)
      .map(configurationFieldName)
    throw new ConfigurationError(`invalid configuration: ${fields.join(', ')}`)
  }
  return result.data
}

export function resolveProactivity(settings: Settings): ProactivityParams {
  const preset = resolveProactivityPreset(settings.proactivity_preset)
  return {
    cooldown: settings.suggestion_cooldown ?? preset.cooldown,
    fresh_window: settings.fresh_window ?? preset.fresh_window,
  }
}

export function resolveProactivityPreset(preset: ProactivityPreset): ProactivityParams {
  return proactivityPresets[preset]
}

export function requireQwenRealtime(settings: Settings): QwenRealtimeConfig {
  const url = stripLikePython(settings.qwen_realtime_url)
  const model = stripLikePython(settings.qwen_realtime_model)
  const voice = stripLikePython(settings.qwen_realtime_voice)
  if (!url.startsWith('wss://')) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_QWEN_REALTIME_URL 必须使用 wss://')
  }
  if (model === '') {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL 不能为空')
  }
  if (voice === '') {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE 不能为空')
  }
  const realtimeKey = stripLikePython(settings.dashscope_api_key ?? '')
  const modelKey = stripLikePython(settings.model_api_key ?? '')
  const apiKey = realtimeKey || modelKey
  if (apiKey === '') {
    throw new ConfigurationError('缺少 DASHSCOPE_API_KEY 或 NOVA_AUDIO_AGENT_MODEL_API_KEY')
  }
  return {url, model, voice, apiKey}
}

export function requireIntegratedRealtime(settings: Settings): QwenRealtimeConfig {
  const url = secureEndpoint(
    settings.qwen_realtime_url,
    'wss',
    'NOVA_AUDIO_AGENT_QWEN_REALTIME_URL',
  )
  const model = stripLikePython(settings.qwen_realtime_model)
  const voice = stripLikePython(settings.qwen_realtime_voice)
  if (model === '') {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL 不能为空')
  }
  if (voice === '') {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE 不能为空')
  }
  const explicitKey = stripLikePython(settings.dashscope_api_key ?? '')
  const compatibleGenericKey = settings.model_base_url === DASHSCOPE_COMPATIBLE_BASE_URL
    ? stripLikePython(settings.model_api_key ?? '')
    : ''
  const apiKey = explicitKey || compatibleGenericKey
  if (apiKey === '') {
    throw new ConfigurationError('缺少 DASHSCOPE_API_KEY')
  }
  return Object.freeze({url, model, voice, apiKey})
}

/** Keeps a selected provider credential on its fixed compatible endpoint. */
export function resolveSupportModelConnection(
  settings: Settings,
  selectedProvider: {readonly baseUrl: string; readonly apiKey: string},
): SupportModelConnection {
  const genericKey = stripLikePython(settings.model_api_key ?? '')
  return genericKey === ''
    ? Object.freeze({
      source: 'selected_provider' as const,
      baseUrl: selectedProvider.baseUrl,
      apiKey: selectedProvider.apiKey,
    })
    : Object.freeze({
      source: 'generic' as const,
      baseUrl: secureEndpoint(
        settings.model_base_url,
        'https',
        'NOVA_AUDIO_AGENT_MODEL_BASE_URL',
      ),
      apiKey: genericKey,
    })
}

export function resolveCascadedSelection(settings: Settings): CascadedSelection {
  const llmModel = settings.cascade_llm_model === null
    ? (settings.cascade_llm_provider === 'qwen'
      ? 'qwen-flash'
      : 'doubao-seed-2-0-pro-260215')
    : requiredSetting(settings.cascade_llm_model, 'NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL')
  return Object.freeze({
    endpointingProvider: settings.cascade_endpointing_provider,
    asrProvider: settings.cascade_asr_provider,
    llmProvider: settings.cascade_llm_provider,
    llmModel,
    ttsProvider: settings.cascade_tts_provider,
  })
}

export function requireCascadedCredentials(
  settings: Settings,
  selection: CascadedSelection,
): CascadedCredentials {
  const llmApiKey = selection.llmProvider === 'qwen'
    ? requiredCredential(settings.dashscope_api_key, 'DASHSCOPE_API_KEY')
    : requiredCredential(settings.ark_api_key, 'ARK_API_KEY')
  const ttsApiKey = requiredCredential(settings.doubao_bigmodel_api_key, 'DOUBAO_BIGMODEL_API_KEY')
  const asrApiKey = stripLikePython(settings.doubao_asr_api_key ?? '') || ttsApiKey
  return Object.freeze({llmApiKey, asrApiKey, ttsApiKey})
}

export function requireVolcengineRealtime(settings: Settings): VolcengineRealtimeConfig {
  const arkApiKey = stripLikePython(settings.ark_api_key ?? '')
  const ttsApiKey = stripLikePython(settings.doubao_bigmodel_api_key ?? '')
  const asrApiKey = stripLikePython(settings.doubao_asr_api_key ?? '') || ttsApiKey
  if (arkApiKey === '') throw new ConfigurationError('缺少 ARK_API_KEY')
  if (ttsApiKey === '') throw new ConfigurationError('缺少 DOUBAO_BIGMODEL_API_KEY')
  if (asrApiKey === '') {
    throw new ConfigurationError('缺少 DOUBAO_ASR_API_KEY 或 DOUBAO_BIGMODEL_API_KEY')
  }
  if (settings.doubao_asr_chunk_ms <= 0) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_DOUBAO_ASR_CHUNK_MS 必须为正整数')
  }
  if (settings.doubao_tts_output_sample_rate !== 24_000) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_DOUBAO_TTS_OUTPUT_SAMPLE_RATE 必须为 24000')
  }
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
    arkBaseUrl: secureEndpoint(settings.volcengine_ark_base_url, 'https',
      'NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL'),
    arkModel: requiredSetting(settings.volcengine_ark_model,
      'NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL'),
    arkSupportModel: requiredSetting(settings.volcengine_ark_support_model,
      'NOVA_AUDIO_AGENT_SURROGATE_MODEL'),
    arkApiKey,
    asrEndpoint: secureEndpoint(settings.doubao_asr_endpoint, 'wss',
      'NOVA_AUDIO_AGENT_DOUBAO_ASR_ENDPOINT'),
    asrResourceId: requiredSetting(settings.doubao_asr_resource_id,
      'NOVA_AUDIO_AGENT_DOUBAO_ASR_RESOURCE_ID'),
    asrApiKey,
    asrChunkMs: settings.doubao_asr_chunk_ms,
    ttsEndpoint: secureEndpoint(settings.doubao_tts_endpoint, 'wss',
      'NOVA_AUDIO_AGENT_DOUBAO_TTS_ENDPOINT'),
    ttsResourceId: requiredSetting(settings.doubao_tts_resource_id,
      'NOVA_AUDIO_AGENT_DOUBAO_TTS_RESOURCE_ID'),
    ttsVoice: requiredSetting(settings.doubao_tts_voice,
      'NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE'),
    ttsApiKey,
    ttsOutputSampleRate: 24_000,
    vadThreshold: settings.volcengine_vad_threshold,
    vadPreRollMs: settings.volcengine_vad_pre_roll_ms,
    vadMinSpeechMs: settings.volcengine_vad_min_speech_ms,
    vadSilenceEndMs: settings.volcengine_vad_silence_end_ms,
    vadSpeechPadMs: settings.volcengine_vad_speech_pad_ms,
    vadMaxUtteranceMs: settings.volcengine_vad_max_utterance_ms,
  })
}

function parseExecutors(raw: string | undefined, fallback: string): string[] {
  if (raw === undefined || raw === '') return [fallback]
  const names = raw.split(',').map(stripLikePython)
  if (names.some(name => name === '')) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_EXECUTORS contains an empty name')
  }
  if (new Set(names).size !== names.length) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_EXECUTORS contains duplicate names')
  }
  return names
}

function parsePipelineMode(value: string | undefined): PipelineMode {
  return parseSelector(pipelineModeSchema, value, 'integrated', 'NOVA_AUDIO_AGENT_PIPELINE_MODE')
}

function parseIntegratedProvider(value: string | undefined): IntegratedProviderName {
  return parseSelector(
    integratedProviderNameSchema,
    value,
    'qwen',
    'NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER',
  )
}

function parseCascadedEndpointingProvider(value: string | undefined): CascadedEndpointingProviderName {
  return parseSelector(
    cascadedEndpointingProviderNameSchema,
    value,
    'auto',
    'NOVA_AUDIO_AGENT_CASCADE_ENDPOINTING_PROVIDER',
  )
}

function parseCascadedAsrProvider(value: string | undefined): CascadedAsrProviderName {
  return parseSelector(
    cascadedAsrProviderNameSchema,
    value,
    'volcengine',
    'NOVA_AUDIO_AGENT_CASCADE_ASR_PROVIDER',
  )
}

function parseCascadedLlmProvider(value: string | undefined): CascadedLlmProviderName {
  return parseSelector(
    cascadedLlmProviderNameSchema,
    value,
    'qwen',
    'NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER',
  )
}

function parseCascadedTtsProvider(value: string | undefined): CascadedTtsProviderName {
  return parseSelector(
    cascadedTtsProviderNameSchema,
    value,
    'volcengine',
    'NOVA_AUDIO_AGENT_CASCADE_TTS_PROVIDER',
  )
}

function parseSelector<T extends string>(
  schema: z.ZodType<T>,
  value: string | undefined,
  fallback: T,
  field: string,
): T {
  const result = schema.safeParse(optionalString(value) ?? fallback)
  if (result.success) return result.data
  throw new ConfigurationError(`invalid configuration: ${field}`)
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return stripLikePython(value)
}

function optionalJsonStringArray(value: string | undefined): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function optionalSecret(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined
  return stripLikePython(value) || null
}

function optionalBoolean(value: string | undefined): boolean | string | undefined {
  if (value === undefined) return undefined
  const normalized = value.toLowerCase()
  if (['true', 't', '1', 'on', 'yes', 'y'].includes(normalized)) return true
  if (['false', 'f', '0', 'off', 'no', 'n'].includes(normalized)) return false
  return normalized
}

function optionalQwenGuardHistoryPairs(value: string | undefined): 1 | 2 | 4 | string | undefined {
  if (value === undefined) return undefined
  if (value === '1') return 1
  if (value === '2') return 2
  if (value === '4') return 4
  return value
}

const pydanticNumericSpace = '[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680'
  + '\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const underscoredDigits = '[0-9](?:_?[0-9])*'
const pydanticIntegerPattern = new RegExp(
  `^${pydanticNumericSpace}*[+-]?${underscoredDigits}(?:\\.0+)?${pydanticNumericSpace}*$`,
  'u',
)
const pydanticFloatPattern = new RegExp(
  `^${pydanticNumericSpace}*[+-]?(?:(?:${underscoredDigits}(?:\\.(?:${underscoredDigits})?)?`
    + `|\\.${underscoredDigits})(?:[eE][+-]?${underscoredDigits})?`
    + `|inf(?:inity)?|nan)${pydanticNumericSpace}*$`,
  'iu',
)
const pydanticNumericEdges = new RegExp(`^${pydanticNumericSpace}+|${pydanticNumericSpace}+$`, 'gu')

function optionalPydanticInteger(value: string | undefined): number | string | undefined {
  if (value === undefined) return undefined
  if (!pydanticIntegerPattern.test(value)) return value
  const parsed = Number(value.replace(pydanticNumericEdges, '').replaceAll('_', ''))
  return Number.isSafeInteger(parsed) ? parsed : value
}

function optionalPydanticFloat(value: string | undefined): number | string | undefined {
  if (value === undefined) return undefined
  if (!pydanticFloatPattern.test(value)) return value
  const normalized = value.replace(pydanticNumericEdges, '').replaceAll('_', '')
  const parsed = Number(normalized.toLowerCase().replace('infinity', 'Infinity').replace('inf', 'Infinity'))
  return Number.isNaN(parsed) && !/^[+-]?nan$/iu.test(normalized) ? value : parsed
}

function rawEnvironmentValue(value: string | undefined): string | undefined {
  return value
}

function requiredSetting(value: string, name: string): string {
  const normalized = stripLikePython(value)
  if (normalized === '') throw new ConfigurationError(`${name} 不能为空`)
  return normalized
}

function requiredCredential(value: string | null, name: string): string {
  const normalized = stripLikePython(value ?? '')
  if (normalized === '') throw new ConfigurationError(`缺少 ${name}`)
  return normalized
}

function secureEndpoint(value: string, scheme: 'https' | 'wss', name: string): string {
  let normalized = stripLikePython(value)
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  const schemeSeparator = normalized.indexOf('://')
  const authorityTail = schemeSeparator < 0 ? '' : normalized.slice(schemeSeparator + 3)
  const authorityEnd = authorityTail.search(/[/?#]/u)
  const authority = authorityEnd < 0 ? authorityTail : authorityTail.slice(0, authorityEnd)
  let parsed: URL | null = null
  try {
    parsed = new URL(normalized)
  } catch {
    // The fixed error below deliberately does not retain the submitted URL.
  }
  const valid = parsed?.protocol === `${scheme}:` && parsed.hostname !== ''
    && !authority.includes('@') && parsed.username === '' && parsed.password === ''
    && parsed.hash === ''
  if (!valid) {
    throw new ConfigurationError(`${name} 必须是安全的 ${scheme}:// 地址`)
  }
  return normalized
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function configurationFieldName(field: string): string {
  const aliases: Readonly<Record<string, string>> = {
    ark_api_key: 'ARK_API_KEY',
    dashscope_api_key: 'DASHSCOPE_API_KEY',
    doubao_asr_api_key: 'DOUBAO_ASR_API_KEY',
    doubao_bigmodel_api_key: 'DOUBAO_BIGMODEL_API_KEY',
    tavily_api_key: 'TAVILY_API_KEY',
  }
  return aliases[field] ?? `NOVA_AUDIO_AGENT_${field.toUpperCase()}`
}
