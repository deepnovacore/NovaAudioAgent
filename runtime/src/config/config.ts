import {parseCapabilityRegistry, type CapabilityRegistry} from './capability-registry.js'
import { z } from 'zod'
import { stripLikePython } from '../text/python-text.js'
import {supportsVision} from '../model/vision-capability.js'

export const proactivityPresetSchema = z.enum(['conservative', 'balanced', 'eager'])
const pipelineModeSchema = z.enum(['integrated', 'cascaded'])
const promptLanguageSchema = z.enum(['zh-CN', 'en'])
const integratedProviderNameSchema = z.enum(['qwen', 'stepfun'])
const cascadedEndpointingProviderNameSchema = z.enum(['auto'])
const cascadedAsrProviderNameSchema = z.enum(['volcengine'])
const cascadedLlmProviderNameSchema = z.enum(['qwen', 'ark', 'deepseek'])
const cascadedTtsProviderNameSchema = z.enum(['volcengine'])
const qwenGuardHistoryRecoverySchema = z.enum(['none', 'packed'])
const qwenGuardHistoryPairsSchema = z.union([z.literal(1), z.literal(2), z.literal(4)])
/** Validity of a name is decided by assembly (`resolveExecutors`), which knows the registered adapters. */
const executorNameSchema = z.string().min(1)
const executorApprovalModeSchema = z.enum(['ask', 'yolo'])
const clarificationDepthSchema = z.enum(['minimal', 'balanced', 'thorough'])
const planReadbackSchema = z.enum(['summary', 'confirm', 'silent'])
const progressBubblesSchema = z.enum(['off', 'milestones', 'all'])
const embeddingProviderSchema = z.enum(['dashscope'])
const memoryConnectionSchema = z.enum(['disabled', 'local', 'remote'])
const searchProviderSchema = z.enum(['mcp', 'tavily'])
const volcFloatSchema = z.custom<number>(value => typeof value === 'number')
export const DASHSCOPE_COMPATIBLE_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const STEPFUN_COMPATIBLE_BASE_URL = 'https://api.stepfun.com/v1'
const STEPFUN_SUPPORT_MODEL = 'step-3.7-flash'

export const settingsSchema = z.object({
  model_base_url: z.url().default(DASHSCOPE_COMPATIBLE_BASE_URL),
  model_api_key: z.string().nullable().default(null),
  openrouter_api_key: z.string().nullable().default(null),
  tavily_api_key: z.string().nullable().default(null),
  fast_model: z.string().default('qwen3-vl-plus'),
  watch_model: z.string().nullable().default(null),
  conversation_vision_enabled: z.boolean().default(false),
  monitor_camera_device_id: z.string().max(256).refine(value => !/[\x00-\x1f]/u.test(value)).default(''),
  support_model: z.string().default('qwen-plus'),
  compressor_model: z.string().default('qwen-flash'),
  language: promptLanguageSchema.default('zh-CN'),
  news_language: promptLanguageSchema.default('en'),
  pipeline_mode: pipelineModeSchema.default('integrated'),
  integrated_provider: integratedProviderNameSchema.default('qwen'),
  cascade_endpointing_provider: cascadedEndpointingProviderNameSchema.default('auto'),
  cascade_asr_provider: cascadedAsrProviderNameSchema.default('volcengine'),
  cascade_llm_provider: cascadedLlmProviderNameSchema.default('deepseek'),
  cascade_llm_model: z.string().nullable().default(null),
  cascade_tts_provider: cascadedTtsProviderNameSchema.default('volcengine'),
  camera_module_enabled: z.boolean().default(true),
  qwen_realtime_url: z.string().default('wss://dashscope.aliyuncs.com/api-ws/v1/realtime'),
  qwen_realtime_model: z.string().default('qwen-audio-3.0-realtime-plus'),
  qwen_realtime_voice: z.string().default('longanqian'),
  stepfun_realtime_url: z.string().default('wss://api.stepfun.com/v1/realtime'),
  stepfun_realtime_model: z.string().default('stepaudio-3-realtime-preview'),
  stepfun_realtime_voice: z.string().default(''),
  stepfun_api_key: z.string().nullable().default(null),
  dashscope_api_key: z.string().nullable().default(null),
  ark_api_key: z.string().nullable().default(null),
  deepseek_api_key: z.string().nullable().default(null),
  doubao_asr_api_key: z.string().nullable().default(null),
  doubao_bigmodel_api_key: z.string().nullable().default(null),
  volcengine_ark_base_url: z.string().default('https://ark.cn-beijing.volces.com/api/v3'),
  volcengine_ark_model: z.string().default('doubao-seed-2-0-pro-260215'),
  volcengine_ark_support_model: z.string().default('doubao-seed-2-0-pro-260215'),
  doubao_asr_endpoint: z.string().default(
    'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
  ),
  doubao_asr_resource_id: z.string().default('volc.seedasr.sauc.duration'),
  doubao_asr_voiceprint_enabled: z.boolean().default(false),
  doubao_asr_voiceprint_id: z.string().default(''),
  doubao_asr_voiceprint_name: z.string().default(''),
  doubao_asr_voiceprint_health_url: z.string().default(''),
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
  volcengine_vad_silence_end_ms: z.number().int().default(300),
  volcengine_vad_speech_pad_ms: z.number().int().default(30),
  volcengine_vad_max_utterance_ms: z.number().int().default(60_000),
  qwen_controlled_guard_reconnect: z.boolean().default(false),
  qwen_guard_history_recovery: qwenGuardHistoryRecoverySchema.default('none'),
  qwen_guard_history_pairs: qwenGuardHistoryPairsSchema.default(4),
  executor: executorNameSchema.nullable().default(null),
  executors: z.array(executorNameSchema),
  codex_workspace: z.string().nullable().default(null),
  codex_bin: z.string().default('codex'),
  codex_prefix_args: z.array(z.string().min(1).max(32_768)).max(1).default([]),
  codex_api_key: z.string().nullable().default(null),
  codex_prewarm: z.boolean().default(true),
  codex_managed_root: z.string().default('~/.nova-audio-agent/workspaces'),
  codex_project_state_root: z.string().default('~/.nova-audio-agent'),
  coding_progress_narration: z.enum(['smart', 'continuous']).default('smart'),
  proactivity_preset: proactivityPresetSchema.default('balanced'),
  codex_working_interval: z.number().finite().min(5).max(600).default(30),
  suggestion_cooldown: z.number().finite().nonnegative().nullable().default(null),
  fresh_window: z.number().finite().nonnegative().nullable().default(null),
  codex_approval_mode: executorApprovalModeSchema.default('ask'),
  clarification_depth: clarificationDepthSchema.default('balanced'),
  plan_readback: planReadbackSchema.default('summary'),
  generate_plan: z.boolean().default(true),
  planner_model: z.string().default(''),
  progress_bubbles: progressBubblesSchema.default('milestones'),
  search_provider: searchProviderSchema.default('tavily'),
  search_mcp_url: z.string().default(''),
  search_mcp_tool: z.string().default('web_search'),
  knowledge_path: z.string().default('~/.nova-audio-agent/knowledge.sqlite'),
  embedding_provider: embeddingProviderSchema.default('dashscope'),
  embedding_model: z.string().default('text-embedding-v4'),
  blackboard_path: z.string().min(1).default('~/.nova-audio-agent/blackboard.sqlite'),
  blackboard_owner_id: z.string().min(1).max(512).default('local'),
  memory_prerecall_enabled: z.boolean().default(false),
  memory_consolidation_enabled: z.boolean().default(true),
  memory_consolidation_hour: z.number().int().min(0).max(23).default(0),
  memory_consolidation_timezone: z.string().refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true}catch{return false}},'invalid timezone').default('UTC'),
  memory_connection: memoryConnectionSchema.default('local'),
  memory_provider: z.enum(['voicemem', 'mem0']).nullable().default(null),
  memory_url: z.string().default(''),
  memory_token: z.string().nullable().default(null),
  memory_path: z.string().min(1).default('~/.nova-audio-agent/memory.sqlite'),
  memory_user_id: z.string().min(1).default('local'),
  // Existing v0.3 ledger location; the retired workspace graph is not enabled.
  workspace_graph_path: z.string().min(1).default('~/.nova-audio-agent/workspace-graph.sqlite'),
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
  readonly llmProvider: 'qwen' | 'ark' | 'deepseek'
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

export type PersonalMemoryConfig = {readonly connection: 'remote'; readonly url: string; readonly token: string} | LocalPersonalMemoryConfig

interface LocalPersonalMemoryConfig {
  readonly connection: 'local'
  readonly provider: 'voicemem' | 'mem0'
  readonly extractionModel: string
  readonly path: string
  readonly userId: string
  readonly embedding: {
    readonly baseUrl: string
    readonly apiKey: string
    readonly model: string
  }
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

export class ConfigurationError extends Error {
  constructor(message: string, readonly code: 'invalid_configuration' = 'invalid_configuration') {
    super(message)
    this.name = 'ConfigurationError'
  }
}

/** Names the credentials the selected voice pipeline cannot start without, so the host can ask for exactly those. */
export class BlockingConfigurationError extends ConfigurationError {
  constructor(readonly pipeline: PipelineMode, readonly missing: readonly string[]) {
    super(`缺少 ${missing.join(', ')}`)
    this.name = 'BlockingConfigurationError'
  }
}

/** Environment names that were renamed without an alias; the old name is ignored, so its presence deserves a startup warning. */
export const RENAMED_ENVIRONMENT: Readonly<Record<string, string>> = {SURROGATE_MODEL: 'SUPPORT_MODEL'}

/** One `[config-warning]` line per renamed variable still set in the environment. */
export function renamedEnvironmentWarnings(environment: NodeJS.ProcessEnv): readonly string[] {
  return Object.entries(RENAMED_ENVIRONMENT)
    .filter(([removed]) => environment[removed] !== undefined)
    .map(([removed, current]) => `[config-warning] ${removed} is no longer read; rename it to ${current}`)
}

export function loadSettings(environment: NodeJS.ProcessEnv = process.env, textConversations = false): Settings {
  const pipelineMode = parsePipelineMode(environment.PIPELINE_MODE)
  const integratedProvider = pipelineMode === 'integrated'
    ? parseIntegratedProvider(environment.INTEGRATED_PROVIDER)
    : undefined
  const cascadedProviders = pipelineMode === 'cascaded'
    ? {
      endpointing: parseCascadedEndpointingProvider(
        environment.CASCADE_ENDPOINTING_PROVIDER,
      ),
      asr: parseCascadedAsrProvider(environment.CASCADE_ASR_PROVIDER),
      llm: parseCascadedLlmProvider(environment.CASCADE_LLM_PROVIDER),
      tts: parseCascadedTtsProvider(environment.CASCADE_TTS_PROVIDER),
    }
    : undefined
  const configuredExecutor = optionalString(environment.EXECUTOR)
  const executor = configuredExecutor === undefined || configuredExecutor === ''
    ? null
    : configuredExecutor
  const executors = parseExecutors(environment.EXECUTORS, configuredExecutor ?? '')
  // StepFun support chat defaults to its own model. fast_model keeps its DashScope default
  // because local memory extraction reaches it through the DashScope embedding connection;
  // an empty watch or planner model would fall back to it, so empty counts as unset there.
  const stepfunSupport = !textConversations && integratedProvider === 'stepfun'
    && (optionalSecret(environment.MODEL_API_KEY) ?? '').trim() === ''
  const supportDefault = (value: string | undefined): string | undefined =>
    value ?? (stepfunSupport ? STEPFUN_SUPPORT_MODEL : undefined)
  const candidate = {
    model_base_url: optionalString(environment.MODEL_BASE_URL),
    model_api_key: optionalSecret(environment.MODEL_API_KEY),
    openrouter_api_key: optionalSecret(environment.OPENROUTER_API_KEY),
    tavily_api_key: optionalSecret(environment.TAVILY_API_KEY),
    fast_model: rawEnvironmentValue(environment.FAST_MODEL),
    watch_model: supportDefault(emptyAsUnset(rawEnvironmentValue(environment.WATCH_MODEL))),
    ...(supportsVision('qwen', environment.WATCH_MODEL ?? '')
      || environment.MEMORY_CONNECTION?.trim() === 'local'
      ? {dashscope_api_key: optionalSecret(environment.DASHSCOPE_API_KEY)} : {}),
    ...(supportsVision('ark', environment.WATCH_MODEL ?? '')
      ? {ark_api_key: optionalSecret(environment.ARK_API_KEY),
          volcengine_ark_base_url: rawEnvironmentValue(environment.VOLCENGINE_ARK_BASE_URL)} : {}),
    conversation_vision_enabled: optionalBoolean(environment.CONVERSATION_VISION_ENABLED),
    monitor_camera_device_id: optionalString(environment.MONITOR_CAMERA_DEVICE_ID),
    support_model: supportDefault(rawEnvironmentValue(environment.SUPPORT_MODEL)),
    compressor_model: supportDefault(rawEnvironmentValue(environment.COMPRESSOR_MODEL)),
    language: parsePromptLanguageSetting(environment.PROMPT_LANGUAGE),
    news_language: parseSelector(promptLanguageSchema, environment.NEWS_LANGUAGE, 'en', 'NEWS_LANGUAGE'),
    pipeline_mode: pipelineMode,
    camera_module_enabled: optionalBoolean(
      environment.CAMERA_MODULE_ENABLED,
    ),
    ...(pipelineMode === 'integrated' ? {
      ...(textConversations ? {cascade_llm_provider: parseCascadedLlmProvider(environment.CASCADE_LLM_PROVIDER),
        cascade_llm_model: rawEnvironmentValue(environment.CASCADE_LLM_MODEL),
        ark_api_key: optionalSecret(environment.ARK_API_KEY), deepseek_api_key: optionalSecret(environment.DEEPSEEK_API_KEY),
        volcengine_ark_base_url: rawEnvironmentValue(environment.VOLCENGINE_ARK_BASE_URL)} : {}),
      integrated_provider: integratedProvider,
      qwen_realtime_url: optionalString(environment.QWEN_REALTIME_URL),
      qwen_realtime_model: optionalString(environment.QWEN_REALTIME_MODEL),
      qwen_realtime_voice: optionalString(environment.QWEN_REALTIME_VOICE)
        ?? (environment.QWEN_REALTIME_MODEL?.startsWith('qwen3.5-omni-') ? 'Ethan'
          : environment.QWEN_REALTIME_MODEL === 'qwen-audio-3.1-realtime-plus' ? 'longanqian_v3.1' : undefined),
      dashscope_api_key: optionalSecret(environment.DASHSCOPE_API_KEY),
      stepfun_realtime_url: optionalString(environment.STEPFUN_REALTIME_URL),
      stepfun_realtime_model: optionalString(environment.STEPFUN_REALTIME_MODEL),
      stepfun_realtime_voice: optionalString(environment.STEPFUN_REALTIME_VOICE),
      stepfun_api_key: optionalSecret(environment.STEPFUN_API_KEY),
      qwen_controlled_guard_reconnect: optionalBoolean(
        environment.QWEN_CONTROLLED_GUARD_RECONNECT,
      ),
      qwen_guard_history_recovery: environment.QWEN_GUARD_HISTORY_RECOVERY,
      qwen_guard_history_pairs: optionalQwenGuardHistoryPairs(
        environment.QWEN_GUARD_HISTORY_PAIRS,
      ),
    } : {
      cascade_endpointing_provider: cascadedProviders!.endpointing,
      cascade_asr_provider: cascadedProviders!.asr,
      cascade_llm_provider: cascadedProviders!.llm,
      cascade_llm_model: rawEnvironmentValue(environment.CASCADE_LLM_MODEL),
      cascade_tts_provider: cascadedProviders!.tts,
      ...(cascadedProviders!.llm === 'qwen'
        ? {dashscope_api_key: optionalSecret(environment.DASHSCOPE_API_KEY)}
        : cascadedProviders!.llm === 'deepseek'
          ? {deepseek_api_key: optionalSecret(environment.DEEPSEEK_API_KEY)}
          : {ark_api_key: optionalSecret(environment.ARK_API_KEY)}),
      ...(cascadedProviders!.llm === 'ark' ? {
        volcengine_ark_base_url: rawEnvironmentValue(
          environment.VOLCENGINE_ARK_BASE_URL,
        ),
      } : {}),
      doubao_asr_api_key: optionalSecret(environment.DOUBAO_ASR_API_KEY),
      doubao_bigmodel_api_key: optionalSecret(environment.DOUBAO_BIGMODEL_API_KEY),
      doubao_asr_endpoint: rawEnvironmentValue(environment.DOUBAO_ASR_ENDPOINT),
      doubao_asr_resource_id: rawEnvironmentValue(
        environment.DOUBAO_ASR_RESOURCE_ID,
      ),
      doubao_asr_voiceprint_enabled: optionalBoolean(environment.DOUBAO_ASR_VOICEPRINT_ENABLED),
      doubao_asr_voiceprint_id: rawEnvironmentValue(environment.DOUBAO_ASR_VOICEPRINT_ID),
      doubao_asr_voiceprint_name: rawEnvironmentValue(environment.DOUBAO_ASR_VOICEPRINT_NAME),
      doubao_asr_voiceprint_health_url: rawEnvironmentValue(environment.DOUBAO_ASR_VOICEPRINT_HEALTH_URL),
      doubao_asr_chunk_ms: optionalPydanticInteger(
        environment.DOUBAO_ASR_CHUNK_MS,
      ),
      doubao_tts_endpoint: rawEnvironmentValue(environment.DOUBAO_TTS_ENDPOINT),
      doubao_tts_resource_id: rawEnvironmentValue(
        environment.DOUBAO_TTS_RESOURCE_ID,
      ),
      doubao_tts_voice: rawEnvironmentValue(environment.DOUBAO_TTS_VOICE),
      doubao_tts_output_sample_rate: optionalPydanticInteger(
        environment.DOUBAO_TTS_OUTPUT_SAMPLE_RATE,
      ),
      volcengine_vad_threshold: optionalPydanticFloat(
        environment.VOLCENGINE_VAD_THRESHOLD,
      ),
      volcengine_vad_pre_roll_ms: optionalPydanticInteger(
        environment.VOLCENGINE_VAD_PRE_ROLL_MS,
      ),
      volcengine_vad_min_speech_ms: optionalPydanticInteger(
        environment.VOLCENGINE_VAD_MIN_SPEECH_MS,
      ),
      volcengine_vad_silence_end_ms: optionalPydanticInteger(
        environment.VOLCENGINE_VAD_SILENCE_END_MS,
      ),
      volcengine_vad_speech_pad_ms: optionalPydanticInteger(
        environment.VOLCENGINE_VAD_SPEECH_PAD_MS,
      ),
      volcengine_vad_max_utterance_ms: optionalPydanticInteger(
        environment.VOLCENGINE_VAD_MAX_UTTERANCE_MS,
      ),
    }),
    executor,
    executors,
    ...executorOwnedSettings(environment, executors),
    coding_progress_narration: optionalString(environment.CODING_PROGRESS_NARRATION),
    proactivity_preset: optionalString(environment.PROACTIVITY_PRESET),
    suggestion_cooldown: optionalPydanticFloat(
      environment.SUGGESTION_COOLDOWN,
    ),
    fresh_window: optionalPydanticFloat(environment.FRESH_WINDOW),
    clarification_depth: parseClarificationDepth(
      environment.CLARIFICATION_DEPTH,
    ),
    plan_readback: parsePlanReadback(environment.PLAN_READBACK),
    generate_plan: optionalBoolean(environment.GENERATE_PLAN),
    planner_model: supportDefault(emptyAsUnset(optionalString(environment.PLANNER_MODEL))),
    progress_bubbles: parseProgressBubbles(environment.PROGRESS_BUBBLES),
    search_provider: parseSearchProvider(environment.SEARCH_PROVIDER),
    search_mcp_url: optionalString(environment.SEARCH_MCP_URL),
    search_mcp_tool: optionalString(environment.SEARCH_MCP_TOOL),
    knowledge_path: optionalString(environment.KNOWLEDGE_PATH),
    embedding_provider: parseEmbeddingProvider(
      environment.EMBEDDING_PROVIDER,
    ),
    embedding_model: optionalString(environment.EMBEDDING_MODEL),
    blackboard_path: optionalString(environment.BLACKBOARD_PATH),
    blackboard_owner_id: optionalString(environment.BLACKBOARD_OWNER_ID),
    memory_prerecall_enabled: optionalBoolean(environment.MEMORY_PRERECALL_ENABLED),
    memory_consolidation_enabled: optionalBoolean(environment.MEMORY_CONSOLIDATION_ENABLED),
    memory_consolidation_hour: optionalPydanticInteger(environment.MEMORY_CONSOLIDATION_HOUR),
    memory_consolidation_timezone: environment.MEMORY_CONSOLIDATION_TIMEZONE,
    memory_connection: optionalString(environment.MEMORY_CONNECTION),
    ...((optionalString(environment.MEMORY_CONNECTION) ?? 'local') === 'local'
      ? {dashscope_api_key: optionalSecret(environment.DASHSCOPE_API_KEY)} : {}),
    memory_provider: optionalString(environment.MEMORY_PROVIDER),
    memory_url: optionalString(environment.MEMORY_URL),
    memory_token: optionalSecret(environment.MEMORY_TOKEN),
    memory_path: optionalString(environment.MEMORY_PATH),
    memory_user_id: optionalString(environment.MEMORY_USER_ID),
    workspace_graph_path: optionalString(environment.MEMORY_LEDGER_PATH) ?? optionalString(environment.WORKSPACE_GRAPH_PATH),
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
  if (environment.MEMORY_BACKEND !== undefined) {
    throw new ConfigurationError('MEMORY_BACKEND was removed; use MEMORY_CONNECTION')
  }
  resolveMemoryConnection(result.data)
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

export function requirePersonalMemory(settings: Settings): PersonalMemoryConfig | null {
  const connection = resolveMemoryConnection(settings)
  if (connection === 'disabled') return null
  if (connection === 'remote') return Object.freeze({
    connection: 'remote',
    url: requiredSetting(settings.memory_url, 'MEMORY_URL'),
    token: requiredCredential(settings.memory_token, 'MEMORY_TOKEN'),
  })
  // Local memory is optional: without an embedding credential it stays off instead of blocking the voice pipeline.
  if (stripLikePython(resolveModelApiKey(settings) ?? '') === '') return null
  return Object.freeze({
    connection: 'local',
    provider: settings.memory_provider ?? 'voicemem',
    path: requiredSetting(settings.memory_path, 'MEMORY_PATH'),
    userId: requiredSetting(settings.memory_user_id, 'MEMORY_USER_ID'),
    extractionModel: requiredSetting(settings.fast_model, 'FAST_MODEL'),
    embedding: Object.freeze({
      baseUrl: secureEndpoint(settings.model_base_url, 'https', 'MODEL_BASE_URL'),
      apiKey: requiredCredential(resolveModelApiKey(settings), 'DASHSCOPE_API_KEY 或 MODEL_API_KEY'),
      model: requiredSetting(settings.embedding_model, 'EMBEDDING_MODEL'),
    }),
  })
}

function resolveMemoryConnection(settings: Settings): z.infer<typeof memoryConnectionSchema> {
  const connection = settings.memory_connection
  if (settings.memory_provider !== null && connection !== 'local') {
    throw new ConfigurationError('MEMORY_PROVIDER is only valid for a local memory connection; remote engines are selected by the service')
  }
  return connection
}

export function requireQwenRealtime(settings: Settings): QwenRealtimeConfig {
  const url = stripLikePython(settings.qwen_realtime_url)
  const model = stripLikePython(settings.qwen_realtime_model)
  const voice = stripLikePython(settings.qwen_realtime_voice)
  if (!url.startsWith('wss://')) {
    throw new ConfigurationError('QWEN_REALTIME_URL 必须使用 wss://')
  }
  if (model === '') {
    throw new ConfigurationError('QWEN_REALTIME_MODEL 不能为空')
  }
  if (voice === '') {
    throw new ConfigurationError('QWEN_REALTIME_VOICE 不能为空')
  }
  const realtimeKey = stripLikePython(settings.dashscope_api_key ?? '')
  const modelKey = stripLikePython(settings.model_api_key ?? '')
  const apiKey = realtimeKey || modelKey
  if (apiKey === '') {
    throw new ConfigurationError('缺少 DASHSCOPE_API_KEY 或 MODEL_API_KEY')
  }
  return {url, model, voice, apiKey}
}

export function requireIntegratedRealtime(settings: Settings): QwenRealtimeConfig {
  if (settings.integrated_provider === 'stepfun') {
    const url = secureEndpoint(settings.stepfun_realtime_url, 'wss', 'STEPFUN_REALTIME_URL')
    const model = stripLikePython(settings.stepfun_realtime_model)
    const voice = stripLikePython(settings.stepfun_realtime_voice)
    const apiKey = stripLikePython(settings.stepfun_api_key ?? '')
    if (model === '') throw new ConfigurationError('STEPFUN_REALTIME_MODEL 不能为空')
    if (apiKey === '') throw new ConfigurationError('缺少 STEPFUN_API_KEY')
    return Object.freeze({url, model, voice, apiKey})
  }
  const url = secureEndpoint(
    settings.qwen_realtime_url,
    'wss',
    'QWEN_REALTIME_URL',
  )
  const model = stripLikePython(settings.qwen_realtime_model)
  const voice = stripLikePython(settings.qwen_realtime_voice)
  if (model === '') {
    throw new ConfigurationError('QWEN_REALTIME_MODEL 不能为空')
  }
  if (voice === '') {
    throw new ConfigurationError('QWEN_REALTIME_VOICE 不能为空')
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

export function resolveModelApiKey(settings: Settings): string | null {
  return stripLikePython(settings.model_api_key ?? '')
    || (settings.model_base_url === DASHSCOPE_COMPATIBLE_BASE_URL ? settings.dashscope_api_key : null)
}

/** Preset monitor models keep their credential on their own provider endpoint. */
export function resolveWatchModelConnection(settings: Settings): {readonly baseUrl: string; readonly apiKey: string} | null {
  const model = stripLikePython(settings.watch_model ?? '')
  if (supportsVision('stepfun', model)) return {
    baseUrl: STEPFUN_COMPATIBLE_BASE_URL,
    apiKey: requiredCredential(settings.stepfun_api_key, 'STEPFUN_API_KEY'),
  }
  if (supportsVision('qwen', model)) return {
    baseUrl: DASHSCOPE_COMPATIBLE_BASE_URL,
    apiKey: requiredCredential(settings.dashscope_api_key
      ?? (settings.model_base_url === DASHSCOPE_COMPATIBLE_BASE_URL ? settings.model_api_key : null), 'DASHSCOPE_API_KEY'),
  }
  if (supportsVision('ark', model)) return {
    baseUrl: secureEndpoint(settings.volcengine_ark_base_url, 'https', 'VOLCENGINE_ARK_BASE_URL'),
    apiKey: requiredCredential(settings.ark_api_key, 'ARK_API_KEY'),
  }
  return null
}

/** The credential a vision watch model still needs, or null when it has one (or needs none). */
export function missingWatchModelCredential(settings: Settings): string | null {
  const model = stripLikePython(settings.watch_model ?? '')
  if (supportsVision('qwen', model)) {
    return stripLikePython(settings.dashscope_api_key
      ?? (settings.model_base_url === DASHSCOPE_COMPATIBLE_BASE_URL ? settings.model_api_key : null) ?? '') === ''
      ? 'DASHSCOPE_API_KEY' : null
  }
  if (supportsVision('ark', model)) return stripLikePython(settings.ark_api_key ?? '') === '' ? 'ARK_API_KEY' : null
  return null
}

/** Knowledge embeds through the generic model gateway, so it needs that gateway's key. */
export function missingKnowledgeCredential(settings: Settings): string | null {
  if (resolveModelApiKey(settings)) return null
  return settings.model_base_url === DASHSCOPE_COMPATIBLE_BASE_URL ? 'DASHSCOPE_API_KEY' : 'MODEL_API_KEY'
}

/** Camera watch and knowledge are optional: without their credential they are reported off rather than failing startup. */
export function withoutUncredentialedModules(registry: CapabilityRegistry, settings: Settings): CapabilityRegistry {
  const camera = registry.modules.camera.enabled ? missingWatchModelCredential(settings) : null
  const knowledge = registry.modules.knowledge.enabled ? missingKnowledgeCredential(settings) : null
  if (camera === null && knowledge === null) return registry
  return {...registry, modules: {
    ...registry.modules,
    ...(camera === null ? {} : {camera: {enabled: false, reason: `missing_environment:${camera}`}}),
    ...(knowledge === null ? {} : {knowledge: {enabled: false, exposeToCodex: false, reason: `missing_environment:${knowledge}`}}),
  }}
}

/** Mirrors requireIntegratedRealtime and requireCascadedCredentials without throwing, for first-run guidance. */
export function describeMissingBlockingCredentials(settings: Settings, textConversations = false): {readonly pipeline: PipelineMode; readonly missing: readonly string[]} {
  const present = (value: string | null) => stripLikePython(value ?? '') !== ''
  if (!textConversations && settings.pipeline_mode === 'integrated') {
    if (settings.integrated_provider === 'stepfun') return {pipeline: 'integrated', missing: present(settings.stepfun_api_key) ? [] : ['STEPFUN_API_KEY']}
    const compatibleGenericKey = settings.model_base_url === DASHSCOPE_COMPATIBLE_BASE_URL ? settings.model_api_key : null
    return {pipeline: 'integrated', missing: present(settings.dashscope_api_key) || present(compatibleGenericKey) ? [] : ['DASHSCOPE_API_KEY']}
  }
  const llmField = settings.cascade_llm_provider === 'qwen'
    ? 'dashscope_api_key' : settings.cascade_llm_provider === 'deepseek' ? 'deepseek_api_key' : 'ark_api_key'
  return {pipeline: 'cascaded', missing: [
    ...(present(settings[llmField]) ? [] : [configurationFieldName(llmField)]),
    ...(textConversations || present(settings.doubao_bigmodel_api_key) ? [] : ['DOUBAO_BIGMODEL_API_KEY']),
  ]}
}

/** Host preflight over a launch environment; other configuration errors stay the runtime's to report. */
export function describeMissingBlockingEnvironment(environment: NodeJS.ProcessEnv, textConversations = false): ReturnType<typeof describeMissingBlockingCredentials> | null {
  try {
    return describeMissingBlockingCredentials(loadSettings(environment, textConversations), textConversations)
  } catch (error) {
    if (error instanceof ConfigurationError) return null
    throw error
  }
}

export function requireBlockingCredentials(settings: Settings): void {
  const {pipeline, missing} = describeMissingBlockingCredentials(settings)
  if (missing.length > 0) throw new BlockingConfigurationError(pipeline, missing)
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
        'MODEL_BASE_URL',
      ),
      apiKey: genericKey,
    })
}

export function resolveCascadedSelection(settings: Settings): CascadedSelection {
  const llmModel = settings.cascade_llm_model === null
    ? (settings.cascade_llm_provider === 'qwen'
      ? 'qwen-plus'
      : settings.cascade_llm_provider === 'deepseek' ? 'deepseek-flash' : 'doubao-seed-2-0-pro-260215')
    : requiredSetting(settings.cascade_llm_model, 'CASCADE_LLM_MODEL')
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
    : selection.llmProvider === 'deepseek'
      ? requiredCredential(settings.deepseek_api_key, 'DEEPSEEK_API_KEY')
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
    throw new ConfigurationError('DOUBAO_ASR_CHUNK_MS 必须为正整数')
  }
  if (settings.doubao_tts_output_sample_rate !== 24_000) {
    throw new ConfigurationError('DOUBAO_TTS_OUTPUT_SAMPLE_RATE 必须为 24000')
  }
  if (!(settings.volcengine_vad_threshold > 0 && settings.volcengine_vad_threshold <= 1)) {
    throw new ConfigurationError('VOLCENGINE_VAD_THRESHOLD 必须在 (0, 1] 内')
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
      'VOLCENGINE_ARK_BASE_URL'),
    arkModel: requiredSetting(settings.volcengine_ark_model,
      'CASCADE_LLM_MODEL'),
    arkSupportModel: requiredSetting(settings.volcengine_ark_support_model,
      'SUPPORT_MODEL'),
    arkApiKey,
    asrEndpoint: secureEndpoint(settings.doubao_asr_endpoint, 'wss',
      'DOUBAO_ASR_ENDPOINT'),
    asrResourceId: requiredSetting(settings.doubao_asr_resource_id,
      'DOUBAO_ASR_RESOURCE_ID'),
    asrApiKey,
    asrChunkMs: settings.doubao_asr_chunk_ms,
    ttsEndpoint: secureEndpoint(settings.doubao_tts_endpoint, 'wss',
      'DOUBAO_TTS_ENDPOINT'),
    ttsResourceId: requiredSetting(settings.doubao_tts_resource_id,
      'DOUBAO_TTS_RESOURCE_ID'),
    ttsVoice: requiredSetting(settings.doubao_tts_voice,
      'DOUBAO_TTS_VOICE'),
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

/**
 * Settings an executor owns are read only when that executor is selected, so its secrets stay
 * lazy. Keyed by executor name as data (like `owner` in the environment contract), not branched on.
 */
const EXECUTOR_OWNED_SETTINGS: Readonly<Record<string, (environment: NodeJS.ProcessEnv) => Record<string, unknown>>> = {
  codex: environment => ({
    codex_workspace: optionalSecret(environment.CODEX_WORKSPACE),
    codex_bin: optionalString(environment.CODEX_BIN),
    codex_prefix_args: optionalJsonStringArray(environment.CODEX_PREFIX_ARGS),
    codex_api_key: optionalSecret(environment.CODEX_API_KEY),
    codex_prewarm: optionalBoolean(environment.CODEX_PREWARM),
    codex_managed_root: optionalString(environment.CODEX_MANAGED_ROOT),
    codex_project_state_root: optionalString(environment.CODEX_PROJECT_STATE_ROOT),
    codex_working_interval: optionalPydanticFloat(
      environment.CODEX_WORKING_INTERVAL,
    ),
    codex_approval_mode: parseExecutorApprovalMode(
      environment.CODEX_APPROVAL_MODE,
    ),
  }),
}

function executorOwnedSettings(environment: NodeJS.ProcessEnv, executors: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const name of executors) {
    const read = Object.hasOwn(EXECUTOR_OWNED_SETTINGS, name) ? EXECUTOR_OWNED_SETTINGS[name] : undefined
    if (read !== undefined) Object.assign(result, read(environment))
  }
  return result
}

function parseExecutors(raw: string | undefined, fallback: string): string[] {
  if (raw === undefined || raw === '') return fallback === '' ? [] : [fallback]
  const names = raw.split(',').map(stripLikePython)
  if (names.some(name => name === '')) {
    throw new ConfigurationError('EXECUTORS contains an empty name')
  }
  if (new Set(names).size !== names.length) {
    throw new ConfigurationError('EXECUTORS contains duplicate names')
  }
  return names
}

function parsePipelineMode(value: string | undefined): PipelineMode {
  return parseSelector(pipelineModeSchema, value, 'integrated', 'PIPELINE_MODE')
}

function parsePromptLanguageSetting(value: string | undefined): z.infer<typeof promptLanguageSchema> {
  return parseSelector(promptLanguageSchema, value, 'zh-CN', 'PROMPT_LANGUAGE')
}

function parseIntegratedProvider(value: string | undefined): IntegratedProviderName {
  return parseSelector(
    integratedProviderNameSchema,
    value,
    'qwen',
    'INTEGRATED_PROVIDER',
  )
}

function parseCascadedEndpointingProvider(value: string | undefined): CascadedEndpointingProviderName {
  return parseSelector(
    cascadedEndpointingProviderNameSchema,
    value,
    'auto',
    'CASCADE_ENDPOINTING_PROVIDER',
  )
}

function parseCascadedAsrProvider(value: string | undefined): CascadedAsrProviderName {
  return parseSelector(
    cascadedAsrProviderNameSchema,
    value,
    'volcengine',
    'CASCADE_ASR_PROVIDER',
  )
}

function parseCascadedLlmProvider(value: string | undefined): CascadedLlmProviderName {
  return parseSelector(
    cascadedLlmProviderNameSchema,
    value,
    'qwen',
    'CASCADE_LLM_PROVIDER',
  )
}

function parseCascadedTtsProvider(value: string | undefined): CascadedTtsProviderName {
  return parseSelector(
    cascadedTtsProviderNameSchema,
    value,
    'volcengine',
    'CASCADE_TTS_PROVIDER',
  )
}

function parseExecutorApprovalMode(value: string | undefined): z.infer<typeof executorApprovalModeSchema> {
  return parseSafeSelector(executorApprovalModeSchema, value, 'ask')
}

function parseClarificationDepth(value: string | undefined): z.infer<typeof clarificationDepthSchema> {
  return parseSafeSelector(clarificationDepthSchema, value, 'balanced')
}

function parsePlanReadback(value: string | undefined): z.infer<typeof planReadbackSchema> {
  return parseSafeSelector(planReadbackSchema, value, 'summary')
}

function parseProgressBubbles(value: string | undefined): z.infer<typeof progressBubblesSchema> {
  return parseSafeSelector(progressBubblesSchema, value, 'milestones')
}

function parseEmbeddingProvider(value: string | undefined): z.infer<typeof embeddingProviderSchema> {
  return parseSelector(embeddingProviderSchema, value, 'dashscope',
    'EMBEDDING_PROVIDER (allowed: dashscope)')
}

function parseSearchProvider(value: string | undefined): z.infer<typeof searchProviderSchema> {
  return parseSafeSelector(searchProviderSchema, value, 'tavily')
}

function parseSafeSelector<T extends string>(schema: z.ZodType<T>, value: string | undefined, fallback: T): T {
  const result = schema.safeParse(optionalString(value) ?? fallback)
  return result.success ? result.data : fallback
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

function emptyAsUnset(value: string | undefined): string | undefined {
  return value === '' ? undefined : value
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
    deepseek_api_key: 'DEEPSEEK_API_KEY',
    dashscope_api_key: 'DASHSCOPE_API_KEY',
    doubao_asr_api_key: 'DOUBAO_ASR_API_KEY',
    doubao_bigmodel_api_key: 'DOUBAO_BIGMODEL_API_KEY',
    tavily_api_key: 'TAVILY_API_KEY',
    openrouter_api_key: 'OPENROUTER_API_KEY',
  }
  return aliases[field] ?? field.toUpperCase()
}

/** Injected settings never trigger ambient filesystem reads. Production passes its loaded registry explicitly. */
export function capabilitiesFromSettings(settings: Settings): CapabilityRegistry {
  const needsDashscopeSearch = settings.search_mcp_url === ''
    && (settings.search_provider === 'mcp' || !settings.tavily_api_key?.trim())
  return withoutUncredentialedModules(parseCapabilityRegistry({version: 1, modules: {
    camera: {enabled: settings.camera_module_enabled},
    search: {provider: settings.search_provider, ...(settings.search_mcp_url === '' ? {} : {mcp: {
      url: settings.search_mcp_url, tool: settings.search_mcp_tool,
    }})},
  }}, {
    ...(!needsDashscopeSearch || settings.dashscope_api_key === null ? {} : {DASHSCOPE_API_KEY: settings.dashscope_api_key}),
    ...(settings.search_provider !== 'tavily' || settings.tavily_api_key === null ? {} : {TAVILY_API_KEY: settings.tavily_api_key}),
    ...(settings.search_mcp_tool === 'web_search' ? {} : {SEARCH_MCP_TOOL: settings.search_mcp_tool}),
  }), settings)
}
