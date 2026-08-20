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
import type {PlaybackFrame} from './playback.js'
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
  readonly announce: (endpoint: string, readiness: DesktopReadiness) => Promise<void>
  readonly closeAuxiliary?: () => void | Promise<void>
  readonly cleanupGraceMs?: number
  readonly onDiagnostic?: (line: string) => void
}

type CleanupResult =
  | {readonly kind: 'resolved'}
  | {readonly kind: 'rejected'; readonly error: unknown}
  | {readonly kind: 'abandoned'}

interface CleanupOutcome {readonly firstFailure: {readonly error: unknown} | null}

/** One idempotent lifecycle owner around the already-constructed realtime and socket graphs. */
export class RealtimeDesktopService {
  readonly #realtime: DesktopRealtimeOwner
  readonly #desktop: DesktopRealtimeTransportOwner
  readonly #readyEndpoint: string
  readonly #stop: AbortController
  readonly #announce: (endpoint: string, readiness: DesktopReadiness) => Promise<void>
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
      if (!this.#stop.signal.aborted) await this.#realtime.start()
      if (!this.#stop.signal.aborted) {
        const readiness = await this.#desktop.server.start()
        if (!this.#stop.signal.aborted) await this.#announce(this.#readyEndpoint, readiness)
      }
      if (!this.#stop.signal.aborted) await this.#waitForTerminalCause()
    } catch (error) {
      primaryFailure = {error}
    }
    const cleanup = await this.#ensureCleanup()
    if (primaryFailure !== null) throw primaryFailure.error
    if (cleanup.firstFailure !== null) throw cleanup.firstFailure.error
  }

  async #waitForTerminalCause(): Promise<void> {
    let removeAbortListener = noop
    const externalStop = new Promise<{readonly kind: 'external'}>(resolve => {
      if (this.#stop.signal.aborted) {
        resolve({kind: 'external'})
        return
      }
      const onAbort = (): void => resolve({kind: 'external'})
      removeAbortListener = () => this.#stop.signal.removeEventListener('abort', onAbort)
      this.#stop.signal.addEventListener('abort', onAbort, {once: true})
    })
    const serviceStop = Promise.resolve()
      .then(() => this.#realtime.service.waitStopped())
      .then(
        () => ({kind: 'service' as const, error: null}),
        (error: unknown) => ({kind: 'service' as const, error: {value: error}}),
      )
    const cause = await Promise.race([externalStop, serviceStop])
    removeAbortListener()
    if (cause.kind === 'service') {
      this.#stop.abort()
      if (cause.error !== null) throw cause.error.value
    }
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
      try {
        this.#onDiagnostic(`[runtime-diagnostic] ${diagnostic}`)
      } catch {
        // Diagnostic observers do not own shutdown progress.
      }
    }
    return result
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
  readonly announce: (endpoint: string, readiness: DesktopReadiness) => Promise<void>
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

/** Accept both Electron MessageEvent wrappers and utility-process direct payloads. */
export function isDesktopShutdownMessage(event: unknown): boolean {
  const message = isObject(event) && 'data' in event ? event.data : event
  return isObject(message) && message.type === 'nova.shutdown'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function noop(): void {
  // Default auxiliary cleanup and settled-signal disposer.
}

function noopDiagnostic(_line: string): void {
  void _line
}
