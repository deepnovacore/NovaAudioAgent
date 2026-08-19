/**
 * The state model behind `RealtimeService`.
 *
 * Ported from the constants and private dataclasses at the head of
 * `src/nova_audio_agent/realtime/service.py`. These live apart from the orchestration for the same
 * reason `session-state.ts` does: the service is a single coupled state machine with around seventy
 * mutable fields, and the only way to read it is to be able to see what each field *is* before
 * following what changes it.
 *
 * Every bound here is behavior, not tuning. A ledger that grows without one is a leak in a process
 * meant to run for hours, and a ledger that evicts in the wrong order forgets the wrong thing --
 * which is why each is spelled out with what it protects rather than left to a comment saying "cap".
 */

import type { HostResponseIntent } from './protocol.js'
import type { PlaybackGeneration } from '../playback.js'
import type { ToolAcceptance, ToolCallReady } from './bridge.js'

/** Longest host fact the provider will be given. Beyond this the model stops attending to it. */
export const MAX_HOST_FACT_CHARS = 3_000
export const MAX_TRACKED_TOOL_CALLS = 500
export const MAX_PENDING_TOOL_REFUSALS = 32
export const PROJECT_EXPIRY_STEP_TIMEOUT_S = 5
export const MAX_TRACKED_SEMANTIC_ACKNOWLEDGEMENTS = 500
export const MAX_TRACKED_ORIGIN_DELIVERY_PROOFS = MAX_TRACKED_SEMANTIC_ACKNOWLEDGEMENTS
export const MAX_UNCERTAIN_DELIVERY_RETRIES = 256
/**
 * R105: delegates whose sync wait was resolved by a Deadline.
 *
 * A later handoff still downgrades to one host fact, so the record has to outlive the wait -- but not
 * forever. Bounded, oldest dropped.
 */
export const MAX_LATE_SYNC_RESULTS = 64
export const SYNC_RESULT_TITLE_CHARS = 120
export const SYNC_RESULT_SNIPPET_CHARS = 400
/** Longest a user may hold the floor before the hold is treated as stale and released. */
export const USER_HOLD_MAX_S = 30
export const STALE_DELIVERY_RETRY_S = 1
/** Below this priority a host item waits its turn; at or above it may interrupt the agent. */
export const PREEMPT_MIN_PRIORITY = 80
export const GUARD_ALERT_DEADLINE_S = 0.35
export const GUARD_CLEAR_ACK_DEADLINE_S = 0.5
/**
 * A monitoring hit outranks routine executor announcements (codex=50) without reaching the
 * preemption band; heartbeats and misses keep the manifest priority.
 */
export const HIT_ALERT_MIN_PRIORITY = 55

export type CodexState = 'idle' | 'running'
export type GuardHistoryRecovery = 'none' | 'packed'

/** What the service will say when a confirmed project operation could not be carried out. */
const PROJECT_COMMIT_FAILURE_TEXT: ReadonlyMap<string, string> = new Map([
  ['workspace_name_conflict', '工作区名称已存在，本次操作未执行。'],
  ['workspace_limit', '工作区数量已达上限，本次操作未执行。'],
  ['session_limit', 'Session 数量已达上限，本次操作未执行。'],
  ['state_busy', '工作区状态正忙，请稍后再试。'],
  ['busy', 'Codex 当前正忙，本次操作未执行。'],
  ['runtime_rejected', 'Codex 当前正忙，本次操作未执行。'],
  ['confirmation_invalid', '确认状态已失效，本次操作未执行。'],
  ['workspace_not_found', '没有找到指定工作区，本次操作未执行。'],
  ['session_not_found', '没有找到指定 Session，本次操作未执行。'],
  ['session_unavailable', '指定 Session 当前不可继续，本次操作未执行。'],
])

/**
 * Explain a failed commit in words a user hears.
 *
 * The fallback is deliberately vague about *why*: an unrecognised code means the failure came from
 * somewhere this layer does not model, and inventing a specific reason for it would be worse than
 * admitting the operation did not happen.
 */
export function projectCommitFailureText(code: unknown): string {
  if (typeof code !== 'string') return '已确认，但操作未执行。'
  return PROJECT_COMMIT_FAILURE_TEXT.get(code) ?? '已确认，但操作未执行。'
}

/** What the host told the provider about one tool call, as the provider knows it. */
export interface ToolCallAcceptanceSnapshot {
  readonly session_epoch: number
  readonly call_id: string
  readonly provider_response_id: string
  readonly acceptance: ToolAcceptance
}

/**
 * One admitted tool call, through its whole life.
 *
 * Five independent axes rather than one status, because they advance on different events and a single
 * enum would have to enumerate their product. `observation` is whether the call still describes the
 * world; `dispatch` is what the runtime did with it; `output` is whether the provider has the result;
 * `continuation` is whether the model has been given a turn to speak about it; `sync` is the R105 wait.
 */
export interface ToolCallState {
  acceptance: ToolAcceptance
  provider_response_id: string
  provider_session_epoch: number
  origin_user_input_revision: number
  observation: 'observed' | 'superseded'
  dispatch: 'dispatched' | 'fulfilled' | 'rejected' | 'not_dispatched'
  logical_name: string | null
  output: 'pending' | 'confirmed'
  continuation: 'queued' | 'requested' | 'bound' | 'terminal' | 'abandoned'
  continuation_response_id: string | null
  final_disposition: 'completed' | 'superseded' | 'abandoned' | 'refused' | null
  /**
   * R105 sync-result wait state. `pending` holds the batch; `resolved` carries a confirmed result;
   * `announce` downgrades the result to an ordinary host fact.
   */
  sync: 'none' | 'pending' | 'resolved' | 'announce'
}

export function toolCallState(input: {
  readonly acceptance: ToolAcceptance
  readonly provider_response_id: string
  readonly provider_session_epoch: number
  readonly origin_user_input_revision: number
  readonly observation: ToolCallState['observation']
  readonly dispatch: ToolCallState['dispatch']
  readonly logical_name?: string | null
  readonly sync?: ToolCallState['sync']
}): ToolCallState {
  return {
    acceptance: input.acceptance,
    provider_response_id: input.provider_response_id,
    provider_session_epoch: input.provider_session_epoch,
    origin_user_input_revision: input.origin_user_input_revision,
    observation: input.observation,
    dispatch: input.dispatch,
    logical_name: input.logical_name ?? null,
    output: 'pending',
    continuation: 'queued',
    continuation_response_id: null,
    final_disposition: null,
    sync: input.sync ?? 'none',
  }
}

/**
 * The tool calls from one provider response, batched so the model gets one turn about all of them.
 *
 * Batching is the point: a response that called three tools should produce one continuation, not
 * three, or the agent narrates its own bookkeeping.
 */
export interface ContinuationBatch {
  readonly provider_response_id: string
  call_keys: string[]
  origin_status: 'active' | 'completed' | 'cancelled' | 'failed'
  phase: 'collecting' | 'ready' | 'requested' | 'bound' | 'terminal' | 'abandoned'
  continuation_response_id: string | null
}

export function continuationBatch(providerResponseId: string): ContinuationBatch {
  return {
    provider_response_id: providerResponseId,
    call_keys: [],
    origin_status: 'active',
    phase: 'collecting',
    continuation_response_id: null,
  }
}

/** A fact the agent should mention, tracked until it has actually been said. */
export interface SemanticAcknowledgement {
  readonly event_id: string
  readonly summary: string
  readonly channel: string
  origin_session_epoch: number | null
  origin_response_id: string | null
  origin_user_input_revision: number | null
  origin_delivered: boolean
  phase: 'pending' | 'queued' | 'requested' | 'bound' | 'delivered'
  response_id: string | null
  binding: 'continuation' | 'fallback' | null
  failed_retry_consumed: boolean
}

export function semanticAcknowledgement(input: {
  readonly event_id: string
  readonly summary: string
  readonly channel?: string
}): SemanticAcknowledgement {
  return {
    event_id: input.event_id,
    summary: input.summary,
    channel: input.channel ?? 'codex',
    origin_session_epoch: null,
    origin_response_id: null,
    origin_user_input_revision: null,
    origin_delivered: false,
    phase: 'pending',
    response_id: null,
    binding: null,
    failed_retry_consumed: false,
  }
}

/** A tool call held back until the user transcript that would justify it arrives. */
export interface DeferredOriginToolCall {
  readonly event: ToolCallReady
  readonly response_id: string
  readonly user_item_id: string | null
}

export interface ProjectExpiryBatch {
  readonly item_keys: readonly string[]
  readonly source_epoch: number
  readonly reconnect: boolean
}

/**
 * One host item waiting for the floor.
 *
 * `sortKey` is the whole ordering contract: higher priority first, preemptive before ordinary at equal
 * priority, then insertion order. Nothing else participates in comparison -- two items with the same
 * key must not be ordered by their contents, or delivery order would depend on text.
 */
export interface QueuedHostResponse {
  readonly sortKey: readonly [number, number, number]
  readonly intent: HostResponseIntent
  readonly priority: number
  readonly preemptive: boolean
  readonly seq: number
  readonly queued_at: number
  readonly semantic_event_id: string | null
  readonly guard_activation: GuardActivationAuthority | null
}

/** Order two queued items the way the oracle's tuple comparison does. */
export function compareQueuedHostResponses(
  left: QueuedHostResponse,
  right: QueuedHostResponse,
): number {
  return left.sortKey[0] - right.sortKey[0]
    || left.sortKey[1] - right.sortKey[1]
    || left.sortKey[2] - right.sortKey[2]
}

export interface GuardActivationAuthority {
  readonly delegate_id: string
  readonly event_id: string
  readonly source_epoch: number
}

export interface UrgentHostResponseOwner {
  readonly delivery_token: number
  readonly session_epoch: number
  readonly event_id: string
  readonly queued: QueuedHostResponse
  readonly response_id: string | null
  readonly generation: PlaybackGeneration | null
}

export interface GuardPreemption {
  readonly token: number
  readonly session_epoch: number
  readonly event_id: string
  readonly old_response_id: string | null
  readonly old_generation: PlaybackGeneration | null
  readonly queued_at: number
  readonly cancel_sent: boolean
  readonly deadline_fired: boolean
  readonly replacement_terminal: boolean
  readonly reconnect_permit_consumed: boolean
  readonly reconnect_disallowed: boolean
  readonly reconnect_aborted: boolean
}

/**
 * A key for the `(session_epoch, id)` ledgers.
 *
 * The epoch is in nearly every key in this layer, and that is the reconnect contract rather than
 * defensive prefixing: after a reconnect the provider may reuse an id, and a ledger keyed on the id
 * alone would let the new session's item answer the old session's question.
 */
export function callKey(sessionEpoch: number, id: string): string {
  return `${sessionEpoch}:${id}`
}

/** Recover the two halves of a call key. Refuses a key that was not built by `callKey`. */
export function parseCallKey(key: string): {readonly sessionEpoch: number; readonly id: string} {
  const separator = key.indexOf(':')
  if (separator <= 0) throw new TypeError(`malformed call key: ${key}`)
  const sessionEpoch = Number(key.slice(0, separator))
  if (!Number.isInteger(sessionEpoch)) throw new TypeError(`malformed call key: ${key}`)
  return {sessionEpoch, id: key.slice(separator + 1)}
}
