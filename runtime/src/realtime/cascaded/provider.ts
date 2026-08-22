import type {
  HostContextItem,
  HostResponseIntent,
  JsonObject,
  RealtimeProvider,
  SessionIdentity,
} from '../protocol.js'
import type {RealtimeTelemetry} from '../telemetry.js'
import {
  CascadedRealtimeAdapter,
  CascadedRealtimeError,
} from './adapter.js'
import type {CascadedLlmFactory, CascadedLlmSession} from './llm.js'
import type {
  AsrFactory,
  EndpointingFactory,
  EndpointingPort,
  TtsFactory,
} from './ports.js'

export interface CascadedRealtimeProviderOptions {
  readonly endpointingFactory: EndpointingFactory
  readonly asrFactory: AsrFactory
  readonly llmFactory: CascadedLlmFactory
  readonly ttsFactory: TtsFactory
  readonly telemetry?: RealtimeTelemetry
  readonly idFactory: () => string
}

type ProviderState = 'disconnected' | 'connecting' | 'connected' | 'closing'

/** Lazily owns one complete, independently fenced cascaded epoch per successful connect. */
export class CascadedRealtimeProvider implements RealtimeProvider {
  readonly #endpointingFactory: EndpointingFactory
  readonly #asrFactory: AsrFactory
  readonly #llmFactory: CascadedLlmFactory
  readonly #ttsFactory: TtsFactory
  readonly #telemetry: RealtimeTelemetry | undefined
  readonly #idFactory: () => string
  #state: ProviderState = 'disconnected'
  #adapter: CascadedRealtimeAdapter | null = null
  #endpointing: EndpointingPort | null = null
  #closePromise: Promise<void> | null = null
  #lastEpoch = 0
  #connectController: AbortController | null = null
  #connectSettled: Promise<void> | null = null

  constructor(options: CascadedRealtimeProviderOptions) {
    this.#endpointingFactory = options.endpointingFactory
    this.#asrFactory = options.asrFactory
    this.#llmFactory = options.llmFactory
    this.#ttsFactory = options.ttsFactory
    this.#telemetry = options.telemetry
    this.#idFactory = options.idFactory
  }

  async connect(options: {
    readonly tools: readonly JsonObject[]
    readonly signal: AbortSignal
  }): Promise<SessionIdentity> {
    if (this.#state !== 'disconnected') throw new CascadedRealtimeError('state')
    if (options.signal.aborted) throw abortReason(options.signal)
    this.#state = 'connecting'
    this.#closePromise = null
    const controller = new AbortController()
    const signal = AbortSignal.any([options.signal, controller.signal])
    this.#connectController = controller
    let settleConnect: (() => void) | undefined
    const settled = new Promise<void>(resolve => { settleConnect = resolve })
    this.#connectSettled = settled
    let endpointing: EndpointingPort | null = null
    let llm: CascadedLlmSession | null = null
    let adapter: CascadedRealtimeAdapter | null = null
    try {
      endpointing = await this.#endpointingFactory({
        signal,
        ...(this.#telemetry === undefined ? {} : {telemetry: this.#telemetry}),
      })
      if (signal.aborted) throw abortReason(signal)
      const asr = this.#asrFactory.openClient()
      if (signal.aborted) throw abortReason(signal)
      llm = this.#llmFactory.open()
      if (signal.aborted) throw abortReason(signal)
      const tts = this.#ttsFactory.openClient()
      if (signal.aborted) throw abortReason(signal)
      adapter = new CascadedRealtimeAdapter({
        endpointing,
        asr,
        llm,
        tts,
        ...(this.#telemetry === undefined ? {} : {telemetry: this.#telemetry}),
        idFactory: this.#idFactory,
        initialEpoch: this.#lastEpoch,
      })
      this.#endpointing = endpointing
      this.#adapter = adapter
      const identity = await adapter.connect({tools: options.tools, signal})
      if (signal.aborted || this.#state !== 'connecting' || this.#adapter !== adapter) {
        throw new CascadedRealtimeError('state')
      }
      this.#lastEpoch = identity.epoch
      this.#state = 'connected'
      return identity
    } catch (error) {
      try {
        await closeEpochResources(adapter, llm, endpointing)
      } finally {
        if (this.#adapter === adapter) this.#adapter = null
        if (this.#endpointing === endpointing) this.#endpointing = null
        this.#finishConnectFailure()
      }
      if (signal.aborted) throw abortReason(signal)
      if (error instanceof CascadedRealtimeError) throw error
      throw new CascadedRealtimeError('configuration')
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
      await closeEpochResources(adapter, null, endpointing)
    })().finally(() => { this.#state = 'disconnected' })
    return this.#closePromise
  }

  #requiredAdapter(): CascadedRealtimeAdapter {
    if (this.#state !== 'connected' || this.#adapter === null) {
      throw new CascadedRealtimeError('state')
    }
    return this.#adapter
  }

  #finishConnectFailure(): void {
    if (this.#state !== 'closing') this.#state = 'disconnected'
  }
}

async function closeEpochResources(
  adapter: CascadedRealtimeAdapter | null,
  llm: CascadedLlmSession | null,
  endpointing: EndpointingPort | null,
): Promise<void> {
  let failure: unknown
  if (adapter !== null) {
    try { await adapter.close() } catch (error) { failure = error }
  } else if (llm !== null) {
    try { await llm.close() } catch (error) { failure = error }
  }
  if (endpointing !== null) {
    try { await endpointing.close() } catch (error) { failure ??= error }
  }
  if (failure !== undefined) throw new CascadedRealtimeError('closed')
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason : new DOMException('This operation was aborted', 'AbortError')
}
