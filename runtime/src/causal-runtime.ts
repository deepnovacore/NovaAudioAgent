import type { Clock } from './clock.js'
import type { EventInput, EventRecord, JsonValue } from './events.js'
import type { IdFactory } from './ids.js'
import { CONVERSATION_CHANNEL } from './memory.js'
import type { Delegate, ExecutorManifest } from './ports.js'
import { CoreRuntime, type ModelCall } from './runtime.js'
import { SLOTS, type Slot } from './slots.js'

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

export interface ExecutorDispatchContext {
  readonly clock: Clock
  readonly delegate: Delegate
  readonly signal: AbortSignal
  readonly progress: (payload: ExecutorProgress) => void
  readonly observe: (payload: ExecutorObservation) => void
}

export interface ExecutorAdapter {
  readonly manifest: ExecutorManifest
  dispatch(
    op: string,
    request: Readonly<Record<string, JsonValue>>,
    context: ExecutorDispatchContext,
  ): Promise<unknown>
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

export class CausalRuntime {
  readonly core: CoreRuntime
  readonly #clock: Clock
  readonly #models: Readonly<Partial<Record<Slot, ModelPort>>>
  readonly #executors = new Map<string, ExecutorAdapter>()
  readonly #tasks = new Set<OwnedTask>()
  readonly #observers = new Set<RuntimeObserver>()
  readonly #pendingUserInputs = new Map<number, PendingUserInput>()
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

  observe(observer: RuntimeObserver): () => void {
    this.#observers.add(observer)
    return () => this.#observers.delete(observer)
  }

  async serve(signal: AbortSignal): Promise<void> {
    if (this.#state !== 'new') throw new Error('causal runtime can only be served once')
    this.#state = 'serving'
    const onAbort = (): void => this.#notifyWork()
    signal.addEventListener('abort', onAbort, {once: true})
    try {
      while (!signal.aborted) {
        await Promise.resolve()
        if (this.#failure !== undefined) throw this.#failure
        const event = this.core.queue.popReady(this.#clock.now())
        if (event !== undefined) {
          this.core.apply(event)
          this.#finishIngress(event)
          for (const observer of this.#observers) observer(structuredClone(event))
          continue
        }
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
      signal => adapter.dispatch(delegate.op, structuredClone(delegate.request), {
        clock: this.#clock,
        delegate: structuredClone(delegate),
        signal,
        progress: payload => this.#postDecoration(() => {
          this.core.postExecutorProgress(dispatchIndex, payload, this.#clock.now())
        }),
        observe: payload => this.#postDecoration(() => {
          this.core.postExecutorObservation(dispatchIndex, payload, this.#clock.now())
        }),
      }),
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
