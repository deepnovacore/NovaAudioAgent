import type {TaskFence} from '../../personal-agent/tasks.js'
import type {TaskDispatchContext} from '../../core/task-tools.js'
import type {JsonValue} from '../../core/events.js'
import {z} from 'zod'
import {RealClock, raceDeadline, type Clock} from '../../core/clock.js'
import {GatewayError} from '../../model/model-gateway.js'
import {assessSchema, planSchema, type IntakeKind, type IntakeModels, type IntakeSlots} from './intake-model.js'
import type {ConfirmedProjectOperation, ProjectProposal} from '../../projects/project-confirmation.js'
import {renderWorkOrder, type WorkOrder} from './work-order.js'
import {
  ProjectResolutionError,
  type CoordinatorDecision,
  type IntakeTarget,
  type RosterEntry,
  type RunningWork,
} from '../coding-executor.js'
import {collapsePythonWhitespace, stripLikePython} from '../../text/python-text.js'
import {deriveSessionTitle} from '../../core/work-tools.js'

export type {IntakeTarget}
export interface IntakeSettings {
  readonly clarification_depth: 'minimal' | 'balanced' | 'thorough'
  readonly generate_plan?: boolean
  readonly support_model?: string
  readonly planner_model?: string
  readonly fast_model?: string
  readonly plan_readback: 'summary' | 'confirm' | 'silent'
}
export interface IntakeAdmission {
  readonly accepted: boolean
  readonly delegate_id?: string | null
  readonly code?: string
  readonly problem?: string | null
}
export interface IntakeSession {
  input_origin_ref?: string
  task_fence?: TaskFence
  intake_id: string
  revision: number
  plan_revision: number | null
  proposal_id: string | null
  workspace: string | null
  session_id: string
  origin_ref: string
  state: 'open' | 'clarifying' | 'ready_to_plan' | 'planning' | 'readback' | 'committing' | 'failed' | 'dispatch_unknown' | 'closed'
  /** `routed`: steer / cancel / resolution error went straight to the adapter, no plan cycle. */
  outcome: 'dispatched' | 'admission_refused' | 'cancelled' | 'abandoned' | 'routed' | null
  delegate_id: string | null
  request: Readonly<Record<string, JsonValue>>
  opening: string
  turns: {question: string | null; answer: string; project_question?: string; project_confirmation_superseded?: boolean}[]
  slots: IntakeSlots
  discovery: string[]
  questions_asked: number
  intent_to_proceed: boolean
  stop_asking: boolean
  pending_question: string | null
  pending_project_question: string | null
  confirmed_project: {project: string; turn_index: number; evidence: string} | null
  missing_goal_grace: number | null
  kind: IntakeKind | null
  execution_mode?: 'direct' | 'plan'
  direct_start_revision?: number | undefined
  bound_target?: {workspace_id: string | null; revision: number}
  decision: CoordinatorDecision | null
  target: IntakeTarget | null
  work_order: string | null
  /** Host-derived session title for a new thread (spec 08 Titles); set with the work order. */
  title: string | null
}

export interface IntakeOptions {
  readonly clock?: Clock
  readonly onStateChanged?: () => void
  readonly models: IntakeModels
  readonly settings: IntakeSettings
  readonly idFactory: () => string
  readonly roster: () => readonly RosterEntry[]
  readonly running: () => readonly RunningWork[]
  readonly activeProject: () => string | null
  /** Conversation-owned IDs only; captured before asynchronous intake work. */
  readonly boundTarget?: () => {workspace_id: string | null; revision: number}
  readonly resolveTarget: (decision: CoordinatorDecision,taskContext?:TaskDispatchContext) => Promise<IntakeTarget>
  /** Open the project-confirmation proposal for `session.target`; the confirmed commit is the only side effect. */
  readonly prepare: (session: Readonly<IntakeSession>) => ProjectProposal
  readonly dispatch: (session: Readonly<IntakeSession>, stillWanted?: () => boolean) => IntakeAdmission | Promise<IntakeAdmission>
  readonly steer: (session: Readonly<IntakeSession>, project: string | null, instruction: string, stillWanted?: () => boolean) => IntakeAdmission | Promise<IntakeAdmission>
  readonly invalidateProposal: () => void
  readonly fact: (session: Readonly<IntakeSession>, text: string, kind?: 'accepted') => void
  readonly record: (session: Readonly<IntakeSession>, kind: string, data: Readonly<Record<string, JsonValue>>) => void
  readonly diagnostic: (code: string) => void
  /** Host-only retrieval; model output never supplies evidence or resolvable locators. */
  readonly attachEvidence?: (order: WorkOrder, workspace: string | null, signal: AbortSignal, target?: IntakeTarget | null) => Promise<Pick<WorkOrder, 'references' | 'evidence_excerpts'>>
}

/** Events and confirmed-host results only; lifecycle decisions stay with the coding controller. */
export type IntakeEventPort = Pick<IntakeController,
  'userInputStarted' | 'userInputEnded' | 'userInputFailed' | 'userResponseCompleted' | 'cancel' | 'decline' | 'beginConfirmed' | 'settleConfirmed' |
  'workspaceChanged' | 'factEligible' | 'preparing'>

const emptySlots = (): IntakeSlots => ({
  goal: {state: 'missing', note: ''}, scope: {state: 'missing', note: ''},
  acceptance: {state: 'missing', note: ''}, constraints: {state: 'missing', note: ''},
})
const limit = (value: string, count: number): string => [...value].slice(0, count).join('')
type IntakeStage = 'assess' | 'plan' | 'resolve' | 'prepare' | 'evidence' | 'dispatch' | 'steer'

/** Only fixed classifications enter memory or speech; never provider bodies or error messages. */
function failureReason(error: unknown): string {
  if (error instanceof GatewayError) {
    if (['HTTPStatus401', 'HTTPStatus403'].includes(error.classification)) return 'authentication'
    if (error.classification === 'HTTPStatus429') return 'rate_limit'
    if (/^HTTPStatus5\d\d$/u.test(error.classification)) return 'server_error'
    if (error.classification === 'TimeoutError') return 'timeout'
    if (error.classification === 'TransportError') return 'transport'
    if (error.classification === 'InvalidResponse') return 'invalid_output'
    return 'provider_rejected'
  }
  if (error instanceof SyntaxError || error instanceof z.ZodError
    || (error instanceof TypeError && error.message === 'intake_output_too_large')) return 'invalid_output'
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout'
  return 'internal_error'
}

/** Schema paths, issue codes and error classes only: never model text, values or messages. */
function failureDetail(error: unknown): string | null {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_.:>|-]/gu, '_').slice(0, 300)
  if (error instanceof z.ZodError) {
    return safe(error.issues.slice(0, 6).map(issue => `${issue.path.join('.') || '$'}:${issue.code}`
      + (issue.code === 'invalid_type' ? `>${String(issue.expected)}` : '')).join('|'))
  }
  if (error instanceof SyntaxError) return 'json_parse'
  if (error instanceof TypeError && error.message === 'intake_output_too_large') return 'output_too_large'
  if (error instanceof GatewayError) return ['authentication', 'rate_limit', 'timeout', 'transport'].includes(failureReason(error)) ? null : safe(error.classification)
  if (error instanceof Error && failureReason(error) === 'internal_error') return safe(`error:${error.name}`)
  return null
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

// ponytail: recognize explicit directive clauses only; uncertain paraphrases retain confirmation.
const directiveText = (text: string): string => text.replace(/"[^"]*"|“[^”]*”|‘[^’]*’|「[^」]*」|`[^`]*`|(?<![\p{L}\p{N}])'[^']*'(?![\p{L}\p{N}])/gu, '')
const directStartRequested = (text: string): boolean => {
  const plain = directiveText(text)
  if (/[?？]|先(?:问|确认)|不允许|不准|禁止|\b(?:before|forbidden|not allowed)\b/iu.test(plain)) return false
  return plain.split(/[，,。.!！;；\n]/u).some(clause => /^(?:请|现在|这次|那就)?(?:(?:直接开始|直接做)(?:(?:吧|即可|就行)|(?:修复|修改|实现|处理|执行).*)?|不用再确认|无需再确认|go ahead|start directly|proceed without confirmation)$/iu.test(clause.trim()))
}
// A later session directive replaces earlier authority; ordinary factual answers preserve it.
const latestSessionDirective = (texts: readonly string[]): string => {
  let latest = ''
  for (const text of texts.map(directiveText)) {
    if (/继续|接着|会话|\b(?:continue|resume|session|thread)\b/iu.test(text)
      || (latest && /先(?:问|确认)|不确定/iu.test(text))) latest = text
  }
  return latest
}
const continuationIntent = (texts: readonly string[]): 'none' | 'new' | 'latest' | 'unclear' => {
  const plain = latestSessionDirective(texts)
  if (/(?:不要|别|不再|不是|不)(?:再)?继续|(?:新开|重新开|另开).{0,6}会话|新会话|\b(?:new|fresh) (?:session|thread)\b|\b(?:do not|don't) (?:continue|resume)\b/iu.test(plain)) return 'new'
  if (/继续|接着|先(?:问|确认)|不确定|\b(?:continue|resume)\b/iu.test(plain)) {
    return !/[?？]|之前|先(?:问|确认)|不允许|不确定|是否/iu.test(plain)
      && /(?:^|[，,。.!！;；\n])\s*(?:请|现在|那就)?(?:在(?:当前项目|当前工作区|本项目|这个项目)(?:里|中)?\s*)?(?:(?:继续|接着)(?=[^，,。.!！;；\n]*(?:任务|会话|工作区|项目|session\b|thread\b))|(?:continue|resume)\b)/iu.test(plain) ? 'latest' : 'unclear'
  }
  return 'none'
}
const currentWorkspaceReference = (project: string | null): string | null => project !== null
  && /^(?:当前项目|当前工作区|本项目|这个项目|current project|current workspace)$/iu.test(stripLikePython(project)) ? null : project

/** Missing/misbound model fields are service failures, never additional user questions. */
function projectConfirmationProblem(result: z.infer<typeof assessSchema>, snapshot: IntakeSession, active: string | null, roster: readonly string[]): string | null {
  const turns = snapshot.turns
  if (result.abandon) return null
  const confirmation = result.project_confirmation
  const latestProjectTurn = turns.findLastIndex(turn => turn.project_question !== undefined)
  if (latestProjectTurn === turns.length - 1 && latestProjectTurn >= 0 && confirmation === null) {
    return 'Interpret the latest project_question answer and return project_confirmation with its turn_index, decision and exact answer evidence.'
  }
  if (confirmation === null) {
    if (!['unclear', 'create'].includes(result.kind) && result.project_evidence === null
      && snapshot.confirmed_project?.project !== (result.project ?? active)
      && turns.some(turn => turn.project_question === (result.project ?? active))) {
      return 'Preserve a still-valid project confirmation by referencing its question turn and exact answer; otherwise resolve the changed target.'
    }
    return null
  }
  const turn = turns[confirmation.turn_index]
  if (!turn?.project_question || turn.project_confirmation_superseded || confirmation.turn_index !== latestProjectTurn || !turn.answer.includes(confirmation.evidence)) {
    return 'project_confirmation must quote the answer to the most recent host-owned project_question; never invent or reuse superseded evidence.'
  }
  const selected = result.project ?? active
  if (confirmation.decision === 'confirmed') {
    if (['create', 'unclear'].includes(result.kind) || selected !== turn.project_question) return 'A confirmed project_question must select that same existing project.'
  } else if (confirmation.decision === 'redirected') {
    if (result.kind === 'unclear' || result.project === null || selected === turn.project_question) {
      return 'A redirected answer must explicitly select a different target; otherwise return rejected/unclear with kind unclear.'
    }
    if (result.kind !== 'create' && !evidenceOccurs(result.project_evidence ?? '', result.project, [turn.answer], roster)) {
      return 'Redirecting to an existing project requires project_evidence naming that project in the answer to this question.'
    }
  } else if (result.kind !== 'unclear') {
    return 'Rejected or unclear project answers require kind unclear. Do not create a workspace or fall back to the active project. Use redirected only for an explicit replacement target.'
  }
  return null
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
  if (error.code === 'unknown_session' && detail.reason === 'continuation_target_required') return 'code=unknown_session：请在“Codex 会话（续接目标）”里选择要继续的会话，或明确说出会话名称。任务尚未执行。'
  if (error.code === 'unknown_project' && detail.reason === 'explicit_project_required') return 'code=unknown_project：这个对话还没有选择执行工作区，请在“执行工作区”里选择已注册目录，或明确说出项目名。任务尚未执行。'
  if (error.code === 'unknown_session') return `code=unknown_session：没有找到“${text(detail.title)}”这个可继续的会话，请明确项目和会话名称。任务尚未执行。`
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

/** Two controller-owned single-flight slots; latest revision replaces pending work, never active work. */
export class IntakeController {
  #taskContext:TaskDispatchContext|undefined
  #taskAuthority: (()=>boolean)|undefined
  readonly #options: IntakeOptions
  readonly #clock: Clock
  #session: IntakeSession | null = null
  #assessing: Promise<void> | null = null
  #planning: Promise<void> | null = null
  #assessPending = false
  #planPending = false
  #userInputPending = false
  #failedUserInput = false
  #workspaceId: string | null | undefined = undefined
  readonly #abort = new Set<AbortController>()
  readonly #modelResults = new Map<string, unknown>()
  readonly #modelBudgets = new Map<string, {attempts: number; deadline: number}>()

  constructor(options: IntakeOptions) { this.#options = options; this.#clock = options.clock ?? new RealClock() }
  get view(): Readonly<IntakeSession> | null { return this.#session === null ? null : structuredClone(this.#session) }
  get active(): boolean { return this.#session !== null && this.#session.state !== 'closed' }
  get preparing(): boolean {
    return this.active && !['failed', 'dispatch_unknown'].includes(this.#session!.state)
      && (this.#assessPending || this.#planPending || this.#assessing !== null
      || this.#planning !== null || this.#session?.state === 'committing')
  }
  userInputStarted(): void { if (this.active) this.#userInputPending = true }
  userInputEnded(): void {
    // A transcript is context, not an amendment decision. Hold old async work until dispatch.
    if (!this.active || this.#session?.proposal_id !== null) this.#userInputPending = false
  }

  userInputFailed(): void {
    if (!this.active || ['committing', 'dispatch_unknown'].includes(this.#session!.state)) return
    this.userInputEnded()
    // A missing amendment must not be bypassed by an unrelated conversation turn.
    if (this.#session?.proposal_id === null && !this.#failedUserInput) {
      this.#userInputPending = true
      this.#failedUserInput = true
      this.#options.fact(this.#session, '刚才没听清，原需求已保留，任务尚未执行。请再说一次。')
    }
  }

  userResponseCompleted(): void {
    if (this.#failedUserInput || !this.#userInputPending || !this.active || this.#session?.proposal_id !== null) return
    this.#userInputPending = false
    if (['failed', 'dispatch_unknown', 'committing'].includes(this.#session.state)) return
    if (this.#assessing === null && this.#planning === null) {
      if ((this.#session.plan_revision === this.#session.revision && this.#session.work_order !== null) || this.#session.state === 'ready_to_plan') this.#planPending = true
      else if (this.#session.pending_question === null) this.#assessPending = true
    }
    this.#pump()
  }

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
      && (!eventId.endsWith(':accepted') || (this.preparing && intake.plan_revision === null && intake.state !== 'committing' && !this.#userInputPending))
  }

  open(request: Readonly<Record<string, JsonValue>>, text: string, originRef: string, sessionId: string, taskContext?: TaskDispatchContext,inputOriginRef=originRef): 'intake_opened' | 'intake_in_progress' {
    const previous=this.#session?.task_fence
    if(this.active&&taskContext&&(previous?.task_id!==taskContext.fence.task_id||previous.goal_revision!==taskContext.fence.goal_revision||previous.control_revision!==taskContext.fence.control_revision))this.cancel()
    this.#taskContext=taskContext
    this.#taskAuthority=taskContext?.stillWanted
    this.#userInputPending = false
    this.#failedUserInput = false
    if (this.active && this.#session!.session_id !== sessionId) this.cancel()
    if (this.active && (this.#session!.state === 'committing' || this.#session!.state === 'dispatch_unknown')) return 'intake_in_progress'
    if (this.active && !this.#bindingCurrent(this.#session!)) this.cancel()
    if (this.active) {
      const current = this.#session!
      // A provider repeats the draft for an already-ingested answer: one content revision per turn.
      if ((current.input_origin_ref??current.origin_ref) !== inputOriginRef) this.#revise(text, inputOriginRef, sessionId)
      return 'intake_in_progress'
    }
    this.#session = {
      ...(taskContext ? {task_fence:{...taskContext.fence}} : {}),
      intake_id: this.#options.idFactory(), revision: 1, plan_revision: null, proposal_id: null,
      workspace: null, session_id: sessionId,
      ...(this.#options.boundTarget ? {bound_target: {...this.#options.boundTarget()}} : {}),
      origin_ref: originRef, input_origin_ref:inputOriginRef, state: 'open', outcome: null, delegate_id: null,
      request: structuredClone(request), opening: limit(text, 4000), turns: [], slots: emptySlots(), discovery: [],
      questions_asked: 0, intent_to_proceed: false, stop_asking: false, pending_question: null, pending_project_question: null, confirmed_project: null,
      missing_goal_grace: null, kind: null, decision: null, target: null, work_order: null, title: null,
    }
    this.#assessPending = true
    this.#pump()
    this.#options.fact(this.#session, '收到，我来处理。', 'accepted')
    return 'intake_opened'
  }

  #revise(text: string, originRef: string, sessionId: string): void {
    const current = this.#session
    if (current === null || !this.active) return
    if (current.session_id !== sessionId) { this.cancel(); return }
    if ((current.input_origin_ref??current.origin_ref) === originRef) return
    if (stripLikePython(text) === '') { this.cancel(); return }
    current.turns.push({question: current.pending_question, answer: limit(text, 2000),
      ...(current.pending_project_question === null ? {} : {project_question: current.pending_project_question})})
    if (current.turns.length > 8) { this.#close('abandoned'); return }
    this.#modelResults.clear()
    this.#modelBudgets.clear()
    current.revision += 1
    for (const abort of this.#abort) abort.abort()
    current.input_origin_ref=originRef
    if(!current.task_fence)current.origin_ref = originRef
    current.plan_revision = null
    current.work_order = null
    current.title = null
    if (current.proposal_id !== null) this.#options.invalidateProposal()
    current.proposal_id = null
    current.pending_question = null
    current.pending_project_question = null
    current.stop_asking = current.questions_asked >= this.#budget()
    current.state = 'clarifying'
    this.#planPending = false
    this.#assessPending = true
    this.#pump()
  }

  cancel(): void { if (this.active) this.#close('cancelled') }

  beginConfirmed(operation: ConfirmedProjectOperation): boolean {
    const current = this.#session
    if (this.#taskAuthority?.()===false || this.#userInputPending || current?.state !== 'readback' || current.proposal_id !== operation.proposal_id
      || current.plan_revision !== current.revision || operation.intake_id !== current.intake_id
      || operation.plan_revision !== current.plan_revision || operation.work_order !== current.work_order) return false
    if (!this.#bindingCurrent(current)) { this.cancel(); return false }
    current.state = 'committing'
    this.#options.onStateChanged?.()
    return true
  }

  settleConfirmed(result: IntakeAdmission): void {
    if (this.#session?.state !== 'committing') return
    if (result.code === 'callback_failed') this.#failure(this.#session, 'dispatch', new Error('commit receipt unavailable'))
    else this.#settle(result)
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
    return (this.#taskAuthority?.()??true) && current?.intake_id === id && current.revision === revision && current.state !== 'closed' ? current : null
  }

  #current(id: string, revision: number): IntakeSession | null {
    const current = this.#live(id, revision)
    if (current && current.state !== 'committing' && !this.#bindingCurrent(current)) { this.cancel(); return null }
    if (current === null) this.#options.diagnostic('intake_stale_result')
    return current
  }

  #bindingCurrent(current: IntakeSession): boolean {
    return current.bound_target === undefined || current.bound_target.revision === this.#options.boundTarget?.().revision
  }

  #userEvidence(current: IntakeSession): string[] {
    const quotes = current.request.source_quotes
    return [...(Array.isArray(quotes) ? quotes.filter((quote): quote is string => typeof quote === 'string') : []),
      current.opening, ...current.turns.map(turn => turn.answer)]
  }

  #input(current: IntakeSession): Readonly<Record<string, unknown>> {
    return {
      intake_id: current.intake_id, revision: current.revision, opening: current.opening,
      instruction: current.request.work_order ?? current.request.instruction ?? null,
      conversation_context: current.request.conversation_context ?? [],
      source_quotes: current.request.source_quotes ?? [],
      turns: structuredClone(current.turns), confirmed_project: structuredClone(current.confirmed_project), slots: structuredClone(current.slots),
      discovery: [...current.discovery], intent_to_proceed: current.intent_to_proceed,
      questions_asked: current.questions_asked, question_budget: this.#budget(),
      roster: this.#options.roster(), active_project: this.#options.activeProject(),
      running: this.#options.running(),
    }
  }

  #pump(): void {
    this.#options.onStateChanged?.()
    if (!this.active || this.#userInputPending || ['failed', 'dispatch_unknown'].includes(this.#session!.state)) return
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
    let stage: IntakeStage = 'assess'
    try {
      const input = this.#input(snapshot)
      const result = await this.#model(snapshot, 'assess', assessSchema.transform(result => ({...result, project: currentWorkspaceReference(result.project)})).superRefine((result, ctx) => {
        // A stale binding cannot answer this revision's project question; discard it below.
        if (result.intake_id !== snapshot.intake_id || result.revision !== snapshot.revision) return
        const problem = projectConfirmationProblem(result, snapshot, input.active_project as string | null, (input.roster as readonly RosterEntry[]).map(entry => entry.name))
        if (problem !== null) ctx.addIssue({code: 'custom', message: problem, path: ['project_confirmation']})
      }), input, abort)
      if (result === null) return
      let current = this.#current(snapshot.intake_id, snapshot.revision)
      if (current === null) return
      let sessionTitle = result.session.mode === 'named' ? result.session.title : null
      if (result.intake_id !== snapshot.intake_id || result.revision !== snapshot.revision) {
        this.#options.diagnostic('intake_stale_result'); return
      }
      if (result.abandon) { this.cancel(); return }
      this.#options.record(current, 'intake.assess', {...result, input_active_project: input.active_project as string | null})
      current.slots = result.slots
      current.execution_mode = result.execution_mode
      current.direct_start_revision = result.early_exit && directStartRequested(current.turns.at(-1)?.answer ?? current.opening) ? current.revision : undefined
      current.intent_to_proceed = result.intent_to_proceed || result.early_exit
      current.discovery = [...new Set([...current.discovery, ...result.discovery,
        ...(result.candidate_question?.owner === 'repo' ? [result.candidate_question.text] : [])])].slice(0, 12)
      let kind: IntakeKind = result.kind
      let question = result.candidate_question?.owner === 'user' ? result.candidate_question.text : null
      const active = this.#options.activeProject()
      const project = result.project ?? (kind === 'create' ? null : active)
      // The model interprets the answer; the host validates the exact question/answer provenance.
      const confirmation = result.project_confirmation
      if (confirmation !== null && confirmation.decision !== 'confirmed') {
        current.turns[confirmation.turn_index]!.project_confirmation_superseded = true
      }
      if (kind === 'unclear' && confirmation === null) {
        for (const turn of current.turns) if (turn.project_question !== undefined) turn.project_confirmation_superseded = true
      }
      const prior = current.confirmed_project
      if (prior !== null && (kind === 'unclear' || kind === 'create' || project !== prior.project
        || (confirmation !== null && confirmation.decision !== 'confirmed'))) {
        current.turns[prior.turn_index]!.project_confirmation_superseded = true
        current.confirmed_project = null
      }
      if (confirmation?.decision === 'confirmed' && !['unclear', 'create'].includes(kind)) {
        current.confirmed_project = {project: project!, turn_index: confirmation.turn_index, evidence: confirmation.evidence}
      }
      const affirmed = current.confirmed_project?.project === project
      let projectQuestion: string | undefined
      if (kind === 'unclear' && confirmation?.decision === 'unclear'
        && project === current.turns[confirmation.turn_index]?.project_question) {
        question = `是在 ${project} 里做吗？`
        projectQuestion = project ?? undefined
      }
      const namedSessionEvidence = project !== null && this.#namedSessionEvidence(project, sessionTitle, current)
      if (kind !== 'create' && kind !== 'unclear' && project !== null && project !== active && !affirmed
        && !evidenceOccurs(result.project_evidence ?? '', project,
          this.#userEvidence(current), this.#options.roster().map(entry => entry.name))
          && !namedSessionEvidence) {
        this.#options.diagnostic('intake_project_evidence_missing')
        kind = 'unclear'
        question = `是在 ${project} 里做吗？`
        projectQuestion = project
      }
      const continuation = continuationIntent([current.opening, ...current.turns.map(turn => turn.answer)])
      // An explicit "continue the original session" may come back named with that project's latest title: same session.
      // Literal title text in the user's words stays a named claim that needs evidence.
      const latestNamed = continuation === 'latest' && sessionTitle !== null && !namedSessionEvidence
        && this.#options.roster().find(entry => entry.name === project)?.last_session_title === sessionTitle
        && ![current.opening, ...current.turns.map(turn => turn.answer)].some(text => text.includes(sessionTitle!))
      if (latestNamed) sessionTitle = null
      const sessionMode = latestNamed ? 'latest' : result.session.mode
      if ((kind === 'work' && ((continuation === 'unclear' && sessionMode !== 'new' && !namedSessionEvidence) || (continuation === 'latest' && sessionMode === 'new')))
        || (sessionTitle && project !== null && (continuation === 'new' || !namedSessionEvidence))) {
        kind = 'unclear'
        question = '请明确要继续的项目和会话名称。'
        projectQuestion = undefined
      }
      current.kind = kind
      if (kind === 'unclear' || (kind === 'create' && project === null)) {
        this.#ask(current, kind === 'create' ? '新项目叫什么名字？' : question ?? '请说明要在哪个项目里做什么。', projectQuestion)
        return
      }
      // Keep the user's request and later corrections together. A project affirmation is target
      // evidence, not a replacement instruction. The executor still enforces its input bound.
      const userText = [...(Array.isArray(current.request.source_quotes) ? current.request.source_quotes.filter((quote): quote is string => typeof quote === 'string') : []), current.opening, ...current.turns.map(turn => turn.question === null
        ? `用户补充：${turn.answer}`
        : `宿主追问：${turn.question}\n用户补充：${turn.answer}`)].join('\n')
      // Local onset precedes final ASR and does not advance the intake revision yet.
      if (kind === 'steer' && this.#userInputPending) return
      if (kind === 'steer') {
        if (!this.#options.running().some(work => work.project === project)) {
          this.#route(current, 'code=no_active_turn：目标工作区没有正在执行的任务，本次追加要求未执行。')
          return
        }
        const wanted = this.#launchWanted(current)
        stage = 'steer'
        current.state = 'committing'
        const admission = await this.#options.steer(current, project, userText, wanted)
        if (this.#current(snapshot.intake_id, snapshot.revision) !== current) return
        this.#options.record(current, 'intake.steer', {accepted: admission.accepted, delegate_id: admission.delegate_id ?? null})
        this.#route(current, admission.accepted
          ? 'code=steered：已把追加要求交给正在执行的任务，等待宿主进度。'
          : `code=steer_failed：追加要求未送达：${admission.problem ?? admission.code ?? 'runtime_rejected'}。`)
        return
      }
      const decision: CoordinatorDecision = {kind: kind === 'switch' ? 'switch' : kind === 'create' ? 'create' : 'work', project, session: sessionTitle || (sessionMode === 'latest' && continuation === 'latest') ? 'latest' : 'new', ...(sessionTitle ? {session_title: sessionTitle} : {})}
      let target: IntakeTarget
      stage = 'resolve'
      try {
        target = await raceDeadline(this.#options.resolveTarget(decision,this.#taskContext), this.#clock, 30, abort.signal,
          () => new DOMException('resolution deadline', 'TimeoutError'))
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
        stage = 'prepare'
        // No plan cycle, still confirmed: every change of the active project is confirmed by the user
        // before any side effect (decision 2026-09-04), and creating a workspace is irreversible.
        current.plan_revision = current.revision
        current.work_order = null
        current.title = null
        if (this.#userInputPending) return
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
    } catch (error) {
      if (!abort.signal.aborted) this.#failure(snapshot, stage, error)
    } finally { abort.abort(); this.#abort.delete(abort) }
  }

  #namedSessionEvidence(project: string, title: string | null | undefined, current: IntakeSession): boolean {
    if (!title) return false
    const roster = this.#options.roster()
    const evidence = [current.opening, ...current.turns.map(turn => turn.answer)].map(directiveText)
    const namedProject = evidence.some(text => text.includes(project))
    if (!namedProject && roster.filter(entry => entry.sessions?.includes(title)).length !== 1) return false
    const text = latestSessionDirective(evidence), index = text.indexOf(title)
    if (!roster.some(entry => entry.name === project && entry.sessions?.includes(title))
      || index < 0 || /[?？]|不确定|是否|之前|先(?:问|确认)|\b(?:not sure|before)\b/iu.test(text)
      || /(?:不允许|不要|别(?!的)|不准|禁止|\bdo not|\bdon't)[^，,。.!！;；\n]*$/iu.test(text.slice(0, index))) return false
    const before = text.slice(0, index).trimEnd(), after = text.slice(index + title.length).trimStart()
    return /(?:继续|接着|\bcontinue|\bresume)\s*$/iu.test(before)
      || (/(?:在|用|使用|切换到|\bin(?: the)?)\s*$/iu.test(before) && /^(?:(?:这个)?会话|session\b)/iu.test(after))
  }

  async #plan(snapshot: IntakeSession): Promise<void> {
    const abort = new AbortController()
    this.#abort.add(abort)
    let stage: IntakeStage = 'plan'
    try {
      const generatePlan = this.#options.settings.generate_plan !== false && snapshot.execution_mode !== 'direct'
      const result = !generatePlan ? {
        intake_id: snapshot.intake_id, revision: snapshot.revision,
        work_order: {objective: snapshot.slots.goal.note, scope_in: [], scope_out: [], acceptance: [], constraints: [], discovery: [], assumptions: []},
      } : await this.#model(snapshot, 'plan', planSchema, this.#input(snapshot), abort)
      if (result === null) return
      const current = this.#current(snapshot.intake_id, snapshot.revision)
      if (current === null) return
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
      if (current.plan_revision !== current.revision) {
        stage = 'evidence'
        const evidenceStarted = this.#clock.now()
        const evidence = this.#options.attachEvidence === undefined ? undefined
          : await raceDeadline(this.#options.attachEvidence(order, current.workspace, abort.signal, current.target), this.#clock, 30, abort.signal,
            () => new DOMException('evidence deadline', 'TimeoutError'))
        if (this.#current(snapshot.intake_id, snapshot.revision) !== current || abort.signal.aborted) return
        this.#options.record(current, 'intake.timing', {stage: 'evidence', elapsed_ms: Math.round((this.#clock.now() - evidenceStarted) * 1000)})
        current.work_order = renderWorkOrder({...order, ...evidence})
        current.title = deriveSessionTitle(order.objective)
        current.plan_revision = current.revision
        current.state = 'readback'
        this.#options.record(current, 'plan.compile', {work_order: current.work_order, generated: generatePlan})
      }
      // A spoken amendment may still be awaiting ASR. Never execute the old plan in that gap.
      if (this.#userInputPending) return
      const project = current.target?.workspace_display_name ?? ''
      // The readback line always names the project. A plan that changes the active project (create, or
      // work quoted into another project) is confirmed under every `plan_readback` (decision 2026-09-04).
      const direct = current.direct_start_revision === current.revision && current.kind === 'work'
        && current.bound_target?.workspace_id != null && current.bound_target.workspace_id === current.target?.workspace_id
        && (current.target.action === 'reuse' || current.target.action === 'resume')
      if ((this.#options.settings.plan_readback === 'confirm' && !direct) || project !== this.#options.activeProject()) {
        stage = 'prepare'
        this.#propose(current, `计划（项目 ${project}）：${limit(order.objective, 200)}`)
        return
      }
      current.state = 'committing'
      const wanted = this.#launchWanted(current)
      stage = 'dispatch'
      const admission = await this.#options.dispatch(current, wanted)
      if (this.#current(snapshot.intake_id, snapshot.revision) === current) this.#settle(admission)
    } catch (error) {
      if (!abort.signal.aborted) this.#failure(snapshot, stage, error)
    } finally { abort.abort(); this.#abort.delete(abort) }
  }

  #ask(current: IntakeSession, question: string, project?: string): void {
    if (current.questions_asked >= this.#budget()) { this.#close('abandoned'); return }
    current.questions_asked += 1
    current.pending_question = question
    current.pending_project_question = project ?? null
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

  #launchWanted(current: IntakeSession): () => boolean {
    const revision = current.revision
    // Admission transfers ownership to the delegate. Completing intake does not cancel it.
    const taskAuthority=this.#taskAuthority
    return () => (taskAuthority?.()??true) && current.revision === revision && (
      current.outcome === 'dispatched' || current.outcome === 'routed'
      || (this.#session === current && current.state !== 'closed' && !this.#userInputPending)
    )
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
  /** Retry only pure model calls, never resolution, confirmation, steering or admission. */
  async #model<T>(snapshot: IntakeSession, stage: 'assess' | 'plan', schema: z.ZodType<T>,
    input: Readonly<Record<string, unknown>>, abort: AbortController): Promise<T | null> {
    const key = `${snapshot.intake_id}:${snapshot.revision}:${stage}`
    if (this.#modelResults.has(key)) return schema.parse(this.#modelResults.get(key))
    const budget = this.#modelBudgets.get(key) ?? {attempts: 0, deadline: this.#clock.now() + 30}
    this.#modelBudgets.set(key, budget)
    const deadline = budget.deadline
    let modelInput = input
    while (budget.attempts < 2) {
      if (abort.signal.aborted || this.#live(snapshot.intake_id, snapshot.revision) === null) return null
      if (this.#clock.now() >= deadline) {
        this.#failure(snapshot, stage, new DOMException('model deadline', 'TimeoutError'), budget.attempts)
        return null
      }
      const requestInput = modelInput
      const started = this.#clock.now()
      const attempt = ++budget.attempts
      const timeout = new AbortController()
      const signal = AbortSignal.any([abort.signal, timeout.signal])
      try {
        const raw = await raceDeadline(this.#options.models[stage](requestInput, signal), this.#clock,
          Math.max(0, deadline - this.#clock.now()), abort.signal,
          () => { timeout.abort(); return new DOMException('model deadline', 'TimeoutError') })
        if (this.#current(snapshot.intake_id, snapshot.revision) === null) return null
        const result = schema.parse(raw)
        this.#modelResults.set(key, result)
        this.#modelBudgets.delete(key)
        return result
      } catch (error) {
        if (abort.signal.aborted || this.#live(snapshot.intake_id, snapshot.revision) === null) return null
        const retrying = attempt < 2 && this.#clock.now() + 1 < deadline
          && ['rate_limit', 'server_error', 'transport', 'timeout', 'invalid_output'].includes(failureReason(error))
        if (error instanceof z.ZodError) modelInput = {...input, validation_feedback:
          error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 2000)}
        this.#failure(snapshot, stage, error, attempt, retrying)
        if (!retrying) return null
        try { await this.#clock.sleep(1, abort.signal) } catch { return null }
      } finally {
        timeout.abort()
        const current = this.#live(snapshot.intake_id, snapshot.revision)
        const model = stage === 'assess' ? this.#options.settings.support_model
          : (this.#options.settings.planner_model ?? '') !== ''
            ? this.#options.settings.planner_model : this.#options.settings.fast_model
        if (current !== null) this.#options.record(current, 'intake.timing', {stage, attempt,
          ...(model === undefined ? {} : {model}), input_chars: JSON.stringify(requestInput).length,
          elapsed_ms: Math.round((this.#clock.now() - started) * 1000)})
      }
    }
    return null
  }

  #failure(snapshot: IntakeSession, stage: IntakeStage, error: unknown, attempt = 1, retrying = false): void {
    const current = this.#live(snapshot.intake_id, snapshot.revision)
    if (current === null) return
    const reason = failureReason(error)
    const detail = failureDetail(error)
    const unknown = stage === 'dispatch' || stage === 'steer'
    if (!retrying) {
      if (!unknown && current.proposal_id !== null) {
        this.#options.invalidateProposal()
        current.proposal_id = null
      }
      current.state = unknown ? 'dispatch_unknown' : 'failed'
      this.#assessPending = false
      this.#planPending = false
    }
    this.#options.record(current, 'intake.failure', {stage, reason, attempt, retrying, ...(detail === null ? {} : {detail})})
    this.#options.diagnostic(`intake_${stage}_${reason}`)
    if (detail !== null) this.#options.diagnostic(`intake_failure_detail stage=${stage} attempt=${attempt} detail=${detail}`)
    if (retrying) return
    this.#options.onStateChanged?.()
    this.#options.fact(current, unknown
      ? '派单结果暂时无法确认，任务可能已开始。需要先核实执行状态，不要重复派单。'
      : reason === 'authentication' || reason === 'provider_rejected'
        ? '计划服务的连接或配置需要检查。原需求已保留，任务尚未执行，修复后可以继续。'
        : '这次计划暂时未能生成，原需求已保留，任务尚未执行，可以稍后继续，无需重述需求。')
  }
  #close(outcome: NonNullable<IntakeSession['outcome']>): void {
    const current = this.#session!
    this.#modelResults.clear()
    this.#modelBudgets.clear()
    current.state = 'closed'
    current.outcome = outcome
    this.#assessPending = false
    this.#planPending = false
    for (const abort of this.#abort) abort.abort()
    if (current.proposal_id !== null && outcome !== 'dispatched') this.#options.invalidateProposal()
    this.#options.onStateChanged?.()
    if (outcome === 'abandoned') this.#options.fact(current, '抱歉，仍未能形成明确工作单，本次需求已结束，尚未执行。请重新说明具体目标。')
  }
}
