import { z } from 'zod'
import { stripLikePython } from './python-text.js'

const backendSchema = z.enum(['python', 'node'])
export const proactivityPresetSchema = z.enum(['conservative', 'balanced', 'eager'])
const realtimeProviderSchema = z.enum(['qwen', 'volcengine'])
const qwenGuardHistoryRecoverySchema = z.enum(['none', 'packed'])
const qwenGuardHistoryPairsSchema = z.union([z.literal(1), z.literal(2), z.literal(4)])
const executorNameSchema = z.enum(['fast_sim', 'slow_sim', 'codex', 'ha', 'autoglm'])

export const settingsSchema = z.object({
  backend: backendSchema.default('python'),
  model_base_url: z.url().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  model_api_key: z.string().nullable().default(null),
  tavily_api_key: z.string().nullable().default(null),
  fast_model: z.string().min(1).default('qwen3-vl-plus'),
  watch_model: z.string().min(1).nullable().default(null),
  surrogate_model: z.string().min(1).default('qwen-flash'),
  compressor_model: z.string().min(1).default('qwen-flash'),
  realtime_provider: realtimeProviderSchema.default('qwen'),
  qwen_realtime_url: z.string().default('wss://dashscope.aliyuncs.com/api-ws/v1/realtime'),
  qwen_realtime_model: z.string().default('qwen-audio-3.0-realtime-plus'),
  qwen_realtime_voice: z.string().default('longanqian'),
  dashscope_api_key: z.string().nullable().default(null),
  qwen_controlled_guard_reconnect: z.boolean().default(false),
  qwen_guard_history_recovery: qwenGuardHistoryRecoverySchema.default('none'),
  qwen_guard_history_pairs: qwenGuardHistoryPairsSchema.default(4),
  executor: executorNameSchema.default('fast_sim'),
  executors: z.array(executorNameSchema).min(1),
  proactivity_preset: proactivityPresetSchema.default('balanced'),
  codex_working_interval: z.number().finite().min(5).max(600).default(30),
  suggestion_cooldown: z.number().finite().nonnegative().nullable().default(null),
  fresh_window: z.number().finite().nonnegative().nullable().default(null),
}).strict()

export type Settings = z.infer<typeof settingsSchema>

export interface QwenRealtimeConfig {
  readonly url: string
  readonly model: string
  readonly voice: string
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

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

export function loadSettings(environment: NodeJS.ProcessEnv = process.env): Settings {
  const configuredExecutor = optionalString(environment.NOVA_AUDIO_AGENT_EXECUTOR)
  const executor = configuredExecutor === undefined || configuredExecutor.length === 0
    ? 'fast_sim'
    : configuredExecutor
  const executors = parseExecutors(environment.NOVA_AUDIO_AGENT_EXECUTORS, executor)
  const candidate = {
    backend: optionalString(environment.NOVA_AUDIO_AGENT_BACKEND),
    model_base_url: optionalString(environment.NOVA_AUDIO_AGENT_MODEL_BASE_URL),
    model_api_key: optionalSecret(environment.NOVA_AUDIO_AGENT_MODEL_API_KEY),
    tavily_api_key: optionalSecret(environment.TAVILY_API_KEY),
    fast_model: optionalString(environment.NOVA_AUDIO_AGENT_FAST_MODEL),
    watch_model: optionalSecret(environment.NOVA_AUDIO_AGENT_WATCH_MODEL),
    surrogate_model: optionalString(environment.NOVA_AUDIO_AGENT_SURROGATE_MODEL),
    compressor_model: optionalString(environment.NOVA_AUDIO_AGENT_COMPRESSOR_MODEL),
    realtime_provider: optionalString(environment.NOVA_AUDIO_AGENT_REALTIME_PROVIDER),
    qwen_realtime_url: optionalString(environment.NOVA_AUDIO_AGENT_QWEN_REALTIME_URL),
    qwen_realtime_model: optionalString(environment.NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL),
    qwen_realtime_voice: optionalString(environment.NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE),
    dashscope_api_key: optionalSecret(environment.DASHSCOPE_API_KEY),
    qwen_controlled_guard_reconnect: optionalBoolean(
      environment.NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT,
    ),
    qwen_guard_history_recovery: optionalString(
      environment.NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_RECOVERY,
    ),
    qwen_guard_history_pairs: optionalQwenGuardHistoryPairs(
      environment.NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS,
    ),
    executor,
    executors,
    proactivity_preset: optionalString(environment.NOVA_AUDIO_AGENT_PROACTIVITY_PRESET),
    codex_working_interval: optionalNumber(
      environment.NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL,
      'NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL',
    ),
    suggestion_cooldown: optionalNumber(
      environment.NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN,
      'NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN',
    ),
    fresh_window: optionalNumber(
      environment.NOVA_AUDIO_AGENT_FRESH_WINDOW,
      'NOVA_AUDIO_AGENT_FRESH_WINDOW',
    ),
  }
  const withoutUndefined = Object.fromEntries(
    Object.entries(candidate).filter(([, value]) => value !== undefined),
  )
  const result = settingsSchema.safeParse(withoutUndefined)
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map(issue => String(issue.path[0] ?? 'settings')))]
      .sort(compareStrings)
      .map(field => field.toUpperCase())
    throw new ConfigurationError(`invalid configuration: ${fields.join(', ')}`)
  }
  for (const name of result.data.executors) {
    if (name === 'ha' || name === 'autoglm') {
      throw new ConfigurationError(`executor '${name}' was removed from the Node runtime`)
    }
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
  if (model.length === 0) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL 不能为空')
  }
  if (voice.length === 0) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE 不能为空')
  }
  const realtimeKey = stripLikePython(settings.dashscope_api_key ?? '')
  const modelKey = stripLikePython(settings.model_api_key ?? '')
  const apiKey = realtimeKey || modelKey
  if (apiKey.length === 0) {
    throw new ConfigurationError('缺少 DASHSCOPE_API_KEY 或 NOVA_AUDIO_AGENT_MODEL_API_KEY')
  }
  return {url, model, voice, apiKey}
}

function parseExecutors(raw: string | undefined, fallback: string): string[] {
  if (raw === undefined || raw.length === 0) return [fallback]
  const names = raw.split(',').map(stripLikePython)
  if (names.some(name => name.length === 0)) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_EXECUTORS contains an empty name')
  }
  if (new Set(names).size !== names.length) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_EXECUTORS contains duplicate names')
  }
  return names
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return stripLikePython(value)
}

function optionalSecret(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined
  return stripLikePython(value) || null
}

function optionalBoolean(value: string | undefined): boolean | string | undefined {
  if (value === undefined) return undefined
  const normalized = stripLikePython(value).toLowerCase()
  if (['true', '1', 'on', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'off', 'no', 'n'].includes(normalized)) return false
  return normalized
}

function optionalQwenGuardHistoryPairs(value: string | undefined): 1 | 2 | 4 | string | undefined {
  if (value === undefined) return undefined
  const normalized = stripLikePython(value)
  if (normalized === '1') return 1
  if (normalized === '2') return 2
  if (normalized === '4') return 4
  return normalized
}

function optionalNumber(value: string | undefined, variable: string): number | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new ConfigurationError(`${variable} must be a number`)
  }
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) throw new ConfigurationError(`${variable} must be finite`)
  return parsed
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
