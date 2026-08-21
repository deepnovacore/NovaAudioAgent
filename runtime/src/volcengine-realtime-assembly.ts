/** Production Volcengine composition above the provider-neutral realtime owner. */

import {AssemblyError, buildAssembly, type AssemblyOptions} from './assembly.js'
import type {CodexAssemblyResource} from './codex-factory.js'
import {RealClock} from './clock.js'
import {requireVolcengineRealtime, type Settings} from './config.js'
import {MonotonicIdFactory} from './ids.js'
import {OpenAIModelGateway} from './model-gateway.js'
import {
  buildRealtimeAssembly,
  type RealtimeAssembly,
  type RealtimeAssemblyOptions,
} from './realtime-assembly.js'
import {FRONTEND_INSTRUCTIONS} from './realtime/qwen.js'
import {DoubaoAsrClient} from './realtime/volcengine/asr.js'
import {createFetchArkResponsesGateway} from './realtime/volcengine/ark.js'
import {
  createEndpointingCapabilityFactory,
  VolcengineRealtimeProvider,
  type ArkResponsesGatewayFactory,
  type DoubaoAsrClientFactory,
  type DoubaoTtsClientFactory,
  type EndpointingCapabilityFactory,
} from './realtime/volcengine/provider.js'
import {DoubaoTtsClient} from './realtime/volcengine/tts.js'
import type {LiveKitExecutor} from './realtime/volcengine/endpointing-capability.js'
import {stripLikePython} from './python-text.js'

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
  const volc = requireVolcengineRealtime(options.settings)
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
  const provider = new VolcengineRealtimeProvider({
    config: volc,
    endpointingCapability: options.endpointingCapability
      ?? createEndpointingCapabilityFactory({
        clock,
        ...(options.liveKitExecutor === undefined ? {} : {executor: options.liveKitExecutor}),
      }),
    asrClient: options.asrClient ?? defaultAsrClient,
    ttsClient: options.ttsClient ?? defaultTtsClient,
    arkFactory: options.arkFactory ?? defaultArkFactory,
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
