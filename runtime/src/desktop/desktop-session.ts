import type {PersonalCommandContext} from '../personal-agent/host.js'
import {randomUUID,createHash} from 'node:crypto'
import type {PromptLanguage} from '../realtime/prompt-language.js'
import {
  DesktopTasks,
  executorTasksSchema,
  taskActionResultSchema,
  taskActionSchema,
  type TaskActionStatus,
  openTaskDirectory,
} from './desktop-tasks.js'
import {
  EXECUTOR_RESULT,
  EXECUTOR_RESULTS_RESET,
  DESKTOP_ACTIVITY,
  CLOCK_PING,
  CAPTION,
  PLAYBACK_TERMINAL,
  DesktopProtocolError as DesktopWireProtocolError,
  captionMessage,
  executorApprovalMessage,
  projectStateMessage,
  executorStateMessage,
  type ExecutorIdentity,
  decodeAudioFrame,
  encodeAudioFrame,
  playbackAlertMessage,
  playbackClearMessage,
  playbackTerminalMessage,
  parseJsonWithIntegerFields,
  validateInputPcm,
  type PublicProjectView,
  DESKTOP_READY,
  deliveryToEvent,
} from './desktop-wire.js'
import {type Clock} from '../core/clock.js'
import {
  connectionDiagnosticSchema,
  playbackTelemetrySchema,
  type DesktopControl,
  DesktopOutboundValidationError,
  DesktopPersonalFrameTooLargeError,
  MAX_DESKTOP_PERSONAL_JSON_BYTES,
  DesktopProtocolError,
  NodeDesktopServer,
  type DesktopReadiness,
  type DesktopServerOptions,
  parseReadyEndpoint,
  validateDesktopToken,
  type CameraCaptureRequest,
  type CameraCaptureTransport,
  type CapturedCameraFrame,
} from '../desktop.js'
import {type PlaybackFrame, type PlaybackCompletion} from '../realtime/playback.js'
import {type CaptionFrame} from '../realtime/session-state.js'
import {type ExecutorState} from '../realtime/service-state.js'
import {type ApprovalView as ExecutorApprovalView} from '../core/approval-port.js'
import {type RealtimeTelemetry} from '../realtime/telemetry.js'
import {DictationError, pcmLevel} from '../realtime/dictation.js'
import {codePointLengthLikePython, stripLikePython} from '../text/python-text.js'
import {
  executorProgressSchema,
  executorResultSchema,
  type ExecutorProgress,
  type ExecutorResult,
  type ProgressMode,
  projectExecutorEvent,
  projectExecutorSuggestion,
} from './desktop-progress.js'
import {type CodingTaskPort, executorWithRole} from '../executors/coding-executor.js'
import {type MemoryBoardDetail, type MemoryBoardMessageOptions, memoryBoardMessage} from '../realtime/memory-board.js'
import {type CameraPermissionStatus} from './desktop-camera.js'
import {type RealtimeAssembly} from '../composition/realtime-assembly.js'
import {type ProjectConfirmationView} from '../projects/project-confirmation.js'
import {type Suggestion} from '../core/suggestions.js'

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
    | 'project_confirmation_decision'
    | 'executor_approval_decision'
    | 'playback_telemetry'
    | 'playback_telemetry_rejected'
    | 'clock_pong'
    | 'connection_diagnostic'
  readonly payload: Readonly<Record<string, string | number | boolean>>
}

/** The service surface the bridge drives. Narrow: six calls and one read. */
export interface BridgeService {
  readonly inputCapabilities?: readonly string[]
  setLanguage?(language?: PromptLanguage): Promise<void>

  readonly executorState: ExecutorState
  setCodingProgressNarration?(mode: 'smart' | 'continuous'): void
  discardInputAudio?(): Promise<void>
  transcribeDraft?(pcm: Uint8Array, signal: AbortSignal): Promise<string>
  submitText?(text: string): Promise<void>
  sendAudio(pcm: Uint8Array): Promise<void>
  localSpeechOnset(speechId: string): Promise<void>
  playbackStarted(utteranceId: string, generationEpoch: number): boolean
  playbackDone(utteranceId: string, generationEpoch: number, playedMs: number | null): boolean
  playbackStopped(
    utteranceId: string,
    generationEpoch: number,
    playedMs: number | null,
  ): Promise<boolean>
  playbackDisconnected(options?: {readonly resumeDelivery?: boolean}): Promise<boolean>
  playbackCleared(utteranceId: string, generationEpoch: number, playedMs: number | null): boolean
  projectConfirmationDecision(proposalId: string, confirmed: boolean): Promise<void>
  executorApprovalDecision(approvalId: string, approved: boolean, scope?: 'session'): boolean
}

export interface DesktopBridgeOptions {
  readonly conversationService?:(id:string)=>BridgeService|undefined
  readonly voiceService?:()=>BridgeService|undefined
  readonly sendConversationAudio?: (id:string,pcm:Uint8Array)=>Promise<void>
  readonly submitConversationText?: (id:string,text:string,requestId?:string,sourceTodo?:{id:string;version:number})=>Promise<void>
  readonly validateConversationInput?: (kind:'audio'|'dictation',id:string|undefined)=>void
  readonly token: string
  readonly service: BridgeService
  /** Set to tear the transport down. Overflow of a non-droppable frame trips it. */
  readonly stop: {abort(): void}
  readonly maxOutboundFrames?: number
  readonly clock?: Clock
  readonly telemetry?: RealtimeTelemetry
  readonly projectView?: PublicProjectView
  readonly approvalView?: ExecutorApprovalView
  /** The coding executor whose state and approvals this bridge relays; absent when none is configured. */
  readonly executor?: ExecutorIdentity | null
  readonly progressBubbles?: ProgressMode
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
  readonly #clock: Clock | undefined
  readonly #telemetry: RealtimeTelemetry | undefined
  readonly #onOutboundAvailable: (() => void) | undefined

  /** Audio, captions, terminals. Bounded; a non-droppable overflow stops the transport. */
  readonly #outbound: DesktopDelivery[] = []
  /** Clears and alerts. Drained before `#outbound` so a clear overtakes the audio it cancels. */
  readonly #preemptOutbound: DesktopDelivery[] = []
  /** Single-slot: only the latest state matters, and a backlog of stale ones is worse than none. */
  #executorOutbound: ExecutorState | null = null
  readonly #executor: ExecutorIdentity | null
  #projectOutbound: PublicProjectView | null = null
  #approvalOutbound: ExecutorApprovalView | null = null
  readonly #progressMode: ProgressMode
  readonly #progressSummaries = new Map<string, string>()
  // ponytail: 64 session entries; refuse new tracking when every slot is live.
  readonly #results = new Map<string, {result: ExecutorResult; project?: string; title?: string}>()
  #resultReplay: string[] = []
  readonly tasks: DesktopTasks
  #tasksOutbound: string | null = null

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
  readonly #inputInstanceId = randomUUID()
  readonly #textReceipts = new Map<string,{hash:string;result:Promise<{type:'input.text_result';request_id:string;ok:boolean;error?:string}>}>()
  #draftInput = false
  #dictation: {id: string; conversationId?:string; chunks: Uint8Array[]; size: number; finishing: boolean; controller: AbortController; timer: ReturnType<typeof setTimeout>} | undefined
  #claimed = false
  #authenticated = false
  #everAuthenticated = false
  #executorState: ExecutorState
  #lastExecutorStateSent: ExecutorState | null = null
  #projectView: PublicProjectView | null
  #lastProjectViewSent: PublicProjectView | null = null
  #approvalExecutor: ExecutorIdentity | null
  #approvalView: ExecutorApprovalView | null
  #lastApprovalViewSent: ExecutorApprovalView | null = null
  #uplinkFrames = 0
  #uplinkBytes = 0
  #uplinkFlushedAt: number
  readonly #pingSent = new Map<string, number>()
  #firstFrameSeen: string | null = null
  #playbackTelemetryRejected = 0

  readonly #conversationService:DesktopBridgeOptions['conversationService']
  readonly #voiceService: DesktopBridgeOptions['voiceService']
  #voiceConversation:string|undefined
  readonly #sendConversationAudio: DesktopBridgeOptions['sendConversationAudio']
  readonly #submitConversationText: DesktopBridgeOptions['submitConversationText']
  readonly #validateConversationInput: DesktopBridgeOptions['validateConversationInput']
  constructor(options: DesktopBridgeOptions) {
    this.#conversationService=options.conversationService
    this.#voiceService=options.voiceService
    this.#sendConversationAudio=options.sendConversationAudio
    this.#submitConversationText=options.submitConversationText
    this.#validateConversationInput=options.validateConversationInput
    // 128 bits of hex, exactly. A shorter token is a weaker one, and a longer one means the caller is
    // passing something other than what this expects.
    if (options.token.length !== 32 || !/^[0-9a-fA-F]+$/u.test(options.token)) {
      throw new TypeError('desktop token must be 128-bit hexadecimal')
    }
    this.#token = options.token
    this.#service = options.service
    this.#stop = options.stop
    this.#maxOutboundFrames = options.maxOutboundFrames ?? DEFAULT_MAX_OUTBOUND_FRAMES
    this.#clock = options.clock
    // Telemetry needs a clock to be worth anything: every sample it takes is a duration.
    this.#telemetry = options.clock === undefined ? undefined : options.telemetry
    this.#onOutboundAvailable = options.onOutboundAvailable
    this.#executorState = options.service.executorState
    this.#projectView = options.projectView ?? null
    this.#approvalView = options.approvalView ?? null
    this.#approvalExecutor = options.approvalView?.executorIdentity ?? options.executor ?? null
    this.#progressMode = options.progressBubbles ?? 'milestones'
    this.#executor = options.executor ?? null
    this.tasks = new DesktopTasks(this.#executor?.executor ?? null)
    if (this.#projectView !== null) this.tasks.project(this.#projectView)
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
  onExecutorState(state: ExecutorState): void {
    if (this.#executor !== null) executorStateMessage(state, this.#executor)
    if (state === this.#executorState) return
    this.#executorState = state
    this.#syncExecutorStateDelivery()
  }

  onActivity(idle: boolean): void {
    if (this.#authenticated) this.#enqueue(JSON.stringify({type: DESKTOP_ACTIVITY, idle}), {droppable: true})
  }

  onProjectView(view: PublicProjectView): void {
    projectStateMessage(view)
    if (sameProjectView(view, this.#projectView)) return
    this.#projectView = view
    this.tasks.project(view)
    this.#syncTasks()
    for (const entry of view.roster ?? []) for (const work of entry.running) {
      const retained = this.#results.get(work.work_id)
      if (retained?.result === null) {
        retained.project = entry.name
        retained.title = work.title
      }
    }
    this.#syncProjectDelivery()
  }

  onExecutorApproval(view: ExecutorApprovalView): void {
    const identity = view.executorIdentity ?? (view.pending_approval ? this.#executor : this.#approvalExecutor)
    if (identity !== null) executorApprovalMessage(view, this.#clock?.now() ?? 0, identity)
    this.#approvalExecutor = identity
    if (sameApprovalView(view, this.#approvalView)) return
    this.#telemetry?.record('approval.desktop_view', {
      pending: view.pending_approval,
      approval_id: view.pending_approval_id ?? null,
      connected: this.#authenticated,
      executor_available: this.#executor !== null,
    })
    this.#approvalView = view
    this.#syncApprovalDelivery()
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
    this.#enqueue(captionMessage(frame, this.#captionSequence), {droppable: !frame.final || frame.full_text === undefined})
  }

  onExecutorProgress(input: ExecutorProgress, result?: ExecutorResult): void {
    const frame = executorProgressSchema.parse(input)
    const revision = this.tasks.snapshot().revision
    this.tasks.progress(frame)
    if (this.#projectView !== null) this.tasks.project(this.#projectView)
    if (this.tasks.snapshot().revision !== revision) this.#syncTasks()
    if (result !== undefined) {
      const parsed = executorResultSchema.parse({type: EXECUTOR_RESULT, work_id: frame.delegate_id, result})
      const previous = this.#results.get(frame.delegate_id)
      const project = this.#projectView?.roster?.find(entry => entry.running.some(work => work.work_id === frame.delegate_id))
      const title = frame.title ?? project?.running.find(work => work.work_id === frame.delegate_id)?.title ?? previous?.title
      const projectName = frame.project ?? project?.name ?? previous?.project
      const retained = {...(projectName === undefined ? {} : {project: projectName}), ...(title === undefined ? {} : {title})}
      const enriched = parsed.result === null ? null : {...parsed.result, ...retained}
      // Validate metadata too before changing retained state; serialization stays one bounded work per frame.
      const wire = executorResultSchema.parse({type: EXECUTOR_RESULT, work_id: frame.delegate_id, result: enriched})
      if (Buffer.byteLength(JSON.stringify(wire)) > MAX_DESKTOP_JSON_BYTES) throw new DesktopWireProtocolError('desktop result frame is too large')
      const oldestFinished = [...this.#results].find(([, entry]) => entry.result !== null)?.[0]
      if (previous === undefined && this.#results.size >= 64 && oldestFinished === undefined) {
        this.#telemetry?.record('desktop.result_retention_full', {})
      } else {
        if (previous === undefined && this.#results.size >= 64) this.#results.delete(oldestFinished!)
        this.#results.set(frame.delegate_id, {result: wire.result, ...retained})
        this.#replayResults()
      }
    }
    if (result !== undefined && result !== null) this.#progressSummaries.delete(frame.delegate_id)
    if (this.#progressMode === 'off' || this.#progressMode === 'milestones' && frame.level === 'detail') return
    if (frame.level === 'detail') {
      if (this.#progressSummaries.get(frame.delegate_id) === frame.summary) return
      if (this.#progressSummaries.size >= 64) this.#progressSummaries.delete(this.#progressSummaries.keys().next().value!)
      this.#progressSummaries.set(frame.delegate_id, frame.summary)
    }
    this.#enqueue(JSON.stringify(frame), {droppable: true})
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
    this.#cancelDictation()
    this.#draftInput = false
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
    this.#lastExecutorStateSent = null
    this.#lastProjectViewSent = null
    this.#lastApprovalViewSent = null
    this.#executorOutbound = null
    this.#projectOutbound = null
    this.#approvalOutbound = null
    this.#progressSummaries.clear()
    this.#resultReplay = []
    this.#tasksOutbound = null
  }

  /** Mark the connection authenticated, which is what unblocks the single-slot queues. */
  onPersonalFrame(frame: unknown): void { if (this.#authenticated) this.#enqueue(JSON.stringify(frame)) }

  markAuthenticated(): void {
    if (this.#everAuthenticated) {
      this.#fencePlaybackForConnectionBoundary({resumeDelivery: true})
    }
    this.#authenticated = true
    this.#everAuthenticated = true
    if(this.#service.inputCapabilities !== undefined)this.onPersonalFrame({type: 'desktop.capabilities', capabilities: this.#service.inputCapabilities, input_instance_id:this.#inputInstanceId})
    this.#syncExecutorStateDelivery()
    this.#syncProjectDelivery()
    this.#syncApprovalDelivery()
    this.#syncTasks()
    if (this.#results.size > 0) this.#replayResults()
  }

  #syncTasks(): void {
    this.#tasksOutbound = JSON.stringify(executorTasksSchema.parse(this.tasks.snapshot()))
    if (this.#authenticated) this.#onOutboundAvailable?.()
  }

  onTaskActionResult(result: unknown): void {
    if (this.#authenticated) this.#enqueue(JSON.stringify(taskActionResultSchema.parse(result)))
  }

  #replayResults(): void {
    // A fresh snapshot also removes evicted entries from a connected renderer. Never aggregate 64 results into one frame.
    this.#resultReplay = [JSON.stringify({type: EXECUTOR_RESULTS_RESET}), ...[...this.#results].map(([work_id, entry]) =>
      JSON.stringify({type: EXECUTOR_RESULT, work_id, result: entry.result}))]
    if (this.#authenticated) this.#onOutboundAvailable?.()
  }

  #fencePlaybackForConnectionBoundary(
    options: {readonly resumeDelivery?: boolean} = {},
  ): void {
    void (this.#voiceService?.()??this.#service).playbackDisconnected(options).catch(() => {
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
        throw new DesktopWireProtocolError('desktop authentication frame must be text')
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
    const pcm = validateInputPcm(raw)
    if (this.#dictation) {
      const draft = this.#dictation
      if (draft.finishing) return
      if (draft.size + pcm.length > 16000 * 2 * 60) { this.#cancelDictation(); throw new Error('dictation too long') }
      draft.chunks.push(pcm.slice()); draft.size += pcm.length
      return
    }
    if (!this.#draftInput) {this.#validateConversationInput?.('audio',this.#voiceConversation);if(this.#voiceConversation){if(!this.#sendConversationAudio)throw Error('voice_unavailable');await this.#sendConversationAudio(this.#voiceConversation,pcm)}else await this.#service.sendAudio(pcm)}
  }

  async receiveControl(control: DesktopControl): Promise<void> {
    if (control.type === 'input.audio') { this.#validateConversationInput?.('audio',control.conversation_id);this.#voiceConversation=control.conversation_id; if (this.#dictation) throw new Error('dictation active'); this.#draftInput = false; return }
    if (control.type === 'input.dictation') { if(control.action==='start')this.#validateConversationInput?.('dictation',control.conversation_id); this.#dictationControl(control.id, control.action,control.conversation_id); return }
    if (control.type === 'input.text') {
      const submit=async()=>{
        if (this.#dictation) throw new Error('dictation active')
        if(control.conversation_id){if(!this.#submitConversationText)throw Error('conversation_runtime_unavailable');await this.#submitConversationText(control.conversation_id,control.text,control.request_id,control.source_todo);return}
        if (!this.#service.submitText) throw new Error('text input unavailable')
        await this.#service.submitText(control.text)
      }
      if(control.request_id===undefined){await submit();return}
      const id=control.request_id
      const result=(ok:boolean,error?:string)=>({type:'input.text_result' as const,request_id:id,ok,...(control.conversation_id?{conversation_id:control.conversation_id}:{}),...(error===undefined?{}:{error})})
      let receipt:ReturnType<typeof result>
      const hash=createHash('sha256').update(JSON.stringify([control.conversation_id??null,control.text,control.source_todo??null])).digest('hex')
      const prior=this.#textReceipts.get(id)
      if(control.input_instance_id!==undefined&&control.input_instance_id!==this.#inputInstanceId)receipt=result(false,'outcome_unknown')
      else if(prior)receipt=prior.hash===hash?await prior.result:result(false,'request_id_conflict')
      else if(this.#textReceipts.size>=256)receipt=result(false,'request_capacity')
      else {
        // Record before calling the provider. Reconnect retries share this exact operation.
        const operation=Promise.resolve().then(submit).then(()=>result(true),()=>result(false,'submission_failed'))
        this.#textReceipts.set(id,{hash,result:operation})
        receipt=await operation
      }
      if(this.#authenticated)this.#enqueue(JSON.stringify(receipt))
      return
    }
    await this.#receiveCommand(commandFromControl(control))
  }

  #cancelDictation(): void {
    if (!this.#dictation) return
    clearTimeout(this.#dictation.timer); this.#dictation.controller.abort(); this.#dictation = undefined
  }

  #dictationControl(id: string, action: 'start' | 'finish' | 'cancel',conversationId?:string): void {
    if (action === 'cancel') { if (this.#dictation?.id === id) this.#cancelDictation(); return }
    if (!this.#service.transcribeDraft) throw new Error('dictation unavailable')
    if (action === 'start') {
      this.#draftInput = true
      if (this.#dictation) throw new Error('dictation active')
      const controller = new AbortController()
      const timer = setTimeout(() => { if (this.#dictation?.controller === controller) this.#cancelDictation() }, 90000)
      this.#dictation = {id,...(conversationId?{conversationId}:{}), chunks: [], size: 0, finishing: false, controller, timer}
      return
    }
    const draft = this.#dictation
    if (draft?.id !== id || draft.finishing) throw new Error('stale dictation')
    draft.finishing = true
    const pcm = Buffer.concat(draft.chunks); draft.chunks = []
    void this.#service.transcribeDraft(pcm, AbortSignal.any([draft.controller.signal, AbortSignal.timeout(30000)]))
      .then(text => { if (this.#dictation === draft) this.#enqueue(JSON.stringify({type: 'input.transcription', id,...(draft.conversationId?{conversation_id:draft.conversationId}:{}), text})) })
      .catch((error: unknown) => {
        if (this.#dictation !== draft) return
        const level = pcmLevel(pcm)
        try { this.#telemetry?.record('dictation.failed', {bytes: pcm.length, peak: level.peak, rms: level.rms, error: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]/gu, ' ').slice(0, 200)}) }
        catch { /* the failure frame below must reach the client even when the telemetry disk cannot be written */ }
        this.#enqueue(JSON.stringify({type: 'input.transcription', id,...(draft.conversationId?{conversation_id:draft.conversationId}:{}), error: error instanceof DictationError ? error.code : 'recognition_failed'}))
      })
      .finally(() => { if (this.#dictation === draft) this.#cancelDictation() })
  }

  async #receiveCommand(command: DesktopCommand): Promise<void> {
    if (
      this.#telemetry !== undefined
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
        await (this.#voiceService?.()??this.#service).localSpeechOnset(String(command.payload.speech_id))
        return
      case 'playback_started':
        (this.#voiceService?.()??this.#service).playbackStarted(
          String(command.payload.utterance_id),
          Number(command.payload.generation_epoch),
        )
        return
      case 'playback_done':
        (this.#voiceService?.()??this.#service).playbackDone(
          String(command.payload.utterance_id),
          Number(command.payload.generation_epoch),
          optionalPlayedMs(command.payload),
        )
        return
      case 'playback_stopped':
        await (this.#voiceService?.()??this.#service).playbackStopped(
          String(command.payload.utterance_id),
          Number(command.payload.generation_epoch),
          optionalPlayedMs(command.payload),
        )
        return
      case 'playback_cleared':
        (this.#voiceService?.()??this.#service).playbackCleared(
          String(command.payload.utterance_id),
          Number(command.payload.generation_epoch),
          optionalPlayedMs(command.payload),
        )
        return
      case 'project_confirmation_decision': {
        const proposalId = command.payload.proposal_id
        if (typeof proposalId !== 'string') return
        const target=typeof command.payload.conversation_id==='string'?this.#conversationService?.(command.payload.conversation_id):this.#service
        if(!target)return
        await target.projectConfirmationDecision(
          proposalId,
          command.payload.confirmed === true,
        )
        return
      }
      case 'executor_approval_decision': {
        const approvalId = command.payload.approval_id
        // A decision names its executor; one that names another executor is not ours to relay.
        if (typeof approvalId !== 'string' || command.payload.executor !== this.#approvalExecutor?.executor) return
        const target=typeof command.payload.conversation_id==='string'?this.#conversationService?.(command.payload.conversation_id):this.#service
        if(!target)return
        target.executorApprovalDecision(approvalId, command.payload.approved === true, command.payload.scope === 'session' ? 'session' : undefined)
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
    if (this.#executorOutbound !== null) {
      const state = this.#executorOutbound
      this.#executorOutbound = null
      if (state !== this.#lastExecutorStateSent) {
        this.#lastExecutorStateSent = state
        this.#syncExecutorStateDelivery()
        if (this.#executor !== null) return {frame: executorStateMessage(state, this.#executor), policy: 'latest'}
      }
    }
    if (this.#projectOutbound !== null) {
      const view = this.#projectOutbound
      this.#projectOutbound = null
      if (!sameProjectView(view, this.#lastProjectViewSent)) {
        this.#lastProjectViewSent = view
        this.#syncProjectDelivery()
        return {frame: projectStateMessage(view), policy: 'latest'}
      }
    }
    if (this.#approvalOutbound !== null) {
      const view = this.#approvalOutbound
      this.#approvalOutbound = null
      if (!sameApprovalView(view, this.#lastApprovalViewSent)) {
        this.#lastApprovalViewSent = view
        this.#syncApprovalDelivery()
        if (this.#approvalExecutor !== null) {
          return {frame: executorApprovalMessage(view, this.#clock?.now() ?? 0, this.#approvalExecutor), policy: 'latest'}
        }
      }
    }
    if (this.#authenticated && this.#tasksOutbound !== null) {
      const frame = this.#tasksOutbound
      this.#tasksOutbound = null
      return {frame, policy: 'latest'}
    }
    if (this.#authenticated && this.#resultReplay.length > 0) {
      return {frame: this.#resultReplay.shift()!, policy: 'latest'}
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
      !value.startsWith(`{"type":"${CAPTION}"`)
      && !value.startsWith(`{"type":"${PLAYBACK_TERMINAL}"`)
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
      if (options.droppable !== true) {
        const droppableIndex = this.#outbound.findIndex(delivery => delivery.policy === 'droppable')
        if (droppableIndex >= 0) this.#outbound.splice(droppableIndex, 1)
      }
    }
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
  #syncExecutorStateDelivery(): void {
    const next = this.#authenticated && this.#executorState !== this.#lastExecutorStateSent
      ? this.#executorState
      : null
    if (next === this.#executorOutbound) return
    this.#executorOutbound = next
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

  #syncApprovalDelivery(): void {
    const next = (
      this.#authenticated
      && this.#approvalView !== null
      && !sameApprovalView(this.#approvalView, this.#lastApprovalViewSent)
    ) ? this.#approvalView : null
    if (sameApprovalView(next, this.#approvalOutbound)) return
    this.#approvalOutbound = next
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
      if (this.#enqueue(`{"type":"${CLOCK_PING}","ping_id":"${pingId}"}`, {droppable: true})) {
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
    readonly executor: boolean
    readonly project: boolean
    readonly approval: boolean
  } {
    return {
      outbound: this.#outbound.length,
      preempt: this.#preemptOutbound.length,
      executor: this.#executorOutbound !== null,
      project: this.#projectOutbound !== null,
      approval: this.#approvalOutbound !== null,
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
    throw new DesktopWireProtocolError('desktop control frame is too large')
  }
  let preliminary: unknown
  try {
    preliminary = JSON.parse(raw) as unknown
  } catch {
    throw new DesktopWireProtocolError('desktop control frame is invalid JSON')
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
      ], () => new DesktopWireProtocolError('desktop playback telemetry is invalid'))
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
      new DesktopWireProtocolError(
        field === 'generation_epoch'
          ? 'desktop playback generation is invalid'
          : 'desktop playback played_ms is invalid',
      ))
  } catch (cause) {
    if (cause instanceof DesktopWireProtocolError) throw cause
    throw new DesktopWireProtocolError('desktop control frame is invalid JSON')
  }
  if (!isPlainObject(value) || typeof value.type !== 'string') {
    throw new DesktopWireProtocolError('desktop control frame has no type')
  }
  if (!options.authenticated) {
    const token = value.token
    if (
      value.type !== 'hello'
      || typeof token !== 'string'
      || !constantTimeEqual(token, options.expectedToken)
    ) {
      throw new DesktopWireProtocolError('desktop authentication failed')
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
      throw new DesktopWireProtocolError('desktop playback generation is invalid')
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
          throw new DesktopWireProtocolError('desktop playback played_ms is invalid')
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
  if (kind === 'project.confirmation_decision') {
    if (Object.keys(value).sort().join(',') !== 'confirmed,proposal_id,type') {
      throw new DesktopWireProtocolError('desktop control frame type is unsupported')
    }
    if (typeof value.confirmed !== 'boolean') {
      throw new DesktopWireProtocolError('desktop project confirmation decision is invalid')
    }
    const proposalId = readIdentifier(value, 'proposal_id')
    if (codePointLengthLikePython(proposalId) > 128) {
      throw new DesktopWireProtocolError('desktop project confirmation decision is invalid')
    }
    return {
      kind: 'project_confirmation_decision',
      payload: {proposal_id: proposalId, confirmed: value.confirmed},
    }
  }
  if (kind === 'executor.approval_decision') {
    if (Object.keys(value).sort().join(',') !== (value.scope === undefined ? 'approval_id,approved,executor,type' : 'approval_id,approved,executor,scope,type')) {
      throw new DesktopWireProtocolError('desktop control frame type is unsupported')
    }
    if (typeof value.approved !== 'boolean' || value.scope !== undefined && (value.scope !== 'session' || !value.approved)) {
      throw new DesktopWireProtocolError('desktop executor approval decision is invalid')
    }
    const executor = readIdentifier(value, 'executor')
    const approvalId = readIdentifier(value, 'approval_id')
    if (codePointLengthLikePython(approvalId) > 128) {
      throw new DesktopWireProtocolError('desktop executor approval decision is invalid')
    }
    return {
      kind: 'executor_approval_decision',
      payload: {executor, approval_id: approvalId, approved: value.approved, ...(value.scope === undefined ? {} : {scope: value.scope})},
    }
  }
  if (kind === 'clock.pong') {
    const timestamp = value.t_render_ms
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) {
      throw new DesktopWireProtocolError('desktop t_render_ms is invalid')
    }
    return {
      kind: 'clock_pong',
      payload: {ping_id: readIdentifier(value, 'ping_id'), t_render_ms: timestamp},
    }
  }
  if (kind === 'connection.diagnostic') {
    const result = connectionDiagnosticSchema.safeParse(value)
    if (!result.success) {
      throw new DesktopWireProtocolError('desktop connection diagnostic is invalid')
    }
    const {type, ...payload} = result.data
    void type
    return {kind: 'connection_diagnostic', payload}
  }
  throw new DesktopWireProtocolError('desktop control frame type is unsupported')
}

function commandFromControl(control: Exclude<DesktopControl, {type: 'input.audio' | 'input.text' | 'input.dictation'}>): DesktopCommand {
  switch (control.type) {
    case 'personal.command':
    case 'executor.task_action':
    case 'coding.progress_narration':
      throw new DesktopWireProtocolError('desktop host control requires authenticated transport')
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
    case 'project.confirmation_decision':
      return {
        kind: 'project_confirmation_decision',
        payload: {proposal_id: control.proposal_id, confirmed: control.confirmed,...(control.conversation_id?{conversation_id:control.conversation_id}:{})},
      }
    case 'executor.approval_decision':
      return {
        kind: 'executor_approval_decision',
        payload: {...(control.conversation_id?{conversation_id:control.conversation_id}:{}),executor: control.executor, approval_id: control.approval_id, approved: control.approved, ...(control.scope === undefined ? {} : {scope: control.scope})},
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
    throw new DesktopWireProtocolError('desktop t_render_ms is invalid')
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
    throw new DesktopWireProtocolError(`desktop ${field} is invalid`)
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
    // Store-ordered and plain data, so the serialisation is a stable identity (spec 08 roster).
    && JSON.stringify(left.roster ?? []) === JSON.stringify(right.roster ?? [])
}

function sameApprovalView(
  left: ExecutorApprovalView | null,
  right: ExecutorApprovalView | null,
): boolean {
  if (left === null || right === null) return left === right
  return left.pending_approval === right.pending_approval
    && left.pending_approval_busy === right.pending_approval_busy
    && left.pending_approval_id === right.pending_approval_id
    && left.executorIdentity?.executor === right.executorIdentity?.executor
    && left.executorIdentity?.display_name === right.executorIdentity?.display_name
    && left.kind === right.kind
    && left.operation_summary === right.operation_summary
    && left.expires_at === right.expires_at
    && (left.held ?? false) === (right.held ?? false)
    && JSON.stringify(left.allowed_decisions) === JSON.stringify(right.allowed_decisions)
    && JSON.stringify(left.local_detail) === JSON.stringify(right.local_detail)
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

const READY_FRAME = JSON.stringify({type: DESKTOP_READY})

/** The authenticated writer surface used by the bridge pump. */
export interface DesktopServerTransport {
  sendText(raw: string): Promise<void>
  sendBinary(raw: Uint8Array): Promise<void>
  disconnectClient(): Promise<void>
  start(): Promise<DesktopReadiness>
  close(): Promise<void>
}

export interface DesktopRealtimeOptions extends DesktopBridgeOptions {
  readonly personalCommand?: (command: unknown,context?:PersonalCommandContext) => Promise<unknown>
  readonly personalSnapshot?: () => unknown
  readonly taskPort?: CodingTaskPort
  readonly openTaskDirectory?: (path: string) => Promise<void>
  /** Remote transport errors release the connection; desktop retains its fatal policy. */
  readonly transportFailure?: 'abort' | 'disconnect'
  readonly memoryBoard?: (requestId: string, detail?: MemoryBoardDetail, page?: MemoryBoardMessageOptions) => string | Promise<string>
  readonly createServer?: (options: DesktopServerOptions) => DesktopServerTransport
  /** Optional lifecycle observation after bridge connection state has been released. */
  readonly onConnectionReleased?: () => void
}

/**
 * Owns the narrow connection-generation boundary between desktop policy and the socket writer.
 * Realtime service/provider construction intentionally lives elsewhere.
 */
export class DesktopRealtime {
  readonly bridge: DesktopSocketBridge
  readonly server: DesktopServerTransport
  readonly serverOptions: DesktopServerOptions

  readonly #stop: {abort(): void}
  readonly #transportFailure: 'abort' | 'disconnect'
  readonly #onConnectionReleased: (() => void) | undefined
  readonly #telemetry: RealtimeTelemetry | undefined
  readonly #discardInputAudio: (() => Promise<void>) | undefined
  #generation = 0
  #activeGeneration: number | null = null
  #drainRequested = false
  #draining = false

  constructor(options: DesktopRealtimeOptions) {
    const {
      createServer,
      transportFailure,
      onConnectionReleased,
      memoryBoard,
      ...bridgeOptions
    } = options
    this.#discardInputAudio = transportFailure === 'disconnect'
      ? options.service.discardInputAudio?.bind(options.service) : undefined
    this.#stop = options.stop
    this.#transportFailure = transportFailure ?? 'abort'
    this.#onConnectionReleased = onConnectionReleased
    this.#telemetry = options.telemetry
    this.bridge = new DesktopSocketBridge({
      ...bridgeOptions,
      ...(transportFailure === 'disconnect' ? {stop: {abort: () => {
        const generation = this.#activeGeneration
        if (generation === null) this.bridge.release()
        else void this.#disconnect(generation)
      }}} : {}),
      onOutboundAvailable: () => this.#requestDrain(),
    })
    this.serverOptions = {
      token: options.token,
      bootstrapTextFrames: [READY_FRAME],
      onClientAuthenticated: async language => {
        this.#authenticated()
        await options.service.setLanguage?.(language)
      },
      onClientDisconnect: media => this.#disconnected(media?.hadProviderAttachment ?? true),
      onDebugBoardRequest: request => {
        if (memoryBoard === undefined) throw new DesktopProtocolError('desktop memory board is unavailable')
        return memoryBoard(request.request_id, request.detail, request)
      },
      onAudio: pcm => this.bridge.receiveAudio(pcm),
      onControl: async (control,context) => {
        const generation = this.#activeGeneration
        if (generation === null) throw new DesktopProtocolError('desktop control is unauthenticated')
        if (control.type === 'personal.command') {
          const result = options.personalCommand ? await options.personalCommand(control,context??(transportFailure==='disconnect'?undefined:{client_id:'desktop:local'})) : {type:'personal.result',request_id:control.request_id,ok:false,error:'unavailable'}
          if (this.#activeGeneration === generation) {
            this.bridge.onPersonalFrame(result)
            // Inspector reads must not publish state and trigger another inspector read.
            if (options.personalSnapshot && !['tasks.get', 'tasks.list'].includes(control.method)) this.bridge.onPersonalFrame(options.personalSnapshot())
          }
          return
        }
        if (control.type === 'coding.progress_narration') { options.service.setCodingProgressNarration?.(control.mode); return }
        if (control.type !== 'executor.task_action') return this.bridge.receiveControl(control)
        const request = taskActionSchema.parse(control)
        // Folder resolution and native launch must not hold the serialized PCM input queue.
        void (async () => {
          let status: TaskActionStatus = 'unavailable'
          try {
            if (this.bridge.tasks.has(request.work_id, request.executor) && options.taskPort !== undefined) {
              if (request.action === 'cancel') status = this.bridge.tasks.isRunning(request.work_id) ? options.taskPort.cancelTask(request.work_id) : 'not_running'
              else {
                const path = await options.taskPort.taskDirectory(request.work_id)
                if (this.#activeGeneration !== generation) return
                if (path !== null) { await (options.openTaskDirectory ?? (target => openTaskDirectory(target, undefined, process.platform, () => this.#activeGeneration === generation)))(path); status = 'opened' }
              }
            }
          } catch { status = 'failed' }
          if (this.#activeGeneration === generation) this.bridge.onTaskActionResult({type: 'executor.task_action_result', request_id: request.request_id, work_id: request.work_id, action: request.action, status})
        })()
      },
    }
    this.server = (createServer ?? (serverOptions => new NodeDesktopServer(serverOptions)))(
      this.serverOptions,
    )
  }

  #authenticated(): void {
    if (!this.bridge.claim()) {
      throw new DesktopProtocolError('desktop bridge connection is unavailable')
    }
    this.#activeGeneration = ++this.#generation
    this.bridge.markAuthenticated()
    this.#requestDrain()
  }

  #disconnected(hadProviderAttachment: boolean): void {
    const generation = this.#activeGeneration
    if (generation !== null) this.#release(generation, hadProviderAttachment)
  }

  #release(generation: number, hadProviderAttachment = true): void {
    if (this.#activeGeneration !== generation) return
    this.#activeGeneration = null
    this.#generation += 1
    if (hadProviderAttachment) void this.#discardInputAudio?.().catch(() => {
      this.#telemetry?.record('remote.input_reset_failed', {})
    })
    this.bridge.release()
    this.#onConnectionReleased?.()
  }

  #requestDrain(): void {
    this.#drainRequested = true
    if (this.#activeGeneration !== null && !this.#draining) void this.#drain()
  }

  async #drain(): Promise<void> {
    if (this.#draining) return
    this.#draining = true
    try {
      while (this.#activeGeneration !== null && this.#drainRequested) {
        this.#drainRequested = false
        for (;;) {
          const generation: number | null = this.#activeGeneration
          if (generation === null) break
          const delivery = this.bridge.takeNextDelivery()
          if (delivery === null) break
          try {
            await this.#send(delivery)
          } catch (error) {
            if (this.#activeGeneration !== generation) break
            if (error instanceof DesktopPersonalFrameTooLargeError) {
              this.#telemetry?.record('desktop.personal_frame_rejected', {
                frame_type: error.frameType, bytes: error.bytes, limit: MAX_DESKTOP_PERSONAL_JSON_BYTES,
              })
              try {
                // A command may already have committed. Reject its response without replaying it.
                await this.server.sendText(JSON.stringify(error.frameType === 'personal.result'
                  ? {type: 'personal.result', request_id: error.requestId, ok: false, error: 'personal_frame_too_large', input_status: 'unknown'}
                  : {type: 'personal.error', error: 'personal_frame_too_large'}))
                continue
              } catch { /* A failed error delivery still follows the transport failure policy. */ }
              if (this.#activeGeneration !== generation) break
            }
            if (delivery.policy === 'required' && this.#transportFailure === 'abort') this.#stop.abort()
            else if (delivery.policy !== 'required' && error instanceof DesktopOutboundValidationError) {
              this.#telemetry?.record('desktop.outbound_validation_dropped', {
                policy: delivery.policy,
                frame_kind: typeof delivery.frame === 'string' ? 'text' : 'binary',
              })
              continue
            } else {
              await this.#disconnect(generation)
            }
            break
          }
          if (this.#activeGeneration !== generation) break
        }
      }
    } finally {
      this.#draining = false
      if (this.#activeGeneration !== null && this.#drainRequested) void this.#drain()
    }
  }

  async #disconnect(generation: number): Promise<void> {
    if (this.#activeGeneration !== generation) return
    try {
      const disconnect = this.server.disconnectClient()
      if (this.#transportFailure === 'disconnect') this.#release(generation)
      await disconnect
      this.#release(generation)
    } catch {
      this.#release(generation)
      this.#telemetry?.record('desktop.transport_disconnect_failed', {})
    }
  }

  #send(delivery: DesktopDelivery): Promise<void> {
    return typeof delivery.frame === 'string'
      ? this.server.sendText(delivery.frame)
      : this.server.sendBinary(delivery.frame)
  }
}

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
  readonly onExecutorSuggestion: (suggestion: Suggestion) => void
  readonly onAudioFrame: (frame: PlaybackFrame) => void
  readonly onAudioClear: (utteranceId: string, generationEpoch: number) => void
  readonly onAudioAlert: (utteranceId: string | null, generationEpoch: number | null) => void
  readonly onAudioTerminal: (utteranceId: string, generationEpoch: number) => void
  readonly onDelivery: (completion: PlaybackCompletion) => void
  readonly onCaption: (frame: CaptionFrame) => void
  readonly onExecutorState: (state: ExecutorState) => void
  readonly onProjectView: (view: ProjectConfirmationView) => void
}

export interface BuildDesktopRealtimeCompositionOptions {
  readonly approvalExecutor?: ExecutorIdentity
  readonly progressBubbles?: ProgressMode
  readonly token: string
  readonly stop: AbortController
  readonly buildRealtime: (
    callbacks: DesktopOutputCallbacks,
    cameraTransport: CameraCaptureTransport,
  ) => RealtimeAssembly
  readonly telemetry?: RealtimeTelemetry
  readonly projectView?: ProjectConfirmationView
  readonly approvalView?: ExecutorApprovalView
  readonly createServer?: DesktopRealtimeOptions['createServer']
  readonly transportFailure?: DesktopRealtimeOptions['transportFailure']
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
  const holder: {desktop?: DesktopRealtime; realtime?: RealtimeAssembly} = {}
  const requireDesktop = (): DesktopRealtime => {
    if (holder.desktop === undefined) {
      throw new Error('desktop realtime bridge is unavailable during construction')
    }
    return holder.desktop
  }
  const requireRealtime = (): RealtimeAssembly => {
    if (holder.realtime === undefined) {
      throw new Error('desktop realtime runtime is unavailable during construction')
    }
    return holder.realtime
  }
  const cameraTransport: CameraCaptureTransport = {
    captureCamera(request: CameraCaptureRequest): Promise<CapturedCameraFrame> {
      let server: DesktopServerTransport
      try {
        server = requireDesktop().server
      } catch (error) {
        return Promise.reject(error instanceof Error
          ? error
          : new Error('desktop realtime bridge is unavailable during construction'))
      }
      if (!isCameraCaptureTransport(server)) {
        return Promise.reject(new Error('desktop camera transport is unavailable'))
      }
      return server.captureCamera(request)
    },
    async releaseCamera(sessionId: string): Promise<void> {
      const server = requireDesktop().server
      if (isCameraCaptureTransport(server)) await server.releaseCamera?.(sessionId)
    },
    requestCameraPermission(): Promise<CameraPermissionStatus> {
      let server: DesktopServerTransport
      try {
        server = requireDesktop().server
      } catch (error) {
        return Promise.reject(error instanceof Error
          ? error
          : new Error('desktop realtime bridge is unavailable during construction'))
      }
      if (!isCameraPermissionTransport(server)) {
        return Promise.reject(new Error('desktop camera permission transport is unavailable'))
      }
      return server.requestCameraPermission()
    },
  }
  const realtime = options.buildRealtime({
    onExecutorSuggestion: suggestion => {
      const progress = projectExecutorSuggestion(suggestion, requireRealtime().runtime.clock.now())
      if (progress !== null) requireDesktop().bridge.onExecutorProgress(progress)
    },
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
      const current = requireRealtime()
      if (current.service.clearingConversation || completion.session_epoch !== current.session.sessionEpoch) return
      const payload = deliveryToEvent(completion)
      if (payload !== null) current.runtime.post({kind: 'assistant_spoken', payload})
    },
    onCaption: frame => requireDesktop().bridge.onCaption(frame),
    onExecutorState: state => requireDesktop().bridge.onExecutorState(state),
    onProjectView: view => requireDesktop().bridge.onProjectView(view),
  }, cameraTransport)
  holder.realtime = realtime
  const desktop = new DesktopRealtime({
    token: options.token,
    ...(options.transportFailure === undefined ? {} : {transportFailure: options.transportFailure}),
    service: realtime.service,
    conversationService:id=>realtime.personalAgent.conversationService(id),
    voiceService:()=>realtime.personalAgent.voiceService(),
    sendConversationAudio:(id,pcm)=>realtime.personalAgent.sendConversationAudio(id,pcm),
    submitConversationText:(id,text,requestId,sourceTodo)=>realtime.personalAgent.submitConversationText(id,text,requestId,sourceTodo),
    validateConversationInput:(kind,id)=>{if(realtime.personalAgent.presentationMode==='background')throw Error('presentation_hidden');const state=realtime.personalAgent.conversationSnapshot();if(id!==undefined&&!state.items.some(item=>item.id===id))throw Error('conversation_not_found');if(kind==='audio'&&((id!==undefined&&state.voice_id!==id)||(id===undefined&&state.voice_id!==null)))throw Error('voice_not_owned');if(kind==='dictation'&&state.voice_id!==null)throw Error('voice_active')},
    personalCommand: (command,context) => realtime.personalAgent.command(command,context),
    personalSnapshot: () => realtime.personalAgent.snapshot(),
    onConnectionReleased:()=>{if(realtime.personalAgent.presentationMode!==null)void realtime.personalAgent.disconnectPresentation().catch(()=>{ /* pending decisions remain fail-closed during shutdown */ })},
    executor: codingExecutorIdentity(realtime) ?? options.approvalExecutor ?? null,
    ...(() => {
      const adapter = [...realtime.runtime.executors.values()].find(adapter => adapter.manifest.roles.includes('coding'))
      const port = (adapter as {taskPort?: CodingTaskPort} | undefined)?.taskPort
      return port === undefined ? {} : {taskPort: port}
    })(),
    stop: options.stop,
    memoryBoard: async (requestId, detail, page) => {
      if (page?.channel === 'personal') {
        const personal = await realtime.inspectPersonalMemory({query: page.query ?? '', ...(page.before_seq === undefined ? {} : {before: page.before_seq})})
        return JSON.stringify({type: 'memory.board', request_id: requestId, channels: [], diagnostics: {version: 1, records: []}, personal})
      }
      await realtime.runtime.flushMemory(true)
      return memoryBoardMessage(requestId, realtime.runtime.memory, options.telemetry?.diagnostics?.(),
        {...page, conversationEpoch: realtime.runtime.core.conversationEpoch, ...(detail === undefined ? {} : {detail})})
    },
    clock: realtime.runtime.clock,
    ...(options.progressBubbles === undefined ? {} : {progressBubbles: options.progressBubbles}),
    ...(options.telemetry === undefined ? {} : {telemetry: options.telemetry}),
    ...(options.projectView === undefined ? {} : {projectView: options.projectView}),
    ...(options.approvalView === undefined ? {} : {approvalView: options.approvalView}),
    ...(options.createServer === undefined ? {} : {createServer: options.createServer}),
  })
  holder.desktop = desktop
  const unsubscribePersonal = realtime.personalAgent.subscribe(() => desktop.bridge.onPersonalFrame(realtime.personalAgent.snapshot()))
  options.stop.signal.addEventListener('abort', unsubscribePersonal, {once:true})
  startDesktopActivityHeartbeat(realtime.service, idle => desktop.bridge.onActivity(idle), options.stop.signal)

  const unsubscribeProgress = realtime.runtime.observe((event, currentConversation) => {
    if (currentConversation === false) return
    const projected = projectExecutorEvent(event, realtime.runtime, channel => realtime.service.agentNameForChannel(channel),
      undefined, id => realtime.service.session.delegateRecord(id))
    if (projected !== null) desktop.bridge.onExecutorProgress(projected.progress, projected.result)
  })
  if (options.stop.signal.aborted) unsubscribeProgress()
  else options.stop.signal.addEventListener('abort', unsubscribeProgress, {once: true})
  return {realtime, desktop}
}

/** Best-effort presence must never take down the owning realtime service. */
export function startDesktopActivityHeartbeat(
  service: RealtimeAssembly['service'],
  publish: (idle: boolean) => void,
  signal: AbortSignal,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    if (signal.aborted) return
    let idle = false
    try {
      const session = service.session
      idle = session.foregroundIdle && session.floor.state === 'idle'
        && session.snapshot().active_delegates.length === 0
        && service.executorState === 'idle'
    } catch { /* Unavailable session state conservatively means busy. */ }
    try { publish(idle) } catch { /* A dropped presence frame is retried next tick. */ }
  }, 1000)
  timer.unref()
  if (signal.aborted) clearInterval(timer)
  else signal.addEventListener('abort', () => clearInterval(timer), {once: true})
  return timer
}

/** The frame identity of the configured coding executor, or `null` when there is none. */
export function codingExecutorIdentity(realtime: Pick<RealtimeAssembly, 'runtime' | 'service'>): ExecutorIdentity | null {
  const manifest = executorWithRole(
    [...realtime.runtime.executors.values()].map(adapter => adapter.manifest),
    'coding',
  )
  if (manifest === null) return null
  const publicName = realtime.service.agentNameForChannel(manifest.name) ?? manifest.name
  return {executor: publicName, display_name: publicName}
}

function isCameraCaptureTransport(
  server: DesktopServerTransport,
): server is DesktopServerTransport & CameraCaptureTransport {
  return 'captureCamera' in server && typeof server.captureCamera === 'function'
}

function isCameraPermissionTransport(
  server: DesktopServerTransport,
): server is DesktopServerTransport & Required<Pick<CameraCaptureTransport, 'requestCameraPermission'>> {
  return 'requestCameraPermission' in server
    && typeof server.requestCameraPermission === 'function'
}

export interface RealtimeDesktopServiceOptions {
  /** Phone-owned media must attach through the listener before the provider can start. */
  readonly listenBeforeRealtime?: boolean
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
  readonly #listenBeforeRealtime: boolean
  readonly #onDiagnostic: (line: string) => void
  #runOperation: Promise<void> | null = null
  #cleanupOperation: Promise<CleanupOutcome> | null = null

  constructor(options: RealtimeDesktopServiceOptions) {
    const grace = options.cleanupGraceMs ?? DESKTOP_OWNER_SHUTDOWN_GRACE_MS
    if (!Number.isFinite(grace) || grace <= 0) {
      throw new TypeError('desktop cleanup grace must be positive and finite')
    }
    this.#listenBeforeRealtime = options.listenBeforeRealtime ?? false
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
      if (this.#listenBeforeRealtime && !this.#stop.signal.aborted) {
        const listening = await this.#runPhase(this.#listen(), external, 'desktop_server_start_abandoned', isReadinessCancellation)
        if (listening.kind === 'rejected') throw listening.error
        if (listening.kind === 'terminal') return await this.#finish(listening.cause)
      }
      if (!this.#stop.signal.aborted) {
        const start = await this.#runPhase(
          this.#realtime.start(),
          external,
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

        if (!this.#listenBeforeRealtime) {
          const listener = await this.#runPhase(
            this.#desktop.server.start(), terminal, 'desktop_server_start_abandoned',
          )
          if (listener.kind === 'rejected') primaryFailure = {error: listener.error}
          if (listener.kind === 'terminal') return await this.#finish(listener.cause)
          if (listener.kind === 'resolved') {
            const announcement = await this.#runPhase(
              this.#announce(this.#readyEndpoint, listener.value, this.#stop.signal),
              terminal, 'desktop_readiness_announcement_abandoned', isReadinessCancellation,
            )
            if (announcement.kind === 'rejected') primaryFailure = {error: announcement.error}
            if (announcement.kind === 'terminal') return await this.#finish(announcement.cause)
          }
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

  async #listen(): Promise<void> {
    const readiness = await this.#desktop.server.start()
    if (!this.#stop.signal.aborted) await this.#announce(this.#readyEndpoint, readiness, this.#stop.signal)
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
      current ??= external.current() ?? cause
      return current
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
    return {promise, current: () => current ?? external.current()}
  }

  async #runPhase<T>(
    work: Promise<T>,
    terminal: TerminalMonitor,
    abandonedDiagnostic: string,
    terminalWinsConcurrentRejection?: (error: unknown) => boolean,
  ): Promise<PhaseResult<T>> {
    const outcome: Promise<PhaseResult<T>> = work.then(
      value => ({kind: 'resolved', value}),
      (error: unknown) => ({kind: 'rejected', error}),
    )
    const raced = await Promise.race([
      outcome,
      terminal.promise.then(cause => ({kind: 'terminal' as const, cause})),
    ])
    if (
      raced.kind === 'rejected'
      && terminalWinsConcurrentRejection?.(raced.error) === true
    ) {
      const cause = terminal.current()
      if (cause !== undefined) return {kind: 'terminal', cause}
    }
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

export interface DesktopConstructionOwnership {
  /** Retain construction cleanup until the returned graph has acquired lifecycle ownership. */
  own(cleanup: () => void | Promise<void>): () => void
}

export interface DesktopEntryOptions {
  readonly listenBeforeRealtime?: boolean
  readonly token: string
  readonly readyEndpoint?: string
  readonly stop: AbortController
  readonly construct: (
    ownership: DesktopConstructionOwnership,
  ) => DesktopEntryConstruction | Promise<DesktopEntryConstruction>
  readonly announce: (
    endpoint: string,
    readiness: DesktopReadiness,
    signal: AbortSignal,
  ) => Promise<void>
  readonly onDiagnostic: (line: string) => void
  readonly cleanupGraceMs?: number
  readonly onStartupFailure?: (error: unknown) => void
}

/** Run the production entry without leaking configuration or dependency errors to stderr. */
export async function runDesktopEntry(options: DesktopEntryOptions): Promise<0 | 2> {
  let ownership: DesktopConstructionLedger | null = null
  try {
    ownership = new DesktopConstructionLedger(
      options.cleanupGraceMs ?? DESKTOP_OWNER_SHUTDOWN_GRACE_MS,
      options.onDiagnostic,
    )
    validateDesktopToken(options.token)
    if (options.readyEndpoint !== undefined) parseReadyEndpoint(options.readyEndpoint)
    const constructed = await options.construct(ownership)
    const owner = new RealtimeDesktopService({
      ...(options.listenBeforeRealtime === undefined ? {} : {listenBeforeRealtime: options.listenBeforeRealtime}),
      realtime: constructed.realtime,
      desktop: constructed.desktop,
      readyEndpoint: options.readyEndpoint ?? '',
      stop: options.stop,
      announce: options.announce,
      ...(constructed.closeAuxiliary === undefined
        ? {}
        : {closeAuxiliary: constructed.closeAuxiliary}),
      ...(options.cleanupGraceMs === undefined ? {} : {cleanupGraceMs: options.cleanupGraceMs}),
      onDiagnostic: options.onDiagnostic,
    })
    ownership.commit()
    await owner.run()
    return 0
  } catch (error) {
    await ownership?.rollback()
    try {
      options.onStartupFailure?.(error)
      options.onDiagnostic(`[runtime-diagnostic] ${desktopEntryFailureCode(error)}`)
    } catch {
      // A diagnostic sink must not convert a bounded entry failure into an unhandled rejection.
    }
    return 2
  }
}

function desktopEntryFailureCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const value = error as {readonly name?: unknown; readonly code?: unknown; readonly message?: unknown}
    if (value.message === 'personal_store_locked') return 'personal_store_locked'
    if (['EACCES', 'EPERM', 'EROFS'].includes(String(value.code))) return 'filesystem_permissions'
    if (['state_permissions', 'state_busy', 'state_lock_failed', 'personal_store_locked', 'workspace_not_found', 'workspace_invalid'].includes(String(value.code))) return String(value.code)
    if (value.code === 'frontbrain_tool_budget_exceeded') return 'configuration_required'
    if (value.code === 'credential_missing') return 'authentication_failed'
    if (new Set([
      'binary_missing', 'spawn_failed', 'codex_host_unavailable',
      'codex_project_host_unsupported', 'backend_unavailable',
    ]).has(String(value.code))) return 'backend_unavailable'
    // Every configuration error class (core, camera, any executor's host config) ends in this suffix.
    if (typeof value.name === 'string' && value.name.endsWith('ConfigurationError')) return 'configuration_required'
  }
  return 'assembly_failed'
}

interface ConstructionCleanup {
  readonly cleanup: () => void | Promise<void>
  active: boolean
}

class DesktopConstructionLedger implements DesktopConstructionOwnership {
  readonly #cleanups: ConstructionCleanup[] = []
  readonly #cleanupGraceMs: number
  readonly #onDiagnostic: (line: string) => void
  #sealed = false
  #rollbackOperation: Promise<void> | null = null

  constructor(cleanupGraceMs: number, onDiagnostic: (line: string) => void) {
    if (!Number.isFinite(cleanupGraceMs) || cleanupGraceMs <= 0) {
      throw new TypeError('desktop cleanup grace must be positive and finite')
    }
    this.#cleanupGraceMs = cleanupGraceMs
    this.#onDiagnostic = onDiagnostic
  }

  own(cleanup: () => void | Promise<void>): () => void {
    if (this.#sealed || typeof cleanup !== 'function') {
      throw new TypeError('desktop construction ownership is closed')
    }
    const entry: ConstructionCleanup = {cleanup, active: true}
    this.#cleanups.push(entry)
    return (): void => { entry.active = false }
  }

  commit(): void {
    this.#sealed = true
    for (const entry of this.#cleanups) entry.active = false
  }

  rollback(): Promise<void> {
    if (this.#rollbackOperation !== null) return this.#rollbackOperation
    if (this.#sealed) return Promise.resolve()
    this.#sealed = true
    this.#rollbackOperation = this.#rollbackFresh()
    return this.#rollbackOperation
  }

  async #rollbackFresh(): Promise<void> {
    for (let index = this.#cleanups.length - 1; index >= 0; index -= 1) {
      const entry = this.#cleanups[index]!
      if (!entry.active) continue
      entry.active = false
      const result = await this.#cleanupWithinGrace(entry.cleanup)
      if (result.kind === 'rejected') {
        this.#emitDiagnostic('desktop_construction_cleanup_failed')
      } else if (result.kind === 'abandoned') {
        this.#emitDiagnostic('desktop_construction_cleanup_abandoned')
      }
    }
  }

  async #cleanupWithinGrace(cleanup: () => void | Promise<void>): Promise<CleanupResult> {
    const settled = settleCleanup(cleanup)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<CleanupResult>(resolve => {
      timer = setTimeout(() => resolve({kind: 'abandoned'}), this.#cleanupGraceMs)
    })
    const result = await Promise.race([settled, deadline])
    if (timer !== undefined) clearTimeout(timer)
    return result
  }

  #emitDiagnostic(diagnostic: string): void {
    try {
      this.#onDiagnostic(`[runtime-diagnostic] ${diagnostic}`)
    } catch {
      // Construction rollback remains all-attempted when diagnostics fail.
    }
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

function isReadinessCancellation(error: unknown): boolean {
  return error instanceof DesktopProtocolError
    && error.message === 'desktop readiness announcement cancelled'
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
