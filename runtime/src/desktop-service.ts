/** Production ownership for one realtime graph and one authenticated desktop transport. */

import {
  DesktopRealtime,
  type DesktopRealtimeOptions,
  type DesktopServerTransport,
} from './desktop-realtime.js'
import {
  parseReadyEndpoint,
  validateDesktopToken,
  type DesktopReadiness,
} from './desktop.js'
import {deliveryToEvent} from './desktop-wire.js'
import type {PlaybackCompletion, PlaybackFrame} from './playback.js'
import type {RealtimeAssembly} from './realtime-assembly.js'
import {memoryBoardMessage} from './realtime/memory-board.js'
import type {ProjectConfirmationView} from './realtime/project-confirmation.js'
import type {CaptionFrame} from './realtime/session-state.js'
import type {CodexState} from './realtime/service-state.js'
import type {RealtimeTelemetry} from './realtime/telemetry.js'

export const DESKTOP_OWNER_SHUTDOWN_GRACE_MS = 1_000

export interface DesktopRealtimeOwner {
  readonly service: {waitStopped(): Promise<void>}
  start(): Promise<void>
  stop(): Promise<void>
}

export interface DesktopRealtimeTransportOwner {
  readonly server: Pick<DesktopServerTransport, 'start' | 'close'>
}

export interface DesktopOutputCallbacks {
  readonly onAudioFrame: (frame: PlaybackFrame) => void
  readonly onAudioClear: (utteranceId: string, generationEpoch: number) => void
  readonly onAudioAlert: (utteranceId: string | null, generationEpoch: number | null) => void
  readonly onAudioTerminal: (utteranceId: string, generationEpoch: number) => void
  readonly onDelivery: (completion: PlaybackCompletion) => void
  readonly onCaption: (frame: CaptionFrame) => void
  readonly onCodexState: (state: CodexState) => void
  readonly onProjectView: (view: ProjectConfirmationView) => void
}

export interface BuildDesktopRealtimeCompositionOptions {
  readonly token: string
  readonly stop: AbortController
  readonly buildRealtime: (callbacks: DesktopOutputCallbacks) => RealtimeAssembly
  readonly telemetry?: RealtimeTelemetry
  readonly projectView?: ProjectConfirmationView
  readonly createServer?: DesktopRealtimeOptions['createServer']
}

export interface DesktopRealtimeComposition {
  readonly realtime: RealtimeAssembly
  readonly desktop: DesktopRealtime
}

/** Build the circular desktop callback graph without exposing a half-built bridge. */
export function buildDesktopRealtimeComposition(
  options: BuildDesktopRealtimeCompositionOptions,
): DesktopRealtimeComposition {
  validateDesktopToken(options.token)
  const holder: {desktop?: DesktopRealtime} = {}
  const requireDesktop = (): DesktopRealtime => {
    if (holder.desktop === undefined) {
      throw new Error('desktop realtime bridge is unavailable during construction')
    }
    return holder.desktop
  }
  const realtime = options.buildRealtime({
    onAudioFrame: frame => requireDesktop().bridge.onAudioFrame(frame),
    onAudioClear: (utteranceId, generationEpoch) => {
      requireDesktop().bridge.onAudioClear(utteranceId, generationEpoch)
    },
    onAudioAlert: (utteranceId, generationEpoch) => {
      requireDesktop().bridge.onAudioAlert(utteranceId, generationEpoch)
    },
    onAudioTerminal: (utteranceId, generationEpoch) => {
      requireDesktop().bridge.onAudioTerminal(utteranceId, generationEpoch)
    },
    onDelivery: completion => {
      const payload = deliveryToEvent(completion)
      if (payload !== null) realtime.runtime.post({kind: 'assistant_spoken', payload})
    },
    onCaption: frame => requireDesktop().bridge.onCaption(frame),
    onCodexState: state => requireDesktop().bridge.onCodexState(state),
    onProjectView: view => requireDesktop().bridge.onCodexProject(view),
  })
  const desktop = new DesktopRealtime({
    token: options.token,
    service: realtime.service,
    stop: options.stop,
    memoryBoard: requestId => memoryBoardMessage(requestId, realtime.runtime.memory),
    clock: realtime.runtime.clock,
    ...(options.telemetry === undefined ? {} : {telemetry: options.telemetry}),
    ...(options.projectView === undefined ? {} : {projectView: options.projectView}),
    ...(options.createServer === undefined ? {} : {createServer: options.createServer}),
  })
  holder.desktop = desktop
  return {realtime, desktop}
}

export interface RealtimeDesktopServiceOptions {
  readonly realtime: DesktopRealtimeOwner
  readonly desktop: DesktopRealtimeTransportOwner
  readonly readyEndpoint: string
  readonly stop: AbortController
  readonly announce: (
    endpoint: string,
    readiness: DesktopReadiness,
    signal: AbortSignal,
  ) => Promise<void>
  readonly closeAuxiliary?: () => void | Promise<void>
  readonly cleanupGraceMs?: number
  readonly onDiagnostic?: (line: string) => void
}

type CleanupResult =
  | {readonly kind: 'resolved'}
  | {readonly kind: 'rejected'; readonly error: unknown}
  | {readonly kind: 'abandoned'}

interface CleanupOutcome {readonly firstFailure: {readonly error: unknown} | null}

type TerminalCause =
  | {readonly kind: 'external'; readonly error: null}
  | {readonly kind: 'service'; readonly error: {readonly value: unknown} | null}

interface TerminalMonitor {
  readonly promise: Promise<TerminalCause>
  readonly current: () => TerminalCause | undefined
}

type PhaseResult<T> =
  | {readonly kind: 'resolved'; readonly value: T}
  | {readonly kind: 'rejected'; readonly error: unknown}
  | {readonly kind: 'terminal'; readonly cause: TerminalCause}

/** One idempotent lifecycle owner around the already-constructed realtime and socket graphs. */
export class RealtimeDesktopService {
  readonly #realtime: DesktopRealtimeOwner
  readonly #desktop: DesktopRealtimeTransportOwner
  readonly #readyEndpoint: string
  readonly #stop: AbortController
  readonly #announce: (
    endpoint: string,
    readiness: DesktopReadiness,
    signal: AbortSignal,
  ) => Promise<void>
  readonly #closeAuxiliary: () => void | Promise<void>
  readonly #cleanupGraceMs: number
  readonly #onDiagnostic: (line: string) => void
  #runOperation: Promise<void> | null = null
  #cleanupOperation: Promise<CleanupOutcome> | null = null

  constructor(options: RealtimeDesktopServiceOptions) {
    const grace = options.cleanupGraceMs ?? DESKTOP_OWNER_SHUTDOWN_GRACE_MS
    if (!Number.isFinite(grace) || grace <= 0) {
      throw new TypeError('desktop cleanup grace must be positive and finite')
    }
    this.#realtime = options.realtime
    this.#desktop = options.desktop
    this.#readyEndpoint = options.readyEndpoint
    this.#stop = options.stop
    this.#announce = options.announce
    this.#closeAuxiliary = options.closeAuxiliary ?? noop
    this.#cleanupGraceMs = grace
    this.#onDiagnostic = options.onDiagnostic ?? noopDiagnostic
  }

  run(): Promise<void> {
    if (this.#runOperation !== null) return this.#runOperation
    const operation = this.#runFresh()
    this.#runOperation = operation
    return operation
  }

  async stop(): Promise<void> {
    this.#stop.abort()
    const outcome = await this.#ensureCleanup()
    if (outcome.firstFailure !== null) throw outcome.firstFailure.error
  }

  async #runFresh(): Promise<void> {
    let primaryFailure: {readonly error: unknown} | null = null
    try {
      const external = this.#externalStopMonitor()
      if (!this.#stop.signal.aborted) {
        const start = await this.#runPhase(
          this.#realtime.start(),
          external.promise,
          'desktop_realtime_start_abandoned',
        )
        if (start.kind === 'rejected') primaryFailure = {error: start.error}
        if (start.kind === 'terminal') return await this.#finish(start.cause)
      }
      if (primaryFailure === null && !this.#stop.signal.aborted) {
        const terminal = this.#armTerminalMonitor(external)
        // Promise callbacks for an already-settled waitStopped run before this continuation. This
        // fence is what keeps a dead service from briefly advertising a live desktop listener.
        await Promise.resolve()
        const early = terminal.current()
        if (early !== undefined) return await this.#finish(early)

        const listener = await this.#runPhase(
          this.#desktop.server.start(),
          terminal.promise,
          'desktop_server_start_abandoned',
        )
        if (listener.kind === 'rejected') primaryFailure = {error: listener.error}
        if (listener.kind === 'terminal') return await this.#finish(listener.cause)
        if (listener.kind === 'resolved') {
          const announcement = await this.#runPhase(
            this.#announce(this.#readyEndpoint, listener.value, this.#stop.signal),
            terminal.promise,
            'desktop_readiness_announcement_abandoned',
          )
          if (announcement.kind === 'rejected') primaryFailure = {error: announcement.error}
          if (announcement.kind === 'terminal') return await this.#finish(announcement.cause)
        }
        if (primaryFailure === null) return await this.#finish(await terminal.promise)
      }
    } catch (error) {
      primaryFailure = {error}
    }
    this.#stop.abort()
    const cleanup = await this.#ensureCleanup()
    if (primaryFailure !== null) throw primaryFailure.error
    if (cleanup.firstFailure !== null) throw cleanup.firstFailure.error
  }

  #externalStopMonitor(): TerminalMonitor {
    let current: TerminalCause | undefined
    const promise = new Promise<TerminalCause>(resolve => {
      if (this.#stop.signal.aborted) {
        current = {kind: 'external', error: null}
        resolve(current)
        return
      }
      const onAbort = (): void => {
        current = {kind: 'external', error: null}
        resolve(current)
      }
      this.#stop.signal.addEventListener('abort', onAbort, {once: true})
    })
    return {promise, current: () => current}
  }

  #armTerminalMonitor(external: TerminalMonitor): TerminalMonitor {
    let current = external.current()
    const remember = (cause: TerminalCause): TerminalCause => {
      current ??= cause
      return cause
    }
    let service: Promise<TerminalCause>
    try {
      service = this.#realtime.service.waitStopped().then<TerminalCause, TerminalCause>(
        () => remember({kind: 'service', error: null}),
        (error: unknown) => remember({kind: 'service', error: {value: error}}),
      )
    } catch (error) {
      service = Promise.resolve(remember({kind: 'service', error: {value: error}}))
    }
    const promise = Promise.race([external.promise, service]).then(cause => {
      current = cause
      this.#stop.abort()
      void this.#ensureCleanup()
      return cause
    })
    return {promise, current: () => current}
  }

  async #runPhase<T>(
    work: Promise<T>,
    terminal: Promise<TerminalCause>,
    abandonedDiagnostic: string,
  ): Promise<PhaseResult<T>> {
    const outcome: Promise<PhaseResult<T>> = work.then(
      value => ({kind: 'resolved', value}),
      (error: unknown) => ({kind: 'rejected', error}),
    )
    const raced = await Promise.race([
      outcome,
      terminal.then(cause => ({kind: 'terminal' as const, cause})),
    ])
    if (raced.kind !== 'terminal') return raced
    await this.#settlePhaseWithinGrace(outcome, abandonedDiagnostic)
    return raced
  }

  async #settlePhaseWithinGrace<T>(
    outcome: Promise<PhaseResult<T>>,
    diagnostic: string,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'abandoned'>(resolve => {
      timer = setTimeout(() => resolve('abandoned'), this.#cleanupGraceMs)
    })
    const result = await Promise.race([outcome.then(() => 'settled' as const), deadline])
    if (timer !== undefined) clearTimeout(timer)
    if (result === 'abandoned') this.#emitDiagnostic(diagnostic)
  }

  async #finish(cause: TerminalCause): Promise<void> {
    const cleanup = await this.#ensureCleanup()
    if (cause.kind === 'service' && cause.error !== null) throw cause.error.value
    if (cleanup.firstFailure !== null) throw cleanup.firstFailure.error
  }

  #ensureCleanup(): Promise<CleanupOutcome> {
    if (this.#cleanupOperation !== null) return this.#cleanupOperation
    this.#cleanupOperation = this.#cleanup()
    return this.#cleanupOperation
  }

  async #cleanup(): Promise<CleanupOutcome> {
    let firstFailure: {readonly error: unknown} | null = null
    const server = await this.#cleanupWithinGrace(
      () => this.#desktop.server.close(),
      'desktop_server_close_abandoned',
    )
    if (server.kind === 'rejected') firstFailure = {error: server.error}

    const realtime = await settleCleanup(() => this.#realtime.stop())
    if (firstFailure === null && realtime.kind === 'rejected') {
      firstFailure = {error: realtime.error}
    }

    const auxiliary = await this.#cleanupWithinGrace(
      () => this.#closeAuxiliary(),
      'desktop_auxiliary_close_abandoned',
    )
    if (firstFailure === null && auxiliary.kind === 'rejected') {
      firstFailure = {error: auxiliary.error}
    }
    return {firstFailure}
  }

  async #cleanupWithinGrace(
    cleanup: () => void | Promise<void>,
    diagnostic: string,
  ): Promise<CleanupResult> {
    const settled = settleCleanup(cleanup)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<CleanupResult>(resolve => {
      timer = setTimeout(() => resolve({kind: 'abandoned'}), this.#cleanupGraceMs)
    })
    const result = await Promise.race([settled, deadline])
    if (timer !== undefined) clearTimeout(timer)
    if (result.kind === 'abandoned') {
      this.#emitDiagnostic(diagnostic)
    }
    return result
  }

  #emitDiagnostic(diagnostic: string): void {
    try {
      this.#onDiagnostic(`[runtime-diagnostic] ${diagnostic}`)
    } catch {
      // Diagnostic observers do not own shutdown progress.
    }
  }
}

async function settleCleanup(cleanup: () => void | Promise<void>): Promise<CleanupResult> {
  try {
    await cleanup()
    return {kind: 'resolved'}
  } catch (error) {
    return {kind: 'rejected', error}
  }
}

export interface DesktopEntryConstruction {
  readonly realtime: DesktopRealtimeOwner
  readonly desktop: DesktopRealtimeTransportOwner
  readonly closeAuxiliary?: () => void | Promise<void>
}

export interface DesktopEntryOptions {
  readonly token: string
  readonly readyEndpoint: string
  readonly stop: AbortController
  readonly construct: () => DesktopEntryConstruction
  readonly announce: (
    endpoint: string,
    readiness: DesktopReadiness,
    signal: AbortSignal,
  ) => Promise<void>
  readonly onDiagnostic: (line: string) => void
  readonly cleanupGraceMs?: number
}

/** Run the production entry without leaking configuration or dependency errors to stderr. */
export async function runDesktopEntry(options: DesktopEntryOptions): Promise<0 | 2> {
  try {
    validateDesktopToken(options.token)
    parseReadyEndpoint(options.readyEndpoint)
    const constructed = options.construct()
    const owner = new RealtimeDesktopService({
      realtime: constructed.realtime,
      desktop: constructed.desktop,
      readyEndpoint: options.readyEndpoint,
      stop: options.stop,
      announce: options.announce,
      ...(constructed.closeAuxiliary === undefined
        ? {}
        : {closeAuxiliary: constructed.closeAuxiliary}),
      ...(options.cleanupGraceMs === undefined ? {} : {cleanupGraceMs: options.cleanupGraceMs}),
      onDiagnostic: options.onDiagnostic,
    })
    await owner.run()
    return 0
  } catch {
    try {
      options.onDiagnostic('[runtime-diagnostic] assembly_failed')
    } catch {
      // A diagnostic sink must not convert a bounded entry failure into an unhandled rejection.
    }
    return 2
  }
}

export interface DesktopStopEventSource {
  once(event: string, listener: (...args: unknown[]) => void): unknown
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off?(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface DesktopStopInputSource extends DesktopStopEventSource {
  resume(): unknown
  pause?(): unknown
}

export interface DesktopStopParentSource extends DesktopStopEventSource {
  start?(): void
}

export interface DesktopStopSources {
  readonly processEvents: DesktopStopEventSource
  readonly stdin: DesktopStopInputSource
  readonly parentPort?: DesktopStopParentSource
}

export interface DesktopStopSourceBinding {
  dispose(): void
}

/** Bind every host termination path to one abort owner and make the bindings explicitly releasable. */
export function installDesktopStopSources(
  options: DesktopStopSources & {readonly stop: AbortController},
): DesktopStopSourceBinding {
  const removers: (() => void)[] = []
  let resumedStdin = false
  let disposed = false
  const requestStop = (): void => options.stop.abort()
  const bind = (
    source: DesktopStopEventSource,
    method: 'on' | 'once',
    event: string,
    listener: (...args: unknown[]) => void,
  ): void => {
    source[method](event, listener)
    removers.push(() => removeEventListener(source, event, listener))
  }

  bind(options.processEvents, 'once', 'SIGINT', requestStop)
  bind(options.processEvents, 'once', 'SIGTERM', requestStop)
  if (options.parentPort === undefined) {
    bind(options.processEvents, 'once', 'disconnect', requestStop)
    bind(options.stdin, 'once', 'end', requestStop)
    options.stdin.resume()
    resumedStdin = true
  } else {
    const onMessage = (event: unknown): void => {
      if (isDesktopShutdownMessage(event)) requestStop()
    }
    bind(options.parentPort, 'on', 'message', onMessage)
    bind(options.parentPort, 'once', 'close', requestStop)
    options.parentPort.start?.()
  }

  return {
    dispose: (): void => {
      if (disposed) return
      disposed = true
      for (const remove of removers.splice(0).reverse()) remove()
      if (resumedStdin) options.stdin.pause?.()
    },
  }
}

/** Entry wrapper that cannot leave a resumed stdin or process listener behind after any exit. */
export async function runDesktopEntryWithStopSources(
  options: DesktopEntryOptions,
  sources: DesktopStopSources,
): Promise<0 | 2> {
  const binding = installDesktopStopSources({...sources, stop: options.stop})
  try {
    return await runDesktopEntry(options)
  } finally {
    binding.dispose()
  }
}

/** Accept both Electron MessageEvent wrappers and utility-process direct payloads. */
export function isDesktopShutdownMessage(event: unknown): boolean {
  const message = isObject(event) && 'data' in event ? event.data : event
  return isObject(message) && message.type === 'nova.shutdown'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function removeEventListener(
  source: DesktopStopEventSource,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  if (source.off !== undefined) source.off(event, listener)
  else source.removeListener?.(event, listener)
}

function noop(): void {
  // Default auxiliary cleanup and settled-signal disposer.
}

function noopDiagnostic(_line: string): void {
  void _line
}
