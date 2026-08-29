import type { Clock } from './clock.js'
import type { EventInput, EventRecord, JsonValue } from './events.js'
import type { IdFactory } from './ids.js'
import { CONVERSATION_CHANNEL, type Memory } from './memory.js'
import {bindHostExecutorCapability} from './host-executor-capability.js'
import type {
  Delegate,
  DelegateRequest,
  ExecutorManifest,
  UpdateSpec,
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
  readonly outcome: 'ok' | 'refused' | 'unknown' | 'failed'
  readonly trust: 'trusted_user' | 'trusted_system' | 'untrusted_external'
  readonly content: Readonly<Record<string, JsonValue>>
  readonly refs?: readonly string[]
}

export interface ExecutorDispatchContext {
  readonly clock: Clock
  readonly delegate: Delegate
  readonly signal: AbortSignal
  readonly progress: (payload: ExecutorProgress) => void
  readonly observe?: (payload: ExecutorObservation) => void
}

export interface ExecutorAdapter {
  readonly manifest: ExecutorManifest
  dispatch(
    op: string,
    request: Readonly<Record<string, JsonValue>>,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff>
}

export interface CausalRuntimeOptions {
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
  promise: Promise<void>
}

interface PendingUserInput {
  readonly resolve: (reference: string) => void
  readonly reject: (reason: Error) => void
}

export type RuntimeObserver = (event: EventRecord) => void

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
  readonly #shutdownGrace: number
  #state: 'new' | 'serving' | 'closed' = 'new'
  #acceptCompletions = true
  #failure: Error | undefined
  #workVersion = 0
  #workWaiter: (() => void) | undefined

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
  }

  post(input: EventInput, at = this.#clock.now()): EventRecord {
    if (this.#state === 'closed') throw new Error('causal runtime is closed')
    const event = this.core.post(input, at)
    this.#notifyWork()
    return structuredClone(event)
  }

  ingestUserInput(input: {readonly text: string; readonly media_refs?: readonly string[]}): Promise<string> {
    if (this.#state === 'closed') return Promise.reject(new Error('causal runtime is closed'))
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

  /**
   * Admit one already-normalized external proposal without awaiting its worker.
   *
   * Reaches the reducer directly rather than through an event, which is what lets a caller learn the
   * delegate id synchronously -- an accepted proposal has to be correlated with the work it started
   * before the next turn, and an event round trip would not have produced the id yet.
   */
  dispatchExternal(
    request: DelegateRequest,
    reason: WakeReason,
  ): RuntimeDispatchResult {
    if (this.#state === 'closed') return {accepted: false, delegate_id: null, problem: 'closed'}
    const admission = this.core.dispatchExternal(request, reason)
    if (admission.accepted) {
      this.#notifyWork()
    }
    return admission
  }

  /** Admit and privately carry the exact one-shot confirmed project capability. */
  dispatchConfirmedExternal(
    request: DelegateRequest,
    reason: WakeReason,
    capability: object,
  ): RuntimeDispatchResult {
    if (this.#state === 'closed') return {accepted: false, delegate_id: null, problem: 'closed'}
    const admission = this.core.dispatchConfirmedExternal(
      request,
      reason,
      capability,
    )
    if (admission.accepted) {
      if (admission.delegate_id !== null) {
        this.#hostExecutorCapabilities.set(admission.delegate_id, capability)
      }
      this.#notifyWork()
    }
    return admission
  }

  /** Route an external update through the reducer's sole structured-state writer. */
  updateExternal(spec: UpdateSpec, reason: WakeReason): boolean {
    if (this.#state === 'closed') return false
    const accepted = this.core.updateExternal(spec, reason)
    this.#notifyWork()
    return accepted
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

  async serve(signal: AbortSignal): Promise<void> {
    if (this.#state !== 'new') throw new Error('causal runtime can only be served once')
    this.#state = 'serving'
    const onAbort = (): void => this.#notifyWork()
    signal.addEventListener('abort', onAbort, {once: true})
    let sinceYield = 0
    try {
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
        const event = this.core.queue.popReady(this.#clock.now())
        if (event !== undefined) {
          sinceYield += 1
          this.core.apply(event)
          this.#finishIngress(event)
          for (const observer of this.#observers) observer(structuredClone(event))
          continue
        }
        sinceYield = 0
        await this.#waitForWork(signal)
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.#state = 'closed'
      this.#acceptCompletions = false
      const stopped = new Error('causal runtime stopped before input was applied')
      for (const pending of this.#pendingUserInputs.values()) pending.reject(stopped)
      this.#pendingUserInputs.clear()
      await this.#shutdownTasks()
      this.#hostExecutorCapabilities.clear()
    }
    if (this.#failure !== undefined) throw this.#failure
  }

  get ownedTaskCount(): number {
    return this.#tasks.size
  }

  #finishIngress(event: EventRecord): void {
    if (event.kind !== 'user_input') return
    const pending = this.#pendingUserInputs.get(event.seq)
    if (pending === undefined) return
    this.#pendingUserInputs.delete(event.seq)
    const item = this.core.memory.channels.get(CONVERSATION_CHANNEL)?.items.at(-1)
    if (item === undefined) {
      pending.reject(new Error('applied user input did not create Memory'))
      return
    }
    pending.resolve(`${item.channel}:${item.seq}`)
  }

  #startModelCall(call: ModelCall): void {
    const port = this.#models[call.slot]
    if (port === undefined) throw new Error(`model slot is not connected: ${call.slot}`)
    this.#ownTask(
      signal => port.complete(structuredClone(call), signal),
      output => this.core.completeModelCall(call.job_id, output, this.#clock.now()),
      () => this.core.completeModelCall(call.job_id, {port_failure: true}, this.#clock.now()),
    )
  }

  #startExecutorDispatch(dispatchIndex: number, delegate: Delegate): void {
    const adapter = this.#executors.get(delegate.executor)
    if (adapter === undefined) throw new Error(`executor adapter is not connected: ${delegate.executor}`)
    this.#ownTask(
      signal => {
        const context: ExecutorDispatchContext = {
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
  ): void {
    if (!this.#acceptCompletions) return
    const controller = new AbortController()
    const owned: OwnedTask = {controller, promise: Promise.resolve()}
    owned.promise = Promise.resolve()
      .then(async () => run(controller.signal))
      .then(
        output => {
          if (this.#acceptCompletions) complete(output)
        },
        () => {
          if (this.#acceptCompletions && !controller.signal.aborted) fail()
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
