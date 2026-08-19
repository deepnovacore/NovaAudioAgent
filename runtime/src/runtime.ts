import type { z } from 'zod'
import { canonicalJson } from './canonical-json.js'
import { VirtualClock } from './clock.js'
import { resolveProactivityPreset } from './config.js'
import {
  FRESH_WINDOW,
  RECENT_LIMIT,
  compileContextView,
  type ContextView,
} from './context-view.js'
import {
  EventQueue,
  type EventInput,
  type EventRecord,
  type JsonValue,
  validProgressSummary,
} from './events.js'
import {
  fixtureExpectedSchema,
  fixtureModelViewSchema,
  type FixtureExpected,
  type RuntimeFixture,
} from './fixtures.js'
import { Floor } from './floor.js'
import { type IdFactory, ScriptedIdFactory } from './ids.js'
import {
  CONVERSATION_CHANNEL,
  USER_PRIORITY,
  Memory,
  applyStructuredUpdate,
  parseMemoryRef,
  type MemoryItem,
} from './memory.js'
import {
  compressorOutputSchema,
  delegateRequestSchema,
  delegateSchema,
  executorHandoffSchema,
  fastBrainOutputSchema,
  surrogateOutputSchema,
  type Delegate,
  type DelegateRequest,
  type ExecutorManifest,
  type FastBrainOutput,
} from './ports.js'
import { PlaybackRegistry } from './playback.js'
import {
  DEFAULT_COOLDOWN,
  SELECTED_WAKE_KIND,
  SuggestionPool,
  isSuggestionAvailable,
} from './suggestions.js'
import {
  SLOTS,
  SlotSet,
  slotSchema,
  wakeReasonSchema,
  type Slot,
  type WakeReason,
} from './slots.js'

type ExecutorEffect = z.infer<typeof fixtureExpectedSchema>['executor_effects'][number]
type FloorDecisionRecord = z.infer<typeof fixtureExpectedSchema>['floor_decisions'][number]
type Diagnostic = z.infer<typeof fixtureExpectedSchema>['diagnostics'][number]
type DesktopEffect = z.infer<typeof fixtureExpectedSchema>['outbound_desktop'][number]
type PlaybackEffect = NonNullable<z.infer<typeof fixtureExpectedSchema>['playback_effects']>[number]
const REJECTED_WAKE_KIND = 'delegate_rejected'

interface WakeTarget {
  readonly slot: Slot
  readonly reason: WakeReason
}

interface ProgressTrigger {
  readonly suggestionId: string
  readonly delegateId: string
}

interface ModelJob {
  readonly jobId: string
  readonly slot: Slot
  readonly reason: WakeReason
  readonly startedAt: number
  readonly seenUserSequence: number
  readonly visibleRefs: ReadonlySet<string>
  readonly offeredSuggestions: ReadonlySet<string>
  readonly selectedSuggestion: string | null
  readonly utteranceId: string | null
  readonly progressTrigger: ProgressTrigger | null
  readonly compression: {
    readonly channel: string
    readonly snapshotCount: number
    readonly items: readonly MemoryItem[]
  } | null
}

interface ScheduledModelCompletion {
  readonly kind: 'model'
  readonly jobId: string
  readonly output: unknown
  readonly due: number
  readonly sequence: number
}

interface ScheduledExecutorCompletion {
  readonly kind: 'executor'
  readonly dispatchIndex: number
  readonly output: unknown
  readonly due: number
  readonly sequence: number
}

type ScheduledFixtureCompletion = ScheduledModelCompletion | ScheduledExecutorCompletion

interface PreparedSpeech {
  readonly decision: 'allow' | 'preempt' | 'defer'
}

export interface ModelCall {
  readonly job_id: string
  readonly slot: Slot
  readonly reason: WakeReason
  readonly started_at: number
  readonly channel?: string
  readonly compression_items?: readonly MemoryItem[]
  readonly context_view?: ContextView
}

export class CoreRuntime {
  readonly queue = new EventQueue()
  readonly memory: Memory
  readonly suggestions: SuggestionPool
  readonly appliedEvents: EventRecord[] = []
  readonly executorEffects: ExecutorEffect[] = []
  readonly floorDecisions: FloorDecisionRecord[] = []
  readonly diagnostics: Diagnostic[] = []
  readonly slots: SlotSet
  readonly #ids: IdFactory
  readonly #manifests = new Map<string, ExecutorManifest>()
  readonly #inFlight = new Map<string, Delegate>()
  readonly #dispatches: Delegate[] = []
  readonly #routableDelegates = new Map<string, Delegate>()
  readonly #terminationKind = new Map<string, 'handoff' | 'deadline'>()
  readonly #terminationOutcome = new Map<string, 'ok' | 'unknown' | 'failed'>()
  readonly #handoffSeen = new Set<string>()
  readonly #fencedDelegates = new Set<string>()
  readonly #retainRoutingHistory: boolean
  readonly #freshWindow: number
  readonly #wiredSlots: ReadonlySet<Slot>
  readonly #onModelCall: ((call: ModelCall) => void) | undefined
  readonly #onExecutorDispatch: ((dispatchIndex: number, delegate: Delegate) => void) | undefined
  readonly #jobs = new Map<string, ModelJob>()
  readonly #results = new Map<string, unknown>()
  readonly #preparedSpeech = new Map<string, PreparedSpeech>()
  readonly #latestProgressSuggestion = new Map<string, string>()
  readonly #latestObservationSuggestion = new Map<string, string>()
  readonly #compressBacklog: string[] = []
  readonly #compressScheduled = new Set<string>()
  #jobSequence = 0
  #utteranceSequence = 0
  floor = new Floor()

  constructor(options: {
    readonly manifests: readonly ExecutorManifest[]
    readonly ids: IdFactory
    readonly modelSlots?: readonly Slot[]
    readonly onModelCall?: (call: ModelCall) => void
    readonly onExecutorDispatch?: (dispatchIndex: number, delegate: Delegate) => void
    readonly retainRoutingHistory?: boolean
    readonly suggestionCooldown?: number
    readonly freshWindow?: number
  }) {
    for (const manifest of options.manifests) this.#manifests.set(manifest.name, manifest)
    this.memory = new Memory({policies: options.manifests.map(manifest => manifest.policy)})
    this.#ids = options.ids
    this.#wiredSlots = new Set(options.modelSlots ?? [])
    this.#onModelCall = options.onModelCall
    this.#onExecutorDispatch = options.onExecutorDispatch
    this.#retainRoutingHistory = options.retainRoutingHistory ?? false
    this.#freshWindow = options.freshWindow ?? FRESH_WINDOW
    this.suggestions = options.suggestionCooldown === undefined
      ? new SuggestionPool()
      : new SuggestionPool({defaultCooldown: options.suggestionCooldown})
    this.slots = new SlotSet((slot, reason) => this.#spawnSlot(slot, reason))
  }

  post(input: EventInput, at: number): EventRecord {
    return this.queue.push(input, at)
  }

  startUserSpeech(speechId: string): void {
    this.floor = this.floor.onUserSpeakStart(speechId)
  }

  endUserSpeech(speechId: string): void {
    this.floor = this.floor.onUserSpeakEnd(speechId)
  }

  startAgentSpeech(utteranceId: string, priority: number): void {
    this.floor = this.floor.onSpeakStart(utteranceId, priority)
  }

  endAgentSpeech(utteranceId: string): void {
    this.floor = this.floor.onSpeakEnd(utteranceId)
  }

  postExecutorCompletion(
    dispatchIndex: number,
    completion: {
      readonly outcome: 'ok' | 'unknown' | 'failed'
      readonly trust: 'trusted_user' | 'trusted_system' | 'untrusted_external'
      readonly content: Readonly<Record<string, JsonValue>>
      readonly refs?: readonly string[]
    },
    at: number,
  ): EventRecord {
    const delegate = this.#dispatches[dispatchIndex]
    if (delegate === undefined) throw new Error(`unknown dispatch index: ${dispatchIndex}`)
    return this.post({
      kind: 'handoff',
      payload: {
        channel: delegate.executor,
        delegate_id: delegate.delegate_id,
        origin_ref: delegate.origin_ref,
        outcome: completion.outcome,
        trust: executorTrust(completion.trust),
        content: structuredClone(completion.content),
        refs: [...(completion.refs ?? [])],
      },
    }, at)
  }

  postExecutorResult(dispatchIndex: number, output: unknown, at: number): EventRecord {
    const parsed = executorHandoffSchema.safeParse(output)
    return this.postExecutorCompletion(dispatchIndex, parsed.success ? parsed.data : {
      outcome: 'unknown',
      trust: 'trusted_system',
      content: {
        error: 'adapter_raised',
        exception: 'ExecutorContractError',
        detail: 'invalid_executor_output',
      },
      refs: [],
    }, at)
  }

  postExecutorProgress(
    dispatchIndex: number,
    progress: {
      readonly phase: 'started' | 'working'
      readonly internal_activity: number
      readonly elapsed: number
      readonly summary: string | null
    },
    at: number,
  ): EventRecord {
    const delegate = this.#dispatches[dispatchIndex]
    if (delegate === undefined) throw new Error(`unknown dispatch index: ${dispatchIndex}`)
    return this.post({
      kind: 'progress',
      payload: {
        channel: delegate.executor,
        delegate_id: delegate.delegate_id,
        op: delegate.op,
        phase: progress.phase,
        internal_activity: progress.internal_activity,
        elapsed: progress.elapsed,
        summary: progress.summary,
      },
    }, at)
  }

  postExecutorObservation(
    dispatchIndex: number,
    observation: {
      readonly trust: 'trusted_user' | 'trusted_system' | 'untrusted_external'
      readonly content: Readonly<Record<string, JsonValue>>
      readonly refs?: readonly string[]
    },
    at: number,
  ): EventRecord {
    const delegate = this.#dispatches[dispatchIndex]
    if (delegate === undefined) throw new Error(`unknown dispatch index: ${dispatchIndex}`)
    return this.post({
      kind: 'observation',
      payload: {
        channel: delegate.executor,
        delegate_id: delegate.delegate_id,
        op: delegate.op,
        origin_ref: delegate.origin_ref,
        trust: executorTrust(observation.trust),
        content: structuredClone(observation.content),
        refs: [...(observation.refs ?? [])],
      },
    }, at)
  }

  completeModelCall(jobId: string, output: unknown, at: number): EventRecord {
    const job = this.#jobs.get(jobId)
    if (job === undefined) throw new Error(`unknown model job: ${jobId}`)
    if (this.#results.has(jobId)) throw new Error(`model job already completed: ${jobId}`)
    if (!Number.isFinite(at) || at < job.startedAt) {
      throw new RangeError(`invalid model completion timestamp: ${at}`)
    }
    this.#results.set(jobId, structuredClone(output))
    if (job.slot === 'compress') {
      if (job.compression === null) throw new Error(`missing compression record: ${jobId}`)
      return this.post({
        kind: 'compress_done',
        payload: {channel: job.compression.channel, job_id: jobId},
      }, at)
    }
    if (job.slot === 'fast') this.#prepareSpeech(job, output, at)
    const completion = this.post({
      kind: 'model_done',
      payload: {slot: job.slot, job_id: jobId},
    }, at)
    const prepared = this.#preparedSpeech.get(jobId)
    if (prepared !== undefined) {
      this.floorDecisions.push({
        event_seq: completion.seq,
        priority: job.reason.priority,
        decision: prepared.decision,
      })
    }
    return completion
  }

  apply(event: EventRecord): WakeReason | null {
    this.appliedEvents.push(event)
    let target: WakeTarget | null = null
    switch (event.kind) {
      case 'user_input': {
        const content: Record<string, JsonValue> = {text: event.payload.text}
        if (event.payload.media_refs !== undefined) {
          content.media_refs = [...event.payload.media_refs]
        }
        const item = this.#appendMemory(CONVERSATION_CHANNEL, {
          ts: event.ts,
          trust: 'trusted_user',
          priority: USER_PRIORITY,
          content,
        })
        this.suggestions.rearmFrom(CONVERSATION_CHANNEL, event.ts)
        target = {
          slot: 'fast',
          reason: wakeReasonSchema.parse({
            kind: 'user_input',
            priority: USER_PRIORITY,
            routing_class: 'user_awaited',
            origin: memoryItemRef(item),
          }),
        }
        break
      }
      case 'handoff': {
        const delegate = this.#applyHandoff(event)
        target = this.#handoffTarget(event, delegate)
        break
      }
      case 'deadline': {
        const delegate = this.#applyDeadline(event)
        target = delegate === undefined ? null : this.#resultTarget(delegate, event.kind)
        break
      }
      case 'progress': {
        const delegate = this.#applyProgress(event)
        const policy = delegate === undefined ? undefined : this.memory.policies.get(delegate.executor)
        if (delegate === undefined || policy === undefined) break
        if (policy.progress_via_surrogate) {
          if (event.payload.phase === 'working' && event.payload.summary !== null) {
            target = {
              slot: 'surrogate.watch',
              reason: wakeReasonSchema.parse({
                kind: event.kind,
                priority: policy.priority,
                routing_class: 'ambient',
                origin: delegate.delegate_id,
              }),
            }
          }
        } else {
          target = this.#resultTarget(delegate, event.kind)
        }
        break
      }
      case 'observation': {
        const delegate = this.#applyObservation(event)
        if (delegate !== undefined && event.payload.content.hit === true) {
          target = this.#resultTarget(delegate, event.kind)
        }
        break
      }
      case 'speak_start':
        this.floor = this.floor.onSpeakStart(event.payload.utterance_id, event.payload.priority)
        break
      case 'speak_end':
        this.floor = this.floor.onSpeakEnd(event.payload.utterance_id)
        break
      case 'compress':
        this.#applyCompress(event)
        target = {
          slot: 'compress',
          reason: wakeReasonSchema.parse({kind: event.kind, priority: 0}),
        }
        break
      case 'model_done':
        this.#applyModelDone(event)
        break
      case 'compress_done':
        this.#applyCompressDone(event)
        break
      case 'assistant_spoken':
        break
      default:
        return exhaustiveEvent(event)
    }
    if (target !== null) this.#wake(target.slot, target.reason)
    return target?.reason ?? null
  }

  consumeFastBrain(output: unknown, reason: WakeReason, eventSequence: number): WakeReason | null {
    return this.#consumeFastBrain(output, reason, eventSequence)
  }

  #consumeFastBrain(
    output: unknown,
    reason: WakeReason,
    eventSequence: number,
    job?: ModelJob,
  ): WakeReason | null {
    const result = fastBrainOutputSchema.safeParse(output)
    if (!result.success) {
      return this.#refuse({
        error: 'model_contract_failure',
        code: 'invalid_fastbrain_output',
        tool_name: null,
      }, reason)
    }
    const parsed = result.data
    this.#consumeSpeech(parsed.speak, reason, eventSequence, job)

    if (parsed.action.act !== 'none' && job !== undefined) {
      const supersededBy = this.#supersedingUserInput(job)
      if (supersededBy !== undefined) {
        this.#dropStaleAction(parsed.action, reason, supersededBy)
        return null
      }
    }

    if (parsed.action.act === 'delegate') {
      return this.#dispatch(parsed.action.delegate, reason, job?.visibleRefs)
    } else if (parsed.action.act === 'update') {
      const result = applyStructuredUpdate(
        this.memory.structured,
        parsed.action.update.target,
        parsed.action.update.delta,
      )
      if (result.ok) {
        this.memory.structured = result.state
      } else {
        const content: Record<string, JsonValue> = {
          error: 'update_rejected',
          target: parsed.action.update.target,
          reason: result.reason,
        }
        if (result.unknown !== undefined) content.unknown = [...result.unknown]
        if (result.fields !== undefined) content.fields = [...result.fields]
        this.#appendMemory(CONVERSATION_CHANNEL, {
          ts: this.appliedEvents.at(-1)?.ts ?? 0,
          trust: 'trusted_system',
          priority: reason.priority,
          content,
          outcome: 'failed',
        })
      }
    }
    return null
  }

  activeDelegates(): readonly Delegate[] {
    return [...this.#inFlight.values()].sort((left, right) => (
      left.dispatched_at - right.dispatched_at || compareStrings(left.delegate_id, right.delegate_id)
    ))
  }

  assertQuiescent(): void {
    for (const slot of SLOTS) {
      if (this.slots.inflight[slot] || this.slots.pending[slot] !== null) {
        throw new Error(`model slot is not quiescent: ${slot}`)
      }
    }
    if (this.#jobs.size > 0 || this.#results.size > 0 || this.#preparedSpeech.size > 0) {
      throw new Error('model jobs remain at quiescence')
    }
    if (this.#compressBacklog.length > 0) throw new Error('compression backlog remains')
  }

  snapshot(): FixtureExpected {
    const channels = Object.fromEntries([...this.memory.channels].map(([name, channel]) => [
      name,
      structuredClone(channel.items),
    ]))
    const summaries = Object.fromEntries([...this.memory.channels].map(([name, channel]) => [
      name,
      channel.summary,
    ]))
    return fixtureExpectedSchema.parse({
      schema_version: 1,
      model_views: [],
      applied_events: this.appliedEvents,
      memory: {
        channels,
        structured: this.memory.structured,
        summaries,
      },
      delegates: this.activeDelegates(),
      suggestions: this.suggestions.all().map(suggestion => ({
        ...suggestion,
        expires_at: Number.isFinite(suggestion.expires_at) ? suggestion.expires_at : null,
      })),
      floor_decisions: this.floorDecisions,
      outbound_desktop: [],
      executor_effects: this.executorEffects,
      diagnostics: this.diagnostics,
    })
  }

  #dispatch(
    request: DelegateRequest,
    reason: WakeReason,
    visibleRefs?: ReadonlySet<string>,
  ): WakeReason | null {
    const result = delegateRequestSchema.safeParse(request)
    if (!result.success) return this.#rejectDelegate(request, 'invalid_delegate_request', reason)
    const parsed = result.data
    const manifest = this.#manifests.get(parsed.executor)
    if (manifest === undefined) return this.#rejectDelegate(parsed, 'unknown_executor', reason)
    const operation = manifest.ops.find(candidate => candidate.name === parsed.op)
    if (operation === undefined) return this.#rejectDelegate(parsed, 'unknown_operation', reason)
    const duplicate = [...this.#inFlight.values()].find(delegate => (
      sameDelegateRequest(delegate, parsed)
    ))
    if (duplicate !== undefined) {
      return this.#rejectDelegate(
        parsed,
        `${duplicate.delegate_id} is already performing the same request`,
        reason,
      )
    }
    if (!operation.readonly) {
      const unresolved = [...this.#routableDelegates.values()].find(delegate => {
        if (this.#fencedDelegates.has(delegate.delegate_id)) return false
        const termination = this.#terminationKind.get(delegate.delegate_id)
        const outcome = this.#terminationOutcome.get(delegate.delegate_id)
        return sameDelegateRequest(delegate, parsed)
          && (termination === 'deadline' || (termination === 'handoff' && outcome === 'unknown'))
      })
      if (unresolved !== undefined) {
        this.#fencedDelegates.add(unresolved.delegate_id)
        if (this.#handoffSeen.has(unresolved.delegate_id) && !this.#retainRoutingHistory) {
          this.#reclaimRouting(unresolved.delegate_id)
        }
        return this.#rejectDelegate(
          parsed,
          `${unresolved.delegate_id} stopped at unknown; verify before retrying`,
          reason,
        )
      }
    }
    const originProblem = this.#originProblem(parsed.origin_ref, visibleRefs)
    if (originProblem !== null) return this.#rejectDelegate(parsed, originProblem, reason)
    const dispatchedAt = this.appliedEvents.at(-1)?.ts ?? 0
    const delegate = delegateSchema.parse({
      ...parsed,
      request: structuredClone(parsed.request),
      delegate_id: this.#ids.next('delegate'),
      deadline: dispatchedAt + operation.deadline_budget,
      routing_class: reason.routing_class,
      dispatched_at: dispatchedAt,
    })
    this.#inFlight.set(delegate.delegate_id, delegate)
    this.#dispatches.push(delegate)
    this.#routableDelegates.set(delegate.delegate_id, delegate)
    this.post({kind: 'deadline', payload: {delegate_id: delegate.delegate_id}}, delegate.deadline)
    // Python's runtime uses one job sequence for model and executor tasks. The
    // executor job id stays private, but reserving it keeps later public
    // model_done ids cross-language exact.
    this.#jobSequence += 1
    this.executorEffects.push({kind: 'dispatch', delegate})
    this.#onExecutorDispatch?.(this.#dispatches.length - 1, delegate)
    return null
  }

  #applyHandoff(event: Extract<EventRecord, {kind: 'handoff'}>): Delegate | undefined {
    const delegate = this.#routableDelegates.get(event.payload.delegate_id)
    const active = delegate === undefined ? undefined : this.#inFlight.get(delegate.delegate_id)
    const previousOutcome = delegate === undefined
      ? undefined
      : this.#terminationOutcome.get(delegate.delegate_id)
    const definitive = event.payload.outcome === 'ok' || event.payload.outcome === 'failed'
    let claimed: Delegate | undefined
    if (
      delegate !== undefined
      && (
        active !== undefined
        || (
          !this.#handoffSeen.has(delegate.delegate_id)
          && this.#terminationKind.get(delegate.delegate_id) === 'deadline'
        )
        || (previousOutcome === 'unknown' && definitive)
      )
    ) {
      claimed = delegate
      this.#handoffSeen.add(delegate.delegate_id)
    }
    if (active !== undefined) {
      this.#inFlight.delete(active.delegate_id)
      this.#terminationKind.set(active.delegate_id, 'handoff')
    }
    if (delegate !== undefined && (active !== undefined || (previousOutcome === 'unknown' && definitive))) {
      this.#terminationOutcome.set(delegate.delegate_id, event.payload.outcome)
    }
    if (delegate !== undefined) {
      this.#latestObservationSuggestion.delete(delegate.delegate_id)
      this.#withdrawProgressSuggestion(delegate.delegate_id)
    }
    const policy = this.memory.policies.get(event.payload.channel)
    if (policy === undefined) throw new Error(`missing policy for handoff: ${event.payload.channel}`)
    const refs = [
      event.payload.origin_ref,
      ...event.payload.refs.filter(reference => reference !== event.payload.origin_ref),
    ]
    const appended = this.#appendMemory(event.payload.channel, {
      ts: event.ts,
      trust: event.payload.trust,
      priority: policy.priority,
      content: event.payload.content,
      outcome: event.payload.outcome,
      refs,
    })
    const explicitMiss = policy.suggest && event.payload.content.hit === false
    if (
      policy.suggest
      && event.payload.outcome === 'ok'
      && !explicitMiss
      && claimed?.executor === event.payload.channel
      && claimed.routing_class === 'ambient'
    ) {
      this.suggestions.add({
        origin: 'executor',
        kind: 'notify',
        content: event.payload.content,
        evidence_refs: [memoryItemRef(appended)],
        salience: policy.priority,
      })
    }
    if (!explicitMiss) this.suggestions.rearmFrom(event.payload.channel, event.ts)
    if (
      claimed !== undefined
      && !this.#retainRoutingHistory
      && (definitive || this.#fencedDelegates.has(claimed.delegate_id))
    ) {
      this.#reclaimRouting(claimed.delegate_id)
    }
    return claimed
  }

  #applyDeadline(event: Extract<EventRecord, {kind: 'deadline'}>): Delegate | undefined {
    const delegate = this.#inFlight.get(event.payload.delegate_id)
    if (delegate === undefined) return undefined
    const policy = this.memory.policies.get(delegate.executor)
    const manifest = this.#manifests.get(delegate.executor)
    const operation = manifest?.ops.find(candidate => candidate.name === delegate.op)
    if (policy === undefined || operation === undefined) {
      throw new Error(`missing bound executor metadata: ${delegate.executor}.${delegate.op}`)
    }
    const sensitive = new Set(operation.sensitive_params)
    const request = Object.fromEntries(Object.entries(delegate.request).map(([key, value]) => [
      key,
      sensitive.has(key) ? '[REDACTED]' : value,
    ]))
    this.#latestObservationSuggestion.delete(delegate.delegate_id)
    this.#withdrawProgressSuggestion(delegate.delegate_id)
    this.#appendMemory(delegate.executor, {
      ts: event.ts,
      trust: 'trusted_system',
      priority: policy.priority,
      content: {error: 'deadline_exceeded', op: delegate.op, request},
      outcome: 'unknown',
      refs: [delegate.origin_ref],
    })
    this.#inFlight.delete(delegate.delegate_id)
    this.#terminationKind.set(delegate.delegate_id, 'deadline')
    this.#terminationOutcome.set(delegate.delegate_id, 'unknown')
    return delegate
  }

  #applyProgress(event: Extract<EventRecord, {kind: 'progress'}>): Delegate | undefined {
    if (!validProgress(event.payload)) return undefined
    const delegate = this.#inFlight.get(event.payload.delegate_id)
    if (delegate?.executor !== event.payload.channel || delegate.op !== event.payload.op) {
      return undefined
    }
    const policy = this.memory.policies.get(delegate.executor)
    if (policy === undefined) return undefined
    const content: Record<string, JsonValue> = {
      op: event.payload.op,
      phase: event.payload.phase,
      internal_activity: event.payload.internal_activity,
      elapsed: event.payload.elapsed,
    }
    if (event.payload.summary !== null) content.summary = event.payload.summary
    const appended = this.#appendMemory(delegate.executor, {
      ts: event.ts,
      trust: 'trusted_system',
      priority: policy.priority,
      content,
      refs: [delegate.origin_ref],
    })
    this.suggestions.rearmFrom(delegate.executor, event.ts)
    if (policy.progress_via_surrogate && event.payload.phase === 'working' && event.payload.summary !== null) {
      this.#withdrawProgressSuggestion(delegate.delegate_id)
      const suggestion = this.suggestions.add({
        origin: 'executor',
        kind: 'notify',
        content: {summary: event.payload.summary},
        evidence_refs: [memoryItemRef(appended)],
        salience: policy.priority,
        expires_at: event.ts + DEFAULT_COOLDOWN,
      })
      this.#latestProgressSuggestion.set(delegate.delegate_id, suggestion.id)
    }
    return delegate
  }

  #applyObservation(event: Extract<EventRecord, {kind: 'observation'}>): Delegate | undefined {
    const delegate = this.#inFlight.get(event.payload.delegate_id)
    if (
      delegate?.executor !== event.payload.channel
      || delegate.op !== event.payload.op
      || delegate.origin_ref !== event.payload.origin_ref
    ) return undefined
    const policy = this.memory.policies.get(delegate.executor)
    if (policy === undefined) return undefined
    const appended = this.#appendMemory(delegate.executor, {
      ts: event.ts,
      trust: event.payload.trust === 'trusted_user' ? 'trusted_system' : event.payload.trust,
      priority: policy.priority,
      content: event.payload.content,
      refs: [
        delegate.origin_ref,
        ...event.payload.refs.filter(reference => reference !== delegate.origin_ref),
      ],
    })
    if (
      event.payload.content.hit === true
      && policy.suggest
      && delegate.routing_class === 'ambient'
    ) {
      const previous = this.#latestObservationSuggestion.get(delegate.delegate_id)
      if (previous !== undefined) this.suggestions.withdraw(previous)
      const suggestion = this.suggestions.add({
        origin: 'executor',
        kind: 'notify',
        content: event.payload.content,
        evidence_refs: [memoryItemRef(appended)],
        salience: policy.priority,
      })
      this.#latestObservationSuggestion.set(delegate.delegate_id, suggestion.id)
    }
    return delegate
  }

  #resultTarget(delegate: Delegate, kind: string, channel = delegate.executor): WakeTarget | null {
    const policy = this.memory.policies.get(channel)
    if (policy === undefined) return null
    const slot: Slot = delegate.routing_class === 'user_awaited'
      ? 'fast'
      : policy.wake === 'fast'
        ? 'fast'
        : 'surrogate.watch'
    return {
      slot,
      reason: wakeReasonSchema.parse({
        kind,
        priority: policy.priority,
        routing_class: delegate.routing_class,
        origin: delegate.delegate_id,
      }),
    }
  }

  #handoffTarget(
    event: Extract<EventRecord, {kind: 'handoff'}>,
    delegate: Delegate | undefined,
  ): WakeTarget | null {
    const policy = this.memory.policies.get(event.payload.channel)
    if (policy === undefined) return null
    if (
      (delegate?.routing_class ?? 'ambient') === 'ambient'
      && policy.suggest
      && event.payload.content.hit === false
    ) return null
    if (delegate !== undefined) {
      const target = this.#resultTarget(delegate, event.kind, event.payload.channel)
      return target
    }
    const slot = policy.wake === 'fast'
      ? 'fast'
      : policy.wake === 'surrogate'
        ? 'surrogate.watch'
        : null
    if (slot === null) return null
    return {
      slot,
      reason: wakeReasonSchema.parse({
        kind: event.kind,
        priority: policy.priority,
        routing_class: 'ambient',
        origin: event.payload.delegate_id,
      }),
    }
  }

  #wake(slot: Slot, reason: WakeReason): void {
    if (!this.#wiredSlots.has(slot)) return
    if (this.#onModelCall === undefined) throw new Error(`model slot is not connected: ${slot}`)
    this.slots.wake(slot, reason)
  }

  #spawnSlot(slot: Slot, reason: WakeReason): string {
    if (this.#onModelCall === undefined) throw new Error(`model slot is not connected: ${slot}`)
    const startedAt = this.appliedEvents.at(-1)?.ts ?? 0
    this.#jobSequence += 1
    const jobId = `job-${this.#jobSequence}`
    let selectedSuggestion: string | null = null
    let utteranceId: string | null = null
    let progressTrigger: ProgressTrigger | null = null
    let compression: ModelJob['compression'] = null

    if (slot === 'fast') {
      this.#utteranceSequence += 1
      utteranceId = `u-${this.#utteranceSequence}`
      selectedSuggestion = this.#checkedSelection(reason.selected_suggestion, startedAt)
    } else if (slot === 'surrogate.watch') {
      progressTrigger = this.#progressTriggerFor(reason, startedAt)
    } else {
      const channel = this.#compressBacklog.shift()
      if (channel === undefined) throw new Error('compression slot spawned without backlog')
      const memoryChannel = this.memory.channels.get(channel)
      if (memoryChannel === undefined) throw new Error(`unknown compression channel: ${channel}`)
      compression = {
        channel,
        snapshotCount: memoryChannel.items.length,
        items: structuredClone(memoryChannel.items),
      }
    }

    const offeredSuggestions = new Set(this.suggestions.all()
      .filter(suggestion => isSuggestionAvailable(suggestion, startedAt))
      .filter(suggestion => {
        if (slot !== 'surrogate.watch') return true
        const latestProgress = new Set(this.#latestProgressSuggestion.values())
        return !latestProgress.has(suggestion.id) || suggestion.id === progressTrigger?.suggestionId
      })
      .map(suggestion => suggestion.id))
    const job: ModelJob = {
      jobId,
      slot,
      reason,
      startedAt,
      seenUserSequence: this.#latestUserSequence(),
      visibleRefs: this.#visibleMemoryRefs(),
      offeredSuggestions,
      selectedSuggestion,
      utteranceId,
      progressTrigger,
      compression,
    }
    this.#jobs.set(jobId, job)
    const contextView = slot === 'compress'
      ? undefined
      : compileContextView(this.memory, this.floor.state, startedAt, {
        inFlight: this.activeDelegates(),
        suggestions: this.suggestions.all().filter(suggestion => offeredSuggestions.has(suggestion.id)),
        manifests: [...this.#manifests.values()],
        selectedSuggestion,
        triggerKind: reason.kind,
        freshWindow: this.#freshWindow,
      })
    this.#onModelCall({
      job_id: jobId,
      slot,
      reason,
      started_at: startedAt,
      ...(compression === null ? {} : {channel: compression.channel}),
      ...(compression === null ? {} : {compression_items: compression.items}),
      ...(contextView === undefined ? {} : {context_view: contextView}),
    })
    return jobId
  }

  #applyModelDone(event: Extract<EventRecord, {kind: 'model_done'}>): void {
    const slot = slotSchema.parse(event.payload.slot)
    if (slot === 'compress') throw new Error(`compress job used model_done: ${event.payload.job_id}`)
    const job = this.#jobs.get(event.payload.job_id)
    if (job?.slot !== slot || !this.#results.has(event.payload.job_id)) {
      throw new Error(`unknown model completion: ${slot}/${event.payload.job_id}`)
    }
    this.slots.onDone(slot, job.jobId, () => {
      const output = this.#results.get(job.jobId)
      this.#results.delete(job.jobId)
      this.#jobs.delete(job.jobId)
      if (slot === 'surrogate.watch') {
        this.#consumeWatch(output, job)
        return
      }
      const compensation = this.#consumeFastBrain(output, job.reason, event.seq, job)
      if (compensation !== null) this.#wake('fast', compensation)
    })
  }

  #consumeWatch(output: unknown, job: ModelJob): void {
    const parsed = surrogateOutputSchema.safeParse(output)
    if (!parsed.success) {
      this.diagnostics.push({code: 'invalid_surrogate_output'})
      this.#settleProgressTrigger(job.progressTrigger, null)
      return
    }
    const selected = parsed.data.speak ? parsed.data.suggestion_id : null
    const suggestion = selected === null ? undefined : this.suggestions.get(selected)
    const valid = suggestion !== undefined
      && job.offeredSuggestions.has(suggestion.id)
      && isSuggestionAvailable(suggestion, this.appliedEvents.at(-1)?.ts ?? job.startedAt)
      ? suggestion
      : undefined
    this.#settleProgressTrigger(job.progressTrigger, valid?.id ?? null)
    if (valid === undefined) return
    this.#wake('fast', wakeReasonSchema.parse({
      kind: SELECTED_WAKE_KIND,
      priority: job.reason.priority,
      routing_class: job.reason.routing_class,
      origin: job.reason.origin,
      selected_suggestion: valid.id,
    }))
  }

  #settleProgressTrigger(trigger: ProgressTrigger | null, selectedId: string | null): void {
    if (trigger === null) return
    if (selectedId !== trigger.suggestionId) this.suggestions.withdraw(trigger.suggestionId)
    if (this.#latestProgressSuggestion.get(trigger.delegateId) === trigger.suggestionId) {
      this.#latestProgressSuggestion.delete(trigger.delegateId)
    }
  }

  #applyCompress(event: Extract<EventRecord, {kind: 'compress'}>): void {
    if (!this.#wiredSlots.has('compress') || this.#compressScheduled.has(event.payload.channel)) return
    if (!this.memory.channels.has(event.payload.channel)) {
      throw new Error(`unknown compression channel: ${event.payload.channel}`)
    }
    this.#compressScheduled.add(event.payload.channel)
    this.#compressBacklog.push(event.payload.channel)
  }

  #applyCompressDone(event: Extract<EventRecord, {kind: 'compress_done'}>): void {
    const job = this.#jobs.get(event.payload.job_id)
    if (
      job?.slot !== 'compress'
      || job.compression?.channel !== event.payload.channel
      || !this.#results.has(event.payload.job_id)
    ) throw new Error(`unknown compression completion: ${event.payload.job_id}`)

    this.slots.onDone('compress', job.jobId, () => {
      const output = this.#results.get(job.jobId)
      this.#results.delete(job.jobId)
      this.#jobs.delete(job.jobId)
      this.#compressScheduled.delete(event.payload.channel)
      const parsed = compressorOutputSchema.safeParse(output)
      const summary = parsed.success && parsed.data.channel === event.payload.channel
        ? parsed.data.summary.trim()
        : ''
      if (!parsed.success || parsed.data.channel !== event.payload.channel) {
        this.diagnostics.push({code: 'invalid_compressor_output'})
      }
      const channel = this.memory.channels.get(event.payload.channel)
      if (channel === undefined || job.compression === null) return
      if (summary.length > 0) {
        channel.summary = summary
        channel.uncompressed = Math.max(0, channel.uncompressed - job.compression.snapshotCount)
        const policy = this.memory.policies.get(event.payload.channel)
        if (policy !== undefined && channel.uncompressed >= policy.compress_watermark) {
          this.#compressScheduled.add(event.payload.channel)
          this.#compressBacklog.push(event.payload.channel)
        }
      }
    })
    this.#continueCompression()
  }

  #continueCompression(): void {
    if (this.#compressBacklog.length === 0 || this.slots.inflight.compress) return
    this.#wake('compress', wakeReasonSchema.parse({kind: 'compress', priority: 0}))
  }

  #appendMemory(channel: string, input: Parameters<Memory['append']>[1]): MemoryItem {
    const item = this.memory.append(channel, input)
    const target = this.memory.channels.get(channel)
    const policy = this.memory.policies.get(channel)
    if (
      target !== undefined
      && policy !== undefined
      && this.#wiredSlots.has('compress')
      && target.uncompressed >= policy.compress_watermark
      && !this.#compressScheduled.has(channel)
    ) {
      this.#compressScheduled.add(channel)
      this.#compressBacklog.push(channel)
      this.post({kind: 'compress', payload: {channel}}, input.ts)
    }
    return item
  }

  #withdrawProgressSuggestion(delegateId: string): void {
    const suggestionId = this.#latestProgressSuggestion.get(delegateId)
    if (suggestionId === undefined) return
    this.#latestProgressSuggestion.delete(delegateId)
    this.suggestions.withdraw(suggestionId)
  }

  #progressTriggerFor(reason: WakeReason, now: number): ProgressTrigger | null {
    if (reason.kind !== 'progress' || reason.origin === null) return null
    const delegate = this.#inFlight.get(reason.origin)
    const suggestionId = this.#latestProgressSuggestion.get(reason.origin)
    const suggestion = suggestionId === undefined ? undefined : this.suggestions.get(suggestionId)
    if (suggestion !== undefined && !isSuggestionAvailable(suggestion, now)) {
      this.#latestProgressSuggestion.delete(reason.origin)
      return null
    }
    if (
      delegate === undefined
      || suggestion?.evidence_refs.length !== 1
      || !suggestion.evidence_refs[0]!.startsWith(`${delegate.executor}:`)
    ) return null
    return {suggestionId: suggestion.id, delegateId: delegate.delegate_id}
  }

  #consumeSpeech(
    speak: FastBrainOutput['speak'],
    reason: WakeReason,
    eventSequence: number,
    job?: ModelJob,
  ): void {
    if (speak.act === 'none' || speak.text.length === 0) return
    const prepared = job === undefined ? undefined : this.#preparedSpeech.get(job.jobId)
    if (job !== undefined) this.#preparedSpeech.delete(job.jobId)
    const decision = prepared?.decision ?? this.floor.decide(reason.priority)
    if (prepared === undefined) {
      this.floorDecisions.push({event_seq: eventSequence, priority: reason.priority, decision})
    }
    const now = this.appliedEvents.at(-1)?.ts ?? 0
    const utteranceId = job?.utteranceId ?? `u-${eventSequence}`
    if (decision === 'defer') {
      if (job?.selectedSuggestion === null || job === undefined) {
        this.suggestions.add({
          origin: 'fast_brain',
          kind: speak.act === 'ask' ? 'question' : 'notify',
          content: {text: speak.text, utterance_id: utteranceId},
          salience: reason.priority,
        })
      }
      return
    }
    this.#appendMemory(CONVERSATION_CHANNEL, {
      ts: now,
      trust: 'trusted_system',
      priority: USER_PRIORITY,
      content: {text: speak.text, utterance_id: utteranceId},
    })
    if (job?.selectedSuggestion !== null && job?.selectedSuggestion !== undefined) {
      this.suggestions.fire(job.selectedSuggestion, now)
    } else if (speak.act === 'ask') {
      const asked = this.suggestions.add({
        origin: 'fast_brain',
        kind: 'question',
        content: {text: speak.text, utterance_id: utteranceId},
        salience: reason.priority,
      })
      this.suggestions.fire(asked.id, now)
    }
  }

  #prepareSpeech(job: ModelJob, output: unknown, at: number): void {
    const parsed = fastBrainOutputSchema.safeParse(output)
    if (!parsed.success || parsed.data.speak.act === 'none' || parsed.data.speak.text.length === 0) {
      return
    }
    const decision = this.floor.decide(job.reason.priority)
    this.#preparedSpeech.set(job.jobId, {decision})
    if (decision === 'defer' || job.utteranceId === null) return
    this.post({
      kind: 'speak_start',
      payload: {utterance_id: job.utteranceId, priority: job.reason.priority},
    }, at)
    this.floor = this.floor.onSpeakStart(job.utteranceId, job.reason.priority)
    this.post({kind: 'speak_end', payload: {utterance_id: job.utteranceId}}, at)
  }

  #checkedSelection(suggestionId: string | null, now: number): string | null {
    if (suggestionId === null) return null
    const suggestion = this.suggestions.get(suggestionId)
    return suggestion !== undefined && isSuggestionAvailable(suggestion, now)
      ? suggestionId
      : null
  }

  #supersedingUserInput(job: ModelJob): MemoryItem | undefined {
    return [...(this.memory.channels.get(CONVERSATION_CHANNEL)?.items ?? [])]
      .filter(item => item.seq > job.seenUserSequence && item.trust === 'trusted_user')
      .at(-1)
  }

  #dropStaleAction(
    action: FastBrainOutput['action'],
    reason: WakeReason,
    supersededBy: MemoryItem,
  ): void {
    if (action.act === 'none') return
    const content: Record<string, JsonValue> = {
      error: 'action_superseded',
      act: action.act,
      by: memoryItemRef(supersededBy),
    }
    if (action.act === 'delegate') {
      content.executor = action.delegate.executor
      content.op = action.delegate.op
    }
    this.#appendMemory(CONVERSATION_CHANNEL, {
      ts: this.appliedEvents.at(-1)?.ts ?? 0,
      trust: 'trusted_system',
      priority: reason.priority,
      content,
      outcome: 'failed',
      refs: [memoryItemRef(supersededBy)],
    })
  }

  #latestUserSequence(): number {
    return [...(this.memory.channels.get(CONVERSATION_CHANNEL)?.items ?? [])]
      .filter(item => item.trust === 'trusted_user')
      .at(-1)?.seq ?? 0
  }

  #visibleMemoryRefs(): ReadonlySet<string> {
    return new Set([...this.memory.channels.values()]
      .flatMap(channel => channel.items.slice(-RECENT_LIMIT).map(item => memoryItemRef(item))))
  }

  #rejectDelegate(request: DelegateRequest, problem: string, reason: WakeReason): WakeReason | null {
    return this.#refuse({
      error: 'delegate_rejected',
      problem,
      executor: boundedModelText(request.executor),
      op: boundedModelText(request.op),
      origin_ref: boundedModelText(request.origin_ref),
    }, reason)
  }

  #reclaimRouting(delegateId: string): void {
    this.#routableDelegates.delete(delegateId)
    this.#terminationKind.delete(delegateId)
    this.#terminationOutcome.delete(delegateId)
    this.#handoffSeen.delete(delegateId)
    this.#fencedDelegates.delete(delegateId)
  }

  #refuse(content: Readonly<Record<string, JsonValue>>, reason: WakeReason): WakeReason | null {
    this.#appendMemory(CONVERSATION_CHANNEL, {
      ts: this.appliedEvents.at(-1)?.ts ?? 0,
      trust: 'trusted_system',
      priority: reason.priority,
      content,
      outcome: 'failed',
    })
    if (reason.kind === REJECTED_WAKE_KIND) return null
    return wakeReasonSchema.parse({
      kind: REJECTED_WAKE_KIND,
      priority: reason.priority,
      routing_class: reason.routing_class,
    })
  }

  #memoryItemExists(reference: string): boolean {
    try {
      const [channel, sequence] = parseMemoryRef(reference)
      return this.memory.channels.get(channel)?.items[sequence - 1] !== undefined
    } catch {
      return false
    }
  }

  #originProblem(reference: string, visibleRefs?: ReadonlySet<string>): string | null {
    try {
      parseMemoryRef(reference)
    } catch {
      return 'invalid_origin_ref'
    }
    if (!this.#memoryItemExists(reference)) return 'origin_not_found'
    if (visibleRefs !== undefined && !visibleRefs.has(reference)) return 'origin_not_visible'
    return null
  }
}

export function runRuntimeFixture(
  fixture: RuntimeFixture,
  manifestRegistry: readonly ExecutorManifest[],
): FixtureExpected {
  const enabled = new Set(fixture.input.configuration.enabled_executors)
  const manifests = manifestRegistry.filter(manifest => enabled.has(manifest.name))
  if (manifests.length !== enabled.size) {
    const found = new Set(manifests.map(manifest => manifest.name))
    const missing = [...enabled].filter(name => !found.has(name))
    throw new Error(`fixture executors are not registered: ${missing.join(', ')}`)
  }
  const clock = new VirtualClock(fixture.input.initial_clock)
  const ids = new ScriptedIdFactory(fixture.input.id_sequences)
  const scripts = {
    fast: [...fixture.input.ports.fastbrain],
    'surrogate.watch': [...fixture.input.ports.surrogate],
    compress: [...fixture.input.ports.compressor],
  }
  const executorScripts = Object.fromEntries(Object.entries(fixture.input.ports.executors ?? {}).map(
    ([name, completions]) => [name, [...completions]],
  ))
  for (const name of Object.keys(executorScripts)) {
    if (!enabled.has(name)) throw new Error(`scripted executor is not enabled: ${name}`)
  }
  const scheduler = new FixtureModelScheduler()
  const outboundDesktop: DesktopEffect[] = []
  const playbackEffects: PlaybackEffect[] = []
  const modelViews: z.infer<typeof fixtureModelViewSchema>[] = []
  const playback = new PlaybackRegistry({
    idFactory: () => ids.next('playback'),
    onFrame: frame => outboundDesktop.push({
      kind: 'audio_frame',
      data: {
        utterance_id: frame.utterance_id,
        generation_epoch: frame.generation_epoch,
        sequence: frame.sequence,
        pcm_base64: Buffer.from(frame.pcm).toString('base64'),
      },
    }),
    onClear: (utteranceId, generationEpoch) => outboundDesktop.push({
      kind: 'audio_clear',
      data: {utterance_id: utteranceId, generation_epoch: generationEpoch},
    }),
    onAlert: (utteranceId, generationEpoch) => outboundDesktop.push({
      kind: 'audio_alert',
      data: {utterance_id: utteranceId, generation_epoch: generationEpoch},
    }),
  })
  const proactivity = resolveProactivityPreset(fixture.input.configuration.proactivity_preset)
  const runtime = new CoreRuntime({
    manifests,
    ids,
    modelSlots: SLOTS,
    retainRoutingHistory: true,
    suggestionCooldown: proactivity.cooldown,
    freshWindow: proactivity.fresh_window,
    onModelCall: call => {
      if (call.context_view !== undefined) {
        modelViews.push(fixtureModelViewSchema.parse({
          slot: call.slot,
          view: call.context_view,
        }))
      }
      const completion = scripts[call.slot].shift()
      if (completion === undefined) throw new Error(`missing scripted ${call.slot} output`)
      scheduler.schedule(
        call.job_id,
        completion.output,
        call.started_at + completion.delay,
      )
    },
    onExecutorDispatch: (dispatchIndex, delegate) => {
      if (!Object.hasOwn(executorScripts, delegate.executor)) return
      const completion = executorScripts[delegate.executor]!.shift()
      if (completion === undefined) {
        throw new Error(`missing scripted ${delegate.executor} output`)
      }
      scheduler.scheduleExecutor(
        dispatchIndex,
        completion.output,
        delegate.dispatched_at + completion.delay,
      )
    },
  })
  const stimuli = fixture.input.stimuli
    .map((stimulus, index) => ({stimulus, index}))
    .sort((left, right) => left.stimulus.at - right.stimulus.at || left.index - right.index)

  let offset = 0
  while (offset < stimuli.length) {
    const at = stimuli[offset]!.stimulus.at
    advanceBefore(clock, runtime, scheduler, at)
    clock.advanceTo(at)
    const group = []
    while (offset < stimuli.length && stimuli[offset]!.stimulus.at === at) {
      group.push(stimuli[offset]!.stimulus)
      offset += 1
    }
    for (const stimulus of group) {
      if (stimulus.kind === 'playback_open') {
        const generation = playback.openResponse({
          sessionEpoch: stimulus.session_epoch,
          responseId: stimulus.response_id,
        })
        playbackEffects.push({kind: 'open', generation})
      } else if (stimulus.kind === 'playback_audio') {
        playback.pushAudio({
          sessionEpoch: stimulus.session_epoch,
          responseId: stimulus.response_id,
          pcm: decodeFixturePcm(stimulus.pcm_base64),
        })
      } else if (stimulus.kind === 'playback_transcript') {
        playback.setTranscript({
          sessionEpoch: stimulus.session_epoch,
          responseId: stimulus.response_id,
          text: stimulus.text,
        })
      } else if (stimulus.kind === 'playback_terminal') {
        playback.markProviderTerminal({
          sessionEpoch: stimulus.session_epoch,
          responseId: stimulus.response_id,
          disposition: stimulus.disposition,
        })
      } else if (stimulus.kind === 'playback_start') {
        const accepted = playback.markStarted(stimulus.utterance_id, stimulus.generation_epoch)
        playbackEffects.push({
          kind: 'ack',
          ack: 'started',
          utterance_id: stimulus.utterance_id,
          generation_epoch: stimulus.generation_epoch,
          accepted,
          completion: null,
        })
      } else if (stimulus.kind === 'playback_fence_current') {
        playback.fenceCurrent({alert: stimulus.alert})
      } else if (stimulus.kind === 'playback_cleared') {
        const completion = playback.recordCleared(
          stimulus.utterance_id,
          stimulus.generation_epoch,
          stimulus.played_ms,
        )
        playbackEffects.push({
          kind: 'ack',
          ack: 'cleared',
          utterance_id: stimulus.utterance_id,
          generation_epoch: stimulus.generation_epoch,
          accepted: completion !== null,
          completion,
        })
      } else if (stimulus.kind === 'playback_done') {
        const completion = playback.ackDone(
          stimulus.utterance_id,
          stimulus.generation_epoch,
          stimulus.played_ms,
        )
        playbackEffects.push({
          kind: 'ack',
          ack: 'done',
          utterance_id: stimulus.utterance_id,
          generation_epoch: stimulus.generation_epoch,
          accepted: completion !== null,
          completion,
        })
      } else if (stimulus.kind === 'floor_user_start') {
        runtime.startUserSpeech(stimulus.speech_id)
      } else if (stimulus.kind === 'floor_user_end') {
        runtime.endUserSpeech(stimulus.speech_id)
      } else if (stimulus.kind === 'floor_agent_start') {
        runtime.startAgentSpeech(stimulus.utterance_id, stimulus.priority)
      } else if (stimulus.kind === 'floor_agent_end') {
        runtime.endAgentSpeech(stimulus.utterance_id)
      } else if (stimulus.kind === 'user_input') {
        runtime.post({
          kind: 'user_input',
          payload: stimulus.media_refs === undefined
            ? {text: stimulus.text}
            : {text: stimulus.text, media_refs: stimulus.media_refs},
        }, at)
      } else if (stimulus.kind === 'executor_complete') {
        runtime.postExecutorCompletion(stimulus.dispatch_index, stimulus, at)
      } else if (stimulus.kind === 'executor_progress') {
        runtime.postExecutorProgress(stimulus.dispatch_index, stimulus, at)
      } else if (stimulus.kind === 'executor_observation') {
        runtime.postExecutorObservation(stimulus.dispatch_index, stimulus, at)
      } else if (stimulus.kind === 'raw_progress') {
        runtime.post({
          kind: 'progress',
          payload: {
            channel: stimulus.channel,
            delegate_id: stimulus.delegate_id,
            op: stimulus.op,
            phase: stimulus.phase,
            internal_activity: stimulus.internal_activity,
            elapsed: stimulus.elapsed,
            summary: stimulus.summary,
          },
        }, at)
      } else if (stimulus.kind === 'raw_observation') {
        runtime.post({
          kind: 'observation',
          payload: {
            channel: stimulus.channel,
            delegate_id: stimulus.delegate_id,
            op: stimulus.op,
            origin_ref: stimulus.origin_ref,
            trust: stimulus.trust,
            content: stimulus.content,
            refs: stimulus.refs,
          },
        }, at)
      }
      if (stimulus.kind !== 'advance_clock') drainReady(clock, runtime, scheduler)
    }
    for (const stimulus of group) {
      if (stimulus.kind === 'advance_clock') {
        advanceBefore(clock, runtime, scheduler, stimulus.to)
        clock.advanceTo(stimulus.to)
      }
    }
  }

  while (runtime.queue.size > 0 || scheduler.size > 0) {
    const next = earliest(runtime.queue.nextTimestamp(), scheduler.nextTimestamp())
    if (next === undefined) break
    advanceAndDrain(clock, runtime, scheduler, next)
  }
  for (const slot of SLOTS) {
    if (scripts[slot].length > 0) {
      throw new Error(`unused ${slot} outputs: ${scripts[slot].length}`)
    }
  }
  for (const [name, completions] of Object.entries(executorScripts)) {
    if (completions.length > 0) throw new Error(`unused ${name} outputs: ${completions.length}`)
  }
  runtime.assertQuiescent()
  ids.assertExhausted()
  const snapshot = runtime.snapshot()
  return fixtureExpectedSchema.parse({
    ...snapshot,
    model_views: modelViews,
    outbound_desktop: outboundDesktop,
    ...(playbackEffects.length === 0 ? {} : {playback_effects: playbackEffects}),
  })
}

function decodeFixturePcm(value: string): Uint8Array {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.byteLength === 0 || decoded.toString('base64') !== value) {
    throw new Error('fixture PCM must use canonical non-empty base64')
  }
  return decoded
}

function advanceBefore(
  clock: VirtualClock,
  runtime: CoreRuntime,
  scheduler: FixtureModelScheduler,
  target: number,
): void {
  if (target < clock.now()) throw new RangeError(`fixture clock cannot move backwards: ${target}`)
  while (true) {
    const next = earliest(runtime.queue.nextTimestamp(), scheduler.nextTimestamp())
    if (next === undefined || next >= target) return
    clock.advanceTo(next)
    drainReady(clock, runtime, scheduler)
  }
}

function advanceAndDrain(
  clock: VirtualClock,
  runtime: CoreRuntime,
  scheduler: FixtureModelScheduler,
  target: number,
): void {
  if (target < clock.now()) throw new RangeError(`fixture clock cannot move backwards: ${target}`)
  while (true) {
    const next = earliest(runtime.queue.nextTimestamp(), scheduler.nextTimestamp())
    if (next === undefined || next > target) break
    clock.advanceTo(next)
    drainReady(clock, runtime, scheduler)
  }
  clock.advanceTo(target)
  drainReady(clock, runtime, scheduler)
}

function drainReady(
  clock: VirtualClock,
  runtime: CoreRuntime,
  scheduler: FixtureModelScheduler,
): void {
  while (true) {
    scheduler.materializeDue(clock.now(), runtime)
    const event = runtime.queue.popReady(clock.now())
    if (event === undefined) return
    runtime.apply(event)
  }
}

class FixtureModelScheduler {
  readonly #pending: ScheduledFixtureCompletion[] = []
  #sequence = 0

  schedule(jobId: string, output: unknown, due: number): void {
    if (!Number.isFinite(due)) throw new TypeError(`model completion timestamp is invalid: ${due}`)
    this.#sequence += 1
    this.#pending.push({
      kind: 'model',
      jobId,
      output: structuredClone(output),
      due,
      sequence: this.#sequence,
    })
    this.#sort()
  }

  scheduleExecutor(dispatchIndex: number, output: unknown, due: number): void {
    if (!Number.isFinite(due)) throw new TypeError(`executor completion timestamp is invalid: ${due}`)
    this.#sequence += 1
    this.#pending.push({
      kind: 'executor',
      dispatchIndex,
      output: structuredClone(output),
      due,
      sequence: this.#sequence,
    })
    this.#sort()
  }

  #sort(): void {
    this.#pending.sort((left, right) => left.due - right.due || left.sequence - right.sequence)
  }

  materializeDue(now: number, runtime: CoreRuntime): void {
    while (this.#pending[0]?.due !== undefined && this.#pending[0].due <= now) {
      const completion = this.#pending.shift()!
      if (completion.kind === 'model') {
        runtime.completeModelCall(completion.jobId, completion.output, completion.due)
      } else {
        runtime.postExecutorResult(completion.dispatchIndex, completion.output, completion.due)
      }
    }
  }

  nextTimestamp(): number | undefined {
    return this.#pending[0]?.due
  }

  get size(): number {
    return this.#pending.length
  }
}

function earliest(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.min(left, right)
}

function memoryItemRef(item: MemoryItem): string {
  return `${item.channel}:${item.seq}`
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sameDelegateRequest(left: Delegate, right: DelegateRequest): boolean {
  return left.executor === right.executor
    && left.op === right.op
    && canonicalJson(left.request) === canonicalJson(right.request)
}

function boundedModelText(value: string): string {
  return [...value].slice(0, 128).join('')
}

function executorTrust(
  trust: 'trusted_user' | 'trusted_system' | 'untrusted_external',
): 'trusted_system' | 'untrusted_external' {
  return trust === 'untrusted_external' ? trust : 'trusted_system'
}

function validProgress(payload: Extract<EventRecord, {kind: 'progress'}>['payload']): boolean {
  if (payload.phase !== 'started' && payload.phase !== 'working') return false
  if (payload.phase === 'started') {
    return payload.internal_activity === 0 && validProgressSummary(payload.summary, payload.phase)
  }
  if (payload.internal_activity < 1 || payload.internal_activity > 1_048_576) return false
  return validProgressSummary(payload.summary, payload.phase)
}

function exhaustiveEvent(value: never): never {
  throw new Error(`unhandled event: ${String(value)}`)
}
