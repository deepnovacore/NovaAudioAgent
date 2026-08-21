import type {Clock} from '../../clock.js'
import type {VolcengineRealtimeConfig} from '../../config.js'
import type {
  HostContextItem,
  HostResponseIntent,
  JsonObject,
  RealtimeProvider,
  SessionIdentity,
} from '../protocol.js'
import type {RealtimeTelemetry} from '../telemetry.js'
import {
  VolcengineCascadedAdapter,
  VolcengineRealtimeError,
  type VolcAsrClient,
  type VolcEndpointingPort,
  type VolcTtsClient,
} from './adapter.js'
import type {ArkResponsesGateway} from './ark.js'
import {
  probeEndpointingCapability,
  type EndpointingCapabilityResult,
  type LiveKitAgentsPublicSurface,
  type LiveKitExecutor,
} from './endpointing-capability.js'
import {LiveKitVolcEndpointing} from './livekit-endpointing.js'
import {SilenceVolcEndpointing} from './silence-endpointing.js'

export interface PreparedEndpointingCapability {
  readonly result: EndpointingCapabilityResult
  readonly surface?: LiveKitAgentsPublicSurface
  readonly executor?: LiveKitExecutor
}

export type EndpointingCapabilityFactory = (input: {
  readonly signal: AbortSignal
  readonly telemetry?: RealtimeTelemetry
}) => Promise<PreparedEndpointingCapability>

export type DoubaoAsrClientFactory = (input: {
  readonly config: VolcengineRealtimeConfig
  readonly idFactory: () => string
}) => VolcAsrClient

export type DoubaoTtsClientFactory = (input: {
  readonly config: VolcengineRealtimeConfig
  readonly idFactory: () => string
}) => VolcTtsClient

export type ArkResponsesGatewayFactory = (input: {
  readonly config: VolcengineRealtimeConfig
}) => ArkResponsesGateway

export interface VolcengineRealtimeProviderOptions {
  readonly config: VolcengineRealtimeConfig
  readonly endpointingCapability: EndpointingCapabilityFactory
  readonly asrClient: DoubaoAsrClientFactory
  readonly ttsClient: DoubaoTtsClientFactory
  readonly arkFactory: ArkResponsesGatewayFactory
  readonly telemetry?: RealtimeTelemetry
  readonly idFactory: () => string
}

type ProviderState = 'disconnected' | 'connecting' | 'connected' | 'closing'

/** Lazy owner that creates one complete cascaded provider epoch per successful connect. */
export class VolcengineRealtimeProvider implements RealtimeProvider {
  readonly #config: VolcengineRealtimeConfig
  readonly #capability: EndpointingCapabilityFactory
  readonly #asrClient: DoubaoAsrClientFactory
  readonly #ttsClient: DoubaoTtsClientFactory
  readonly #arkFactory: ArkResponsesGatewayFactory
  readonly #telemetry: RealtimeTelemetry | undefined
  readonly #idFactory: () => string
  #state: ProviderState = 'disconnected'
  #adapter: VolcengineCascadedAdapter | null = null
  #endpointing: VolcEndpointingPort | null = null
  #closePromise: Promise<void> | null = null
  #lastEpoch = 0
  #connectController: AbortController | null = null
  #connectSettled: Promise<void> | null = null

  constructor(options: VolcengineRealtimeProviderOptions) {
    this.#config = Object.freeze({...options.config})
    this.#capability = options.endpointingCapability
    this.#asrClient = options.asrClient
    this.#ttsClient = options.ttsClient
    this.#arkFactory = options.arkFactory
    this.#telemetry = options.telemetry
    this.#idFactory = options.idFactory
  }

  async connect(options: {
    readonly tools: readonly JsonObject[]
    readonly signal: AbortSignal
  }): Promise<SessionIdentity> {
    if (this.#state !== 'disconnected') throw new VolcengineRealtimeError('state')
    if (options.signal.aborted) throw abortReason(options.signal)
    this.#state = 'connecting'
    this.#closePromise = null
    const controller = new AbortController()
    const signal = AbortSignal.any([options.signal, controller.signal])
    this.#connectController = controller
    let settleConnect: (() => void) | undefined
    const settled = new Promise<void>(resolve => { settleConnect = resolve })
    this.#connectSettled = settled
    let endpointing: VolcEndpointingPort | null = null
    let adapter: VolcengineCascadedAdapter | null = null
    try {
      const prepared = await this.#capability({
        signal,
        ...(this.#telemetry === undefined ? {} : {telemetry: this.#telemetry}),
      })
      if (signal.aborted) throw abortReason(signal)
      endpointing = buildEndpointing(prepared, this.#config)
      const asr = this.#asrClient({config: this.#config, idFactory: this.#idFactory})
      const tts = this.#ttsClient({config: this.#config, idFactory: this.#idFactory})
      adapter = new VolcengineCascadedAdapter({
        endpointing,
        asr,
        tts,
        arkFactory: () => this.#arkFactory({config: this.#config}),
        ...(this.#telemetry === undefined ? {} : {telemetry: this.#telemetry}),
        idFactory: this.#idFactory,
        initialEpoch: this.#lastEpoch,
      })
      this.#endpointing = endpointing
      this.#adapter = adapter
      const identity = await adapter.connect({tools: options.tools, signal})
      if (signal.aborted || this.#state !== 'connecting' || this.#adapter !== adapter) {
        throw new VolcengineRealtimeError('state')
      }
      this.#lastEpoch = identity.epoch
      this.#state = 'connected'
      return identity
    } catch (error) {
      try {
        await closeEpochResources(adapter, endpointing)
      } finally {
        if (this.#adapter === adapter) this.#adapter = null
        if (this.#endpointing === endpointing) this.#endpointing = null
        this.#finishConnectFailure()
      }
      throw error
    } finally {
      if (this.#connectController === controller) this.#connectController = null
      if (this.#connectSettled === settled) this.#connectSettled = null
      settleConnect?.()
    }
  }

  sendAudio(pcm: Uint8Array, signal: AbortSignal): Promise<void> {
    return this.#requiredAdapter().sendAudio(pcm, signal)
  }

  injectHostItem(item: HostContextItem, options: {
    readonly confirmationTimeout: number | null
    readonly asUserActivation: boolean
    readonly signal: AbortSignal
  }): Promise<unknown> {
    return this.#requiredAdapter().injectHostItem(item, options)
  }

  createResponse(intent: HostResponseIntent, signal: AbortSignal): Promise<void> {
    return this.#requiredAdapter().createResponse(intent, signal)
  }

  cancelResponse(responseId: string, signal: AbortSignal): Promise<void> {
    return this.#requiredAdapter().cancelResponse(responseId, signal)
  }

  events(signal: AbortSignal): AsyncIterable<unknown> {
    return this.#requiredAdapter().events(signal)
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    if (this.#state === 'disconnected') return Promise.resolve()
    this.#state = 'closing'
    const connecting = this.#connectSettled
    this.#connectController?.abort()
    this.#closePromise = (async () => {
      if (connecting !== null) await connecting
      const adapter = this.#adapter
      const endpointing = this.#endpointing
      this.#adapter = null
      this.#endpointing = null
      await closeEpochResources(adapter, endpointing)
    })().finally(() => { this.#state = 'disconnected' })
    return this.#closePromise
  }

  #requiredAdapter(): VolcengineCascadedAdapter {
    if (this.#state !== 'connected' || this.#adapter === null) {
      throw new VolcengineRealtimeError('state')
    }
    return this.#adapter
  }

  #finishConnectFailure(): void {
    if (this.#state !== 'closing') this.#state = 'disconnected'
  }
}

export function createEndpointingCapabilityFactory(options: {
  readonly executor?: LiveKitExecutor
  readonly clock?: Clock
} = {}): EndpointingCapabilityFactory {
  return async input => {
    let surface: LiveKitAgentsPublicSurface | undefined
    const loader = async (): Promise<LiveKitAgentsPublicSurface> => {
      surface ??= await import('@livekit/agents') as unknown as LiveKitAgentsPublicSurface
      return surface
    }
    const result = await probeEndpointingCapability({
      signal: input.signal,
      agentsLoader: loader,
      ...(options.executor === undefined ? {} : {executor: options.executor}),
      ...(options.clock === undefined ? {} : {clock: options.clock}),
      ...(input.telemetry === undefined ? {} : {telemetry: input.telemetry}),
    })
    if (result.mode !== 'livekit_v1_mini') return {result}
    const loaded = surface ?? await loader()
    const executor = options.executor ?? loaded.getJobContext(false)?.inferenceExecutor
    return {
      result,
      surface: loaded,
      ...(executor === undefined ? {} : {executor}),
    }
  }
}

function buildEndpointing(
  prepared: PreparedEndpointingCapability,
  config: VolcengineRealtimeConfig,
): VolcEndpointingPort {
  if (prepared.result.mode !== 'livekit_v1_mini') return new SilenceVolcEndpointing(config)
  if (prepared.surface === undefined || prepared.executor === undefined) {
    throw new VolcengineRealtimeError('configuration')
  }
  return new LiveKitVolcEndpointing({
    surface: prepared.surface,
    executor: prepared.executor,
    config,
  })
}

async function closeEpochResources(
  adapter: VolcengineCascadedAdapter | null,
  endpointing: VolcEndpointingPort | null,
): Promise<void> {
  let failure: unknown
  if (adapter !== null) {
    try { await adapter.close() } catch (error) { failure = error }
  }
  if (endpointing !== null) {
    try { await endpointing.close() } catch (error) { failure ??= error }
  }
  if (failure !== undefined) throw new VolcengineRealtimeError('closed')
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason : new DOMException('This operation was aborted', 'AbortError')
}
