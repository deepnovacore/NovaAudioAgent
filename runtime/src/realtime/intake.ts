import type {JsonValue} from '../events.js'
import {assessSchema, planSchema, type IntakeModels, type IntakeSlots} from './intake-model.js'
import type {ConfirmedProjectOperation, ProjectProposal} from './project-confirmation.js'
import {renderWorkOrder, type WorkOrder} from './work-order.js'

export interface IntakeTarget {
  readonly workspace: string
  readonly action: 'create' | 'reuse' | 'resume'
  readonly workspace_display_name: string
  readonly workspace_id: string | null
  readonly session_title: string | null
  readonly session_id: string | null
}
export interface IntakeSettings {
  readonly clarification_depth: 'minimal' | 'balanced' | 'thorough'
  readonly plan_readback: 'summary' | 'confirm' | 'silent'
}
export interface IntakeAdmission {
  readonly accepted: boolean
  readonly delegate_id?: string | null
  readonly code?: string
  readonly problem?: string | null
}
export interface IntakeSession {
  intake_id: string
  revision: number
  plan_revision: number | null
  proposal_id: string | null
  workspace: string | null
  session_id: string
  codex_session: string | null
  origin_ref: string
  state: 'open' | 'clarifying' | 'ready_to_plan' | 'planning' | 'readback' | 'committing' | 'closed'
  outcome: 'dispatched' | 'admission_refused' | 'cancelled' | 'abandoned' | null
  delegate_id: string | null
  request: Readonly<Record<string, JsonValue>>
  opening: string
  turns: {question: string | null; answer: string}[]
  slots: IntakeSlots
  discovery: string[]
  questions_asked: number
  intent_to_proceed: boolean
  stop_asking: boolean
  pending_question: string | null
  missing_goal_grace: number | null
  malformed: number
  target: IntakeTarget | null
  work_order: string | null
}

export interface IntakeOptions {
  readonly models: IntakeModels
  readonly settings: IntakeSettings
  readonly idFactory: () => string
  readonly resolveTarget: (request: Readonly<Record<string, JsonValue>>) => Promise<IntakeTarget>
  readonly prepare: (session: Readonly<IntakeSession>) => ProjectProposal
  readonly dispatch: (session: Readonly<IntakeSession>) => IntakeAdmission
  readonly invalidateProposal: () => void
  readonly fact: (session: Readonly<IntakeSession>, text: string) => void
  readonly record: (session: Readonly<IntakeSession>, kind: string, data: Readonly<Record<string, JsonValue>>) => void
  readonly diagnostic: (code: string) => void
}

const emptySlots = (): IntakeSlots => ({
  goal: {state: 'missing', note: ''}, scope: {state: 'missing', note: ''},
  acceptance: {state: 'missing', note: ''}, constraints: {state: 'missing', note: ''},
})
const limit = (value: string, count: number): string => [...value].slice(0, count).join('')

export function isIntakeAction(request: Readonly<Record<string, JsonValue>>): boolean {
  return typeof request.work_order === 'string'
    && typeof request.action === 'string'
    && ['create_workspace', 'start_session', 'resume_session'].includes(request.action)
}

/** This recognizes non-content turns only. It never grants execution authority. */
export function isPurePlanDecision(text: string): boolean {
  return /^(确认|可以|做吧|好|好的|同意|不同意|不行|取消|不用了|算了|yes|ok|okay|confirm|no|cancel)[。！!,.，\s]*$/iu.test(text.trim())
}

/** Two service-owned single-flight slots; latest revision replaces pending work, never active work. */
export class IntakeController {
  readonly #options: IntakeOptions
  #session: IntakeSession | null = null
  #assessing: Promise<void> | null = null
  #planning: Promise<void> | null = null
  #assessPending = false
  #planPending = false
  #userInputPending = false
  readonly #abort = new Set<AbortController>()

  constructor(options: IntakeOptions) { this.#options = options }
  get view(): Readonly<IntakeSession> | null { return this.#session === null ? null : structuredClone(this.#session) }
  get active(): boolean { return this.#session !== null && this.#session.state !== 'closed' }
  userInputStarted(): void { if (this.active) this.#userInputPending = true }

  open(request: Readonly<Record<string, JsonValue>>, text: string, originRef: string, sessionId: string): 'intake_opened' | 'intake_in_progress' {
    if (this.active && this.#session!.session_id !== sessionId) this.cancel()
    if (this.active) {
      const current = this.#session!
      if (current.state === 'committing') return 'intake_in_progress'
      // A provider repeats the draft for an already-ingested answer: one content revision per turn.
      if (current.origin_ref !== originRef) this.userTurn(text, originRef, sessionId)
      return 'intake_in_progress'
    }
    this.#session = {
      intake_id: this.#options.idFactory(), revision: 1, plan_revision: null, proposal_id: null,
      workspace: null, session_id: sessionId, codex_session: typeof request.session === 'string' ? request.session : null,
      origin_ref: originRef, state: 'open', outcome: null, delegate_id: null,
      request: structuredClone(request), opening: limit(text, 4000), turns: [], slots: emptySlots(), discovery: [],
      questions_asked: 0, intent_to_proceed: false, stop_asking: false, pending_question: null,
      missing_goal_grace: null, malformed: 0, target: null, work_order: null,
    }
    this.#assessPending = true
    this.#pump()
    return 'intake_opened'
  }

  userTurn(text: string, originRef: string, sessionId: string): void {
    this.#userInputPending = false
    const current = this.#session
    if (current === null || !this.active) return
    if (current.session_id !== sessionId) { this.cancel(); return }
    if (current.state === 'committing' || current.origin_ref === originRef) return
    if (current.proposal_id !== null && isPurePlanDecision(text)) return
    if (/^(取消|不用了|算了|cancel)[。！!.，\s]*$/iu.test(text.trim())) { this.cancel(); return }
    current.turns.push({question: current.pending_question, answer: limit(text, 2000)})
    if (current.turns.length > 8) { this.#close('abandoned'); return }
    current.revision += 1
    current.origin_ref = originRef
    current.plan_revision = null
    current.work_order = null
    if (current.proposal_id !== null) this.#options.invalidateProposal()
    current.proposal_id = null
    current.pending_question = null
    current.stop_asking = current.questions_asked >= this.#budget()
    current.state = 'clarifying'
    this.#planPending = false
    this.#assessPending = true
    this.#pump()
  }

  cancel(): void { if (this.active) this.#close('cancelled') }

  beginConfirmed(operation: ConfirmedProjectOperation): boolean {
    const current = this.#session
    if (this.#userInputPending || current?.state !== 'readback' || current.proposal_id !== operation.proposal_id
      || current.plan_revision !== current.revision || operation.intake_id !== current.intake_id
      || operation.plan_revision !== current.plan_revision || operation.work_order !== current.work_order) return false
    current.state = 'committing'
    return true
  }

  settleConfirmed(result: IntakeAdmission): void {
    if (this.#session?.state === 'committing') this.#settle(result)
  }

  decline(proposalId: string): void {
    if (this.#session?.proposal_id === proposalId && this.#session.state === 'readback') this.cancel()
  }

  /** Deterministic test drain; event handlers never await model completion. */
  async settled(): Promise<void> {
    while (this.#assessing !== null || this.#planning !== null) {
      await Promise.all([this.#assessing, this.#planning])
    }
  }

  #current(id: string, revision: number): IntakeSession | null {
    const current = this.#session
    if (current?.intake_id === id && current.revision === revision && current.state !== 'closed') return current
    this.#options.diagnostic('intake_stale_result')
    return null
  }

  #input(current: IntakeSession): Readonly<Record<string, unknown>> {
    return {
      intake_id: current.intake_id, revision: current.revision, opening: current.opening,
      turns: structuredClone(current.turns), slots: structuredClone(current.slots),
      discovery: [...current.discovery], intent_to_proceed: current.intent_to_proceed,
      questions_asked: current.questions_asked, question_budget: this.#budget(),
    }
  }

  #pump(): void {
    if (!this.active) return
    if (this.#assessPending && this.#assessing === null) {
      this.#assessPending = false
      const snapshot = structuredClone(this.#session!)
      this.#assessing = this.#assess(snapshot).finally(() => { this.#assessing = null; this.#pump() })
    }
    if (this.#planPending && this.#planning === null && !this.#assessPending && this.#assessing === null) {
      this.#planPending = false
      const snapshot = structuredClone(this.#session!)
      this.#session!.state = 'planning'
      this.#planning = this.#plan(snapshot).finally(() => { this.#planning = null; this.#pump() })
    }
  }

  async #assess(snapshot: IntakeSession): Promise<void> {
    const abort = new AbortController()
    this.#abort.add(abort)
    try {
      if (snapshot.target === null) {
        const target = await this.#options.resolveTarget(snapshot.request)
        const current = this.#current(snapshot.intake_id, snapshot.revision)
        if (current === null) return
        current.target = target
        current.workspace = target.workspace
      }
      const raw = await this.#options.models.assess(this.#input(snapshot), AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]))
      const current = this.#current(snapshot.intake_id, snapshot.revision)
      if (current === null) return
      const parsed = assessSchema.safeParse(raw)
      if (!parsed.success) { this.#malformed(current); return }
      const result = parsed.data
      if (result.intake_id !== snapshot.intake_id || result.revision !== snapshot.revision) {
        this.#options.diagnostic('intake_stale_result'); return
      }
      current.malformed = 0
      if (result.abandon) { this.cancel(); return }
      this.#options.record(current, 'intake.assess', result)
      current.slots = result.slots
      current.intent_to_proceed = result.intent_to_proceed || result.early_exit
      current.discovery = [...new Set([...current.discovery, ...result.discovery,
        ...(result.candidate_question?.owner === 'repo' ? [result.candidate_question.text] : [])])].slice(0, 12)
      // The host computes readiness; a model cannot open the gate by inflating its score.
      const readiness = Object.values(result.slots).filter(value => value.state !== 'missing').length / 4
      current.stop_asking ||= result.early_exit || current.questions_asked >= this.#budget()
        || readiness >= (this.#options.settings.clarification_depth === 'thorough' ? 1 : .75)
      if (!current.stop_asking && result.candidate_question?.owner === 'user') {
        current.questions_asked += 1
        current.pending_question = result.candidate_question.text
        current.state = 'clarifying'
        this.#options.fact(current, `只问下面这一个问题，不调用编码工具：${current.pending_question}`)
        return
      }
      // No user-owned blocker: repository discovery never holds up planning.
      current.stop_asking = true
      if (current.slots.goal.state !== 'stated') {
        if (current.missing_goal_grace !== null && current.revision > current.missing_goal_grace) {
          this.#close('abandoned'); return
        }
        current.missing_goal_grace ??= current.revision
        current.state = 'clarifying'
        this.#options.fact(current, '还缺少要完成的具体目标，请说明希望实现或修复什么。暂不规划或执行。')
        return
      }
      if (!current.intent_to_proceed) {
        current.state = 'clarifying'
        this.#options.fact(current, '需求已记录，等待用户明确要求开始；不要继续追问或声称已执行。')
        return
      }
      current.state = 'ready_to_plan'
      this.#planPending = true
    } catch {
      const current = this.#current(snapshot.intake_id, snapshot.revision)
      if (current !== null) this.#malformed(current)
    } finally { this.#abort.delete(abort) }
  }

  async #plan(snapshot: IntakeSession): Promise<void> {
    const abort = new AbortController()
    this.#abort.add(abort)
    try {
      const raw = await this.#options.models.plan(this.#input(snapshot), AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]))
      const current = this.#current(snapshot.intake_id, snapshot.revision)
      if (current === null) return
      const result = planSchema.parse(raw)
      if (result.intake_id !== current.intake_id || result.revision !== current.revision) {
        this.#options.diagnostic('intake_stale_result'); return
      }
      const slots = current.slots
      const order: WorkOrder = {
        ...result.work_order,
        objective: slots.goal.note,
        scope_in: slots.scope.state === 'stated' ? [slots.scope.note] : [],
        scope_out: slots.scope.state === 'stated' ? result.work_order.scope_out : [],
        acceptance: slots.acceptance.state === 'stated' ? [slots.acceptance.note] : ['User did not specify; propose and report'],
        constraints: slots.constraints.state === 'stated' ? [slots.constraints.note] : [],
        discovery: [...new Set([...current.discovery, ...result.work_order.discovery])].slice(0, 12),
        assumptions: [...new Set([...Object.values(slots).filter(slot => slot.state === 'inferred').map(slot => slot.note), ...result.work_order.assumptions])].slice(0, 12),
      }
      current.work_order = renderWorkOrder(order)
      current.plan_revision = current.revision
      current.state = 'readback'
      this.#options.record(current, 'plan.compile', {work_order: current.work_order})
      // A spoken amendment may still be awaiting ASR. Never execute the old plan in that gap.
      if (this.#userInputPending) return
      if (this.#options.settings.plan_readback === 'confirm' || current.request.action !== 'start_session') {
        const proposal = this.#options.prepare(current)
        current.proposal_id = proposal.proposal_id
        this.#options.fact(current, `${proposal.confirmation_prompt} 计划：${limit(order.objective, 200)}。proposal_id=${proposal.proposal_id}；仅通过 codex__confirm_project_action 确认；修改需求会使此计划失效。`)
        return
      }
      if (this.#options.settings.plan_readback === 'summary') this.#options.fact(current, `计划：${limit(order.objective, 240)}。只读回这一句，不再追问；等待宿主派单结果。`)
      current.state = 'committing'
      this.#settle(this.#options.dispatch(current))
    } catch {
      const current = this.#current(snapshot.intake_id, snapshot.revision)
      if (current !== null) this.#malformed(current)
    } finally { this.#abort.delete(abort) }
  }

  #settle(result: IntakeAdmission): void {
    const current = this.#session!
    current.delegate_id = result.delegate_id ?? null
    this.#options.record(current, 'intake.dispatch', {
      accepted: result.accepted, delegate_id: current.delegate_id,
      questions_asked: current.questions_asked, work_order_chars: current.work_order?.length ?? 0,
    })
    this.#close(result.accepted ? 'dispatched' : 'admission_refused')
    if (!result.accepted) this.#options.fact(current, `任务尚未执行：${result.problem ?? result.code ?? 'runtime_rejected'}。可重新提出任务；若结果未知，先验证再重试。`)
  }

  #budget(): number { return {minimal: 1, balanced: 3, thorough: 5}[this.#options.settings.clarification_depth] }
  #malformed(current: IntakeSession): void {
    current.malformed += 1
    current.state = 'clarifying'
    this.#options.diagnostic('intake_malformed_result')
    if (current.malformed >= 2) this.#close('abandoned')
    else this.#options.fact(current, '暂时未能整理这次需求，任务尚未执行，请补充或重试。')
  }
  #close(outcome: NonNullable<IntakeSession['outcome']>): void {
    const current = this.#session!
    current.state = 'closed'
    current.outcome = outcome
    this.#assessPending = false
    this.#planPending = false
    for (const abort of this.#abort) abort.abort()
    if (current.proposal_id !== null && outcome !== 'dispatched') this.#options.invalidateProposal()
    if (outcome === 'abandoned') this.#options.fact(current, '抱歉，仍未能形成明确工作单，本次需求已结束，尚未执行。请重新说明具体目标。')
  }
}
