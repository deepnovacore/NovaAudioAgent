import type {JsonValue} from '../../events.js'
import {assessSchema, planSchema, type IntakeKind, type IntakeModels, type IntakeSlots} from './intake-model.js'
import type {ConfirmedProjectOperation, ProjectProposal} from '../../project-confirmation.js'
import {renderWorkOrder, type WorkOrder} from './work-order.js'
import {
  ProjectResolutionError,
  type CancelResult,
  type CoordinatorDecision,
  type IntakeTarget,
  type RosterEntry,
  type RunningWork,
} from '../../coding-executor.js'
import {collapsePythonWhitespace, stripLikePython} from '../../python-text.js'
import {deriveSessionTitle} from '../../work-tools.js'

export type {IntakeTarget}
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
  origin_ref: string
  state: 'open' | 'clarifying' | 'ready_to_plan' | 'planning' | 'readback' | 'committing' | 'closed'
  /** `routed`: steer / cancel / resolution error went straight to the adapter, no plan cycle. */
  outcome: 'dispatched' | 'admission_refused' | 'cancelled' | 'abandoned' | 'routed' | null
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
  kind: IntakeKind | null
  decision: CoordinatorDecision | null
  target: IntakeTarget | null
  work_order: string | null
  /** Host-derived session title for a new thread (spec 08 Titles); set with the work order. */
  title: string | null
}

export interface IntakeOptions {
  readonly models: IntakeModels
  readonly settings: IntakeSettings
  readonly idFactory: () => string
  readonly roster: () => readonly RosterEntry[]
  readonly running: () => readonly RunningWork[]
  readonly activeProject: () => string | null
  readonly resolveTarget: (decision: CoordinatorDecision) => Promise<IntakeTarget>
  /** Open the project-confirmation proposal for `session.target`; the confirmed commit is the only side effect. */
  readonly prepare: (session: Readonly<IntakeSession>) => ProjectProposal
  readonly dispatch: (session: Readonly<IntakeSession>, stillWanted?: () => boolean) => IntakeAdmission | Promise<IntakeAdmission>
  readonly steer: (session: Readonly<IntakeSession>, project: string | null, instruction: string, stillWanted?: () => boolean) => IntakeAdmission | Promise<IntakeAdmission>
  /** `stillWanted` is re-checked by the adapter after its model call, before any work is aborted. */
  readonly cancel: (instruction: string, stillWanted: () => boolean) => Promise<CancelResult>
  readonly invalidateProposal: () => void
  readonly fact: (session: Readonly<IntakeSession>, text: string) => void
  readonly record: (session: Readonly<IntakeSession>, kind: string, data: Readonly<Record<string, JsonValue>>) => void
  readonly diagnostic: (code: string) => void
  /** Host-only retrieval; model output never supplies evidence or resolvable locators. */
  readonly attachEvidence?: (order: WorkOrder, workspace: string | null, signal: AbortSignal) => Promise<Pick<WorkOrder, 'references' | 'evidence_excerpts'>>
}

/** Events and confirmed-host results only; lifecycle decisions stay with the coding controller. */
export type IntakeEventPort = Pick<IntakeController,
  'userInputStarted' | 'userTurn' | 'cancel' | 'decline' | 'beginConfirmed' | 'settleConfirmed' |
  'workspaceChanged' | 'factEligible'>

const emptySlots = (): IntakeSlots => ({
  goal: {state: 'missing', note: ''}, scope: {state: 'missing', note: ''},
  acceptance: {state: 'missing', note: ''}, constraints: {state: 'missing', note: ''},
})
const limit = (value: string, count: number): string => [...value].slice(0, count).join('')
const MAX_ROSTER = 10

/** This recognizes non-content turns only. It never grants execution authority. */
export function isPurePlanDecision(text: string): boolean {
  return /^(确认|可以|做吧|好|好的|同意|不同意|不行|取消|不用了|算了|yes|ok|okay|confirm|no|cancel)[。！!,.，\s]*$/iu.test(text.trim())
}

/**
 * The quoted span must occur in an utterance *and* overlap (one contains the other) exactly one roster
 * name, which must be the selected one: a filler like "改" vouches for nothing, and a shared prefix like
 * "pricing" for `pricing-page` / `pricing-svc` vouches for neither. Every utterance counts: binding to
 * the latest turn alone would loop on multi-turn clarifications. Whitespace- and case-insensitive.
 */
function evidenceOccurs(evidence: string, project: string, utterances: readonly string[], roster: readonly string[]): boolean {
  const normalize = (value: string): string => collapsePythonWhitespace(stripLikePython(value)).toLowerCase()
  const span = normalize(evidence)
  if (span === '' || !utterances.some(text => normalize(text).includes(span))) return false
  const named = roster.map(normalize).filter(name => span.includes(name) || name.includes(span))
  return named.length === 1 && named[0] === normalize(project)
}

/** Spoken rendering of a resolution error / cancel result: code first, then what the model needs to offer. */
export function renderResolutionError(error: ProjectResolutionError): string {
  const detail = error.detail
  const text = (value: JsonValue | undefined): string => typeof value === 'string' ? value : ''
  // A list of names, or of `{project, title}` records, whichever the adapter had at hand.
  const list = (value: JsonValue | undefined): string => Array.isArray(value)
    ? value.map(item => typeof item === 'object' && item !== null && !Array.isArray(item)
      ? `${text(item.project)}/${text(item.title)}`
      : text(item)).join('、')
    : ''
  if (error.code === 'unknown_project') {
    const suggestions = list(detail.suggestions)
    return `code=unknown_project：没有叫“${text(detail.project)}”的项目${suggestions === '' ? '' : `，相近的有：${suggestions}`}。可以请用户确认项目名，或明确要求新建。任务尚未执行。`
  }
  if (error.code === 'ambiguous_project') {
    return `code=ambiguous_project：“${text(detail.project)}”匹配多个项目：${list(detail.candidates)}。请用户说明是哪一个。任务尚未执行。`
  }
  if (error.code === 'busy_project') {
    return `code=busy_project：项目“${text(detail.project)}”正在执行“${text(detail.title)}”。可以追加要求（steer），或先取消再重新开始（cancel）。新任务尚未执行。`
  }
  return `code=capacity：同时运行的任务已达上限，正在跑：${list(detail.running)}。可以先取消一个。新任务尚未执行。`
}

export function renderCancelResult(result: CancelResult): string {
  if (result.code === 'cancelled') return `code=cancelled：已请求停止“${result.work.project}/${result.work.title}”，稍后有终态事实。`
  if (result.code === 'not_running') return 'code=not_running：当前没有正在执行的任务。'
  return `code=ambiguous_work：有多个任务在跑：${result.running.map(work => `${work.project}/${work.title}`).join('、')}。请用户说明要停哪一个。`
}

/** Two controller-owned single-flight slots; latest revision replaces pending work, never active work. */
export class IntakeController {
  readonly #options: IntakeOptions
  #session: IntakeSession | null = null
  #assessing: Promise<void> | null = null
  #planning: Promise<void> | null = null
  #assessPending = false
  #planPending = false
  #userInputPending = false
  #workspaceId: string | null | undefined = undefined
  readonly #abort = new Set<AbortController>()

  constructor(options: IntakeOptions) { this.#options = options }
  get view(): Readonly<IntakeSession> | null { return this.#session === null ? null : structuredClone(this.#session) }
  get active(): boolean { return this.#session !== null && this.#session.state !== 'closed' }
  userInputStarted(): void { if (this.active) this.#userInputPending = true }

  workspaceChanged(workspaceId: string | null): void {
    if (this.#workspaceId !== undefined && this.#workspaceId !== workspaceId
      && this.#session?.state !== 'committing') this.cancel()
    this.#workspaceId = workspaceId
  }
  factEligible(eventId: string, sessionEpoch: number): boolean {
    const intake = this.#session
    return intake?.session_id === String(sessionEpoch)
      && eventId.startsWith(`intake:${intake.intake_id}:${intake.revision}:`)
      && intake.outcome !== 'cancelled'
  }

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
      workspace: null, session_id: sessionId,
      origin_ref: originRef, state: 'open', outcome: null, delegate_id: null,
      request: structuredClone(request), opening: limit(text, 4000), turns: [], slots: emptySlots(), discovery: [],
      questions_asked: 0, intent_to_proceed: false, stop_asking: false, pending_question: null,
      missing_goal_grace: null, malformed: 0, kind: null, decision: null, target: null, work_order: null, title: null,
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
    if (stripLikePython(text) === '') { this.cancel(); return }
    if (current.proposal_id !== null && isPurePlanDecision(text)) return
    if (/^(取消|不用了|算了|cancel)[。！!.，\s]*$/iu.test(text.trim())) { this.cancel(); return }
    current.turns.push({question: current.pending_question, answer: limit(text, 2000)})
    if (current.turns.length > 8) { this.#close('abandoned'); return }
    current.revision += 1
    current.origin_ref = originRef
    current.plan_revision = null
    current.work_order = null
    current.title = null
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

  #live(id: string, revision: number): IntakeSession | null {
    const current = this.#session
    return current?.intake_id === id && current.revision === revision && current.state !== 'closed' ? current : null
  }

  #current(id: string, revision: number): IntakeSession | null {
    const current = this.#live(id, revision)
    if (current === null) this.#options.diagnostic('intake_stale_result')
    return current
  }

  #input(current: IntakeSession): Readonly<Record<string, unknown>> {
    return {
      intake_id: current.intake_id, revision: current.revision, opening: current.opening,
      instruction: current.request.work_order ?? current.request.instruction ?? null,
      turns: structuredClone(current.turns), slots: structuredClone(current.slots),
      discovery: [...current.discovery], intent_to_proceed: current.intent_to_proceed,
      questions_asked: current.questions_asked, question_budget: this.#budget(),
      roster: this.#options.roster().slice(0, MAX_ROSTER), active_project: this.#options.activeProject(),
      running: this.#options.running(),
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
      const raw = await this.#options.models.assess(this.#input(snapshot), AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]))
      let current = this.#current(snapshot.intake_id, snapshot.revision)
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
      let kind: IntakeKind = result.kind
      let question = result.candidate_question?.owner === 'user' ? result.candidate_question.text : null
      const active = this.#options.activeProject()
      const project = result.project ?? (kind === 'create' ? null : active)
      // Wrong-project protection: a non-active selection must be quoted from the utterance, never inferred.
      // The one host-authored exception is our own `是在 X 里做吗？` once the user has just affirmed it (an alias
      // like 博客→blog never contains the roster name, a bare 对 cannot, and `blog` next to `blog-v2` would
      // never pass the exactly-one check; without this the question loops).
      const latest = current.turns.at(-1)
      const affirmed = latest?.question === `是在 ${project} 里做吗？`
        && /^(是|对|嗯|好|可以|是的|对的|没错|yes|ok|okay)[。！!,.，\s]*$/iu.test(latest.answer.trim())
      if (kind !== 'create' && kind !== 'unclear' && project !== null && project !== active && !affirmed
        && !evidenceOccurs(result.project_evidence ?? '', project,
          [current.opening, ...current.turns.map(turn => turn.answer)], this.#options.roster().map(entry => entry.name))) {
        this.#options.diagnostic('intake_project_evidence_missing')
        kind = 'unclear'
        question = `是在 ${project} 里做吗？`
      }
      current.kind = kind
      if (kind === 'unclear' || (kind === 'create' && project === null)) {
        this.#ask(current, kind === 'create' ? '新项目叫什么名字？' : question ?? '请说明要在哪个项目里做什么。')
        return
      }
      if (!current.intent_to_proceed) {
        current.state = 'clarifying'
        this.#options.fact(current, '需求已记录，等待用户明确要求开始；不要继续追问或声称已执行。')
        return
      }
      // Keep the user's request and later corrections together. A project affirmation is target
      // evidence, not a replacement instruction. The executor still enforces its input bound.
      const userText = [current.opening, ...current.turns.map(turn => turn.question === null
        ? `用户补充：${turn.answer}`
        : `宿主追问：${turn.question}\n用户补充：${turn.answer}`)].join('\n')
      // Local onset precedes final ASR and does not advance the intake revision yet.
      if (this.#userInputPending) return
      if (kind === 'cancel') {
        const outcome = await this.#options.cancel(userText, () => !this.#userInputPending && this.#live(snapshot.intake_id, snapshot.revision) !== null)
        current = this.#current(snapshot.intake_id, snapshot.revision)
        if (current === null || this.#userInputPending) return
        this.#options.record(current, 'intake.cancel', {code: outcome.code})
        this.#route(current, renderCancelResult(outcome))
        return
      }
      if (kind === 'steer') {
        const wanted = () => !this.#userInputPending && this.#current(snapshot.intake_id, snapshot.revision) === current
        const admission = await this.#options.steer(current, project, userText, wanted)
        if (!wanted()) return
        this.#options.record(current, 'intake.steer', {accepted: admission.accepted, delegate_id: admission.delegate_id ?? null})
        this.#route(current, admission.accepted
          ? 'code=steered：已把追加要求交给正在执行的任务，等待宿主进度。'
          : `code=steer_failed：追加要求未送达：${admission.problem ?? admission.code ?? 'runtime_rejected'}。`)
        return
      }
      const decision: CoordinatorDecision = {kind: kind === 'switch' ? 'switch' : kind === 'create' ? 'create' : 'work', project, session: result.session}
      let target: IntakeTarget
      try {
        target = await this.#options.resolveTarget(decision)
      } catch (error) {
        current = this.#current(snapshot.intake_id, snapshot.revision)
        if (current === null) return
        if (!(error instanceof ProjectResolutionError)) throw error
        this.#options.record(current, 'intake.resolution_error', {code: error.code, ...error.detail})
        this.#route(current, renderResolutionError(error))
        return
      }
      current = this.#current(snapshot.intake_id, snapshot.revision)
      if (current === null) return
      current.decision = decision
      current.target = target
      current.workspace = target.workspace
      // The host computes readiness; a model cannot open the gate by inflating its score.
      const readiness = Object.values(result.slots).filter(value => value.state !== 'missing').length / 4
      current.stop_asking ||= result.early_exit || current.questions_asked >= this.#budget()
        || readiness >= (this.#options.settings.clarification_depth === 'thorough' ? 1 : .75)
      if (kind === 'switch' || (kind === 'create' && current.slots.goal.state === 'missing' && question === null)) {
        // No plan cycle, still confirmed: every change of the active project is confirmed by the user
        // before any side effect (decision 2026-09-04), and creating a workspace is irreversible.
        current.plan_revision = current.revision
        current.work_order = null
        current.title = null
        this.#propose(current, `${kind === 'switch' ? '切换到' : '新建'}项目“${target.workspace_display_name}”，不派任务`)
        return
      }
      if (!current.stop_asking && question !== null) {
        this.#ask(current, question)
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
      const evidence = this.#options.attachEvidence === undefined ? undefined
        : await this.#options.attachEvidence(order, current.workspace, abort.signal)
      if (this.#current(snapshot.intake_id, snapshot.revision) !== current || abort.signal.aborted) return
      current.work_order = renderWorkOrder({...order, ...evidence})
      current.title = deriveSessionTitle(order.objective)
      current.plan_revision = current.revision
      current.state = 'readback'
      this.#options.record(current, 'plan.compile', {work_order: current.work_order})
      // A spoken amendment may still be awaiting ASR. Never execute the old plan in that gap.
      if (this.#userInputPending) return
      const project = current.target?.workspace_display_name ?? ''
      // The readback line always names the project. A plan that changes the active project (create, or
      // work quoted into another project) is confirmed under every `plan_readback` (decision 2026-09-04).
      if (this.#options.settings.plan_readback === 'confirm' || project !== this.#options.activeProject()) {
        this.#propose(current, `计划（项目 ${project}）：${limit(order.objective, 200)}`)
        return
      }
      if (this.#options.settings.plan_readback === 'summary') this.#options.fact(current, `计划（项目 ${project}）：${limit(order.objective, 240)}。只读回这一句，不再追问；等待宿主派单结果。`)
      current.state = 'committing'
      const wanted = () => !this.#userInputPending && this.#current(snapshot.intake_id, snapshot.revision) === current
      const admission = await this.#options.dispatch(current, wanted)
      if (wanted()) this.#settle(admission)
    } catch {
      const current = this.#current(snapshot.intake_id, snapshot.revision)
      if (current !== null) this.#malformed(current)
    } finally { this.#abort.delete(abort) }
  }

  #ask(current: IntakeSession, question: string): void {
    if (current.questions_asked >= this.#budget()) { this.#close('abandoned'); return }
    current.questions_asked += 1
    current.pending_question = question
    current.state = 'clarifying'
    this.#options.fact(current, `只问下面这一个问题，不调用编码工具：${question}`)
  }

  #propose(current: IntakeSession, summary: string): void {
    const proposal = this.#options.prepare(current)
    current.proposal_id = proposal.proposal_id
    current.state = 'readback'
    this.#options.fact(current, `${proposal.confirmation_prompt} ${summary}。id=${proposal.proposal_id}；仅通过 confirm(id, accepted) 回答；修改需求会使此提议失效。`)
  }

  /** Closed without a plan cycle: the fact carries the adapter's structured code. */
  #route(current: IntakeSession, text: string): void {
    this.#close('routed')
    this.#options.fact(current, text)
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
