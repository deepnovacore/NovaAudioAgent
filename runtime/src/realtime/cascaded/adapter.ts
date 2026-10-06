import {committedConversationPairsSchema,type CommittedConversationPair} from '../history.js'
export type PreparedMemoryContext = (signal: AbortSignal) => Promise<string | null>
import {abortable} from '../../core/camera-session.js'
import type {PromptLanguage} from '../prompt-language.js'
import {dispatchSourceContext} from '../history.js'
import {cascadedResponseGuidance, validateOriginalImage,TASK_CONTINUATION_INSTRUCTIONS} from './llm.js'
import type {Frame} from '../../executors/watcher.js'
import { randomUUID } from 'node:crypto'
import {jsonValueSchema} from '../../core/events.js'
import {codePointLengthLikePython, stripLikePython} from '../../text/python-text.js'
import {
  MAX_REALTIME_PCM_BYTES,
  MAX_REALTIME_TEXT,
  hostContextItemSchema,
  hostResponseIntentSchema,
  realtimeIdentifierSchema,
  realtimeProviderEventSchema,
  responseAdaptationContextSchema,
  workspaceContextInjectionSchema,
  type HostContextItem,
  type HostResponseIntent,
  type ItemIdentity,
  type JsonObject,
  type RealtimeProvider,
  type RealtimeProviderEvent,
  type ResponseAdaptationContext,
  type ResponseOrigin,
  type SessionIdentity,
  type WorkspaceContextDeliveryRecord,
} from '../protocol.js'
import { NullTelemetry, type RealtimeTelemetry } from '../telemetry.js'
import {StreamingSpeech} from '../streaming-speech.js'
import type {
  CascadedLlmEvent,
  CascadedLlmFactory,
  CascadedLlmInput,
  CascadedLlmSession,
  CascadedLlmTool,
} from './llm.js'
import type {
  AsrClient,
  AsrSession,
  EndpointingEvent,
  EndpointingPort,
  TtsClient,
  TtsSession,
} from './ports.js'

export const MAX_CASCADED_EVENT_QUEUE = 4_096
export const MAX_CASCADED_QUEUED_AUDIO_BYTES = 16 * 1_024 * 1_024
export const MAX_CASCADED_PENDING_HOST_ITEMS = 256
export const MAX_CASCADED_CONSUMED_HOST_ITEMS = 256
export const MAX_CASCADED_ABANDONED_TOOL_CALLS = 256
export const DEFAULT_CASCADED_SETTLE_MS = 1_000

export const CASCADED_PREEMPTIVE_ALERT_POLICY = Object.freeze({
  controlledPreemptiveAlertReconnect: false,
  preemptiveAlertHistoryRecovery: 'none' as const,
  preemptiveAlertHistoryPairs: 4,
})

export interface CascadedRealtimeAdapterOptions {
  readonly textOnly?: boolean
  readonly history?: readonly CommittedConversationPair[]
  readonly endpointing?: EndpointingPort
  readonly asr?: AsrClient
  readonly language?: PromptLanguage
  readonly llm: CascadedLlmSession
  /** Opens a fresh LLM session for every adapter connection epoch. */
  readonly llmFactory?: CascadedLlmFactory
  readonly tts?: TtsClient
  readonly prerecall?: (query: string, signal: AbortSignal) => Promise<PreparedMemoryContext | null>
  readonly captureFrame?: (signal: AbortSignal) => Promise<Frame>
  readonly telemetry?: RealtimeTelemetry
  readonly idFactory?: () => string
  readonly settleTimeoutMs?: number
  /** Host-owned epoch floor when a fresh adapter replaces a closed adapter instance. */
  readonly initialEpoch?: number
}

export type CascadedRealtimeFailureCode =
  | 'state'
  | 'configuration'
  | 'duplicate_host_item'
  | 'pending_host_items_full'
  | 'response_active'
  | 'missing_host_input'
  | 'closed'

export class CascadedRealtimeError extends Error {
  readonly code: CascadedRealtimeFailureCode

  constructor(code: CascadedRealtimeFailureCode) {
    super(`Cascaded realtime ${code} failure`)
    this.name = 'CascadedRealtimeError'
    this.code = code
  }
}

interface PendingHostItem {
  readonly providerItemId: string
  readonly item: HostContextItem
  readonly input: CascadedLlmInput
}

interface ActiveAsr {
  readonly session: AsrSession
  readonly controller: AbortController
  readonly speechId: string
  readonly itemId: string
  task: Promise<void>
  speechEnded: boolean
  failed: boolean
}

interface ActiveTts {
  readonly responseId: string
  readonly responseSignal: AbortSignal
  controller: AbortController
  openId: string | null
  openPromise: Promise<TtsSession> | null
  session: TtsSession | null
  receiveTask: Promise<void> | null
  readonly texts: string[]
  audioEmitted: boolean
  retryUsed: boolean
  firstTextRecorded: boolean
}

interface ActiveResponse {
  readonly origin: ResponseOrigin
  readonly controller: AbortController
  id: string | null
  task: Promise<void>
  terminal: boolean
  tts: ActiveTts | null
}

interface EpochOwner {
  readonly epoch: number
  historyRestoring:boolean
  readonly sessionId: string
  readonly controller: AbortController
  readonly queue: BoundedEventQueue
  readonly llm: CascadedLlmSession
  llmClosePromise: Promise<void> | null
  readonly tools: readonly CascadedLlmTool[]
  readonly pending: Map<string, PendingHostItem>
  readonly consumed: Map<string, number>
  readonly abandonedCalls: Map<string, null>
  workspaceContext: {
    readonly item: HostContextItem
    readonly providerItemId: string
    readonly record: WorkspaceContextDeliveryRecord
  } | null
  prerecall: {query: string; itemId: string; controller: AbortController; result: Promise<PreparedMemoryContext | null>} | null
  responseAdaptation: ResponseAdaptationContext | null
  consumptionGeneration: number
  responseSequence: number
  pendingToolCallId: string | null
  userInput: {readonly itemId: string; readonly text: string; submitted: boolean} | null
  responseStartBarrier: Promise<void> | null
  asr: ActiveAsr | null
  response: ActiveResponse | null
  standbyTts: {state: ActiveTts; timer: ReturnType<typeof setTimeout>} | null
  revoked: boolean
}

class MixedResponseFailure extends Error {}
class TtsResponseFailure extends Error {}

const TTS_BOUNDARIES = new Set([...`，。！？；：,.!?;:\n`])

class TextChunker {
  readonly #softLimit = 18
  readonly #hardLimit = 48
  #pending: string[] = []
  #first = true

  push(text: string): readonly string[] {
    const delta = [...text]
    if (delta.length > MAX_REALTIME_TEXT) throw new RangeError('TTS text delta is too large')
    this.#pending.push(...delta)
    const chunks: string[] = []
    while (this.#pending.length > 0) {
      const boundary = this.#flushBoundary()
      if (boundary === null && this.#pending.length < this.#hardLimit) break
      const end = boundary === null ? this.#hardLimit : Math.min(boundary, this.#hardLimit)
      chunks.push(this.#pending.slice(0, end).join(''))
      this.#pending = this.#pending.slice(end)
      this.#first = false
    }
    return chunks
  }

  finish(): readonly string[] {
    if (this.#pending.length === 0) return []
    const pending = this.#pending.join('')
    this.#pending = []
    this.#first = false
    return [pending]
  }

  #flushBoundary(): number | null {
    for (let index = 0; index < this.#pending.length; index += 1) {
      if (!TTS_BOUNDARIES.has(this.#pending[index]!)) continue
      const end = index + 1
      if (this.#first || end >= this.#softLimit) return end
    }
    return null
  }
}

class BoundedEventQueue {
  readonly #items: RealtimeProviderEvent[] = []
  #audioBytes = 0
  #claimed = false
  #closed = false
  #overflowEvent: RealtimeProviderEvent | null = null
  #waiter: ((event: RealtimeProviderEvent | null) => void) | null = null

  claim(): void {
    if (this.#claimed) throw new CascadedRealtimeError('state')
    this.#claimed = true
  }

  enqueue(event: RealtimeProviderEvent): boolean {
    if (this.#closed) return false
    const owned = cloneEvent(event)
    if (this.#waiter !== null) {
      const waiter = this.#waiter
      waiter(owned)
      return true
    }
    const audioBytes = owned.kind === 'response_audio_delta' ? owned.pcm.byteLength : 0
    if (this.#items.length >= MAX_CASCADED_EVENT_QUEUE
      || this.#audioBytes + audioBytes > MAX_CASCADED_QUEUED_AUDIO_BYTES) return false
    this.#items.push(owned)
    this.#audioBytes += audioBytes
    return true
  }

  overflow(event: RealtimeProviderEvent): void {
    if (this.#overflowEvent !== null || this.#closed) return
    this.#overflowEvent = cloneEvent(event)
    this.#closed = true
    this.#wakeTerminalIfReady()
  }

  close(): void {
    this.#closed = true
    this.#wakeTerminalIfReady()
  }

  take(signal: AbortSignal): Promise<RealtimeProviderEvent | null> {
    if (this.#items.length > 0) {
      const event = this.#items.shift()!
      if (event.kind === 'response_audio_delta') this.#audioBytes -= event.pcm.byteLength
      return Promise.resolve(cloneEvent(event))
    }
    if (this.#overflowEvent !== null) {
      const event = this.#overflowEvent
      this.#overflowEvent = null
      return Promise.resolve(cloneEvent(event))
    }
    if (this.#closed || signal.aborted) return Promise.resolve(null)
    if (this.#waiter !== null) return Promise.reject(new CascadedRealtimeError('state'))
    return new Promise(resolve => {
      const onAbort = (): void => finish(null)
      const finish = (event: RealtimeProviderEvent | null): void => {
        if (this.#waiter !== finish) return
        this.#waiter = null
        signal.removeEventListener('abort', onAbort)
        resolve(event === null ? null : cloneEvent(event))
      }
      this.#waiter = finish
      signal.addEventListener('abort', onAbort, {once: true})
    })
  }

  #wakeTerminalIfReady(): void {
    if (this.#waiter === null || this.#items.length > 0) return
    const waiter = this.#waiter
    if (this.#overflowEvent !== null) {
      const event = this.#overflowEvent
      this.#overflowEvent = null
      waiter(event)
    } else waiter(null)
  }
}

export class CascadedRealtimeAdapter implements RealtimeProvider {
  readonly userResponseMode = 'requested' as const
  readonly #textOnly:boolean
  readonly #initialHistory:readonly CommittedConversationPair[]|undefined
  readonly #endpointing: EndpointingPort|undefined
  readonly #asrClient: AsrClient|undefined
  readonly #ttsClient: TtsClient|undefined
  readonly #defaultLanguage: PromptLanguage
  #language: PromptLanguage
  readonly #llm: CascadedLlmSession
  readonly #llmFactory: CascadedLlmFactory | undefined
  readonly #prerecall: ((query: string, signal: AbortSignal) => Promise<PreparedMemoryContext | null>) | undefined
  readonly #captureFrame: ((signal: AbortSignal) => Promise<Frame>) | undefined
  readonly #telemetry: RealtimeTelemetry
  readonly #idFactory: () => string
  readonly #settleTimeoutMs: number
  #epoch: number
  #state: 'new' | 'connecting' | 'connected' | 'closing' | 'disconnected' = 'new'
  #owner: EpochOwner | null = null
  #audioTail: Promise<void> = Promise.resolve()
  #asrTail: Promise<void> = Promise.resolve()
  #queuedAsrBytes = 0
  #queuedAsrOperations = 0
  #closePromise: Promise<void> | null = null
  #legacyLlmUsed = false
  #legacyLlmClosePromise: Promise<void> | null = null

  setLanguage(language: PromptLanguage = this.#defaultLanguage): Promise<void> { this.#language = language; return Promise.resolve() }

  constructor(options: CascadedRealtimeAdapterOptions) {
    this.#textOnly=options.textOnly===true
    this.#initialHistory=options.history===undefined?undefined:committedConversationPairsSchema.parse(options.history)
    if(!this.#textOnly&&(!options.endpointing||!options.asr||!options.tts))throw new CascadedRealtimeError('configuration')
    this.#endpointing = this.#textOnly?undefined:options.endpointing
    this.#asrClient = this.#textOnly?undefined:options.asr
    this.#ttsClient = this.#textOnly?undefined:options.tts
    this.#defaultLanguage = options.language ?? 'zh-CN'
    this.#language = this.#defaultLanguage
    this.#llm = options.llm
    this.#llmFactory = options.llmFactory
    this.#prerecall = options.prerecall
    this.#captureFrame = options.captureFrame
    this.#telemetry = options.telemetry ?? new NullTelemetry()
    this.#idFactory = options.idFactory ?? randomUUID
    this.#settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_CASCADED_SETTLE_MS
    this.#epoch = options.initialEpoch ?? 0
    if (!Number.isSafeInteger(this.#settleTimeoutMs) || this.#settleTimeoutMs <= 0) {
      throw new CascadedRealtimeError('configuration')
    }
    if (!Number.isSafeInteger(this.#epoch) || this.#epoch < 0) {
      throw new CascadedRealtimeError('configuration')
    }
  }

  async connect(options: {
    readonly tools: readonly JsonObject[]
    readonly signal: AbortSignal
  }): Promise<SessionIdentity> {
    if (this.#state !== 'new' && this.#state !== 'disconnected') {
      throw new CascadedRealtimeError('state')
    }
    throwIfAborted(options.signal)
    this.#state = 'connecting'
    this.#closePromise = null
    this.#audioTail = Promise.resolve()
    this.#asrTail = Promise.resolve()
    this.#queuedAsrBytes = 0
    this.#queuedAsrOperations = 0
    const epoch = this.#epoch + 1
    let owner: EpochOwner | null = null
    try {
      const tools = options.tools.map(schema => cascadedToolSchema(structuredClone(schema)))
      const sessionId = this.#freshId()
      const llm = this.#openLlm()
      owner = {
        epoch,
        historyRestoring:false,
        sessionId,
        controller: new AbortController(),
        queue: new BoundedEventQueue(),
        llm,
        llmClosePromise: null,
        tools: Object.freeze(tools.map(tool => Object.freeze(structuredClone(tool)))),
        pending: new Map(),
        consumed: new Map(),
        abandonedCalls: new Map(),
        workspaceContext: null,
        prerecall: null,
        responseAdaptation: null,
        consumptionGeneration: 0,
        responseSequence: 0,
        pendingToolCallId: null,
        responseStartBarrier: null,
        userInput: null,
        asr: null,
        response: null,
        standbyTts: null,
        revoked: false,
      }
      this.#owner = owner
      if(this.#initialHistory!==undefined){
        if(!llm.restoreHistory)throw new CascadedRealtimeError('configuration')
        await llm.restoreHistory(this.#initialHistory,options.signal)
      }
      await this.#endpointing?.reset()
      throwIfAborted(options.signal)
      if (this.#owner !== owner || owner.revoked) throw new CascadedRealtimeError('state')
      this.#epoch = epoch
      this.#state = 'connected'
      this.#warmStandbyTts(owner)
      this.#record('volcengine.session.connected', {epoch})
      return {epoch, provider_session_id: sessionId}
    } catch (error) {
      if (owner !== null) {
        const failedOwner = owner
        await safeCallWithin(() => this.#closeLlm(failedOwner), this.#settleTimeoutMs)
      }
      if (this.#owner?.epoch === epoch) this.#owner = null
      this.#finishConnectFailure()
      if (error instanceof CascadedRealtimeError) throw error
      throwIfAborted(options.signal)
      throw new CascadedRealtimeError('configuration')
    }
  }

  async restoreHistory(history:readonly CommittedConversationPair[],signal:AbortSignal):Promise<void> {
    const owner=this.#requiredOwner()
    if(owner.userInput!==null||owner.response!==null||owner.asr!==null||owner.pending.size||owner.consumed.size||owner.responseSequence)throw new CascadedRealtimeError('state')
    if(!owner.llm.restoreHistory)throw new CascadedRealtimeError('configuration')
    owner.historyRestoring=true
    try {await owner.llm.restoreHistory(committedConversationPairsSchema.parse(history),combineSignals(signal,owner.controller.signal))}
    finally {owner.historyRestoring=false}
  }

  submitText(text: string, signal: AbortSignal): Promise<void> {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) return Promise.reject(new CascadedRealtimeError('configuration'))
    const owner = this.#requiredOwner()
    const operation = this.#audioTail.then(async () => {
      throwIfAborted(combineSignals(owner.controller.signal, signal))
      if (!this.#isCurrent(owner) || owner.asr !== null || this.#queuedAsrOperations > 0) throw new CascadedRealtimeError('state')
      this.#warmStandbyTts(owner)
      const speechId = this.#freshId(), itemId = this.#freshId()
      await this.#emit(owner, {kind: 'user_speech_started', session_epoch: owner.epoch, speech_id: speechId, provider_item_id: itemId})
      await this.#emit(owner, {kind: 'user_speech_ended', session_epoch: owner.epoch, speech_id: speechId, provider_item_id: itemId})
      owner.userInput = {itemId, text, submitted: false}
      await this.#emit(owner, {kind: 'user_transcript_final', session_epoch: owner.epoch, item_id: itemId, text, input_kind:'text'})
    })
    this.#audioTail = operation.catch(() => undefined)
    return operation
  }

  sendAudio(pcm: Uint8Array, signal: AbortSignal): Promise<void> {
    if(this.#textOnly)return Promise.reject(new CascadedRealtimeError('configuration'))
    let owned: Uint8Array
    try {
      owned = inputPcm(pcm)
    } catch {
      return Promise.reject(new CascadedRealtimeError('configuration'))
    }
    let owner: EpochOwner
    try {
      owner = this.#requiredOwner()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new CascadedRealtimeError('state'))
    }
    const operation = this.#audioTail.then(async () => {
      const combined = combineSignals(owner.controller.signal, signal)
      throwIfAborted(combined)
      let decisions: readonly EndpointingEvent[]
      try {
        decisions = await this.#endpointing!.feed(owned.slice(), combined)
      } catch {
        throwIfAborted(combined)
        await this.#emit(owner, {
          kind: 'provider_error', session_epoch: owner.epoch,
          code: 'volcengine_vad_failed', recoverable: true,
        })
        await Promise.resolve(this.#endpointing?.reset()).catch(() => undefined)
        return
      }
      // Endpointing must keep consuming live microphone frames during a slow network open.
      // ASR writes retain their own order, including the final packet.
      decisions = decisions.map(decision => 'pcm' in decision
        ? {...decision, pcm: copyEndpointPcm(decision.pcm)} : {...decision})
      if (decisions.some(decision => decision.kind === 'speech_end')) {
        this.#record('volcengine.vad.local_end', {epoch: owner.epoch})
        try {
          await this.#endpointing!.reset()
        } catch {
          throwIfAborted(combined)
          await this.#emit(owner, {kind: 'provider_error', session_epoch: owner.epoch,
            code: 'volcengine_vad_failed', recoverable: true})
        }
      }
      const bytes = decisions.reduce((sum, decision) => sum + ('pcm' in decision ? decision.pcm.byteLength : 0), 0)
      this.#queuedAsrBytes += bytes
      if (decisions.length > 0) this.#queuedAsrOperations++
      const queuedAt = performance.now()
      const throttled = this.#queuedAsrBytes > 320_000
      const sending = this.#asrTail.then(async () => {
        if (decisions.length > 0) this.#record('cascaded.asr.audio_queue', {epoch: owner.epoch, wait_ms: performance.now() - queuedAt, bytes})
        for (const decision of decisions) {
          if (!this.#isCurrent(owner)) return
          if (decision.kind === 'speech_start') {
            await this.#startAsr(owner, decision.pcm, combined)
          } else if (decision.kind === 'speech_audio') {
            await this.#appendAsr(owner, decision.pcm, combined)
          } else if (decision.kind === 'speech_end') {
            if (typeof decision.commit !== 'boolean') {
              await this.#failAsr(owner, 'cascaded_asr_finish')
            } else await this.#stopAsr(owner, decision.commit, combined)
          } else {
            await this.#emit(owner, {
              kind: 'provider_error', session_epoch: owner.epoch,
              code: 'volcengine_vad_failed', recoverable: true,
            })
          }
        }
      }).finally(() => {
        if (this.#owner === owner) {
          this.#queuedAsrBytes -= bytes
          if (decisions.length > 0) this.#queuedAsrOperations--
        }
      })
      this.#asrTail = sending.catch(() => undefined)
      return {sending, throttled}
    })
    this.#audioTail = operation.then(() => undefined, () => undefined)
    return operation.then(result => result?.throttled ? result.sending : undefined)
  }

  replaceResponseAdaptation(context: ResponseAdaptationContext, signal: AbortSignal): Promise<void> {
    try {
      const owner = this.#requiredOwner()
      throwIfAborted(combineSignals(owner.controller.signal, signal))
      context = responseAdaptationContextSchema.parse(context)
      const prior = owner.responseAdaptation
      if (prior !== null && context.revision < prior.revision) return Promise.resolve()
      if (prior !== null && JSON.stringify(context) === JSON.stringify(prior)) return Promise.resolve()
      owner.responseAdaptation = context
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new CascadedRealtimeError('configuration'))
    }
  }

  async injectHostItem(
    input: HostContextItem,
    options: {
      readonly confirmationTimeout: number | null
      readonly asUserActivation: boolean
      readonly signal: AbortSignal
    },
  ): Promise<ItemIdentity> {
    void options.confirmationTimeout
    const owner = this.#requiredOwner()
    throwIfAborted(combineSignals(owner.controller.signal, options.signal))
    let item: HostContextItem
    try {
      item = hostContextItemSchema.parse(input)
    } catch {
      throw new CascadedRealtimeError('configuration')
    }
    if (item.kind === 'workspace_context') throw new CascadedRealtimeError('configuration')
    if (options.asUserActivation && item.kind !== 'progress' && item.kind !== 'final') {
      throw new CascadedRealtimeError('configuration')
    }
    if (owner.pending.has(item.host_item_id) || owner.consumed.has(item.host_item_id)) {
      throw new CascadedRealtimeError('duplicate_host_item')
    }
    if (owner.pending.size >= MAX_CASCADED_PENDING_HOST_ITEMS) {
      throw new CascadedRealtimeError('pending_host_items_full')
    }
    const providerItemId = this.#freshId()
    owner.pending.set(item.host_item_id, {
      providerItemId,
      item: structuredClone(item),
      input: hostInput(item, options.asUserActivation),
    })
    return await Promise.resolve({
      session_epoch: owner.epoch,
      host_item_id: item.host_item_id,
      provider_item_id: providerItemId,
    })
  }

  retireHostItem(providerItemId: string, signal: AbortSignal): Promise<void> {
    const owner = this.#requiredOwner()
    throwIfAborted(combineSignals(owner.controller.signal, signal))
    for (const [id, pending] of owner.pending) {
      if (pending.providerItemId === providerItemId) owner.pending.delete(id)
    }
    return Promise.resolve()
  }

  async injectWorkspaceContext(
    input: HostContextItem,
    options: {readonly confirmationTimeout: number | null; readonly signal: AbortSignal},
  ): Promise<WorkspaceContextDeliveryRecord> {
    void options.confirmationTimeout
    const owner = this.#requiredOwner()
    throwIfAborted(combineSignals(owner.controller.signal, options.signal))
    let item: HostContextItem
    try {
      item = hostContextItemSchema.parse(input)
    } catch {
      throw new CascadedRealtimeError('configuration')
    }
    if (item.kind !== 'workspace_context' || item.session_epoch !== owner.epoch) {
      throw new CascadedRealtimeError('configuration')
    }
    const prior = owner.workspaceContext
    if (prior !== null && JSON.stringify(prior.item) === JSON.stringify(item)) {
      return await Promise.resolve(structuredClone(prior.record))
    }
    if (prior !== null
      && prior.item.workspace_instance_id === item.workspace_instance_id
      && (item.revision ?? -1) <= (prior.item.revision ?? -1)) {
      throw new CascadedRealtimeError('configuration')
    }
    const providerItemId = this.#freshId()
    const record = workspaceContextInjectionSchema.parse({
      item,
      asUserActivation: false,
      delivery: {
        capability: 'replace_provider_item', delivered: true,
        session_epoch: item.session_epoch,
        workspace_instance_id: item.workspace_instance_id,
        revision: item.revision,
        prior_provider_item_id: prior?.providerItemId ?? null,
        provider_item_id: providerItemId,
        superseded_provider_item_id: prior?.providerItemId ?? null,
      },
    })
    owner.workspaceContext = {
      item: structuredClone(item), providerItemId, record: structuredClone(record),
    }
    return await Promise.resolve(structuredClone(record))
  }

  async createResponse(input: HostResponseIntent, signal: AbortSignal): Promise<void> {
    const owner = this.#requiredOwner()
    throwIfAborted(combineSignals(owner.controller.signal, signal))
    let intent: HostResponseIntent
    try {
      intent = hostResponseIntentSchema.parse(input)
    } catch {
      throw new CascadedRealtimeError('configuration')
    }
    await this.#serializeResponseStart(owner, async () => {
      throwIfAborted(combineSignals(owner.controller.signal, signal))
      if (owner.response !== null) throw new CascadedRealtimeError('response_active')
      if (intent.item.kind === 'tool_output' && intent.item.call_id !== null
        && owner.abandonedCalls.has(intent.item.call_id)) {
        owner.abandonedCalls.delete(intent.item.call_id)
        owner.pending.delete(intent.item.host_item_id)
        this.#startSilentResponse(owner, {kind: 'host_request', host_item_id: intent.item.host_item_id})
        await Promise.resolve()
        return
      }
      if (owner.consumed.delete(intent.item.host_item_id)) {
        this.#startSilentResponse(owner, {kind: 'host_request', host_item_id: intent.item.host_item_id})
        await Promise.resolve()
        return
      }
      const {inputs, hostIds} = this.#selectResponseInputs(owner, intent)
      if (inputs.length === 0) throw new CascadedRealtimeError('missing_host_input')
      await this.#resolvePendingToolCall(owner, inputs)
      if (!this.#isCurrent(owner)) throw new CascadedRealtimeError('state')
      throwIfAborted(combineSignals(owner.controller.signal, signal))
      for (const id of hostIds) owner.pending.delete(id)
      this.#startResponse(owner, inputs, {kind: 'host_request', host_item_id: intent.item.host_item_id},
        intent.item.kind === 'tool_output',intent.kind==='task_continuation')
      await Promise.resolve()
    })
  }

  async cancelResponse(responseId: string, signal: AbortSignal): Promise<void> {
    const owner = this.#requiredOwner()
    throwIfAborted(combineSignals(owner.controller.signal, signal))
    if (!realtimeIdentifierSchema.safeParse(responseId).success) {
      throw new CascadedRealtimeError('configuration')
    }
    const response = owner.response
    if (response?.id !== responseId || response.terminal) {
      await this.#emit(owner, {
        kind: 'response_cancel_rejected',
        session_epoch: owner.epoch,
        response_id: responseId,
        cancel_request_id: this.#freshId(),
        reason: 'no_active_response',
      })
      return
    }
    this.#record('volcengine.response.cancel', {epoch: owner.epoch})
    response.controller.abort()
    if (!await settleWithin(response.task, this.#settleTimeoutMs)) {
      // The LLM/TTS did not relinquish ownership. Reusing this epoch would overlap inference.
      await this.#emitTerminal(owner, response, 'failed', 'cancel_timeout')
      await this.#emit(owner, {kind: 'provider_error', session_epoch: owner.epoch,
        code: 'cascaded_cancel_timeout', recoverable: false})
      await this.#disconnectOwner(owner)
    }
  }

  async *events(signal: AbortSignal): AsyncIterable<RealtimeProviderEvent> {
    const owner = this.#requiredOwner()
    owner.queue.claim()
    while (!signal.aborted) {
      const event = await owner.queue.take(signal)
      if (event === null) return
      yield cloneEvent(event)
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    if (this.#state === 'new' || this.#state === 'disconnected') {
      this.#state = 'disconnected'
      this.#closePromise = (async () => {
        if (!(await safeCallWithin(() => this.#closeUnusedLegacyLlm(), this.#settleTimeoutMs))) {
          throw new CascadedRealtimeError('closed')
        }
      })()
      return this.#closePromise
    }
    this.#state = 'closing'
    const owner = this.#owner
    const audioTail = this.#audioTail
    const asrTail = this.#asrTail
    this.#closePromise = (async () => {
      let failed = false
      if (owner !== null) {
        owner.revoked = true
        this.#emitClosingTerminal(owner)
        owner.controller.abort()
        failed = !(await settleWithin(audioTail, this.#settleTimeoutMs)) || failed
        failed = !(await settleWithin(asrTail, this.#settleTimeoutMs)) || failed
        failed = !(await this.#cleanupOwner(owner)) || failed
        owner.queue.close()
        this.#record('volcengine.session.closed', {epoch: owner.epoch})
      }
      if (this.#owner === owner) this.#owner = null
      this.#state = 'disconnected'
      if (failed) throw new CascadedRealtimeError('closed')
    })()
    return this.#closePromise
  }

  #emitClosingTerminal(owner: EpochOwner): void {
    const active = owner.response
    if (active?.id == null || active.terminal) return
    active.terminal = true
    const terminal = realtimeProviderEventSchema.parse({
      kind: 'response_terminal', session_epoch: owner.epoch,
      response_id: active.id,
      ...(active.origin.kind === 'user_item' ? {origin: active.origin} : {}), status: 'cancelled', reason: 'cancelled',
    })
    if (!owner.queue.enqueue(terminal)) {
      owner.queue.overflow({
        kind: 'provider_error', session_epoch: owner.epoch,
        code: 'volcengine_event_overflow', recoverable: false,
      })
    }
    this.#record('volcengine.response.terminal', {status: 'cancelled'})
  }

  async #startAsr(owner: EpochOwner, pcm: Uint8Array, signal: AbortSignal): Promise<void> {
    if (owner.asr !== null) await this.#discardAsr(owner)
    this.#warmStandbyTts(owner)
    const speechId = this.#freshId()
    const itemId = this.#freshId()
    await this.#emit(owner, {
      kind: 'user_speech_started', session_epoch: owner.epoch,
      speech_id: speechId, provider_item_id: itemId,
    })
    let session: AsrSession
    try {
      this.#record('cascaded.asr.connect', {epoch: owner.epoch})
      session = await this.#asrClient!.open(signal)
      this.#record('cascaded.asr.connected', {epoch: owner.epoch, item_id: itemId})
    } catch {
      if (!this.#isCurrent(owner)) return
      await this.#emit(owner, {
        kind: 'user_speech_ended', session_epoch: owner.epoch,
        speech_id: speechId, provider_item_id: itemId,
      })
      await this.#emit(owner, {
        kind: 'provider_error', session_epoch: owner.epoch,
        code: 'cascaded_asr_start', recoverable: true,
      })
      await this.#emit(owner, {
        kind: 'user_transcript_failed', session_epoch: owner.epoch, item_id: itemId,
      })
      return
    }
    if (!this.#isCurrent(owner)) {
      await safeCallWithin(() => session.close(), this.#settleTimeoutMs)
      return
    }
    const controller = new AbortController()
    const active: ActiveAsr = {
      session, controller, speechId, itemId,
      task: Promise.resolve(), speechEnded: false, failed: false,
    }
    owner.asr = active
    active.task = this.#consumeAsr(owner, active)
    void active.task.catch(() => undefined)
    try {
      await session.append(pcm, combineSignals(signal, controller.signal))
    } catch {
      await this.#failAsr(owner, 'cascaded_asr_append')
      return
    }
    this.#record('volcengine.vad.start', {epoch: owner.epoch})
  }

  async #appendAsr(owner: EpochOwner, pcm: Uint8Array, signal: AbortSignal): Promise<void> {
    const active = owner.asr
    if (active === null) return
    try {
      await active.session.append(pcm, combineSignals(signal, active.controller.signal))
    } catch {
      await this.#failAsr(owner, 'cascaded_asr_append')
    }
  }

  async #stopAsr(owner: EpochOwner, commit: boolean, signal: AbortSignal): Promise<void> {
    const active = owner.asr
    if (active === null) {
      return
    }
    if (!active.speechEnded) {
      active.speechEnded = true
      await this.#emit(owner, {
        kind: 'user_speech_ended', session_epoch: owner.epoch,
        speech_id: active.speechId, provider_item_id: active.itemId,
      })
    }
    this.#record('volcengine.vad.end', {epoch: owner.epoch, commit})
    if (active.failed) {
      if (owner.asr === active) owner.asr = null
      return
    }
    if (!commit) {
      await this.#discardAsr(owner)
      return
    }
    try {
      await active.session.finish(combineSignals(signal, active.controller.signal))
    } catch {
      await this.#emit(owner, {
        kind: 'provider_error', session_epoch: owner.epoch,
        code: 'cascaded_asr_finish', recoverable: true,
      })
      await this.#emit(owner, {
        kind: 'user_transcript_failed', session_epoch: owner.epoch, item_id: active.itemId,
      })
      await this.#discardAsr(owner)
    }
  }

  async #consumeAsr(owner: EpochOwner, active: ActiveAsr): Promise<void> {
    let finalSeen = false
    try {
      for await (const transcript of active.session.events(
        combineSignals(owner.controller.signal, active.controller.signal),
      )) {
        if (!this.#isCurrent(owner) || owner.asr !== active) return
        if (typeof transcript.text !== 'string' || typeof transcript.final !== 'boolean') {
          throw new Error('invalid ASR event')
        }
        if ([...transcript.text].length > MAX_REALTIME_TEXT) {
          throw new Error('ASR transcript is too large')
        }
        if (transcript.final) {
          finalSeen = true
          this.#record('cascaded.asr.final', {epoch: owner.epoch})
          if (stripLikePython(transcript.text) === '') {
            await this.#emit(owner, {
              kind: 'user_transcript_failed', session_epoch: owner.epoch, item_id: active.itemId,
            })
          } else {
            owner.userInput = {itemId: active.itemId, text: transcript.text, submitted: false}
            await this.#emit(owner, {
              kind: 'user_transcript_final', session_epoch: owner.epoch,
              item_id: active.itemId, text: transcript.text,
            })
          }
          return
        } else {
          this.#record('cascaded.asr.partial', {epoch: owner.epoch})
          if (transcript.text.length >= 6) void this.#prepareRecall(owner, active.itemId, transcript.text)
          await this.#emit(owner, {
            kind: 'user_transcript_delta', session_epoch: owner.epoch,
            item_id: active.itemId, text: transcript.text,
            ...(transcript.replace === true ? {replace:true} : {}),
          })
        }
      }
      if (!finalSeen && !active.controller.signal.aborted && !owner.controller.signal.aborted) {
        throw new Error('ASR stream ended without final transcript')
      }
    } catch {
      if (this.#isCurrent(owner) && owner.asr === active
        && !active.controller.signal.aborted && !owner.controller.signal.aborted) {
        active.failed = true
        await this.#emit(owner, {
          kind: 'provider_error', session_epoch: owner.epoch,
          code: 'cascaded_asr_receive', recoverable: true,
        })
        await this.#emit(owner, {
          kind: 'user_transcript_failed', session_epoch: owner.epoch, item_id: active.itemId,
        })
      }
    } finally {
      await active.session.close().catch(() => undefined)
      if (owner.asr === active && (active.speechEnded || active.controller.signal.aborted)) {
        owner.asr = null
      }
    }
  }

  async #failAsr(owner: EpochOwner, code: string): Promise<void> {
    const active = owner.asr
    if (active === null) return
    if (!active.speechEnded) {
      active.speechEnded = true
      await this.#emit(owner, {
        kind: 'user_speech_ended', session_epoch: owner.epoch,
        speech_id: active.speechId, provider_item_id: active.itemId,
      })
    }
    await this.#emit(owner, {
      kind: 'provider_error', session_epoch: owner.epoch, code, recoverable: true,
    })
    await this.#emit(owner, {
      kind: 'user_transcript_failed', session_epoch: owner.epoch, item_id: active.itemId,
    })
    await this.#discardAsr(owner)
  }

  async #discardAsr(owner: EpochOwner): Promise<void> {
    const active = owner.asr
    if (active === null) return
    owner.asr = null
    active.controller.abort()
    await active.session.close().catch(() => undefined)
    await settleWithin(active.task, this.#settleTimeoutMs)
  }

  async ensureResponse(signal: AbortSignal, userItemId?: string, requestId?: string): Promise<boolean> {
    const owner = this.#requiredOwner()
    if (userItemId !== undefined && !realtimeIdentifierSchema.safeParse(userItemId).success) {
      throw new CascadedRealtimeError('configuration')
    }
    if (requestId !== undefined && !realtimeIdentifierSchema.safeParse(requestId).success) {
      throw new CascadedRealtimeError('configuration')
    }
    return this.#serializeResponseStart(owner, async () => {
      throwIfAborted(combineSignals(owner.controller.signal, signal))
      const input = owner.userInput
      if (owner.response !== null || input === null
        || (userItemId !== undefined && input.itemId !== userItemId)) return false
      const {inputs, hostIds} = this.#selectResponseInputs(owner, null)
      await this.#resolvePendingToolCall(owner, inputs)
      if (!this.#isCurrent(owner)) throw new CascadedRealtimeError('state')
      throwIfAborted(combineSignals(owner.controller.signal, signal))
      if (owner.userInput !== input) return false
      this.#markConsumed(owner, hostIds)
      // A retry continues the same conversation; appending the transcript again invents a user turn.
      if (!input.submitted) inputs.push({kind: 'user_text', text: input.text})
      this.#startResponse(owner, inputs, {kind: 'user_item', item_id: input.itemId,
        ...(requestId === undefined ? {} : {request_id: requestId})})
      return true
    })
  }

  #startResponse(owner: EpochOwner, inputs: readonly CascadedLlmInput[], origin: ResponseOrigin,
    allowTools = true,taskContinuation=false): void {
    const controller = new AbortController()
    const active: ActiveResponse = {
      controller, origin, id: `cascaded-response-${owner.epoch}-${++owner.responseSequence}`,
      task: Promise.resolve(), terminal: false, tts: null,
    }
    owner.response = active
    active.task = Promise.resolve().then(() => this.#runResponse(owner, active, inputs, allowTools,taskContinuation))
    void active.task.catch(() => undefined)
  }

  #startSilentResponse(owner: EpochOwner, origin: ResponseOrigin): void {
    const controller = new AbortController()
    const active: ActiveResponse = {
      controller, origin, id: null, task: Promise.resolve(), terminal: false, tts: null,
    }
    owner.response = active
    active.task = Promise.resolve().then(async () => {
      const responseId = this.#freshId()
      active.id = responseId
      try {
        await this.#emit(owner, {
          kind: 'response_started', session_epoch: owner.epoch, response_id: responseId, origin: active.origin,
        })
        await this.#emitTerminal(owner, active, 'completed', 'completed')
      } finally {
        if (owner.response === active) owner.response = null
      }
    })
    void active.task.catch(() => undefined)
  }

  #prepareRecall(owner: EpochOwner, itemId: string, query: string): Promise<PreparedMemoryContext | null> {
    if (!this.#prerecall) return Promise.resolve(null)
    if (owner.prerecall?.query === query && owner.prerecall.itemId === itemId) return owner.prerecall.result
    owner.prerecall?.controller.abort()
    const controller = new AbortController()
    const signal = AbortSignal.any([owner.controller.signal, controller.signal, AbortSignal.timeout(250)])
    const started = performance.now()
    const result = abortable(this.#prerecall(query, signal), signal).catch(() => null).then(content => {
      this.#record('memory.prerecall.completed', {duration_ms: performance.now() - started, injected: false})
      return signal.aborted ? null : content
    })
    owner.prerecall = {query, itemId, controller, result}
    return result
  }

  async #runResponse(
    owner: EpochOwner,
    active: ActiveResponse,
    inputs: readonly CascadedLlmInput[],
    allowTools: boolean,taskContinuation=false,
  ): Promise<void> {
    const language = this.#language
    let llmResponseId: string | null = null
    let llmFailureCode: string | null = null
    let textSeen = false
    let toolSeen = false
    let pendingTool: Extract<CascadedLlmEvent, {kind: 'tool_call'}> | null = null
    const transcript: string[] = []
    let transcriptLength = 0
    const chunker = new TextChunker()
    const speech = new StreamingSpeech()
    const signal = combineSignals(owner.controller.signal, active.controller.signal)
    let continuationResetFailed = false
    try {
      if (active.id === null) throw new Error('missing admitted response identity')
      // Admission belongs to this adapter, independent of when a remote LLM sends its first byte.
      await this.#emit(owner, {kind: 'response_started', session_epoch: owner.epoch,
        response_id: active.id, origin: active.origin})
      throwIfAborted(signal)
      let visualInputs = inputs
      if (this.#captureFrame && inputs.some(item => item.kind === 'user_text')) {
        try {
          this.#record('cascaded.vision.requested', {epoch: owner.epoch, response_id: active.id})
          const image = await this.#captureFrame(signal)
          this.#record('cascaded.vision.completed', {epoch: owner.epoch, response_id: active.id})
          validateOriginalImage(image)
          throwIfAborted(signal)
          if (!this.#isCurrent(owner) || owner.response !== active) return
          visualInputs = inputs.map(item => item.kind === 'user_text' ? {...item, image} : item)
        } catch {
          throwIfAborted(signal)
          visualInputs = inputs.map(item => item.kind === 'user_text' ? {...item, text: item.text + '\n[主机状态：本轮摄像头取帧失败。请明确告诉用户本轮未取得画面，不要假装看到了。]'} : item)
        }
      }
      const userText = inputs.find(item => item.kind === 'user_text')
      let memoryContext: string | null = null
      if (userText?.kind === 'user_text' && this.#prerecall) {
        const consumeSignal = AbortSignal.any([signal, AbortSignal.timeout(250)])
        const prepared = await abortable(this.#prepareRecall(owner, owner.userInput?.itemId ?? active.id, userText.text), consumeSignal).catch(() => null)
        if (prepared) {
          memoryContext = await abortable(prepared(consumeSignal), consumeSignal).catch(() => null)
        }
        throwIfAborted(signal)
        if (!this.#isCurrent(owner) || owner.response !== active) return
        this.#record('memory.prerecall.injected', {injected: memoryContext !== null})
      }
      this.#record('cascaded.llm.requested', {epoch: owner.epoch, response_id: active.id})
      this.#warmStandbyTts(owner)
      for await (const event of owner.llm.stream({
        language,
        inputs: visualInputs.map(item => structuredClone(item)),
        tools: allowTools ? owner.tools.map(tool => structuredClone(tool)) : [],
        workspaceContext: allowTools ? owner.workspaceContext?.item.content ?? null : null,
        responseAdaptation: [allowTools ? owner.responseAdaptation?.content : null, allowTools ? memoryContext : null,
          allowTools ? [...owner.pending.values()].filter(pending => pending.item.speech_content !== undefined)
            .map(pending => pending.item.content).join('\n') : null,
          allowTools ? dispatchSourceContext(owner.responseAdaptation?.user_sources) : null,
          taskContinuation?TASK_CONTINUATION_INSTRUCTIONS:cascadedResponseGuidance(allowTools, language),
        ].filter(Boolean).join('\n'),
        signal,
      })) {
        throwIfAborted(signal)
        if (!this.#isCurrent(owner) || owner.response !== active) return
        if (event.kind === 'response_started') {
          if (llmResponseId !== null) throw new Error('duplicate LLM response identity')
          llmResponseId = event.response_id
          this.#record('cascaded.llm.started', {epoch: owner.epoch, response_id: active.id})
        } else if (event.kind === 'text_delta') {
          if (toolSeen) throw new MixedResponseFailure()
          if (llmResponseId === null) throw new Error('LLM text before identity')
          if (!this.#textOnly && active.tts === null) {
            active.tts = this.#newTtsState(active.id, signal)
            const standby = owner.standbyTts
            if (standby !== null) {
              owner.standbyTts = null
              clearTimeout(standby.timer)
              active.tts.openId = standby.state.openId
              this.#record('cascaded.tts.prewarm.claimed', {epoch: owner.epoch,
                response_id: active.id, open_id: standby.state.openId!})
              active.tts.controller = standby.state.controller
              active.tts.openPromise = standby.state.openPromise
              const controller = active.tts.controller
              signal.addEventListener('abort', () => controller.abort(), {once: true, signal: controller.signal})
            } else this.#prewarmTts(owner, active.tts)
          }
          textSeen = true
          transcriptLength += [...event.text].length
          if (transcriptLength > MAX_REALTIME_TEXT) throw new Error('LLM response text overflow')
          transcript.push(event.text)
          if (transcriptLength === [...event.text].length) {
            this.#record('cascaded.llm.first_text', {epoch: owner.epoch, response_id: active.id})
          }
          await this.#emit(owner, {
            kind: 'response_transcript_delta', session_epoch: owner.epoch,
            response_id: active.id, text: event.text,
          })
          if (active.tts !== null) for (const chunk of chunker.push(speech.push(event.text))) {
            await this.#sendTtsText(owner, active.tts, chunk)
          }
        } else if (event.kind === 'tool_call') {
          if (textSeen || toolSeen) throw new MixedResponseFailure()
          if (llmResponseId === null) throw new Error('LLM tool before identity')
          toolSeen = true
          pendingTool = event
          owner.pendingToolCallId = event.call_id
          this.#record('cascaded.llm.tool_call', {epoch: owner.epoch, response_id: active.id})
        } else if (event.kind === 'response_failed') {
          if (llmResponseId !== null && event.response_id !== llmResponseId) throw new Error('LLM failure identity mismatch')
          llmFailureCode = event.code
          throw new Error('LLM stable provider failure')
        } else {
          if (llmResponseId === null || event.response_id !== llmResponseId) {
            throw new Error('LLM terminal identity mismatch')
          }
          if (textSeen) {
            if(!this.#textOnly){
            if (active.tts === null) throw new Error('missing TTS state')
            for (const chunk of chunker.push(speech.finish())) {
              await this.#sendTtsText(owner, active.tts, chunk)
            }
            for (const chunk of chunker.finish()) {
              await this.#sendTtsText(owner, active.tts, chunk)
            }
            await this.#finishTts(owner, active)
            }
            await this.#emit(owner, {
              kind: 'response_transcript_final', session_epoch: owner.epoch,
              response_id: active.id, text: transcript.join(''),
            })
          } else {
            await this.#cancelTts(owner, active)
            if (pendingTool !== null) {
              await this.#emit(owner, {
                kind: 'tool_call_ready', session_epoch: owner.epoch,
                call_id: pendingTool.call_id, item_id: pendingTool.item_id,
                name: pendingTool.name, arguments: structuredClone(pendingTool.arguments),
                response_id: active.id,
              })
            }
          }
          if (active.origin.kind === 'user_item' && owner.userInput?.itemId === active.origin.item_id) {
            owner.userInput.submitted = true
          }
          await this.#emitTerminal(owner, active, 'completed', 'completed')
          return
        }
      }
      throw new Error('LLM stream ended without terminal')
    } catch (error) {
      if (owner.pendingToolCallId !== null) {
        continuationResetFailed = !(await this.#abandonPendingToolCall(owner))
      }
      if (active.controller.signal.aborted || owner.controller.signal.aborted) {
        await this.#cancelTts(owner, active)
        if (active.id !== null && !active.terminal) {
          await this.#emitTerminal(owner, active, 'cancelled', 'cancelled')
        }
      } else if (error instanceof MixedResponseFailure) {
        await this.#cancelTts(owner, active)
        await this.#emit(owner, {
          kind: 'provider_error', session_epoch: owner.epoch,
          code: 'cascaded_mixed_text_tool', recoverable: false,
        })
        if (active.id !== null) await this.#emitTerminal(owner, active, 'failed', 'mixed_output')
      } else {
        await this.#cancelTts(owner, active)
        const ttsFailure = error instanceof TtsResponseFailure
        const rawCode = llmFailureCode ?? (error instanceof Error && 'code' in error ? error.code : null)
        const code = typeof rawCode === 'string'
          && ['configuration', 'aborted', 'timeout', 'protocol', 'overflow', 'closed', 'network', 'http'].includes(rawCode)
          ? rawCode : 'unknown'
        this.#record('cascaded.response.failed', {component: ttsFailure ? 'tts' : 'llm', code})
        await this.#emit(owner, {
          kind: 'provider_error', session_epoch: owner.epoch,
          code: ttsFailure ? 'cascaded_tts_receive' : 'cascaded_response_failed',
          recoverable: true,
        })
        active.id ??= this.#freshId()
        await this.#emitTerminal(
          owner, active, 'failed', ttsFailure ? 'tts_failure' : 'provider_failure',
        )
      }
    } finally {
      if (owner.response === active) owner.response = null
      if (continuationResetFailed && this.#isCurrent(owner)) {
        await this.#disconnectOwner(owner)
      }
    }
  }

  #newTtsState(responseId: string, responseSignal: AbortSignal): ActiveTts {
    return {
      responseId,
      responseSignal,
      controller: new AbortController(),
      openId: null,
      openPromise: null,
      session: null,
      receiveTask: null,
      texts: [],
      audioEmitted: false,
      retryUsed: false,
      firstTextRecorded: false,
    }
  }

  #warmStandbyTts(owner: EpochOwner): void {
    if (this.#textOnly || !this.#isCurrent(owner) || owner.standbyTts !== null) return
    const state = this.#newTtsState('', owner.controller.signal)
    const timer = setTimeout(() => {
      if (owner.standbyTts?.state !== state) return
      owner.standbyTts = null
      void this.#releaseTtsState(state, true)
    }, 30_000)
    timer.unref()
    owner.standbyTts = {state, timer}
    this.#prewarmTts(owner, state)
  }

  #prewarmTts(owner: EpochOwner, state: ActiveTts): void {
    if (state.openPromise !== null || state.session !== null) return
    const openId = randomUUID()
    state.openId = openId
    const started = performance.now()
    const payload = {epoch: owner.epoch, open_id: openId,
      ...(state.responseId ? {response_id: state.responseId} : {})}
    this.#record('cascaded.tts.prewarm', payload)
    state.openPromise = Promise.resolve().then(() => this.#ttsClient!.open(
      combineSignals(state.responseSignal, state.controller.signal),
    )).then(session => {
      this.#record('cascaded.tts.prewarm.ready', {...payload, duration_ms: performance.now() - started})
      return session
    }, error => {
      this.#record('cascaded.tts.prewarm.failed', {...payload, duration_ms: performance.now() - started})
      throw error
    })
    void state.openPromise.catch(() => undefined)
  }

  async #ensureTts(owner: EpochOwner, state: ActiveTts): Promise<TtsSession> {
    if (state.session !== null) return state.session
    const signal = combineSignals(state.responseSignal, state.controller.signal)
    throwIfAborted(signal)
    const prewarm = state.openPromise
    let session: TtsSession
    if (prewarm !== null) {
      try {
        session = await prewarm
      } catch {
        throwIfAborted(signal)
        state.openPromise = this.#ttsClient!.open(signal)
        session = await state.openPromise
      }
    } else {
      state.openPromise = this.#ttsClient!.open(signal)
      session = await state.openPromise
    }
    // Keep pending opens owned until release can cancel even a late provider result.
    throwIfAborted(signal)
    state.openPromise = null
    state.session = session
    state.receiveTask = this.#consumeTts(owner, state, session)
    void state.receiveTask.catch(() => undefined)
    return session
  }

  async #sendTtsText(owner: EpochOwner, state: ActiveTts, text: string): Promise<void> {
    state.texts.push(text)
    try {
      const session = await this.#ensureTts(owner, state)
      if (!state.firstTextRecorded) {
        state.firstTextRecorded = true
        this.#record('cascaded.tts.first_text', {epoch: owner.epoch, response_id: state.responseId})
      }
      await session.sendText(text, combineSignals(state.responseSignal, state.controller.signal))
    } catch {
      try {
        if (await this.#retryTts(owner, state)) return
      } catch {
        // The stable TTS category below owns every open/send/replay detail.
      }
      throw new TtsResponseFailure()
    }
  }

  async #consumeTts(
    owner: EpochOwner,
    state: ActiveTts,
    session: TtsSession,
  ): Promise<void> {
    for await (const event of session.events(
      combineSignals(state.responseSignal, state.controller.signal),
    )) {
      if (!this.#isCurrent(owner) || state.session !== session) return
      const pcm = new Uint8Array(event.pcm)
      if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) throw new TtsResponseFailure()
      if (!state.audioEmitted) {
        state.audioEmitted = true
        this.#record('cascaded.tts.first_audio', {epoch: owner.epoch, response_id: state.responseId})
      }
      await this.#emit(owner, {
        kind: 'response_audio_delta', session_epoch: owner.epoch,
        response_id: state.responseId, pcm,
      })
    }
    // A closed prewarmed session is not proof that submitted speech was synthesized.
    if (!state.audioEmitted && !state.controller.signal.aborted) throw new TtsResponseFailure()
  }

  async #retryTts(owner: EpochOwner, state: ActiveTts): Promise<boolean> {
    if (state.audioEmitted || state.retryUsed || state.responseSignal.aborted) return false
    state.retryUsed = true
    this.#record('cascaded.tts.reconnect', {epoch: owner.epoch})
    await this.#releaseTtsState(state, true)
    state.controller = new AbortController()
    const session = await this.#ensureTts(owner, state)
    for (const text of state.texts) {
      await session.sendText(text, combineSignals(state.responseSignal, state.controller.signal))
    }
    return true
  }

  async #finishTts(owner: EpochOwner, active: ActiveResponse): Promise<void> {
    const state = active.tts
    if (state === null) return
    if (state.texts.length === 0) {
      await this.#cancelTts(owner, active)
      return
    }
    try {
      const session = await this.#ensureTts(owner, state)
      await session.finish(combineSignals(state.responseSignal, state.controller.signal))
      if (state.receiveTask !== null) await state.receiveTask
    } catch {
      try {
        if (!await this.#retryTts(owner, state)) throw new TtsResponseFailure()
        if (state.session === null) throw new TtsResponseFailure()
        await state.session.finish(combineSignals(state.responseSignal, state.controller.signal))
        if (state.receiveTask !== null) await state.receiveTask
      } catch {
        throw new TtsResponseFailure()
      }
    } finally {
      await this.#releaseTtsState(state, false)
      active.tts = null
    }
  }

  async #cancelTts(owner: EpochOwner, active: ActiveResponse): Promise<boolean> {
    const state = active.tts
    if (state === null) return true
    const hadResource = state.openPromise !== null || state.session !== null || state.receiveTask !== null
    active.tts = null
    const successful = await this.#releaseTtsState(state, true)
    if (hadResource) this.#record('cascaded.tts.cancel', {epoch: owner.epoch})
    return successful
  }

  async #releaseTtsState(state: ActiveTts, cancel: boolean): Promise<boolean> {
    let successful = true
    const open = state.openPromise
    state.openPromise = null
    state.controller.abort()
    let session = state.session
    state.session = null
    if (open !== null) {
      const openSettled = await settleWithin(open, this.#settleTimeoutMs)
      if (openSettled) {
        try {
          session ??= await open
        } catch {
          // A failed prewarm owns no provider resource.
        }
      } else {
        successful = false
        void open.then(async late => {
          await safeCallWithin(() => late.cancel(), this.#settleTimeoutMs)
          await safeCallWithin(() => late.close(), this.#settleTimeoutMs)
        }, () => undefined)
      }
    }
    if (cancel && session !== null) {
      successful = await safeCallWithin(
        () => session.cancel(), this.#settleTimeoutMs,
      ) && successful
    }
    const receive = state.receiveTask
    state.receiveTask = null
    if (receive !== null) {
      successful = await settleWithin(receive, this.#settleTimeoutMs) && successful
    }
    if (session !== null) {
      successful = await safeCallWithin(
        () => session.close(), this.#settleTimeoutMs,
      ) && successful
    }
    return successful
  }

  async #emitTerminal(
    owner: EpochOwner,
    active: ActiveResponse,
    status: 'completed' | 'cancelled' | 'failed',
    reason: string,
  ): Promise<void> {
    if (active.terminal || active.id === null) return
    active.terminal = true
    await this.#emit(owner, {
      kind: 'response_terminal', session_epoch: owner.epoch,
      response_id: active.id,
      ...(active.origin.kind === 'user_item' ? {origin: active.origin} : {}), status, reason,
    })
    this.#record('volcengine.response.terminal', {status})
  }

  #selectResponseInputs(owner: EpochOwner, intent: HostResponseIntent | null): {
    readonly inputs: CascadedLlmInput[]
    readonly hostIds: string[]
  } {
    const inputs: CascadedLlmInput[] = []
    const hostIds: string[] = []
    if (intent !== null && !owner.pending.has(intent.item.host_item_id)) return {inputs, hostIds}
    for (const [hostId, pending] of owner.pending) {
      const include = pending.item.kind === 'recovery' || pending.item.kind === 'dialogue_context'
        || pending.item.kind === 'tool_output' || hostId === intent?.item.host_item_id
      if (!include) continue
      const input = intent?.kind === 'host_fact' && hostId === intent.item.host_item_id
        && (pending.item.kind === 'progress' || pending.item.kind === 'final')
        ? hostInput(pending.item, true) : structuredClone(pending.input)
      if (input.kind === 'tool_result') inputs.unshift(input)
      else inputs.push(input)
      if (pending.item.speech_content === undefined) hostIds.push(hostId)
    }
    return {inputs, hostIds}
  }

  #markConsumed(owner: EpochOwner, hostIds: readonly string[]): void {
    if (hostIds.length === 0) return
    owner.consumptionGeneration += 1
    for (const hostId of hostIds) {
      owner.pending.delete(hostId)
      owner.consumed.delete(hostId)
      owner.consumed.set(hostId, owner.consumptionGeneration)
    }
    while (owner.consumed.size > MAX_CASCADED_CONSUMED_HOST_ITEMS) {
      const oldest = owner.consumed.keys().next().value
      if (oldest === undefined) break
      owner.consumed.delete(oldest)
    }
  }

  async #resolvePendingToolCall(
    owner: EpochOwner,
    inputs: readonly CascadedLlmInput[],
  ): Promise<void> {
    const callId = owner.pendingToolCallId
    if (callId === null) return
    if (inputs.some(input => input.kind === 'tool_result' && input.call_id === callId)) {
      owner.pendingToolCallId = null
      return
    }
    if (!(await this.#abandonPendingToolCall(owner))) {
      await this.#disconnectOwner(owner)
      throw new CascadedRealtimeError('closed')
    }
  }

  async #abandonPendingToolCall(owner: EpochOwner): Promise<boolean> {
    const callId = owner.pendingToolCallId
    if (callId === null) return true
    owner.pendingToolCallId = null
    owner.abandonedCalls.delete(callId)
    owner.abandonedCalls.set(callId, null)
    while (owner.abandonedCalls.size > MAX_CASCADED_ABANDONED_TOOL_CALLS) {
      const oldest = owner.abandonedCalls.keys().next().value
      if (oldest === undefined) break
      owner.abandonedCalls.delete(oldest)
    }
    return await safeCallWithin(
      () => owner.llm.abandonPendingResponse(), this.#settleTimeoutMs,
    )
  }

  async #disconnectOwner(owner: EpochOwner): Promise<void> {
    owner.revoked = true
    owner.controller.abort()
    await this.#cleanupOwner(owner)
    owner.queue.close()
    if (this.#owner === owner) this.#owner = null
    this.#state = 'disconnected'
  }

  async #serializeResponseStart<T>(
    owner: EpochOwner,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = owner.responseStartBarrier
    let release: (() => void) | undefined
    const barrier = new Promise<void>(resolve => { release = resolve })
    owner.responseStartBarrier = barrier
    if (previous !== null) await previous
    try {
      // Terminal is observable before the response task finishes releasing its ownership.
      if (owner.response?.terminal && !await settleWithin(owner.response.task, this.#settleTimeoutMs)) {
        throw new CascadedRealtimeError('response_active')
      }
      if (!this.#isCurrent(owner)) throw new CascadedRealtimeError('state')
      return await operation()
    } finally {
      release?.()
      if (owner.responseStartBarrier === barrier) owner.responseStartBarrier = null
    }
  }

  #emit(owner: EpochOwner, event: RealtimeProviderEvent): Promise<void> {
    if (!this.#isCurrent(owner)) return Promise.resolve()
    let parsed: RealtimeProviderEvent
    try {
      parsed = realtimeProviderEventSchema.parse(event)
    } catch {
      parsed = {
        kind: 'provider_error', session_epoch: owner.epoch,
        code: 'volcengine_event_invalid', recoverable: false,
      }
    }
    if (owner.queue.enqueue(parsed)) return Promise.resolve()
    owner.queue.overflow({
      kind: 'provider_error', session_epoch: owner.epoch,
      code: 'volcengine_event_overflow', recoverable: false,
    })
    owner.revoked = true
    owner.controller.abort()
    void this.#cleanupOwner(owner).catch(() => undefined)
    return Promise.resolve()
  }

  async #cleanupOwner(owner: EpochOwner): Promise<boolean> {
    let successful = true
    const standby = owner.standbyTts
    owner.standbyTts = null
    if (standby !== null) {
      clearTimeout(standby.timer)
      successful = await this.#releaseTtsState(standby.state, true) && successful
    }
    const response = owner.response
    if (response !== null) {
      response.controller.abort()
      successful = await settleWithin(response.task, this.#settleTimeoutMs) && successful
      successful = await this.#cancelTts(owner, response) && successful
      if (owner.response === response) owner.response = null
    }
    const asr = owner.asr
    if (asr !== null) {
      asr.controller.abort()
      successful = await safeCallWithin(
        () => asr.session.close(), this.#settleTimeoutMs,
      ) && successful
      successful = await settleWithin(asr.task, this.#settleTimeoutMs) && successful
      if (owner.asr === asr) owner.asr = null
    }
    successful = await this.#abandonPendingToolCall(owner) && successful
    successful = await safeCallWithin(() => this.#closeLlm(owner), this.#settleTimeoutMs) && successful
    successful = await safeCallWithin(
      async () => { await this.#endpointing?.reset() }, this.#settleTimeoutMs,
    ) && successful
    return successful
  }

  #openLlm(): CascadedLlmSession {
    if (!this.#legacyLlmUsed) {
      this.#legacyLlmUsed = true
      return this.#llm
    }
    if (this.#llmFactory !== undefined) return this.#llmFactory.open()
    throw new CascadedRealtimeError('state')
  }

  #closeLlm(owner: EpochOwner): Promise<void> {
    owner.llmClosePromise ??= Promise.resolve().then(() => owner.llm.close())
    return owner.llmClosePromise
  }

  #closeUnusedLegacyLlm(): Promise<void> {
    if (this.#legacyLlmUsed) return Promise.resolve()
    this.#legacyLlmClosePromise ??= Promise.resolve().then(() => this.#llm.close())
    return this.#legacyLlmClosePromise
  }

  #requiredOwner(): EpochOwner {
    const owner = this.#owner
    if (this.#state !== 'connected' || owner === null || owner.revoked || owner.historyRestoring) {
      throw new CascadedRealtimeError('state')
    }
    return owner
  }

  #finishConnectFailure(): void {
    if (this.#state !== 'closing') this.#state = 'disconnected'
  }

  #isCurrent(owner: EpochOwner): boolean {
    return this.#owner === owner && !owner.revoked
  }

  #freshId(): string {
    let value: unknown
    try {
      value = this.#idFactory()
    } catch {
      throw new CascadedRealtimeError('configuration')
    }
    const parsed = realtimeIdentifierSchema.safeParse(value)
    if (!parsed.success) throw new CascadedRealtimeError('configuration')
    return parsed.data
  }

  #record(kind: string, payload: Readonly<Record<string, boolean | number | string>>): void {
    this.#telemetry.record(kind, payload)
  }
}

function hostInput(item: HostContextItem, asUserActivation: boolean): CascadedLlmInput {
  if (item.kind === 'tool_output') {
    let output: unknown
    try {
      output = JSON.parse(item.content) as unknown
    } catch {
      // Tool output is evidence, not a command: plain text is a valid JSON string value.
      output = item.content
    }
    const parsed = jsonValueSchema.safeParse(output)
    if (!parsed.success || item.call_id === null) throw new CascadedRealtimeError('configuration')
    return {kind: 'tool_result', call_id: item.call_id, output: structuredClone(parsed.data)}
  }
  const labels: Readonly<Record<string, string>> = {
    progress: '任务进度事实',
    final: '任务结果事实',
    recovery: '恢复摘要',
    dialogue_context: '只读历史对话',
  }
  const content = asUserActivation
    ? item.speech_content ?? item.content
    : `Nova Audio Agent ${labels[item.kind]}：${item.content}`
  return item.kind === 'dialogue_context'
    ? {kind: 'packed_history', content}
    : {kind: asUserActivation ? 'host_activation' : 'host_context', content}
}

function cascadedToolSchema(schema: JsonObject): CascadedLlmTool {
  const functionObject = schema.function
  if (schema.type !== 'function' || !jsonObject(functionObject)) {
    throw new CascadedRealtimeError('configuration')
  }
  const name = functionObject.name
  const parameters = functionObject.parameters
  if (!validIdentifier(name) || !jsonObject(parameters)) {
    throw new CascadedRealtimeError('configuration')
  }
  const description = functionObject.description
  if (description !== undefined && typeof description !== 'string') {
    throw new CascadedRealtimeError('configuration')
  }
  return {
    name,
    ...(description !== undefined && stripLikePython(description) !== '' ? {description} : {}),
    parameters: structuredClone(parameters),
  }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && stripLikePython(value) !== ''
    && codePointLengthLikePython(value) <= MAX_REALTIME_TEXT
}

function jsonObject(value: unknown): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
    && jsonValueSchema.safeParse(value).success
}

function copyEndpointPcm(value: Uint8Array): Uint8Array {
  try {
    return inputPcm(value)
  } catch {
    throw new CascadedRealtimeError('configuration')
  }
}

function inputPcm(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength % 2 !== 0
    || value.byteLength > MAX_REALTIME_PCM_BYTES) {
    throw new RangeError('PCM must be non-empty aligned bounded PCM16 bytes')
  }
  return value.slice()
}

function cloneEvent(event: RealtimeProviderEvent): RealtimeProviderEvent {
  if (event.kind !== 'response_audio_delta') return structuredClone(event)
  return {...event, pcm: event.pcm.slice()}
}

function combineSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  return first === second ? first : AbortSignal.any([first, second])
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('This operation was aborted', 'AbortError')
}

async function settleWithin(task: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task.then(() => true, () => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function safeCallWithin(
  operation: () => Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let task: Promise<void>
  try {
    task = operation()
  } catch {
    return false
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task.then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
