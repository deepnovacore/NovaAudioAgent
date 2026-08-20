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

export const CODEX_PREFLIGHT_LIMIT_MS = 20_000
export const CODEX_INTERRUPT_GRACE_MS = 2_000
export const CODEX_TREE_GRACE_MS = 5_000
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
  readonly workspace: HostWorkspace
  readonly codexHome: HostCodexHome
  readonly apiKey: string | null
  readonly developerInstructions: string | null
  readonly resumeThreadId: string | null
  readonly persistent: boolean
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
  readonly onThreadReady?: () => void
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
  turnStartWritten: boolean
  initialized: boolean
  warm: boolean
  used: boolean
  exited: boolean
  closing: boolean
  cleanupPromise: Promise<CleanupResult> | null
}

interface CleanupResult {
  readonly stop: 'none' | 'terminate' | 'kill'
  readonly exitCode: number | null
  readonly cleanupFailed: boolean
  readonly treeGone: boolean
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
  readonly #config: CodexAppServerLaunchConfig
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
  #runActive = false
  #closed = false
  #hadTurn = false
  readonly #sensitiveInputs: string[] = []
  readonly #lateOwnerCleanups = new Set<Promise<void>>()
  readonly #unconfirmedOwners = new Set<OwnedCodexProcess>()
  readonly #spawnControllers = new Set<AbortController>()
  #lateCleanupFailure: CodexTransportError | null = null
  #credentialCleanupFailure: CodexTransportError | null = null
  #failedTreeSession: Session | null = null

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
      if (this.#prewarmPromise !== null) return this.#prewarmPromise
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
      const projection = new AppServerTurnProjection({clock: this.#scheduler.clock})
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
      if (this.#prewarmPromise !== null) await this.#prewarmPromise
      session = this.#usableWarmSession()
      if (session === null) {
        if (this.#session !== null) await this.#cleanup(this.#session, true)
        session = (await this.#startEstablish(deadline)).session
        this.#session = session
      }
      session.used = true
      session.warm = false
      const progress = observer.onProgress === undefined
        ? undefined
        : (value: ExecutorProgress): void => {
          const summary = value.summary === null ? null : this.#sanitizeText(value.summary, 240).text
          try {
            observer.onProgress?.(Object.freeze({...value, summary: summary === '' ? null : summary}))
          } catch {
            // Advisory progress never owns the worker.
          }
        }
      const projection = new AppServerTurnProjection({
        clock: this.#scheduler.clock,
        ...(progress === undefined ? {} : {onProgress: progress}),
      })
      session.projection = projection
      session.completion = deferred<TurnCompletion>()
      this.#bindThread(projection, session.threadResponse)
      try { observer.onThreadReady?.() } catch { /* advisory */ }
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
          return {threadId: projection.threadId, input: [{type: 'text', text: workOrder}]}
        },
        deadline,
        () => { session!.turnStartWritten = true },
      )
      projection.bindTurnResponse(turnResponse)
      completion = await this.#waitForCompletion(session, deadline)
    } catch (error) {
      failureCode = safeTransportError(error, 'transport_lost').code
    }
    this.#hadTurn ||= session?.projection?.turnWasStarted ?? false
    const written = session?.turnStartWritten ?? false
    let cleanup: CleanupResult = {stop: 'none', exitCode: null, cleanupFailed: false, treeGone: true}
    if (session !== null) cleanup = await this.#cleanup(session, failureCode !== null)
    if (session !== null && cleanup.treeGone && this.#session === session) this.#session = null
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
          code: error.server_code === -32602 ? 'stale_turn' : 'server_rejected',
          written,
        })
      }
      if (!written) return Object.freeze({code: 'stale_turn', written: false})
      return Object.freeze({code: 'transport_lost', written: true})
    }
  }

  close(reason: 'shutdown' | 'cancel' | 'failure' = 'shutdown'): Promise<void> {
    void reason
    if (this.#closePromise !== null) return this.#closePromise
    this.#closed = true
    const work = (async (): Promise<void> => {
      let closeTimedOut = false
      for (const controller of this.#spawnControllers) controller.abort()
      const ownedAtClose = this.#session
      let cleanupFailed = false
      if (ownedAtClose !== null) {
        const cleanup = await this.#cleanupWithRetry(ownedAtClose, true)
        cleanupFailed ||= cleanup.cleanupFailed
        closeTimedOut ||= !cleanup.treeGone
      }
      const prewarm = this.#prewarmPromise
      if (prewarm !== null) await prewarm.catch(() => undefined)
      const establishing = this.#establishPromise
      if (establishing !== null) {
        closeTimedOut ||= !await settleCleanupValue(
          async () => { await establishing.catch(() => undefined); return true },
          CODEX_TREE_GRACE_MS,
          false,
        )
      }
      const session = this.#session
      if (session !== null && session !== ownedAtClose) {
        const cleanup = await this.#cleanupWithRetry(session, true)
        cleanupFailed ||= cleanup.cleanupFailed
        closeTimedOut ||= !cleanup.treeGone
      }
      if (this.#failedTreeSession === null) this.#session = null
      const late = [...this.#lateOwnerCleanups]
      if (late.length > 0) {
        closeTimedOut ||= !await settleCleanupValue(
          async () => { await Promise.allSettled(late); return true },
          CODEX_TREE_GRACE_MS,
          false,
        )
      }
      for (const owner of [...this.#unconfirmedOwners]) {
        const gone = await this.#cleanupRejectedOwner(owner)
        closeTimedOut ||= !gone
        if (gone) {
          try { await this.#removeCredentialHome() } catch { cleanupFailed = true }
        }
      }
      cleanupFailed ||= this.#credentialCleanupFailure !== null
      closeTimedOut ||= this.#failedTreeSession !== null || this.#unconfirmedOwners.size > 0
      if (closeTimedOut) throw new CodexTransportError('transport_lost')
      if (this.#lateCleanupFailure !== null) {
        throw new CodexTransportError(this.#lateCleanupFailure.code)
      }
      if (cleanupFailed) throw new CodexTransportError('credential_missing')
    })()
    this.#closePromise = work
    return work
  }

  async #performPreflight(deadline: TransportDeadline): Promise<SafePreflightReport> {
    const hardDeadline = Math.min(deadline.expiresAtMs, Date.now() + CODEX_PREFLIGHT_LIMIT_MS)
    const bounded = {...deadline, expiresAtMs: hardDeadline}
    let report: unknown
    try {
      report = await runWithin(
        this.#preflightRunner.run(this.#config, Math.max(0, hardDeadline - Date.now())),
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
        this.#schemaProbe.generate(this.#config, Math.max(0, hardDeadline - Date.now())),
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
    let credentialSnapshot: CredentialSnapshot
    const credentialWork = Promise.resolve().then(() => this.#credentials.prepare({
      codexHome: this.#config.codexHome,
      apiKey: this.#config.apiKey,
    }))
    try {
      credentialSnapshot = await runWithin(
        credentialWork,
        deadline,
        'adapter_timeout',
      )
    } catch (error) {
      // Node's promise-based filesystem operations run through the libuv worker pool. A timeout
      // stops admission, not the already-owned worker operation, so shield and join it before
      // cleaning the selected home or returning cancellation to the caller.
      await credentialWork.catch(() => undefined)
      await this.#removeCredentialHome()
      if (error instanceof CodexTransportError && error.code === 'adapter_timeout') throw error
      throw new CodexTransportError('credential_missing')
    }
    if (this.#closed) {
      await this.#removeCredentialHome()
      throw new CodexTransportError('transport_lost')
    }
    let owner: OwnedCodexProcess
    try {
      const environment = this.#credentials.environment(credentialSnapshot)
      const spec = createApprovedCodexSpawnSpec({
        binary: this.#config.binary,
        workspace: this.#config.workspace,
        codexHome: this.#config.codexHome,
        environment,
      })
      const spawnController = new AbortController()
      const abortSpawn = (): void => { spawnController.abort() }
      const spawnTimer = setTimeout(abortSpawn, Math.max(0, deadline.expiresAtMs - Date.now()))
      deadline.signal?.addEventListener('abort', abortSpawn, {once: true})
      this.#spawnControllers.add(spawnController)
      const spawnWork = Promise.resolve().then(() => this.#processFactory.spawn(spec, {
        signal: spawnController.signal,
        expiresAtMs: deadline.expiresAtMs,
      }))
      void spawnWork.finally(() => {
        clearTimeout(spawnTimer)
        deadline.signal?.removeEventListener('abort', abortSpawn)
        this.#spawnControllers.delete(spawnController)
      }).catch(() => undefined)
      try {
        owner = await runWithin(spawnWork, deadline, 'adapter_timeout')
      } catch (error) {
        spawnController.abort()
        const unconfirmedOwner = takeUnconfirmedCodexProcessOwner(error)
        if (unconfirmedOwner !== null) {
          this.#closed = true
          this.#unconfirmedOwners.add(unconfirmedOwner)
          throw new CodexTransportError('transport_lost')
        }
        const safe = this.#closed
          ? new CodexTransportError('transport_lost')
          : deadline.signal?.aborted === true || Date.now() >= deadline.expiresAtMs
            ? new CodexTransportError('adapter_timeout')
            : safeTransportError(error, 'spawn_failed')
        if (safe.code === 'adapter_timeout') {
          this.#trackLateOwnerCleanup(spawnWork)
          throw safe
        }
        throw safe
      }
    } catch (error) {
      const safe = safeTransportError(error, 'spawn_failed')
      if (safe.code !== 'adapter_timeout' && this.#unconfirmedOwners.size === 0) {
        await this.#removeCredentialHome().catch(() => undefined)
      }
      throw new CodexTransportError(
        safe.code === 'adapter_timeout' || safe.code === 'transport_lost'
          ? safe.code
          : 'spawn_failed',
      )
    }
    if (this.#closed) {
      if (!await this.#cleanupRejectedOwner(owner)) throw new CodexTransportError('transport_lost')
      await this.#removeCredentialHome()
      throw new CodexTransportError('transport_lost')
    }
    let session: Session
    try {
      requireOwnedProcessContract(owner)
      session = this.#ownSession(owner, credentialSnapshot)
    } catch {
      if (!await this.#cleanupRejectedOwner(owner)) throw new CodexTransportError('transport_lost')
      await this.#removeCredentialHome()
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
      if (cleanup.treeGone && this.#session === session) this.#session = null
      throw safeTransportError(error, 'transport_lost')
    }
  }

  #startEstablish(deadline: TransportDeadline): Promise<{
    readonly report: SafePreflightReport
    readonly session: Session
  }> {
    if (this.#establishPromise !== null) return this.#establishPromise
    const work = this.#establish(deadline)
    this.#establishPromise = work
    void work.finally(() => {
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
        const projection = session.projection
        if (projection === null) return
        try {
          const completion = projection.notification(notification.method, notification.params)
          if (completion !== null) session.completion?.resolve(completion)
        } catch (error) {
          this.#failSession(session, safeTransportError(error, 'unsupported_protocol'))
        }
      },
      onServerRequest: () => {
        session.unexpectedServerRequest = true
        if (session.turnStartWritten) this.#failSession(session, new CodexTransportError('unexpected_server_request'))
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
      turnStartWritten: false,
      initialized: false,
      warm: false,
      used: false,
      exited: false,
      closing: false,
      cleanupPromise: null,
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
    const common: Record<string, unknown> = {approvalPolicy: 'never'}
    if (this.#config.developerInstructions !== null) {
      common.developerInstructions = this.#config.developerInstructions
    }
    if (!this.#config.persistent) {
      return {method: 'thread/start', params: {...common, ephemeral: true}}
    }
    const persistent = {
      ...common,
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      permissions: 'nova_audio_agent',
    }
    if (this.#config.resumeThreadId !== null) {
      return {method: 'thread/resume', params: {
        ...persistent,
        threadId: this.#config.resumeThreadId,
        excludeTurns: true,
      }}
    }
    return {method: 'thread/start', params: {...persistent, ephemeral: false}}
  }

  #bindThread(projection: AppServerTurnProjection, response: unknown): void {
    try {
      projection.bindThread(response, {
        workspace: hostWorkspacePath(this.#config.workspace),
        ephemeral: !this.#config.persistent,
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

  #cleanup(session: Session, interrupt: boolean): Promise<CleanupResult> {
    if (session.cleanupPromise !== null) return session.cleanupPromise
    session.closing = true
    this.#failSession(session, new CodexTransportError('transport_lost'))
    const work = this.#cleanupOwnedSession(session, interrupt).then(result => {
      if (!result.treeGone && session.cleanupPromise === work) session.cleanupPromise = null
      return result
    })
    session.cleanupPromise = work
    return work
  }

  async #cleanupWithRetry(session: Session, interrupt: boolean): Promise<CleanupResult> {
    let cleanup = await this.#cleanup(session, interrupt)
    if (!cleanup.treeGone) cleanup = await this.#cleanup(session, interrupt)
    return cleanup
  }

  async #cleanupOwnedSession(session: Session, interrupt: boolean): Promise<CleanupResult> {
    let stop: CleanupResult['stop'] = 'none'
    if (interrupt && session.initialized && session.turnStartWritten) {
      const pair = session.projection?.activePair
      if (pair !== null && pair !== undefined) {
        const interruptExpiresAtMs = Date.now() + CODEX_INTERRUPT_GRACE_MS
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
    await settleCleanup(() => session.owner.closeStdin(), CODEX_INTERRUPT_GRACE_MS)
    let gone = await settleCleanupValue(
      () => session.owner.waitTreeGone(CODEX_TREE_GRACE_MS),
      CODEX_TREE_GRACE_MS + 100,
      false,
    )
    if (!gone) {
      stop = 'terminate'
      await settleCleanup(() => session.owner.terminateTree(), CODEX_INTERRUPT_GRACE_MS)
      gone = await settleCleanupValue(
        () => session.owner.waitTreeGone(CODEX_TREE_GRACE_MS),
        CODEX_TREE_GRACE_MS + 100,
        false,
      )
    }
    if (!gone) {
      stop = 'kill'
      await settleCleanup(() => session.owner.killTree(), CODEX_INTERRUPT_GRACE_MS)
      gone = await settleCleanupValue(
        () => session.owner.waitTreeGone(CODEX_TREE_GRACE_MS),
        CODEX_TREE_GRACE_MS + 100,
        false,
      )
    }
    const exitCode = await settleCleanupValue(
      () => session.owner.exit,
      CODEX_TREE_GRACE_MS,
      null,
    )
    session.rpc.end()
    await settleCleanup(() => session.owner.dispose(), CODEX_TREE_GRACE_MS)
    await session.settlePumps()
    session.removeListeners()
    let cleanupFailed = false
    if (gone) {
      if (this.#failedTreeSession === session) this.#failedTreeSession = null
      try { await this.#removeCredentialHome() } catch { cleanupFailed = true }
    } else {
      this.#failedTreeSession = session
      this.#closed = true
      this.#session = session
    }
    return Object.freeze({stop, exitCode, cleanupFailed, treeGone: gone})
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
    normalized = normalized.replace(/(?:bearer\s+|(?:sk|rk|pk)-)[A-Za-z0-9_./+=-]{8,}/giu, '[REDACTED]')
    normalized = [...normalized].map(character => (
      isOtherCategory(character.codePointAt(0)!) ? ' ' : character
    )).join('')
    const characters = [...normalized]
    return Object.freeze({text: characters.slice(0, limit).join(''), originalChars: characters.length})
  }

  #failSession(session: Session, error: CodexTransportError): void {
    if (session.failureCause !== null) return
    session.failureCause = error
    session.failure.resolve(error)
    if (session.warm && !session.used && !session.closing) {
      void this.#cleanup(session, true).catch(() => undefined)
    }
  }

  async #removeCredentialHome(): Promise<void> {
    try { await this.#credentials.removeEphemeralHome(this.#config.codexHome) }
    catch {
      this.#credentialCleanupFailure ??= new CodexTransportError('credential_missing')
      throw new CodexTransportError(this.#credentialCleanupFailure.code)
    }
  }

  #trackLateOwnerCleanup(spawnWork: Promise<OwnedCodexProcess>): void {
    const cleanupWork = spawnWork.then(async owner => {
      if (!await this.#cleanupRejectedOwner(owner)) throw new CodexTransportError('transport_lost')
      await this.#removeCredentialHome()
    }, async error => {
      const unconfirmedOwner = takeUnconfirmedCodexProcessOwner(error)
      if (unconfirmedOwner !== null) {
        this.#closed = true
        this.#unconfirmedOwners.add(unconfirmedOwner)
        throw new CodexTransportError('transport_lost')
      }
      await this.#removeCredentialHome()
    })
    const cleanup = cleanupWork.catch(error => {
      this.#lateCleanupFailure ??= safeTransportError(error, 'credential_missing')
      throw this.#lateCleanupFailure
    })
    this.#lateOwnerCleanups.add(cleanup)
    void cleanup.finally(() => { this.#lateOwnerCleanups.delete(cleanup) }).catch(() => undefined)
  }

  async #cleanupRejectedOwner(owner: OwnedCodexProcess): Promise<boolean> {
    const gone = await cleanupRejectedOwner(owner)
    if (gone) {
      this.#unconfirmedOwners.delete(owner)
    } else {
      this.#closed = true
      this.#unconfirmedOwners.add(owner)
    }
    return gone
  }
}

function validateLaunchConfig(config: CodexAppServerLaunchConfig): CodexAppServerLaunchConfig {
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
  return Object.freeze({
    binary: config.binary,
    workspace: config.workspace,
    codexHome: config.codexHome,
    apiKey,
    developerInstructions,
    resumeThreadId,
    persistent: config.persistent,
  })
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

const TRANSPORT_CODES: ReadonlySet<CodexTransportCode> = new Set([
  'completed', 'adapter_timeout', 'binary_missing', 'credential_missing', 'preflight_failed',
  'preflight_timeout', 'sandbox_failed', 'spawn_failed', 'stderr_too_large', 'transport_lost',
  'unsupported_protocol', 'unsupported_version', 'workspace_invalid', 'workspace_root_mismatch',
  'resume_unavailable', 'server_rejected', 'turn_failed', 'missing_terminal', 'nonzero_exit',
  'unexpected_server_request', 'busy',
])

async function settleCleanup(operation: () => Promise<void>, milliseconds: number): Promise<void> {
  await settleCleanupValue(async () => { await operation(); return true }, milliseconds, false)
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

async function cleanupRejectedOwner(owner: OwnedCodexProcess): Promise<boolean> {
  await settleCleanup(() => owner.closeStdin(), CODEX_INTERRUPT_GRACE_MS)
  let gone = await settleCleanupValue(
    () => owner.waitTreeGone(CODEX_TREE_GRACE_MS),
    CODEX_TREE_GRACE_MS + 100,
    false,
  )
  if (!gone) {
    await settleCleanup(() => owner.terminateTree(), CODEX_INTERRUPT_GRACE_MS)
    gone = await settleCleanupValue(
      () => owner.waitTreeGone(CODEX_TREE_GRACE_MS),
      CODEX_TREE_GRACE_MS + 100,
      false,
    )
  }
  if (!gone) {
    await settleCleanup(() => owner.killTree(), CODEX_INTERRUPT_GRACE_MS)
    gone = await settleCleanupValue(
      () => owner.waitTreeGone(CODEX_TREE_GRACE_MS),
      CODEX_TREE_GRACE_MS + 100,
      false,
    )
  }
  await settleCleanupValue(() => owner.exit, CODEX_TREE_GRACE_MS, null)
  await settleCleanup(() => owner.dispose(), CODEX_TREE_GRACE_MS)
  return gone
}
