import {z} from 'zod'

/** The model-facing wire contract. Session identity is supplied by the host context. */
export const visionAssessSchema = z.object({
  request_id: z.string().min(1).max(128),
  revision: z.number().int().nonnegative(),
  kind: z.enum(['monitor', 'stop', 'unclear']),
  condition: z.string().nullable(),
  urgency: z.enum(['routine', 'urgent']).nullable(),
  urgency_evidence: z.string().nullable(),
  interval_s: z.number().finite().nullable(),
  duration_s: z.number().finite().nullable(),
  question: z.string().nullable(),
}).strict()

export type VisionAssess = z.infer<typeof visionAssessSchema>
export type VisionKind = VisionAssess['kind']

export interface VisionIdentity {
  request_id: string
  revision: number
  session_epoch: number
}

/**
 * The host captures this context when asking the assess slot. Optional current-
 * value readers let an effect re-check the identity immediately before use.
 */
export interface VisionAssessContext extends VisionIdentity {
  original_user_text: string
  stillWanted: () => boolean
  current_request_id?: () => string
  current_revision?: () => number
  current_session_epoch?: () => number
}

export const VISION_ASSESS_SYSTEM = `You are the host's vision.assess slot. Return only JSON matching the supplied schema and echo request_id and revision exactly. Do not speak, use tools, or mutate state. Decide only between monitor, stop, and unclear.
For monitor, condition must be a concrete, bounded visual condition. interval_s must be 2..30 seconds (default 2.5) and duration_s must be 30..1800 seconds (default 1800); reject an explicit out-of-range value rather than rewriting it. unclear must contain exactly one bounded host question and must never assume urgent urgency.
Set urgency to urgent only when urgency_evidence is a non-empty substring copied exactly from the original user text. Missing, forged, or non-substring evidence is not urgent. Explicit negative or silence requests such as 不要提醒、不要告警、保持静默、不用喊我 must never become urgent or preemptive, even if nearby text appears urgent. Treat this as a conservative safety rule; do not pretend to classify arbitrary language perfectly. Set urgency_evidence to null for routine or unclear decisions.`

const DEFAULT_QUESTION = 'Please clarify the vision request.'
const NEGATIVE_SILENCE = /不要提醒|不要告警|保持静默|不用喊我|别提醒|无需提醒|不要通知|别通知/u

export type VisionDecisionCode = 'monitor' | 'stop' | 'unclear' | 'superseded' | 'no_action'

interface VisionDecisionBase {
  readonly code: VisionDecisionCode
  readonly identity: VisionIdentity
  /** Re-run this check immediately before asking permission, launching, or stopping. */
  readonly recheck: () => boolean
}

export interface VisionMonitorDecision extends VisionDecisionBase {
  readonly code: 'monitor'
  readonly assessment: VisionAssess
}

export interface VisionStopDecision extends VisionDecisionBase {
  readonly code: 'stop'
  readonly assessment: VisionAssess
}

export interface VisionUnclearDecision extends VisionDecisionBase {
  readonly code: 'unclear'
  readonly assessment: VisionAssess
  readonly question: string
  readonly urgency: null
}

export interface VisionSupersededDecision extends VisionDecisionBase {
  readonly code: 'superseded'
  readonly reason: 'identity_mismatch' | 'not_still_wanted'
}

export interface VisionNoActionDecision extends VisionDecisionBase {
  readonly code: 'no_action'
  readonly reason:
    | 'invalid_schema'
    | 'invalid_condition'
    | 'invalid_interval'
    | 'invalid_duration'
    | 'urgent_evidence_missing'
    | 'urgent_evidence_forged'
    | 'negative_silence_guard'
    | 'invalid_kind_fields'
}

export type VisionDecision =
  | VisionMonitorDecision
  | VisionStopDecision
  | VisionUnclearDecision
  | VisionSupersededDecision
  | VisionNoActionDecision

function sameIdentity(left: VisionIdentity, right: VisionIdentity): boolean {
  return left.request_id === right.request_id
    && left.revision === right.revision
    && left.session_epoch === right.session_epoch
}

function contextIsCurrent(identity: VisionIdentity, context: VisionAssessContext): boolean {
  try {
    return sameIdentity(identity, context)
      && (context.current_request_id?.() ?? identity.request_id) === identity.request_id
      && (context.current_revision?.() ?? identity.revision) === identity.revision
      && (context.current_session_epoch?.() ?? identity.session_epoch) === identity.session_epoch
      && context.stillWanted()
  } catch {
    return false
  }
}

function validContext(context: VisionAssessContext): boolean {
  return typeof context.request_id === 'string' && context.request_id.length > 0
    && Number.isInteger(context.revision) && context.revision >= 0
    && Number.isInteger(context.session_epoch) && context.session_epoch >= 0
    && typeof context.original_user_text === 'string'
    && typeof context.stillWanted === 'function'
}

function noAction(
  identity: VisionIdentity,
  reason: VisionNoActionDecision['reason'],
): VisionNoActionDecision {
  return {code: 'no_action', identity, reason, recheck: () => false}
}

function superseded(
  identity: VisionIdentity,
  reason: VisionSupersededDecision['reason'],
): VisionSupersededDecision {
  return {code: 'superseded', identity, reason, recheck: () => false}
}

function unclear(
  identity: VisionIdentity,
  context: VisionAssessContext,
  source: VisionAssess,
): VisionUnclearDecision {
  const question = source.question?.trim() ?? ''
  const boundedQuestion = question.length > 0 && question.length <= 300 ? question : DEFAULT_QUESTION
  const assessment: VisionAssess = {
    ...source,
    kind: 'unclear',
    condition: null,
    urgency: null,
    urgency_evidence: null,
    interval_s: null,
    duration_s: null,
    question: boundedQuestion,
  }
  return {
    code: 'unclear', identity, assessment, question: boundedQuestion, urgency: null,
    recheck: () => contextIsCurrent(identity, context),
  }
}

function invalidSemantic(
  identity: VisionIdentity,
  context: VisionAssessContext,
  source: VisionAssess,
  reason: VisionNoActionDecision['reason'],
): VisionUnclearDecision {
  // Semantic model mistakes fail closed as a host clarification, never as an effect.
  void reason
  return unclear(identity, context, source)
}

/** Parse a model result and bind any actionable decision to the captured host context. */
export function assessVision(input: unknown, context: VisionAssessContext): VisionDecision {
  const identity: VisionIdentity = {
    request_id: context.request_id,
    revision: context.revision,
    session_epoch: context.session_epoch,
  }
  if (!validContext(context)) return noAction(identity, 'invalid_schema')
  const parsed = visionAssessSchema.safeParse(input)
  if (!parsed.success) return noAction(identity, 'invalid_schema')
  const source = parsed.data
  const sourceIdentity: VisionIdentity = {...identity, request_id: source.request_id, revision: source.revision}
  if (!contextIsCurrent(identity, context) || source.request_id !== identity.request_id || source.revision !== identity.revision) {
    const reason = source.request_id !== identity.request_id || source.revision !== identity.revision
      ? 'identity_mismatch'
      : 'not_still_wanted'
    return superseded(sourceIdentity, reason)
  }

  if (source.kind === 'unclear') return unclear(identity, context, source)
  if (source.kind === 'stop') {
    const hasExtraFields = source.condition !== null || source.urgency !== null
      || source.urgency_evidence !== null || source.interval_s !== null || source.duration_s !== null
      || source.question !== null
    return hasExtraFields ? invalidSemantic(identity, context, source, 'invalid_kind_fields') : {
      code: 'stop', identity, assessment: source,
      recheck: () => contextIsCurrent(identity, context),
    }
  }

  const condition = source.condition?.trim() ?? ''
  if (condition.length === 0 || condition.length > 300) {
    return invalidSemantic(identity, context, source, 'invalid_condition')
  }
  if (source.question !== null) {
    return invalidSemantic(identity, context, source, 'invalid_kind_fields')
  }
  const interval = source.interval_s ?? 2.5
  if (interval < 2 || interval > 30 || !Number.isFinite(interval)) {
    return invalidSemantic(identity, context, source, 'invalid_interval')
  }
  const duration = source.duration_s ?? 1800
  if (duration < 30 || duration > 1800 || !Number.isFinite(duration)) {
    return invalidSemantic(identity, context, source, 'invalid_duration')
  }

  if (source.urgency === 'urgent') {
    const evidence = source.urgency_evidence ?? ''
    if (evidence.trim().length === 0) return invalidSemantic(identity, context, source, 'urgent_evidence_missing')
    if (evidence.length > 300) return invalidSemantic(identity, context, source, 'urgent_evidence_forged')
    if (!context.original_user_text.includes(evidence)) {
      return invalidSemantic(identity, context, source, 'urgent_evidence_forged')
    }
    if (NEGATIVE_SILENCE.test(context.original_user_text) || NEGATIVE_SILENCE.test(evidence)) {
      return invalidSemantic(identity, context, source, 'negative_silence_guard')
    }
  } else if (source.urgency_evidence !== null) {
    return invalidSemantic(identity, context, source, 'invalid_kind_fields')
  }

  const assessment: VisionAssess = {
    ...source,
    condition,
    interval_s: interval,
    duration_s: duration,
  }
  return {
    code: 'monitor', identity, assessment,
    recheck: () => contextIsCurrent(identity, context),
  }
}

export type VisionMonitorState = 'idle' | 'permission-pending' | 'active' | 'terminal'
export type VisionMonitorOperationCode =
  | 'reserved' | 'busy' | 'active' | 'already_active' | 'hit' | 'cancelled'
  | 'already_cancelled' | 'cleaned' | 'already_idle' | 'stale'

export interface VisionMonitorOperation {
  readonly code: VisionMonitorOperationCode
  readonly state: VisionMonitorState
  readonly identity: VisionIdentity | null
}

function identityKey(identity: VisionIdentity): string {
  return `${identity.request_id}\u0000${identity.revision}\u0000${identity.session_epoch}`
}

function copyIdentity(identity: VisionIdentity | null): VisionIdentity | null {
  return identity === null ? null : {...identity}
}

/** Pure first-release single-active reservation state machine. */
export class VisionMonitorMachine {
  #state: VisionMonitorState = 'idle'
  #identity: VisionIdentity | null = null
  readonly #fenced = new Set<string>()

  get state(): VisionMonitorState {
    return this.#state
  }

  get identity(): VisionIdentity | null {
    return copyIdentity(this.#identity)
  }

  reserve(identity: VisionIdentity): VisionMonitorOperation {
    const key = identityKey(identity)
    if (this.#state !== 'idle') return {code: 'busy', state: this.#state, identity: this.identity}
    if (this.#fenced.has(key)) return {code: 'stale', state: this.#state, identity: null}
    this.#identity = {...identity}
    this.#state = 'permission-pending'
    return {code: 'reserved', state: this.#state, identity: this.identity}
  }

  grant(identity: VisionIdentity): VisionMonitorOperation {
    if (this.#fenced.has(identityKey(identity))) return {code: 'stale', state: this.#state, identity: this.identity}
    if (this.#state === 'permission-pending' && this.matches(identity)) {
      this.#state = 'active'
      return {code: 'active', state: this.#state, identity: this.identity}
    }
    if (this.#state === 'active' && this.matches(identity)) {
      return {code: 'already_active', state: this.#state, identity: this.identity}
    }
    return {code: 'stale', state: this.#state, identity: this.identity}
  }

  hit(identity: VisionIdentity): VisionMonitorOperation {
    if (this.#state === 'active' && this.matches(identity)) {
      return {code: 'hit', state: this.#state, identity: this.identity}
    }
    return {code: 'stale', state: this.#state, identity: this.identity}
  }

  cancel(identity: VisionIdentity): VisionMonitorOperation {
    if (this.matches(identity) && (this.#state === 'permission-pending' || this.#state === 'active')) {
      this.#state = 'terminal'
      this.#fenced.add(identityKey(identity))
      return {code: 'cancelled', state: this.#state, identity: this.identity}
    }
    if (this.matches(identity) && this.#state === 'terminal') {
      return {code: 'already_cancelled', state: this.#state, identity: this.identity}
    }
    if (this.#state === 'idle' && this.#fenced.has(identityKey(identity))) {
      return {code: 'already_cancelled', state: this.#state, identity: null}
    }
    return {code: 'stale', state: this.#state, identity: this.identity}
  }

  cleanup(identity: VisionIdentity): VisionMonitorOperation {
    if (this.matches(identity) && this.#state === 'terminal') {
      this.#state = 'idle'
      this.#identity = null
      return {code: 'cleaned', state: this.#state, identity: null}
    }
    if (this.#state === 'idle' && this.#fenced.has(identityKey(identity))) {
      return {code: 'already_idle', state: this.#state, identity: null}
    }
    return {code: 'stale', state: this.#state, identity: this.identity}
  }

  private matches(identity: VisionIdentity): boolean {
    return this.#identity !== null && sameIdentity(this.#identity, identity)
  }
}

export {VisionMonitorMachine as VisionMonitorStateMachine}
