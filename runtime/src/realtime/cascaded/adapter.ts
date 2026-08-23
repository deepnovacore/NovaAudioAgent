import { randomUUID } from 'node:crypto'
import {jsonValueSchema} from '../../events.js'
import {codePointLengthLikePython, stripLikePython} from '../../python-text.js'
import {
  MAX_REALTIME_PCM_BYTES,
  MAX_REALTIME_TEXT,
  hostContextItemSchema,
  hostResponseIntentSchema,
  realtimeIdentifierSchema,
  realtimeProviderEventSchema,
  type HostContextItem,
  type HostResponseIntent,
  type ItemIdentity,
  type JsonObject,
  type RealtimeProvider,
  type RealtimeProviderEvent,
  type SessionIdentity,
} from '../protocol.js'
import { NullTelemetry, type RealtimeTelemetry } from '../telemetry.js'
import type {
  CascadedLlmEvent,
  CascadedLlmInput,
  CascadedLlmSession,
  CascadedLlmTool,
} from './llm.js'
import {GUARD_ACTIVATION_PREFIX} from './llm.js'
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

export const CASCADED_GUARD_POLICY = Object.freeze({
  controlledGuardReconnect: false,
  guardHistoryRecovery: 'none' as const,
  guardHistoryPairs: 4,
})

export interface CascadedRealtimeAdapterOptions {
  readonly endpointing: EndpointingPort
  readonly asr: AsrClient
  readonly llm: CascadedLlmSession
  readonly tts: TtsClient
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
  openPromise: Promise<TtsSession> | null
  session: TtsSession | null
  receiveTask: Promise<void> | null
  readonly texts: string[]
  audioEmitted: boolean
  retryUsed: boolean
  firstTextRecorded: boolean
}

interface ActiveResponse {
  readonly controller: AbortController
  id: string | null
  task: Promise<void>
  terminal: boolean
  tts: ActiveTts | null
}

interface EpochOwner {
  readonly epoch: number
  readonly sessionId: string
  readonly controller: AbortController
  readonly queue: BoundedEventQueue
  readonly llm: CascadedLlmSession
  readonly tools: readonly CascadedLlmTool[]
  readonly pending: Map<string, PendingHostItem>
  readonly consumed: Map<string, number>
  readonly abandonedCalls: Map<string, null>
  consumptionGeneration: number
  pendingToolCallId: string | null
  responseStartBarrier: Promise<void> | null
  asr: ActiveAsr | null
  response: ActiveResponse | null
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
  readonly #endpointing: EndpointingPort
  readonly #asrClient: AsrClient
  readonly #ttsClient: TtsClient
  readonly #llm: CascadedLlmSession
  readonly #telemetry: RealtimeTelemetry
  readonly #idFactory: () => string
  readonly #settleTimeoutMs: number
  #epoch: number
  #state: 'new' | 'connecting' | 'connected' | 'closing' | 'disconnected' = 'new'
  #owner: EpochOwner | null = null
  #audioTail: Promise<void> = Promise.resolve()
  #closePromise: Promise<void> | null = null
  #llmClosePromise: Promise<void> | null = null

  constructor(options: CascadedRealtimeAdapterOptions) {
    this.#endpointing = options.endpointing
    this.#asrClient = options.asr
    this.#ttsClient = options.tts
    this.#llm = options.llm
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
    const epoch = this.#epoch + 1
    try {
      const tools = options.tools.map(schema => cascadedToolSchema(structuredClone(schema)))
      const sessionId = this.#freshId()
      const llm = this.#llm
      const owner: EpochOwner = {
        epoch,
        sessionId,
        controller: new AbortController(),
        queue: new BoundedEventQueue(),
        llm,
        tools: Object.freeze(tools.map(tool => Object.freeze(structuredClone(tool)))),
        pending: new Map(),
        consumed: new Map(),
        abandonedCalls: new Map(),
        consumptionGeneration: 0,
        pendingToolCallId: null,
        responseStartBarrier: null,
        asr: null,
        response: null,
        revoked: false,
      }
      this.#owner = owner
      await this.#endpointing.reset()
      throwIfAborted(options.signal)
      if (this.#owner !== owner || owner.revoked) throw new CascadedRealtimeError('state')
      this.#epoch = epoch
      this.#state = 'connected'
      this.#record('volcengine.session.connected', {epoch})
      return {epoch, provider_session_id: sessionId}
    } catch (error) {
      await safeCallWithin(() => this.#closeLlm(), this.#settleTimeoutMs)
      if (this.#owner?.epoch === epoch) this.#owner = null
      this.#finishConnectFailure()
      if (error instanceof CascadedRealtimeError) throw error
      throwIfAborted(options.signal)
      throw new CascadedRealtimeError('configuration')
    }
  }

  sendAudio(pcm: Uint8Array, signal: AbortSignal): Promise<void> {
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
        decisions = await this.#endpointing.feed(owned.slice(), combined)
      } catch {
        throwIfAborted(combined)
        await this.#emit(owner, {
          kind: 'provider_error', session_epoch: owner.epoch,
          code: 'volcengine_vad_failed', recoverable: true,
        })
        await Promise.resolve(this.#endpointing.reset()).catch(() => undefined)
        return
      }
      for (const decision of decisions) {
        if (!this.#isCurrent(owner)) return
        if (decision.kind === 'speech_start') {
          await this.#startAsr(owner, copyEndpointPcm(decision.pcm), combined)
        } else if (decision.kind === 'speech_audio') {
          await this.#appendAsr(owner, copyEndpointPcm(decision.pcm), combined)
        } else if (decision.kind === 'speech_end') {
          if (typeof decision.commit !== 'boolean') {
            await this.#failAsr(owner, 'volcengine_asr_finish')
          } else await this.#stopAsr(owner, decision.commit, combined)
        } else {
          await this.#emit(owner, {
            kind: 'provider_error', session_epoch: owner.epoch,
            code: 'volcengine_vad_failed', recoverable: true,
          })
        }
      }
    })
    this.#audioTail = operation.then(() => undefined, () => undefined)
    return operation
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
      item: structuredClone(item),
      input: hostInput(item, options.asUserActivation),
    })
    return await Promise.resolve({
      session_epoch: owner.epoch,
      host_item_id: item.host_item_id,
      provider_item_id: providerItemId,
    })
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
        this.#startSilentResponse(owner)
        await Promise.resolve()
        return
      }
      if (owner.consumed.delete(intent.item.host_item_id)) {
        this.#startSilentResponse(owner)
        await Promise.resolve()
        return
      }
      const inputs = this.#takeResponseInputs(owner, intent)
      if (inputs.length === 0) throw new CascadedRealtimeError('missing_host_input')
      await this.#resolvePendingToolCall(owner, inputs)
      if (!this.#isCurrent(owner)) throw new CascadedRealtimeError('state')
      throwIfAborted(combineSignals(owner.controller.signal, signal))
      this.#startResponse(owner, inputs)
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
    await settleWithin(response.task, this.#settleTimeoutMs)
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
        if (!(await safeCallWithin(() => this.#closeLlm(), this.#settleTimeoutMs))) {
          throw new CascadedRealtimeError('closed')
        }
      })()
      return this.#closePromise
    }
    this.#state = 'closing'
    const owner = this.#owner
    const audioTail = this.#audioTail
    this.#closePromise = (async () => {
      let failed = false
      if (owner !== null) {
        owner.revoked = true
        this.#emitClosingTerminal(owner)
        owner.controller.abort()
        failed = !(await settleWithin(audioTail, this.#settleTimeoutMs)) || failed
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
      response_id: active.id, status: 'cancelled', reason: 'cancelled',
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
    const speechId = this.#freshId()
    const itemId = this.#freshId()
    await this.#emit(owner, {
      kind: 'user_speech_started', session_epoch: owner.epoch,
      speech_id: speechId, provider_item_id: itemId,
    })
    let session: AsrSession
    try {
      this.#record('volcengine.asr.connect', {epoch: owner.epoch})
      session = await this.#asrClient.open(signal)
    } catch {
      await this.#emit(owner, {
        kind: 'user_speech_ended', session_epoch: owner.epoch,
        speech_id: speechId, provider_item_id: itemId,
      })
      await this.#emit(owner, {
        kind: 'provider_error', session_epoch: owner.epoch,
        code: 'volcengine_asr_start', recoverable: true,
      })
      await this.#emit(owner, {
        kind: 'user_transcript_failed', session_epoch: owner.epoch, item_id: itemId,
      })
      await Promise.resolve(this.#endpointing.reset()).catch(() => undefined)
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
      await this.#failAsr(owner, 'volcengine_asr_append')
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
      await this.#failAsr(owner, 'volcengine_asr_append')
    }
  }

  async #stopAsr(owner: EpochOwner, commit: boolean, signal: AbortSignal): Promise<void> {
    const active = owner.asr
    if (active === null) {
      await Promise.resolve(this.#endpointing.reset()).catch(() => undefined)
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
      await Promise.resolve(this.#endpointing.reset()).catch(() => undefined)
      return
    }
    if (!commit) {
      await this.#discardAsr(owner)
      await Promise.resolve(this.#endpointing.reset()).catch(() => undefined)
      return
    }
    try {
      await active.session.finish(combineSignals(signal, active.controller.signal))
    } catch {
      await this.#emit(owner, {
        kind: 'provider_error', session_epoch: owner.epoch,
        code: 'volcengine_asr_finish', recoverable: true,
      })
      await this.#emit(owner, {
        kind: 'user_transcript_failed', session_epoch: owner.epoch, item_id: active.itemId,
      })
      await this.#discardAsr(owner)
    } finally {
      await Promise.resolve(this.#endpointing.reset()).catch(() => undefined)
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
          this.#record('volcengine.asr.final', {epoch: owner.epoch})
          if (stripLikePython(transcript.text) === '') {
            await this.#emit(owner, {
              kind: 'user_transcript_failed', session_epoch: owner.epoch, item_id: active.itemId,
            })
          } else {
            await this.#emit(owner, {
              kind: 'user_transcript_final', session_epoch: owner.epoch,
              item_id: active.itemId, text: transcript.text,
            })
            await this.#startUserResponse(owner, transcript.text)
          }
          return
        } else {
          this.#record('volcengine.asr.partial', {epoch: owner.epoch})
          await this.#emit(owner, {
            kind: 'user_transcript_delta', session_epoch: owner.epoch,
            item_id: active.itemId, text: transcript.text,
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
          code: 'volcengine_asr_receive', recoverable: true,
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
    await Promise.resolve(this.#endpointing.reset()).catch(() => undefined)
  }

  async #discardAsr(owner: EpochOwner): Promise<void> {
    const active = owner.asr
    if (active === null) return
    owner.asr = null
    active.controller.abort()
    await active.session.close().catch(() => undefined)
    await settleWithin(active.task, this.#settleTimeoutMs)
  }

  async #startUserResponse(owner: EpochOwner, text: string): Promise<void> {
    await this.#serializeResponseStart(owner, async () => {
      if (owner.response !== null) {
        owner.response.controller.abort()
        await settleWithin(owner.response.task, this.#settleTimeoutMs)
      }
      const {inputs, consumedIds} = this.#takeUserResponseInputs(owner)
      this.#markConsumed(owner, consumedIds)
      await this.#resolvePendingToolCall(owner, inputs)
      if (!this.#isCurrent(owner)) throw new CascadedRealtimeError('state')
      this.#startResponse(owner, [...inputs, {kind: 'user_text', text}])
    })
  }

  #startResponse(owner: EpochOwner, inputs: readonly CascadedLlmInput[]): void {
    const controller = new AbortController()
    const active: ActiveResponse = {
      controller, id: null, task: Promise.resolve(), terminal: false, tts: null,
    }
    owner.response = active
    active.task = Promise.resolve().then(() => this.#runResponse(owner, active, inputs))
    void active.task.catch(() => undefined)
  }

  #startSilentResponse(owner: EpochOwner): void {
    const controller = new AbortController()
    const active: ActiveResponse = {
      controller, id: null, task: Promise.resolve(), terminal: false, tts: null,
    }
    owner.response = active
    active.task = Promise.resolve().then(async () => {
      const responseId = this.#freshId()
      active.id = responseId
      try {
        await this.#emit(owner, {
          kind: 'response_started', session_epoch: owner.epoch, response_id: responseId,
        })
        await this.#emitTerminal(owner, active, 'completed', 'completed')
      } finally {
        if (owner.response === active) owner.response = null
      }
    })
    void active.task.catch(() => undefined)
  }

  async #runResponse(
    owner: EpochOwner,
    active: ActiveResponse,
    inputs: readonly CascadedLlmInput[],
  ): Promise<void> {
    let textSeen = false
    let toolSeen = false
    let pendingTool: Extract<CascadedLlmEvent, {kind: 'tool_call'}> | null = null
    const transcript: string[] = []
    let transcriptLength = 0
    const chunker = new TextChunker()
    const signal = combineSignals(owner.controller.signal, active.controller.signal)
    let continuationResetFailed = false
    try {
      for await (const event of owner.llm.stream({
        inputs: inputs.map(item => structuredClone(item)),
        tools: owner.tools.map(tool => structuredClone(tool)),
        signal,
      })) {
        throwIfAborted(signal)
        if (!this.#isCurrent(owner) || owner.response !== active) return
        if (event.kind === 'response_started') {
          if (active.id !== null) throw new Error('duplicate LLM response identity')
          active.id = event.response_id
          this.#record('cascaded.llm.started', {epoch: owner.epoch})
          await this.#emit(owner, {
            kind: 'response_started', session_epoch: owner.epoch, response_id: event.response_id,
          })
          active.tts = this.#newTtsState(event.response_id, signal)
          this.#prewarmTts(owner, active.tts)
        } else if (event.kind === 'text_delta') {
          if (toolSeen) throw new MixedResponseFailure()
          if (active.id === null || active.tts === null) throw new Error('LLM text before identity')
          textSeen = true
          transcriptLength += [...event.text].length
          if (transcriptLength > MAX_REALTIME_TEXT) throw new Error('LLM response text overflow')
          transcript.push(event.text)
          if (transcriptLength === [...event.text].length) {
            this.#record('cascaded.llm.first_text', {epoch: owner.epoch})
          }
          await this.#emit(owner, {
            kind: 'response_transcript_delta', session_epoch: owner.epoch,
            response_id: active.id, text: event.text,
          })
          for (const chunk of chunker.push(event.text)) {
            await this.#sendTtsText(owner, active.tts, chunk)
          }
        } else if (event.kind === 'tool_call') {
          if (textSeen || toolSeen) throw new MixedResponseFailure()
          if (active.id === null) throw new Error('LLM tool before identity')
          toolSeen = true
          pendingTool = event
          owner.pendingToolCallId = event.call_id
          await this.#cancelTts(owner, active)
          this.#record('cascaded.llm.tool_call', {epoch: owner.epoch})
        } else if (event.kind === 'response_failed') {
          active.id ??= event.response_id
          throw new Error('LLM stable provider failure')
        } else {
          if (active.id === null || event.response_id !== active.id) {
            throw new Error('LLM terminal identity mismatch')
          }
          if (textSeen) {
            if (active.tts === null) throw new Error('missing TTS state')
            for (const chunk of chunker.finish()) {
              await this.#sendTtsText(owner, active.tts, chunk)
            }
            await this.#finishTts(owner, active)
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
        await this.#emit(owner, {
          kind: 'provider_error', session_epoch: owner.epoch,
          code: ttsFailure ? 'volcengine_tts_receive' : 'cascaded_response_failed',
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
      openPromise: null,
      session: null,
      receiveTask: null,
      texts: [],
      audioEmitted: false,
      retryUsed: false,
      firstTextRecorded: false,
    }
  }

  #prewarmTts(owner: EpochOwner, state: ActiveTts): void {
    if (state.openPromise !== null || state.session !== null) return
    state.openPromise = this.#ttsClient.open(
      combineSignals(state.responseSignal, state.controller.signal),
    )
    void state.openPromise.catch(() => undefined)
    this.#record('volcengine.tts.prewarm', {epoch: owner.epoch})
  }

  async #ensureTts(owner: EpochOwner, state: ActiveTts): Promise<TtsSession> {
    if (state.session !== null) return state.session
    const prewarm = state.openPromise
    state.openPromise = null
    let session: TtsSession
    if (prewarm !== null) {
      try {
        session = await prewarm
        this.#record('volcengine.tts.prewarm.ready', {epoch: owner.epoch})
      } catch {
        this.#record('volcengine.tts.prewarm.failed', {epoch: owner.epoch})
        session = await this.#ttsClient.open(
          combineSignals(state.responseSignal, state.controller.signal),
        )
      }
    } else {
      session = await this.#ttsClient.open(
        combineSignals(state.responseSignal, state.controller.signal),
      )
    }
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
        this.#record('volcengine.tts.first_text', {epoch: owner.epoch})
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
        this.#record('volcengine.tts.first_audio', {epoch: owner.epoch})
      }
      await this.#emit(owner, {
        kind: 'response_audio_delta', session_epoch: owner.epoch,
        response_id: state.responseId, pcm,
      })
    }
  }

  async #retryTts(owner: EpochOwner, state: ActiveTts): Promise<boolean> {
    if (state.audioEmitted || state.retryUsed || state.responseSignal.aborted) return false
    state.retryUsed = true
    this.#record('volcengine.tts.reconnect', {epoch: owner.epoch})
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
    if (state === null || state.texts.length === 0) return
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
    if (hadResource) this.#record('volcengine.tts.cancel', {epoch: owner.epoch})
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
      response_id: active.id, status, reason,
    })
    this.#record('volcengine.response.terminal', {status})
  }

  #takeResponseInputs(owner: EpochOwner, intent: HostResponseIntent): CascadedLlmInput[] {
    if (!owner.pending.has(intent.item.host_item_id)) return []
    const selected: CascadedLlmInput[] = []
    for (const [hostId, pending] of [...owner.pending]) {
      let include = hostId === intent.item.host_item_id
        || pending.item.kind === 'recovery' || pending.item.kind === 'dialogue_context'
      if (intent.item.kind === 'tool_output' && pending.item.kind === 'tool_output') include = true
      if (!include) continue
      selected.push(structuredClone(pending.input))
      owner.pending.delete(hostId)
    }
    return selected
  }

  #takeUserResponseInputs(owner: EpochOwner): {
    readonly inputs: CascadedLlmInput[]
    readonly consumedIds: string[]
  } {
    const inputs: CascadedLlmInput[] = []
    const consumedIds: string[] = []
    for (const [hostId, pending] of [...owner.pending]) {
      if (pending.item.kind !== 'recovery' && pending.item.kind !== 'dialogue_context'
        && pending.item.kind !== 'tool_output') continue
      inputs.push(structuredClone(pending.input))
      consumedIds.push(hostId)
      owner.pending.delete(hostId)
    }
    return {inputs, consumedIds}
  }

  #markConsumed(owner: EpochOwner, hostIds: readonly string[]): void {
    if (hostIds.length === 0) return
    owner.consumptionGeneration += 1
    for (const hostId of hostIds) {
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
    successful = await safeCallWithin(() => this.#closeLlm(), this.#settleTimeoutMs) && successful
    successful = await safeCallWithin(
      async () => { await this.#endpointing.reset() }, this.#settleTimeoutMs,
    ) && successful
    return successful
  }

  #closeLlm(): Promise<void> {
    this.#llmClosePromise ??= Promise.resolve().then(() => this.#llm.close())
    return this.#llmClosePromise
  }

  #requiredOwner(): EpochOwner {
    const owner = this.#owner
    if (this.#state !== 'connected' || owner === null || owner.revoked) {
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
      throw new CascadedRealtimeError('configuration')
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
    ? `${GUARD_ACTIVATION_PREFIX}以下内容不是用户说的话，也不是新的用户目标。`
      + `只把该事实作为宿主提供的上下文：${item.content}`
    : `Nova Audio Agent ${labels[item.kind]}：${item.content}`
  return item.kind === 'dialogue_context'
    ? {kind: 'packed_history', content}
    : {kind: 'host_context', content}
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
