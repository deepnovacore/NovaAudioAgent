/** Production Volcengine composition above the provider-neutral realtime owner. */

import {AssemblyError, buildAssembly, type AssemblyOptions} from './assembly.js'
import type {CodexAssemblyResource} from './codex-factory.js'
import {RealClock} from './clock.js'
import {
  requireVolcengineRealtime,
  type Settings,
  type VolcengineRealtimeConfig,
} from './config.js'
import {MonotonicIdFactory} from './ids.js'
import {OpenAIModelGateway} from './model-gateway.js'
import {
  buildRealtimeAssembly,
  type RealtimeAssembly,
  type RealtimeAssemblyOptions,
} from './realtime-assembly.js'
import {FRONTEND_INSTRUCTIONS} from './realtime/qwen.js'
import {createArkCascadedLlmSession} from './realtime/cascaded/ark-llm.js'
import {CascadedRealtimeError} from './realtime/cascaded/adapter.js'
import {CascadedRealtimeProvider} from './realtime/cascaded/provider.js'
import type {AsrClient, EndpointingFactory, TtsClient} from './realtime/cascaded/ports.js'
import {DoubaoAsrClient} from './realtime/volcengine/asr.js'
import {
  createFetchArkResponsesGateway,
  type ArkResponsesGateway,
} from './realtime/volcengine/ark.js'
import {
  createEndpointingCapabilityFactory,
  type EndpointingCapabilityFactory,
  type PreparedEndpointingCapability,
} from './realtime/volcengine/endpointing-capability.js'
import {LiveKitVolcEndpointing} from './realtime/volcengine/livekit-endpointing.js'
import {SilenceVolcEndpointing} from './realtime/volcengine/silence-endpointing.js'
import {DoubaoTtsClient} from './realtime/volcengine/tts.js'
import type {LiveKitExecutor} from './realtime/volcengine/endpointing-capability.js'
import {stripLikePython} from './python-text.js'

export type DoubaoAsrClientFactory = (input: {
  readonly config: VolcengineRealtimeConfig
  readonly idFactory: () => string
}) => AsrClient

export type DoubaoTtsClientFactory = (input: {
  readonly config: VolcengineRealtimeConfig
  readonly idFactory: () => string
}) => TtsClient

export type ArkResponsesGatewayFactory = (input: {
  readonly config: VolcengineRealtimeConfig
}) => ArkResponsesGateway

export interface BuildVolcengineRealtimeAssemblyOptions
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
  readonly endpointingCapability?: EndpointingCapabilityFactory
  readonly asrClient?: DoubaoAsrClientFactory
  readonly ttsClient?: DoubaoTtsClientFactory
  readonly arkFactory?: ArkResponsesGatewayFactory
  readonly liveKitExecutor?: LiveKitExecutor
  readonly codexResource?: CodexAssemblyResource
}

export function buildVolcengineRealtimeAssembly(
  options: BuildVolcengineRealtimeAssemblyOptions,
): RealtimeAssembly {
  const volc = Object.freeze({...requireVolcengineRealtime(options.settings)})
  validateCodexResource(options)
  const clock = options.clock ?? new RealClock()
  const ids = options.ids ?? new MonotonicIdFactory()
  const genericKey = stripLikePython(options.settings.model_api_key ?? '')
  const coreSettings = genericKey === ''
    ? supportModelSettings(options.settings, volc.arkSupportModel)
    : options.settings
  const gateway = new OpenAIModelGateway({
    baseUrl: genericKey === '' ? volc.arkBaseUrl : options.settings.model_base_url,
    apiKey: genericKey === '' ? volc.arkApiKey : genericKey,
    clock,
    ...(options.metrics === undefined ? {} : {metrics: options.metrics}),
  })
  const core = buildAssembly({
    settings: coreSettings,
    clock,
    ids,
    gateway,
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
  const endpointingCapability = options.endpointingCapability
    ?? createEndpointingCapabilityFactory({
        clock,
        ...(options.liveKitExecutor === undefined ? {} : {executor: options.liveKitExecutor}),
      })
  const asrClient = options.asrClient ?? defaultAsrClient
  const ttsClient = options.ttsClient ?? defaultTtsClient
  const arkFactory = options.arkFactory ?? defaultArkFactory
  const provider = new CascadedRealtimeProvider({
    endpointingFactory: volcengineEndpointingFactory(volc, endpointingCapability),
    asrFactory: {openClient: () => asrClient({
      config: volc, idFactory: () => ids.next('volcengine'),
    })},
    llmFactory: {open: () => createArkCascadedLlmSession(arkFactory({config: volc}))},
    ttsFactory: {openClient: () => ttsClient({
      config: volc, idFactory: () => ids.next('volcengine'),
    })},
    ...(options.telemetry === undefined ? {} : {telemetry: options.telemetry}),
    idFactory: () => ids.next('volcengine'),
  })
  return buildRealtimeAssembly({
    core,
    provider,
    idFactory: () => ids.next('realtime'),
    controlledGuardReconnect: false,
    guardHistoryRecovery: 'none',
    guardHistoryPairs: 4,
    ...(options.providerToolView === undefined
      ? {}
      : {providerToolView: options.providerToolView}),
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

function validateCodexResource(options: BuildVolcengineRealtimeAssemblyOptions): void {
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

function supportModelSettings(settings: Settings, model: string): Settings {
  return Object.freeze({
    ...settings,
    watch_model: model,
    surrogate_model: model,
    compressor_model: model,
  })
}

function volcengineEndpointingFactory(
  config: VolcengineRealtimeConfig,
  capability: EndpointingCapabilityFactory,
): EndpointingFactory {
  return async input => buildEndpointing(await capability(input), config)
}

function buildEndpointing(
  prepared: PreparedEndpointingCapability,
  config: VolcengineRealtimeConfig,
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

const defaultAsrClient: DoubaoAsrClientFactory = ({config, idFactory}) => new DoubaoAsrClient({
  endpoint: config.asrEndpoint,
  apiKey: config.asrApiKey,
  resourceId: config.asrResourceId,
  chunkMs: config.asrChunkMs,
  idFactory,
})

const defaultTtsClient: DoubaoTtsClientFactory = ({config, idFactory}) => new DoubaoTtsClient({
  endpoint: config.ttsEndpoint,
  apiKey: config.ttsApiKey,
  resourceId: config.ttsResourceId,
  voice: config.ttsVoice,
  outputSampleRate: config.ttsOutputSampleRate,
  idFactory,
})

const defaultArkFactory: ArkResponsesGatewayFactory = ({config}) => createFetchArkResponsesGateway({
  baseUrl: config.arkBaseUrl,
  apiKey: config.arkApiKey,
  model: config.arkModel,
  instructions: FRONTEND_INSTRUCTIONS,
})
