import type {
  CodexAppServerTransport,
  SafePreflightReport,
  SteerTransportResult,
} from '../codex-app-server-transport.js'
import {
  CODEX_LIVE_MANIFEST,
  sanitizeCodexPreflightReport,
  validateCodexRequest,
  type CodexStatusSnapshot,
} from '../codex-contract.js'
import {snapshotJsonRecord} from '../codex-safe-json.js'
import type {
  ExecutorAdapter,
  ExecutorDispatchContext,
  ExecutorHandoff,
} from '../causal-runtime.js'
import type {JsonValue} from '../events.js'
import {
  AdapterDeadlineError,
  CodexAdapterClosedError,
  CodexAdapterCore,
  awaitOperation,
  createOperationDeadline,
  failureHandoff,
  lifecycleClock,
  readWrittenBoundary,
  type CodexAdapterScheduler,
} from './codex-common.js'

const PREWARM_DEADLINE_SECONDS = 20
const STEER_DEADLINE_SECONDS = 30

export class CodexLiveAdapter implements ExecutorAdapter {
  readonly manifest = CODEX_LIVE_MANIFEST
  readonly #core: CodexAdapterCore
  readonly #scheduler: CodexAdapterScheduler | undefined
  #prewarmTask: Promise<void> | null = null
  #prewarmController: AbortController | null = null
  #prewarmReport: Readonly<Record<string, unknown>> | null = null
  #activeTurn = false
  #closed = false
  #runController: AbortController | null = null
  #runTask: Promise<ExecutorHandoff> | null = null
  readonly #steerControllers = new Set<AbortController>()
  readonly #steerTasks = new Set<Promise<ExecutorHandoff>>()
  #closePromise: Promise<void> | null = null

  constructor(transport: CodexAppServerTransport, scheduler?: CodexAdapterScheduler) {
    this.#scheduler = scheduler
    this.#core = new CodexAdapterCore(transport, {
      live: true,
      ...(scheduler === undefined ? {} : {scheduler}),
    })
  }

  get status(): CodexStatusSnapshot { return this.#core.status }

  prewarm(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    if (this.#prewarmTask !== null) return this.#prewarmTask
    const controller = new AbortController()
    this.#prewarmController = controller
    this.#core.setPrewarm('warming')
    const work = this.#prewarm(controller.signal)
    const exposed = work.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.#prewarmTask === exposed) this.#prewarmTask = null
      if (this.#prewarmController === controller) this.#prewarmController = null
    })
    this.#prewarmTask = exposed
    return exposed
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    this.#closed = true
    const work = this.#close()
    this.#closePromise = work
    return work
  }

  async dispatch(
    op: string,
    request: Readonly<Record<string, JsonValue>>,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    const admitted = validateCodexRequest('live', op, request)
    if (!admitted.ok) return failureHandoff(admitted.error, admitted.op)
    if (op === 'status') return this.#core.statusHandoff(context.clock.now())
    if (this.#closed) return failureHandoff('closed', op)
    if (op === 'steer') {
      const instruction = admitted.value.instruction
      if (typeof instruction !== 'string') return failureHandoff('invalid_params', op)
      return await this.#dispatchSteer(instruction, context)
    }
    const workOrder = admitted.value.work_order
    if (typeof workOrder !== 'string') return failureHandoff('invalid_params', op)
    if (this.#core.runActive) return failureHandoff('busy', 'run')
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort() }
    if (context.signal.aborted) controller.abort()
    else context.signal.addEventListener('abort', onAbort, {once: true})
    this.#runController = controller
    const runContext: ExecutorDispatchContext = {...context, signal: controller.signal}
    const work = this.#run(workOrder, runContext)
    this.#runTask = work
    try {
      return await work
    } finally {
      context.signal.removeEventListener('abort', onAbort)
      if (this.#runController === controller) this.#runController = null
      if (this.#runTask === work) this.#runTask = null
    }
  }

  async #run(workOrder: string, context: ExecutorDispatchContext): Promise<ExecutorHandoff> {
    let consumedWarmState = false
    try {
      return await this.#core.run(workOrder, context, {
        prepare: async () => {
          const warming = this.#prewarmTask
          if (warming !== null) await warming
          if (this.#closed) throw new CodexAdapterClosedError()
          consumedWarmState = true
          const ready = this.#core.status.prewarm === 'ready' ? this.#prewarmReport : null
          this.#prewarmReport = null
          return ready ?? undefined
        },
        onTurnBound: () => { this.#activeTurn = true },
      })
    } finally {
      this.#activeTurn = false
      if (consumedWarmState) {
        this.#prewarmReport = null
        this.#core.setPrewarm('cold')
      }
    }
  }

  async #prewarm(signal: AbortSignal): Promise<void> {
    const clock = lifecycleClock(this.#scheduler)
    const deadline = createOperationDeadline(
      clock,
      PREWARM_DEADLINE_SECONDS,
      signal,
      this.#scheduler,
    )
    try {
      const report = await awaitOperation(
        () => this.#core.transport.prewarm(deadline.transport),
        deadline,
      )
      const admitted = report === null ? null : completePreflight(report)
      if (admitted === null) {
        this.#prewarmReport = null
        this.#core.setPrewarm('failed')
        return
      }
      this.#prewarmReport = admitted
      this.#core.setPrewarm('ready')
    } catch {
      this.#prewarmReport = null
      this.#core.setPrewarm('failed')
    } finally {
      deadline.detach()
    }
  }

  async #close(): Promise<void> {
    this.#runController?.abort()
    this.#prewarmController?.abort()
    for (const controller of this.#steerControllers) controller.abort()
    const warming = this.#prewarmTask
    const steering = [...this.#steerTasks]
    const closingTransport = this.#core.transport.close('shutdown')
    void closingTransport.catch(() => undefined)
    if (warming !== null) await warming
    this.#prewarmTask = null
    this.#prewarmController = null
    this.#prewarmReport = null
    this.#activeTurn = false
    try {
      const running = this.#runTask
      if (running !== null) await running.catch(() => undefined)
      await Promise.all(steering.map(task => task.catch(() => undefined)))
      await closingTransport
    } finally {
      this.#core.setPrewarm('cold')
    }
  }

  async #dispatchSteer(
    instruction: string,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort() }
    if (context.signal.aborted) controller.abort()
    else context.signal.addEventListener('abort', onAbort, {once: true})
    this.#steerControllers.add(controller)
    const work = this.#steer(instruction, {...context, signal: controller.signal})
    this.#steerTasks.add(work)
    try {
      const result = await work
      if (this.#closed && !context.signal.aborted) return failureHandoff('closed', 'steer')
      return result
    } catch (error) {
      if (this.#closed && !context.signal.aborted) return failureHandoff('closed', 'steer')
      throw error
    } finally {
      context.signal.removeEventListener('abort', onAbort)
      this.#steerControllers.delete(controller)
      this.#steerTasks.delete(work)
    }
  }

  async #steer(instruction: string, context: ExecutorDispatchContext): Promise<ExecutorHandoff> {
    if (!this.#activeTurn) return steerHandoff('failed', 'no_active_turn')
    const deadline = createOperationDeadline(
      context.clock,
      STEER_DEADLINE_SECONDS,
      context.signal,
      this.#scheduler,
    )
    try {
      let raw: SteerTransportResult
      try {
        raw = await awaitOperation(
          () => this.#core.transport.steer({instruction}, deadline.transport),
          deadline,
        )
      } catch (error) {
        if (context.signal.aborted) throw abortError()
        const written = error instanceof AdapterDeadlineError
          && readWrittenBoundary(error.lateValue, 'written') === true
        return steerHandoff(written ? 'unknown' : 'failed', 'transport_lost')
      }
      if (context.signal.aborted) throw abortError()
      const result = validateSteerResult(raw)
      if (result === null) {
        const written = readWrittenBoundary(raw, 'written') === true
        return steerHandoff(written ? 'unknown' : 'failed', 'transport_lost')
      }
      if (result.code === 'accepted') return steerHandoff('ok', 'accepted')
      if (result.code === 'transport_lost') {
        return steerHandoff(result.written ? 'unknown' : 'failed', 'transport_lost')
      }
      return steerHandoff('failed', result.code)
    } finally {
      deadline.detach()
    }
  }
}

function completePreflight(value: SafePreflightReport): Readonly<Record<string, unknown>> | null {
  const admitted = sanitizeCodexPreflightReport(value)
  if (
    admitted === null
    || typeof admitted.version !== 'string'
    || admitted.root_matches !== true
    || admitted.mount !== 'workspace_only'
    || admitted.subprocess !== 'contained'
    || admitted.network !== 'blocked'
  ) return null
  return admitted
}

function validateSteerResult(value: unknown): SteerTransportResult | null {
  try {
    const snapshot = snapshotJsonRecord(value)
    const keys = Object.keys(snapshot)
    if (keys.length !== 2 || !Object.hasOwn(snapshot, 'code') || !Object.hasOwn(snapshot, 'written')) {
      return null
    }
    if (
      snapshot.code !== 'accepted'
      && snapshot.code !== 'no_active_turn'
      && snapshot.code !== 'stale_turn'
      && snapshot.code !== 'server_rejected'
      && snapshot.code !== 'transport_lost'
    ) return null
    if (typeof snapshot.written !== 'boolean') return null
    if (
      (snapshot.code === 'accepted' && !snapshot.written)
      || (snapshot.code === 'no_active_turn' && snapshot.written)
      || (snapshot.code === 'stale_turn' && snapshot.written)
      || (snapshot.code === 'server_rejected' && !snapshot.written)
      || (snapshot.code === 'transport_lost' && !snapshot.written)
    ) return null
    return Object.freeze({code: snapshot.code, written: snapshot.written})
  } catch {
    return null
  }
}

function steerHandoff(
  outcome: ExecutorHandoff['outcome'],
  code: 'accepted' | 'no_active_turn' | 'stale_turn' | 'server_rejected' | 'transport_lost',
): ExecutorHandoff {
  return {
    outcome,
    trust: 'trusted_system',
    content: {op: 'steer', worker: 'codex', code},
  }
}

function abortError(): Error {
  const error = new Error('Codex steer cancelled')
  error.name = 'AbortError'
  return error
}
