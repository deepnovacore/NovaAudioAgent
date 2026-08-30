/**
 * One-client transport adapter around an already-built `RealtimeService`.
 *
 * Ported from `DesktopSocketBridge` in `src/nova_audio_agent/realtime/desktop.py`. The renderer is one
 * websocket and the runtime is a state machine, and everything here is about the mismatch between
 * them: a socket that can block, a queue that can fill, and audio that becomes wrong the instant the
 * agent is interrupted.
 *
 * Four outbound queues rather than one, because they have different urgency and different
 * overflow rules. Playback *clears* must overtake the audio they cancel -- a clear that queued behind
 * two seconds of stale PCM is two seconds of the user hearing something the agent has already
 * abandoned. Codex state and the project view are single-slot: only the latest matters, and a backlog
 * of stale states is worse than none.
 *
 * Overflow is not uniform either. A dropped caption is a cosmetic loss, so captions are droppable. A
 * dropped audio frame or control message means the renderer's picture of playback is now wrong in a
 * way it cannot detect, so the transport is stopped instead of quietly continuing.
 */

import {
  DesktopProtocolError,
  captionMessage,
  codexProjectMessage,
  codexStateMessage,
  decodeAudioFrame,
  encodeAudioFrame,
  playbackAlertMessage,
  playbackClearMessage,
  playbackTerminalMessage,
  parseJsonWithIntegerFields,
  validateInputPcm,
  type PublicProjectView,
} from './desktop-wire.js'
import type { Clock } from './clock.js'
import {
  connectionDiagnosticSchema,
  playbackTelemetrySchema,
  type DesktopControl,
} from './desktop.js'
import type { PlaybackFrame } from './playback.js'
import type { CaptionFrame } from './realtime/session-state.js'
import type { CodexState } from './realtime/service-state.js'
import type { RealtimeTelemetry } from './realtime/telemetry.js'
import type {MemoryBoardDetail} from './realtime/memory-board.js'
import {codePointLengthLikePython, stripLikePython} from './python-text.js'
import {
  hasUnpairedSurrogate,
  workspaceGraphBoardMessage,
} from './realtime/workspace-graph-board.js'

export const DEFAULT_MAX_OUTBOUND_FRAMES = 128

/** What a parsed renderer control frame carries. */
export interface DesktopCommand {
  readonly kind:
    | 'authenticated'
    | 'speech_onset'
    | 'playback_started'
    | 'playback_stopped'
    | 'playback_done'
    | 'playback_cleared'
    | 'memory_board_request'
    | 'workspace_graph_board_request'
    | 'project_confirmation_decision'
    | 'playback_telemetry'
    | 'playback_telemetry_rejected'
    | 'clock_pong'
    | 'connection_diagnostic'
  readonly payload: Readonly<Record<string, string | number | boolean>>
}

/** The service surface the bridge drives. Narrow: six calls and one read. */
export interface BridgeService {
  readonly codexState: CodexState
  sendAudio(pcm: Uint8Array): Promise<void>
  localSpeechOnset(speechId: string): Promise<void>
  playbackStarted(utteranceId: string, generationEpoch: number): boolean
  playbackDone(utteranceId: string, generationEpoch: number, playedMs: number | null): boolean
  playbackStopped(
    utteranceId: string,
    generationEpoch: number,
    playedMs: number | null,
  ): Promise<boolean>
  playbackDisconnected(): Promise<boolean>
  playbackCleared(utteranceId: string, generationEpoch: number, playedMs: number | null): boolean
  projectConfirmationDecision(proposalId: string, confirmed: boolean): Promise<void>
}

export interface DesktopBridgeOptions {
  readonly token: string
  readonly service: BridgeService
  /** Set to tear the transport down. Overflow of a non-droppable frame trips it. */
  readonly stop: {abort(): void}
  readonly maxOutboundFrames?: number
  readonly memoryBoard?: (requestId: string, detail?: MemoryBoardDetail) => string
  readonly workspaceGraphBoard?: (requestId: string) => string
  readonly clock?: Clock
  readonly telemetry?: RealtimeTelemetry
  readonly projectView?: PublicProjectView
  /** Wake the composition-owned sender after, and only after, work becomes available. */
  readonly onOutboundAvailable?: () => void
}

/** An outbound frame: text for control and captions, bytes for audio. */
export type OutboundFrame = string | Uint8Array

export type DesktopDeliveryPolicy = 'required' | 'droppable' | 'latest'

export interface DesktopDelivery {
  readonly frame: OutboundFrame
  readonly policy: DesktopDeliveryPolicy
}

export class DesktopSocketBridge {
  readonly #token: string
  readonly #service: BridgeService
  readonly #stop: {abort(): void}
  readonly #maxOutboundFrames: number
  readonly #memoryBoard: ((requestId: string) => string) | undefined
  readonly #workspaceGraphBoard: ((requestId: string) => string) | undefined
  readonly #clock: Clock | undefined
  readonly #telemetry: RealtimeTelemetry | undefined
  readonly #onOutboundAvailable: (() => void) | undefined

  /** Audio, captions, terminals. Bounded; a non-droppable overflow stops the transport. */
  readonly #outbound: DesktopDelivery[] = []
  /** Clears and alerts. Drained before `#outbound` so a clear overtakes the audio it cancels. */
  readonly #preemptOutbound: DesktopDelivery[] = []
  /** Single-slot: only the latest state matters, and a backlog of stale ones is worse than none. */
  #codexOutbound: CodexState | null = null
  #projectOutbound: PublicProjectView | null = null
  #workspaceGraphOutbound: string | null = null

  /**
   * The highest generation the renderer has been told to clear.
   *
   * Anything at or below it is audio for a turn the agent has abandoned. Monotonic, because a clear for
   * an older generation arriving late must not un-fence a newer one.
   */
  #fencedGenerationEpoch = 0
  #latestPlaybackGenerationEpoch = 0
  #captionSequence = 0
  #latestAssistantCaptionSequence = 0
  /** Assistant captions at or below this belong to a cleared turn. */
  #fencedAssistantCaptionSequence = 0
  #claimed = false
  #authenticated = false
  #everAuthenticated = false
  #codexState: CodexState
  #lastCodexStateSent: CodexState | null = null
  #projectView: PublicProjectView | null
  #lastProjectViewSent: PublicProjectView | null = null
  #uplinkFrames = 0
  #uplinkBytes = 0
  #uplinkFlushedAt: number
  readonly #pingSent = new Map<string, number>()
  #firstFrameSeen: string | null = null
  #playbackTelemetryRejected = 0

  constructor(options: DesktopBridgeOptions) {
    // 128 bits of hex, exactly. A shorter token is a weaker one, and a longer one means the caller is
    // passing something other than what this expects.
    if (options.token.length !== 32 || !/^[0-9a-fA-F]+$/u.test(options.token)) {
      throw new TypeError('desktop token must be 128-bit hexadecimal')
    }
    this.#token = options.token
    this.#service = options.service
    this.#stop = options.stop
    this.#maxOutboundFrames = options.maxOutboundFrames ?? DEFAULT_MAX_OUTBOUND_FRAMES
    this.#memoryBoard = options.memoryBoard
    this.#workspaceGraphBoard = options.workspaceGraphBoard
    this.#clock = options.clock
    // Telemetry needs a clock to be worth anything: every sample it takes is a duration.
    this.#telemetry = options.clock === undefined ? undefined : options.telemetry
    this.#onOutboundAvailable = options.onOutboundAvailable
    this.#codexState = options.service.codexState
    this.#projectView = options.projectView ?? null
    this.#uplinkFlushedAt = options.clock?.now() ?? 0
  }

  // -----------------------------------------------------------------------------------------------
  // Outbound: what the runtime hands the renderer.
  // -----------------------------------------------------------------------------------------------

  onAudioFrame(frame: PlaybackFrame): void {
    this.#latestPlaybackGenerationEpoch = Math.max(
      this.#latestPlaybackGenerationEpoch,
      frame.generation_epoch,
    )
    if (frame.generation_epoch <= this.#fencedGenerationEpoch) return
    const sent = this.#enqueue(encodeAudioFrame(frame))
    if (!sent || this.#telemetry === undefined || frame.sequence !== 0) return
    // First frame of a generation only: the metric is time-to-first-audio, and a re-sent sequence zero
    // for the same generation is the transport retrying rather than a new turn starting.
    const key = `${frame.utterance_id}:${frame.generation_epoch}`
    if (this.#firstFrameSeen === key) return
    this.#firstFrameSeen = key
    this.#telemetry.record('playback.first_frame_enqueued', {
      utterance_id: frame.utterance_id,
      generation_epoch: frame.generation_epoch,
    })
  }

  /**
   * Tell the renderer to drop a generation's audio.
   *
   * Raises the fence before enqueueing, so anything already waiting behind this in the audio queue is
   * recognised as stale when the sender reaches it. Enqueued on the preempt queue, because a clear that
   * waited behind the audio it cancels is not a clear.
   */
  onAudioClear(utteranceId: string, generationEpoch: number): void {
    this.#fencedGenerationEpoch = Math.max(this.#fencedGenerationEpoch, generationEpoch)
    this.#fencedAssistantCaptionSequence = Math.max(
      this.#fencedAssistantCaptionSequence,
      this.#latestAssistantCaptionSequence,
    )
    const sent = this.#enqueuePreempt(playbackClearMessage(utteranceId, generationEpoch))
    if (sent) {
      this.#telemetry?.record('playback.clear_sent', {
        utterance_id: utteranceId,
        generation_epoch: generationEpoch,
      })
    }
  }

  /**
   * Tell the renderer playback stalled.
   *
   * Fences the same way a clear does even when the alert carries no generation: an alert means the
   * agent's audio is not reaching the user, and continuing to send it would be sending sound nobody
   * hears into a turn that has already gone wrong.
   */
  onAudioAlert(utteranceId: string | null, generationEpoch: number | null): void {
    const message = playbackAlertMessage(utteranceId, generationEpoch)
    if (generationEpoch !== null) {
      this.#fencedGenerationEpoch = Math.max(this.#fencedGenerationEpoch, generationEpoch)
    }
    this.#fencedAssistantCaptionSequence = Math.max(
      this.#fencedAssistantCaptionSequence,
      this.#latestAssistantCaptionSequence,
    )
    const sent = this.#enqueuePreempt(message)
    if (sent) {
      this.#telemetry?.record('renderer.alert_tone_sent', {
        generation_qualified: generationEpoch !== null,
      })
    }
  }

  onAudioTerminal(utteranceId: string, generationEpoch: number): void {
    this.#latestPlaybackGenerationEpoch = Math.max(
      this.#latestPlaybackGenerationEpoch,
      generationEpoch,
    )
    this.#enqueue(playbackTerminalMessage(utteranceId, generationEpoch))
  }

  /**
   * The Codex state changed.
   *
   * Validated eagerly so a bad state is a caller error here rather than a malformed frame later. An
   * in-flight send is cancelled: the renderer wants the *current* state, and finishing a send of the
   * previous one first would show something already untrue.
   */
  onCodexState(state: CodexState): void {
    codexStateMessage(state)
    if (state === this.#codexState) return
    this.#codexState = state
    this.#syncCodexStateDelivery()
  }

  onCodexProject(view: PublicProjectView): void {
    codexProjectMessage(view)
    if (sameProjectView(view, this.#projectView)) return
    this.#projectView = view
    this.#syncProjectDelivery()
  }

  /**
   * Transcript text, speculative or final.
   *
   * Droppable, and the only thing here that is: a lost caption is a cosmetic gap, while a lost audio
   * frame leaves the renderer's playback state wrong in a way it cannot detect.
   */
  onCaption(frame: CaptionFrame): void {
    this.#captionSequence += 1
    if (frame.role === 'assistant') {
      this.#latestAssistantCaptionSequence = this.#captionSequence
    }
    this.#enqueue(captionMessage(frame, this.#captionSequence), {droppable: true})
  }

  // -----------------------------------------------------------------------------------------------
  // Connection ownership.
  // -----------------------------------------------------------------------------------------------

  /** One renderer at a time. A second connection is refused rather than replacing the first. */
  claim(): boolean {
    if (this.#claimed) return false
    this.#claimed = true
    return true
  }

  release(): void {
    this.#claimed = false
    this.#authenticated = false
    this.#fencedGenerationEpoch = Math.max(
      this.#fencedGenerationEpoch,
      this.#latestPlaybackGenerationEpoch,
    )
    this.#outbound.length = 0
    this.#preemptOutbound.length = 0
    this.#pingSent.clear()
    this.#firstFrameSeen = null
    this.#fencePlaybackForConnectionBoundary()
    // The next renderer has been told nothing, so both latches reset -- otherwise it would never
    // receive the current state, having "already been sent" it.
    this.#lastCodexStateSent = null
    this.#lastProjectViewSent = null
    this.#codexOutbound = null
    this.#projectOutbound = null
    this.#workspaceGraphOutbound = null
  }

  /** Mark the connection authenticated, which is what unblocks the single-slot queues. */
  markAuthenticated(): void {
    if (this.#everAuthenticated) this.#fencePlaybackForConnectionBoundary()
    this.#authenticated = true
    this.#everAuthenticated = true
    this.#syncCodexStateDelivery()
    this.#syncProjectDelivery()
  }

  #fencePlaybackForConnectionBoundary(): void {
    void this.#service.playbackDisconnected().catch(() => {
      this.#telemetry?.record('desktop.playback_disconnect_failed', {})
    })
  }

  // -----------------------------------------------------------------------------------------------
  // Inbound: what the renderer tells the runtime.
  // -----------------------------------------------------------------------------------------------

  /**
   * Handle one frame from the renderer.
   *
   * Binary is microphone PCM and text is control. Before authentication only one text frame is
   * accepted, and only if it authenticates -- so nothing reaches the runtime on an unproven connection.
   */
  async receive(raw: OutboundFrame, options: {readonly authenticated: boolean}): Promise<boolean> {
    if (!options.authenticated) {
      if (typeof raw !== 'string') {
        throw new DesktopProtocolError('desktop authentication frame must be text')
      }
      parseClientMessage(raw, {expectedToken: this.#token, authenticated: false})
      return true
    }
    if (typeof raw !== 'string') {
      await this.receiveAudio(raw)
      return true
    }
    const command = parseClientMessage(raw, {expectedToken: this.#token, authenticated: true})
    await this.#receiveCommand(command)
    return true
  }

  async receiveAudio(raw: Uint8Array): Promise<void> {
    this.#recordUplink(raw.length)
    await this.#service.sendAudio(validateInputPcm(raw))
  }

  async receiveControl(control: DesktopControl): Promise<void> {
    await this.#receiveCommand(commandFromControl(control))
  }

  async #receiveCommand(command: DesktopCommand): Promise<void> {
    if (
      this.#telemetry !== undefined
      && command.kind !== 'memory_board_request'
      && command.kind !== 'workspace_graph_board_request'
      && command.kind !== 'playback_telemetry'
      && command.kind !== 'playback_telemetry_rejected'
      && command.kind !== 'connection_diagnostic'
    ) {
      this.#telemetry.record('renderer.ack', {kind: command.kind, ...command.payload})
    }
    switch (command.kind) {
      case 'connection_diagnostic': {
        const {phase, ...payload} = command.payload
        const kind = phase === 'closed'
          ? 'desktop.connection_closed'
          : phase === 'reconnect_attempt'
            ? 'desktop.reconnect_attempt'
            : 'desktop.reconnect_result'
        this.#telemetry?.record(kind, payload)
        return
      }
      case 'playback_telemetry_rejected':
        this.#playbackTelemetryRejected += 1
        this.#telemetry?.record('playback.telemetry_rejected', {
          count: this.#playbackTelemetryRejected,
        })
        return
      case 'playback_telemetry':
        this.#telemetry?.record('playback.native', command.payload)
        return
      case 'clock_pong':
        this.#recordSyncSample(
          String(command.payload.ping_id),
          Number(command.payload.t_render_ms),
        )
        return
      case 'speech_onset':
        await this.#service.localSpeechOnset(String(command.payload.speech_id))
        return
      case 'playback_started':
        this.#service.playbackStarted(
          String(command.payload.utterance_id),
          Number(command.payload.generation_epoch),
        )
        return
      case 'playback_done':
        this.#service.playbackDone(
          String(command.payload.utterance_id),
          Number(command.payload.generation_epoch),
          optionalPlayedMs(command.payload),
        )
        return
      case 'playback_stopped':
        await this.#service.playbackStopped(
          String(command.payload.utterance_id),
          Number(command.payload.generation_epoch),
          optionalPlayedMs(command.payload),
        )
        return
      case 'playback_cleared':
        this.#service.playbackCleared(
          String(command.payload.utterance_id),
          Number(command.payload.generation_epoch),
          optionalPlayedMs(command.payload),
        )
        return
      case 'memory_board_request':
        if (this.#memoryBoard !== undefined) {
          // Droppable: a board the renderer asked for and did not get is a refresh it can ask for
          // again, unlike playback state it cannot reconstruct.
          this.#enqueue(this.#memoryBoard(String(command.payload.request_id)), {droppable: true})
        }
        return
      case 'workspace_graph_board_request': {
        const requestId = String(command.payload.request_id)
        try {
          this.#workspaceGraphOutbound = this.#workspaceGraphBoard?.(requestId)
            ?? workspaceGraphBoardMessage(requestId, null, 'disabled')
        } catch {
          this.#workspaceGraphOutbound = workspaceGraphBoardMessage(requestId, null, 'degraded')
        }
        this.#onOutboundAvailable?.()
        return
      }
      case 'project_confirmation_decision': {
        const proposalId = command.payload.proposal_id
        if (typeof proposalId !== 'string') return
        await this.#service.projectConfirmationDecision(
          proposalId,
          command.payload.confirmed === true,
        )
        return
      }
      default:
        return
    }
  }

  // -----------------------------------------------------------------------------------------------
  // The send side.
  // -----------------------------------------------------------------------------------------------

  /**
   * Take the next frame the renderer should receive, in priority order.
   *
   * Preempt before audio, then the two single-slot queues. Audio at or below the fence is dropped here
   * rather than at enqueue time, because the fence can rise *after* a frame is queued -- which is the
   * common case, since a clear is exactly what raises it.
   */
  takeNextFrame(): OutboundFrame | null {
    return this.takeNextDelivery()?.frame ?? null
  }

  /** Take the next frame together with the failure policy the sender must apply. */
  takeNextDelivery(): DesktopDelivery | null {
    const preempt = this.#preemptOutbound.shift()
    if (preempt !== undefined) return preempt
    for (;;) {
      const delivery = this.#outbound.shift()
      if (delivery === undefined) break
      if (!this.#isFencedPlaybackMessage(delivery.frame)) return delivery
    }
    if (this.#codexOutbound !== null) {
      const state = this.#codexOutbound
      this.#codexOutbound = null
      if (state !== this.#lastCodexStateSent) {
        this.#lastCodexStateSent = state
        this.#syncCodexStateDelivery()
        return {frame: codexStateMessage(state), policy: 'latest'}
      }
    }
    if (this.#projectOutbound !== null) {
      const view = this.#projectOutbound
      this.#projectOutbound = null
      if (!sameProjectView(view, this.#lastProjectViewSent)) {
        this.#lastProjectViewSent = view
        this.#syncProjectDelivery()
        return {frame: codexProjectMessage(view), policy: 'latest'}
      }
    }
    if (this.#workspaceGraphOutbound !== null) {
      const frame = this.#workspaceGraphOutbound
      this.#workspaceGraphOutbound = null
      return {frame, policy: 'latest'}
    }
    return null
  }

  /**
   * Whether this frame belongs to a turn the renderer has been told to drop.
   *
   * Cheap prefix test first: only two message shapes can be fenced, and parsing every caption to find
   * out would be work on the hot path. Audio is checked by decoding its header, which is the only place
   * its generation is written.
   */
  #isFencedPlaybackMessage(value: OutboundFrame): boolean {
    if (typeof value !== 'string') {
      return decodeAudioFrame(value).generation_epoch <= this.#fencedGenerationEpoch
    }
    if (
      !value.startsWith('{"type":"caption"')
      && !value.startsWith('{"type":"playback.terminal"')
    ) {
      return false
    }
    let payload: unknown
    try {
      payload = JSON.parse(value)
    } catch {
      return false
    }
    if (!isPlainObject(payload)) return false
    if (payload.type === 'caption') {
      const sequence = payload.sequence
      // Only the assistant's: a user caption describes what the *user* said, which a fence about the
      // agent's audio says nothing about.
      return payload.role === 'assistant'
        && typeof sequence === 'number'
        && Number.isInteger(sequence)
        && sequence <= this.#fencedAssistantCaptionSequence
    }
    if (payload.type !== 'playback.terminal') return false
    const generationEpoch = payload.generation_epoch
    return typeof generationEpoch === 'number'
      && Number.isInteger(generationEpoch)
      && generationEpoch <= this.#fencedGenerationEpoch
  }

  #enqueue(value: OutboundFrame, options: {readonly droppable?: boolean} = {}): boolean {
    if (this.#everAuthenticated && !this.#authenticated) return false
    if (this.#outbound.length >= this.#maxOutboundFrames) {
      // A dropped non-droppable frame leaves the renderer's picture of playback wrong in a way it
      // cannot detect, so the transport stops rather than continuing to look healthy.
      if (options.droppable !== true) this.#stop.abort()
      return false
    }
    this.#outbound.push({frame: value, policy: options.droppable === true ? 'droppable' : 'required'})
    this.#onOutboundAvailable?.()
    return true
  }

  #enqueuePreempt(value: string): boolean {
    if (this.#everAuthenticated && !this.#authenticated) return false
    if (this.#preemptOutbound.length >= this.#maxOutboundFrames) {
      // Never droppable. A clear that does not arrive means the user keeps hearing an abandoned turn.
      this.#stop.abort()
      return false
    }
    this.#preemptOutbound.push({frame: value, policy: 'required'})
    this.#onOutboundAvailable?.()
    return true
  }

  /** Re-arm the single slot if the renderer's state is still behind. */
  #syncCodexStateDelivery(): void {
    const next = this.#authenticated && this.#codexState !== this.#lastCodexStateSent
      ? this.#codexState
      : null
    if (next === this.#codexOutbound) return
    this.#codexOutbound = next
    if (next !== null) this.#onOutboundAvailable?.()
  }

  #syncProjectDelivery(): void {
    const next = (
      this.#authenticated
      && this.#projectView !== null
      && !sameProjectView(this.#projectView, this.#lastProjectViewSent)
    ) ? this.#projectView : null
    if (sameProjectView(next, this.#projectOutbound)) return
    this.#projectOutbound = next
    if (next !== null) this.#onOutboundAvailable?.()
  }

  // -----------------------------------------------------------------------------------------------
  // Clock synchronisation and uplink accounting.
  // -----------------------------------------------------------------------------------------------

  registerPing(pingId: string): void {
    if (this.#clock !== undefined) this.#pingSent.set(pingId, this.#clock.now())
  }

  /**
   * Arm a round of clock pings.
   *
   * Several rather than one: a single round trip is dominated by whatever the renderer happened to be
   * doing, and the useful figure is the minimum across a handful.
   */
  sendClockPings(count = 5): readonly string[] {
    if (this.#clock === undefined || this.#telemetry === undefined) return []
    const ids: string[] = []
    for (let index = 0; index < count; index += 1) {
      const pingId = `ping-${index}`
      if (this.#enqueue(`{"type":"clock.ping","ping_id":"${pingId}"}`, {droppable: true})) {
        this.registerPing(pingId)
        ids.push(pingId)
      }
    }
    return ids
  }

  #recordSyncSample(pingId: string, renderMs: number): void {
    const sentAt = this.#pingSent.get(pingId)
    if (sentAt === undefined || this.#clock === undefined || this.#telemetry === undefined) return
    this.#pingSent.delete(pingId)
    const roundTrip = Math.max(0, this.#clock.now() - sentAt)
    this.#telemetry.record('renderer.clock_sync', {
      ping_id: pingId,
      round_trip_ms: roundTrip * 1_000,
      t_render_ms: renderMs,
    })
  }

  #recordUplink(size: number): void {
    this.#uplinkFrames += 1
    this.#uplinkBytes += size
  }

  /** Report accumulated uplink volume, once a second at most. */
  flushUplink(): void {
    if (this.#clock === undefined || this.#telemetry === undefined) return
    if (this.#uplinkFrames === 0) return
    const now = this.#clock.now()
    if (now - this.#uplinkFlushedAt < 1) return
    this.#telemetry.record('renderer.uplink', {
      frames: this.#uplinkFrames,
      bytes: this.#uplinkBytes,
      elapsed: now - this.#uplinkFlushedAt,
    })
    this.#uplinkFrames = 0
    this.#uplinkBytes = 0
    this.#uplinkFlushedAt = now
  }

  /** Read-only views, for assertions. */
  get pendingCounts(): {
    readonly outbound: number
    readonly preempt: number
    readonly codex: boolean
    readonly project: boolean
    readonly workspaceGraph: boolean
  } {
    return {
      outbound: this.#outbound.length,
      preempt: this.#preemptOutbound.length,
      codex: this.#codexOutbound !== null,
      project: this.#projectOutbound !== null,
      workspaceGraph: this.#workspaceGraphOutbound !== null,
    }
  }

  get fencedGenerationEpoch(): number {
    return this.#fencedGenerationEpoch
  }
}

/**
 * Parse one renderer control frame.
 *
 * The size bound is checked on the *encoded* bytes before parsing, because a frame's cost is its
 * length and the parse is what this is protecting.
 */
export function parseClientMessage(
  raw: string,
  options: {readonly expectedToken: string; readonly authenticated: boolean},
): DesktopCommand {
  if (new TextEncoder().encode(raw).length > MAX_DESKTOP_JSON_BYTES) {
    throw new DesktopProtocolError('desktop control frame is too large')
  }
  let preliminary: unknown
  try {
    preliminary = JSON.parse(raw) as unknown
  } catch {
    throw new DesktopProtocolError('desktop control frame is invalid JSON')
  }
  if (
    options.authenticated
    && isPlainObject(preliminary)
    && preliminary.type === 'playback.telemetry'
  ) {
    try {
      const telemetryValue = parseJsonWithIntegerFields(raw, [
        'generation_epoch',
        'window_ms',
        'queued_samples',
        'queued_samples_max',
        'underrun_samples',
        'underrun_callbacks',
        'max_consecutive_underrun_samples',
        'render_callbacks',
        'max_callback_us',
        'pcm_near_silence_ms_max',
        'sequence_gaps',
        'rejected_frames',
        'stdin_buffered_bytes_max',
        'stdin_backpressure_count',
      ], () => new DesktopProtocolError('desktop playback telemetry is invalid'))
      const result = playbackTelemetrySchema.safeParse(telemetryValue)
      if (!result.success) return {kind: 'playback_telemetry_rejected', payload: {}}
      const {type, ...payload} = result.data
      void type
      return {kind: 'playback_telemetry', payload}
    } catch {
      return {kind: 'playback_telemetry_rejected', payload: {}}
    }
  }
  let value: unknown
  try {
    // Only the fields the oracle type-checks as `int`. `t_render_ms` is deliberately absent: it accepts
    // an int or a float there and coerces with `float()`, so both spellings are legal input.
    value = parseJsonWithIntegerFields(raw, [
      'generation_epoch',
      'played_ms',
      'window_ms',
      'queued_samples',
      'queued_samples_max',
      'underrun_samples',
      'underrun_callbacks',
      'max_consecutive_underrun_samples',
      'render_callbacks',
      'max_callback_us',
      'pcm_near_silence_ms_max',
      'sequence_gaps',
      'rejected_frames',
      'stdin_buffered_bytes_max',
      'stdin_backpressure_count',
      'close_code',
      'attempt',
      'delay_ms',
    ], field =>
      new DesktopProtocolError(
        field === 'generation_epoch'
          ? 'desktop playback generation is invalid'
          : 'desktop playback played_ms is invalid',
      ))
  } catch (cause) {
    if (cause instanceof DesktopProtocolError) throw cause
    throw new DesktopProtocolError('desktop control frame is invalid JSON')
  }
  if (!isPlainObject(value) || typeof value.type !== 'string') {
    throw new DesktopProtocolError('desktop control frame has no type')
  }
  if (!options.authenticated) {
    const token = value.token
    if (
      value.type !== 'hello'
      || typeof token !== 'string'
      || !constantTimeEqual(token, options.expectedToken)
    ) {
      throw new DesktopProtocolError('desktop authentication failed')
    }
    return {kind: 'authenticated', payload: {}}
  }


  const kind = value.type
  if (kind === 'speech.onset') {
    const payload: Record<string, string | number> = {speech_id: readIdentifier(value, 'speech_id')}
    readRenderTimestamp(value, payload)
    return {kind: 'speech_onset', payload}
  }
  if (
    kind === 'playback.started'
    || kind === 'playback.stopped'
    || kind === 'playback.done'
    || kind === 'playback.cleared'
  ) {
    const utteranceId = readIdentifier(value, 'utterance_id')
    const generationEpoch = value.generation_epoch
    if (
      typeof generationEpoch !== 'number'
      || !Number.isInteger(generationEpoch)
      || generationEpoch < 1
    ) {
      throw new DesktopProtocolError('desktop playback generation is invalid')
    }
    const payload: Record<string, string | number> = {
      utterance_id: utteranceId,
      generation_epoch: generationEpoch,
    }
    // `started` carries no duration: nothing has played yet, so a value there would be a claim about
    // audio the renderer has not delivered.
    if (kind !== 'playback.started') {
      const playedMs = value.played_ms
      if (playedMs !== null && playedMs !== undefined) {
        if (typeof playedMs !== 'number' || !Number.isInteger(playedMs) || playedMs < 0) {
          throw new DesktopProtocolError('desktop playback played_ms is invalid')
        }
        payload.played_ms = playedMs
      }
    }
    readRenderTimestamp(value, payload)
    return {
      kind: kind.replace('.', '_') as DesktopCommand['kind'],
      payload,
    }
  }
  if (kind === 'memory.board.request') {
    return {kind: 'memory_board_request', payload: {request_id: readIdentifier(value, 'request_id')}}
  }
  if (kind === 'workspace_graph.board.request') {
    if (Object.keys(value).sort().join(',') !== 'request_id,type') {
      throw new DesktopProtocolError('desktop control frame type is unsupported')
    }
    const requestId = readIdentifier(value, 'request_id')
    if (hasUnpairedSurrogate(requestId)) {
      throw new DesktopProtocolError('desktop request_id is invalid')
    }
    return {
      kind: 'workspace_graph_board_request',
      payload: {request_id: requestId},
    }
  }
  if (kind === 'project.confirmation_decision') {
    if (Object.keys(value).sort().join(',') !== 'confirmed,proposal_id,type') {
      throw new DesktopProtocolError('desktop control frame type is unsupported')
    }
    if (typeof value.confirmed !== 'boolean') {
      throw new DesktopProtocolError('desktop project confirmation decision is invalid')
    }
    const proposalId = readIdentifier(value, 'proposal_id')
    if (codePointLengthLikePython(proposalId) > 128) {
      throw new DesktopProtocolError('desktop project confirmation decision is invalid')
    }
    return {
      kind: 'project_confirmation_decision',
      payload: {proposal_id: proposalId, confirmed: value.confirmed},
    }
  }
  if (kind === 'clock.pong') {
    const timestamp = value.t_render_ms
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) {
      throw new DesktopProtocolError('desktop t_render_ms is invalid')
    }
    return {
      kind: 'clock_pong',
      payload: {ping_id: readIdentifier(value, 'ping_id'), t_render_ms: timestamp},
    }
  }
  if (kind === 'connection.diagnostic') {
    const result = connectionDiagnosticSchema.safeParse(value)
    if (!result.success) {
      throw new DesktopProtocolError('desktop connection diagnostic is invalid')
    }
    const {type, ...payload} = result.data
    void type
    return {kind: 'connection_diagnostic', payload}
  }
  throw new DesktopProtocolError('desktop control frame type is unsupported')
}

function commandFromControl(control: DesktopControl): DesktopCommand {
  switch (control.type) {
    case 'speech.onset':
      return {
        kind: 'speech_onset',
        payload: withRenderTimestamp({speech_id: control.speech_id}, control.t_render_ms),
      }
    case 'playback.started':
      return {
        kind: 'playback_started',
        payload: withRenderTimestamp({
          utterance_id: control.utterance_id,
          generation_epoch: control.generation_epoch,
        }, control.t_render_ms),
      }
    case 'playback.stopped':
    case 'playback.done':
    case 'playback.cleared': {
      const payload = withRenderTimestamp({
        utterance_id: control.utterance_id,
        generation_epoch: control.generation_epoch,
      }, control.t_render_ms)
      if (control.played_ms !== undefined) payload.played_ms = control.played_ms
      return {kind: control.type.replace('.', '_') as DesktopCommand['kind'], payload}
    }
    case 'memory.board.request':
      return {kind: 'memory_board_request', payload: {request_id: control.request_id}}
    case 'workspace_graph.board.request':
      return {kind: 'workspace_graph_board_request', payload: {request_id: control.request_id}}
    case 'project.confirmation_decision':
      return {
        kind: 'project_confirmation_decision',
        payload: {proposal_id: control.proposal_id, confirmed: control.confirmed},
      }
    case 'clock.pong':
      return {
        kind: 'clock_pong',
        payload: {ping_id: control.ping_id, t_render_ms: control.t_render_ms},
      }
    case 'connection.diagnostic': {
      const {type, ...payload} = control
      void type
      return {kind: 'connection_diagnostic', payload}
    }
    case 'playback.telemetry': {
      const {type, ...payload} = control
      void type
      return {kind: 'playback_telemetry', payload}
    }
    case 'playback.telemetry_rejected':
      return {kind: 'playback_telemetry_rejected', payload: {}}
  }
}

function withRenderTimestamp(
  payload: Record<string, string | number | boolean>,
  timestamp: number | undefined,
): Record<string, string | number | boolean> {
  if (timestamp !== undefined) payload.t_render_ms = timestamp
  return payload
}

const MAX_DESKTOP_JSON_BYTES = 16 * 1_024



function readRenderTimestamp(
  value: Record<string, unknown>,
  payload: Record<string, string | number>,
): void {
  const timestamp = value.t_render_ms
  if (timestamp === undefined || timestamp === null) return
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) {
    throw new DesktopProtocolError('desktop t_render_ms is invalid')
  }
  payload.t_render_ms = timestamp
}

function readIdentifier(value: Record<string, unknown>, field: string): string {
  const candidate = value[field]
  if (
    typeof candidate !== 'string'
    || stripLikePython(candidate) === ''
    || codePointLengthLikePython(candidate) > 256
  ) {
    throw new DesktopProtocolError(`desktop ${field} is invalid`)
  }
  return candidate
}


function optionalPlayedMs(
  payload: Readonly<Record<string, string | number | boolean>>,
): number | null {
  const value = payload.played_ms
  return value === undefined ? null : Number(value)
}

function sameProjectView(
  left: PublicProjectView | null,
  right: PublicProjectView | null,
): boolean {
  if (left === null || right === null) return left === right
  return left.workspace_display_name === right.workspace_display_name
    && left.session_title === right.session_title
    && left.pending_confirmation === right.pending_confirmation
    && left.pending_confirmation_busy === right.pending_confirmation_busy
    && left.pending_confirmation_id === right.pending_confirmation_id
    && (left.pending_action ?? null) === (right.pending_action ?? null)
    && (left.pending_workspace_display_name ?? null)
      === (right.pending_workspace_display_name ?? null)
    && (left.pending_session_title ?? null) === (right.pending_session_title ?? null)
    && (left.pending_expires_in_seconds ?? null) === (right.pending_expires_in_seconds ?? null)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Compare two strings without leaking their contents through timing.
 *
 * The length is compared first and returns early, which is not a leak: the token's length is fixed and
 * public. What must not leak is *where* a wrong token first differs.
 */
function constantTimeEqual(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < candidate.length; index += 1) {
    difference |= candidate.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return difference === 0
}
