import type { Clock } from './clock.js'
import type { EventInput, EventRecord, JsonValue } from './events.js'
import type { IdFactory } from './ids.js'
import { CONVERSATION_CHANNEL, type Memory, type MemoryItem } from './memory.js'
import {BlackboardSession, type BlackboardSessionOptions} from './memory/blackboard-session.js'
import {bindHostExecutorCapability} from './host-executor-capability.js'
import type {
  Delegate,
  DelegateRequest,
  ExecutorManifest,
} from './ports.js'
import {
  CoreRuntime,
  type GraphContextProvider,
  type ModelCall,
  type RuntimeDispatchResult,
} from './runtime.js'
import { SLOTS, type Slot, type WakeReason } from './slots.js'
import type {Suggestion} from './suggestions.js'

export interface ModelPort {
  complete(call: ModelCall, signal: AbortSignal): Promise<unknown>
}

export interface ExecutorProgress {
  readonly phase: 'started' | 'working'
  readonly internal_activity: number
  readonly elapsed: number
  readonly summary: string | null
}

export interface ExecutorObservation {
  readonly trust: 'trusted_user' | 'trusted_system' | 'untrusted_external'
  readonly content: Readonly<Record<string, JsonValue>>
  readonly refs?: readonly string[]
}

/** An executor's report only; the runtime binds delegate and channel identity. */
export interface ExecutorHandoff {
  readonly outcome: 'ok' | 'refused' | 'unknown' | 'failed' | 'cancelled'
  readonly trust: 'trusted_user' | 'trusted_system' | 'untrusted_external'
  readonly content: Readonly<Record<string, JsonValue>>
  readonly refs?: readonly string[]
}

/** Host-only, non-serializable authority. Never placed in Delegate, Event or Memory. */
export interface UserTurnAuthority {
  readonly originRef: string
  readonly sessionEpoch: number
  readonly acceptedUserInputRevision: number
  readonly stillWanted: () => boolean
}

export interface ExecutorDispatchContext {
  readonly clock: Clock
  readonly delegate: Delegate
  readonly signal: AbortSignal
  readonly progress: (payload: ExecutorProgress) => void
  readonly observe?: (payload: ExecutorObservation) => void
  readonly userTurn?: UserTurnAuthority
}

/** Result of an adapter's own admission hook; `null` from the hook means "apply the defaults". */
export type ExecutorAdmission =
  | {readonly ok: true; readonly request: Readonly<Record<string, JsonValue>>; readonly sync_result: boolean}
  | {readonly ok: false}

export interface ExecutorAdapter {
  readonly manifest: ExecutorManifest
  /**
   * Optional per-op admission for ops whose params outgrow plain JSON-schema validation (oneOf
   * branches) or whose synchronous-result decision depends on the arguments. Absent or `null`:
   * the op's `params` schema and `sync_result` flag apply.
   */
  admitRequest?(op: string, request: Readonly<Record<string, JsonValue>>): ExecutorAdmission | null
  dispatch(
    op: string,
    request: Readonly<Record<string, JsonValue>>,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff>
}

export interface CausalRuntimeOptions {
  readonly blackboard?: BlackboardSessionOptions
  readonly conversationId?: string
  readonly clock: Clock
  readonly ids: IdFactory
  readonly models?: Readonly<Partial<Record<Slot, ModelPort>>>
  readonly executors?: readonly ExecutorAdapter[]
  readonly retainRoutingHistory?: boolean
  readonly suggestionCooldown?: number
  readonly freshWindow?: number
  readonly shutdownGrace?: number
}

interface OwnedTask {
  readonly controller: AbortController
  readonly kind: 'model' | 'executor'
  promise: Promise<void>
}

interface PendingUserInput {
  readonly resolve: (reference: string) => void
  readonly reject: (reason: Error) => void
}

/** Cleared terminal events settle host control only; their content must never be projected again. */
export type RuntimeObserver = (event: EventRecord, currentConversation?: boolean) => void

const DEFAULT_SHUTDOWN_GRACE = 1

/** Applied events between forced event-loop turns while the queue stays ready. */
const DRAIN_YIELD_INTERVAL = 64

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => { setImmediate(resolve) })
}

export class CausalRuntime {
  readonly core: CoreRuntime
  readonly #clock: Clock
  readonly #models: Readonly<Partial<Record<Slot, ModelPort>>>
  readonly #executors = new Map<string, ExecutorAdapter>()
  readonly #tasks = new Set<OwnedTask>()
  readonly #observers = new Set<RuntimeObserver>()
  readonly #pendingUserInputs = new Map<number, PendingUserInput>()
  readonly #hostExecutorCapabilities = new Map<string, object>()
  readonly #userTurns = new Map<string, UserTurnAuthority>()
  readonly #launchChecks = new Map<string, () => boolean>()
  readonly #shutdownGrace: number
  #state: 'new' | 'serving' | 'closed' = 'new'
  #acceptCompletions = true
  #failure: Error | undefined
  #workVersion = 0
  #workWaiter: (() => void) | undefined
  readonly #blackboard: BlackboardSession | undefined
  #memoryReady: Promise<void> | undefined
  #memoryOpened = false
  #memoryClosed = false
  #serving: Promise<void> | undefined
  #maintenance: NodeJS.Timeout | undefined
  #clearing: Promise<void> | undefined
  #applying: Promise<void> | undefined

  constructor(options: CausalRuntimeOptions) {
    this.#clock = options.clock
    this.#models = {...options.models}
    this.#shutdownGrace = options.shutdownGrace ?? DEFAULT_SHUTDOWN_GRACE
    if (!Number.isFinite(this.#shutdownGrace) || this.#shutdownGrace < 0) {
      throw new RangeError('shutdown grace must be a non-negative finite number')
    }
    for (const adapter of options.executors ?? []) {
      if (this.#executors.has(adapter.manifest.name)) {
        throw new Error(`duplicate executor adapter: ${adapter.manifest.name}`)
      }
      this.#executors.set(adapter.manifest.name, adapter)
    }
    const modelSlots = SLOTS.filter(slot => this.#models[slot] !== undefined)
    this.core = new CoreRuntime({
      manifests: [...this.#executors.values()].map(adapter => adapter.manifest),
      ...(options.conversationId === undefined ? {} : {conversationId: options.conversationId}),
      ids: options.ids,
      modelSlots,
      ...(options.retainRoutingHistory === undefined
        ? {}
        : {retainRoutingHistory: options.retainRoutingHistory}),
      ...(options.suggestionCooldown === undefined
        ? {}
        : {suggestionCooldown: options.suggestionCooldown}),
      ...(options.freshWindow === undefined ? {} : {freshWindow: options.freshWindow}),
      onModelCall: call => this.#startModelCall(call),
      onExecutorDispatch: (dispatchIndex, delegate) => {
        this.#startExecutorDispatch(dispatchIndex, delegate)
      },
    })
    this.#blackboard = options.blackboard === undefined ? undefined : new BlackboardSession(this.memory, options.blackboard)
  }

  get hasPersistentMemory(): boolean { return this.#blackboard !== undefined }

  openMemory(): Promise<void> {
    if (this.#memoryClosed) return Promise.reject(new Error('causal runtime memory is closed'))
    this.#memoryReady ??= (this.#blackboard?.open() ?? Promise.resolve()).then(() => { if (!this.#memoryClosed) this.#memoryOpened = true })
    return this.#memoryReady
  }

  /** Also used by the host intake writer, which does not enter through the reducer. */
  async flushMemory(maintenance = false): Promise<void> {
    if (this.#clearing !== undefined) await this.#clearing
    if (this.#blackboard === undefined) return
    try { await this.#blackboard.flush(maintenance) }
    catch (error) {
      this.#failure ??= runtimeError(error)
      this.#notifyWork()
      throw error
    }
  }

  /** Host must fence provider input, playback and projections around this transition. */
  clearConversation(): Promise<void> {
    if (this.#clearing !== undefined) return this.#clearing
    if (this.#state === 'closed' || this.#memoryClosed || !this.#memoryOpened) {
      return Promise.reject(new Error('causal runtime memory is not ready'))
    }
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    const applying = this.#applying
    // Set the gate before aborting models: abort listeners can re-enter host callbacks synchronously.
    this.#clearing = Promise.resolve().then(async () => {
      try {
        await applying
        if (this.#blackboard === undefined) this.memory.clear()
        else await this.#blackboard.clear()
      } catch (error) {
        this.#failure ??= runtimeError(error)
        throw error
      } finally { this.#clearing = undefined; this.#notifyWork() }
    })
    this.core.resetConversationState()
    for (const task of this.#tasks) if (task.kind === 'model') task.controller.abort()
    for (const pending of this.#pendingUserInputs.values()) pending.reject(new Error('conversation cleared before input was acknowledged'))
    this.#pendingUserInputs.clear()
    // Existing executor work keeps its lifecycle; unused one-shot authority does not survive clear.
    this.#hostExecutorCapabilities.clear()
    this.#userTurns.clear()
    this.#launchChecks.clear()
    this.#notifyWork()
    return this.#clearing
  }

  post(input: EventInput, at = this.#clock.now()): EventRecord {
    if (this.#state === 'closed' || this.#memoryClosed) throw new Error('causal runtime is closed')
    if (this.#failure !== undefined) throw this.#failure
    if (this.#clearing !== undefined) throw new Error('conversation is clearing')
    const event = this.core.post(input, at)
    this.#notifyWork()
    return structuredClone(event)
  }

  ingestUserInput(input: {readonly text: string; readonly media_refs?: readonly string[]}): Promise<string> {
    if (this.#state === 'closed' || this.#memoryClosed) return Promise.reject(new Error('causal runtime is closed'))
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    if (this.#clearing !== undefined) return Promise.reject(new Error('conversation is clearing'))
    const event = this.core.post({
      kind: 'user_input',
      payload: input.media_refs === undefined
        ? {text: input.text}
        : {text: input.text, media_refs: [...input.media_refs]},
    }, this.#clock.now())
    const applied = new Promise<string>((resolve, reject) => {
      this.#pendingUserInputs.set(event.seq, {resolve, reject})
    })
    this.#notifyWork()
    return applied
  }

  /** The clock the runtime schedules against, so a caller measures the same time it does. */
  get clock(): Clock {
    return this.#clock
  }

  /** The executor adapters, by manifest name. Read-only: wiring happens at construction. */
  get executors(): ReadonlyMap<string, ExecutorAdapter> {
    return this.#executors
  }

  /** The blackboard. Recall projects from it, so it has to be the same instance the reducer writes. */
  get memory(): Memory {
    return this.core.memory
  }

  /** Admit and durably publish before the adapter starts on the next event-loop turn.
   * Callers install correlation immediately after awaiting admission, before any further I/O.
   */
  async dispatchExternal(
    request: DelegateRequest,
    reason: WakeReason,
    userTurn?: UserTurnAuthority,
    stillWanted?: () => boolean,
  ): Promise<RuntimeDispatchResult> {
    if (this.#state === 'closed' || this.#memoryClosed) return {accepted: false, delegate_id: null, problem: 'closed'}
    if (this.#clearing !== undefined) return {accepted: false, delegate_id: null, problem: 'conversation_clearing'}
    if (this.#blackboard !== undefined && !this.#memoryOpened) return {accepted: false, delegate_id: null, problem: 'memory_not_ready'}
    if (this.#failure !== undefined) throw this.#failure
    const epoch = this.core.conversationEpoch
    const admission = this.core.dispatchExternal(request, reason)
    if (admission.accepted) {
      if (admission.delegate_id !== null && userTurn !== undefined) this.#userTurns.set(admission.delegate_id, userTurn)
      if (admission.delegate_id !== null && stillWanted !== undefined) this.#launchChecks.set(admission.delegate_id, stillWanted)
      this.#notifyWork()
    }
    await this.flushMemory()
    if (epoch !== this.core.conversationEpoch) return {accepted: false, delegate_id: null, problem: 'conversation_cleared'}
    return admission
  }

  /** Admit and privately carry the exact one-shot confirmed project capability. */
  async dispatchConfirmedExternal(
    request: DelegateRequest,
    reason: WakeReason,
    capability: object,
    launchAuthorized: () => boolean,
  ): Promise<RuntimeDispatchResult> {
    if (this.#state === 'closed' || this.#memoryClosed) return {accepted: false, delegate_id: null, problem: 'closed'}
    if (this.#clearing !== undefined) return {accepted: false, delegate_id: null, problem: 'conversation_clearing'}
    if (this.#blackboard !== undefined && !this.#memoryOpened) return {accepted: false, delegate_id: null, problem: 'memory_not_ready'}
    if (this.#failure !== undefined) throw this.#failure
    const epoch = this.core.conversationEpoch
    const admission = this.core.dispatchConfirmedExternal(
      request,
      reason,
      capability,
    )
    if (admission.accepted) {
      if (admission.delegate_id !== null) {
        this.#hostExecutorCapabilities.set(admission.delegate_id, capability)
        this.#launchChecks.set(admission.delegate_id, launchAuthorized)
      }
      this.#notifyWork()
    }
    await this.flushMemory()
    if (epoch !== this.core.conversationEpoch) return {accepted: false, delegate_id: null, problem: 'conversation_cleared'}
    return admission
  }

  /** The delegate a handoff claimed, for an observer projecting that exact event. */
  claimedHandoff(seq: number): Delegate | undefined {
    return this.core.claimedHandoff(seq)
  }

  /** Whether this exact deadline terminated its delegate. */
  terminatedByDeadline(seq: number, delegateId: string): boolean {
    return this.core.terminatedByDeadline(seq, delegateId)
  }

  /** The delegate from either table, whether or not it is still in flight. */
  delegateFor(delegateId: string): Delegate | undefined {
    return this.core.delegateFor(delegateId)
  }

  /** The delegate only if it is still in flight. */
  inFlightDelegate(delegateId: string): Delegate | undefined {
    return this.core.inFlightDelegate(delegateId)
  }

  observe(observer: RuntimeObserver): () => void {
    this.#observers.add(observer)
    return () => this.#observers.delete(observer)
  }

  /** Bind one host-owned, synchronous graph projection at the real model-call boundary. */
  bindGraphContextProvider(provider: GraphContextProvider): () => void {
    return this.core.bindGraphContextProvider(provider)
  }

  bindSuggestionSelected(
    observer: (suggestion: Suggestion, reason: WakeReason) => void,
  ): () => void {
    return this.core.bindSuggestionSelected(observer)
  }

  suggestionFor(suggestionId: string): Suggestion | null {
    return this.core.suggestions.get(suggestionId) ?? null
  }

  confirmSuggestionSpoken(suggestionId: string): void {
    this.core.suggestions.fire(suggestionId, this.#clock.now())
  }

  serve(signal: AbortSignal): Promise<void> {
    const serving = this.#serve(signal)
    this.#serving ??= serving
    return serving
  }

  /** Called after service stop has aborted serving; persistence has its own bounded RPC drain. */
  async closeMemory(): Promise<void> {
    if (this.#blackboard === undefined) return
    this.#memoryClosed = true
    this.#memoryOpened = false
    try { await this.#serving; await this.#memoryReady }
    finally { await this.#blackboard.close() }
  }

  async #serve(signal: AbortSignal): Promise<void> {
    if (this.#state !== 'new') throw new Error('causal runtime can only be served once')
    this.#state = 'serving'
    const onAbort = (): void => this.#notifyWork()
    signal.addEventListener('abort', onAbort, {once: true})
    let sinceYield = 0
    try {
      await this.openMemory()
      if (this.#blackboard !== undefined) {
        this.#maintenance = setInterval(() => {
          void this.flushMemory(true).catch(() => { /* flush wakes the serving failure path */ })
        }, 60_000)
        this.#maintenance.unref()
      }
      while (!signal.aborted) {
        // A microtask yield lets owned task completions re-enter the queue, but it
        // never returns control to the macrotask queue. An event queue that stays
        // ready would therefore starve socket reads and timers for as long as it
        // keeps producing work, so punctuate a long drain with a real event-loop
        // turn.
        if (sinceYield >= DRAIN_YIELD_INTERVAL) {
          sinceYield = 0
          await yieldToEventLoop()
        } else {
          await Promise.resolve()
        }
        if (this.#failure !== undefined) throw this.#failure
        if (this.#clearing !== undefined) { await this.#clearing; continue }
        const event = this.core.queue.popReady(this.#clock.now())
        if (event !== undefined) {
          sinceYield += 1
          this.#applying = this.#applyEvent(event)
          try { await this.#applying } finally { this.#applying = undefined }
          continue
        }
        sinceYield = 0
        await this.#waitForWork(signal)
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      clearInterval(this.#maintenance)
      this.#state = 'closed'
      this.#acceptCompletions = false
      const stopped = new Error('causal runtime stopped before input was applied')
      for (const pending of this.#pendingUserInputs.values()) pending.reject(this.#failure ?? stopped)
      this.#pendingUserInputs.clear()
      await this.#shutdownTasks()
      this.#hostExecutorCapabilities.clear()
      this.#userTurns.clear()
      this.#launchChecks.clear()
      await this.#blackboard?.close()
    }
    if (this.#failure !== undefined) throw this.#failure
  }

  get ownedTaskCount(): number {
    return this.#tasks.size
  }

  async #applyEvent(event: EventRecord): Promise<void> {
    this.core.apply(event)
    const userItem = event.kind === 'user_input'
      ? this.memory.channels.get(CONVERSATION_CHANNEL)?.items.at(-1) : undefined
    if (this.#blackboard !== undefined) await this.flushMemory()
    const current = this.core.isCurrentConversationEvent(event)
    if (!current) {
      if (event.kind === 'handoff' || event.kind === 'deadline') {
        const control = event.kind === 'handoff'
          ? {...event, payload: {...event.payload, content: {}, refs: []}} : event
        for (const observer of this.#observers) observer(structuredClone(control), false)
      }
      return
    }
    this.#finishIngress(event, userItem)
    for (const observer of this.#observers) observer(structuredClone(event), true)
  }

  #finishIngress(event: EventRecord, item: MemoryItem | undefined): void {
    if (event.kind !== 'user_input') return
    const pending = this.#pendingUserInputs.get(event.seq)
    if (pending === undefined) return
    this.#pendingUserInputs.delete(event.seq)
    if (item === undefined || this.memory.channels.get(CONVERSATION_CHANNEL)?.getBySeq(item.seq) === undefined) {
      pending.reject(new Error('applied user input did not create Memory'))
      return
    }
    pending.resolve(`${item.channel}:${item.seq}`)
  }

  #startModelCall(call: ModelCall): void {
    const epoch = this.core.conversationEpoch
    const port = this.#models[call.slot]
    if (port === undefined) throw new Error(`model slot is not connected: ${call.slot}`)
    this.#ownTask(
      signal => {
        const prepared = this.#blackboard === undefined ? call : this.core.refreshModelCall(call)
        if (prepared.compression_items?.length === 0) return Promise.resolve({channel: prepared.channel, summary: ''})
        return port.complete(structuredClone(prepared), signal)
      },
      output => { if (epoch === this.core.conversationEpoch) this.core.completeModelCall(call.job_id, output, this.#clock.now()) },
      () => { if (epoch === this.core.conversationEpoch) this.core.completeModelCall(call.job_id, {port_failure: true}, this.#clock.now()) },
    )
  }

  #startExecutorDispatch(dispatchIndex: number, delegate: Delegate): void {
    const epoch = this.core.conversationEpoch
    const adapter = this.#executors.get(delegate.executor)
    if (adapter === undefined) throw new Error(`executor adapter is not connected: ${delegate.executor}`)
    if (this.#blackboard !== undefined) {
      this.memory.append(delegate.executor, {
        ts: this.#clock.now(), trust: 'trusted_system', priority: adapter.manifest.policy.priority,
        content: {kind: 'task_admitted', delegate_id: delegate.delegate_id, executor: delegate.executor, op: delegate.op},
        refs: [delegate.origin_ref],
      })
    }
    this.#ownTask(
      signal => {
        const userTurn = this.#userTurns.get(delegate.delegate_id)
        this.#userTurns.delete(delegate.delegate_id)
        const wanted = this.#launchChecks.get(delegate.delegate_id) ?? userTurn?.stillWanted
        this.#launchChecks.delete(delegate.delegate_id)
        let live = true
        try { live = wanted?.() ?? true } catch { live = false }
        live &&= epoch === this.core.conversationEpoch && this.#clearing === undefined && this.#acceptCompletions
        if (!live) {
          this.#hostExecutorCapabilities.delete(delegate.delegate_id)
          return Promise.resolve({outcome: 'refused', trust: 'trusted_system', content: {error: 'superseded'}, refs: []})
        }
        const context: ExecutorDispatchContext = {
        ...(userTurn === undefined ? {} : {userTurn}),
        clock: this.#clock,
        delegate: structuredClone(delegate),
        signal,
        progress: payload => this.#postDecoration(() => {
          this.core.postExecutorProgress(dispatchIndex, payload, this.#clock.now())
        }),
        observe: payload => this.#postDecoration(() => {
          this.core.postExecutorObservation(dispatchIndex, payload, this.#clock.now())
        }),
        }
        const capability = this.#hostExecutorCapabilities.get(delegate.delegate_id)
        this.#hostExecutorCapabilities.delete(delegate.delegate_id)
        if (capability !== undefined) bindHostExecutorCapability(context, capability)
        return adapter.dispatch(delegate.op, structuredClone(delegate.request), context)
      },
      output => this.core.postExecutorResult(dispatchIndex, output, this.#clock.now()),
      () => this.core.postExecutorCompletion(dispatchIndex, {
        outcome: 'unknown',
        trust: 'trusted_system',
        content: {
          error: 'adapter_raised',
          exception: 'ExecutorFailure',
          detail: 'dispatch_failed',
        },
        refs: [],
      }, this.#clock.now()),
      true,
    )
  }

  #postDecoration(post: () => void): void {
    if (!this.#acceptCompletions) return
    try {
      post()
      this.#notifyWork()
    } catch {
      // Progress and live observations are decorative and cannot break the terminal handoff.
    }
  }

  #ownTask(
    run: (signal: AbortSignal) => Promise<unknown>,
    complete: (output: unknown) => void,
    fail: () => void,
    publishAdmission = false,
  ): void {
    if (!this.#acceptCompletions) return
    const controller = new AbortController()
    const owned: OwnedTask = {controller, kind: publishAdmission ? 'executor' : 'model', promise: Promise.resolve()}
    let started = false
    owned.promise = Promise.resolve()
      .then(async () => {
        if (this.#blackboard !== undefined) {
          await this.flushMemory()
        }
        // This boundary also applies without persistence: admission itself is now asynchronous.
        if (publishAdmission) await yieldToEventLoop()
        if (!this.#acceptCompletions || controller.signal.aborted) return undefined
        started = true
        return run(controller.signal)
      })
      .then(
        output => {
          if (started && this.#acceptCompletions && !controller.signal.aborted) complete(output)
        },
        () => {
          if (started && this.#acceptCompletions && !controller.signal.aborted) fail()
        },
      )
      .catch(error => {
        if (this.#failure === undefined) this.#failure = runtimeError(error)
      })
      .finally(() => {
        this.#tasks.delete(owned)
        this.#notifyWork()
      })
    this.#tasks.add(owned)
  }

  async #waitForWork(signal: AbortSignal): Promise<void> {
    const version = this.#workVersion
    const timer = new AbortController()
    let release: (() => void) | undefined
    const work = new Promise<void>(resolve => {
      release = resolve
      this.#workWaiter = resolve
      if (this.#workVersion !== version || signal.aborted) resolve()
    })
    const next = this.core.queue.nextTimestamp()
    const deadline = next === undefined
      ? new Promise<void>(() => undefined)
      : this.#clock.sleep(Math.max(0, next - this.#clock.now()), timer.signal)
        .catch(error => {
          if (!timer.signal.aborted) throw error
        })
    try {
      await Promise.race([work, deadline])
    } finally {
      timer.abort()
      if (this.#workWaiter === release) this.#workWaiter = undefined
    }
  }

  #notifyWork(): void {
    this.#workVersion += 1
    this.#workWaiter?.()
  }

  async #shutdownTasks(): Promise<void> {
    const tasks = [...this.#tasks]
    for (const task of tasks) task.controller.abort()
    if (tasks.length === 0) return
    const timer = new AbortController()
    try {
      await Promise.race([
        Promise.allSettled(tasks.map(task => task.promise)),
        this.#clock.sleep(this.#shutdownGrace, timer.signal).catch(error => {
          if (!timer.signal.aborted) throw error
        }),
      ])
    } finally {
      timer.abort()
    }
  }
}

function runtimeError(value: unknown): Error {
  return value instanceof Error ? value : new Error('causal runtime task failed', {cause: value})
}
