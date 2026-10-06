import {TaskExecutionRejected} from '../personal-agent/task-loop.js'
import type {TaskDispatchContext} from '../core/task-tools.js'
import {taskGrantService} from '../personal-agent/tasks.js'
import type {PromptLanguage} from './prompt-language.js'
export type { AgentControllerFactory,DelegateLike,DeliverySnapshot,ExecutorManifestLike,RealtimeServiceOptions,ServiceProvider,ServiceRuntime } from './service-ports.js'
export { formatSeconds } from './service-state.js'
import { CodingProgressNarrationState,type CodingProgressNarration } from './coding-progress-narration.js'
import { HostDelivery } from './host-delivery.js'
import { ProjectConfirmationFlow } from './project-confirmation-flow.js'
import { ProviderProjection } from './provider-projection.js'
import type { DeliverySnapshot,HostItemOptions,ProviderReconnectReason,RealtimeServiceOptions,ServiceProvider,ServiceRuntime } from './service-ports.js'
import { Mutex,Signal,diagnosticName } from './service-state.js'
import { ToolContinuations } from './tool-continuations.js'
/**
 * Coordinates provider event ordering, lifecycle and user-origin evidence.
 * HostDelivery owns speech/acknowledgements; ToolContinuations owns admitted work;
 * ProjectConfirmationFlow owns confirmation lifecycle; ProviderProjection owns presentation.
 * Reconnect lock precedes delivery lock. Reconnect uses private deliveryPass, never
 * the public recovery wrapper. Continuations run only after delivery lock release.
 * Epoch checks remain at the original await boundaries because providers may reuse IDs.
 */

import { randomUUID } from 'node:crypto'
import {
createAgentControllerRegistry,
type AgentControllerRegistry
} from '../executors/agent-controller.js'
import { ApprovalHost } from '../core/approval.js'
import type { Clock } from '../core/clock.js'
import { type EventRecord,type JsonValue } from '../core/events.js'
import {
type IntakeEventPort,
type IntakeOptions,
} from '../executors/coding/intake.js'
import {
USER_PRIORITY
} from '../core/memory.js'
import type { PlaybackCompletion,PlaybackGeneration } from './playback.js'
import { codePointLengthLikePython } from '../text/python-text.js'
import type { WakeReason } from '../core/slots.js'
import type { Suggestion } from '../core/suggestions.js'
import type { CompiledTools } from '../core/tool-schema.js'
import type { RealtimeRuntimeBridge,ToolCallReady } from './bridge.js'
import { type CodingChannel } from './evidence.js'
import { packRecoveryTurns,projectRecoveryTurns,type RecoveryTurn } from './history.js'
import type {
HostContextItem,
HostResponseIntent,
RealtimeProviderEvent,
} from './protocol.js'
import { ItemDeliveryUncertainError } from './protocol.js'
import {
MAX_HOST_FACT_CHARS,
MAX_TRACKED_TOOL_CALLS,
PROJECT_EXPIRY_STEP_TIMEOUT_S,
callKey,
hostFactIntent,
type ExecutorState,
type PreemptiveAlertHistoryRecovery,
type QueuedHostResponse,
type ToolCallAcceptanceSnapshot,
type UrgentHostResponseOwner
} from './service-state.js'
import {
type CaptionFrame
} from './session-state.js'
import { RealtimeDeliveryError,type RealtimeSession } from './session.js'
import type { RealtimeTelemetry } from './telemetry.js'
import { UserOriginBindingLedger } from './user-origin-binding.js'

function sameAgentDescriptors(
  left: readonly {readonly name: string; readonly summary: string; readonly ownedChannels: readonly string[]}[],
  right: readonly {readonly name: string; readonly summary: string; readonly ownedChannels: readonly string[]}[],
): boolean {
  return left.length === right.length && left.every((descriptor, index) => {
    const other = right[index]
    return other?.name === descriptor.name
      && descriptor.summary === other.summary
      && descriptor.ownedChannels.length === other.ownedChannels.length
      && descriptor.ownedChannels.every((channel, channelIndex) => channel === other.ownedChannels[channelIndex])
  })
}

/**
 * How long `close` waits for a task that is not responding to its abort signal.
 *
 * Short: every loop here checks the signal at its next suspension point, so a task still running after
 * this is stuck rather than slow, and waiting longer would only delay the diagnostic.
 */
const SHUTDOWN_GRACE_MS = 250

export class RealtimeService {
  async setLanguage(language?: PromptLanguage): Promise<void> { await this.#provider.setLanguage?.(language) }

  playbackStarted(utteranceId: string, generationEpoch: number): boolean {return this.#host.playbackStarted(utteranceId, generationEpoch)}

  readonly #confirmation: ProjectConfirmationFlow

  get projectConfirmationBlockingForTest(): boolean {return this.#confirmation.projectConfirmationBlockingForTest}

  get confirmationClosingItemsForTest(): readonly string[] {return this.#confirmation.confirmationClosingItemsForTest}

  get confirmationItemsForTest(): readonly string[] {return this.#confirmation.confirmationItemsForTest}

  get confirmationResponsesForTest(): readonly string[] {return this.#confirmation.confirmationResponsesForTest}

  readonly #continuations: ToolContinuations

  get toolCallDispositionsForTest(): readonly (string | null)[] { return this.#continuations.toolCallDispositionsForTest }

  driveContinuations(): Promise<void> { return this.#continuations.driveContinuations() }

  toolCallAcceptances(): readonly ToolCallAcceptanceSnapshot[] { return this.#continuations.toolCallAcceptances() }

  readonly #host: HostDelivery

  get urgentOwnerForTest(): UrgentHostResponseOwner | null { return this.#host.urgentOwnerForTest }

  seedUrgentOwnerForTest(input: {
    readonly sessionEpoch: number
    readonly eventId: string
    readonly responseId: string | null
  }): void { return this.#host.seedUrgentOwnerForTest(input) }

  takeNextQueuedHostItem(): QueuedHostResponse | undefined { return this.#host.takeNextQueuedHostItem() }

  queuedHostItems(): readonly QueuedHostResponse[] { return this.#host.queuedHostItems() }

  get armedPreemptPriority(): number | null { return this.#host.armedPreemptPriority }

  get pendingHostItemCount(): number { return this.#host.pendingHostItemCount }

  playbackDisconnected(
    options: {readonly resumeDelivery?: boolean} = {},
  ): Promise<boolean> { return this.#host.playbackDisconnected(options) }

  playbackStopped(
    utteranceId: string,
    generationEpoch: number,
    playedMs: number | null,
  ): Promise<boolean> { return this.#host.playbackStopped(utteranceId, generationEpoch, playedMs) }

  playbackCleared(utteranceId: string, generationEpoch: number, playedMs: number | null): boolean { return this.#host.playbackCleared(utteranceId, generationEpoch, playedMs) }

  playbackDone(utteranceId: string, generationEpoch: number, playedMs: number | null): boolean { return this.#host.playbackDone(utteranceId, generationEpoch, playedMs) }

  taskRoutes():readonly string[]{return this.#agentRegistry.descriptors.map(item=>item.name)}
  taskTurnOrigin():string|undefined{return this.#intakeUser?.origin_ref}
  async dispatchTask(grant:TaskDispatchContext,instruction:string){
    let tasks;try{tasks=taskGrantService(grant);tasks.validateContinuation(grant)}catch{throw new TaskExecutionRejected('task_continuation_stale')}const task=tasks.get(grant.fence.task_id)
    const controller=task.execution_route?this.#agentRegistry.controllers.get(task.execution_route):undefined
    if(!controller)throw new TaskExecutionRejected('task_executor_unavailable')
    return controller.dispatch({taskContext:grant,continuationGrant:grant,instruction,originalUserText:task.original_goal??task.goal,origin_ref:grant.origin_ref,sessionEpoch:this.session.sessionEpoch,acceptedUserInputRevision:0,stillWanted:grant.stillWanted})
  }

  queueHostItem(
    intent: HostResponseIntent,
    options: HostItemOptions = {},
  ): void { return this.#host.queueHostItem(intent, options) }

  semanticAcknowledgementFor(responseId: string): string | null { return this.#host.semanticAcknowledgementFor(responseId) }

  readonly #projection: ProviderProjection

  projectRuntimeEvent(event: EventRecord, currentConversation = true): void {
    this.#projection.projectRuntimeEvent(event, currentConversation)
  }

  onSuggestionSelected(suggestion: Suggestion, reason: WakeReason): void {
    this.#projection.onSuggestionSelected(suggestion, reason)
  }

  readonly session: RealtimeSession
  readonly #intake: IntakeEventPort | undefined
  #intakeUser: {text: string; origin_ref: string; epoch: number; inputRevision: number; localOnsetRevision: number} | null = null
  #localSpeechOnsetRevision = 0
  #lastLocalSpeechOnsetId: string | null = null

  readonly #provider: ServiceProvider
  readonly #runtime: ServiceRuntime
  readonly #clock: Clock
  #unsubscribeCodingProgress: (() => void) | null = null
  readonly #codingProgressNarration: CodingProgressNarrationState
  readonly #tools: CompiledTools
  readonly #providerSchemas: readonly Readonly<Record<string, JsonValue>>[]
  readonly #bridge: RealtimeRuntimeBridge
  readonly #idFactory: () => string
  readonly #onProviderTerminal: (generation: PlaybackGeneration) => void
  readonly #onExecutorState: (state: ExecutorState) => void
  readonly #captionScope = randomUUID()
  readonly #onCaption: ((frame: CaptionFrame) => void) | undefined
  readonly #onUserTranscriptAccepted: RealtimeServiceOptions['onUserTranscriptAccepted']
  readonly #telemetry: RealtimeTelemetry | undefined
  readonly #onDiagnostic: (line: string) => void
  readonly #controlledPreemptiveAlertReconnect: boolean
  readonly #preemptiveAlertHistoryRecovery: PreemptiveAlertHistoryRecovery
  readonly #preemptiveAlertHistoryPairs: number
  readonly #approvalHost: ApprovalHost
  /** The coding-role executor's channel and label, resolved once from the registered manifests. */
  readonly #coding: CodingChannel | null
  readonly #agentRegistry: AgentControllerRegistry
  readonly #reconnectLock = new Mutex()
  readonly #pendingIngress = new Set<Promise<void>>()
  readonly #deliveryReady = new Signal()
  /**
   * The stop flag, as a real `AbortController`.
   *
   * Not a look-alike carrying only `aborted`: the runtime's `serve` registers an abort listener on
   * whatever it is handed, so anything less than the real thing throws on the first `start()`.
   * Replaced on each `start()` rather than reset, because an `AbortController` cannot be un-aborted.
   */
  #stop = new AbortController()

  #unsubscribe: (() => void) | null = null
  #tasks: Promise<void>[] = []
  #connected = false
  #providerFailed = false
  #clearingConversation = false
  #clearConversationOperation: Promise<void> | null = null
  #conversationClearRevision = 0
  readonly #audioStarted = new Set<string>()
  /** Exact revision-scoped join from provider user items to responses and Memory origins. */
  readonly #userOrigins = new UserOriginBindingLedger(MAX_TRACKED_TOOL_CALLS)
  #unsubscribeExecutorApproval: (() => void) | null = null
  #awaitingUserOrigin = false
  #userOriginPreexistingResponseId: string | null = null

  readonly #onProviderEvent: ((event:RealtimeProviderEvent)=>void)|undefined
  constructor(options: RealtimeServiceOptions) {
    this.#onProviderEvent=options.onProviderEvent
    // Preserve config capture order when custom controller factories invoke intake callbacks.
    let commitProjectOperation: RealtimeServiceOptions['commitProjectOperation'] = undefined
    let onProjectView: RealtimeServiceOptions['onProjectView'] = undefined
    let projectViewProvider: RealtimeServiceOptions['projectViewProvider'] = undefined
    let projectExpiryStepTimeoutMs: number | undefined = undefined
    const recovery = options.preemptiveAlertHistoryRecovery ?? 'none'
    if (recovery !== 'none' && recovery !== 'packed') {
      throw new TypeError('unknown preemptive-alert history recovery arm')
    }
    const pairs = options.preemptiveAlertHistoryPairs ?? 4
    // 1, 2, or 4 rather than any positive number: these are the arms the recovery experiment has,
    // and an unlisted value would silently be a fifth arm nobody measured.
    if (pairs !== 1 && pairs !== 2 && pairs !== 4) {
      throw new TypeError('preemptive-alert history pair budget must be 1, 2, or 4')
    }
    this.#provider = options.provider
    this.#runtime = options.runtime
    this.#clock = options.runtime.clock
    this.#codingProgressNarration = options.runtime.codingProgressNarration ?? new CodingProgressNarrationState()
    this.#subscribeCodingProgress()
    this.#tools = options.tools
    // Deep-copied at construction: the provider is handed these on every connect, including after a
    // reconnect, and a caller that mutated its own array afterwards would change what the model is
    // told its tools are, mid-session.
    this.#providerSchemas = structuredClone(options.providerSchemas ?? options.tools.schemas)
    this.session = options.session
    this.#bridge = options.bridge
    this.#idFactory = options.idFactory ?? (() => `host_${randomHex()}`)
    this.#onProviderTerminal = options.onProviderTerminal ?? noop
    this.#onExecutorState = options.onExecutorState ?? noop
    const onActiveWorkChanged = options.onActiveWorkChanged ?? noop
    this.#onCaption = options.onCaption
    this.#onUserTranscriptAccepted = options.onUserTranscriptAccepted
    this.#telemetry = options.telemetry
    this.#onDiagnostic = options.onDiagnostic ?? ((line: string): void => {
      console.log(line)
    })
    this.#controlledPreemptiveAlertReconnect = options.controlledPreemptiveAlertReconnect ?? false
    this.#preemptiveAlertHistoryRecovery = recovery
    this.#preemptiveAlertHistoryPairs = pairs
    const projectConfirmation = options.projectConfirmation
    const intake: IntakeOptions | undefined = options.intake === undefined ? undefined : {
      ...options.intake,
      clock: this.#clock,
      record: (intake, kind, data) => {
        if (kind === 'intake.failure' || kind === 'intake.timing') this.#telemetry?.record(kind, {
          intake_id: intake.intake_id, revision: intake.revision, ...data,
        })
        options.intake!.record(intake, kind, data)
      },
      onStateChanged: () => this.#projection.publishExecutorState(),
      idFactory: this.#idFactory,
      dispatch: async (intake, stillWanted) => {
        const result = await options.intake!.dispatch(intake, stillWanted)
        return this.#continuations.recordIntakeDispatch(intake, result)
      },
      diagnostic: code => this.#onDiagnostic(`[realtime-diagnostic] ${code}`),
      invalidateProposal: () => this.#confirmation.invalidateProjectConfirmation('intake_amended'),
      fact: (intake, text, kind) => {
        this.queueHostItem(hostFactIntent({
          kind: 'final', host_item_id: this.#idFactory(),
          event_id: `intake:${intake.intake_id}:${intake.revision}:${kind ?? this.#idFactory()}`,
          content: [...text].slice(0, MAX_HOST_FACT_CHARS).join(''),
        }), {priority: USER_PRIORITY - 1, preemptive: false})
        this.#deliveryReady.set()
      },
      prepare: intake => {
        const proposal=this.#confirmation.prepareIntake(intake)
        options.onIntakePrepared?.(intake,proposal)
        return proposal
      },
    }
    this.#approvalHost = new ApprovalHost({
      session: this.session, clock: this.#clock, idFactory: this.#idFactory,
      controller: options.executorApproval, telemetry: this.#telemetry,
      projectBlocking: () => projectConfirmation?.pending === true || projectConfirmation?.committing === true,
      displayName: () => this.#coding?.display_name ?? '执行器',
      queueHostItem: (intent, options) => this.queueHostItem(intent, options),
      deliveryReady: () => this.#deliveryReady.set(),
      reportDeliveryFailure: failure => this.#reportDeliveryFailure(failure),
      retireProviderHostEventNow: eventId => this.#host.retireProviderHostEventNow(eventId),
      retireProviderHostEvent: eventId => this.#host.retireProviderHostEvent(eventId),
      removeQueuedPrompt: id => this.#host.removeQueuedExecutorApprovalPrompt(id),
      releaseQuestion: id => this.#host.releaseExecutorApprovalQuestion(id),
    })
    this.#coding = null
    for (const adapter of options.runtime.executors.values()) {
      if (adapter.manifest.roles.includes('coding')) {
        this.#coding = {channel: adapter.manifest.name, display_name: adapter.manifest.display_name ?? adapter.manifest.name}
        break
      }
    }
    this.#host = new HostDelivery({
      session: this.session, runtime: this.#runtime, clock: this.#clock,
      telemetry: this.#telemetry, approvalHost: this.#approvalHost,
      controlledPreemptiveAlertReconnect: this.#controlledPreemptiveAlertReconnect,
      clearingConversation: () => this.#clearingConversation,
      stopped: () => this.#stop.signal.aborted,
      providerFailed: () => this.#providerFailed,
      wake: () => this.#deliveryReady.set(),
      intakeFactEligible: (id, epoch) => this.#intake?.factEligible(id, epoch),
      executorPriority: channel => this.#projection.executorPriority(channel),
      executorDisplayName: channel => this.#projection.executorDisplayName(channel),
      idFactory: this.#idFactory, onDiagnostic: this.#onDiagnostic,
      reportDeliveryFailure: failure => this.#reportDeliveryFailure(failure),
      responseCarriesPersonalRecall: responseId => this.#continuations.responseCarriesPersonalRecall(responseId),
      originCanReferenceProof: key => this.#continuations.originCanReferenceProof(key),
      originHasNonterminalReference: key => this.#continuations.originHasNonterminalReference(key),
    })
    this.#confirmation = new ProjectConfirmationFlow({
      session: this.session, clock: this.#clock, projectConfirmation,
      approvalHost: this.#approvalHost, coding: this.#coding, telemetry: this.#telemetry,
      idFactory: this.#idFactory, onDiagnostic: this.#onDiagnostic,
      intake: () => this.#intake,
      get commitProjectOperation() {return commitProjectOperation},
      get onProjectView() {return onProjectView},
      get projectViewProvider() {return projectViewProvider},
      get projectExpiryStepTimeoutMs() {return projectExpiryStepTimeoutMs!},
      userOrigins: {
        itemForResponse: (epoch, response) => this.#userOrigins.itemForResponse(epoch, response),
        revisionForItem: (epoch, item) => this.#userOrigins.revisionForItem(epoch, item),
        hasOriginRef: (epoch, item) => this.#userOrigins.hasOriginRef(epoch, item),
        bindRetryResponse: input => this.#userOrigins.bindRetryResponse(input),
      },
      bindResponseUserOrigin: (epoch, response) => this.#bindResponseUserOrigin(epoch, response),
      failOriginTranscriptAndRefresh: (epoch, item) => {
        this.#failUserOriginTranscript(epoch, item)
        this.#awaitingUserOrigin = this.#userOrigins.hasUnboundRevision(epoch, this.session.userInputRevision)
        if (!this.#awaitingUserOrigin) this.#userOriginPreexistingResponseId = null
      },
      continuations: {
        takeDeferredForItem: item => this.#continuations.takeDeferredForItem(item),
        takeConfirmationDeferredCalls: epoch => this.#continuations.takeConfirmationDeferredCalls(epoch),
        abandonProjectConfirmationContinuation: (epoch, response) => this.#continuations.abandonProjectConfirmationContinuation(epoch, response),
        releaseDeferredOriginCalls: (item, origin) => this.#continuations.releaseDeferredOriginCalls(item, origin),
      },
      reconnectProviderSession: options => this.#reconnectProviderSession(options),
      deliveryPass: () => this.#deliveryPass(),
      queueHostItem: (intent, options) => this.queueHostItem(intent, options),
      wakeDelivery: () => this.#deliveryReady.set(),
      reportDeliveryFailure: failure => this.#reportDeliveryFailure(failure),
      stopSignal: () => this.#stop.signal,
      conversationClearRevision: () => this.#conversationClearRevision,
      clearingConversation: () => this.#clearingConversation,
    })
    const controllers = [...(options.agentControllers ?? [])]
    if (options.agentControllerFactory !== undefined) {
      const controller = options.agentControllerFactory.create({intake})
      this.#intake = controller.intake
      controllers.unshift(controller)
    }
    this.#agentRegistry = createAgentControllerRegistry({
      controllers,
      manifests: [...options.runtime.executors.values()].map(adapter => adapter.manifest),
    })
    if (!sameAgentDescriptors(this.#agentRegistry.descriptors, options.tools.agent_descriptors)) {
      throw new TypeError('agent controller registry does not match compiled tool descriptors')
    }
    this.#continuations = new ToolContinuations({
      ...(options.taskHost ? {taskHost:options.taskHost} : {}),
      session: this.session, host: this.#host, runtime: this.#runtime,
      bridge: this.#bridge, tools: this.#tools, intake: this.#intake, approvalHost: this.#approvalHost,
      coding: this.#coding, telemetry: this.#telemetry, idFactory: this.#idFactory,
      executorPriority: channel => this.#projection.executorPriority(channel),
      executorDisplayName: channel => this.#projection.executorDisplayName(channel),
      publishExecutorState: () => this.#projection.publishExecutorState(),
      queueHostItem: (intent, options) => this.queueHostItem(intent, options),
      wakeDelivery: () => this.#deliveryReady.set(),
      userOrigins: {
        itemForResponse: (epoch, response) => this.#userOrigins.itemForResponse(epoch, response),
        revisionForItem: (epoch, item) => this.#userOrigins.revisionForItem(epoch, item),
        originRefForItem: (epoch, item) => this.#userOrigins.originRefForItem(epoch, item),
        bindRetryResponse: input => this.#userOrigins.bindRetryResponse(input),
      },
      confirmTarget: event => this.#confirmation.confirmTarget(event),
      isProjectConfirmationShadowItem: (epoch, item) => this.#confirmation.isProjectConfirmationShadowItem(epoch, item),
      closeProjectConfirmationTool: event => this.#confirmation.closeProjectConfirmationTool(event),
      handleProjectConfirmationDecision: (event, origin) => this.#confirmation.handleProjectConfirmationDecision(event, origin),
      reconnectProviderSession: options => this.#reconnectProviderSession(options),
      deliveryPass: () => this.#deliveryPass(),
      recoverUncertainDelivery: failure => this.#recoverUncertainDelivery(failure),
      reportDeliveryFailure: failure => this.#reportDeliveryFailure(failure),
      awaitingUserOrigin: () => this.#awaitingUserOrigin,
      userOriginPreexistingResponseId: () => this.#userOriginPreexistingResponseId,
      discardedInputEpoch: () => this.#discardedInputEpoch,
      stopSignal: () => this.#stop.signal,
      intakeUser: () => this.#intakeUser,
      currentUserTurn: (event, origin) => this.#currentUserTurn(event, origin),
      agentController: name => this.#agentRegistry.controllers.get(name),
    })
    commitProjectOperation = options.commitProjectOperation
    onProjectView = options.onProjectView
    projectViewProvider = options.projectViewProvider
    projectExpiryStepTimeoutMs = options.projectExpiryStepTimeoutMs ?? PROJECT_EXPIRY_STEP_TIMEOUT_S * 1_000
    // Subscribed at construction: a proposal can expire before anything else happens, and the observer
    // is the only notice of it.
    this.#confirmation.subscribeExpiry()
    this.#unsubscribeExecutorApproval = options.executorApproval?.observe(view => {
      this.#approvalHost.syncExecutorApproval(view)
    }) ?? null
    if (options.executorApproval !== undefined) this.#approvalHost.syncExecutorApproval(options.executorApproval.view)

    this.#projection = new ProviderProjection({
      session: this.session, runtime: this.#runtime, clock: this.#clock, coding: this.#coding,
      ...(options.taskHost ? {taskOwnsWork: (workId: string) => options.taskHost!.tasks.list().some(task => task.work_ids.includes(workId))} : {}),
      codingProgressNarration: this.#codingProgressNarration,
      generatePlan: options.intake?.settings.generate_plan !== false, telemetry: this.#telemetry,
      idFactory: this.#idFactory,
      queueHostItem: (intent, options) => this.queueHostItem(intent, options),
      agentNameForChannel: channel => this.#agentRegistry.agentNameForChannel(channel),
      clearingConversation: () => this.#clearingConversation,
      onActiveWorkChanged,
      onExecutorState: this.#onExecutorState,
      preparing: () => this.#intake?.preparing === true,
      onDiagnostic: this.#onDiagnostic,
      resolveSyncResult: event => this.#continuations.resolveSyncResult(event),
      expireSyncResult: event => this.#continuations.expireSyncResult(event),
      hasSemanticAcknowledgement: id => this.#host.hasSemanticAcknowledgement(id),
      fenceSemanticAcknowledgement: delegate => this.#host.fenceSemanticAcknowledgement(delegate),
      retireDelegateHostEvents: delegate => this.#host.retireDelegateHostEvents(delegate),
      rememberDelegateHostEvent: (delegate, event) => this.#host.rememberDelegateHostEvent(delegate, event),
      rememberCodingProgressHostEvent: event => this.#host.rememberCodingProgressHostEvent(event),
      coalesceCodingProgress: () => {
        this.#host.coalesceCodingProgress()
      },
    })
}

  get executorState(): ExecutorState {
    return this.#projection.executorState
  }

  agentNameForChannel(channel: string): string | null { return this.#agentRegistry.agentNameForChannel(channel) }

  onProjectWorkspaceChanged(workspaceId: string | null): void {
    this.#intake?.workspaceChanged(workspaceId)
  }

  get stopped(): boolean {
    return this.#stop.signal.aborted
  }

  /** True from the synchronous clear fence until a blank provider epoch is fully ready. */
  get clearingConversation(): boolean {
    return this.#clearingConversation
  }

  /** Clear the current conversation while leaving independently running executors alone. */
  clearConversation(): Promise<void> {
    if (this.#clearConversationOperation !== null) return this.#clearConversationOperation
    if (!this.#connected || this.stopped || this.#providerFailed) {
      return Promise.reject(new Error('realtime service is not available for conversation clear'))
    }

    // Publish single-flight ownership before playback/confirmation callbacks can reenter clear.
    const operation = Promise.resolve().then(() => this.#clearConversationAfterFence())
    this.#clearConversationOperation = operation

    // Install every externally visible fence before returning the Promise. Old provider input and
    // user authority must become unusable in the same synchronous turn as the clear request.
    this.#conversationClearRevision += 1
    this.#clearingConversation = true
    this.#host.pauseForConversationClear()
    const clearingGeneration = this.session.beginConversationClear()
    if (clearingGeneration !== null) this.#host.startPreemptiveAlertClearDeadline(clearingGeneration)
    this.#intake?.cancel()
    this.#intakeUser = null
    this.#host.releaseUrgentOwner()
    this.#confirmation.invalidateProjectConfirmation('conversation_cleared')
    do {
      this.#approvalHost.invalidateExecutorApproval('conversation_cleared')
    } while (this.#approvalHost.pending)

    void operation.then(
      () => {
        if (this.#clearConversationOperation !== operation) return
        this.#clearConversationOperation = null
        this.#clearingConversation = false
        this.#host.resumeAfterConversationClear()
        this.#deliveryReady.set()
      },
      failure => {
        if (this.#clearConversationOperation !== operation) return
        this.#clearConversationOperation = null
        this.#onDiagnostic(
          `[realtime-diagnostic] conversation_clear_failed type=${diagnosticName(failure)}`,
        )
        // A failed durable clear or replacement cannot leave a live service silently dropping input.
        // Use the existing fatal lifecycle; a new service must reopen and revalidate its resources.
        this.#taskFailed(this.#stop)
      },
    )
    return operation
  }

  async #clearConversationAfterFence(): Promise<void> {
    // Normal ingress stays concurrent: a newer user turn must be able to supersede a pending tool.
    // The synchronous clear fence prevents new admissions while existing handlers settle.
    await Promise.allSettled([...this.#pendingIngress])
    await this.#reconnectLock.run(async () => {
        await this.#host.withDeliveryLock(async () => {
          if (this.#runtime.clearConversation === undefined) {
            throw new Error('runtime conversation clear is unavailable')
          }
          await this.#runtime.clearConversation()
          this.#resetConversationLedgers()
          await this.session.resetConversation({tools: structuredClone(this.#providerSchemas)})
          this.#userOrigins.beginEpoch(this.session.sessionEpoch)
          this.#clearCaptions()
          this.#projection.publishExecutorState()
        })
      })
  }

  #subscribeCodingProgress(): void {
    if (this.#unsubscribeCodingProgress !== null) return
    this.#unsubscribeCodingProgress = this.#codingProgressNarration.observe(() => {
      this.#host.retireCodingProgress()
    })
  }

  async connect(): Promise<void> {
    this.#subscribeCodingProgress()
    if (this.#connected) return
    await this.session.connect({tools: structuredClone(this.#providerSchemas)})
    if (Number.isInteger(this.session.sessionEpoch) && this.session.sessionEpoch >= 0) {
      this.#userOrigins.beginEpoch(this.session.sessionEpoch)
    }
    this.#confirmation.syncProjectConfirmationIsolation()
    this.#approvalHost.sync()
    this.#unsubscribe = this.#runtime.observe((event, currentConversation = true) => {
      this.projectRuntimeEvent(event, currentConversation)
    })
    this.#connected = true
  }

  /**
   * Start the three long-lived loops.
   *
   * Idempotent by design: `start` is called from more than one place during bring-up, and a second
   * set of loops would consume the same provider stream twice.
   */
  async start(): Promise<void> {
    await this.connect()
    if (this.#tasks.length > 0) return
    // A fresh controller: an aborted one cannot be reused, and `start` after `close` has to work.
    // Each guard is handed the controller it belongs to, so a task abandoned by an earlier close
    // cannot report a failure against the run that replaced it.
    const run = new AbortController()
    this.#stop = run
    const signal = run.signal
    this.#tasks = [
      this.#guardTask(this.#receiveLoop(signal), run),
      this.#guardTask(this.#deliveryLoop(signal), run),
      this.#guardTask(this.#runtime.serve(signal), run),
    ]
  }

  /**
   * Stop everything, and surface a provider close failure rather than swallowing it.
   *
   * The order matters. State that could authorize new work is cleared *before* awaiting anything, so
   * a task still running during the await cannot act on it. The provider close is attempted even if
   * that clearing threw, and its own failure is held and re-raised after every task has been
   * cancelled -- a close that failed still has to leave the service stopped.
   */
  async close(): Promise<void> {
    this.#unsubscribeCodingProgress?.()
    this.#unsubscribeCodingProgress = null
    this.#stop.abort()
    this.#confirmation.invalidateProjectConfirmation('service_closed')
    this.#approvalHost.invalidateExecutorApproval('service_closed')
    this.#confirmation.unsubscribeExpiry()
    if (this.#unsubscribeExecutorApproval !== null) {
      this.#unsubscribeExecutorApproval()
      this.#unsubscribeExecutorApproval = null
    }
    this.#confirmation.discardPendingExpiries()
    // The drain is shutdown-owned work. A promise cannot be cancelled, so its continuations check the
    // signal instead -- and this waits, bounded, so a reconnect cannot land after `close` returned.
    const draining = this.#confirmation.expiryDrain()
    this.#host.close()
    this.#deliveryReady.set()
    if (this.#unsubscribe !== null) {
      this.#unsubscribe()
      this.#unsubscribe = null
    }
    // Held rather than propagated immediately: a close that failed still has to leave every task
    // cancelled and the service marked disconnected, so the failure is re-raised only after that.
    let closeFailure: {readonly cause: unknown} | null = null
    let closeAbandoned = false
    try {
      // Bounded like the loops are. A transport that never finishes closing would otherwise block
      // application shutdown forever, which is exactly the failure mode a degraded transport has.
      closeAbandoned = !await resolvedWithin(this.#provider.close(), SHUTDOWN_GRACE_MS)
    } catch (cause) {
      closeFailure = {cause}
    }
    if (closeAbandoned) {
      this.#onDiagnostic('[realtime-diagnostic] shutdown_provider_close_abandoned')
    }
    const backgroundTasks = [
      ...this.#tasks,
      ...this.#host.retirementTasks(),
      ...this.#approvalHost.pendingTasks,
      ...this.#host.acknowledgementReleaseTasks(),
      ...this.#confirmation.carrierReleaseTasks(),
    ]
    const tasks = draining === null ? backgroundTasks : [...backgroundTasks, draining]
    this.#tasks = []
    // Bounded. A promise cannot be cancelled from outside the way an asyncio task can, so a loop that
    // ignores the abort would make `close` wait forever -- and a service that never finishes closing
    // is worse than one that reports a task it could not stop. The loops all observe the signal, so
    // reaching the timeout means one of them is genuinely stuck.
    const abandoned = await settleWithin(tasks, SHUTDOWN_GRACE_MS)
    this.#connected = false
    if (abandoned > 0) {
      this.#onDiagnostic(
        `[realtime-diagnostic] shutdown_tasks_abandoned count=${abandoned}`,
      )
    }
    if (closeFailure !== null) throw asError(closeFailure.cause)
  }

  #inputController = new AbortController()
  #inputReady: Promise<void> | null = null
  readonly #inputChanged = new Signal()
  #discardedInputEpoch = -1

  /** Replace only the provider session; host work remains owned by the existing graph. */
  detachTaskConversation():void{
    this.#conversationClearRevision++
    this.#intakeUser=null
  }
  discardInputAudio(): Promise<void> {
    // A phone-owned provider may still be awaiting its first successful SDK handshake.
    if (!this.#connected) return Promise.resolve()
    this.#inputController.abort()
    this.#inputController = new AbortController()
    this.#discardedInputEpoch = this.session.sessionEpoch
    // Serialize repeated disconnects, including one during a pending replacement. A failed
    // replacement deliberately leaves this barrier rejected so subsequent input stays closed.
    const previous = this.#inputReady
    const replace = async () => {
      this.#discardedInputEpoch = this.session.sessionEpoch
      await this.#reconnectProviderSession({reason: 'client_disconnect'})
    }
    const ready = previous === null ? replace() : previous.then(replace, replace)
    this.#inputReady = ready
    this.#inputChanged.set()
    void ready.catch(() => undefined)
    return ready
  }

  get inputCapabilities(): readonly string[] { return [...(this.#provider.submitText ? ['text_input'] : []), ...(this.#provider.transcribeDraft ? ['dictation'] : [])] }

  async transcribeDraft(pcm: Uint8Array, signal: AbortSignal): Promise<string> {
    if (!this.#provider.transcribeDraft) throw new Error('dictation unavailable')
    return this.#provider.transcribeDraft(pcm, AbortSignal.any([signal, this.#inputController.signal]))
  }

  async submitText(text: string): Promise<void> {
    const controller = this.#inputController
    if (this.#inputReady !== null) await this.#inputReady
    if (controller.signal.aborted || !this.#provider.submitText) throw new Error('text input unavailable')
    await this.#provider.submitText(text, controller.signal)
  }

  async sendAudio(pcm: Uint8Array): Promise<void> {
    if (this.#clearingConversation) return
    const controller = this.#inputController
    if (this.#inputReady !== null) await this.#inputReady
    if (controller.signal.aborted || this.#clearingConversation) return
    await this.#provider.sendAudio(pcm, controller.signal)
  }

  async localSpeechOnset(speechId: string): Promise<void> {
    if (this.#clearingConversation) return
    if (speechId !== this.#lastLocalSpeechOnsetId) {
      this.#lastLocalSpeechOnsetId = speechId
      this.#localSpeechOnsetRevision += 1
    }
    this.#intake?.userInputStarted()
    this.#approvalHost.noteExecutorApprovalOnsetBeforeContext()
    const generation = this.session.currentGeneration
    if (generation !== null) {
      const key = callKey(generation.session_epoch, generation.response_id)
      this.#host.rememberLocalSpeechInterruption(key)
    }
    this.#approvalHost.releaseQuestionOnOnset()
    await this.session.localSpeechOnset(speechId)
  }

  /** Settle the exact proposal shown by the renderer; the controller remains the sole authority. */
  projectConfirmationDecision(proposalId: string, confirmed: boolean): Promise<void> {
    return this.#trackIngress(() => this.#confirmation.projectConfirmationDecision(proposalId, confirmed))
  }

  /** Renderer clicks are direct local-user authority on the same one-shot controller as voice. */
  executorApprovalDecision(approvalId: string, approved: boolean, scope?: 'session'): boolean {
    if (this.#clearingConversation) return false
    return this.#approvalHost.executorApprovalDecision(approvalId, approved, scope)
  }

  async waitStopped(): Promise<void> {
    await Promise.allSettled(this.#tasks)
  }

  /**
   * Deliver everything the floor currently allows.
   *
   * The public entry point. It exists to translate an uncertain delivery into a reconnect attempt;
   * the reconnect path itself must call `#deliveryPass` instead, or it would re-enter here while
   * holding the reconnect lock.
   */
  async flushHostItems(): Promise<void> {
    try {
      await this.#deliveryPass()
    } catch (cause) {
      if (cause instanceof ItemDeliveryUncertainError) {
        await this.#recoverUncertainDelivery(cause)
        return
      }
      throw cause
    }
  }

  /**
   * An injection whose outcome the provider never confirmed.
   *
   * Retried exactly once per item, and never for a recovery item -- a recovery injection is what a
   * reconnect *is*, so retrying it through another reconnect would recurse. A second uncertainty for
   * the same item means the transport cannot be trusted to report anything, and the service stops
   * rather than guessing whether the model has seen a fact.
   */
  async #recoverUncertainDelivery(failure: ItemDeliveryUncertainError): Promise<void> {
    if (failure.item_kind === 'recovery') {
      this.#failUncertainDelivery()
      return
    }
    if (!this.#host.admitUncertainDeliveryRetry(failure.host_item_id)) {
      this.#failUncertainDelivery()
      return
    }
    try {
      const reconnected = await this.#reconnectProviderSession({
        reason: 'uncertain_delivery',
        expectedEpoch: failure.session_epoch,
      })
      if (!reconnected) await this.#deliveryPass()
    } catch (cause) {
      if (cause instanceof ItemDeliveryUncertainError) {
        this.#failUncertainDelivery()
        return
      }
      throw cause
    }
  }

  #failUncertainDelivery(): void {
    this.#onDiagnostic('[realtime-diagnostic] uncertain_delivery_exhausted')
    this.#providerFailed = true
    this.#host.releaseFailedDelivery()
    this.#stop.abort()
    this.#deliveryReady.set()
  }

  /**
   * One pass over the queue, under the delivery lock.
   *
   * The stale-hold release happens first and unconditionally: a user hold that has outlived its
   * window blocks every delivery, so checking it after the floor test would let one abandoned hold
   * stall the queue indefinitely.
   *
   * The continuation re-drive at the end is the subtle part. A preempt that was armed and is no
   * longer armed means the thing blocking continuations has cleared, and nothing else will notice --
   * so this pass has to hand off. It happens *outside* the lock because the continuation drive takes
   * its own, and CP3 says the two are never held together.
   */
  async #deliveryPass(): Promise<void> {
    if (await this.#host.deliveryPass()) await this.driveContinuations()
  }

  /** Blank dead-epoch speculative text on both roles after a reconnect. */
  #clearCaptions(): void {
    this.session.resetCaptions()
    if (this.#onCaption !== undefined) {
      this.#onCaption({role: 'assistant', text: '', final: true})
      this.#onCaption({role: 'user', text: '', final: true})
    }
  }

  /** Drop every service projection that could make the fresh provider epoch describe old dialogue. */
  #resetConversationLedgers(): void {
    this.#host.resetDelivery()
    this.#host.resetUncertainDeliveryRetries()
    this.#continuations.resetCalls()
    this.#host.resetAcknowledgements()
    this.#audioStarted.clear()
    this.#continuations.resetDeferredAndSync()
    this.#confirmation.reset()
    this.#projection.reset()
    this.#host.resetOriginProofs()
    this.#awaitingUserOrigin = false
    this.#userOriginPreexistingResponseId = null
    this.#intakeUser = null
    this.#localSpeechOnsetRevision = 0
    this.#lastLocalSpeechOnsetId = null
    this.#deliveryReady.clear()
  }

  /**
   * Replace the provider session, and reconcile everything that referred to the old one.
   *
   * Ported from `_reconnect_provider_session`. The whole method runs under `#reconnectLock`, and the
   * two things that look like implementation detail are both load-bearing:
   *
   * The source epoch is armed *before* the await, so a preemptive alert already waiting on the session's
   * response-request lock can see that the provider identity advanced even if it runs before this
   * resumes. Arming it after would let that alert act against a session that no longer exists.
   *
   * The tail calls the private `#deliveryPass` rather than the public `flushHostItems`. The public
   * wrapper turns an uncertain delivery into a reconnect, and reconnecting while already holding the
   * lock would deadlock. Confirmation uncertainty is meant to escape to the caller here.
   *
   * Returns false when the epoch moved while waiting for the lock: someone else already replaced the
   * session, and doing it again would discard a *live* one.
   */
  async #reconnectProviderSession(
    options: {readonly reason: ProviderReconnectReason; readonly expectedEpoch?: number},
  ): Promise<boolean> {
    const requestedEpoch = options.expectedEpoch ?? this.session.sessionEpoch
    this.#telemetry?.record('provider.reconnect', {reason: options.reason, outcome: 'started'})
    try {
      return await this.#reconnectLock.run(async () => {
        if (this.session.sessionEpoch !== requestedEpoch) {
          this.#telemetry?.record('provider.reconnect', {
            reason: options.reason,
            outcome: 'skipped_epoch',
          })
          return false
        }
        const oldEpoch = this.session.sessionEpoch
        this.#confirmation.invalidateProjectConfirmation('provider_replaced')
        this.#approvalHost.invalidateExecutorApproval('provider_replaced')
        this.#host.beginReconnect(oldEpoch)
        // Provider identity and session epoch must advance before queued host delivery resumes.
        await this.session.reconnect({
          tools: structuredClone(this.#providerSchemas),
          withProviderTransition: work => this.#host.withDeliveryLock(work),
        })
        // Only if nothing cleared it while we were awaiting. A user who started speaking during the
        // reconnect has already activated the new session, so demanding an activation would be wrong.
        this.#host.finishReconnect(oldEpoch)
        const retryOwner = this.#host.currentUrgentOwner

        // Every origin binding named items in a session that is gone. Keeping any of it would let a
        // tool call cite evidence the new provider has never seen.
        this.#awaitingUserOrigin = false
        this.#userOriginPreexistingResponseId = null
        this.#userOrigins.beginEpoch(this.session.sessionEpoch)
        this.#continuations.clearDeferred()

        this.#host.releaseUrgentHostResponseForEpoch(oldEpoch)
        // An urgent item that was injected but never got a response is the one case worth retrying: it
        // was delivered into a session that died before speaking it, so the user heard nothing. One that
        // *did* get a response was taken up by the provider, and re-queueing would say it twice.
        if (retryOwner?.session_epoch === oldEpoch && retryOwner.response_id === null) {
          this.#host.requeueHostItem(retryOwner.queued)
        }
        this.#clearCaptions()
        this.#audioStarted.clear()
        this.#continuations.reconcileToolStateAfterReconnect(oldEpoch)
        this.#host.reopenFailedSemanticAcknowledgements()
        this.#host.reconcileSemanticAcknowledgementsAfterReconnect()
        await this.driveContinuations()
        await this.#deliveryPass()
        this.#telemetry?.record('provider.reconnect', {
          reason: options.reason,
          outcome: 'completed',
        })
        return true
      })
    } catch (failure) {
      this.#telemetry?.record('provider.reconnect', {reason: options.reason, outcome: 'failed'})
      throw failure
    }
  }

  /** Live host preference: switching never stops or restarts executor work. */
  setCodingProgressNarration(mode: CodingProgressNarration): void { this.#codingProgressNarration.setMode(mode) }

  /**
   * Consume the provider stream until it ends or the service stops.
   *
   * The epoch filter is the first thing in the loop and it is not redundant with the session's own:
   * `events()` already drops mismatched events, and dropping them again here is what makes a
   * reconnect that happens *while* an event is in flight safe.
   *
   * The outer loop distinguishes three endings. A stopped service or a failed provider returns. An
   * epoch that changed means a reconnect replaced the stream, so it re-subscribes. A stream that
   * ended having yielded nothing is a provider that is simply gone.
   */
  async #receiveLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const streamEpoch = this.session.sessionEpoch
      let received = false
      // The signal goes to the provider: at shutdown the stream is normally parked with nothing to
      // say, and an iterator suspended in `await` cannot be stopped from out here.
      for await (const event of this.#provider.events(signal)) {
        if (signal.aborted) return
        if (event.session_epoch <= this.#discardedInputEpoch) continue
        if (event.session_epoch !== this.session.sessionEpoch) continue
        received = true
        try {
          await this.handleEvent(event)
          this.#onProviderEvent?.(event)
        } catch (cause) {
          if (cause instanceof ItemDeliveryUncertainError) {
            await this.#recoverUncertainDelivery(cause)
          } else if (cause instanceof RealtimeDeliveryError) {
            this.#reportDeliveryFailure(cause)
          } else {
            throw cause
          }
        }
        if (this.#stop.signal.aborted) return
      }
      if (this.#stop.signal.aborted || this.#providerFailed) return
      if (streamEpoch <= this.#discardedInputEpoch && this.#inputReady !== null) {
        while (!signal.aborted) {
          const ready: Promise<void> = this.#inputReady
          try {
            await ready
            if (ready === this.#inputReady) break
          } catch {
            // Stay fail-closed until another remote disconnect requests a replacement.
            this.#inputChanged.clear()
            if (ready === this.#inputReady) await this.#inputChanged.wait(signal)
          }
        }
        if (this.#stop.signal.aborted) return
      }
      // Reconnect closes the old iterator before connect/observers publish the new session epoch.
      // Join that transition before deciding an ended stream means the provider disappeared.
      await this.#reconnectLock.run(() => Promise.resolve())
      if (this.#stop.signal.aborted || this.#providerFailed) return
      if (this.session.sessionEpoch !== streamEpoch) continue
      if (!received) return
    }
  }

  /**
   * Deliver queued host items whenever something signals there may be work.
   *
   * A delivery failure is reported and the loop continues: one item the provider refused must not
   * take down the loop that would deliver the next one.
   */
  async #deliveryLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      // Raced against the signal, not just checked after: the wait is where this loop spends almost
      // all of its time, and a latch nobody sets again would hold it past shutdown.
      await this.#deliveryReady.wait(signal)
      this.#deliveryReady.clear()
      if (signal.aborted) return
      try {
        await this.flushHostItems()
        // R105: a sync resolution may have made a held batch ready. The drive is reentrancy-safe --
        // it early-returns while a batch is requested or bound.
        await this.driveContinuations()
      } catch (cause) {
        if (cause instanceof RealtimeDeliveryError) {
          this.#reportDeliveryFailure(cause)
        } else {
          throw cause
        }
      }
    }
  }

  /**
   * Ingest one provider event.
   *
   * The shape is a sequence of `if isinstance` blocks in the oracle and stays one here, deliberately:
   * a single event can be several things at once to this layer -- a `ResponseStarted` binds a user
   * origin *and* a semantic acknowledgement *and* a continuation -- so a switch that ran one arm per
   * event would have to duplicate the shared tail.
   *
   * Two events never reach the session at all. A cancel rejection is routed by response ownership:
   * confirmation carriers recover their provider epoch, while every other rejection is the preemptive alert's to
   * arbitrate. A provider error is about the transport rather than the conversation.
   *
   * The tail is the part worth reading twice: after everything an event implies has been recorded,
   * continuations are driven (only if the session accepted it -- a rejected event changed nothing to
   * speak about) and then a delivery pass runs unconditionally, because the floor may have opened even
   * for an event the session refused.
   */
  handleEvent(event: RealtimeProviderEvent): Promise<void> {
    return this.#trackIngress(() => this.#handleEvent(event))
  }

  #trackIngress(action: () => Promise<void>): Promise<void> {
    if (this.#clearingConversation) return Promise.resolve()
    // Register before invoking callbacks so a reentrant clear also joins this handler.
    const operation = Promise.resolve().then(async () => {
      if (!this.#clearingConversation) await action()
    })
    this.#pendingIngress.add(operation)
    void operation.then(
      () => { this.#pendingIngress.delete(operation) },
      () => { this.#pendingIngress.delete(operation) },
    )
    return operation
  }

  async #handleEvent(event: RealtimeProviderEvent): Promise<void> {
    if (event.session_epoch <= this.#discardedInputEpoch) return
    this.#confirmation.syncProjectConfirmationIsolation()
    if (event.kind === 'response_cancel_rejected') {
      if (this.#confirmation.responseIsQuarantined(event.session_epoch, event.response_id)) {
        await this.#confirmation.recoverProjectConfirmationCarrier(
          event.session_epoch,
          event.response_id,
          'cancel_rejected',
        )
        return
      }
      // The provider kept speaking through a preemption. The preemptive-alert arbiter owns it, and it does not reach
      // the session at all: this is about the transport, not the conversation.
      await this.#handlePreemptiveAlertCancelRejected(event)
      return
    }
    if (event.kind === 'provider_error') {
      this.#telemetry?.record('provider.error', {session_epoch: event.session_epoch, code: event.code, recoverable: event.recoverable})
      await this.session.accept(event)
      this.#onDiagnostic(
        `[realtime-diagnostic] provider_error code=${event.code} recoverable=${event.recoverable}`,
      )
      if (event.recoverable) {
        await this.#reconnectProviderSession({
          reason: 'recoverable_provider_error',
          expectedEpoch: this.session.sessionEpoch,
        })
        this.#clearCaptions()
      } else {
        this.#providerFailed = true
        this.#approvalHost.invalidateExecutorApproval('provider_failed')
        this.#host.releaseUrgentOwner()
        this.#host.releasePreemptionAfterFailure()
        this.#stop.abort()
      }
      return
    }

    const approvalEvent = this.#approvalHost.beforeEvent(event)
    if (this.#telemetry !== undefined) {
      if (event.kind === 'response_audio_delta') {
        // First delta only: the metric is time-to-first-audio, and recording every delta would make
        // it a throughput counter instead.
        if (!this.#audioStarted.has(event.response_id)) {
          this.#audioStarted.add(event.response_id)
          this.#telemetry.record('provider.first_audio_delta', {session_epoch: event.session_epoch, response_id: event.response_id})
        }
      } else if (event.kind === 'response_terminal') {
        this.#audioStarted.delete(event.response_id)
      }
    }

    // Captured before `accept`, because a terminal is what *removes* the owner's response and the
    // release below needs to know which owner this terminal belonged to.
    const terminalOwner = event.kind === 'response_terminal'
      ? this.#host.urgentOwnerForResponse(event.session_epoch, event.response_id)
      : null

    // A tool call in a turn that is meant to be waiting for a confirmation is refused before the
    // session sees it: letting it through would have the model acting inside the very turn whose answer
    // it is supposed to be waiting for.
    const confirmTarget = event.kind === 'tool_call_ready' ? this.#confirmation.confirmTarget(event) : null
    const isConfirmationDecision = confirmTarget === 'project'
    const blockedConfirmationTool = event.kind === 'tool_call_ready'
      && this.#confirmation.blocksProjectConfirmationTool(event)
      && !isConfirmationDecision
    const isExecutorApprovalDecision = confirmTarget === 'approval'
    const blockedExecutorApprovalTool = event.kind === 'tool_call_ready'
      && this.#approvalHost.blocksExecutorApprovalTool(event)
      && !isExecutorApprovalDecision
    // An automatic provider may create the response that will emit the confirmation function before VAD reports
    // speech end. That response is an authorization carrier, not an audible assistant turn. Let it
    // acquire an origin while the user still owns the floor, but never bypass the one-shot fence for
    // a stale host-requested confirmation question.
    const {confirmationFencePendingAtStart, confirmationResponseStartsDuringSpeech} = this.#confirmation.beforeEvent(event)
    const accepted = blockedConfirmationTool || blockedExecutorApprovalTool
      ? false
      : await this.session.accept(event, {
          allowResponseStartDuringUserSpeech: confirmationResponseStartsDuringSpeech
            || approvalEvent.responseStartsDuringSpeech
            || approvalEvent.orphanedExecutorRetryCandidate,
        })
    const executorQuarantinedResponse = await this.#approvalHost.afterEventAccepted(event, accepted, approvalEvent)
    this.#confirmation.afterEventAccepted(event, accepted, confirmationFencePendingAtStart, confirmationResponseStartsDuringSpeech)
    if (event.kind === 'response_started' || event.kind === 'response_audio_delta') {
      this.#host.learnPreemptedResponse(event)
      this.#host.recordPreemptiveAlertCancelSent(event.response_id)
    }
    // Unconditional, and before the accepted-only work: a fence receipt is destructive to read, so it
    // has to be consumed on every event or a later one would see a stale interruption.
    this.#host.retireFencedPrestartUrgent()
    if (accepted && (event.kind === 'response_started' || event.kind === 'response_audio_delta')) {
      this.#host.bindUrgentHostResponse(event)
      this.#host.finishPreemptiveAlertFirstAudio(event)
    }

    if (event.kind === 'response_started' && accepted) {
      // Only for a response with no events yet: one that already has them has been bound, and
      // rebinding would take a second user turn for the same response.
      if (this.session.responseEventIds(event.response_id).length === 0) {
        this.#bindResponseUserOrigin(event.session_epoch, event.response_id)
      }
      this.#host.suppressCancelledSemanticAcknowledgement(event.response_id)
      this.#host.bindRequestedSemanticAcknowledgement(event.response_id)
      this.#continuations.bindContinuation(event.response_id)
      this.#continuations.bindToolContinuationOrigin(event.session_epoch, event.response_id)
      this.#confirmation.suppressShadowConfirmationResponse(event.session_epoch, event.response_id)
    }
    if (event.kind === 'response_started') {
      this.#telemetry?.record('provider.response_started', {
        session_epoch: event.session_epoch,
        response_id: event.response_id,
        accepted,
        user_input_revision: this.session.providerTurnUserInputRevision(event.response_id) ?? -1,
        item_id: this.#userOrigins.itemForResponse(
          event.session_epoch,
          event.response_id,
        ) ?? 'none',
      })
    }

    if (event.kind === 'user_speech_started' || event.kind === 'user_speech_ended') {
      this.#telemetry?.record(`provider.${event.kind}`, {session_epoch: event.session_epoch,
        speech_id: event.speech_id, item_id: event.provider_item_id, accepted})
    } else if (event.kind === 'user_transcript_final' || event.kind === 'user_transcript_failed') {
      this.#telemetry?.record(`provider.${event.kind}`, {session_epoch: event.session_epoch,
        item_id: event.item_id, accepted})
    } else if (event.kind === 'response_terminal') {
      this.#telemetry?.record('provider.response_terminal', {session_epoch: event.session_epoch,
        response_id: event.response_id, status: event.status, accepted})
    }

    if (this.#onCaption !== undefined) {
      const caption = this.session.captionFor(
        event,
        event.kind === 'user_transcript_final' ? {accepted} : undefined,
      )
      if (caption !== null) {
        const sourceId='item_id' in event?event.item_id:'response_id' in event?event.response_id:null
        this.#onCaption({...caption,...(typeof sourceId==='string'?{turn_id:`${this.#captionScope}:${event.session_epoch}:${caption.role}:${sourceId}`}:{})})
      }
    }

    if (event.kind === 'user_speech_started' && accepted) {
      this.#intake?.userInputStarted()
      this.#host.acceptUserActivation(event.session_epoch)
      this.#host.revokePreemptiveReconnect()
      // An automatic provider may finish its function call before emitting this turn's transcript final. Do not let
      // that call bind to provider-authored placeholder text or the previous user turn.
      this.#awaitingUserOrigin = true
      this.#userOriginPreexistingResponseId = this.session.activeProviderResponseId
      if (event.provider_item_id !== null) {
        this.#rememberUnboundUserOrigin(
          event.session_epoch,
          this.session.userInputRevision,
          event.provider_item_id,
        )
      }
      this.#approvalHost.noteExecutorApprovalOnsetBeforeContext()
      this.#approvalHost.releaseQuestionOnOnset()
      await this.#approvalHost.reserveExecutorApprovalItem(event.session_epoch, event.provider_item_id)
      this.#confirmation.reserveProjectConfirmation(event)
    }
    if (
      event.kind === 'user_speech_ended'
      && accepted
      && event.provider_item_id !== null
    ) {
      this.#rememberUnboundUserOrigin(
        event.session_epoch,
        this.session.userInputRevision,
        event.provider_item_id,
      )
      await this.#approvalHost.reserveExecutorApprovalItem(event.session_epoch, event.provider_item_id)
      await this.#approvalHost.maybeRequestFreshExecutorApprovalResponse()
    }

    if (event.kind === 'response_yielded' && accepted) {
      this.#audioStarted.delete(event.response_id)
      const generation = this.session.currentGeneration
      if (generation?.response_id === event.response_id && generation.session_epoch === event.session_epoch) {
        this.#onProviderTerminal(generation)
      }
      this.#continuations.finishContinuation({response_id:event.response_id,status:'yielded'})
      this.#continuations.finishOrigin(event.response_id)
    }

    if (event.kind === 'response_terminal' && accepted) {
      this.#approvalHost.noteTerminal(event)
      this.#host.recordPreemptiveAlertCancelTerminal(event)
      const generation = this.session.currentGeneration
      if (
        generation !== null
        && generation.session_epoch === event.session_epoch
        && generation.response_id === event.response_id
      ) {
        this.#onProviderTerminal(generation)
      }
      this.#host.finishSemanticAcknowledgement(event)
      this.#continuations.finishContinuation(event)
      this.#continuations.finishOrigin(event.response_id)
      const itemId = this.#userOrigins.itemForResponse(event.session_epoch, event.response_id)
      if (event.status === 'completed' && itemId !== undefined
        && this.#userOrigins.revisionForItem(event.session_epoch, itemId) === this.session.userInputRevision
        && this.#intakeUser?.localOnsetRevision === this.#localSpeechOnsetRevision) this.#intake?.userResponseCompleted()
      await this.#confirmation.settleTerminal(event, itemId)
      await this.#approvalHost.settleTerminal(event)
      this.#confirmation.clearTerminalShadow(event.session_epoch, itemId)
      // Released only when the terminal is *not* the current generation: if it is, playback is still
      // running and the owner is what keeps the alert's audio attributable.
      if (
        generation?.session_epoch !== event.session_epoch
        || generation.response_id !== event.response_id
      ) {
        this.#host.releaseUrgentHostResponse(terminalOwner)
      }
      this.#host.markPreemptiveAlertReplacementTerminal(terminalOwner)
    }
    if (event.kind === 'response_terminal' && executorQuarantinedResponse) {
      await this.#approvalHost.finishPendingExecutorApprovalResponseQuarantine(
        event.session_epoch,
        event.response_id,
      )
    }

    if (event.kind === 'user_transcript_final') {
      if (accepted) {
        const localOnsetRevision = this.#localSpeechOnsetRevision
        // A delayed final still belongs to its original VAD item, not a newer speech onset.
        const inputRevision = this.#userOrigins.revisionForItem(event.session_epoch, event.item_id)
          ?? this.session.userInputRevision
        this.#host.acceptUserActivation(event.session_epoch)
        if (this.#userOrigins.revisionForItem(event.session_epoch, event.item_id) === undefined) {
          // Some realtime transports can deliver a final transcript without a preceding VAD item id.
          // `RealtimeSession.accept()` has already advanced the exact item as the current user turn;
          // mirror that accepted identity into the evidence ledger rather than dropping the transcript.
          this.#rememberUnboundUserOrigin(
            event.session_epoch,
            this.session.userInputRevision,
            event.item_id,
          )
        }
        await this.#approvalHost.reserveExecutorApprovalItem(event.session_epoch, event.item_id)
        if (event.session_epoch <= this.#discardedInputEpoch) return
        await this.#approvalHost.maybeRequestFreshExecutorApprovalResponse()
        if (event.session_epoch <= this.#discardedInputEpoch) return
        const originRef = await this.#bridge.acceptUserTranscript(event.text)
        if (event.session_epoch <= this.#discardedInputEpoch) return
        this.#notifyAcceptedUserTranscript({
          text: event.text, originRef, sessionEpoch: event.session_epoch, itemId: event.item_id, userInputRevision: inputRevision, ...(event.input_kind==='text'?{confirmed:true}:{}),
        })
        this.#rememberUserOriginRef(event.session_epoch, event.item_id, originRef)
        this.#intakeUser = {text: event.text, origin_ref: originRef, epoch: event.session_epoch, inputRevision, localOnsetRevision}
        this.#intake?.userInputEnded()
        this.#awaitingUserOrigin = this.#userOrigins.hasUnboundRevision(
          event.session_epoch,
          this.session.userInputRevision,
        )
        if (!this.#awaitingUserOrigin) this.#userOriginPreexistingResponseId = null
        await this.#confirmation.afterTranscriptFinal(event, originRef)
      }
    } else if (event.kind === 'user_transcript_failed') {
      if (accepted) {
        // Failed speech is neither cancellation nor authorization. Release an existing
        // proposal's speech hold; unfinished planning stays paused for a valid user turn.
        if (this.#userOrigins.revisionForItem(event.session_epoch, event.item_id) === this.session.userInputRevision) {
          this.#intake?.userInputFailed()
        }
        if (this.#userOrigins.revisionForItem(event.session_epoch, event.item_id) === undefined) {
          this.#rememberUnboundUserOrigin(
            event.session_epoch,
            this.session.userInputRevision,
            event.item_id,
          )
        }
        await this.#approvalHost.reserveExecutorApprovalItem(event.session_epoch, event.item_id)
        await this.#approvalHost.maybeRequestFreshExecutorApprovalResponse()
        // The transcript will never arrive, so anything waiting on it is waiting forever. Released
        // with a null ref: the calls still need an answer, and the bridge refuses them for want of
        // evidence rather than this layer dropping them silently.
        this.#failUserOriginTranscript(event.session_epoch, event.item_id)
        this.#awaitingUserOrigin = this.#userOrigins.hasUnboundRevision(
          event.session_epoch,
          this.session.userInputRevision,
        )
        if (!this.#awaitingUserOrigin) this.#userOriginPreexistingResponseId = null
        await this.#confirmation.afterTranscriptFailed(event)
      }
    } else if (event.kind === 'tool_call_ready') {
      this.#telemetry?.record('tool.call', {
        name: this.#tools.bindings.get(event.name)?.logical_name ?? (event.name === 'confirm' ? 'confirm' : 'unknown'),
        call_id: event.call_id, outcome: accepted ? 'received' : 'rejected',
      })
      if (!accepted) {
        // A refused confirmation tool still owes the provider a terminal result, or the protocol stalls
        // waiting for one that will never come.
        if (blockedConfirmationTool) await this.#confirmation.closeProjectConfirmationTool(event)
        else if (blockedExecutorApprovalTool) await this.#approvalHost.closeExecutorApprovalCarrierTool(event)
        else if (
          isExecutorApprovalDecision
          && event.session_epoch === this.session.sessionEpoch
        ) {
          await this.#approvalHost.handleExecutorApprovalDecision(event, {
            observedProviderResponseId: event.response_id,
            originItemId: null,
            originRef: null,
          })
        }
        return
      }
      await this.#continuations.routeToolCall(event)
    }
    if (event.kind === 'user_transcript_final' || event.kind === 'user_transcript_failed') {
      await this.#confirmation.resumeProjectConfirmationCarrierRecoveryAfterUser()
    }
    if (event.kind === 'response_terminal') {
      this.#confirmation.clearTerminal(event)
      this.#approvalHost.clearTerminal(event)
    }

    if (accepted) await this.driveContinuations()
    await this.#deliveryPass()
  }

  #notifyAcceptedUserTranscript(turn: {
    readonly confirmed?: boolean
    readonly text: string
    readonly originRef: string
    readonly sessionEpoch: number
    readonly itemId: string
    readonly userInputRevision: number
  }): void {
    const callback = this.#onUserTranscriptAccepted
    if (callback === undefined) return
    try {
      void Promise.resolve(callback(turn)).catch(() => {
        this.#onDiagnostic('[realtime-diagnostic] personal_memory_admission_failed')
      })
    } catch {
      this.#onDiagnostic('[realtime-diagnostic] personal_memory_admission_failed')
    }
  }

  /**
   * Wrap a loop so its failure stops the service instead of vanishing.
   *
   * An unobserved rejection in one of three long-lived loops is the worst outcome available: the
   * service would look alive while no longer consuming its provider. A loop that ends *at all*
   * without the service being asked to stop is treated as a failure for the same reason.
   */
  async #guardTask(task: Promise<void>, run: AbortController): Promise<void> {
    try {
      await task
      if (!run.signal.aborted) this.#taskFailed(run)
    } catch (cause) {
      this.#onDiagnostic(`[realtime-diagnostic] task_failure type=${diagnosticName(cause)}`)
      this.#taskFailed(run)
    }
  }

  /**
   * Stop the service because one of its loops ended when it should not have.
   *
   * Scoped to the run that started the task, not to whatever run is current. A task abandoned by an
   * earlier `close` can still resolve later, and without this check it would read the *replacement*
   * controller, find it un-aborted, and take down a service that had already been restarted.
   */
  #taskFailed(run: AbortController): void {
    if (run !== this.#stop) {
      // From a run that is already over. Its outcome cannot bear on the current one.
      this.#onDiagnostic('[realtime-diagnostic] task_failure_from_previous_run')
      return
    }
    this.#providerFailed = true
    this.#approvalHost.invalidateExecutorApproval('task_failed')
    this.#host.releaseFailedDelivery()
    this.#stop.abort()
    this.#deliveryReady.set()
  }

  #reportDeliveryFailure(failure: RealtimeDeliveryError): void {
    this.#onDiagnostic(`[realtime-diagnostic] delivery_failure type=${diagnosticName(failure)}`)
  }

  // ---------------------------------------------------------------------------------------------
  // Family H: binding a tool call to the user turn that justifies it.
  //
  // A tool proposal needs evidence, and the evidence is the user transcript of the turn the model was
  // responding to. The provider does not hand those over together -- An automatic provider can finish a function call
  // before emitting the turn's transcript final -- so the binding is built here from two streams that
  // arrive out of order. Getting it wrong does not fail loudly; it attaches a proposal to the
  // *previous* user turn, which is precisely the kind of citation the origin check exists to stop.
  // ---------------------------------------------------------------------------------------------

  /** Register one provider item against the exact user revision that introduced it. */
  #rememberUnboundUserOrigin(epoch: number, revision: number, itemId: string): void {
    const registered = this.#userOrigins.registerUserItem({epoch, revision, itemId})
    this.#telemetry?.record('user_origin.item_registered', {
      session_epoch: epoch,
      user_input_revision: revision,
      item_id: itemId,
      registered,
    })
  }

  /**
   * Claim only the user item from the revision this provider response captured at open.
   */
  #bindResponseUserOrigin(epoch: number, responseId: string): boolean {
    if (epoch !== this.session.sessionEpoch) {
      this.#recordUserOriginResponseBinding(epoch, responseId, -1, 'epoch_mismatch', 'none')
      return false
    }
    const revision = this.session.providerTurnUserInputRevision(responseId)
    if (revision === undefined) {
      this.#recordUserOriginResponseBinding(epoch, responseId, -1, 'revision_missing', 'none')
      return false
    }
    const origin = this.session.providerResponseOrigin(responseId)
    if (origin !== undefined && (
      origin.kind !== 'user_item'
      || this.#userOrigins.revisionForItem(epoch, origin.item_id) !== revision
      || !this.session.responseMatchesUserItem(responseId, origin.item_id, revision)
    )) {
      this.#recordUserOriginResponseBinding(epoch, responseId, revision, 'provider_origin_mismatch', 'none')
      return false
    }
    const result = this.#userOrigins.bindResponse({epoch, responseId, revision})
    this.#recordUserOriginResponseBinding(
      epoch,
      responseId,
      revision,
      result.status,
      result.status === 'bound' ? result.item_id : 'none',
    )
    this.#awaitingUserOrigin = this.#userOrigins.hasUnboundRevision(
      epoch,
      this.session.userInputRevision,
    )
    if (!this.#awaitingUserOrigin) this.#userOriginPreexistingResponseId = null
    return result.status === 'bound'
  }

  #recordUserOriginResponseBinding(
    epoch: number,
    responseId: string,
    revision: number,
    status: string,
    itemId: string,
  ): void {
    this.#telemetry?.record('user_origin.response_binding', {
      session_epoch: epoch,
      user_input_revision: revision,
      response_id: responseId,
      item_id: itemId,
      status,
      proposal_id: this.#confirmation.proposalId ?? 'none',
      proposal_origin_ref: this.#confirmation.proposalOriginRef ?? 'none',
    })
  }

  /** Record the Memory ref produced by the transcript for this exact provider item. */
  #rememberUserOriginRef(epoch: number, itemId: string, originRef: string): void {
    const resolved = this.#userOrigins.resolveTranscript({epoch, itemId, originRef})
    this.#telemetry?.record('user_origin.transcript_resolution', {
      session_epoch: epoch,
      user_input_revision: this.#userOrigins.revisionForItem(epoch, itemId) ?? -1,
      item_id: itemId,
      origin_ref: originRef,
      status: resolved ? 'resolved' : 'rejected',
    })
  }

  #failUserOriginTranscript(epoch: number, itemId: string): boolean {
    const revision = this.#userOrigins.revisionForItem(epoch, itemId) ?? -1
    const failed = this.#userOrigins.failTranscript(epoch, itemId)
    this.#telemetry?.record('user_origin.transcript_resolution', {
      session_epoch: epoch,
      user_input_revision: revision,
      item_id: itemId,
      origin_ref: 'none',
      status: failed ? 'failed' : 'missing',
    })
    return failed
  }

  /** Same current-user fence for controller actions and direct external MCP effects. */
  #currentUserTurn(event: ToolCallReady, originRef: string | null) {
    const user = this.#intakeUser
    if (event.session_epoch <= this.#discardedInputEpoch || originRef === null || user?.epoch !== event.session_epoch || originRef !== user.origin_ref
      || user.localOnsetRevision !== this.#localSpeechOnsetRevision || user.inputRevision !== this.session.userInputRevision) return null
    const revision = this.session.userInputRevision
    const localOnsetRevision = this.#localSpeechOnsetRevision
    return {originRef, sessionEpoch: event.session_epoch, acceptedUserInputRevision: revision,
      stillWanted: (): boolean => event.session_epoch > this.#discardedInputEpoch
        && this.session.sessionEpoch === event.session_epoch
        && this.session.userInputRevision === revision
        && this.#localSpeechOnsetRevision === localOnsetRevision
        && this.#intakeUser?.origin_ref === originRef}
  }

  // Controlled provider replacement stays here; HostDelivery owns preemption state and deadlines.

  /**
   * The provider refused to cancel, so take the session away from it.
   *
   * The last resort. The provider was asked to stop, said it would not, and the alert is still waiting
   * -- so the whole provider session is replaced under the preemption rather than letting the old turn
   * run to completion. Gated behind the composition-owned reconnect option because it is a heavy remedy for a case
   * that should not happen.
   *
   * `#reconnectLock` before `#deliveryLock`, never the reverse: that order is fixed across this layer,
   * and every replacement path that holds both follows this order.
   *
   * Seven conditions have to hold before the permit is spent. Together they say: this rejection is
   * about *this* preemption, in the current session, for a turn that is still trying to cancel and has
   * not produced anything yet. Anything else and a reconnect would be discarding a session that is
   * working.
   */
  async #handlePreemptiveAlertCancelRejected(event: {
    readonly session_epoch: number
    readonly response_id: string
  }): Promise<void> {
    if (!this.#controlledPreemptiveAlertReconnect) return
    await this.#reconnectLock.run(async () => {
      await this.#host.withDeliveryLock(async () => {
        if (this.#preemptiveAlertHistoryRecovery !== 'none') await this.#runtime.flushMemory?.(true)
        const preemption = this.#host.currentPreemption
        if (
          preemption?.session_epoch !== event.session_epoch
          || preemption.session_epoch !== this.session.sessionEpoch
          || preemption.old_response_id !== event.response_id
          || preemption.reconnect_permit_consumed
          || preemption.reconnect_disallowed
          || this.session.providerTurnPhase(event.response_id) !== 'cancel_requested'
          // A turn that has already produced events has said something to the user; replacing the
          // session under it would lose whatever that was.
          || this.session.responseEventIds(event.response_id).length > 0
        ) {
          return
        }
        const queued = this.#host.findQueuedEvent(preemption.event_id)
        const oldGeneration = preemption.old_generation
        if (queued === undefined || oldGeneration === null) return

        const spent = this.#host.spendReconnectPermit(preemption)
        if (spent.deadline_fired) {
          // The alert already fenced the retained renderer generation. Anchor its uncertainty bound
          // now, before a slow reconnect; ordinary deferred alerts never consume this permit.
          this.#host.startPreemptiveAlertClearDeadline(oldGeneration)
        }
        const oldEpoch = this.session.sessionEpoch
        const history = this.#preemptiveAlertRecoveryHistory()
        try {
          const historyOutcome = await this.session.reconnectForPreemptiveAlert({
            tools: structuredClone(this.#providerSchemas),
            oldGeneration,
            confirmationTimeout: 0.5,
            history,
            historyMode: this.#preemptiveAlertHistoryRecovery,
          })
          this.#host.requireActivation()
          if (this.#preemptiveAlertHistoryRecovery !== 'none') {
            this.#telemetry?.record('guard.history_recovery', {
              arm: this.#preemptiveAlertHistoryRecovery,
              outcome: historyOutcome,
              item_count: history.length,
              pair_count: Math.floor(history.length / 2),
              character_count: history.reduce(
                (total, turn) => total + codePointLengthLikePython(turn.text),
                0,
              ),
            })
          }
          this.#awaitingUserOrigin = false
          this.#userOriginPreexistingResponseId = null
          this.#userOrigins.beginEpoch(this.session.sessionEpoch)
          this.#continuations.clearDeferred()
          this.#host.releaseUrgentHostResponseForEpoch(oldEpoch)
          this.#clearCaptions()
          this.#audioStarted.clear()
          this.#continuations.reconcileToolStateAfterReconnect(oldEpoch)
          this.#host.reopenFailedSemanticAcknowledgements()
          this.#host.reconcileSemanticAcknowledgementsAfterReconnect()
          const current = this.#host.currentPreemption
          // The world may have moved while reconnecting: a replacement preemption, or a user who
          // started speaking and revoked the authority this was borrowing.
          if (current?.token !== spent.token) return
          if (current.reconnect_aborted) {
            this.#host.clearPreemptiveAlert(current.token)
            return
          }
          this.#host.adoptReconnectedPreemption(current)
          await this.#host.deliverCapturedPreemptiveAlertLocked(queued)
        } catch (failure) {
          this.#telemetry?.record('guard.history_recovery_failure', {
            arm: this.#preemptiveAlertHistoryRecovery,
            reason: diagnosticName(failure),
          })
          this.#onDiagnostic(
            `[realtime-diagnostic] preemptive_alert_reconnect_failure type=${diagnosticName(failure)}`,
          )
          // A failed reconnect leaves no working provider and no way to speak the alert. Stopping is
          // the only honest outcome.
          this.#providerFailed = true
          this.#stop.abort()
          this.#deliveryReady.set()
        }
      })
    })
  }

  /** Recent conversation to hand a replacement provider, so it does not start blank. */
  #preemptiveAlertRecoveryHistory(): readonly RecoveryTurn[] {
    if (this.#preemptiveAlertHistoryRecovery === 'none') return []
    const channel = this.#runtime.memory?.channels.get('conversation')
    if (channel === undefined) return []
    const history = projectRecoveryTurns(channel.items, {maxPairs: this.#preemptiveAlertHistoryPairs})
    if (this.#preemptiveAlertHistoryRecovery === 'packed') return packRecoveryTurns(history).turns
    return history
  }

  deliveryState(): DeliverySnapshot {
    return {...this.#host.snapshot(), continuationOrder: this.#continuations.continuationOrder()}
  }

  /**
   * Drive the uncertain-delivery recovery directly.
   *
   * Exposed to test the bounded recovery policy independently of provider receive timing.
   */
  reportUncertainDeliveryForTest(failure: ItemDeliveryUncertainError): Promise<void> {
    return this.#recoverUncertainDelivery(failure)
  }

  /**
   * How many user items are waiting for a response to claim them.
   *
   * The evidence boundary is invisible from outside otherwise: a spent item wrongly re-queued only
   * shows up later, as a tool call admitted against a turn the user has moved past.
   */
  get unboundUserOriginCountForTest(): number {
    return this.#userOrigins.unboundCount
  }

  /**
   * Drive a reconnect directly.
   *
   * The paths that normally reach it -- a recoverable provider error, an uncertain delivery, a full
   * refusal ledger -- each need their own setup, and the reconciliation this performs is worth testing
   * on its own rather than only through one of them.
   */
  reconnectForTest(expectedEpoch?: number): Promise<boolean> {
    return this.#reconnectProviderSession({
      reason: 'test',
      ...(expectedEpoch === undefined ? {} : {expectedEpoch}),
    })
  }

  /** Drive invalidation directly, for the observer-failure case. */
  invalidateProjectConfirmationForTest(reason: string): void {
    this.#confirmation.invalidateProjectConfirmation(reason)
  }

  /** Which response holds which user turn, in binding order. */
  get boundOriginsForTest(): readonly (readonly [string, string])[] {
    return this.#userOrigins.boundResponses
  }

  /** How many responses hold a user turn as their evidence. */
  get boundOriginCountForTest(): number {
    return this.#userOrigins.boundResponseCount
  }

  /** What the provider was handed at connect. Exposed so the copy can be checked, not assumed. */
  get providerSchemasForTest(): readonly Readonly<Record<string, JsonValue>>[] {
    return this.#providerSchemas
  }

  /** Read-only compatibility configuration view. */
  get preemptiveAlertConfiguration(): {
    readonly controlledReconnect: boolean
    readonly historyRecovery: PreemptiveAlertHistoryRecovery
    readonly historyPairs: number
  } {
    return {
      controlledReconnect: this.#controlledPreemptiveAlertReconnect,
      historyRecovery: this.#preemptiveAlertHistoryRecovery,
      historyPairs: this.#preemptiveAlertHistoryPairs,
    }
  }

  /** Existing test compatibility views; production owners communicate through semantic methods. */
  get internals(): {
    readonly reconnectLock: Mutex
    readonly bridge: RealtimeRuntimeBridge
    readonly tools: CompiledTools
    readonly runtime: ServiceRuntime
    readonly idFactory: () => string
    readonly setExecutorState: (state: ExecutorState) => void
  } {
    return {
      reconnectLock: this.#reconnectLock,
      bridge: this.#bridge,
      tools: this.#tools,
      runtime: this.#runtime,
      idFactory: this.#idFactory,
      setExecutorState: (state: ExecutorState) => {
        this.#projection.setExecutorStateForTest(state)
      },
    }
  }
}

/**
 * Whether a promise settled inside the grace period.
 *
 * Rejections propagate -- a provider that refused to close reported something the caller has to see --
 * while a promise that never settles at all resolves to `false` so the caller can say so and move on.
 */
async function resolvedWithin(work: Promise<unknown>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), graceMs)
  })
  try {
    return await Promise.race([work.then(() => true), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Wait for every task, but not forever.
 *
 * Returns how many were still running when the grace period ran out. A JavaScript promise cannot be
 * cancelled the way an asyncio task can, so a loop that ignored its abort signal would make `close`
 * hang -- and a service that never finishes closing is worse than one that names a task it could not
 * stop. Every loop here observes the signal, so reaching the timeout means one is genuinely stuck.
 */
async function settleWithin(tasks: readonly Promise<void>[], graceMs: number): Promise<number> {
  if (tasks.length === 0) return 0
  let outstanding = tasks.length
  const settled = tasks.map(task => task.then(
    () => {
      outstanding -= 1
    },
    () => {
      outstanding -= 1
    },
  ))
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(resolve, graceMs)
  })
  await Promise.race([Promise.all(settled), deadline])
  if (timer !== undefined) clearTimeout(timer)
  return outstanding
}

/** A callback that was not supplied. Named so two of them are not two anonymous empty functions. */
function noop(): void {
  // Intentionally empty: an absent observer is not an error.
}

/** Wrap whatever was thrown so it can be re-thrown as an Error without losing the original. */
function asError(cause: unknown): Error {
  if (cause instanceof Error) return cause
  const wrapped = new Error(`provider close failed: ${String(cause)}`)
  wrapped.cause = cause
  return wrapped
}

function randomHex(): string {
  // 32 hex characters, matching the oracle's `uuid4().hex`.
  return randomUUID().replaceAll('-', '')
}

export type { HostContextItem,PlaybackCompletion }
