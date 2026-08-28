/** Provider-neutral cascaded production assembly over closed, host-owned node registries. */

import {AssemblyError, buildAssembly, type AssemblyOptions} from './assembly.js'
import {
  requireSelectedCascadedRealtimeConfig,
  type ArkCascadedLlmConfig,
  type AutoEndpointingConfig,
  type QwenCascadedLlmConfig,
  type VolcengineAsrConfig,
  type VolcengineTtsConfig,
} from './cascaded-realtime-config.js'
import {RealClock, type Clock} from './clock.js'
import type {CodexAssemblyResource} from './codex-factory.js'
import {
  resolveSupportModelConnection,
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
import {workspaceGraphServiceFromSettings} from './workspace-graph/factory.js'

export type {
  ArkCascadedLlmConfig,
  AutoEndpointingConfig,
  QwenCascadedLlmConfig,
  VolcengineAsrConfig,
  VolcengineTtsConfig,
} from './cascaded-realtime-config.js'

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
  const selected = requireSelectedCascadedRealtimeConfig(options.settings)
  const selection = selected.selection
  validateCodexResource(options)
  const clock = options.clock ?? new RealClock()
  const ids = options.ids ?? new MonotonicIdFactory()

  const endpointingFactory = registry.endpointing[selection.endpointingProvider]({
    config: selected.endpointing,
    clock,
    ...(options.endpointingCapability === undefined
      ? {}
      : {capability: options.endpointingCapability}),
    ...(options.liveKitExecutor === undefined ? {} : {liveKitExecutor: options.liveKitExecutor}),
  })
  const asrFactory = registry.asr[selection.asrProvider]({
    config: selected.asr,
    ids,
    ...(options.asrClient === undefined ? {} : {clientFactory: options.asrClient}),
  })
  const llmFactory = selected.llm.provider === 'qwen'
    ? registry.llm.qwen({
      config: selected.llm.config,
      clock,
      ids,
      ...(options.qwenLlmFactory === undefined ? {} : {factory: options.qwenLlmFactory}),
    })
    : registry.llm.ark({
      config: selected.llm.config,
      clock,
      ids,
      ...(options.arkLlmFactory === undefined ? {} : {factory: options.arkLlmFactory}),
  })
  const ttsFactory = registry.tts[selection.ttsProvider]({
    config: selected.tts,
    ids,
    ...(options.ttsClient === undefined ? {} : {clientFactory: options.ttsClient}),
  })

  const support = supportComposition(
    options,
    selection.llmProvider,
    selection.llmModel,
    selected.llm.config.apiKey,
    selected.llm.config.baseUrl,
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
    ...(options.telemetry === undefined ? {} : {telemetry: options.telemetry}),
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
  const workspaceGraph = workspaceGraphServiceFromSettings(
    options.settings,
    code => {
      if (code === 'workspace_graph_open_failed') return
      try { options.onDiagnostic?.(`[realtime-diagnostic] ${code}`) } catch { /* advisory */ }
    },
  )
  return buildRealtimeAssembly({
    core,
    provider,
    idFactory: () => ids.next('realtime'),
    controlledGuardReconnect: false,
    guardHistoryRecovery: 'none',
    guardHistoryPairs: 4,
    ...(workspaceGraph === undefined ? {} : {workspaceGraph}),
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

function supportComposition(
  options: BuildCascadedRealtimeAssemblyOptions,
  provider: CascadedLlmProviderName,
  model: string,
  llmApiKey: string,
  selectedBaseUrl: string,
  clock: Clock,
): {readonly settings: Settings; readonly gateway: ModelGateway} {
  if (options.supportGateway !== undefined) {
    return {settings: options.settings, gateway: options.supportGateway}
  }
  const connection = resolveSupportModelConnection(options.settings, {
    baseUrl: selectedBaseUrl,
    apiKey: llmApiKey,
  })
  if (connection.source === 'generic') {
    return {
      settings: options.settings,
      gateway: new OpenAIModelGateway({
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        clock,
        ...(options.metrics === undefined ? {} : {metrics: options.metrics}),
      }),
    }
  }
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
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
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
  if (options.codexResource !== undefined && options.codexResource.mode !== 'project') {
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
  instructions: FRONTEND_INSTRUCTIONS,
  clock: input.clock,
  idFactory: input.idFactory,
})

const defaultArkLlmFactory: ArkCascadedFactory = input => createArkCascadedLlmFactory({
  ...input.config,
  instructions: FRONTEND_INSTRUCTIONS,
})
