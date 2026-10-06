import { canonicalJson } from '../text/canonical-json.js';
import type { Clock } from '../core/clock.js';
import type { CodingProgressNarrationState } from './coding-progress-narration.js';
import { codingProgressSummary } from './coding-progress-narration.js';
import { validProgressSummary,type EventRecord,type JsonValue } from '../core/events.js';
import { isMonitorPolicy,isPreemptiveMonitorAlert,monitorAlertDelivery,parseMemoryRef } from '../core/memory.js';
import { stripLikePython } from '../text/python-text.js';
import type { WakeReason } from '../core/slots.js';
import type { Suggestion } from '../core/suggestions.js';
import { finalSpeechView,genericFinalSpeechView,type CodingChannel } from './evidence.js';
import type {
HostResponseIntent, HostWorkSource
} from './protocol.js';
import type { DelegateLike,ExecutorManifestLike,HostItemOptions,ServiceRuntime } from './service-ports.js';
import {
HIT_ALERT_MIN_PRIORITY,
MAX_HOST_FACT_CHARS,
PREEMPT_MIN_PRIORITY,
PROGRESS_HOST_ITEM_TTL_S,diagnosticName,hostFactIntent,type ExecutorState
} from './service-state.js';
import { activeExecutorContextData } from './session-state.js';
import { type RealtimeSession } from './session.js';
import { SPEECH_FINAL_LIMIT,prepareForSpeech } from './speech-prep.js';
import type { RealtimeTelemetry } from './telemetry.js';

function suggestionSpeechView(content: Readonly<Record<string, JsonValue>>): string {
  for (const key of ['observation', 'summary', 'message'] as const) {
    const value = content[key]
    if (typeof value === 'string' && stripLikePython(value) !== '') {
      return prepareForSpeech(value, {limit: SPEECH_FINAL_LIMIT}).text
    }
  }
  return '有一条新的提醒'
}

function monitorHitSpeechView(content: Readonly<Record<string, JsonValue>>): string {
  for (const key of ['observation', 'summary', 'message'] as const) {
    const value = content[key]
    if (typeof value === 'string' && stripLikePython(value) !== '') {
      return prepareForSpeech(`检测到了：${stripLikePython(value)}`, {
        limit: SPEECH_FINAL_LIMIT,
      }).text
    }
  }
  return '检测到了，提醒条件已经满足。'
}

interface ProviderProjectionPorts {
 readonly session: RealtimeSession
 readonly runtime: ServiceRuntime
 readonly clock: Clock
 readonly coding: CodingChannel | null
 readonly generatePlan?: boolean
 readonly codingProgressNarration: CodingProgressNarrationState
 readonly telemetry: RealtimeTelemetry | undefined
 readonly idFactory: () => string
 queueHostItem(intent: HostResponseIntent, options?: HostItemOptions): void
 readonly agentNameForChannel: (channel: string) => string | null
 readonly clearingConversation: () => boolean
 readonly onActiveWorkChanged: () => void
 readonly preparing: () => boolean
 readonly taskOwnsWork?: (workId: string) => boolean
 readonly onExecutorState: (state: ExecutorState) => void
 readonly onDiagnostic: (line: string) => void
 resolveSyncResult(event: Extract<EventRecord, {kind: 'handoff'}>): boolean
 expireSyncResult(event: Extract<EventRecord, {kind: 'deadline'}>): boolean
 hasSemanticAcknowledgement(id: string): boolean
 fenceSemanticAcknowledgement(delegateId: string): void
 retireDelegateHostEvents(delegateId: string): void
 rememberDelegateHostEvent(delegateId: string, eventId: string): void
 rememberCodingProgressHostEvent(eventId: string): void
 coalesceCodingProgress(): void
}

export class ProviderProjection {

  executorDisplayName(channel: string): string {
    const agent = this.ports.agentNameForChannel(channel)
    if (agent !== null) return agent
    const manifest = this.ports.runtime.executors.get(channel)?.manifest
    if (manifest !== undefined && isMonitorPolicy(manifest.policy)) {
      return monitorAlertDelivery(manifest.policy) === 'deferred' ? '观察' : '监控'
    }
    return manifest?.display_name ?? channel
  }

  /** A channel's manifest priority, or the default when there is no manifest for it. */
  executorPriority(channel: string | null): number {
    if (channel === null) return 50
    return this.ports.runtime.executors.get(channel)?.manifest.policy.priority ?? 50
  }

 get executorState(): ExecutorState {return this.#executorState}
 setExecutorStateForTest(state: ExecutorState): void {this.#executorState = state; this.ports.onExecutorState(state)}

  /**
   * Tell the renderer whether Codex is working, when that changes.
   *
   * Derived from the session's live delegates rather than counted here: the session is what knows
   * when one finishes, and a separate counter would drift the moment a delegate ended by any route
   * this layer does not see.
   */
  publishExecutorState(): void {
    const delegates = this.ports.session.snapshot().active_delegates
    const fingerprint = canonicalJson(activeExecutorContextData(
      delegates,
      channel => this.ports.agentNameForChannel(channel),
    ))
    if (fingerprint !== this.#activeWorkFingerprint) {
      this.#activeWorkFingerprint = fingerprint
      if (!this.ports.clearingConversation()) {
        try {
          this.ports.onActiveWorkChanged()
        } catch (cause) {
          this.ports.onDiagnostic(
            `[realtime-diagnostic] active_work_observer_failed type=${diagnosticName(cause)}`,
          )
        }
      }
    }
    const next: ExecutorState = delegates.some(([, record]) => record.channel === this.ports.coding?.channel)
      ? 'running'
      : this.ports.preparing() ? 'preparing' : 'idle'
    if (next === this.#executorState) return
    this.#executorState = next
    try {
      this.ports.onExecutorState(next)
    } catch (cause) {
      // A renderer that cannot accept the state must not stop the service that produced it.
      this.ports.onDiagnostic(`[realtime-diagnostic] codex_state_observer_failed type=${diagnosticName(cause)}`)
    }
  }

  /** Compact fingerprint of delegate progress for context refresh. */
  #activeWorkFingerprint = canonicalJson(activeExecutorContextData([]))

  #executorState: ExecutorState = 'idle'

 readonly #lastProgressSummary = new Map<string, string>()
 readonly #startedDelegates = new Set<string>()
 constructor(private readonly ports: ProviderProjectionPorts) {}
 reset(): void { this.#lastProgressSummary.clear(); this.#startedDelegates.clear() }
/** Resolve synchronous results before ordinary channel projection can consume them. */
projectRuntimeEvent(event: EventRecord, currentConversation = true): void {
    if (!currentConversation) {
      this.#settleHistoricalRuntimeEvent(event)
      return
    }
    if (event.kind === 'handoff') this.ports.telemetry?.record('tool.finished', {
      executor: event.payload.channel, delegate_id: event.payload.delegate_id, outcome: event.payload.outcome,
    })
    if (event.kind === 'handoff' && this.ports.resolveSyncResult(event)) return
    if (event.kind === 'deadline') {
      if (this.ports.expireSyncResult(event)) return
      this.#projectDeadline(event)
      return
    }
    if (event.kind !== 'progress' && event.kind !== 'observation' && event.kind !== 'handoff') {
      return
    }
    const manifest = this.ports.runtime.executors.get(event.payload.channel)?.manifest
    if (manifest === undefined) return

    if (event.payload.channel === this.ports.coding?.channel && this.ports.telemetry !== undefined) {
      if (event.kind === 'progress') {
        this.ports.telemetry.record('executor.progress', {
          delegate_id: event.payload.delegate_id,
          phase: event.payload.phase,
          internal_activity: event.payload.internal_activity,
        })
      } else if (event.kind === 'handoff') {
        this.ports.telemetry.record('executor.handoff', {
          delegate_id: event.payload.delegate_id,
          outcome: event.payload.outcome,
        })
      }
    }

    if (event.kind === 'observation') {
      this.#projectObservation(event, manifest)
    } else if (event.kind === 'progress') {
      this.#projectProgress(event, manifest)
    } else {
      this.#projectHandoff(event, manifest)
    }
  }

#settleHistoricalRuntimeEvent(event: EventRecord): void {
    if (event.kind !== 'handoff' && event.kind !== 'deadline') return
    const delegateId = event.payload.delegate_id
    let delegate: DelegateLike | undefined
    if (event.kind === 'handoff') {
      delegate = this.ports.runtime.claimedHandoff(event.seq)
      if (delegate?.executor !== event.payload.channel) return
    } else if (this.ports.runtime.terminatedByDeadline(event.seq, delegateId)) {
      delegate = this.ports.runtime.delegateFor(delegateId)
    }
    if (delegate?.delegate_id !== delegateId) return
    const channel = delegate.executor
    this.ports.session.registerDelegate(delegateId, {
      summary: this.#delegateSummary(delegateId, this.executorDisplayName(channel)),
      state: event.kind === 'deadline'
        ? 'unknown'
        : event.payload.outcome === 'ok'
          ? 'completed'
          : event.payload.outcome === 'refused'
            ? 'refused'
            : event.payload.outcome === 'unknown' ? 'unknown' : 'failed',
      channel,
      progress_summary: null,
      internal_activity: 0,
      elapsed: 0,
    })
    this.#lastProgressSummary.delete(delegateId)
    this.#startedDelegates.delete(delegateId)
    this.publishExecutorState()
  }

onSuggestionSelected(suggestion: Suggestion, reason: WakeReason): void {
    const progress = this.#isSelectedProgress(suggestion)
    const coding = progress && suggestion.evidence_refs[0]?.startsWith(`${this.ports.coding?.channel}:`) === true
    if (coding && this.ports.codingProgressNarration.mode !== 'smart') return
    const delegate = coding && reason.origin !== null ? this.ports.runtime.inFlightDelegate(reason.origin) : undefined
    if (coding && delegate?.executor !== this.ports.coding?.channel) return
    if (coding) {
      this.ports.rememberCodingProgressHostEvent(`suggestion:${suggestion.id}`)
      this.ports.rememberDelegateHostEvent(reason.origin!, `suggestion:${suggestion.id}`)
    }
    const hit = suggestion.content.hit === true
    this.ports.queueHostItem(hostFactIntent({
      kind: this.#isSelectedProgress(suggestion) ? 'progress' : 'final',
      host_item_id: this.ports.idFactory(),
      event_id: `suggestion:${suggestion.id}`,
      ...(reason.origin === null ? {} : {source: this.#workSource(reason.origin)}),
      content: suggestionSpeechView(suggestion.content),
    }), {
      priority: hit ? Math.max(reason.priority, HIT_ALERT_MIN_PRIORITY) : reason.priority,
      preemptive: false,
      ...(coding ? {owner: {delegate_id: reason.origin!, channel: delegate!.executor}, expiresAt: this.ports.clock.now() + PROGRESS_HOST_ITEM_TTL_S} : {}),
    })
  }

#isSelectedProgress(suggestion: Suggestion): boolean {
    if (suggestion.evidence_refs.length !== 1) return false
    const summary = suggestion.content.summary
    if (typeof summary !== 'string') return false
    const memory = this.ports.runtime.memory
    if (memory === undefined) return false
    const reference = suggestion.evidence_refs[0]
    if (reference === undefined) return false
    let channelName: string
    let sequence: number
    try {
      [channelName, sequence] = parseMemoryRef(reference)
    } catch {
      return false
    }
    const policy = memory.policies.get(channelName)
    const evidence = memory.channels.get(channelName)?.items.find(item => item.seq === sequence)
    return policy?.progress_via_surrogate === true
      && evidence?.channel === channelName
      && evidence.seq === sequence
      && evidence.content.phase === 'working'
      && evidence.content.summary === summary
  }

#projectDeadline(event: Extract<EventRecord, {kind: 'deadline'}>): void {
    const delegateId = event.payload.delegate_id
    // This exact event, not "was terminated by a deadline at some point": a second deadline for the
    // same delegate would otherwise announce the same timeout twice.
    if (!this.ports.runtime.terminatedByDeadline(event.seq, delegateId)) return
    const delegate = this.ports.runtime.delegateFor(delegateId)
    if (delegate === undefined) return
    const manifest = this.ports.runtime.executors.get(delegate.executor)?.manifest
    const operation = manifest?.ops.find(candidate => candidate.name === delegate.op)
    if (manifest === undefined || operation === undefined || operation.sync_result === true) return
    const displayName = this.executorDisplayName(delegate.executor)
    this.ports.session.registerDelegate(delegateId, {
      summary: this.#delegateSummary(delegateId, displayName),
      state: 'unknown',
      channel: delegate.executor,
      progress_summary: null,
      internal_activity: 0,
      elapsed: 0,
    })
    // A settled delegate leaves no dedup residue behind, or a later run of the same delegate id would
    // inherit a summary it never produced.
    this.#lastProgressSummary.delete(delegateId)
    this.#startedDelegates.delete(delegateId)
    this.publishExecutorState()
    this.ports.queueHostItem(hostFactIntent({
      kind: 'final',
      host_item_id: this.ports.idFactory(),
      event_id: `deadline:${delegateId}`,
      source: this.#workSource(delegateId, event.seq),
      content: `${displayName} 的委派任务超时，未能确认结果。`,
    }), {priority: manifest.policy.priority})
  }

#projectObservation(
    event: Extract<EventRecord, {kind: 'observation'}>,
    manifest: ExecutorManifestLike,
  ): void {
    const delegate = this.#observationDelegate(event)
    if (delegate === undefined) return
    const displayName = this.executorDisplayName(event.payload.channel)
    this.ports.session.registerDelegate(event.payload.delegate_id, {
      summary: this.#delegateSummary(event.payload.delegate_id, displayName),
      state: 'running',
      channel: event.payload.channel,
    })
    this.publishExecutorState()
    if (event.payload.content.hit !== true) return
    if (manifest.policy.suggest === true && delegate.routing_class === 'ambient') return
    const monitor = isMonitorPolicy(manifest.policy)
    const delivery = monitorAlertDelivery(manifest.policy)
    // A none monitor still records the hit and updates delegate state above, but does not address it
    // to the user or take their floor.
    if (monitor && delivery === 'none') return
    const speechView = monitor
      ? monitorHitSpeechView(event.payload.content)
      : genericFinalSpeechView(displayName, 'ok', event.payload.content)
    const content = [...speechView]
      .slice(0, MAX_HOST_FACT_CHARS)
      .join('')
    this.ports.queueHostItem(hostFactIntent({
      kind: 'final',
      host_item_id: this.ports.idFactory(),
      event_id: `observation:${event.payload.delegate_id}:${event.seq}`,
      source: this.#workSource(event.payload.delegate_id, event.seq),
      content,
    }), {
      // A monitoring hit outranks routine executor announcements; only its policy may authorize a floor preempt.
      priority: Math.max(manifest.policy.priority, HIT_ALERT_MIN_PRIORITY),
      preemptive: monitor
        ? isPreemptiveMonitorAlert(manifest.policy)
        : manifest.policy.priority >= PREEMPT_MIN_PRIORITY,
      preemptiveAlert: isPreemptiveMonitorAlert(manifest.policy),
      preemptiveAlertDelegateId: isPreemptiveMonitorAlert(manifest.policy) ? event.payload.delegate_id : null,
    })
  }

#observationDelegate(
    event: Extract<EventRecord, {kind: 'observation'}>,
  ): DelegateLike | undefined {
    const delegate = this.ports.runtime.inFlightDelegate(event.payload.delegate_id)
    if (delegate === undefined) return undefined
    if (
      event.payload.channel !== delegate.executor
      || event.payload.op !== delegate.op
      || event.payload.origin_ref !== delegate.origin_ref
    ) {
      return undefined
    }
    return delegate
  }

#projectProgress(
    event: Extract<EventRecord, {kind: 'progress'}>,
    manifest: ExecutorManifestLike,
  ): void {
    const payload = event.payload
    if (
      payload.op === ''
      || !Number.isInteger(payload.internal_activity)
      || !Number.isFinite(payload.elapsed)
      || payload.elapsed < 0
      || (payload.phase === 'started' && payload.internal_activity !== 0)
      || (
        payload.phase === 'working'
        && !(payload.internal_activity >= 1 && payload.internal_activity <= 1_048_576)
      )
    ) {
      return
    }
    const delegate = this.ports.runtime.inFlightDelegate(payload.delegate_id)
    if (delegate?.executor !== payload.channel || delegate.op !== payload.op) return
    const displayName = this.executorDisplayName(payload.channel)
    const coding = payload.channel === this.ports.coding?.channel
    let summary: string | null = payload.summary
    if (!validProgressSummary(summary, payload.phase)) summary = null
    if (summary !== null) {
      // CP2: prepared once at the storage boundary, so the recovery frame the session renders never
      // carries raw markdown either.
      summary = coding ? codingProgressSummary(summary) : prepareForSpeech(summary, {limit: SPEECH_FINAL_LIMIT}).text || null
    }
    const previousSummary = this.#lastProgressSummary.get(payload.delegate_id)
    // Keep received facts current even when smart mode suppresses delivery.
    if (coding && payload.phase === 'working' && summary !== null) {
      this.#lastProgressSummary.set(payload.delegate_id, summary)
    }
    this.ports.session.registerDelegate(payload.delegate_id, {
      summary: this.#delegateSummary(payload.delegate_id, displayName),
      state: 'running',
      channel: payload.channel,
      progress_summary: summary,
      internal_activity: payload.internal_activity,
      elapsed: payload.elapsed,
    })
    this.publishExecutorState()
    if (manifest.ops.find(op => op.name === delegate.op)?.sync_result === true
      || (manifest.roles.includes('coding') && delegate.op === 'steer')) return
    // Preparation and actual execution are different lifecycle facts. Deduplicate by delegate,
    // never by spoken text, and let normal owner/expiry fences suppress obsolete startup facts.
    if (coding && payload.phase === 'started') {
      if (this.#startedDelegates.has(payload.delegate_id)) return
      this.#startedDelegates.add(payload.delegate_id)
    }
    if (
      !coding && payload.phase === 'started'
      && this.ports.hasSemanticAcknowledgement(`background:${payload.delegate_id}`)
    ) return
    // A monitor's periodic heartbeat is operational state, not a new user-facing event. Speaking it
    // creates a fresh model turn that can accidentally replay an older acknowledgement.
    if (isMonitorPolicy(manifest.policy) && payload.phase === 'working') return
    if (payload.phase === 'working') {
      if (this.ports.codingProgressNarration.viaProactive(coding, manifest.policy.progress_via_surrogate === true)) return
      if (coding && this.ports.codingProgressNarration.mode === 'continuous' && summary === null) return
    }

    let content: string
    if (payload.phase === 'started') {
      content = coding ? `交给 ${manifest.display_name} 执行。` : `${displayName} 已开始处理这个任务。`
    } else if (summary !== null) {
      // Same-summary skip: state registration already happened, only the host injection is
      // suppressed. A summary-less event keeps the field template and is never deduped this way.
      if (previousSummary === summary) return
      this.#lastProgressSummary.set(payload.delegate_id, summary)
      content = `${displayName} 正在执行：${summary}`
    } else {
      content = `${displayName} 仍在处理这个任务，目前已推进 ${payload.internal_activity} 个步骤。`
    }
    const eventId = `progress:${payload.delegate_id}:${payload.phase}:${payload.internal_activity}`
    if (coding && payload.phase === 'working') {
      // Coalesce queued updates per task; the latest fact retains existing owner/floor/expiry fences.
      if (this.ports.codingProgressNarration.mode === 'continuous') {
        this.ports.retireDelegateHostEvents(payload.delegate_id)
        this.ports.coalesceCodingProgress()
      }
      this.ports.rememberCodingProgressHostEvent(eventId)
    }
    this.ports.rememberDelegateHostEvent(payload.delegate_id, eventId)
    this.ports.queueHostItem(hostFactIntent({
      kind: 'progress',
      host_item_id: this.ports.idFactory(),
      event_id: eventId,
      source: this.#workSource(payload.delegate_id, event.seq),
      content,
    }), {
      priority: manifest.policy.priority,
      owner: {delegate_id: payload.delegate_id, channel: payload.channel},
      expiresAt: this.ports.clock.now() + PROGRESS_HOST_ITEM_TTL_S,
    })
  }

#projectHandoff(
    event: Extract<EventRecord, {kind: 'handoff'}>,
    manifest: ExecutorManifestLike,
  ): void {
    // Only the delegate *this* handoff claimed. A duplicate, or one for an already-settled delegate,
    // claims nothing and must not be projected against whatever the previous one claimed.
    const claimed = this.ports.runtime.claimedHandoff(event.seq)
    if (claimed?.executor !== event.payload.channel) return
    const payload = event.payload
    const displayName = this.executorDisplayName(payload.channel)
    this.ports.fenceSemanticAcknowledgement(payload.delegate_id)
    this.ports.retireDelegateHostEvents(payload.delegate_id)
    const directSuggestionHandoff = manifest.policy.suggest === true
      && payload.outcome === 'ok'
      && claimed.routing_class === 'user_awaited'
    const suppressUnselectedSuggestion = manifest.policy.suggest === true
      && payload.outcome === 'ok'
      && !directSuggestionHandoff
    this.ports.session.registerDelegate(payload.delegate_id, {
      summary: this.#delegateSummary(payload.delegate_id, displayName),
      state: payload.outcome === 'ok'
        ? 'completed'
        : payload.outcome === 'refused'
          ? 'refused'
          : payload.outcome === 'unknown' ? 'unknown' : 'failed',
      channel: payload.channel,
    })
    // CP1: a settled delegate leaves no dedup residue behind.
    this.#lastProgressSummary.delete(payload.delegate_id)
    this.#startedDelegates.delete(payload.delegate_id)
    this.publishExecutorState()
    // Tracked tasks publish only after host verification, never from executor terminal prose.
    if (this.ports.taskOwnsWork?.(payload.delegate_id)) return
    if (manifest.ops.find(op => op.name === claimed.op)?.sync_result === true
      || (manifest.roles.includes('coding') && claimed.op === 'steer')) return
    if (
      isMonitorPolicy(manifest.policy)
      && monitorAlertDelivery(manifest.policy) === 'none'
      && payload.outcome === 'ok'
      && payload.content.hit === true
    ) return
    if (suppressUnselectedSuggestion) return

    const successfulMonitorStop = isMonitorPolicy(manifest.policy)
      && payload.outcome === 'ok'
      && (
        (claimed.op === 'stop' && payload.content.stopped === true)
        || (claimed.op === 'start' && payload.content.state === 'stopped')
      )
    if (successfulMonitorStop) return

    const finalView = payload.channel === this.ports.coding?.channel
      ? finalSpeechView(payload.outcome, payload.content, this.ports.coding.display_name)
      : genericFinalSpeechView(displayName, payload.outcome, payload.content)
    const task = payload.channel === this.ports.coding?.channel ? claimed.request?.work_order : null
    // Fact-only narration has no dialogue history. Keep this result tied to its own task,
    // without restoring unrelated history or treating requested work as proof of execution.
    const taskContext = typeof task === 'string'
      ? `\n本次任务上下文（不是执行结果，不复述）：${JSON.stringify([...task].slice(0, 1600).join(''))}`
      : ''
    const content = [...(finalView + taskContext)].slice(0, MAX_HOST_FACT_CHARS).join('')
    const hit = payload.outcome === 'ok' && payload.content.hit === true
    const preemptiveMonitorHit = hit && isPreemptiveMonitorAlert(manifest.policy)
    this.ports.queueHostItem(hostFactIntent({
      kind: 'final',
      host_item_id: this.ports.idFactory(),
      event_id: `final:${payload.delegate_id}`,
      source: this.#workSource(payload.delegate_id, event.seq),
      content,
    }), {
      priority: hit
        ? Math.max(manifest.policy.priority, HIT_ALERT_MIN_PRIORITY)
        : manifest.policy.priority,
      preemptive: hit && (isMonitorPolicy(manifest.policy)
        ? isPreemptiveMonitorAlert(manifest.policy)
        : manifest.policy.priority >= PREEMPT_MIN_PRIORITY),
      preemptiveAlert: preemptiveMonitorHit,
      preemptiveAlertDelegateId: preemptiveMonitorHit ? payload.delegate_id : null,
    })
  }

#workSource(delegateId: string, eventSeq?: number): HostWorkSource | undefined {
    const record = this.ports.session.delegateRecord(delegateId)
    const delegate = this.ports.runtime.delegateFor(delegateId)
    const channel = record?.channel ?? delegate?.executor
    if (channel === undefined) return undefined
    const request = channel === this.ports.coding?.channel ? delegate?.request : undefined
    const label = (value: string | undefined): string | undefined => value === undefined
      ? undefined : [...value.replace(/[\p{C}]/gu, '')].slice(0, 120).join('') || undefined
    const project = label(record?.project ?? (typeof request?.project === 'string' ? request.project : undefined))
    const title = label(record?.title ?? (typeof request?.title === 'string' ? request.title : undefined))
    return {work_id: delegateId, ...(eventSeq === undefined ? {} : {event_seq: eventSeq}), executor: this.ports.agentNameForChannel(channel) ?? channel,
      ...(project === undefined ? {} : {project}), ...(title === undefined ? {} : {title})}
  }

#delegateSummary(delegateId: string, displayName: string): string {
    for (const [currentId, record] of this.ports.session.snapshot().active_delegates) {
      if (currentId === delegateId) return record.summary
    }
    return `${displayName} background task`
  }
}
