import { jsonValueSchema } from '../events.js'
import { canonicalJson } from '../canonical-json.js'
import {
  MAX_REALTIME_PCM_BYTES,
  hostContextItemSchema,
  hostResponseIntentSchema,
  itemIdentitySchema,
  realtimeIdentifierSchema,
  realtimeProviderEventSchema,
  responseAdaptationContextSchema,
  RealtimeProtocolError,
  sessionIdentitySchema,
  workspaceContextInjectionSchema,
  type HostContextItem,
  type HostResponseIntent,
  type ItemIdentity,
  type JsonObject,
  type RealtimeProvider,
  type RealtimeProviderEvent,
  type ResponseAdaptationContext,
  type SessionIdentity,
  type WorkspaceContextDeliveryRecord,
} from './protocol.js'

export type RealtimeProviderSessionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'closed'

export interface InjectHostItemOptions {
  readonly confirmationTimeout?: number | null
  readonly asUserActivation?: boolean
  readonly signal?: AbortSignal
}

const jsonObjectSchema = jsonValueSchema.refine(
  value => value !== null && !Array.isArray(value) && typeof value === 'object',
  'tool schema must be a JSON object',
)

interface ConnectionOwner {
  readonly controller: AbortController
  readonly identity: SessionIdentity
}

export interface RealtimeProviderSessionOptions {
  /** Synchronous host cache; failures are advisory and never delay audio indefinitely. */
  readonly responseAdaptation?: () => ResponseAdaptationContext | undefined
  readonly onDiagnostic?: (diagnostic: {
    readonly kind: 'response_adaptation'
    readonly reason: 'read_failed' | 'invalid' | 'replace_failed'
    readonly epoch: number
    readonly revision: number | null
  }) => void
}

class InternalProtocolError extends RealtimeProtocolError {}

export class RealtimeProviderSession {
  readonly #provider: RealtimeProvider
  #state: RealtimeProviderSessionState = 'new'
  #identity: SessionIdentity | null = null
  #lastEpoch = 0
  #connectionAbort: AbortController | null = null
  #reading: AbortController | null = null
  #closing: Promise<void> | null = null
  readonly #responseAdaptation: (() => ResponseAdaptationContext | undefined) | undefined
  readonly #onDiagnostic: RealtimeProviderSessionOptions['onDiagnostic']
  #responseAdaptationTail: Promise<void> = Promise.resolve()
  #audioAdaptationRefresh: Promise<void> | undefined
  #responseAdaptationReadFailureDiagnosedEpoch: number | null = null
  #responseAdaptationAttempt: {
    readonly epoch: number
    readonly revision: number
    readonly content: string | null
    readonly confirmed: boolean
  } | null = null
  readonly #connectedObservers = new Set<(
    identity: SessionIdentity,
  ) => void | Promise<void>>()

  constructor(provider: RealtimeProvider, options: RealtimeProviderSessionOptions = {}) {
    this.#provider = provider
    this.#responseAdaptation = options.responseAdaptation
    this.#onDiagnostic = options.onDiagnostic
  }

  get userResponseMode(): 'automatic' | 'requested' {
    return this.#provider.userResponseMode ?? 'automatic'
  }

  get state(): RealtimeProviderSessionState {
    return this.#state
  }

  get identity(): SessionIdentity | null {
    return this.#identity === null ? null : structuredClone(this.#identity)
  }

  observeConnected(observer: (identity: SessionIdentity) => void | Promise<void>): () => void {
    this.#connectedObservers.add(observer)
    return () => { this.#connectedObservers.delete(observer) }
  }

  connect(options: {
    readonly tools: readonly Record<string, unknown>[]
  }, signal?: AbortSignal): Promise<SessionIdentity>
  connect(tools?: readonly JsonObject[], signal?: AbortSignal): Promise<SessionIdentity>
  async connect(
    input: readonly JsonObject[] | {
      readonly tools: readonly Record<string, unknown>[]
    } = [],
    signal?: AbortSignal,
  ): Promise<SessionIdentity> {
    if (this.#state === 'closed') throw new Error('realtime provider session is closed')
    if (this.#state !== 'new' && this.#state !== 'disconnected') {
      throw new Error(`realtime provider session cannot connect from ${this.#state}`)
    }
    const tools: readonly unknown[] = Array.isArray(input)
      ? input
      : (input as {readonly tools: readonly Record<string, unknown>[]}).tools
    const parsedTools = tools.map(tool => jsonObjectSchema.parse(tool) as JsonObject)
    const connectionAbort = new AbortController()
    this.#connectionAbort = connectionAbort
    this.#state = 'connecting'
    try {
      const identity = sessionIdentitySchema.parse(await this.#provider.connect({
        tools: structuredClone(parsedTools),
        signal: combinedSignal(connectionAbort.signal, signal),
      }))
      if (identity.epoch <= this.#lastEpoch) {
        throw new InternalProtocolError('provider session epoch must increase')
      }
      if (this.#isClosed() || this.#connectionAbort !== connectionAbort) {
        throw new InternalProtocolError('provider connection completed after cancellation')
      }
      this.#lastEpoch = identity.epoch
      this.#identity = Object.freeze({...identity})
      this.#responseAdaptationTail = Promise.resolve()
      this.#audioAdaptationRefresh = undefined
      this.#responseAdaptationReadFailureDiagnosedEpoch = null
      this.#responseAdaptationAttempt = null
      this.#state = 'connected'
      const owner = this.#requiredConnectionOwner()
      await this.#refreshResponseAdaptation(owner, signal)
      this.#assertCurrentConnection(owner)
      for (const observer of [...this.#connectedObservers]) {
        await observer(structuredClone(identity))
      }
      return structuredClone(identity)
    } catch (error) {
      connectionAbort.abort()
      if (this.#connectionAbort === connectionAbort) this.#connectionAbort = null
      if (!this.#isClosed()) {
        try {
          await this.#provider.close()
        } catch {
          // The original bounded connect failure remains the useful verdict.
        }
        if (!this.#isClosed()) this.#state = 'disconnected'
      }
      this.#identity = null
      throw protocolFailure('provider connect failed', error)
    }
  }

  async reconnect(
    tools: readonly Record<string, unknown>[] = [],
    signal?: AbortSignal,
  ): Promise<SessionIdentity> {
    if (this.#state === 'closed') throw new Error('realtime provider session is closed')
    if (this.#state === 'connecting') throw new Error('realtime provider session is connecting')
    this.#connectionAbort?.abort()
    this.#connectionAbort = null
    this.#identity = null
    this.#state = 'connecting'
    try {
      await this.#provider.close()
    } catch (error) {
      if (!this.#isClosed()) this.#state = 'disconnected'
      throw protocolFailure('provider reconnect close failed', error)
    }
    if (this.#isClosed()) throw new Error('realtime provider session is closed')
    this.#state = 'disconnected'
    return this.connect({tools}, signal)
  }

  async submitText(text: string, signal?: AbortSignal): Promise<void> {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || !this.#provider.submitText) throw new RealtimeProtocolError('text input unavailable')
    const owner = this.#requiredConnectionOwner()
    await this.#provider.submitText(text, combinedSignal(owner.controller.signal, signal))
    this.#assertCurrentConnection(owner)
  }

  async transcribeDraft(pcm: Uint8Array, signal?: AbortSignal): Promise<string> {
    if (!this.#provider.transcribeDraft) throw new RealtimeProtocolError('dictation unavailable')
    const owner = this.#requiredConnectionOwner()
    const text = await this.#provider.transcribeDraft(pcm, combinedSignal(owner.controller.signal, signal))
    this.#assertCurrentConnection(owner)
    return text
  }

  async sendAudio(pcm: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (!(pcm instanceof Uint8Array) || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
      throw new RealtimeProtocolError('input PCM must be non-empty aligned PCM16 bytes')
    }
    if (pcm.byteLength > MAX_REALTIME_PCM_BYTES) {
      throw new RealtimeProtocolError('input PCM frame is too large')
    }
    const owned = pcm.slice()
    const owner = this.#requiredConnectionOwner()
    try {
      if (this.#audioAdaptationRefresh === undefined) {
        const refresh = this.#refreshResponseAdaptation(owner, signal).catch(() => undefined).finally(() => {
          if (this.#audioAdaptationRefresh === refresh) this.#audioAdaptationRefresh = undefined
        })
        this.#audioAdaptationRefresh = refresh
      }
      this.#assertCurrentConnection(owner)
      signal?.throwIfAborted()
      await this.#provider.sendAudio(
        owned,
        combinedSignal(owner.controller.signal, signal),
      )
      this.#assertCurrentConnection(owner)
    } catch (error) {
      throw protocolFailure('provider audio send failed', error)
    }
  }

  async injectHostItem(
    input: HostContextItem,
    options: InjectHostItemOptions = {},
  ): Promise<ItemIdentity> {
    const item = hostContextItemSchema.parse(input)
    if (item.kind === 'workspace_context') {
      throw new RealtimeProtocolError(
        'workspace context delivery is unavailable until provider capability is proven',
      )
    }
    const confirmationTimeout = options.confirmationTimeout ?? null
    if (
      confirmationTimeout !== null
      && (!Number.isFinite(confirmationTimeout) || confirmationTimeout < 0)
    ) throw new RangeError('confirmation timeout must be a non-negative finite number')
    const owner = this.#requiredConnectionOwner()
    let result: ItemIdentity
    try {
      result = itemIdentitySchema.parse(await this.#provider.injectHostItem(
        structuredClone(item),
        {
          confirmationTimeout,
          asUserActivation: options.asUserActivation ?? false,
          signal: combinedSignal(owner.controller.signal, options.signal),
        },
      ))
      this.#assertCurrentConnection(owner)
    } catch (error) {
      throw protocolFailure('host item injection failed', error)
    }
    if (
      result.session_epoch !== owner.identity.epoch
      || result.host_item_id !== item.host_item_id
    ) throw new RealtimeProtocolError('host item confirmation identity mismatch')
    return structuredClone(result)
  }

  async retireHostItem(input: string, signal?: AbortSignal): Promise<boolean> {
    const providerItemId = realtimeIdentifierSchema.parse(input)
    const owner = this.#requiredConnectionOwner()
    if (this.#provider.retireHostItem === undefined) return false
    try {
      await this.#provider.retireHostItem(
        providerItemId,
        combinedSignal(owner.controller.signal, signal),
      )
      this.#assertCurrentConnection(owner)
      return true
    } catch (error) {
      throw protocolFailure('host item retirement failed', error)
    }
  }

  async injectWorkspaceContext(
    input: HostContextItem,
    options: Omit<InjectHostItemOptions, 'asUserActivation'> = {},
  ): Promise<WorkspaceContextDeliveryRecord> {
    const item = hostContextItemSchema.parse(input)
    if (item.kind !== 'workspace_context') {
      throw new RealtimeProtocolError('workspace context requires the dedicated item kind')
    }
    if (this.#provider.injectWorkspaceContext === undefined) {
      throw new RealtimeProtocolError(
        'workspace context delivery is unavailable until provider capability is proven',
      )
    }
    const confirmationTimeout = options.confirmationTimeout ?? null
    if (
      confirmationTimeout !== null
      && (!Number.isFinite(confirmationTimeout) || confirmationTimeout < 0)
    ) throw new RangeError('confirmation timeout must be a non-negative finite number')
    const owner = this.#requiredConnectionOwner()
    try {
      const record = workspaceContextInjectionSchema.parse(await this.#provider.injectWorkspaceContext(
        structuredClone(item),
        {
          confirmationTimeout,
          signal: combinedSignal(owner.controller.signal, options.signal),
        },
      ))
      this.#assertCurrentConnection(owner)
      if (record.delivery.session_epoch !== owner.identity.epoch) {
        throw new InternalProtocolError('workspace context delivery identity mismatch')
      }
      if (canonicalJson(record.item) !== canonicalJson(item)) {
        throw new InternalProtocolError('workspace context delivery item mismatch')
      }
      return freezeWorkspaceContextDelivery(record)
    } catch (error) {
      throw protocolFailure('workspace context injection failed', error)
    }
  }

  async createResponse(intent: HostResponseIntent, signal?: AbortSignal): Promise<void> {
    const parsed = hostResponseIntentSchema.parse(intent)
    const owner = this.#requiredConnectionOwner()
    try {
      await this.#refreshResponseAdaptation(owner, signal)
      this.#assertCurrentConnection(owner)
      await this.#provider.createResponse(
        structuredClone(parsed),
        combinedSignal(owner.controller.signal, signal),
      )
      this.#assertCurrentConnection(owner)
    } catch (error) {
      throw protocolFailure('provider response creation failed', error)
    }
  }

  async ensureResponse(userItemId?: string, signal?: AbortSignal, requestId?: string): Promise<boolean> {
    if (this.#provider.ensureResponse === undefined) {
      throw new RealtimeProtocolError('provider response ensuring is unavailable')
    }
    const owner = this.#requiredConnectionOwner()
    try {
      await this.#refreshResponseAdaptation(owner, signal)
      this.#assertCurrentConnection(owner)
      if (userItemId !== undefined) realtimeIdentifierSchema.parse(userItemId)
      if (requestId !== undefined) realtimeIdentifierSchema.parse(requestId)
      const accepted = await this.#provider.ensureResponse(
        combinedSignal(owner.controller.signal, signal), userItemId, requestId,
      )
      this.#assertCurrentConnection(owner)
      return accepted !== false
    } catch (error) {
      throw protocolFailure('provider response ensuring failed', error)
    }
  }

  async cancelResponse(responseId: string, signal?: AbortSignal): Promise<void> {
    const parsed = realtimeIdentifierSchema.parse(responseId)
    const owner = this.#requiredConnectionOwner()
    try {
      await this.#provider.cancelResponse(
        parsed,
        combinedSignal(owner.controller.signal, signal),
      )
      this.#assertCurrentConnection(owner)
    } catch (error) {
      throw protocolFailure('provider response cancellation failed', error)
    }
  }

  async *events(signal?: AbortSignal): AsyncGenerator<RealtimeProviderEvent> {
    const owner = this.#requiredConnectionOwner()
    if (this.#reading === owner.controller) {
      throw new Error('realtime provider events already have a consumer')
    }
    this.#reading = owner.controller
    const streamSignal = combinedSignal(owner.controller.signal, signal)
    try {
      for await (const raw of this.#provider.events(streamSignal)) {
        if (streamSignal.aborted || !this.#isCurrentConnection(owner)) return
        let event: RealtimeProviderEvent
        try {
          event = realtimeProviderEventSchema.parse(raw)
        } catch {
          throw new InternalProtocolError('provider emitted an invalid realtime event')
        }
        if (event.session_epoch !== owner.identity.epoch) continue
        yield cloneProviderEvent(event)
      }
    } catch (error) {
      if (!streamSignal.aborted) throw protocolFailure('provider event stream failed', error)
    } finally {
      if (this.#reading === owner.controller) this.#reading = null
    }
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing
    this.#state = 'closed'
    this.#identity = null
    this.#connectionAbort?.abort()
    this.#connectionAbort = null
    this.#closing = this.#provider.close().catch(error => {
      throw protocolFailure('provider close failed', error)
    })
    return this.#closing
  }

  #requiredIdentity(): SessionIdentity {
    if (this.#state !== 'connected' || this.#identity === null) {
      throw new Error('realtime provider session is not connected')
    }
    return this.#identity
  }

  #requiredConnectionOwner(): ConnectionOwner {
    const identity = this.#requiredIdentity()
    if (this.#connectionAbort === null) {
      throw new Error('realtime provider session has no connection owner')
    }
    return {controller: this.#connectionAbort, identity}
  }

  #isCurrentConnection(owner: ConnectionOwner): boolean {
    return this.#state === 'connected'
      && this.#connectionAbort === owner.controller
      && this.#identity === owner.identity
  }

  #assertCurrentConnection(owner: ConnectionOwner): void {
    if (!this.#isCurrentConnection(owner)) {
      throw new InternalProtocolError('provider operation completed for a stale session')
    }
  }

  #isClosed(): boolean {
    return this.#state === 'closed'
  }

  async #refreshResponseAdaptation(owner: ConnectionOwner, signal?: AbortSignal): Promise<void> {
    if (this.#provider.replaceResponseAdaptation === undefined || this.#responseAdaptation === undefined) return
    const operation = this.#responseAdaptationTail.then(async () => {
      if (!this.#isCurrentConnection(owner)) return
      let raw: unknown
      try {
        raw = this.#responseAdaptation?.()
      } catch {
        if (this.#responseAdaptationReadFailureDiagnosedEpoch !== owner.identity.epoch) {
          this.#responseAdaptationReadFailureDiagnosedEpoch = owner.identity.epoch
          this.#reportAdaptationDiagnostic('read_failed', owner.identity.epoch, null)
        }
        return
      }
      if (raw === undefined) return
      const parsed = responseAdaptationContextSchema.safeParse(raw)
      if (!parsed.success) {
        this.#reportAdaptationDiagnostic('invalid', owner.identity.epoch, null)
        return
      }
      const context = parsed.data
      const previous = this.#responseAdaptationAttempt
      if (previous !== null && previous.epoch === owner.identity.epoch
        && previous.confirmed && previous.content === context.content
        && context.revision >= previous.revision) {
        this.#responseAdaptationAttempt = {
          epoch: owner.identity.epoch, revision: context.revision, content: context.content, confirmed: true,
        }
        return
      }
      if (previous !== null && previous.epoch === owner.identity.epoch
        && previous.revision === context.revision && previous.content === context.content) return
      this.#responseAdaptationAttempt = {
        epoch: owner.identity.epoch, revision: context.revision, content: context.content, confirmed: false,
      }
      try {
        await this.#provider.replaceResponseAdaptation!(
          structuredClone(context),
          combinedSignal(owner.controller.signal, signal),
        )
        this.#assertCurrentConnection(owner)
        this.#responseAdaptationAttempt = {
          epoch: owner.identity.epoch, revision: context.revision, content: context.content, confirmed: true,
        }
      } catch {
        // This affects wording only. The captured owner is checked again before audio/response send.
        this.#reportAdaptationDiagnostic('replace_failed', owner.identity.epoch, context.revision)
      }
    })
    this.#responseAdaptationTail = operation.then(() => undefined, () => undefined)
    await operation
  }

  #reportAdaptationDiagnostic(
    reason: 'read_failed' | 'invalid' | 'replace_failed',
    epoch: number,
    revision: number | null,
  ): void {
    try { this.#onDiagnostic?.({kind: 'response_adaptation', reason, epoch, revision}) }
    catch { /* diagnostics are never allowed to affect provider delivery */ }
  }
}


function freezeWorkspaceContextDelivery(
  record: WorkspaceContextDeliveryRecord,
): WorkspaceContextDeliveryRecord {
  const owned = structuredClone(record)
  Object.freeze(owned.item)
  Object.freeze(owned.delivery)
  return Object.freeze(owned)
}

function cloneProviderEvent(event: RealtimeProviderEvent): RealtimeProviderEvent {
  if (event.kind !== 'response_audio_delta') return structuredClone(event)
  return {...event, pcm: event.pcm.slice()}
}

function combinedSignal(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  return secondary === undefined ? primary : AbortSignal.any([primary, secondary])
}

function protocolFailure(message: string, error: unknown): Error {
  if (error instanceof InternalProtocolError) return error
  return new RealtimeProtocolError(message)
}
