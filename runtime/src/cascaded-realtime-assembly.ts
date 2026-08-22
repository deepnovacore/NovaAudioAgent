/** Provider-neutral cascaded production assembly over closed, host-owned node registries. */

import {AssemblyError, buildAssembly, type AssemblyOptions} from './assembly.js'
import {RealClock, type Clock} from './clock.js'
import type {CodexAssemblyResource} from './codex-factory.js'
import {
  ConfigurationError,
  requireCascadedCredentials,
  resolveCascadedSelection,
  type CascadedAsrProviderName,
  type CascadedEndpointingProviderName,
  type CascadedLlmProviderName,
  type CascadedTtsProviderName,
  type Settings,
} from './config.js'
import {MonotonicIdFactory, type IdFactory} from './ids.js'
import {OpenAIModelGateway, type ModelGateway} from './model-gateway.js'
import {stripLikePython} from './python-text.js'
import {
  buildRealtimeAssembly,
  type RealtimeAssembly,
  type RealtimeAssemblyOptions,
} from './realtime-assembly.js'
import {createArkCascadedLlmFactory} from './realtime/cascaded/ark-llm.js'
import type {CascadedLlmFactory} from './realtime/cascaded/llm.js'
import type {AsrClient, AsrFactory, EndpointingFactory, TtsClient, TtsFactory} from './realtime/cascaded/ports.js'
import {CascadedRealtimeError} from './realtime/cascaded/adapter.js'
import {CascadedRealtimeProvider} from './realtime/cascaded/provider.js'
import {createQwenCascadedLlmFactory} from './realtime/cascaded/qwen-llm.js'
import {FRONTEND_INSTRUCTIONS} from './realtime/qwen.js'
import {DoubaoAsrClient} from './realtime/volcengine/asr.js'
import {
  createEndpointingCapabilityFactory,
  type EndpointingCapabilityFactory,
  type LiveKitExecutor,
  type PreparedEndpointingCapability,
} from './realtime/volcengine/endpointing-capability.js'
import {LiveKitVolcEndpointing} from './realtime/volcengine/livekit-endpointing.js'
import {SilenceVolcEndpointing} from './realtime/volcengine/silence-endpointing.js'
import {DoubaoTtsClient} from './realtime/volcengine/tts.js'

const DASHSCOPE_COMPATIBLE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

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
  readonly chunkMs: number
}

export interface QwenCascadedLlmConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly instructions: string
}

export interface ArkCascadedLlmConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly instructions: string
}

export interface VolcengineTtsConfig {
  readonly endpoint: string
  readonly resourceId: string
  readonly voice: string
  readonly apiKey: string
  readonly outputSampleRate: 24_000
}

export type CascadedAsrClientFactory = (input: {
  readonly config: VolcengineAsrConfig
  readonly idFactory: () => string
}) => AsrClient

export type CascadedTtsClientFactory = (input: {
  readonly config: VolcengineTtsConfig
  readonly idFactory: () => string
}) => TtsClient

export type QwenCascadedFactory = (input: {
  readonly config: QwenCascadedLlmConfig
  readonly clock: Clock
  readonly idFactory: () => string
}) => CascadedLlmFactory

export type ArkCascadedFactory = (input: {
  readonly config: ArkCascadedLlmConfig
}) => CascadedLlmFactory

export interface BuildCascadedRealtimeAssemblyOptions
  extends Omit<
    AssemblyOptions,
    'gateway' | 'includeMemoryRecall' | 'realtimeFrontbrain'
  >, Omit<
    RealtimeAssemblyOptions,
    | 'core'
    | 'provider'
    | 'idFactory'
    | 'controlledGuardReconnect'
    | 'guardHistoryRecovery'
    | 'guardHistoryPairs'
  > {
  readonly registries?: CascadedProviderRegistries
  readonly supportGateway?: ModelGateway
  readonly endpointingCapability?: EndpointingCapabilityFactory
  readonly asrClient?: CascadedAsrClientFactory
  readonly qwenLlmFactory?: QwenCascadedFactory
  readonly arkLlmFactory?: ArkCascadedFactory
  readonly ttsClient?: CascadedTtsClientFactory
  readonly liveKitExecutor?: LiveKitExecutor
  readonly codexResource?: CodexAssemblyResource
}

export interface AutoEndpointingFactoryInput {
  readonly config: AutoEndpointingConfig
  readonly clock: Clock
  readonly capability?: EndpointingCapabilityFactory
  readonly liveKitExecutor?: LiveKitExecutor
}

export interface VolcengineAsrFactoryInput {
  readonly config: VolcengineAsrConfig
  readonly ids: IdFactory
  readonly clientFactory?: CascadedAsrClientFactory
}

export interface QwenLlmFactoryInput {
  readonly config: QwenCascadedLlmConfig
  readonly clock: Clock
  readonly ids: IdFactory
  readonly factory?: QwenCascadedFactory
}

export interface ArkLlmFactoryInput {
  readonly config: ArkCascadedLlmConfig
  readonly clock: Clock
  readonly ids: IdFactory
  readonly factory?: ArkCascadedFactory
}

export interface VolcengineTtsFactoryInput {
  readonly config: VolcengineTtsConfig
  readonly ids: IdFactory
  readonly clientFactory?: CascadedTtsClientFactory
}

export interface CascadedProviderRegistries {
  readonly endpointing: Readonly<Record<
    CascadedEndpointingProviderName,
    (input: AutoEndpointingFactoryInput) => EndpointingFactory
  >>
  readonly asr: Readonly<Record<
    CascadedAsrProviderName,
    (input: VolcengineAsrFactoryInput) => AsrFactory
  >>
  readonly llm: Readonly<{
    readonly qwen: (input: QwenLlmFactoryInput) => CascadedLlmFactory
    readonly ark: (input: ArkLlmFactoryInput) => CascadedLlmFactory
  }>
  readonly tts: Readonly<Record<
    CascadedTtsProviderName,
    (input: VolcengineTtsFactoryInput) => TtsFactory
  >>
}

export const cascadedProviderRegistries: CascadedProviderRegistries = Object.freeze({
  endpointing: Object.freeze({
    auto: (input: AutoEndpointingFactoryInput) => {
      const capability = input.capability
        ?? createEndpointingCapabilityFactory({
          clock: input.clock,
          ...(input.liveKitExecutor === undefined
            ? {}
            : {executor: input.liveKitExecutor}),
        })
      return async (request: Parameters<EndpointingFactory>[0]) => (
        buildEndpointing(await capability(request), input.config)
      )
    },
  }),
  asr: Object.freeze({
    volcengine: (input: VolcengineAsrFactoryInput) => ({
      openClient: () => (input.clientFactory ?? defaultAsrClient)({
        config: input.config,
        idFactory: () => input.ids.next('volcengine'),
      }),
    }),
  }),
  llm: Object.freeze({
    qwen: (input: QwenLlmFactoryInput) => (
      input.factory ?? defaultQwenLlmFactory
    )({
      config: input.config,
      clock: input.clock,
      idFactory: () => input.ids.next('qwen-cascaded'),
    }),
    ark: (input: ArkLlmFactoryInput) => (
      input.factory ?? defaultArkLlmFactory
    )({
      config: input.config,
    }),
  }),
  tts: Object.freeze({
    volcengine: (input: VolcengineTtsFactoryInput) => ({
      openClient: () => (input.clientFactory ?? defaultTtsClient)({
        config: input.config,
        idFactory: () => input.ids.next('volcengine'),
      }),
    }),
  }),
})

export function buildCascadedRealtimeAssembly(
  options: BuildCascadedRealtimeAssemblyOptions,
  registry: CascadedProviderRegistries = options.registries ?? cascadedProviderRegistries,
): RealtimeAssembly {
  const selection = resolveCascadedSelection(options.settings)
  const credentials = requireCascadedCredentials(options.settings, selection)
  validateCodexResource(options)
  const clock = options.clock ?? new RealClock()
  const ids = options.ids ?? new MonotonicIdFactory()

  const endpointingConfig = resolveEndpointingConfig(options.settings)
  const asrConfig = resolveAsrConfig(options.settings, credentials.asrApiKey)
  const llmConfig = selection.llmProvider === 'qwen'
    ? resolveQwenLlmConfig(selection.llmModel, credentials.llmApiKey)
    : resolveArkLlmConfig(options.settings, selection.llmModel, credentials.llmApiKey)
  const ttsConfig = resolveTtsConfig(options.settings, credentials.ttsApiKey)

  const endpointingFactory = registry.endpointing[selection.endpointingProvider]({
    config: endpointingConfig,
    clock,
    ...(options.endpointingCapability === undefined
      ? {}
      : {capability: options.endpointingCapability}),
    ...(options.liveKitExecutor === undefined ? {} : {liveKitExecutor: options.liveKitExecutor}),
  })
  const asrFactory = registry.asr[selection.asrProvider]({
    config: asrConfig,
    ids,
    ...(options.asrClient === undefined ? {} : {clientFactory: options.asrClient}),
  })
  const llmFactory = selection.llmProvider === 'qwen'
    ? registry.llm.qwen({
      config: llmConfig,
      clock,
      ids,
      ...(options.qwenLlmFactory === undefined ? {} : {factory: options.qwenLlmFactory}),
    })
    : registry.llm.ark({
      config: llmConfig,
      clock,
      ids,
      ...(options.arkLlmFactory === undefined ? {} : {factory: options.arkLlmFactory}),
    })
  const ttsFactory = registry.tts[selection.ttsProvider]({
    config: ttsConfig,
    ids,
    ...(options.ttsClient === undefined ? {} : {clientFactory: options.ttsClient}),
  })

  const support = supportComposition(
    options,
    selection.llmProvider,
    selection.llmModel,
    credentials.llmApiKey,
    clock,
  )
  const core = buildAssembly({
    settings: support.settings,
    clock,
    ids,
    gateway: support.gateway,
    realtimeFrontbrain: true,
    ...(options.sink === undefined ? {} : {sink: options.sink}),
    ...(options.metrics === undefined ? {} : {metrics: options.metrics}),
    ...(options.media === undefined ? {} : {media: options.media}),
    ...((options.executors === undefined && options.codexResource === undefined)
      ? {}
      : {executors: [
        ...(options.executors ?? []),
        ...(options.codexResource === undefined ? [] : [options.codexResource.adapter]),
      ]}),
    ...(options.searchTransport === undefined ? {} : {searchTransport: options.searchTransport}),
    ...(options.frameSource === undefined ? {} : {frameSource: options.frameSource}),
    ...(options.mediaStore === undefined ? {} : {mediaStore: options.mediaStore}),
  })
  const provider = new CascadedRealtimeProvider({
    endpointingFactory,
    asrFactory,
    llmFactory,
    ttsFactory,
    ...(options.telemetry === undefined ? {} : {telemetry: options.telemetry}),
    idFactory: () => ids.next('cascaded'),
  })
  return buildRealtimeAssembly({
    core,
    provider,
    idFactory: () => ids.next('realtime'),
    controlledGuardReconnect: false,
    guardHistoryRecovery: 'none',
    guardHistoryPairs: 4,
    ...(options.providerToolView === undefined ? {} : {providerToolView: options.providerToolView}),
    ...(options.onAudioFrame === undefined ? {} : {onAudioFrame: options.onAudioFrame}),
    ...(options.onAudioClear === undefined ? {} : {onAudioClear: options.onAudioClear}),
    ...(options.onAudioAlert === undefined ? {} : {onAudioAlert: options.onAudioAlert}),
    ...(options.onAudioTerminal === undefined ? {} : {onAudioTerminal: options.onAudioTerminal}),
    ...(options.onSpoken === undefined ? {} : {onSpoken: options.onSpoken}),
    ...(options.onDelivery === undefined ? {} : {onDelivery: options.onDelivery}),
    ...(options.onCaption === undefined ? {} : {onCaption: options.onCaption}),
    ...(options.onCodexState === undefined ? {} : {onCodexState: options.onCodexState}),
    ...(options.onProjectView === undefined ? {} : {onProjectView: options.onProjectView}),
    ...(options.telemetry === undefined ? {} : {telemetry: options.telemetry}),
    ...(options.onDiagnostic === undefined ? {} : {onDiagnostic: options.onDiagnostic}),
    ...(options.projectConfirmation === undefined
      ? {}
      : {projectConfirmation: options.projectConfirmation}),
    ...(options.commitProjectOperation === undefined
      ? {}
      : {commitProjectOperation: options.commitProjectOperation}),
    ...(options.projectExpiryStepTimeoutMs === undefined
      ? {}
      : {projectExpiryStepTimeoutMs: options.projectExpiryStepTimeoutMs}),
    ...(options.codexResource === undefined ? {} : {codexResource: options.codexResource}),
  })
}

function resolveEndpointingConfig(settings: Settings): AutoEndpointingConfig {
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

function resolveAsrConfig(settings: Settings, apiKey: string): VolcengineAsrConfig {
  if (settings.doubao_asr_chunk_ms <= 0) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_DOUBAO_ASR_CHUNK_MS 必须为正整数')
  }
  return Object.freeze({
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

function resolveQwenLlmConfig(model: string, apiKey: string): QwenCascadedLlmConfig {
  return Object.freeze({
    baseUrl: DASHSCOPE_COMPATIBLE_BASE_URL,
    apiKey,
    model,
    instructions: FRONTEND_INSTRUCTIONS,
  })
}

function resolveArkLlmConfig(
  settings: Settings,
  model: string,
  apiKey: string,
): ArkCascadedLlmConfig {
  return Object.freeze({
    baseUrl: secureEndpoint(
      settings.volcengine_ark_base_url,
      'https',
      'NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL',
    ),
    apiKey,
    model,
    instructions: FRONTEND_INSTRUCTIONS,
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

function supportComposition(
  options: BuildCascadedRealtimeAssemblyOptions,
  provider: CascadedLlmProviderName,
  model: string,
  llmApiKey: string,
  clock: Clock,
): {readonly settings: Settings; readonly gateway: ModelGateway} {
  if (options.supportGateway !== undefined) {
    return {settings: options.settings, gateway: options.supportGateway}
  }
  const genericKey = stripLikePython(options.settings.model_api_key ?? '')
  if (genericKey !== '') {
    return {
      settings: options.settings,
      gateway: new OpenAIModelGateway({
        baseUrl: secureEndpoint(
          options.settings.model_base_url,
          'https',
          'NOVA_AUDIO_AGENT_MODEL_BASE_URL',
        ),
        apiKey: genericKey,
        clock,
        ...(options.metrics === undefined ? {} : {metrics: options.metrics}),
      }),
    }
  }
  const baseUrl = provider === 'qwen'
    ? DASHSCOPE_COMPATIBLE_BASE_URL
    : secureEndpoint(
      options.settings.volcengine_ark_base_url,
      'https',
      'NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL',
    )
  const watchModel = stripLikePython(options.settings.watch_model ?? '')
    || (provider === 'qwen' ? 'qwen3-vl-plus' : model)
  const settings = Object.create(options.settings) as Settings
  Object.assign(settings, {
    watch_model: watchModel,
    surrogate_model: model,
    compressor_model: model,
  })
  Object.freeze(settings)
  return {
    settings,
    gateway: new OpenAIModelGateway({
      baseUrl,
      apiKey: llmApiKey,
      clock,
      ...(options.metrics === undefined ? {} : {metrics: options.metrics}),
    }),
  }
}

function validateCodexResource(options: BuildCascadedRealtimeAssemblyOptions): void {
  const selected = options.settings.executors.includes('codex')
  if (selected !== (options.codexResource !== undefined)) {
    throw new AssemblyError('realtime Codex resource selection mismatch')
  }
  if (options.codexResource?.mode === 'ordinary') {
    throw new AssemblyError('ordinary Codex resource cannot enter realtime composition')
  }
  if (options.codexResource !== undefined
    && options.settings.codex_projects_enabled !== (options.codexResource.mode === 'project')) {
    throw new AssemblyError('realtime Codex project mode mismatch')
  }
}

function buildEndpointing(
  prepared: PreparedEndpointingCapability,
  config: AutoEndpointingConfig,
): LiveKitVolcEndpointing | SilenceVolcEndpointing {
  if (prepared.result.mode !== 'livekit_v1_mini') return new SilenceVolcEndpointing(config)
  if (prepared.surface === undefined || prepared.executor === undefined) {
    throw new CascadedRealtimeError('configuration')
  }
  return new LiveKitVolcEndpointing({
    surface: prepared.surface,
    executor: prepared.executor,
    config,
  })
}

const defaultAsrClient: CascadedAsrClientFactory = input => new DoubaoAsrClient({
  endpoint: input.config.endpoint,
  apiKey: input.config.apiKey,
  resourceId: input.config.resourceId,
  chunkMs: input.config.chunkMs,
  idFactory: input.idFactory,
})

const defaultTtsClient: CascadedTtsClientFactory = input => new DoubaoTtsClient({
  endpoint: input.config.endpoint,
  apiKey: input.config.apiKey,
  resourceId: input.config.resourceId,
  voice: input.config.voice,
  outputSampleRate: input.config.outputSampleRate,
  idFactory: input.idFactory,
})

const defaultQwenLlmFactory: QwenCascadedFactory = input => createQwenCascadedLlmFactory({
  ...input.config,
  clock: input.clock,
  idFactory: input.idFactory,
})

const defaultArkLlmFactory: ArkCascadedFactory = input => createArkCascadedLlmFactory(input.config)

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
