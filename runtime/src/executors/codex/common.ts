import {executorDiagnosticSchema, type ExecutorDiagnostic} from '../../core/executor-diagnostic.js'
import {createHash} from 'node:crypto'

import type {
  CodexAppServerTransport,
  CodexTransportCode,
  TransportDeadline,
  TransportOutcome,
} from './app-server-transport.js'
import {CodexTransportError} from './app-server-transport.js'
import {
  CODEX_STARTUP_DEADLINE,
  MAX_CODEX_EVIDENCE_COUNTER,
  PUBLIC_PREFLIGHT_CODES,
  createCodexRunEnvelope,
  projectCodexStatus,
  sanitizeCodexEvidence,
  sanitizeCodexPreflightReport,
  type CodexStatusSnapshot,
} from './contract.js'
import {snapshotJsonRecord} from './safe-json.js'
import type {
  ExecutorActivity,
  ExecutorDispatchContext,
  ExecutorHandoff,
  ExecutorProgress,
} from '../../core/causal-runtime.js'
import type {Clock} from '../../core/clock.js'
import {RealClock, raceDeadline} from '../../core/clock.js'
import {jsonValueSchema, validProgressSummary, type JsonValue} from '../../core/events.js'

const TRANSPORT_CODES: ReadonlySet<string> = new Set<CodexTransportCode>([
  'completed',
  'config_not_isolated',
  'mcp_tools_not_isolated',
  'adapter_timeout',
  'binary_missing',
  'credential_missing',
  'preflight_failed',
  'preflight_timeout',
  'sandbox_failed',
  'spawn_failed',
  'stderr_too_large',
  'transport_lost',
  'unsupported_protocol',
  'unsupported_version',
  'workspace_invalid',
  'workspace_root_mismatch',
  'resume_unavailable',
  'server_rejected',
  'turn_failed',
  'usage_limit_exceeded',
  'missing_terminal',
  'nonzero_exit',
  'unexpected_server_request',
  'busy',
])
const PREFLIGHT_CODES: ReadonlySet<string> = new Set(PUBLIC_PREFLIGHT_CODES)
const REFUSED_CODES: ReadonlySet<string> = new Set([
  'config_not_isolated',
  'mcp_tools_not_isolated',
  'adapter_timeout',
  'binary_missing',
  'busy',
  'credential_missing',
  'preflight_failed',
  'preflight_timeout',
  'resume_unavailable',
  'sandbox_failed',
  'server_rejected',
  'spawn_failed',
  'stderr_too_large',
  'transport_lost',
  'unexpected_server_request',
  'unsupported_protocol',
  'unsupported_version',
  'workspace_invalid',
  'workspace_root_mismatch',
])
const UNCERTAIN_CODES: ReadonlySet<string> = new Set([
  'adapter_timeout',
  'credential_missing',
  'missing_terminal',
  'nonzero_exit',
  'server_rejected',
  'stderr_too_large',
  'transport_lost',
  'turn_failed',
  'usage_limit_exceeded',
  'unsupported_protocol',
  'unexpected_server_request',
])
const ADAPTER_CLEANUP_GRACE_SECONDS = 6

export interface CodexAdapterScheduler {
  readonly wallNowMilliseconds: () => number
  readonly lifecycleClock?: Clock
}

export type CodexFailureStage = 'preflight' | 'credential' | 'spawn' | 'thread_start' | 'execution'

const DEFAULT_LIFECYCLE_CLOCK = new RealClock()
const DEFAULT_SCHEDULER: CodexAdapterScheduler = {
  wallNowMilliseconds: () => Date.now(),
  lifecycleClock: DEFAULT_LIFECYCLE_CLOCK,
}

interface RunDeadline {
  readonly clock: Clock
  readonly expiresAt: number
  readonly transport: TransportDeadline
  readonly controller: AbortController
  readonly detach: () => void
}

interface ValidatedOutcome {
  readonly process?: TransportOutcome['process']
  readonly diagnostic?: ExecutorDiagnostic
  readonly classification: 'completed' | 'refused' | 'uncertain'
  readonly code: CodexTransportCode
  readonly turnStartWritten: boolean
  readonly completion: Readonly<{
    status: 'completed' | 'failed'
    final_text: string | null
    internal_activity: number
  }> | null
}

/** Host-internal lifecycle state shared by sequential Codex adapter facades. */
export interface CodexAdapterSharedState {
  status: CodexStatusSnapshot
}

export interface ValidatedCodexDisposition {
  readonly classification: ValidatedOutcome['classification']
  readonly code: CodexTransportCode
  readonly turnStartWritten: boolean
}

export function createCodexAdapterSharedState(): CodexAdapterSharedState {
  return {status: initialSnapshot()}
}

export class CodexAdapterCore {
  readonly #transport: CodexAppServerTransport
  readonly #scheduler: CodexAdapterScheduler
  readonly #sharedState: CodexAdapterSharedState
  #runActive = false
  #runToken: object | null = null
  #latestProgress: ExecutorProgress | null = null

  constructor(
    transport: CodexAppServerTransport,
    options: {
      readonly scheduler?: CodexAdapterScheduler
      readonly sharedState?: CodexAdapterSharedState
    },
  ) {
    this.#transport = transport
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER
    this.#sharedState = options.sharedState ?? createCodexAdapterSharedState()
  }

  get #status(): CodexStatusSnapshot { return this.#sharedState.status }
  set #status(value: CodexStatusSnapshot) { this.#sharedState.status = value }
  get status(): CodexStatusSnapshot { return this.#sharedState.status }
  get runActive(): boolean { return this.#runActive }
  get transport(): CodexAppServerTransport { return this.#transport }

  setPrewarm(value: CodexStatusSnapshot['prewarm']): void {
    this.#status = freezeStatus({...this.#status, prewarm: value})
  }

  statusHandoff(now: number): ExecutorHandoff {
    return {
      outcome: 'ok',
      trust: 'trusted_system',
      content: requireJsonRecord(projectCodexStatus(this.#status, now, {
        live: true,
        progress: this.#latestProgress,
      })),
    }
  }

  async run(
    workOrder: string,
    context: ExecutorDispatchContext,
    options: {
      readonly preflight?: Readonly<Record<string, unknown>>
      readonly prepare?: (
        signal: AbortSignal,
      ) => Promise<Readonly<Record<string, unknown>> | undefined>
      readonly onTurnBound?: () => void
      readonly onValidatedOutcome?: (outcome: ValidatedCodexDisposition) => void
    } = {},
  ): Promise<ExecutorHandoff> {
    if (this.#runActive) return failureHandoff('busy', 'run')
    this.#runActive = true
    const runToken = Object.freeze({})
    this.#runToken = runToken
    const startedAt = context.clock.now()
    const deadline = createRunDeadline(
      context.clock,
      CODEX_STARTUP_DEADLINE,
      context.signal,
      this.#scheduler,
    )
    const sequence = this.#status.run_sequence + 1
    let preflight: Readonly<Record<string, unknown>> = {}
    let preflightPassed = false
    let processStarted = false
    let sideEffectSeen = false
    let turnBound = false
    let observerOpen = true
    this.#latestProgress = null
    this.#status = freezeStatus({
      ...initialSnapshot(),
      state: 'running',
      run_sequence: sequence,
      started_at: startedAt,
      elapsed: 0,
      prewarm: this.#status.prewarm,
    })

    const observer = {
      onActivity:(event:ExecutorActivity):void=>{if(observerOpen&&this.#runToken===runToken)context.activity?.(event)},
      onThreadReady: (): void => {
        if (!observerOpen || this.#runToken !== runToken) return
        processStarted = true
        this.#status = freezeStatus({
          ...this.#status,
          state: 'running',
          process_running: true,
          process_exited: false,
        })
      },
      onProgress: (value: ExecutorProgress): void => {
        if (!observerOpen || this.#runToken !== runToken) return
        const progress = sanitizeProgress(value)
        if (progress === null) return
        this.#latestProgress = progress
        try { context.progress(progress) } catch { /* advisory progress never owns the worker */ }
      },
      onTurnStartWritten: (): void => {
        if (!observerOpen || this.#runToken !== runToken || sideEffectSeen) return
        sideEffectSeen = true
      },
      onTurnBound: (): void => {
        if (!observerOpen || this.#runToken !== runToken) return
        sideEffectSeen = true
        turnBound = true
        context.instructionAccepted?.()
        try { options.onTurnBound?.() } catch { /* advisory state never owns the worker */ }
      },
    }

    try {
      try {
        let prepared = options.preflight
        if (options.prepare !== undefined) {
          const prepare = options.prepare
          prepared = await awaitCodexPhase(() => prepare(deadline.controller.signal), deadline)
        }
        if (prepared === undefined) {
          preflight = requirePreflight(await awaitCodexPhase(
            () => this.#transport.preflight(deadline.transport),
            deadline,
          ))
        } else {
          preflight = requirePreflight(prepared)
        }
        preflightPassed = true
        this.#status = freezeStatus({...this.#status, preflight: 'passed'})
      } catch (error) {
        if (context.signal.aborted) {
          this.#settle(sequence, startedAt, context.clock.now(), processStarted, false, null)
          throw abortError()
        }
        this.#settle(sequence, startedAt, context.clock.now(), processStarted, false, null)
        if (error instanceof CodexAdapterClosedError) return failureHandoff('closed', 'run')
        const code = error instanceof InvalidPreflightError
          ? 'invalid_preflight_report'
          : safePreflightExceptionCode(error, 'transport_failure')
        return createRunHandoff(
          'failed', 'trusted_system', code, preflight, failureStage(code, 'preflight'),
        )
      }

      let rawOutcome: TransportOutcome
      try {
        rawOutcome = await awaitCodexPhase(
          () => this.#transport.run({workOrder}, observer, context.beforeWrite?{...deadline.transport,beforeWrite:context.beforeWrite}:deadline.transport, null),
          deadline, false,
        )
      } catch (error) {
        if (
          (error instanceof AdapterDeadlineError || error instanceof AdapterAbortError)
          && readWrittenBoundary(error.lateValue, 'turnStartWritten') === true
        ) sideEffectSeen = true
        this.#settle(
          sequence,
          startedAt,
          context.clock.now(),
          processStarted || sideEffectSeen,
          preflightPassed,
          null,
        )
        if (context.signal.aborted) throw abortError()
        const afterStart = sideEffectSeen
        const code = safePreflightExceptionCode(
          error,
          'transport_failure',
        )
        return createRunHandoff(
          afterStart ? 'unknown' : 'failed',
          afterStart ? 'untrusted_external' : 'trusted_system',
          code,
          preflight,
          failureStage(code, turnBound ? 'execution' : 'thread_start'),
        )
      }

      let admitted = validateOutcome(rawOutcome)
      if (readWrittenBoundary(rawOutcome, 'turnStartWritten') === true) sideEffectSeen = true
      if (admitted !== null && sideEffectSeen && !admitted.turnStartWritten) admitted = null
      if (admitted !== null) {
        try {
          options.onValidatedOutcome?.(Object.freeze({
            classification: admitted.classification,
            code: admitted.code,
            turnStartWritten: admitted.turnStartWritten,
          }))
        } catch { /* host disposition observers are advisory */ }
      }
      const written = sideEffectSeen
      const evidence = admitted?.classification === 'completed'
        ? createCompletionEvidence(admitted, preflight.protocol === 'acp')
        : null
      this.#settle(
        sequence,
        startedAt,
        context.clock.now(),
        processStarted || written,
        preflightPassed,
        admitted,
        evidence !== null,
      )
      if (context.signal.aborted) throw abortError()
      if (admitted === null) {
        return createRunHandoff(
          sideEffectSeen ? 'unknown' : 'failed',
          sideEffectSeen ? 'untrusted_external' : 'trusted_system',
          'invalid_worker_result',
          preflight,
          'thread_start',
        )
      }
      if (admitted.classification === 'refused') {
        return createRunHandoff(
          'failed',
          admitted.diagnostic === undefined ? 'trusted_system' : 'untrusted_external',
          admitted.code,
          preflight,
          failureStage(admitted.code, 'thread_start'),
          undefined, admitted.diagnostic,
        )
      }
      if (admitted.classification === 'uncertain') {
        return createRunHandoff(
          'unknown', 'untrusted_external', admitted.code, preflight, turnBound ? 'execution' : 'thread_start', undefined, admitted.diagnostic,
        )
      }
      if (evidence === null || !admitted.turnStartWritten) {
        return createRunHandoff(
          admitted.turnStartWritten ? 'unknown' : 'failed',
          admitted.turnStartWritten ? 'untrusted_external' : 'trusted_system',
          'invalid_worker_result',
          preflight,
          'thread_start',
        )
      }
      return createRunHandoff(
        'ok', 'untrusted_external', 'completed', preflight, undefined, evidence,
      )
    } finally {
      observerOpen = false
      deadline.detach()
      this.#latestProgress = null
      if (this.#runToken === runToken) {
        this.#runToken = null
        this.#runActive = false
      }
    }
  }

  #settle(
    sequence: number,
    startedAt: number,
    finishedAt: number,
    processStarted: boolean,
    preflightPassed: boolean,
    outcome: ValidatedOutcome | null,
    validCompletion = false,
  ): void {
    const now = Math.max(startedAt, finishedAt)
    const completed = validCompletion
      && outcome?.classification === 'completed'
      && outcome.code === 'completed'
      && outcome.turnStartWritten
      && outcome.completion?.status === 'completed'
      && outcome.completion.final_text !== null
    // An ACP transport reports the observed root-process exit even for failed or uncertain runs.
    if (completed || outcome?.process !== undefined) {
      this.#status = freezeStatus({
        state: 'exited',
        run_sequence: sequence,
        started_at: startedAt,
        finished_at: now,
        elapsed: Math.max(0, now - startedAt),
        process_running: false,
        process_exited: true,
        terminal: completed ? 'completed' : outcome?.completion?.status ?? null,
        exit_code: outcome?.process === undefined ? 0 : outcome.process.exit_code,
        preflight: preflightPassed ? 'passed' : 'failed',
        prewarm: this.#status.prewarm,
      })
      return
    }
    if (processStarted) {
      this.#status = freezeStatus({
        ...this.#status,
        state: 'running',
        run_sequence: sequence,
        started_at: startedAt,
        finished_at: null,
        elapsed: Math.max(0, now - startedAt),
        process_running: true,
        process_exited: false,
        terminal: null,
        exit_code: null,
        preflight: preflightPassed ? 'passed' : 'failed',
      })
      return
    }
    this.#status = freezeStatus({
      state: 'idle',
      run_sequence: sequence,
      started_at: startedAt,
      finished_at: now,
      elapsed: Math.max(0, now - startedAt),
      process_running: false,
      process_exited: false,
      terminal: null,
      exit_code: null,
      preflight: preflightPassed ? 'passed' : 'failed',
      prewarm: this.#status.prewarm,
    })
  }
}

export function failureHandoff(
  error: string,
  op: string,
  stage?: CodexFailureStage,
): ExecutorHandoff {
  return {
    outcome: 'failed',
    trust: 'trusted_system',
    content: requireJsonRecord({error, op, ...(stage === undefined ? {} : {stage})}),
  }
}

export function failureStage(code: string, fallback: CodexFailureStage): CodexFailureStage {
  if (code === 'credential_missing') return 'credential'
  if (code === 'spawn_failed') return 'spawn'
  if (PREFLIGHT_CODES.has(code) || code === 'invalid_preflight_report') return 'preflight'
  return fallback
}

export function createOperationDeadline(
  clock: Clock,
  duration: number,
  signal: AbortSignal,
  scheduler: CodexAdapterScheduler = DEFAULT_SCHEDULER,
): RunDeadline {
  return createRunDeadline(clock, duration, signal, scheduler)
}

export async function awaitOperation<T>(work: () => Promise<T>, deadline: RunDeadline): Promise<T> {
  return await awaitCodexPhase(work, deadline)
}

export function lifecycleClock(scheduler?: CodexAdapterScheduler): Clock {
  return scheduler?.lifecycleClock ?? DEFAULT_LIFECYCLE_CLOCK
}

function initialSnapshot(): CodexStatusSnapshot {
  return freezeStatus({
    state: 'idle',
    run_sequence: 0,
    started_at: null,
    finished_at: null,
    elapsed: null,
    process_running: false,
    process_exited: false,
    terminal: null,
    exit_code: null,
    preflight: 'not_run',
    prewarm: 'cold',
  })
}

function freezeStatus(value: CodexStatusSnapshot): CodexStatusSnapshot {
  return Object.freeze({...value})
}

function createRunDeadline(
  clock: Clock,
  duration: number,
  parentSignal: AbortSignal,
  scheduler: CodexAdapterScheduler,
): RunDeadline {
  const startedAt = clock.now()
  const controller = new AbortController()
  const onAbort = (): void => { controller.abort() }
  if (parentSignal.aborted) controller.abort()
  else parentSignal.addEventListener('abort', onAbort, {once: true})
  const expiresAt = startedAt + duration
  return {
    clock,
    expiresAt,
    transport: Object.freeze({
      expiresAtMs: scheduler.wallNowMilliseconds() + Math.max(0, duration) * 1000,
      signal: controller.signal,
    }),
    controller,
    detach: () => { parentSignal.removeEventListener('abort', onAbort) },
  }
}

async function awaitCodexPhase<T>(start: () => Promise<T>, deadline: RunDeadline, bounded = true): Promise<T> {
  const remaining = bounded ? deadline.expiresAt - deadline.clock.now() : null
  if (deadline.controller.signal.aborted) {
    throw abortError()
  }
  if (remaining !== null && !(remaining > 0)) {
    deadline.controller.abort()
    throw new AdapterDeadlineError()
  }
  const work = Promise.resolve().then(start)
  try {
    const result = await raceDeadline(work, deadline.clock, remaining, deadline.controller.signal,
      () => new AdapterDeadlineError(), abortError)
    if (bounded && deadline.clock.now() >= deadline.expiresAt) throw new AdapterDeadlineError()
    return result
  } catch (error) {
    if (error instanceof AdapterDeadlineError || deadline.controller.signal.aborted) {
      deadline.controller.abort()
      const late = await settleAfterAbort(work, deadline.clock)
      if (error instanceof AdapterDeadlineError) {
        throw new AdapterDeadlineError(late.state === 'fulfilled' ? late.value : undefined)
      }
      throw new AdapterAbortError(late.state === 'fulfilled' ? late.value : undefined)
    }
    throw error
  }
}

type LateSettlement =
  | Readonly<{state: 'fulfilled'; value: unknown}>
  | Readonly<{state: 'rejected'}>
  | Readonly<{state: 'pending'}>

async function settleAfterAbort(work: Promise<unknown>, clock: Clock): Promise<LateSettlement> {
  const controller = new AbortController()
  const settled = work.then<LateSettlement, LateSettlement>(
    value => ({state: 'fulfilled', value}),
    () => ({state: 'rejected'}),
  )
  const grace = clock.sleep(ADAPTER_CLEANUP_GRACE_SECONDS, controller.signal)
    .then<LateSettlement>(() => ({state: 'pending'}))
  try {
    return await Promise.race([settled, grace])
  } finally {
    controller.abort()
    void grace.catch(() => undefined)
  }
}

export function readWrittenBoundary(
  value: unknown,
  field: 'turnStartWritten' | 'written',
): boolean | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    return descriptor !== undefined
      && 'value' in descriptor
      && typeof descriptor.value === 'boolean'
      ? descriptor.value
      : null
  } catch {
    return null
  }
}

function requirePreflight(value: unknown): Readonly<Record<string, unknown>> {
  const admitted = sanitizeCodexPreflightReport(value)
  if (admitted?.protocol === 'acp') return admitted
  if (
    admitted === null
    || typeof admitted.version !== 'string'
    || admitted.root_matches !== true
    || admitted.mount !== 'workspace_only'
    || admitted.subprocess !== 'contained'
    || admitted.network !== 'blocked'
  ) throw new InvalidPreflightError()
  return admitted
}

function validateOutcome(value: unknown): ValidatedOutcome | null {
  try {
    const snapshot = snapshotJsonRecord(value)
    const required = ['classification', 'code', 'turnStartWritten', 'completion']
    if (required.some(key => !Object.hasOwn(snapshot, key))
      || Object.keys(snapshot).some(key => ![...required, 'diagnostic', 'process'].includes(key))) return null
    let process: TransportOutcome['process']
    if (Object.hasOwn(snapshot, 'process')) {
      const observed = snapshotJsonRecord(snapshot.process)
      if (!sameKeys(observed, ['exit_code', 'stop'])
        || (observed.exit_code !== null && (typeof observed.exit_code !== 'number' || !Number.isSafeInteger(observed.exit_code)))
        || (observed.stop !== 'none' && observed.stop !== 'terminate' && observed.stop !== 'kill')) return null
      process = Object.freeze({exit_code: observed.exit_code, stop: observed.stop})
    }
    const parsedDiagnostic = executorDiagnosticSchema.safeParse(snapshot.diagnostic)
    const diagnostic = parsedDiagnostic.success ? parsedDiagnostic.data : undefined
    if (
      snapshot.classification !== 'completed'
      && snapshot.classification !== 'refused'
      && snapshot.classification !== 'uncertain'
    ) return null
    if (typeof snapshot.code !== 'string' || !TRANSPORT_CODES.has(snapshot.code)) return null
    if (typeof snapshot.turnStartWritten !== 'boolean') return null
    let completion: ValidatedOutcome['completion'] = null
    if (snapshot.completion !== null) {
      const candidate = snapshotJsonRecord(snapshot.completion)
      if (
        !sameKeys(candidate, ['status', 'final_text', 'internal_activity'])
        && !sameKeys(candidate, ['status', 'final_text', 'internal_activity', 'error_code'])
      ) return null
      if (candidate.status !== 'completed' && candidate.status !== 'failed') return null
      if (candidate.final_text !== null && typeof candidate.final_text !== 'string') return null
      if (
        Object.hasOwn(candidate, 'error_code')
        && candidate.error_code !== null
        && candidate.error_code !== 'usage_limit_exceeded'
      ) return null
      if (candidate.status === 'completed' && candidate.error_code !== undefined && candidate.error_code !== null) {
        return null
      }
      if (
        typeof candidate.internal_activity !== 'number'
        || !Number.isSafeInteger(candidate.internal_activity)
        || candidate.internal_activity < 0
        || candidate.internal_activity > MAX_CODEX_EVIDENCE_COUNTER
      ) return null
      completion = Object.freeze({
        status: candidate.status,
        final_text: candidate.final_text,
        internal_activity: candidate.internal_activity,
        ...(Object.hasOwn(candidate, 'error_code') ? {error_code: candidate.error_code as 'usage_limit_exceeded' | null} : {}),
      })
    }
    if (snapshot.classification === 'completed') {
      if (
        snapshot.code !== 'completed'
        || snapshot.turnStartWritten !== true
        || completion?.status !== 'completed'
        || completion.final_text === null
      ) return null
    } else if (snapshot.classification === 'refused') {
      if (
        !REFUSED_CODES.has(snapshot.code)
        || snapshot.turnStartWritten
        || completion !== null
      ) return null
    } else if (
      !snapshot.turnStartWritten
      || !UNCERTAIN_CODES.has(snapshot.code)
    ) return null
    return Object.freeze({
      ...(diagnostic === undefined ? {} : {diagnostic}),
      ...(process === undefined ? {} : {process}),
      classification: snapshot.classification,
      code: snapshot.code as CodexTransportCode,
      turnStartWritten: snapshot.turnStartWritten,
      completion,
    })
  } catch {
    return null
  }
}

function createCompletionEvidence(outcome: ValidatedOutcome, acp = false): Readonly<Record<string, unknown>> | null {
  const completion = outcome.completion
  if (
    // ACP completion is evidence only after the backend process teardown was observed.
    (acp && outcome.process === undefined)
    || outcome.classification !== 'completed'
    || outcome.code !== 'completed'
    || !outcome.turnStartWritten
    || completion?.status !== 'completed'
    || completion.final_text === null
  ) return null
  const count = completion.internal_activity
  const characters = [...completion.final_text]
  // The app-server projection already bounds final text; ACP output is bounded here.
  const text = acp ? characters.slice(0, 4000).join('') : completion.final_text
  const evidence = {
    events: [
      {type: 'thread.started'},
      {type: 'turn.started'},
      ...(count === 0 ? [] : [{type: 'internal_activity', count}]),
      {type: 'turn.completed'},
    ],
    protocol: {
      thread_started: true,
      turn_started: true,
      terminal: 'completed',
      transport_closed: true,
      unknown_event_count: 0,
    },
    process: {started: true, ...(outcome.process ?? {exit_code: 0, stop: 'none'})},
    result: {final_message: {
      text,
      original_chars: characters.length,
      truncated: characters.length > [...text].length,
      sha256: createHash('sha256').update(completion.final_text, 'utf8').digest('hex'),
    }},
  }
  return sanitizeCodexEvidence(evidence)
}

function createRunHandoff(
  outcome: ExecutorHandoff['outcome'],
  trust: ExecutorHandoff['trust'],
  code: unknown,
  preflight: Readonly<Record<string, unknown>>,
  stage?: CodexFailureStage,
  evidence?: Readonly<Record<string, unknown>>,
  diagnostic?: ExecutorDiagnostic,
): ExecutorHandoff {
  return {
    outcome,
    trust,
    content: requireJsonRecord({...createCodexRunEnvelope(code, preflight, evidence, stage),
      ...(diagnostic === undefined ? {} : {diagnostic})}),
  }
}

function sanitizeProgress(value: unknown): ExecutorProgress | null {
  try {
    const snapshot = snapshotJsonRecord(value)
    if (!sameKeys(snapshot, ['phase', 'internal_activity', 'elapsed', 'summary'])) return null
    if (snapshot.phase !== 'started' && snapshot.phase !== 'working') return null
    if (
      typeof snapshot.internal_activity !== 'number'
      || !Number.isSafeInteger(snapshot.internal_activity)
      || snapshot.internal_activity < 0
      || snapshot.internal_activity > MAX_CODEX_EVIDENCE_COUNTER
      || typeof snapshot.elapsed !== 'number'
      || !Number.isFinite(snapshot.elapsed)
      || snapshot.elapsed < 0
      || !validProgressSummary(snapshot.summary, snapshot.phase)
      || (snapshot.phase === 'started'
        && (snapshot.internal_activity !== 0 || snapshot.elapsed !== 0 || snapshot.summary !== null))
    ) return null
    return Object.freeze({
      phase: snapshot.phase,
      internal_activity: snapshot.internal_activity,
      elapsed: snapshot.elapsed,
      summary: snapshot.summary as string | null,
    })
  } catch {
    return null
  }
}

function safePreflightExceptionCode(error: unknown, fallback: string): string {
  if (error instanceof AdapterDeadlineError) return 'adapter_timeout'
  if (error instanceof CodexTransportError && PREFLIGHT_CODES.has(error.code)) return error.code
  return fallback
}

function requireJsonRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  const parsed = jsonValueSchema.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Codex public content must be a JSON object')
  }
  return Object.freeze(parsed)
}

function sameKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

class InvalidPreflightError extends Error {}
export class AdapterDeadlineError extends Error {
  constructor(readonly lateValue?: unknown) { super('Codex adapter deadline exceeded') }
}
class AdapterAbortError extends Error {
  override readonly name = 'AbortError'
  constructor(readonly lateValue?: unknown) { super('Codex adapter dispatch cancelled') }
}
export class CodexAdapterClosedError extends Error {}

function abortError(): Error {
  const error = new Error('Codex adapter dispatch cancelled')
  error.name = 'AbortError'
  return error
}
