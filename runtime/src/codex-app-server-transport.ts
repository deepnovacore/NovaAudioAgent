import {Readable, Writable} from 'node:stream'

import {
  validateCodexSchemaBundle,
  validateEffectiveCodexConfig,
} from './codex-app-server-schema.js'
import {sanitizeCodexPreflightReport} from './codex-contract.js'
import type {
  CredentialSnapshot,
  CredentialSnapshotter,
} from './codex-credential-snapshot.js'
import {
  AppServerRequestRejected,
  CodexProtocolError,
  JsonRpcConnection,
  MAX_STDOUT,
} from './codex-protocol.js'
import {
  createApprovedCodexSpawnSpec,
  hostCodexHomeValue,
  hostWorkspacePath,
  takeUnconfirmedCodexProcessOwner,
  type CodexProcessOwnerFactory,
  type HostBinary,
  type HostCodexHome,
  type HostWorkspace,
  type OwnedCodexProcess,
} from './codex-process-owner.js'
import {snapshotJsonRecord} from './codex-safe-json.js'
import {AppServerTurnProjection, type TurnCompletion} from './codex-turn-projection.js'
import type {ExecutorProgress} from './causal-runtime.js'
import type {Clock} from './clock.js'
import {RealClock} from './clock.js'
import {stripLikePython, isWellFormed} from './python-text.js'
import {normalizeNfcPinned} from './unicode-normalize.js'
import {isOtherCategory} from './unicode-tables.js'
import {
  CodexApprovalController,
  routeCodexApprovalServerRequest,
} from './realtime/codex-approval.js'

export const CODEX_PREFLIGHT_LIMIT_MS = 20_000
export const CODEX_INTERRUPT_GRACE_MS = 2_000
export const CODEX_TREE_GRACE_MS = 5_000
const CODEX_CONTROL_GRACE_MS = 250
const CODEX_TREE_PHASE_GRACE_MS = 1_000
export const CODEX_STDERR_LIMIT = 64 * 1024
export const CODEX_WORK_ORDER_LIMIT = 65_536
export const CODEX_DEVELOPER_INSTRUCTIONS_LIMIT = 4000
export const CODEX_THREAD_ID_LIMIT = 256
export const CODEX_FINAL_TEXT_LIMIT = 4000

export type CodexTransportCode =
  | 'completed'
  | 'adapter_timeout'
  | 'binary_missing'
  | 'credential_missing'
  | 'preflight_failed'
  | 'preflight_timeout'
  | 'sandbox_failed'
  | 'spawn_failed'
  | 'stderr_too_large'
  | 'transport_lost'
  | 'unsupported_protocol'
  | 'unsupported_version'
  | 'workspace_invalid'
  | 'workspace_root_mismatch'
  | 'resume_unavailable'
  | 'server_rejected'
  | 'turn_failed'
  | 'missing_terminal'
  | 'nonzero_exit'
  | 'unexpected_server_request'
  | 'busy'

export interface CodexAppServerLaunchConfig {
  readonly binary: HostBinary
  readonly prefixArgs?: readonly string[]
  readonly workspace: HostWorkspace
  readonly codexHome: HostCodexHome
  readonly apiKey: string | null
  readonly developerInstructions: string | null
  readonly resumeThreadId: string | null
  readonly persistent: boolean
  readonly workingInterval?: number
  readonly approvalPolicy?: 'never' | 'on-request'
  readonly approvalController?: CodexApprovalController
}

type ValidatedCodexAppServerLaunchConfig = Omit<
  CodexAppServerLaunchConfig,
  'workingInterval' | 'approvalPolicy'
> & {
  readonly workingInterval: number
  readonly approvalPolicy: 'never' | 'on-request'
}

export interface TransportDeadline {
  readonly expiresAtMs: number
  readonly signal?: AbortSignal
}

export interface SafePreflightReport extends Readonly<Record<string, unknown>> {
  readonly version: string
  readonly root_matches: true
  readonly mount: 'workspace_only'
  readonly subprocess: 'contained'
  readonly network: 'blocked'
}

export interface RunInput { readonly workOrder: string }
export interface SteerInput { readonly instruction: string }

export interface TransportObserver {
  readonly onProgress?: (progress: ExecutorProgress) => void
  readonly onThreadReady?: (threadId: string) => void
  readonly onTurnStartWritten?: () => void
  readonly onTurnBound?: () => void
}

export interface TransportOutcome {
  readonly classification: 'completed' | 'refused' | 'uncertain'
  readonly code: CodexTransportCode
  readonly turnStartWritten: boolean
  readonly completion: TurnCompletion | null
}

export interface SteerTransportResult {
  readonly code: 'accepted' | 'no_active_turn' | 'stale_turn' | 'server_rejected' | 'transport_lost'
  readonly written: boolean
}

export interface CodexAppServerTransport {
  preflight(deadline: TransportDeadline): Promise<SafePreflightReport>
  prewarm(deadline: TransportDeadline): Promise<SafePreflightReport | null>
  run(
    input: RunInput,
    observer: TransportObserver,
    deadline: TransportDeadline,
  ): Promise<TransportOutcome>
  steer(input: SteerInput, deadline: TransportDeadline): Promise<SteerTransportResult>
  close(reason?: 'shutdown' | 'cancel' | 'failure'): Promise<void>
}

export interface CodexHostPreflightRunner {
  run(config: CodexAppServerLaunchConfig, timeoutMs: number): Promise<unknown>
}

export interface CodexLiveSchemaProbe {
  generate(config: CodexAppServerLaunchConfig, timeoutMs: number): Promise<Readonly<Record<string, unknown>>>
}

interface CredentialProvider {
  prepare(input: {readonly codexHome: HostCodexHome; readonly apiKey: string | null}): Promise<CredentialSnapshot>
  environment(snapshot: CredentialSnapshot): Readonly<Record<string, string>>
  removeEphemeralHome(home: HostCodexHome): Promise<void>
}

interface TransportScheduler {
  readonly clock: Clock
  yieldIo(): Promise<void>
}

const REAL_SCHEDULER: TransportScheduler = {
  clock: new RealClock(),
  yieldIo: async () => { await new Promise<void>(resolve => { setImmediate(resolve) }) },
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
  readonly settled: () => boolean
}

interface Session {
  readonly owner: OwnedCodexProcess
  readonly rpc: JsonRpcConnection
  readonly credentialSnapshot: CredentialSnapshot
  readonly failure: Deferred<CodexTransportError>
  failureCause: CodexTransportError | null
  readonly stdoutDone: Promise<void>
  readonly stderrDone: Promise<void>
  readonly settlePumps: () => Promise<void>
  readonly removeListeners: () => void
  readonly threadResponse: unknown
  projection: AppServerTurnProjection | null
  completion: Deferred<TurnCompletion> | null
  unexpectedServerRequest: boolean
  turnStartAdmitted: boolean
  turnStartWritten: boolean
  initialized: boolean
  warm: boolean
  used: boolean
  exited: boolean
  closing: boolean
  cleanupPromise: Promise<CleanupResult> | null
  closeStdinPromise: Promise<void> | null
  terminatePromise: Promise<void> | null
  interruptAttempted: boolean
  treeGone: boolean
  rpcEnded: boolean
  pumpPromise: Promise<void> | null
  pumpsSettled: boolean
  listenersRemoved: boolean
  pipesClosed: boolean
  disposePromise: Promise<void> | null
  disposed: boolean
  credentialSettled: boolean
  credentialCleanupFailed: boolean
  cleanupStop: 'none' | 'terminate' | 'kill'
  cleanupExitCode: number | null
}

interface CleanupResult {
  readonly stop: 'none' | 'terminate' | 'kill'
  readonly exitCode: number | null
  readonly cleanupFailed: boolean
  readonly treeGone: boolean
  readonly complete: boolean
}

interface RetainedOwnerCleanup {
  readonly owner: OwnedCodexProcess
  treeGone: boolean
  cleanupStop: 'none' | 'terminate' | 'kill'
  cleanupExitCode: number | null
  closeStdinPromise: Promise<void> | null
  terminatePromise: Promise<void> | null
  disposePromise: Promise<void> | null
  disposed: boolean
  credentialSettled: boolean
  credentialCleanupFailed: boolean
}

interface CredentialRemovalAttempt {
  promise: Promise<void>
  settled: boolean
  succeeded: boolean
}

export class CodexTransportError extends Error {
  readonly code: CodexTransportCode

  constructor(code: CodexTransportCode) {
    super(code)
    this.name = 'CodexTransportError'
    this.code = code
  }
}

export class OwnedCodexAppServerTransport implements CodexAppServerTransport {
  readonly #config: ValidatedCodexAppServerLaunchConfig
  readonly #processFactory: CodexProcessOwnerFactory
  readonly #credentials: CredentialProvider
  readonly #preflightRunner: CodexHostPreflightRunner
  readonly #schemaProbe: CodexLiveSchemaProbe
  readonly #scheduler: TransportScheduler
  #session: Session | null = null
  #prewarmPromise: Promise<SafePreflightReport | null> | null = null
  #establishPromise: Promise<{
    readonly report: SafePreflightReport
    readonly session: Session
  }> | null = null
  #closePromise: Promise<void> | null = null
  #firstCloseFailure: CodexTransportError | null = null
  #runActive = false
  #closed = false
  #hadTurn = false
  readonly #sensitiveInputs: string[] = []
  readonly #lateOwnerCleanups = new Set<Promise<void>>()
  readonly #pendingSpawnOwnerships = new Set<Promise<OwnedCodexProcess>>()
  readonly #lateCredentialCleanups = new Set<Promise<void>>()
  readonly #unconfirmedOwners = new Map<OwnedCodexProcess, RetainedOwnerCleanup>()
  readonly #spawnControllers = new Set<AbortController>()
  readonly #establishControllers = new Set<AbortController>()
  #lateCleanupFailure: CodexTransportError | null = null
  #credentialCleanupFailure: CodexTransportError | null = null
  #credentialRemovalRequired = false
  #credentialRemovalAttempt: CredentialRemovalAttempt | null = null
  #credentialPreparations = 0
  #retainedCleanupSession: Session | null = null

  constructor(options: {
    readonly config: CodexAppServerLaunchConfig
    readonly processFactory: CodexProcessOwnerFactory
    readonly credentialSnapshotter: CredentialSnapshotter | CredentialProvider
    readonly preflightRunner: CodexHostPreflightRunner
    readonly schemaProbe: CodexLiveSchemaProbe
    readonly scheduler?: TransportScheduler
  }) {
    this.#config = validateLaunchConfig(options.config)
    this.#processFactory = options.processFactory
    this.#credentials = options.credentialSnapshotter
    this.#preflightRunner = options.preflightRunner
    this.#schemaProbe = options.schemaProbe
    this.#scheduler = options.scheduler ?? REAL_SCHEDULER
  }

  async preflight(deadline: TransportDeadline): Promise<SafePreflightReport> {
    validateDeadline(deadline)
    return await this.#performPreflight(deadline)
  }

  prewarm(deadline: TransportDeadline): Promise<SafePreflightReport | null> {
    try {
      validateDeadline(deadline)
      if (this.#closed || this.#runActive) return Promise.resolve(null)
      if (this.#usableWarmSession() !== null) return Promise.resolve(null)
      if (this.#prewarmPromise !== null) {
        return runWithin(this.#prewarmPromise, deadline, 'preflight_timeout')
      }
      const work = this.#prewarm(deadline)
      this.#prewarmPromise = work
      void work.finally(() => {
        if (this.#prewarmPromise === work) this.#prewarmPromise = null
      }).catch(() => undefined)
      return work
    } catch (error) {
      return Promise.reject(safeTransportError(error, 'preflight_failed'))
    }
  }

  async #prewarm(deadline: TransportDeadline): Promise<SafePreflightReport | null> {
    let session: Session | null = null
    try {
      const established = await this.#startEstablish(deadline)
      session = established.session
      const projection = new AppServerTurnProjection({
        clock: this.#scheduler.clock,
        workingInterval: this.#config.workingInterval,
      })
      this.#bindThread(projection, session.threadResponse)
      await this.#scheduler.yieldIo()
      if (session.failureCause !== null) throw session.failureCause
      if (session.unexpectedServerRequest) {
        throw new CodexTransportError('unexpected_server_request')
      }
      session.projection = null
      session.warm = true
      this.#session = session
      return established.report
    } catch (error) {
      if (session !== null) await this.#cleanup(session, true)
      throw safeTransportError(error, 'preflight_failed')
    }
  }

  async run(
    input: RunInput,
    observer: TransportObserver,
    deadline: TransportDeadline,
  ): Promise<TransportOutcome> {
    let workOrder: string
    try {
      validateDeadline(deadline)
      workOrder = validateBoundedText(input.workOrder, CODEX_WORK_ORDER_LIMIT, 'transport_lost')
    } catch (error) {
      return outcome('refused', safeTransportError(error, 'transport_lost').code, false, null)
    }
    if (this.#closed || this.#runActive) return outcome('refused', 'busy', false, null)
    this.#runActive = true
    this.#sensitiveInputs.splice(0, this.#sensitiveInputs.length, workOrder)
    let session: Session | null = null
    let completion: TurnCompletion | null = null
    let failureCode: CodexTransportCode | null = null
    try {
      if (this.#prewarmPromise !== null) {
        await runWithin(this.#prewarmPromise, deadline, 'adapter_timeout')
      }
      session = this.#usableWarmSession()
      if (session === null) {
        if (this.#session !== null) await this.#cleanup(this.#session, true)
        session = (await this.#startEstablish(deadline)).session
        this.#session = session
      }
      session.used = true
      session.warm = false
      const progress = observer.onProgress === undefined && observer.onTurnBound === undefined
        ? undefined
        : (value: ExecutorProgress): void => {
          if (value.phase === 'started') {
            try { observer.onTurnBound?.() } catch { /* advisory */ }
          }
          if (observer.onProgress === undefined) return
          const summary = value.summary === null ? null : this.#sanitizeText(value.summary, 240).text
          try {
            observer.onProgress(Object.freeze({...value, summary: summary === '' ? null : summary}))
          } catch {
            // Advisory progress never owns the worker.
          }
        }
      const projection = new AppServerTurnProjection({
        clock: this.#scheduler.clock,
        workingInterval: this.#config.workingInterval,
        ...(progress === undefined ? {} : {onProgress: progress}),
      })
      session.projection = projection
      session.completion = deferred<TurnCompletion>()
      this.#bindThread(projection, session.threadResponse)
      const threadId = projection.threadId
      if (threadId === null) throw new CodexTransportError('unsupported_protocol')
      try { observer.onThreadReady?.(threadId) } catch { /* advisory */ }
      await this.#scheduler.yieldIo()
      const turnResponse = await this.#requestPreparedWithin(
        session,
        'turn/start',
        () => {
          if (session!.failureCause !== null) {
            throw new CodexProtocolError(session!.failureCause.code)
          }
          if (session!.unexpectedServerRequest) {
            throw new CodexProtocolError('unexpected_server_request')
          }
          session!.turnStartAdmitted = true
          return {threadId: projection.threadId, input: [{type: 'text', text: workOrder}]}
        },
        deadline,
        () => {
          session!.turnStartWritten = true
          try { observer.onTurnStartWritten?.() } catch { /* advisory */ }
        },
      )
      projection.bindTurnResponse(turnResponse)
      completion = await this.#waitForCompletion(session, deadline)
    } catch (error) {
      failureCode = safeTransportError(error, 'transport_lost').code
    }
    this.#hadTurn ||= session?.projection?.turnWasStarted ?? false
    const written = session?.turnStartWritten ?? false
    let cleanup: CleanupResult = {
      stop: 'none', exitCode: null, cleanupFailed: false, treeGone: true, complete: true,
    }
    if (session !== null) cleanup = await this.#cleanup(session, failureCode !== null)
    if (session !== null && cleanup.complete && this.#session === session) this.#session = null
    this.#runActive = false
    try {
      if (failureCode !== null) {
        return outcome(written ? 'uncertain' : 'refused', failureCode, written, completion)
      }
      if (completion === null) return outcome(written ? 'uncertain' : 'refused', 'transport_lost', written, null)
      const safeCompletion = Object.freeze({
        status: completion.status,
        final_text: completion.final_text === null
          ? null
          : this.#sanitizeText(completion.final_text, CODEX_FINAL_TEXT_LIMIT).text,
        internal_activity: completion.internal_activity,
      })
      if (cleanup.cleanupFailed) return outcome('uncertain', 'credential_missing', written, safeCompletion)
      if (!cleanup.complete) return outcome('uncertain', 'transport_lost', written, safeCompletion)
      if (session?.unexpectedServerRequest === true) {
        return outcome('uncertain', 'unexpected_server_request', written, safeCompletion)
      }
      if (completion.status !== 'completed') return outcome('uncertain', 'turn_failed', written, safeCompletion)
      if (safeCompletion.final_text === null) return outcome('uncertain', 'missing_terminal', written, safeCompletion)
      if (cleanup.exitCode !== 0) return outcome('uncertain', 'nonzero_exit', written, safeCompletion)
      if (cleanup.stop !== 'none') return outcome('uncertain', 'transport_lost', written, safeCompletion)
      return outcome('completed', 'completed', written, safeCompletion)
    } finally {
      this.#sensitiveInputs.splice(0)
    }
  }

  async steer(input: SteerInput, deadline: TransportDeadline): Promise<SteerTransportResult> {
    let instruction: string
    try {
      validateDeadline(deadline)
      instruction = validateBoundedText(input.instruction, CODEX_WORK_ORDER_LIMIT, 'stale_turn')
    } catch {
      return Object.freeze({code: 'stale_turn', written: false})
    }
    const session = this.#session
    const projection = session?.projection
    if (session === null || projection === null || projection === undefined || session.closing) {
      return Object.freeze({code: this.#hadTurn ? 'stale_turn' : 'no_active_turn', written: false})
    }
    let written = false
    let expectedTurnId: string | null = null
    try {
      const response = await this.#requestPreparedWithin(
        session,
        'turn/steer',
        () => {
          const pair = projection.activePair
          if (pair === null) throw new CodexProtocolError('stale_turn')
          expectedTurnId = pair[1]
          this.#sensitiveInputs.push(instruction)
          return {
            threadId: pair[0],
            expectedTurnId: pair[1],
            input: [{type: 'text', text: instruction}],
          }
        },
        deadline,
        () => {
          written = true
        },
      )
      const envelope = snapshotJsonRecord(response)
      if (!exactKeys(envelope, ['turnId']) || envelope.turnId !== expectedTurnId) {
        return Object.freeze({code: 'server_rejected', written: true})
      }
      return Object.freeze({code: 'accepted', written: true})
    } catch (error) {
      if (error instanceof AppServerRequestRejected) {
        return Object.freeze({
          code: error.server_code === -32602 && !written ? 'stale_turn' : 'server_rejected',
          written,
        })
      }
      if (!written) return Object.freeze({code: 'stale_turn', written: false})
      return Object.freeze({code: 'transport_lost', written: true})
    }
  }

  close(reason: 'shutdown' | 'cancel' | 'failure' = 'shutdown'): Promise<void> {
    this.#config.approvalController?.invalidate(reason)
    if (this.#closePromise !== null) return this.#closePromise
    this.#closed = true
    const work = this.#closeAttempt()
    const exposed = work.then(
      () => undefined,
      error => {
        this.#firstCloseFailure ??= safeTransportError(error, 'transport_lost')
        if (this.#closePromise === exposed && this.#hasRetainedCleanup()) {
          this.#closePromise = null
        }
        throw new CodexTransportError(this.#firstCloseFailure.code)
      },
    )
    this.#closePromise = exposed
    return exposed
  }

  async #closeAttempt(): Promise<void> {
    const expiresAtMs = Date.now() + CODEX_TREE_GRACE_MS
    let closeTimedOut = false
    let cleanupFailed = false
    let credentialCoordinated = false
    for (const controller of this.#establishControllers) controller.abort()
    for (const controller of this.#spawnControllers) controller.abort()

    const ownedAtClose = this.#retainedCleanupSession ?? this.#session
    if (ownedAtClose !== null) {
      credentialCoordinated = true
      const cleanup = await this.#cleanup(ownedAtClose, true, expiresAtMs)
      cleanupFailed ||= cleanup.cleanupFailed
      closeTimedOut ||= !cleanup.complete && !cleanup.cleanupFailed
    }
    const prewarm = this.#prewarmPromise
    if (prewarm !== null) closeTimedOut ||= !await settlePromiseBefore(prewarm, expiresAtMs)
    const establishing = this.#establishPromise
    if (establishing !== null) closeTimedOut ||= !await settlePromiseBefore(establishing, expiresAtMs)

    const session = this.#retainedCleanupSession ?? this.#session
    if (session !== null && session !== ownedAtClose) {
      credentialCoordinated = true
      const cleanup = await this.#cleanup(session, true, expiresAtMs)
      cleanupFailed ||= cleanup.cleanupFailed
      closeTimedOut ||= !cleanup.complete && !cleanup.cleanupFailed
    }
    if (this.#retainedCleanupSession === null) this.#session = null

    const lateOwner = [...this.#lateOwnerCleanups]
    if (lateOwner.length > 0) {
      closeTimedOut ||= !await settlePromiseBefore(Promise.allSettled(lateOwner), expiresAtMs)
    }
    const lateCredential = [...this.#lateCredentialCleanups]
    if (lateCredential.length > 0) {
      closeTimedOut ||= !await settlePromiseBefore(Promise.allSettled(lateCredential), expiresAtMs)
    }
    for (const ledger of [...this.#unconfirmedOwners.values()]) {
      credentialCoordinated = true
      const cleanup = await this.#cleanupRejectedOwner(ledger.owner, expiresAtMs)
      cleanupFailed ||= cleanup.cleanupFailed
      closeTimedOut ||= !cleanup.complete && !cleanup.cleanupFailed
    }
    if (this.#credentialRemovalRequired && !credentialCoordinated) {
      const credential = await this.#removeCredentialHomeBefore(expiresAtMs)
      cleanupFailed ||= credential === 'failed'
      closeTimedOut ||= credential === 'pending'
    }
    cleanupFailed ||= this.#credentialCleanupFailure !== null
    if (closeTimedOut) throw new CodexTransportError('transport_lost')
    if (this.#lateCleanupFailure !== null) throw new CodexTransportError(this.#lateCleanupFailure.code)
    if (cleanupFailed) throw new CodexTransportError('credential_missing')
    if (this.#hasRetainedCleanup()) throw new CodexTransportError('transport_lost')
    if (this.#firstCloseFailure !== null) throw new CodexTransportError(this.#firstCloseFailure.code)
  }

  #hasRetainedCleanup(): boolean {
    return this.#retainedCleanupSession !== null
      || this.#unconfirmedOwners.size > 0
      || this.#prewarmPromise !== null
      || this.#establishPromise !== null
      || this.#lateOwnerCleanups.size > 0
      || this.#pendingSpawnOwnerships.size > 0
      || this.#lateCredentialCleanups.size > 0
      || this.#credentialRemovalRequired
      || this.#credentialPreparations > 0
  }

  async #performPreflight(deadline: TransportDeadline): Promise<SafePreflightReport> {
    const hardDeadline = Math.min(deadline.expiresAtMs, Date.now() + CODEX_PREFLIGHT_LIMIT_MS)
    const bounded = {...deadline, expiresAtMs: hardDeadline}
    const probeConfig: ValidatedCodexAppServerLaunchConfig = Object.freeze({
      ...this.#config,
      apiKey: null,
    })
    let report: unknown
    try {
      report = await runWithin(
        this.#preflightRunner.run(probeConfig, Math.max(0, hardDeadline - Date.now())),
        bounded,
        'preflight_timeout',
      )
    } catch (error) {
      throw safeTransportError(error, 'preflight_failed')
    }
    const admitted = requireCompletePreflightReport(report)
    let bundle: Readonly<Record<string, unknown>>
    try {
      bundle = await runWithin(
        this.#schemaProbe.generate(probeConfig, Math.max(0, hardDeadline - Date.now())),
        bounded,
        'preflight_timeout',
      )
      validateCodexSchemaBundle(bundle)
    } catch (error) {
      if (error instanceof CodexTransportError && error.code === 'preflight_timeout') throw error
      throw new CodexTransportError('unsupported_protocol')
    }
    return admitted
  }

  async #establish(deadline: TransportDeadline): Promise<{
    readonly report: SafePreflightReport
    readonly session: Session
  }> {
    const report = await this.#performPreflight(deadline)
    if (this.#closed) throw new CodexTransportError('transport_lost')
    if (this.#credentialRemovalRequired) {
      this.#closed = true
      throw new CodexTransportError('transport_lost')
    }
    this.#credentialRemovalRequired = true
    this.#credentialRemovalAttempt = null
    let credentialSnapshot: CredentialSnapshot
    this.#credentialPreparations += 1
    const credentialWork = Promise.resolve()
      .then(() => this.#credentials.prepare({
        codexHome: this.#config.codexHome,
        apiKey: this.#config.apiKey,
      }))
      .finally(() => { this.#credentialPreparations -= 1 })
    try {
      credentialSnapshot = await runWithin(
        credentialWork,
        deadline,
        'adapter_timeout',
      )
    } catch (error) {
      // A libuv filesystem request cannot be force-cancelled. Keep its owned continuation
      // shielded, but bound the caller/close join and remove the selected home when it settles.
      const cleanup = this.#trackLateCredentialCleanup(credentialWork)
      const joined = await settlePromiseBefore(
        cleanup,
        Date.now() + CODEX_TREE_GRACE_MS,
      )
      if (!joined) {
        const closeOwnsCancellation = this.#closed
        this.#closed = true
        throw new CodexTransportError(closeOwnsCancellation ? 'transport_lost' : 'adapter_timeout')
      }
      if (this.#credentialCleanupFailure !== null) {
        throw new CodexTransportError('credential_missing')
      }
      if (error instanceof CodexTransportError && error.code === 'adapter_timeout') {
        throw new CodexTransportError(this.#closed ? 'transport_lost' : 'adapter_timeout')
      }
      throw new CodexTransportError('credential_missing')
    }
    if (this.#closed) {
      const removal = await this.#removeCredentialHomeBefore(
        Date.now() + CODEX_TREE_GRACE_MS,
      )
      if (removal !== 'complete') this.#closed = true
      throw new CodexTransportError('transport_lost')
    }
    let owner: OwnedCodexProcess
    try {
      const environment = this.#credentials.environment(credentialSnapshot)
      const spec = createApprovedCodexSpawnSpec({
        binary: this.#config.binary,
        prefixArgs: this.#config.prefixArgs ?? [],
        workspace: this.#config.workspace,
        codexHome: this.#config.codexHome,
        environment,
      })
      const spawnController = new AbortController()
      const abortSpawn = (): void => { spawnController.abort() }
      const spawnTimer = setTimeout(abortSpawn, Math.max(0, deadline.expiresAtMs - Date.now()))
      deadline.signal?.addEventListener('abort', abortSpawn, {once: true})
      this.#spawnControllers.add(spawnController)
      let spawnWaiterReleased = false
      const releaseSpawnWaiter = (): void => {
        if (spawnWaiterReleased) return
        spawnWaiterReleased = true
        clearTimeout(spawnTimer)
        deadline.signal?.removeEventListener('abort', abortSpawn)
        this.#spawnControllers.delete(spawnController)
      }
      const spawnWork = Promise.resolve().then(() => this.#processFactory.spawn(spec, {
        signal: spawnController.signal,
        expiresAtMs: deadline.expiresAtMs,
      }))
      try {
        owner = await runWithin(spawnWork, deadline, 'adapter_timeout')
      } catch (error) {
        spawnController.abort()
        const unconfirmedOwner = takeUnconfirmedCodexProcessOwner(error)
        if (unconfirmedOwner !== null) {
          this.#closed = true
          this.#retainUnconfirmedOwner(unconfirmedOwner)
          throw new CodexTransportError('transport_lost')
        }
        const safe = this.#closed
          ? new CodexTransportError('transport_lost')
          : deadline.signal?.aborted === true || Date.now() >= deadline.expiresAtMs
            ? new CodexTransportError('adapter_timeout')
            : safeTransportError(error, 'spawn_failed')
        if (safe.code === 'adapter_timeout' || safe.code === 'transport_lost') {
          this.#trackLateOwnerCleanup(spawnWork)
          this.#closed = true
          throw safe
        }
        throw safe
      } finally {
        // The deadline timer and caller listener belong to this waiter, not the raw spawn
        // ownership continuation. Late owner/rejection cleanup remains tracked separately.
        releaseSpawnWaiter()
      }
    } catch (error) {
      const safe = safeTransportError(error, 'spawn_failed')
      if (
        safe.code !== 'adapter_timeout'
        && safe.code !== 'transport_lost'
        && this.#unconfirmedOwners.size === 0
      ) {
        const removal = await this.#removeCredentialHomeBefore(
          Date.now() + CODEX_TREE_GRACE_MS,
        )
        if (removal !== 'complete') this.#closed = true
      }
      throw new CodexTransportError(
        safe.code === 'adapter_timeout' || safe.code === 'transport_lost'
          ? safe.code
          : 'spawn_failed',
      )
    }
    if (this.#closed) {
      if (!(await this.#cleanupRejectedOwner(owner)).complete) {
        throw new CodexTransportError('transport_lost')
      }
      throw new CodexTransportError('transport_lost')
    }
    let session: Session
    try {
      requireOwnedProcessContract(owner)
      session = this.#ownSession(owner, credentialSnapshot)
    } catch {
      if (!(await this.#cleanupRejectedOwner(owner)).complete) {
        throw new CodexTransportError('transport_lost')
      }
      throw new CodexTransportError('spawn_failed')
    }
    this.#session = session
    try {
      if (this.#closed) throw new CodexTransportError('transport_lost')
      await this.#requestWithin(session, 'initialize', {
        clientInfo: {name: 'nova-audio-agent', title: 'Nova Audio Agent', version: '1'},
      }, deadline)
      session.initialized = true
      await this.#notifyWithin(session, 'initialized', undefined, deadline)
      const configResponse = await this.#requestWithin(session, 'config/read', {
        includeLayers: true,
        cwd: hostWorkspacePath(this.#config.workspace),
      }, deadline)
      validateEffectiveCodexConfig(configResponse, hostWorkspacePath(this.#config.workspace), {
        allowReplacementInstructions: false,
      })
      const thread = this.#threadRequest()
      let threadResponse: unknown
      try {
        threadResponse = await this.#requestWithin(session, thread.method, thread.params, deadline)
      } catch (error) {
        if (thread.method === 'thread/resume' && error instanceof AppServerRequestRejected) {
          throw new CodexTransportError('resume_unavailable')
        }
        throw error
      }
      ;(session as {threadResponse: unknown}).threadResponse = threadResponse
      return {report, session}
    } catch (error) {
      const cleanup = await this.#cleanup(session, true)
      if (cleanup.complete && this.#session === session) this.#session = null
      throw safeTransportError(error, 'transport_lost')
    }
  }

  #startEstablish(deadline: TransportDeadline): Promise<{
    readonly report: SafePreflightReport
    readonly session: Session
  }> {
    if (this.#establishPromise !== null) return this.#establishPromise
    const controller = new AbortController()
    this.#establishControllers.add(controller)
    const signal = deadline.signal === undefined
      ? controller.signal
      : AbortSignal.any([deadline.signal, controller.signal])
    const work = this.#establish({...deadline, signal})
    this.#establishPromise = work
    void work.finally(() => {
      this.#establishControllers.delete(controller)
      if (this.#establishPromise === work) this.#establishPromise = null
    }).catch(() => undefined)
    return work
  }

  #ownSession(owner: OwnedCodexProcess, credentialSnapshot: CredentialSnapshot): Session {
    const failure = deferred<CodexTransportError>()
    let stdoutResolve!: () => void
    let stderrResolve!: () => void
    const stdoutDone = new Promise<void>(resolve => { stdoutResolve = resolve })
    const stderrDone = new Promise<void>(resolve => { stderrResolve = resolve })
    let feedChain = Promise.resolve()
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTerminal = false
    let stderrTerminal = false
    const rpc = new JsonRpcConnection({
      write: async bytes => { await writeDrain(owner.stdin, bytes) },
      onNotification: notification => {
        if (isTurnLifecycleNotification(notification.method) && !session.turnStartAdmitted) {
          this.#failSession(session, new CodexTransportError('unsupported_protocol'))
          return
        }
        const projection = session.projection
        if (projection === null) return
        try {
          const completion = projection.notification(notification.method, notification.params)
          if (completion !== null) {
            this.#config.approvalController?.invalidate('turn_completed')
            session.completion?.resolve(completion)
          }
        } catch (error) {
          this.#failSession(session, safeTransportError(error, 'unsupported_protocol'))
        }
      },
      onServerRequest: (_id, method, params, signal) => {
        const projection = session.projection
        const controller = this.#config.approvalController
        if (projection !== null && controller !== undefined) {
          const routed = routeCodexApprovalServerRequest({
            controller,
            workspace: hostWorkspacePath(this.#config.workspace),
            activePair: projection.activePair,
            fileChangeItem: (itemId, startedAtMs) => {
              const pair = projection.activePair
              if (pair === null) return null
              return projection.fileChangeItemForApproval(
                pair[0], pair[1], itemId, startedAtMs,
              )
            },
            method,
            params,
            signal,
          })
          if (routed !== undefined) return routed
        }
        session.unexpectedServerRequest = true
        if (session.turnStartWritten) this.#failSession(session, new CodexTransportError('unexpected_server_request'))
        return undefined
      },
    })
    const finishStdout = (failureCode: CodexTransportError | null): void => {
      if (failureCode !== null) this.#failSession(session, failureCode)
      if (stdoutTerminal) return
      stdoutTerminal = true
      owner.stdout.pause()
      void feedChain.then(() => {
        const ended = rpc.end()
        if (ended !== undefined) this.#failSession(session, mapProtocolFailure(ended))
        else if (failureCode === null && !session.closing && session.completion?.settled() !== true) {
          this.#failSession(session, new CodexTransportError('transport_lost'))
        }
      }, error => { this.#failSession(session, mapProtocolFailure(error)) }).finally(stdoutResolve)
    }
    const onStdoutData = (chunk: Buffer): void => {
      if (stdoutTerminal) return
      owner.stdout.pause()
      const byteLength = Reflect.get(chunk, 'byteLength') as unknown
      if (
        typeof byteLength !== 'number'
        || !Number.isSafeInteger(byteLength)
        || byteLength < 0
        || stdoutBytes + byteLength > MAX_STDOUT
      ) {
        finishStdout(new CodexTransportError('transport_lost'))
        return
      }
      let copy: Uint8Array
      try { copy = Uint8Array.from(chunk) }
      catch { finishStdout(new CodexTransportError('transport_lost')); return }
      stdoutBytes += byteLength
      const accepted = feedChain.then(async () => { await rpc.feed(copy) })
      feedChain = accepted
      void accepted.then(() => {
        if (!stdoutTerminal) owner.stdout.resume()
      }, error => { finishStdout(mapProtocolFailure(error)) })
    }
    const onStdoutEnd = (): void => { finishStdout(null) }
    const onStdoutError = (): void => { finishStdout(new CodexTransportError('transport_lost')) }
    const onStdoutClose = (): void => {
      if (!stdoutTerminal) finishStdout(new CodexTransportError('transport_lost'))
    }
    const onStderrData = (chunk: Buffer): void => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > CODEX_STDERR_LIMIT) {
        this.#failSession(session, new CodexTransportError('stderr_too_large'))
      }
    }
    const finishStderr = (failureCode: CodexTransportError | null): void => {
      if (failureCode !== null) this.#failSession(session, failureCode)
      if (stderrTerminal) return
      stderrTerminal = true
      stderrResolve()
    }
    const onStderrEnd = (): void => { finishStderr(null) }
    const onStderrError = (): void => { finishStderr(new CodexTransportError('transport_lost')) }
    const onStderrClose = (): void => {
      if (!stderrTerminal) finishStderr(new CodexTransportError('transport_lost'))
    }
    const onStdinError = (): void => {
      this.#failSession(session, new CodexTransportError('transport_lost'))
    }
    owner.stdin.on('error', onStdinError)
    owner.stdout.on('data', onStdoutData)
    owner.stdout.once('end', onStdoutEnd)
    owner.stdout.once('error', onStdoutError)
    owner.stdout.once('close', onStdoutClose)
    owner.stderr.on('data', onStderrData)
    owner.stderr.once('end', onStderrEnd)
    owner.stderr.once('error', onStderrError)
    owner.stderr.once('close', onStderrClose)
    const session: Session = {
      owner,
      rpc,
      credentialSnapshot,
      failure,
      failureCause: null,
      stdoutDone,
      stderrDone,
      settlePumps: async () => {
        finishStdout(session.closing ? null : new CodexTransportError('transport_lost'))
        finishStderr(session.closing ? null : new CodexTransportError('transport_lost'))
        await feedChain.catch(() => undefined)
        await Promise.all([stdoutDone, stderrDone])
      },
      removeListeners: () => {
        owner.stdin.off('error', onStdinError)
        owner.stdout.off('data', onStdoutData)
        owner.stdout.off('end', onStdoutEnd)
        owner.stdout.off('error', onStdoutError)
        owner.stdout.off('close', onStdoutClose)
        owner.stderr.off('data', onStderrData)
        owner.stderr.off('end', onStderrEnd)
        owner.stderr.off('error', onStderrError)
        owner.stderr.off('close', onStderrClose)
      },
      threadResponse: null,
      projection: null,
      completion: null,
      unexpectedServerRequest: false,
      turnStartAdmitted: false,
      turnStartWritten: false,
      initialized: false,
      warm: false,
      used: false,
      exited: false,
      closing: false,
      cleanupPromise: null,
      closeStdinPromise: null,
      terminatePromise: null,
      interruptAttempted: false,
      treeGone: false,
      rpcEnded: false,
      pumpPromise: null,
      pumpsSettled: false,
      listenersRemoved: false,
      pipesClosed: false,
      disposePromise: null,
      disposed: false,
      credentialSettled: false,
      credentialCleanupFailed: false,
      cleanupStop: 'none',
      cleanupExitCode: null,
    }
    void owner.exit.then(
      () => {
        session.exited = true
        if (!session.closing) this.#failSession(session, new CodexTransportError('transport_lost'))
      },
      () => {
        session.exited = true
        this.#failSession(session, new CodexTransportError('transport_lost'))
      },
    )
    return session
  }

  #threadRequest(): {
    readonly method: 'thread/start' | 'thread/resume'
    readonly params: Readonly<Record<string, unknown>>
  } {
    const workspace = hostWorkspacePath(this.#config.workspace)
    const common: Record<string, unknown> = {approvalPolicy: this.#config.approvalPolicy}
    if (this.#config.developerInstructions !== null) {
      common.developerInstructions = this.#config.developerInstructions
    }
    if (!this.#config.persistent) {
      return {method: 'thread/start', params: {...common, ephemeral: true}}
    }
    const persistent = {
      ...common,
      cwd: workspace,
    }
    if (this.#config.resumeThreadId !== null) {
      return {method: 'thread/resume', params: {
        ...persistent,
        threadId: this.#config.resumeThreadId,
      }}
    }
    return {method: 'thread/start', params: {...persistent, ephemeral: false}}
  }

  #bindThread(projection: AppServerTurnProjection, response: unknown): void {
    try {
      projection.bindThread(response, {
        workspace: hostWorkspacePath(this.#config.workspace),
        ephemeral: !this.#config.persistent,
        approvalPolicy: this.#config.approvalPolicy,
        ...(this.#config.resumeThreadId === null
          ? {}
          : {expectedThreadId: this.#config.resumeThreadId}),
      })
    } catch (error) {
      if (this.#config.resumeThreadId !== null) throw new CodexTransportError('resume_unavailable')
      throw error
    }
  }

  async #requestWithin(
    session: Session,
    method: string,
    params: Readonly<Record<string, unknown>>,
    deadline: TransportDeadline,
    onWritten?: () => void,
    observeSessionFailure = true,
  ): Promise<unknown> {
    return await requestWithDeadline(
      signal => session.rpc.request(method, params, {
        signal,
        ...(onWritten === undefined ? {} : {onWritten: () => { onWritten() }}),
      }),
      deadline,
      observeSessionFailure ? session.failure.promise : undefined,
    )
  }

  async #requestPreparedWithin(
    session: Session,
    method: string,
    prepare: () => Readonly<Record<string, unknown>>,
    deadline: TransportDeadline,
    onWritten?: () => void,
  ): Promise<unknown> {
    return await requestWithDeadline(
      signal => session.rpc.requestPrepared(method, prepare, {
        signal,
        ...(onWritten === undefined ? {} : {onWritten: () => { onWritten() }}),
      }),
      deadline,
      session.failure.promise,
    )
  }

  async #notifyWithin(
    session: Session,
    method: string,
    params: Readonly<Record<string, unknown>> | undefined,
    deadline: TransportDeadline,
  ): Promise<void> {
    await runWithin(session.rpc.notify(method, params), deadline, 'adapter_timeout')
  }

  async #waitForCompletion(session: Session, deadline: TransportDeadline): Promise<TurnCompletion> {
    const completion = session.completion
    if (completion === null) throw new CodexTransportError('transport_lost')
    return await runWithin(
      Promise.race([
        completion.promise,
        session.failure.promise.then(error => Promise.reject(error)),
      ]),
      deadline,
      'adapter_timeout',
    )
  }

  #usableWarmSession(): Session | null {
    const session = this.#session
    if (
      session === null
      || !session.warm
      || session.used
      || session.exited
      || session.unexpectedServerRequest
      || session.failureCause !== null
      || session.closing
    ) return null
    return session
  }

  #cleanup(
    session: Session,
    interrupt: boolean,
    expiresAtMs = Date.now() + CODEX_TREE_GRACE_MS,
  ): Promise<CleanupResult> {
    if (session.cleanupPromise !== null) return session.cleanupPromise
    session.closing = true
    this.#failSession(session, new CodexTransportError('transport_lost'))
    const work = this.#cleanupOwnedSession(session, interrupt, expiresAtMs)
      .then(result => {
        if (!result.complete && session.cleanupPromise === work) session.cleanupPromise = null
        return result
      }, error => {
        if (session.cleanupPromise === work) session.cleanupPromise = null
        throw error
      })
    session.cleanupPromise = work
    return work
  }

  async #cleanupOwnedSession(
    session: Session,
    interrupt: boolean,
    expiresAtMs: number,
  ): Promise<CleanupResult> {
    if (interrupt && !session.interruptAttempted && session.initialized && session.turnStartWritten) {
      session.interruptAttempted = true
      const pair = session.projection?.activePair
      if (pair !== null && pair !== undefined) {
        const interruptExpiresAtMs = Math.min(
          expiresAtMs,
          Date.now() + CODEX_INTERRUPT_GRACE_MS,
        )
        const interruptDeadline = {expiresAtMs: interruptExpiresAtMs}
        await this.#requestWithin(session, 'turn/interrupt', {
          threadId: pair[0], turnId: pair[1],
        }, interruptDeadline, undefined, false).catch(() => undefined)
        const completion = session.completion
        if (completion !== null && !completion.settled()) {
          await settleCleanupValue(
            () => completion.promise,
            Math.max(0, interruptExpiresAtMs - Date.now()),
            null,
          )
        }
      }
    }
    session.closeStdinPromise ??= Promise.resolve().then(() => session.owner.closeStdin())
    await settleSuccessBefore(session.closeStdinPromise, controlDeadline(expiresAtMs))
    if (!session.treeGone) {
      session.treeGone = await waitTreeGoneBefore(session.owner, expiresAtMs)
    }
    if (!session.treeGone) {
      session.cleanupStop = 'terminate'
      session.terminatePromise ??= Promise.resolve().then(() => session.owner.terminateTree())
      await settleSuccessBefore(session.terminatePromise, controlDeadline(expiresAtMs))
      session.treeGone = await waitTreeGoneBefore(session.owner, expiresAtMs)
    }
    if (!session.treeGone) {
      session.cleanupStop = 'kill'
      await settleOperationBefore(() => session.owner.killTree(), controlDeadline(expiresAtMs))
      session.treeGone = await waitTreeGoneBefore(session.owner, expiresAtMs)
    }
    if (!session.treeGone) {
      this.#retainedCleanupSession = session
      this.#closed = true
      this.#session = session
      return cleanupResult(session, false)
    }

    session.cleanupExitCode ??= await settleCleanupValue(
      () => session.owner.exit,
      Math.min(100, remainingMilliseconds(expiresAtMs)),
      null,
    )
    if (!session.rpcEnded) {
      session.rpc.end()
      session.rpcEnded = true
    }
    session.pumpPromise ??= session.settlePumps()
    if (!session.listenersRemoved) {
      session.removeListeners()
      session.listenersRemoved = true
    }
    if (!session.pipesClosed) {
      closeOwnedPipes(session.owner)
      session.pipesClosed = true
    }
    if (!session.pumpsSettled) {
      session.pumpsSettled = await settleSuccessBefore(session.pumpPromise, expiresAtMs)
      if (!session.pumpsSettled) {
        this.#retainedCleanupSession = session
        this.#closed = true
        this.#session = session
        return cleanupResult(session, false)
      }
    }
    session.disposePromise ??= Promise.resolve().then(() => session.owner.dispose())
    if (!session.disposed) {
      session.disposed = await settleSuccessBefore(session.disposePromise, expiresAtMs)
      if (!session.disposed) {
        this.#retainedCleanupSession = session
        this.#closed = true
        this.#session = session
        return cleanupResult(session, false)
      }
    }
    if (!session.credentialSettled) {
      const removal = await this.#removeCredentialHomeBefore(expiresAtMs)
      session.credentialSettled = removal === 'complete'
      session.credentialCleanupFailed ||= removal === 'failed'
      if (!session.credentialSettled) {
        this.#retainedCleanupSession = session
        this.#closed = true
        this.#session = session
        return cleanupResult(session, false)
      }
    }
    if (this.#retainedCleanupSession === session) this.#retainedCleanupSession = null
    return cleanupResult(session, true)
  }

  #sanitizeText(text: string, limit: number): {readonly text: string; readonly originalChars: number} {
    let normalized = normalizeNfcPinned([...text].slice(0, CODEX_WORK_ORDER_LIMIT).join(''))
    const secrets = [
      ...this.#sensitiveInputs.map(value => normalizeNfcPinned(value)),
      this.#config.apiKey,
      this.#config.developerInstructions,
      hostWorkspacePath(this.#config.workspace),
      hostCodexHomeValue(this.#config.codexHome).path,
    ].filter((value): value is string => value !== null && value !== '')
      .map(value => normalizeNfcPinned(value))
    secrets.sort((left, right) => [...right].length - [...left].length)
    for (const secret of secrets) normalized = normalized.replaceAll(secret, '[REDACTED]')
    normalized = normalized.replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
      '[PRIVATE_KEY]',
    )
    normalized = [...normalized].map(character => (
      isOtherCategory(character.codePointAt(0)!) ? ' ' : character
    )).join('')
    normalized = normalized.replace(
      /(?:bearer[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+[A-Za-z0-9._~+\/-]+=*|(?:sk|rk|pk)-[A-Za-z0-9_./+=-]{8,})/giu,
      '[REDACTED]',
    )
    const characters = [...normalized]
    return Object.freeze({text: characters.slice(0, limit).join(''), originalChars: characters.length})
  }

  #failSession(session: Session, error: CodexTransportError): void {
    if (session.failureCause !== null) return
    session.failureCause = error
    this.#config.approvalController?.invalidate(error.code)
    session.failure.resolve(error)
    if (session.warm && !session.used && !session.closing) {
      void this.#cleanup(session, true).catch(() => undefined)
    }
  }

  async #invokeCredentialHomeRemoval(): Promise<void> {
    try { await this.#credentials.removeEphemeralHome(this.#config.codexHome) }
    catch {
      this.#credentialCleanupFailure ??= new CodexTransportError('credential_missing')
      throw new CodexTransportError(this.#credentialCleanupFailure.code)
    }
  }

  async #removeCredentialHomeBefore(
    expiresAtMs: number,
  ): Promise<'complete' | 'pending' | 'failed'> {
    if (!this.#credentialRemovalRequired) return 'complete'
    if (this.#credentialPreparations > 0 || this.#pendingSpawnOwnerships.size > 0) return 'pending'
    let attempt = this.#credentialRemovalAttempt
    if (attempt === null) {
      const owned: CredentialRemovalAttempt = {
        promise: Promise.resolve(), settled: false, succeeded: false,
      }
      owned.promise = Promise.resolve()
        .then(() => this.#invokeCredentialHomeRemoval())
        .then(
          () => {
            owned.settled = true
            owned.succeeded = true
            this.#credentialRemovalRequired = false
          },
          () => {
            owned.settled = true
          },
        )
      attempt = owned
      this.#credentialRemovalAttempt = owned
    }
    if (!attempt.settled) {
      const settled = await settlePromiseBefore(attempt.promise, expiresAtMs)
      if (!settled) return 'pending'
    }
    if (attempt.succeeded) return 'complete'
    if (this.#credentialRemovalAttempt === attempt) this.#credentialRemovalAttempt = null
    return 'failed'
  }

  #trackLateCredentialCleanup(work: Promise<CredentialSnapshot>): Promise<void> {
    const remove = async (): Promise<void> => {
      const result = await this.#removeCredentialHomeBefore(Date.now() + CODEX_TREE_GRACE_MS)
      if (result === 'pending') throw new CodexTransportError('transport_lost')
      if (result === 'failed') throw new CodexTransportError('credential_missing')
    }
    const cleanupWork = work.then(remove, remove)
    this.#lateCredentialCleanups.add(cleanupWork)
    void cleanupWork.finally(() => {
      this.#lateCredentialCleanups.delete(cleanupWork)
    }).catch(() => undefined)
    return cleanupWork
  }

  #trackLateOwnerCleanup(spawnWork: Promise<OwnedCodexProcess>): void {
    this.#pendingSpawnOwnerships.add(spawnWork)
    const cleanupWork = spawnWork.then(async owner => {
      // Transfer the barrier to a retained owner before releasing pending spawn ownership.
      const ownerCleanup = this.#cleanupRejectedOwner(owner)
      this.#pendingSpawnOwnerships.delete(spawnWork)
      const cleanup = await ownerCleanup
      if (!cleanup.complete) {
        throw new CodexTransportError(cleanup.cleanupFailed ? 'credential_missing' : 'transport_lost')
      }
    }, async error => {
      const unconfirmedOwner = takeUnconfirmedCodexProcessOwner(error)
      if (unconfirmedOwner !== null) {
        this.#closed = true
        this.#retainUnconfirmedOwner(unconfirmedOwner)
        this.#pendingSpawnOwnerships.delete(spawnWork)
        throw new CodexTransportError('transport_lost')
      }
      // A definitive rejection proves no owner exists, so credential cleanup may proceed.
      this.#pendingSpawnOwnerships.delete(spawnWork)
      const removal = await this.#removeCredentialHomeBefore(
        Date.now() + CODEX_TREE_GRACE_MS,
      )
      if (removal === 'pending') throw new CodexTransportError('transport_lost')
      if (removal === 'failed') throw new CodexTransportError('credential_missing')
    })
    const cleanup = cleanupWork.catch(error => {
      this.#lateCleanupFailure ??= safeTransportError(error, 'credential_missing')
      throw this.#lateCleanupFailure
    })
    this.#lateOwnerCleanups.add(cleanup)
    void cleanup.finally(() => { this.#lateOwnerCleanups.delete(cleanup) }).catch(() => undefined)
  }

  #retainUnconfirmedOwner(owner: OwnedCodexProcess): RetainedOwnerCleanup {
    const existing = this.#unconfirmedOwners.get(owner)
    if (existing !== undefined) return existing
    const ledger: RetainedOwnerCleanup = {
      owner,
      treeGone: false,
      cleanupStop: 'none',
      cleanupExitCode: null,
      closeStdinPromise: null,
      terminatePromise: null,
      disposePromise: null,
      disposed: false,
      credentialSettled: false,
      credentialCleanupFailed: false,
    }
    this.#unconfirmedOwners.set(owner, ledger)
    return ledger
  }

  async #cleanupRejectedOwner(
    owner: OwnedCodexProcess,
    expiresAtMs = Date.now() + CODEX_TREE_GRACE_MS,
  ): Promise<CleanupResult> {
    const ledger = this.#retainUnconfirmedOwner(owner)
    ledger.closeStdinPromise ??= Promise.resolve().then(() => owner.closeStdin())
    await settleSuccessBefore(ledger.closeStdinPromise, controlDeadline(expiresAtMs))
    if (!ledger.treeGone) ledger.treeGone = await waitTreeGoneBefore(owner, expiresAtMs)
    if (!ledger.treeGone) {
      ledger.cleanupStop = 'terminate'
      ledger.terminatePromise ??= Promise.resolve().then(() => owner.terminateTree())
      await settleSuccessBefore(ledger.terminatePromise, controlDeadline(expiresAtMs))
      ledger.treeGone = await waitTreeGoneBefore(owner, expiresAtMs)
    }
    if (!ledger.treeGone) {
      ledger.cleanupStop = 'kill'
      await settleOperationBefore(() => owner.killTree(), controlDeadline(expiresAtMs))
      ledger.treeGone = await waitTreeGoneBefore(owner, expiresAtMs)
    }
    if (!ledger.treeGone) {
      this.#closed = true
      return retainedOwnerResult(ledger, false)
    }
    ledger.cleanupExitCode ??= await settleCleanupValue(
      () => owner.exit,
      Math.min(100, remainingMilliseconds(expiresAtMs)),
      null,
    )
    ledger.disposePromise ??= Promise.resolve().then(() => owner.dispose())
    if (!ledger.disposed) {
      ledger.disposed = await settleSuccessBefore(ledger.disposePromise, expiresAtMs)
      if (!ledger.disposed) {
        this.#closed = true
        return retainedOwnerResult(ledger, false)
      }
    }
    if (!ledger.credentialSettled) {
      const removal = await this.#removeCredentialHomeBefore(expiresAtMs)
      ledger.credentialSettled = removal === 'complete'
      ledger.credentialCleanupFailed ||= removal === 'failed'
      if (!ledger.credentialSettled) {
        this.#closed = true
        return retainedOwnerResult(ledger, false)
      }
    }
    this.#unconfirmedOwners.delete(owner)
    return retainedOwnerResult(ledger, true)
  }
}

function validateLaunchConfig(config: CodexAppServerLaunchConfig): ValidatedCodexAppServerLaunchConfig {
  hostWorkspacePath(config.workspace)
  const home = hostCodexHomeValue(config.codexHome)
  if (home.ephemeral === config.persistent) throw new CodexTransportError('workspace_invalid')
  const apiKey = config.apiKey === null
    ? null
    : validateBoundedText(config.apiKey, CODEX_WORK_ORDER_LIMIT, 'credential_missing', false)
  const developerInstructions = config.developerInstructions === null
    ? null
    : validateBoundedText(
      config.developerInstructions,
      CODEX_DEVELOPER_INSTRUCTIONS_LIMIT,
      'unsupported_protocol',
    )
  const resumeThreadId = config.resumeThreadId === null
    ? null
    : validateThreadId(config.resumeThreadId)
  if (!config.persistent && resumeThreadId !== null) throw new CodexTransportError('resume_unavailable')
  const approvalPolicy = config.approvalPolicy ?? 'never'
  if (
    (approvalPolicy !== 'never' && approvalPolicy !== 'on-request')
    || (approvalPolicy === 'on-request' && !(config.approvalController instanceof CodexApprovalController))
    || (approvalPolicy === 'never' && config.approvalController !== undefined)
  ) throw new CodexTransportError('workspace_invalid')
  return Object.freeze({
    binary: config.binary,
    prefixArgs: Object.freeze([...(config.prefixArgs ?? [])]),
    workspace: config.workspace,
    codexHome: config.codexHome,
    apiKey,
    developerInstructions,
    resumeThreadId,
    persistent: config.persistent,
    approvalPolicy,
    ...(config.approvalController === undefined
      ? {}
      : {approvalController: config.approvalController}),
    workingInterval: validateWorkingInterval(config.workingInterval),
  })
}

function validateWorkingInterval(value: number | undefined): number {
  const interval = value ?? 30
  if (!Number.isFinite(interval) || interval < 5 || interval > 600) {
    throw new CodexTransportError('workspace_invalid')
  }
  return interval
}

function validateThreadId(value: string): string {
  const normalized = stripLikePython(value)
  if (
    normalized === ''
    || [...normalized].length > CODEX_THREAD_ID_LIMIT
    || [...normalized].some(character => isOtherCategory(character.codePointAt(0)!))
  ) throw new CodexTransportError('resume_unavailable')
  return normalized
}

function validateBoundedText(
  value: string,
  limit: number,
  code: CodexTransportCode | 'stale_turn',
  strip = true,
): string {
  if (typeof value !== 'string' || !isWellFormed(value)) {
    throw new CodexTransportError(code === 'stale_turn' ? 'transport_lost' : code)
  }
  const normalized = strip ? stripLikePython(value) : value
  if (normalized === '' || [...normalized].length > limit) {
    throw new CodexTransportError(code === 'stale_turn' ? 'transport_lost' : code)
  }
  return normalized
}

function validateDeadline(deadline: TransportDeadline): void {
  if (
    typeof deadline !== 'object'
    || deadline === null
    || typeof deadline.expiresAtMs !== 'number'
    || !Number.isFinite(deadline.expiresAtMs)
    || deadline.expiresAtMs <= Date.now()
    || (deadline.signal !== undefined && !(deadline.signal instanceof AbortSignal))
    || deadline.signal?.aborted === true
  ) throw new CodexTransportError('adapter_timeout')
}

function requireCompletePreflightReport(value: unknown): SafePreflightReport {
  let raw: Readonly<Record<string, unknown>>
  try { raw = snapshotJsonRecord(value) }
  catch { throw new CodexTransportError('preflight_failed') }
  if (
    Object.hasOwn(raw, 'version')
    && typeof raw.version === 'string'
    && !versionAtLeast(raw.version, [0, 145, 0])
  ) throw new CodexTransportError('unsupported_version')
  const admitted = sanitizeCodexPreflightReport(value)
  if (
    typeof admitted?.version !== 'string'
    || admitted.root_matches !== true
    || admitted.mount !== 'workspace_only'
    || admitted.subprocess !== 'contained'
    || admitted.network !== 'blocked'
    || !isPlainRecord(admitted.credential)
    || admitted.credential.present !== true
    || !isPlainRecord(admitted.limits)
  ) throw new CodexTransportError('preflight_failed')
  if (!versionAtLeast(admitted.version, [0, 145, 0])) {
    throw new CodexTransportError('unsupported_version')
  }
  return admitted as SafePreflightReport
}

function versionAtLeast(value: string, minimum: readonly [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value)
  if (match === null) return false
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  if (!actual.every(Number.isSafeInteger)) return false
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true
    if (actual[index]! < minimum[index]!) return false
  }
  return true
}

async function requestWithDeadline(
  operation: (signal: AbortSignal) => Promise<unknown>,
  deadline: TransportDeadline,
  sessionFailure?: Promise<CodexTransportError>,
): Promise<unknown> {
  validateDeadline(deadline)
  const controller = new AbortController()
  let timedOut = false
  const remaining = Math.max(0, deadline.expiresAtMs - Date.now())
  let rejectDeadline!: (error: Error) => void
  const deadlineFailure = new Promise<never>((_resolve, reject) => { rejectDeadline = reject })
  void deadlineFailure.catch(() => undefined)
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    rejectDeadline(new CodexTransportError('adapter_timeout'))
  }, remaining)
  const onAbort = (): void => {
    controller.abort()
    rejectDeadline(new CodexTransportError('adapter_timeout'))
  }
  deadline.signal?.addEventListener('abort', onAbort, {once: true})
  try {
    const request = operation(controller.signal)
    const candidates: Promise<unknown>[] = [request, deadlineFailure]
    if (sessionFailure !== undefined) candidates.push(sessionFailure.then(error => {
      controller.abort()
      throw error
    }))
    return await Promise.race(candidates)
  } catch (error) {
    if (timedOut || deadline.signal?.aborted === true) throw new CodexTransportError('adapter_timeout')
    throw error
  } finally {
    clearTimeout(timer)
    deadline.signal?.removeEventListener('abort', onAbort)
  }
}

async function runWithin<T>(
  operation: Promise<T>,
  deadline: TransportDeadline,
  timeoutCode: CodexTransportCode,
): Promise<T> {
  validateDeadline(deadline)
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new CodexTransportError(timeoutCode)) }, deadline.expiresAtMs - Date.now())
    if (deadline.signal !== undefined) {
      onAbort = () => { reject(new CodexTransportError(timeoutCode)) }
      deadline.signal.addEventListener('abort', onAbort, {once: true})
    }
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) deadline.signal?.removeEventListener('abort', onAbort)
  }
}

async function writeDrain(stream: Writable, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null = null): void => {
      if (settled) return
      settled = true
      stream.off('error', onError)
      stream.off('close', onClose)
      if (error === null) resolve()
      else reject(new CodexTransportError('transport_lost'))
    }
    const onError = (): void => { finish(new Error('stream failure')) }
    const onClose = (): void => { finish(new Error('stream closed')) }
    stream.once('error', onError)
    stream.once('close', onClose)
    try {
      stream.write(bytes, error => { finish(error ?? null) })
    } catch {
      finish(new Error('stream failure'))
    }
  })
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (error: Error) => void
  let isSettled = false
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  void promise.catch(() => undefined)
  return {
    promise,
    resolve: value => {
      if (isSettled) return
      isSettled = true
      resolvePromise(value)
    },
    reject: error => {
      if (isSettled) return
      isSettled = true
      rejectPromise(error)
    },
    settled: () => isSettled,
  }
}

function outcome(
  classification: TransportOutcome['classification'],
  code: CodexTransportCode,
  turnStartWritten: boolean,
  completion: TurnCompletion | null,
): TransportOutcome {
  return Object.freeze({classification, code, turnStartWritten, completion})
}

function mapProtocolFailure(error: unknown): CodexTransportError {
  if (error instanceof AppServerRequestRejected) return new CodexTransportError('server_rejected')
  if (!(error instanceof CodexProtocolError)) return new CodexTransportError('transport_lost')
  if (error.code === 'stdout_too_large' || error.code === 'stdout_line_too_large') {
    return new CodexTransportError('transport_lost')
  }
  if (error.code === 'config_not_isolated') return new CodexTransportError('unsupported_protocol')
  if (error.code === 'stream_failure' || error.code === 'transport_lost') {
    return new CodexTransportError('transport_lost')
  }
  if (error.code === 'stderr_too_large') return new CodexTransportError('stderr_too_large')
  if (error.code === 'unexpected_server_request') {
    return new CodexTransportError('unexpected_server_request')
  }
  return new CodexTransportError('unsupported_protocol')
}

function safeTransportError(error: unknown, fallback: CodexTransportCode): CodexTransportError {
  if (error instanceof CodexTransportError) return new CodexTransportError(error.code)
  if (error instanceof CodexProtocolError) return mapProtocolFailure(error)
  if (isPlainRecord(error)) {
    const code = error.code
    if (typeof code === 'string' && TRANSPORT_CODES.has(code as CodexTransportCode)) {
      return new CodexTransportError(code as CodexTransportCode)
    }
  }
  return new CodexTransportError(fallback)
}

function isTurnLifecycleNotification(method: string): boolean {
  return method === 'turn/started'
    || method === 'item/started'
    || method === 'item/completed'
    || method === 'turn/completed'
}

const TRANSPORT_CODES: ReadonlySet<CodexTransportCode> = new Set([
  'completed', 'adapter_timeout', 'binary_missing', 'credential_missing', 'preflight_failed',
  'preflight_timeout', 'sandbox_failed', 'spawn_failed', 'stderr_too_large', 'transport_lost',
  'unsupported_protocol', 'unsupported_version', 'workspace_invalid', 'workspace_root_mismatch',
  'resume_unavailable', 'server_rejected', 'turn_failed', 'missing_terminal', 'nonzero_exit',
  'unexpected_server_request', 'busy',
])

function remainingMilliseconds(expiresAtMs: number): number {
  return Math.max(0, expiresAtMs - Date.now())
}

function controlDeadline(expiresAtMs: number): number {
  return Math.min(expiresAtMs, Date.now() + CODEX_CONTROL_GRACE_MS)
}

async function settlePromiseBefore(work: Promise<unknown>, expiresAtMs: number): Promise<boolean> {
  return await settleCleanupValue(
    async () => { await work.catch(() => undefined); return true },
    remainingMilliseconds(expiresAtMs),
    false,
  )
}

async function settleSuccessBefore(work: Promise<unknown>, expiresAtMs: number): Promise<boolean> {
  return await settleCleanupValue(
    async () => { await work; return true },
    remainingMilliseconds(expiresAtMs),
    false,
  )
}

async function settleOperationBefore(
  operation: () => Promise<void>,
  expiresAtMs: number,
): Promise<boolean> {
  return await settleCleanupValue(
    async () => { await operation(); return true },
    remainingMilliseconds(expiresAtMs),
    false,
  )
}

async function waitTreeGoneBefore(
  owner: OwnedCodexProcess,
  expiresAtMs: number,
): Promise<boolean> {
  const graceMs = Math.min(CODEX_TREE_PHASE_GRACE_MS, remainingMilliseconds(expiresAtMs))
  if (graceMs <= 0) return false
  return await settleCleanupValue(
    () => owner.waitTreeGone(graceMs),
    graceMs,
    false,
  )
}

function closeOwnedPipes(owner: OwnedCodexProcess): void {
  try { owner.stdin.destroy() } catch { /* tree is already gone; continue final cleanup */ }
  try { owner.stdout.destroy() } catch { /* tree is already gone; continue final cleanup */ }
  try { owner.stderr.destroy() } catch { /* tree is already gone; continue final cleanup */ }
}

function cleanupResult(session: Session, complete: boolean): CleanupResult {
  return Object.freeze({
    stop: session.cleanupStop,
    exitCode: session.cleanupExitCode,
    cleanupFailed: session.credentialCleanupFailed,
    treeGone: session.treeGone,
    complete,
  })
}

function retainedOwnerResult(ledger: RetainedOwnerCleanup, complete: boolean): CleanupResult {
  return Object.freeze({
    stop: ledger.cleanupStop,
    exitCode: ledger.cleanupExitCode,
    cleanupFailed: ledger.credentialCleanupFailed,
    treeGone: ledger.treeGone,
    complete,
  })
}

async function settleCleanupValue<T>(
  operation: () => Promise<T>,
  milliseconds: number,
  fallback: T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation().catch(() => fallback),
      new Promise<T>(resolve => { timer = setTimeout(() => { resolve(fallback) }, milliseconds) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

function requireOwnedProcessContract(owner: OwnedCodexProcess): void {
  if (
    typeof owner !== 'object'
    || owner === null
    || !(owner.stdin instanceof Writable)
    || !(owner.stdout instanceof Readable)
    || !(owner.stderr instanceof Readable)
    || !(owner.exit instanceof Promise)
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0
    || typeof owner.closeStdin !== 'function'
    || typeof owner.waitTreeGone !== 'function'
    || typeof owner.terminateTree !== 'function'
    || typeof owner.killTree !== 'function'
    || typeof owner.dispose !== 'function'
  ) throw new CodexTransportError('spawn_failed')
}
