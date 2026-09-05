import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {VirtualClock} from '../src/clock.js'
import {IntakeController, type IntakeOptions} from '../src/executors/coding/intake.js'
import {intakeModels, type IntakeModels, type IntakeSlots} from '../src/executors/coding/intake-model.js'
import {ProjectConfirmationController} from '../src/project-confirmation.js'
import {renderWorkOrder, workOrderSchema} from '../src/executors/coding/work-order.js'
import {ProjectResolutionError, type CoordinatorDecision, type IntakeTarget} from '../src/coding-executor.js'
import {validateCodexRequest} from '../src/executors/codex/contract.js'

const stated = (note: string) => ({state: 'stated' as const, note})
const missing = {state: 'missing' as const, note: ''}
const slots: IntakeSlots = {goal: stated('Fix empty password'), scope: stated('Login only'), acceptance: stated('Show validation error'), constraints: stated('Keep public API')}
const order = workOrderSchema.parse({objective: slots.goal.note, scope_in: ['Login only'], acceptance: ['Show validation error']})
const assessment = (input: Readonly<Record<string, unknown>>, changes = {}) => ({
  intake_id: input.intake_id, revision: input.revision, slots, readiness: 1,
  kind: 'work', project: null, project_evidence: null, session: 'latest',
  intent_to_proceed: true, candidate_question: null, discovery: [], early_exit: false, abandon: false,
  ...changes,
})
const plan = (input: Readonly<Record<string, unknown>>) => ({intake_id: input.intake_id, revision: input.revision, work_order: order})
/** What the service hands `open` for a `dispatch` (spec 08): the coordinator decides project and session itself. */
const request = {work_order: 'draft', project: null, session: 'latest'}
const target: IntakeTarget = {workspace: '/canonical/project', action: 'reuse', workspace_display_name: 'Project', workspace_id: 'w1', session_title: 'Named task', session_id: null}
const running = [{work_id: 'w-blog', project: 'blog', title: '暗色模式'}]

type HarnessOptions = Partial<Omit<IntakeOptions, 'models'>> & {readonly models?: Partial<IntakeModels>}

function harness(options: HarnessOptions = {}) {
  let sequence = 0
  let planned = 0
  const facts: string[] = [], records: string[] = [], diagnostics: string[] = []
  const dispatched: unknown[] = []
  const decisions: CoordinatorDecision[] = []
  const steered: string[] = [], cancelled: string[] = []
  const {models, resolveTarget = () => Promise.resolve(target), ...rest} = options
  const confirmation = new ProjectConfirmationController({clock: new VirtualClock(), idFactory: () => `proposal-${++sequence}`})
  const intake = new IntakeController({
    idFactory: () => `intake-${++sequence}`,
    settings: {clarification_depth: 'balanced', plan_readback: 'summary'},
    models: {
      assess: input => Promise.resolve(assessment(input)),
      plan: input => { planned++; return Promise.resolve(plan(input)) },
      resolveCancelTarget: () => Promise.resolve(null),
      ...models,
    },
    roster: () => [
      {name: 'Project', last_used_at: 1, last_session_title: 'Named task', running: []},
      {name: 'blog', last_used_at: 0, last_session_title: '暗色模式', running},
    ],
    running: () => running,
    activeProject: () => 'Project',
    resolveTarget: decision => { decisions.push(decision); return resolveTarget(decision) },
    prepare: current => confirmation.prepare({...current.target!, intake_id: current.intake_id, plan_revision: current.plan_revision!, origin_ref: current.origin_ref, work_order: current.work_order}),
    dispatch: current => { dispatched.push(current); return {accepted: true, delegate_id: 'd1'} },
    steer: (_current, _project, instruction) => { steered.push(instruction); return {accepted: true, delegate_id: 'd-steer'} },
    cancel: instruction => { cancelled.push(instruction); return Promise.resolve({code: 'cancelled', work: running[0]!}) },
    invalidateProposal: () => { confirmation.invalidate('amended') },
    fact: (_current, text) => { facts.push(text) },
    record: (_current, kind) => { records.push(kind) },
    diagnostic: code => { diagnostics.push(code) },
    ...rest,
  })
  return {intake, confirmation, facts, records, diagnostics, dispatched, decisions, steered, cancelled, planned: () => planned}
}

/** The service's confirmed-commit path: `beginConfirmed` → adapter commit → `settleConfirmed`. */
function confirmProposal(h: ReturnType<typeof harness>, result = {accepted: true, delegate_id: 'd-confirmed'}) {
  const operation = h.confirmation.acceptDirectDecision({proposalId: h.intake.view!.proposal_id!, confirmed: true}).operation!
  assert.equal(h.intake.beginConfirmed(operation), true)
  assert.equal(h.intake.view?.state, 'committing')
  h.intake.settleConfirmed(result)
  return operation
}

test('intake zero-question fast path compiles once, preserves target/session and closes only on acceptance', async () => {
  const h = harness()
  h.intake.open(request, 'Fix empty password', 'conversation:1', 'epoch1')
  await h.intake.settled()
  assert.equal(h.intake.view?.outcome, 'dispatched')
  assert.equal(h.intake.view?.questions_asked, 0)
  assert.equal(h.intake.view?.workspace, '/canonical/project')
  assert.equal(h.intake.view?.target?.session_title, 'Named task')
  assert.equal(h.intake.view?.title, 'Fix empty password')
  assert.deepEqual(h.records, ['intake.assess', 'plan.compile', 'intake.dispatch'])
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.planned(), 1)
  assert.match(h.intake.view.work_order!, /^WorkOrder v2/)
})

for (const [depth, budget] of [['minimal', 1], ['balanced', 3], ['thorough', 5]] as const) {
  test(`intake ${depth} enforces ${budget} user questions and missing-goal grace`, async () => {
    let plans = 0
    const h = harness({settings: {clarification_depth: depth, plan_readback: 'summary'}, models: {
      assess: input => Promise.resolve(assessment(input, {slots: {goal: missing, scope: missing, acceptance: missing, constraints: missing}, readiness: 1, candidate_question: {owner: 'user', text: 'Which outcome?'}})),
      plan: input => { plans++; return Promise.resolve(plan(input)) },
    }})
    h.intake.open(request, 'Improve it', 'u1', 'e')
    await h.intake.settled()
    for (let index = 1; index <= budget; index++) {
      h.intake.userTurn('Something', `u${index + 1}`, 'e')
      await h.intake.settled()
    }
    assert.equal(h.intake.view?.questions_asked, budget)
    assert.equal(h.intake.view?.state, 'clarifying')
    assert.equal(plans, 0)
    h.intake.userTurn('Still vague', 'u-final', 'e')
    await h.intake.settled()
    assert.equal(h.intake.view?.outcome, 'abandoned')
    assert.equal(h.dispatched.length, 0)
  })
}

test('intake repo questions become discovery; inferred slots are never requirements', async () => {
  const h = harness({models: {
    assess: input => Promise.resolve(assessment(input, {
      slots: {...slots, scope: {state: 'inferred', note: 'CLI only'}, acceptance: missing, constraints: {state: 'inferred', note: 'Probably keep dependencies'}},
      candidate_question: {owner: 'repo', text: 'Find the test command'},
    })), plan: input => Promise.resolve(plan(input)),
  }})
  h.intake.open(request, 'Fix empty password', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.intake.view?.questions_asked, 0)
  assert.ok(!h.facts.some(text => text.includes('Find the test command')))
  const rendered = h.intake.view.work_order!
  assert.match(rendered, /Discovery.*\n- Find the test command/s)
  assert.match(rendered, /Assumptions.*\n- CLI only\n- Probably keep dependencies/s)
  assert.doesNotMatch(rendered.split('Assumptions')[0]!, /CLI only|Probably keep dependencies/)
})

test('intake early exit closes asking but still requires stated goal; exploration cannot plan', async () => {
  for (const [goal, proceed, early, expected] of [[missing, false, true, 0], [slots.goal, false, false, 0], [slots.goal, false, true, 1]] as const) {
    let plans = 0
    const h = harness({models: {
      assess: input => Promise.resolve(assessment(input, {slots: {...slots, goal}, intent_to_proceed: proceed, early_exit: early})),
      plan: input => { plans++; return Promise.resolve(plan(input)) },
    }})
    h.intake.open(request, 'Do it', 'u1', 'e')
    await h.intake.settled()
    assert.equal(plans, expected)
  }
})

test('intake confirms the exact compiled proposal without revision bump or recompile; replay fails', async () => {
  const h = harness({settings: {clarification_depth: 'balanced', plan_readback: 'confirm'}})
  h.intake.open(request, 'Fix it', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.intake.view?.state, 'readback')
  const proposalId = h.intake.view.proposal_id!
  h.intake.userTurn('确认', 'u2', 'e')
  assert.equal(h.intake.view?.revision, 1)
  assert.equal(h.intake.view?.origin_ref, 'u1')
  const operation = h.confirmation.acceptDirectDecision({proposalId, confirmed: true}).operation!
  assert.equal(h.intake.beginConfirmed({...operation, plan_revision: 2}), false)
  assert.equal(h.intake.beginConfirmed(operation), true)
  assert.equal(h.intake.beginConfirmed(operation), false)
  assert.equal(h.intake.view?.outcome, null)
  h.intake.settleConfirmed({accepted: true, delegate_id: 'd-confirmed'})
  assert.equal(h.intake.view?.outcome, 'dispatched')
  assert.equal(h.intake.view?.delegate_id, 'd-confirmed')
  assert.equal(h.planned(), 1)
  assert.equal(h.dispatched.length, 0)
})

for (const answer of ['Login only', 'Do not execute yet; only discuss', 'Cancel this request completely']) {
  test(`intake reassesses earlier execution intent after: ${answer}`, async () => {
    const inputs: Readonly<Record<string, unknown>>[] = []
    const h = harness({models: {
      assess: input => {
        inputs.push(input)
        return Promise.resolve(assessment(input, input.revision === 1 ? {
          slots: {...slots, scope: missing, acceptance: missing, constraints: missing},
          candidate_question: {owner: 'user', text: 'Which scope?'},
        } : {intent_to_proceed: answer === 'Login only', abandon: answer.startsWith('Cancel')}))
      },
      plan: input => Promise.resolve(plan(input)),
    }})
    h.intake.open(request, 'Fix empty password', 'u1', 'e')
    await h.intake.settled()
    assert.equal(h.intake.view?.intent_to_proceed, true)
    assert.equal(h.dispatched.length, 0)
    h.intake.userTurn(answer, 'u2', 'e')
    await h.intake.settled()
    assert.equal(inputs[1]?.intent_to_proceed, true, 'assessor receives prior intent with user evidence')
    assert.equal(inputs[1]?.opening, 'Fix empty password')
    assert.deepEqual(inputs[1]?.turns, [{question: 'Which scope?', answer}])
    assert.equal(h.dispatched.length, answer === 'Login only' ? 1 : 0)
    if (answer.startsWith('Cancel')) assert.equal(h.intake.view?.outcome, 'cancelled')
    else assert.equal(h.intake.view?.intent_to_proceed, answer === 'Login only')
  })
}

test('intake stale plan is dropped; amendments coalesce into one new plan and replace origin', async () => {
  let release!: (value: unknown) => void
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const revisions: unknown[] = []
  const h = harness({models: {
    assess: input => Promise.resolve(assessment(input, {slots: {...slots, goal: stated(Number(input.revision) > 1 ? 'Analyze only' : 'Fix it')}})),
    plan: async input => {
      revisions.push(input.revision)
      if (input.revision === 1) { started(); return await new Promise(resolve => { release = resolve }) }
      return plan(input)
    },
  }})
  h.intake.open(request, 'Fix it', 'u1', 'e')
  await entered
  h.intake.userTurn('Wait, only analyze', 'u2', 'e')
  h.intake.userTurn('Do not modify any files', 'u3', 'e')
  release(plan({intake_id: h.intake.view!.intake_id, revision: 1}))
  await h.intake.settled()
  assert.deepEqual(revisions, [1, 3])
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.intake.view?.origin_ref, 'u3')
  assert.match(h.intake.view.work_order!, /Analyze only/)
  assert.ok(h.diagnostics.includes('intake_stale_result'))
})

test('intake assess is single-flight; stale and malformed output cannot speak or plan', async () => {
  let release!: (value: unknown) => void
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  let calls = 0
  const h = harness({models: {
    assess: async input => { calls++; if (calls === 1) { started(); return await new Promise(resolve => { release = resolve }) } return assessment(input) },
    plan: input => Promise.resolve(plan(input)),
  }})
  h.intake.open(request, 'Fix it', 'u1', 'e')
  await entered
  h.intake.userTurn('New content', 'u2', 'e')
  assert.equal(calls, 1)
  release(assessment({intake_id: h.intake.view!.intake_id, revision: 1}, {candidate_question: {owner: 'user', text: 'STALE QUESTION'}}))
  await h.intake.settled()
  assert.equal(calls, 2)
  assert.ok(!h.facts.some(text => text.includes('STALE')))
  const broken = harness({models: {assess: () => Promise.resolve(({})), plan: input => Promise.resolve(plan(input))}})
  broken.intake.open(request, 'Fix it', 'u1', 'e')
  await broken.intake.settled()
  broken.intake.userTurn('Try again', 'u2', 'e')
  await broken.intake.settled()
  assert.equal(broken.intake.view?.outcome, 'abandoned')
  assert.equal(broken.dispatched.length, 0)
})

test('intake amendment invalidates proposal; session mismatch and cancellation prevent dispatch', async () => {
  const h = harness({settings: {clarification_depth: 'balanced', plan_readback: 'confirm'}})
  h.intake.open(request, 'Fix it', 'u1', 'e')
  await h.intake.settled()
  const old = h.intake.view!.proposal_id!
  h.intake.userTurn('Wait, only analyze', 'u2', 'e')
  assert.equal(h.confirmation.acceptDirectDecision({proposalId: old, confirmed: true}).operation, null)
  await h.intake.settled()
  assert.equal(h.intake.view?.revision, 2)
  assert.notEqual(h.intake.view?.proposal_id, old)
  h.intake.userTurn('continue', 'u3', 'different-session')
  assert.equal(h.intake.view?.outcome, 'cancelled')
  assert.equal(h.confirmation.pending, false)
})

test('intake admission refusal leaves explicit recovery, never dispatched', async () => {
  const h = harness({dispatch: current => {
    assert.equal(current.state, 'committing')
    assert.equal(current.outcome, null)
    return {accepted: false, problem: 'unknown_fence'}
  }})
  h.intake.open(request, 'Fix it', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.intake.view?.outcome, 'admission_refused')
  assert.ok(h.facts.some(text => text.includes('unknown_fence')))
  assert.equal(h.intake.open(request, 'Retry', 'u2', 'e'), 'intake_opened')
  await h.intake.settled()
})

test('coordinator: work on the active project resolves without evidence; a non-active pick must be quoted from the utterance', async () => {
  const active = harness()
  active.intake.open(request, '修一下登录', 'u1', 'e')
  await active.intake.settled()
  assert.deepEqual(active.decisions, [{kind: 'work', project: 'Project', session: 'latest'}])
  assert.equal(active.intake.view?.outcome, 'dispatched')

  // The quoted span must occur in the utterance *and* overlap exactly one roster name (either contains the other).
  const roster = () => [
    {name: 'Project', last_used_at: 1, last_session_title: null, running: []},
    {name: 'blog', last_used_at: 0, last_session_title: null, running: []},
    {name: '博客', last_used_at: 0, last_session_title: null, running: []},
    {name: 'pricing-page', last_used_at: 0, last_session_title: null, running: []},
  ]
  for (const [project, evidence, utterance] of [
    ['blog', 'Blog', '改一下 blog 的暗色模式'],
    ['博客', '博客', '改一下博客的暗色模式'],
    ['pricing-page', 'pricing', '改 pricing 的按钮'],
  ] as const) {
    const quoted = harness({
      roster, models: {assess: input => Promise.resolve(assessment(input, {project, project_evidence: evidence, session: 'new'}))},
      resolveTarget: () => Promise.resolve({...target, workspace_display_name: project}),
    })
    quoted.intake.open(request, utterance, 'u1', 'e')
    await quoted.intake.settled()
    assert.deepEqual(quoted.decisions, [{kind: 'work', project, session: 'new'}], `${project} quoted as ${evidence}`)
    assert.equal(quoted.intake.view?.kind, 'work')
    // Work in another project is an implied switch: planned, then confirmed like create (decision 2026-09-04).
    assert.equal(quoted.intake.view?.state, 'readback')
    assert.equal(quoted.confirmation.view.pending_action, 'reuse_workspace')
    assert.match(quoted.facts.at(-1)!, new RegExp(`计划（项目 ${project}）.*id=proposal-\\d+；仅通过 confirm\\(id, accepted\\) 回答`))
    assert.equal(quoted.dispatched.length, 0)
    confirmProposal(quoted)
    assert.equal(quoted.intake.view?.outcome, 'dispatched')
    assert.equal(quoted.intake.view?.delegate_id, 'd-confirmed')
  }

  // A shared prefix names two projects: `pricing` vouches for neither, and the intake asks instead.
  const twoPricing = () => [...roster(), {name: 'pricing-svc', last_used_at: 0, last_session_title: null, running: []}]
  for (const project of ['pricing-page', 'pricing-svc']) {
    const shared = harness({roster: twoPricing, models: {assess: input => Promise.resolve(assessment(input, {project, project_evidence: 'pricing'}))}})
    shared.intake.open(request, '改 pricing 的按钮', 'u1', 'e')
    await shared.intake.settled()
    assert.deepEqual(shared.decisions, [], project)
    assert.equal(shared.intake.view?.kind, 'unclear', project)
    assert.ok(shared.facts.some(text => text.includes(`是在 ${project} 里做吗`)), project)
  }
  const verbatim = harness({roster: twoPricing, models: {assess: input => Promise.resolve(assessment(input, {project: 'pricing-page', project_evidence: 'pricing-page'}))}})
  verbatim.intake.open(request, '改 pricing-page 的按钮', 'u1', 'e')
  await verbatim.intake.settled()
  assert.deepEqual(verbatim.decisions, [{kind: 'work', project: 'pricing-page', session: 'latest'}])

  // Missing, not in the utterance, or a filler ("改") that is in the utterance but does not name the project.
  for (const evidence of [null, '博客', '改']) {
    const unverified = harness({roster, models: {assess: input => Promise.resolve(assessment(input, {project: 'blog', project_evidence: evidence}))}})
    unverified.intake.open(request, '改一下暗色模式', 'u1', 'e')
    await unverified.intake.settled()
    assert.deepEqual(unverified.decisions, [], `evidence ${String(evidence)} never reaches the adapter`)
    assert.equal(unverified.intake.view?.kind, 'unclear')
    assert.equal(unverified.intake.view?.state, 'clarifying')
    assert.ok(unverified.diagnostics.includes('intake_project_evidence_missing'))
    assert.ok(unverified.facts.some(text => text.includes('是在 blog 里做吗')))
    assert.equal(unverified.dispatched.length, 0)
  }

})

test('coordinator: an affirmed host question is the only host-authored project evidence', async () => {
  const roster = () => [
    {name: 'Project', last_used_at: 1, last_session_title: null, running: []},
    {name: 'blog', last_used_at: 0, last_session_title: null, running: []},
  ]
  // An alias (博客 → blog) can never be quoted; the host's own `是在 blog 里做吗？` becomes the evidence once
  // the user affirms it -- and only then: a negative or a new instruction leaves the question unanswered.
  for (const [answer, dispatched] of [['对', true], ['不是', false], ['先修登录', false]] as const) {
    const alias = harness({roster, models: {assess: input => Promise.resolve(assessment(input, {project: 'blog', project_evidence: 'blog'}))}})
    alias.intake.open(request, '改一下博客的暗色模式', 'u1', 'e')
    await alias.intake.settled()
    assert.equal(alias.intake.view?.kind, 'unclear', answer)
    alias.intake.userTurn(answer, 'u2', 'e')
    await alias.intake.settled()
    assert.deepEqual(alias.decisions, dispatched ? [{kind: 'work', project: 'blog', session: 'latest'}] : [], answer)
    assert.equal(alias.intake.view?.kind, dispatched ? 'work' : 'unclear', answer)
  }
})

test('coordinator: unclear asks the model question; a resolution error routes with its stable code', async () => {
  const unclear = harness({models: {assess: input => Promise.resolve(assessment(input, {kind: 'unclear', candidate_question: {owner: 'user', text: '是哪个项目？'}}))}})
  unclear.intake.open(request, '把那个项目的测试修好', 'u1', 'e')
  await unclear.intake.settled()
  assert.equal(unclear.intake.view?.state, 'clarifying')
  assert.ok(unclear.facts.some(text => text.includes('是哪个项目？')))

  const unknown = harness({
    models: {assess: input => Promise.resolve(assessment(input, {project: 'blgo', project_evidence: 'blgo'}))},
    resolveTarget: () => Promise.reject(new ProjectResolutionError('unknown_project', {project: 'blgo', suggestions: ['blog'], hint: 'create'})),
  })
  unknown.intake.open(request, '在 blgo 里修测试', 'u1', 'e')
  await unknown.intake.settled()
  // A name outside the roster never passes the evidence check; the affirmed host question is the one way in.
  assert.equal(unknown.intake.view?.kind, 'unclear')
  unknown.intake.userTurn('对', 'u2', 'e')
  await unknown.intake.settled()
  assert.equal(unknown.intake.view?.outcome, 'routed')
  assert.ok(unknown.records.includes('intake.resolution_error'))
  assert.match(unknown.facts.at(-1)!, /^code=unknown_project：没有叫“blgo”的项目，相近的有：blog。/)
  assert.equal(unknown.dispatched.length, 0)
})

test('coordinator: steer preserves the request and amendments after project clarification', async () => {
  const h = harness({models: {
    assess: input => Promise.resolve(assessment(input, {kind: 'steer', project: 'blog'})),
  }})
  h.intake.open(request, '把博客那个正在做的页面字体再调大', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.steered.length, 0)
  assert.match(h.facts.at(-1)!, /是在 blog 里做吗/)
  h.intake.userTurn('仅调整正文，不改标题', 'u2', 'e')
  await h.intake.settled()
  assert.equal(h.steered.length, 0)
  h.intake.userTurn('是的', 'u3', 'e')
  await h.intake.settled()
  assert.equal(h.steered.length, 1)
  assert.match(h.steered[0]!, /把博客那个正在做的页面字体再调大/)
  assert.match(h.steered[0]!, /仅调整正文，不改标题/)
  assert.equal(h.intake.view?.outcome, 'routed')
  assert.equal(h.planned(), 0)
})

test('coordinator: the complete bounded intake fits the real project steer contract', async () => {
  let delivered = ''
  const h = harness({
    models: {assess: input => Promise.resolve(assessment(input, input.revision === 9
      ? {kind: 'steer'}
      : {kind: 'unclear', candidate_question: {owner: 'user', text: 'Which scope?'.padEnd(300, '?')}}))},
    steer: (_current, project, instruction) => {
      const validated = validateCodexRequest('project', 'steer', {project, instruction})
      if (validated.ok) delivered = instruction
      return {accepted: validated.ok, delegate_id: validated.ok ? 'd-steer' : null}
    },
  })
  const opening = 'Opening:'.padEnd(4000, '目')
  h.intake.open(request, opening, 'u1', 'e')
  await h.intake.settled()
  const answers = Array.from({length: 8}, (_, i) => `Amendment ${i}:`.padEnd(2000, '约'))
  for (const [index, answer] of answers.entries()) {
    h.intake.userTurn(answer, `answer-${index}`, 'e')
  }
  await h.intake.settled()
  assert.ok(delivered.includes(opening), 'the original request reaches the real steer boundary intact')
  for (const answer of answers) assert.ok(delivered.includes(answer), 'each amendment is preserved')
  assert.equal(validateCodexRequest('project', 'steer', {instruction: '字'.repeat(24_001)}).ok, false)
})

test('coordinator: create always confirms — with a goal it plans first, bare create proposes with a null work order', async () => {
  const created: IntakeTarget = {...target, action: 'create', workspace_display_name: 'shop', workspace_id: null, session_title: null}
  const withGoal = harness({
    models: {assess: input => Promise.resolve(assessment(input, {kind: 'create', project: 'shop', project_evidence: 'shop'}))},
    resolveTarget: () => Promise.resolve(created),
  })
  withGoal.intake.open(request, '新建一个 shop 项目，先做登录', 'u1', 'e')
  await withGoal.intake.settled()
  assert.deepEqual(withGoal.decisions, [{kind: 'create', project: 'shop', session: 'latest'}])
  assert.equal(withGoal.planned(), 1)
  assert.equal(withGoal.intake.view?.state, 'readback')
  assert.equal(withGoal.confirmation.view.pending_action, 'create_workspace')
  assert.match(withGoal.intake.view?.work_order ?? '', /^WorkOrder v2/)
  assert.match(withGoal.facts.at(-1)!, /计划（项目 shop）.*id=proposal-\d+；仅通过 confirm\(id, accepted\) 回答/)
  assert.equal(withGoal.dispatched.length, 0)

  const bare = harness({
    models: {assess: input => Promise.resolve(assessment(input, {kind: 'create', project: 'shop', project_evidence: 'shop', slots: {goal: missing, scope: missing, acceptance: missing, constraints: missing}}))},
    resolveTarget: () => Promise.resolve(created),
  })
  bare.intake.open(request, '新建一个 shop 项目', 'u1', 'e')
  await bare.intake.settled()
  assert.equal(bare.planned(), 0)
  assert.equal(bare.intake.view?.state, 'readback')
  assert.equal(bare.intake.view?.work_order, null)
  assert.equal(bare.confirmation.pending, true)
  assert.match(bare.facts.at(-1)!, /新建项目“shop”，不派任务/)

  const unnamed = harness({models: {assess: input => Promise.resolve(assessment(input, {kind: 'create', project: null}))}})
  unnamed.intake.open(request, '开个新项目', 'u1', 'e')
  await unnamed.intake.settled()
  assert.deepEqual(unnamed.decisions, [])
  assert.ok(unnamed.facts.some(text => text.includes('新项目叫什么名字？')))
})

const selectTarget: IntakeTarget = {...target, action: 'select', workspace_display_name: 'blog', session_title: null}
const switchModels = {assess: (input: Readonly<Record<string, unknown>>) => Promise.resolve(assessment(input, {kind: 'switch', project: 'blog', project_evidence: 'blog'}))}

test('coordinator: switch proposes without a plan cycle and activates only through the confirmed commit', async () => {
  // Decision 2026-09-04: any change of the active project is confirmed by the user before any side effect.
  const switched = harness({models: switchModels, resolveTarget: () => Promise.resolve(selectTarget)})
  switched.intake.open(request, '切到 blog', 'u1', 'e')
  await switched.intake.settled()
  assert.deepEqual(switched.decisions, [{kind: 'switch', project: 'blog', session: 'latest'}])
  assert.equal(switched.planned(), 0)
  assert.equal(switched.intake.view?.state, 'readback')
  assert.equal(switched.intake.view?.work_order, null)
  assert.equal(switched.confirmation.view.pending_action, 'select_workspace')
  assert.match(switched.facts.at(-1)!, /^准备切换到工作区blog，请确认或取消。 切换到项目“blog”，不派任务。id=proposal-\d+；仅通过 confirm\(id, accepted\) 回答/)
  assert.ok(!switched.facts.some(text => text.startsWith('code=switched')))

  // A user turn while the commit runs in `committing` is ignored: no revision bump, no re-assess (P1 race).
  const operation = switched.confirmation.acceptDirectDecision({proposalId: switched.intake.view.proposal_id!, confirmed: true}).operation!
  assert.equal(operation.action, 'select')
  assert.equal(operation.work_order, null)
  assert.equal(switched.intake.beginConfirmed(operation), true)
  switched.intake.userTurn('等等，改成 pricing', 'u2', 'e')
  assert.equal(switched.intake.open(request, '再来一个', 'u3', 'e'), 'intake_in_progress')
  await switched.intake.settled()
  assert.equal(switched.intake.view?.state, 'committing')
  assert.equal(switched.intake.view?.revision, 1)
  assert.equal(switched.decisions.length, 1, 'no re-assess during the commit')
  switched.intake.settleConfirmed({accepted: true})
  assert.equal(switched.intake.view?.outcome, 'dispatched')
  assert.equal(switched.dispatched.length, 0, 'a switch has no work order to dispatch')

  // Declining cancels the intake and leaves nothing to commit.
  const declined = harness({models: switchModels, resolveTarget: () => Promise.resolve(selectTarget)})
  declined.intake.open(request, '切到 blog', 'u1', 'e')
  await declined.intake.settled()
  const proposalId = declined.intake.view!.proposal_id!
  assert.equal(declined.confirmation.acceptDirectDecision({proposalId, confirmed: false}).kind, 'cancelled')
  declined.intake.decline(proposalId)
  assert.equal(declined.intake.view?.outcome, 'cancelled')
  assert.equal(declined.confirmation.pending, false)
  assert.equal(declined.dispatched.length, 0)
})

test('coordinator: steer and cancel route straight to the adapter without a plan cycle', async () => {
  const steered = harness({models: {assess: input => Promise.resolve(assessment(input, {kind: 'steer', project: 'blog', project_evidence: 'blog'}))}})
  steered.intake.open(request, 'blog 那个顺便把字体也调大', 'u1', 'e')
  await steered.intake.settled()
  assert.deepEqual(steered.steered, ['blog 那个顺便把字体也调大'])
  assert.deepEqual(steered.decisions, [])
  assert.equal(steered.intake.view?.outcome, 'routed')
  assert.match(steered.facts.at(-1)!, /^code=steered：/)

  const cancelled = harness({models: {assess: input => Promise.resolve(assessment(input, {kind: 'cancel', project: 'blog', project_evidence: 'blog'}))}})
  cancelled.intake.open(request, '停掉 blog 那个', 'u1', 'e')
  await cancelled.intake.settled()
  assert.deepEqual(cancelled.cancelled, ['停掉 blog 那个'])
  assert.equal(cancelled.intake.view?.outcome, 'routed')
  assert.ok(cancelled.records.includes('intake.cancel'))
  assert.equal(cancelled.facts.at(-1), 'code=cancelled：已请求停止“blog/暗色模式”，稍后有终态事实。')
  assert.equal(cancelled.dispatched.length, 0)
})

test('coordinator: no effectful route runs when the assessor says the user did not ask to proceed', async () => {
  for (const kind of ['steer', 'cancel'] as const) {
    const h = harness({models: {assess: input => Promise.resolve(assessment(input, {
      kind, project: null, project_evidence: null, intent_to_proceed: false,
    }))}})
    h.intake.open(request, '那个任务跑完了吗？', 'u1', 'e')
    await h.intake.settled()
    assert.deepEqual(h.steered, [], kind)
    assert.deepEqual(h.cancelled, [], kind)
    assert.equal(h.intake.view?.outcome, null, kind)
    assert.equal(h.intake.view?.state, 'clarifying', kind)
    assert.match(h.facts.at(-1)!, /等待用户明确要求开始/u, kind)
  }
})

test('coordinator: a revision bump during switch resolution or cancel resolution commits nothing stale', async () => {
  // Switch: resolve is side-effect-free; a stale resolution proposes nothing.
  let releaseTarget!: (value: IntakeTarget) => void
  let enteredResolve!: () => void
  const resolving = new Promise<void>(resolve => { enteredResolve = resolve })
  let assessments = 0
  const switched = harness({
    models: {assess: input => Promise.resolve(assessment(input, ++assessments === 1
      ? {kind: 'switch', project: 'blog', project_evidence: 'blog'}
      : {kind: 'unclear', candidate_question: {owner: 'user', text: '要做什么？'}}))},
    resolveTarget: () => { enteredResolve(); return new Promise(resolve => { releaseTarget = resolve }) },
  })
  switched.intake.open(request, '切到 blog', 'u1', 'e')
  await resolving
  switched.intake.userTurn('等等，别切', 'u2', 'e')
  releaseTarget(selectTarget)
  await switched.intake.settled()
  assert.equal(switched.confirmation.pending, false, 'a stale switch never reaches the confirmation FSM')
  assert.ok(!switched.facts.some(text => text.includes('切换到')))
  assert.ok(switched.diagnostics.includes('intake_stale_result'))

  // Cancel: the adapter asks `stillWanted` after its own (model) target resolution; a bump answers false.
  const wanted: boolean[] = []
  let enteredCancel!: () => void
  const cancelling = new Promise<void>(resolve => { enteredCancel = resolve })
  let releaseCancel!: () => void
  assessments = 0
  const cancelled = harness({
    models: {assess: input => Promise.resolve(assessment(input, ++assessments === 1
      ? {kind: 'cancel', project: 'blog', project_evidence: 'blog'}
      : {kind: 'unclear', candidate_question: {owner: 'user', text: '要做什么？'}}))},
    cancel: async (_instruction, stillWanted) => {
      enteredCancel()
      await new Promise<void>(resolve => { releaseCancel = resolve })
      wanted.push(stillWanted())
      return {code: 'ambiguous_work', running}
    },
  })
  cancelled.intake.open(request, '停掉 blog 那个', 'u1', 'e')
  await cancelling
  cancelled.intake.userTurn('不，别停', 'u2', 'e')
  releaseCancel()
  await cancelled.intake.settled()
  assert.deepEqual(wanted, [false])
  assert.ok(!cancelled.records.includes('intake.cancel'))
})

test('WorkOrder deterministic golden, optional truncation order, unicode and required-size refusal', () => {
  assert.equal(renderWorkOrder(order), 'WorkOrder v2\n\nObjective:\n- Fix empty password\n\nScope in:\n- Login only\n\nAcceptance:\n- Show validation error')
  const large = {...order, assumptions: ['a'.repeat(3500)], evidence_excerpts: ['e'.repeat(300), 'f'.repeat(300)], discovery: ['d'.repeat(3500)]}
  const rendered = renderWorkOrder(large)
  assert.ok(rendered.length <= 4000)
  assert.equal(rendered, renderWorkOrder(large))
  assert.match(rendered, /Truncated: Assumptions.*User-provided material/s)
  assert.throws(() => renderWorkOrder({...order, objective: '必'.repeat(4000)}), /requirements_too_large/)
  assert.ok(renderWorkOrder({...order, assumptions: ['😀'.repeat(4000)]}).length <= 4000)
})

test('intake model ports use selected models, bounded JSON and explicit ownership prompts', async () => {
  const requests: {model: string; system: string; prompt: string}[] = []
  const models: IntakeModels = intakeModels({
    async *stream() { await Promise.resolve();  throw new Error('not used') },
    complete: request => { requests.push(request); return Promise.resolve({text: '{}'}) },
  }, 'cheap-assessor', 'chosen-planner')
  await models.assess({intake_id: 'i1', revision: 1}, new AbortController().signal)
  await models.plan({intake_id: 'i1', revision: 1}, new AbortController().signal)
  assert.deepEqual(requests.map(value => value.model), ['cheap-assessor', 'chosen-planner'])
  assert.match(requests[0]!.system, /ask only when the answer would change the implementation or the acceptance; otherwise prefer inferring and marking the inference\./)
  assert.match(requests[0]!.system, /Preserve an earlier request to proceed unless the user retracts it/)
  assert.match(requests[0]!.system, /Set abandon on explicit cancellation/)
  assert.match(requests[1]!.system, /anything guessed goes under assumptions/i)
})


test('intake labelled multi-turn fixtures exercise user questions, inference, readiness and abandonment', async () => {
  interface Turn {utterance: string; label: string; goal?: string; scope?: string; acceptance?: string; constraints?: string; question?: {owner: string; text: string}}
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/realtime/qwen/v1/codex-clarification.json'), 'utf8')) as {intake_cases: {id: string; depth: 'balanced' | 'thorough'; turns: Turn[]}[]}
  for (const scenario of fixture.intake_cases) {
    let turn: Turn = scenario.turns[0]!
    const h = harness({settings: {clarification_depth: scenario.depth, plan_readback: 'silent'}, models: {
      assess: input => Promise.resolve(assessment(input, {slots: {
        goal: turn.goal === undefined ? missing : stated(turn.goal), scope: turn.scope === undefined ? missing : stated(turn.scope),
        acceptance: turn.acceptance === undefined ? missing : stated(turn.acceptance), constraints: turn.constraints === undefined ? missing : stated(turn.constraints),
      }, candidate_question: turn.question ?? null, abandon: turn.label === 'abandon'})),
      plan: input => Promise.resolve(plan(input)),
    }})
    for (let index = 0; index < scenario.turns.length; index++) {
      turn = scenario.turns[index]!
      if (index === 0) h.intake.open(request, turn.utterance, 'u0', 'e')
      else h.intake.userTurn(turn.utterance, `u${index}`, 'e')
      await h.intake.settled()
      if (turn.label === 'ask(user-owned)') assert.equal(h.intake.view?.pending_question, turn.question?.text, scenario.id)
      else if (turn.label === 'abandon') assert.equal(h.intake.view?.outcome, 'cancelled', scenario.id)
      else {
        assert.equal(h.intake.view?.outcome, 'dispatched', scenario.id)
        if (turn.label === 'infer') assert.ok(h.intake.view?.discovery.includes(turn.question!.text))
      }
    }
  }
})

test('intake planning result waits for an in-progress utterance; failed transcription can cancel it', async () => {
  let release!: (value: unknown) => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const h = harness({models: {assess: input => Promise.resolve(assessment(input)), plan: async () => { entered(); return await new Promise(resolve => { release = resolve }) }}})
  h.intake.open(request, 'Fix it', 'u1', 'e')
  await ready
  h.intake.userInputStarted()
  release(plan({intake_id: h.intake.view!.intake_id, revision: 1}))
  await h.intake.settled()
  assert.equal(h.dispatched.length, 0)
  h.intake.cancel()
  assert.equal(h.intake.view?.outcome, 'cancelled')
})

test('blank final during an authorized confirmed commit preserves its eventual settlement', async () => {
  let invalidations = 0
  const h = harness({
    settings: {clarification_depth: 'balanced', plan_readback: 'confirm'},
    invalidateProposal: () => { invalidations++ },
  })
  h.intake.open(request, 'Fix empty password', 'u1', 'e')
  await h.intake.settled()
  const operation = h.confirmation.acceptDirectDecision({proposalId: h.intake.view!.proposal_id!, confirmed: true}).operation!
  assert.equal(h.intake.beginConfirmed(operation), true)
  h.intake.userInputStarted()
  h.intake.userTurn('   ', 'u2', 'e')
  assert.equal(h.intake.view?.state, 'committing')
  assert.equal(h.intake.view?.revision, 1)
  assert.equal(invalidations, 0)
  h.intake.settleConfirmed({accepted: true, delegate_id: 'confirmed-work'})
  assert.equal(h.intake.view?.outcome, 'dispatched')
  assert.equal(h.intake.view?.delegate_id, 'confirmed-work')
  assert.equal(h.records.filter(kind => kind === 'intake.dispatch').length, 1)
})
