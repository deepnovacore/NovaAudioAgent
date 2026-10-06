import {readFileSync} from 'node:fs'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {VirtualClock} from '../src/core/clock.js'
import {IntakeController, type IntakeOptions} from '../src/executors/coding/intake.js'
import {assessSchema, assessSchemaFor, requirementsSchema, intakeModels, type IntakeModels, type IntakeSlots} from '../src/executors/coding/intake-model.js'
import {ProjectConfirmationController} from '../src/projects/project-confirmation.js'
import {renderWorkOrder, workOrderSchema} from '../src/executors/coding/work-order.js'
import {ProjectResolutionError, type CoordinatorDecision, type IntakeTarget} from '../src/executors/coding-executor.js'
import {validateCodexRequest} from '../src/executors/codex/contract.js'
import {GatewayError} from '../src/model/model-gateway.js'
import {fixture} from './fixtures/codex/project-adapter-fixture.js'

const stated = (note: string) => ({state: 'stated' as const, note})
const missing = {state: 'missing' as const, note: ''}
const slots: IntakeSlots = {goal: stated('Fix empty password'), scope: stated('Login only'), acceptance: stated('Show validation error'), constraints: stated('Keep public API')}
const order = workOrderSchema.parse({objective: slots.goal.note, scope_in: ['Login only'], acceptance: ['Show validation error']})
const assessment = (input: Readonly<Record<string, unknown>>, changes = {}) => ({
  intake_id: input.intake_id, revision: input.revision, slots, readiness: 1,
  kind: 'work', project: null, project_evidence: null, session: {mode: 'latest'},
  intent_to_proceed: true, candidate_question: null, discovery: [], early_exit: false, abandon: false,
  ...changes,
})
const projectAnswer = (input: Readonly<Record<string, unknown>>, decision: 'confirmed' | 'rejected' | 'unclear' | 'redirected') => {
  const turns = input.turns as {answer: string}[]
  return {turn_index: turns.length - 1, decision, evidence: turns.at(-1)!.answer}
}
const plan = (input: Readonly<Record<string, unknown>>) => ({intake_id: input.intake_id, revision: input.revision, work_order: order})

test('adaptive direct work preserves requirements without calling the planner or announcing a plan', async () => {
  const h = harness({models: {assess: input => Promise.resolve(assessment(input, {execution_mode: 'direct'}))}})
  h.intake.open(request, 'Fix empty password', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.planned(), 0)
  for (const slot of Object.values(slots)) assert.ok(h.intake.view?.work_order?.includes(slot.note))
  assert.ok(h.facts.every(text => !text.includes('梳理一下计划')))
})

test('adaptive direct work still honors explicit confirmation settings', async () => {
  const h = harness({settings: {clarification_depth: 'balanced', plan_readback: 'confirm'},
    models: {assess: input => Promise.resolve(assessment(input, {execution_mode: 'direct'}))}})
  h.intake.open(request, 'Fix empty password', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.planned(), 0)
  assert.equal(h.dispatched.length, 0)
  assert.ok(h.intake.view?.proposal_id)
})

test('intake assess schema keeps session mode and title mutually exclusive', () => {
  const base = assessment({intake_id: 'schema-intake', revision: 1})
  assert.equal(assessSchema.safeParse({...base, session: {mode: 'latest', title: '修复登录'}}).success, false)
  assert.equal(assessSchema.safeParse({...base, session: {mode: 'named'}}).success, false)
})
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
      targets: {resolveIntake: () => Promise.reject(new Error('unexpected target call')), resolveWork: () => Promise.resolve(null)},
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
  assert.deepEqual(h.records.filter(kind => kind !== 'intake.timing'), ['intake.assess', 'plan.compile', 'intake.dispatch'])
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.planned(), 1)
  assert.match(h.intake.view.work_order!, /^WorkOrder v2/)
})

test('host knowledge attachment enriches only the current revision plan', async () => {
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => {entered = resolve})
  const waiting = new Promise<void>(resolve => {release = resolve})
  const h = harness({attachEvidence: async (_order, workspace) => {
    assert.equal(workspace, '/canonical/project')
    entered(); await waiting
    return {references: ['knowledge://source/chunk?d=0123456789ab']}
  }})
  h.intake.open(request, 'Fix empty password', 'u1', 'e')
  await started
  h.intake.cancel()
  release()
  await h.intake.settled()
  assert.equal(h.dispatched.length, 0)
  assert.equal(h.records.includes('plan.compile'), false)
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
      h.intake.open(request, 'Something', `u${index + 1}`, 'e')
      await h.intake.settled()
    }
    assert.equal(h.intake.view?.questions_asked, budget)
    assert.equal(h.intake.view?.state, 'clarifying')
    assert.equal(plans, 0)
    h.intake.open(request, 'Still vague', 'u-final', 'e')
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
  for (const [goal, proceed, early, expected] of [[missing, false, true, 0], [slots.goal, false, false, 1], [slots.goal, false, true, 1]] as const) {
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
  h.intake.userInputEnded()
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

for (const answer of ['Login only', 'Cancel this request completely']) {
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
    h.intake.open(request, answer, 'u2', 'e')
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
  h.intake.open(request, 'Wait, only analyze', 'u2', 'e')
  h.intake.open(request, 'Wait, only analyze', 'u2', 'e')
  h.intake.open(request, 'Do not modify any files', 'u3', 'e')
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
  h.intake.open(request, 'New content', 'u2', 'e')
  assert.equal(calls, 1)
  release(assessment({intake_id: h.intake.view!.intake_id, revision: 1}, {candidate_question: {owner: 'user', text: 'STALE QUESTION'}}))
  await h.intake.settled()
  assert.equal(calls, 2)
  assert.ok(!h.facts.some(text => text.includes('STALE')))
  const broken = harness({models: {assess: () => Promise.resolve(({})), plan: input => Promise.resolve(plan(input))}})
  broken.intake.open(request, 'Fix it', 'u1', 'e')
  await broken.intake.settled()
  broken.intake.open(request, 'Try again', 'u2', 'e')
  await broken.intake.settled()
  assert.equal(broken.intake.view?.state, 'failed')
  assert.equal(broken.intake.view?.outcome, null)
  assert.equal(broken.dispatched.length, 0)
})

test('intake amendment invalidates proposal; session mismatch and cancellation prevent dispatch', async () => {
  const h = harness({settings: {clarification_depth: 'balanced', plan_readback: 'confirm'}})
  h.intake.open(request, 'Fix it', 'u1', 'e')
  await h.intake.settled()
  const old = h.intake.view!.proposal_id!
  h.intake.open(request, 'Wait, only analyze', 'u2', 'e')
  h.intake.open(request, 'Wait, only analyze', 'u2', 'e')
  assert.equal(h.confirmation.acceptDirectDecision({proposalId: old, confirmed: true}).operation, null)
  await h.intake.settled()
  assert.equal(h.intake.view?.revision, 2)
  assert.notEqual(h.intake.view?.proposal_id, old)
  h.intake.cancel()
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
  assert.deepEqual(active.decisions, [{kind: 'work', project: 'Project', session: 'new'}])
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
      roster, models: {assess: input => Promise.resolve(assessment(input, {project, project_evidence: evidence, session: {mode: 'new'}}))},
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
  assert.deepEqual(verbatim.decisions, [{kind: 'work', project: 'pricing-page', session: 'new'}])

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

test('registered projects beyond display caps remain intake evidence without expanding session history', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'nova-intake-roster-'))
  const value = await fixture({localCodexHome: home})
  try {
    const counter = await value.store.createManaged('counter')
    const previous = await value.store.beginSession(counter.workspace_id, 'Previous counter task')
    await value.store.markSessionReady(previous.session_id, 'previous-counter-thread')
    await value.store.importSession(counter.workspace_id, {home, threadId: 'counter-thread', title: 'Counter history', updatedAt: 100})
    const archived = await value.store.createManaged('alpha-archive')
    await value.store.importSession(archived.workspace_id, {home, threadId: 'archive-thread', title: 'Archived history', updatedAt: 101})
    for (let index = 0; index < 21; index++) {
      const workspace = index === 0 ? await value.store.resolveWorkspace('alpha') : await value.store.createManaged(`project-${index}`)
      const session = await value.store.beginSession(workspace.workspace_id, `Task ${index}`)
      await value.store.markSessionReady(session.session_id, `task-thread-${index}`)
      await value.store.importSession(workspace.workspace_id, {home, threadId: `recent-thread-${index}`, title: `History ${index}`, updatedAt: 200 + index})
    }
    await value.adapter.initialize()
    const roster = value.adapter.roster()
    assert.equal(roster.length, 23)
    assert.deepEqual(roster.at(-1), {name: 'counter', last_used_at: 100, last_session_title: null, running: []})
    assert.equal(roster.filter(entry => entry.sessions !== undefined).length, 10)
    assert.ok(roster.slice(0, 10).every(entry => entry.sessions?.length === 1 && entry.last_session_title?.startsWith('Task ')))
    assert.equal(roster.slice(10).some(entry => entry.last_session_title !== null), false)
    assert.equal(value.adapter.publicProjectView(false).roster.length, 10)
    assert.equal((await value.store.publicView(false)).roster.length, 20)
    const before = await value.store.snapshot()
    for (const mode of ['explicit', 'confirmed', 'redirected', 'ambiguous', 'unknown'] as const) {
      const inputs: Readonly<Record<string, unknown>>[] = []
      const h = harness({roster: () => value.adapter.roster(), activeProject: () => null,
        resolveTarget: decision => value.adapter.resolveIntakeTarget(decision), models: {assess: input => {
          inputs.push(input)
          const followup = input.revision !== 1
          const project = mode === 'unknown' ? 'missing-project' : mode === 'ambiguous' ? 'alpha' : mode === 'redirected' && !followup ? 'alpha' : 'counter'
          return Promise.resolve(assessment(input, {project, session: {mode: 'new'}, execution_mode: 'direct',
            project_evidence: mode === 'explicit' || mode === 'ambiguous' || mode === 'unknown' || (mode === 'redirected' && followup) ? project : null,
            ...(followup ? {project_confirmation: projectAnswer(input, mode === 'redirected' ? 'redirected' : 'confirmed')} : {}),
          }))
        }}})
      h.intake.open(request, mode === 'explicit' ? 'Fix counter' : mode === 'ambiguous' ? 'Fix alpha' : mode === 'unknown' ? 'Fix missing-project' : 'Fix the counter page', 'u1', 'e')
      await h.intake.settled()
      assert.deepEqual((inputs[0]!.roster as {name: string}[]).map(entry => entry.name), roster.map(entry => entry.name))
      if (mode === 'confirmed' || mode === 'redirected') {
        assert.equal(h.intake.view?.kind, 'unclear', mode)
        h.intake.open(request, mode === 'confirmed' ? 'Yes, counter' : 'No, use counter', 'u2', 'e')
        await h.intake.settled()
      }
      if (mode === 'ambiguous' || mode === 'unknown') {
        assert.equal(h.intake.view?.kind, 'unclear', mode)
        assert.equal(h.decisions.length, 0, mode)
      } else {
        assert.deepEqual(h.decisions, [{kind: 'work', project: 'counter', session: 'new'}], mode)
        assert.equal(h.intake.view?.target?.workspace_id, counter.workspace_id, mode)
        assert.equal(h.intake.view?.questions_asked, mode === 'explicit' ? 0 : 1, mode)
        assert.equal(h.records.includes('intake.failure'), false, mode)
      }
    }
    assert.deepEqual(await value.store.snapshot(), before, 'catalog projection and resolution do not change recency, active project or sessions')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
    await rm(home, {recursive: true, force: true})
  }
})

test('coordinator: an affirmed host question is the only host-authored project evidence', async () => {
  const roster = () => [
    {name: 'Project', last_used_at: 1, last_session_title: null, running: []},
    {name: 'blog', last_used_at: 0, last_session_title: null, running: []},
  ]
  // An alias (博客 → blog) can never be quoted; the host's own `是在 blog 里做吗？` becomes the evidence once
  // the user affirms it -- and only then: a negative or a new instruction leaves the question unanswered.
  for (const [answer, dispatched] of [['对，就在你刚才问的那个项目里做', true], ['不是', false], ['先修登录', false]] as const) {
    const alias = harness({roster, models: {assess: input => Promise.resolve(assessment(input, {project: 'blog', project_evidence: null, ...(input.revision === 1 ? {} : {kind: dispatched ? 'work' : 'unclear', project_confirmation: projectAnswer(input, dispatched ? 'confirmed' : answer === '不是' ? 'rejected' : 'unclear')})}))}})
    alias.intake.open(request, '改一下博客的暗色模式', 'u1', 'e')
    await alias.intake.settled()
    assert.equal(alias.intake.view?.kind, 'unclear', answer)
    alias.intake.open(request, answer, 'u2', 'e')
    await alias.intake.settled()
    assert.deepEqual(alias.decisions, dispatched ? [{kind: 'work', project: 'blog', session: 'new'}] : [], answer)
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
    models: {assess: input => Promise.resolve(assessment(input, {project: 'blgo', project_evidence: input.revision === 1 ? 'blgo' : null, ...(input.revision === 1 ? {} : {project_confirmation: projectAnswer(input, 'confirmed')})}))},
    resolveTarget: () => Promise.reject(new ProjectResolutionError('unknown_project', {project: 'blgo', suggestions: ['blog'], hint: 'create'})),
  })
  unknown.intake.open(request, '在 blgo 里修测试', 'u1', 'e')
  await unknown.intake.settled()
  // A name outside the roster never passes the evidence check; the affirmed host question is the one way in.
  assert.equal(unknown.intake.view?.kind, 'unclear')
  unknown.intake.open(request, '对', 'u2', 'e')
  await unknown.intake.settled()
  assert.equal(unknown.intake.view?.outcome, 'routed')
  assert.ok(unknown.records.includes('intake.resolution_error'))
  assert.match(unknown.facts.at(-1)!, /^code=unknown_project：没有叫“blgo”的项目，相近的有：blog。/)
  assert.equal(unknown.dispatched.length, 0)
})

test('coordinator: steer preserves the request and amendments after project clarification', async () => {
  const h = harness({models: {
    assess: input => Promise.resolve(assessment(input, {kind: input.revision === 2 ? 'unclear' : 'steer', project: 'blog', project_evidence: null, ...(input.revision === 1 ? {} : {project_confirmation: projectAnswer(input, input.revision === 3 ? 'confirmed' : 'unclear')})})),
  }})
  h.intake.open(request, '把博客那个正在做的页面字体再调大', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.steered.length, 0)
  assert.match(h.facts.at(-1)!, /是在 blog 里做吗/)
  h.intake.open(request, '仅调整正文，不改标题', 'u2', 'e')
  await h.intake.settled()
  assert.equal(h.steered.length, 0)
  h.intake.open(request, '是的', 'u3', 'e')
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
    running: () => [{work_id: 'w-project', project: 'Project', title: 'Current task'}],
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
    h.intake.open(request, answer, `answer-${index}`, 'e')
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
  assert.deepEqual(withGoal.decisions, [{kind: 'create', project: 'shop', session: 'new'}])
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
  assert.deepEqual(switched.decisions, [{kind: 'switch', project: 'blog', session: 'new'}])
  assert.equal(switched.planned(), 0)
  assert.equal(switched.intake.view?.state, 'readback')
  assert.equal(switched.intake.view?.work_order, null)
  assert.equal(switched.confirmation.view.pending_action, 'select_workspace')
  assert.match(switched.facts.at(-1)!, /^是否切换到“blog”工作区？ 切换到项目“blog”，不派任务。id=proposal-\d+；仅通过 confirm\(id, accepted\) 回答/)
  assert.ok(!switched.facts.some(text => text.startsWith('code=switched')))

  // A user turn while the commit runs in `committing` is ignored: no revision bump, no re-assess (P1 race).
  const operation = switched.confirmation.acceptDirectDecision({proposalId: switched.intake.view.proposal_id!, confirmed: true}).operation!
  assert.equal(operation.action, 'select')
  assert.equal(operation.work_order, null)
  assert.equal(switched.intake.beginConfirmed(operation), true)
  switched.intake.userInputEnded()
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

test('coordinator: dispatch can steer but cannot select the separate cancel action', async () => {
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
  assert.deepEqual(cancelled.cancelled, [])
  assert.equal(cancelled.intake.view?.outcome, null)
  assert.ok(!cancelled.records.includes('intake.cancel'))
  assert.equal(cancelled.dispatched.length, 0)
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
  switched.intake.open(request, '等等，别切', 'u2', 'e')
  releaseTarget(selectTarget)
  await switched.intake.settled()
  assert.equal(switched.confirmation.pending, false, 'a stale switch never reaches the confirmation FSM')
  assert.ok(!switched.facts.some(text => text.includes('切换到')))
  assert.ok(switched.diagnostics.includes('intake_stale_result'))


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
    complete: request => {
      requests.push(request)
      const value = request.system.includes('target.resolve slot')
        ? {intake_id:'i1',revision:1,kind:'work',project:null,project_evidence:null,project_confirmation:null,session:{mode:'new'},question:null}
        : request.system.includes('intake.assess slot') ? requirementsSchema.strip().parse(assessment({intake_id:'i1',revision:1})) : {}
      return Promise.resolve({text:JSON.stringify(value)})
    },
  }, 'cheap-assessor', 'chosen-planner')
  await models.assess({intake_id: 'i1', revision: 1}, new AbortController().signal)
  await models.plan({intake_id: 'i1', revision: 1}, new AbortController().signal)
  assert.deepEqual(requests.map(value => value.model), ['cheap-assessor', 'cheap-assessor', 'chosen-planner'])
  assert.match(requests[0]!.system, /ask only when the answer would change the implementation or the acceptance; otherwise prefer inferring and marking the inference\./)
  assert.match(requests[0]!.system, /Preserve an earlier request to proceed unless the user retracts it/)
  assert.match(requests[0]!.system, /Set abandon on explicit cancellation/)
  assert.match(requests[1]!.system, /target.resolve slot/)
  assert.match(requests[2]!.system, /anything guessed goes under assumptions/i)
})


test('intake labelled multi-turn fixtures exercise user questions, inference, readiness and abandonment', async () => {
  interface Turn {utterance: string; label: string; goal?: string; scope?: string; acceptance?: string; constraints?: string; question?: {owner: string; text: string}}
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../tests/fixtures/realtime/qwen/v1/codex-clarification.json'), 'utf8')) as {intake_cases: {id: string; depth: 'balanced' | 'thorough'; turns: Turn[]}[]}
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
      else h.intake.open(request, turn.utterance, `u${index}`, 'e')
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
  h.intake.userInputEnded()
  assert.equal(h.intake.view?.state, 'committing')
  assert.equal(h.intake.view?.revision, 1)
  assert.equal(invalidations, 0)
  h.intake.settleConfirmed({accepted: true, delegate_id: 'confirmed-work'})
  assert.equal(h.intake.view?.outcome, 'dispatched')
  assert.equal(h.intake.view?.delegate_id, 'confirmed-work')
  assert.equal(h.records.filter(kind => kind === 'intake.dispatch').length, 1)
})


test('an explicitly named session selects its project, but an invented session selection is rejected', async () => {
  for (const explicit of [true, false]) {
    const h = harness({
      roster: () => [{name: 'blog', last_used_at: 1, last_session_title: 'Newest', running: [], sessions: ['修复登录']}],
      models: {assess: input => Promise.resolve(assessment(input, {project: 'blog', session: {mode: 'named', title: '修复登录'}}))},
    })
    h.intake.open(request, explicit ? '继续修复登录这个会话' : '修一下页面', 'user:1', 'epoch1')
    await h.intake.settled()
    if (explicit) assert.equal(h.decisions[0]?.session_title, '修复登录')
    else assert.equal(h.decisions.length, 0)
    h.intake.cancel()
  }
})

for (const text of ['取消', '不用了', 'cancel', '确认前先把需求改成新的']) {
  test(`pending proposal waits for a structured decision: ${text}`, async () => {
    const h = harness({settings: {clarification_depth: 'balanced', plan_readback: 'confirm'}})
    h.intake.open(request, 'Fix it', 'u1', 'e')
    await h.intake.settled()
    const proposalId = h.intake.view!.proposal_id!
    h.intake.userInputEnded()
    assert.equal(h.intake.view?.proposal_id, proposalId)
    assert.equal(h.intake.view?.revision, 1)
    h.intake.open(request, text, 'u2', 'e')
    assert.equal(h.intake.view?.revision, 2)
    assert.equal(h.intake.view?.proposal_id, null)
    assert.equal(h.confirmation.acceptDirectDecision({proposalId, confirmed: true}).operation, null)
    await h.intake.settled()
  })
}

 test('frontend context reaches assessment without granting historical project authority', async () => {
   const context = [
     {role: 'user', text: '在 blog 项目里写贪吃蛇', sequence: 1},
     {role: 'assistant', text: '要网页还是桌面版？', sequence: 2},
   ]
   let captured: Readonly<Record<string, unknown>> | undefined
   const h = harness({models: {assess: input => {
     captured = input
     return Promise.resolve(assessment(input, {project: 'blog', project_evidence: 'blog'}))
   }}})
   h.intake.open({...request, conversation_context: context}, '网页，方向键控制', 'u3', 'e')
   await h.intake.settled()
   assert.deepEqual(captured?.conversation_context, context)
   assert.equal(captured?.opening, '网页，方向键控制')
   assert.deepEqual(h.decisions, [])
   assert.equal(h.intake.view?.kind, 'unclear')
 })

test('dispatch-selected user quotes preserve the current clarification chain project', async () => {
  const h = harness({models: {assess: input => Promise.resolve(assessment(input, {project: 'blog', project_evidence: 'blog'}))}})
  h.intake.open({...request, source_quotes: ['在 blog 项目里写贪吃蛇']}, '网页，方向键控制', 'u3', 'e')
  await h.intake.settled()
  assert.deepEqual(h.decisions, [{kind: 'work', project: 'blog', session: 'new'}])
})

test('preparation state spans assessment and stops at a concrete question or cancellation', async () => {
  const states: boolean[] = []
  const h = harness({
    onStateChanged: () => states.push(h.intake.preparing),
    models: {assess: input => Promise.resolve(assessment(input, {
      kind: 'unclear', readiness: .25, slots: {...slots, scope: missing},
      candidate_question: {owner: 'user', text: 'Which screen?'},
    }))},
  })
  h.intake.open(request, 'Fix login', 'u1', '1')
  assert.equal(h.intake.preparing, true)
  await h.intake.settled()
  assert.equal(h.intake.preparing, false)
  assert.ok(h.facts.some(text => text.includes('Which screen?')))
  assert.equal(states[0], true)
  assert.equal(states.at(-1), false)
  h.intake.cancel()
  assert.equal(h.intake.preparing, false)
})

test('accepted dispatch and steer remain launchable after intake closes normally', async () => {
  for (const kind of ['work', 'steer'] as const) {
    let wanted: (() => boolean) | undefined
    const admit = (_session: unknown, check?: () => boolean) => {
      wanted = check
      assert.equal(check?.(), true)
      return {accepted: true, delegate_id: 'delayed'}
    }
    const h = harness({running: () => [{work_id: 'w-project', project: 'Project', title: 'Current task'}],
      models: {assess: input => Promise.resolve(assessment(input, {kind}))},
      dispatch: admit, steer: (session, _project, _instruction, check) => admit(session, check)})
    h.intake.open(request, 'Fix empty password', 'u1', 'e')
    await h.intake.settled()
    assert.equal(h.intake.active, false)
    assert.equal(wanted?.(), true, 'normal intake completion must not revoke an admitted delegate')
  }
})

test('an unrelated completed frontend turn releases paused work without rewriting its requirements', async () => {
  let release!: (value: unknown) => void
  let calls = 0
  let entered!: () => void
  const started = new Promise<void>(resolve => {entered = resolve})
  const h = harness({models: {plan: async input => {
    calls++
    if (input.revision === 1 && !release) {entered(); return await new Promise(resolve => {release = resolve})}
    return plan(input)
  }}})
  h.intake.open(request, 'Fix empty password', 'u1', 'e')
  await started
  h.intake.userInputStarted()
  h.intake.userInputEnded()
  release(plan({intake_id: h.intake.view!.intake_id, revision: 1}))
  await h.intake.settled()
  assert.equal(h.dispatched.length, 0)
  h.intake.userResponseCompleted()
  await h.intake.settled()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.intake.view?.opening, 'Fix empty password')
  assert.equal(h.intake.view?.revision, 1)
  assert.equal(calls, 1)
  assert.equal(h.records.filter(kind => kind === 'intake.assess').length, 1)
  assert.equal(h.records.filter(kind => kind === 'plan.compile').length, 1)
})

test('accepted dispatch emits immediate feedback once and cancellation invalidates it', () => {
  const h = harness({models: {assess: () => new Promise(() => { /* deliberately pending */ })}})
  h.intake.open(request, 'Build a page', 'conversation:1', '1')
  assert.deepEqual(h.facts, ['收到，我来处理。'])
  const s = h.intake.view!
  const event = `intake:${s.intake_id}:${s.revision}:accepted`
  assert.equal(h.intake.factEligible(event, 1), true)
  h.intake.open(request, 'Build a page', 'conversation:1', '1')
  assert.equal(h.facts.length, 1)
  h.intake.cancel()
  assert.equal(h.intake.factEligible(event, 1), false)
})


test('idle workspaces do not advertise or admit steer, even if a model invents it', async () => {
  const raw = assessment({intake_id: 'idle', revision: 1}, {kind: 'steer'})
  assert.equal(assessSchemaFor({running: []}).safeParse(raw).success, false)
  assert.equal(assessSchemaFor({running}).safeParse(raw).success, true)
  const h = harness({running: () => [], models: {assess: input => Promise.resolve(assessment(input, {kind: 'steer'}))}})
  h.intake.open(request, '继续当前工作区的会话，创建下一个文件', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.steered.length, 0)
  assert.equal(h.dispatched.length, 0, 'the host must not invent a replacement operation')
  assert.match(h.facts.at(-1)!, /code=no_active_turn/)
})

test('transient assessment failure retries the same requirement and dispatches once', async () => {
  let calls = 0
  const h = harness({models: {assess: input => {
    if (++calls === 1) return Promise.reject(new GatewayError('HTTPStatus503'))
    return Promise.resolve(assessment(input))
  }}})
  h.intake.open(request, 'Fix empty password', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.intake.view?.outcome, 'dispatched')
  assert.equal(h.dispatched.length, 1)
  assert.equal(calls, 2)
  assert.ok(!h.facts.some(text => text.includes('请补充') || text.includes('需求已结束')))
})

test('exhausted service failures retain requirements and only structured dispatch resumes them', async () => {
  let unavailable = true, calls = 0
  let resumed: Readonly<Record<string, unknown>> | undefined
  const failures: unknown[] = []
  const h = harness({record: (_s, kind, data) => { if (kind === 'intake.failure') failures.push(data) }, models: {
    assess: input => {
      calls++
      if (unavailable) return Promise.reject(new GatewayError('HTTPStatus503'))
      resumed = input
      return Promise.resolve(assessment(input))
    },
  }})
  h.intake.open({...request, source_quotes: ['original user goal']}, 'Fix empty password', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.intake.view?.state, 'failed')
  assert.equal(h.intake.view?.outcome, null)
  assert.equal(h.intake.preparing, false)
  assert.equal(calls, 2)
  assert.equal(failures.length, 2)
  assert.match(h.facts.at(-1)!, /原需求已保留/)
  h.intake.userInputStarted()
  h.intake.userInputEnded()
  h.intake.userResponseCompleted()
  await h.intake.settled()
  assert.equal(calls, 2, 'unrelated conversation must not restart an unavailable service')
  unavailable = false
  h.intake.open(request, 'Continue', 'u2', 'e')
  await h.intake.settled()
  assert.equal(h.dispatched.length, 1)
  assert.equal(resumed?.opening, 'Fix empty password')
  assert.deepEqual(resumed?.source_quotes, ['original user goal'])
  assert.deepEqual(resumed?.turns, [{question: null, answer: 'Continue'}])
})

test('authentication failures pause without retry or blaming the user', async () => {
  let calls = 0
  const failures: unknown[] = []
  const h = harness({record: (_s, kind, data) => { if (kind === 'intake.failure') failures.push(data) }, models: {
    assess: () => { calls++; return Promise.reject(new GatewayError('HTTPStatus401')) },
  }})
  h.intake.open(request, 'Fix it', 'u1', 'e')
  await h.intake.settled()
  assert.equal(calls, 1)
  assert.equal(h.intake.view?.state, 'failed')
  assert.deepEqual(failures, [{stage: 'assess', reason: 'authentication', attempt: 1, retrying: false}])
  assert.match(h.facts.at(-1)!, /配置/)
})

test('plan generation retries independently but admission exceptions never retry', async () => {
  let assessments = 0, plans = 0, admissions = 0
  const h = harness({models: {
    assess: input => { assessments++; return Promise.resolve(assessment(input)) },
    plan: input => ++plans === 1 ? Promise.reject(new GatewayError('HTTPStatus429')) : Promise.resolve(plan(input)),
  }, dispatch: () => { admissions++; throw new Error('receipt lost after admission') }})
  h.intake.open(request, 'Fix it', 'u1', 'e')
  await h.intake.settled()
  assert.equal(assessments, 1)
  assert.equal(plans, 2)
  assert.equal(admissions, 1)
  assert.equal(h.intake.view?.state, 'dispatch_unknown')
  assert.match(h.facts.at(-1)!, /可能已开始/)
  assert.doesNotMatch(h.facts.at(-1)!, /尚未执行/)
  h.intake.open(request, 'Try again', 'u2', 'e')
  h.intake.userInputStarted()
  h.intake.userResponseCompleted()
  await h.intake.settled()
  assert.equal(admissions, 1)
})

for (const action of ['cancel', 'revise', 'interrupt'] as const) {
  test(`a ${action} during retry backoff cannot launch the old requirement`, async () => {
    let failed!: () => void
    const failure = new Promise<void>(resolve => { failed = resolve })
    const revisions: unknown[] = []
    const h = harness({record: (_s, kind) => { if (kind === 'intake.failure') failed() }, models: {
      assess: input => {
        revisions.push(input.revision)
        if (revisions.length === 1) return Promise.reject(new GatewayError('HTTPStatus503'))
        return Promise.resolve(assessment(input))
      },
    }})
    h.intake.open(request, 'Fix it', 'u1', 'e')
    // The old implementation has only the diagnostic, no durable failure record.
    await Promise.race([failure, h.intake.settled()])
    if (action === 'cancel') h.intake.cancel()
    else if (action === 'revise') h.intake.open(request, 'Fix the new requirement', 'u2', 'e')
    else h.intake.userInputStarted()
    await h.intake.settled()
    assert.deepEqual(revisions, action === 'revise' ? [1, 2] : action === 'interrupt' ? [1, 1] : [1])
    assert.equal(h.dispatched.length, action === 'revise' ? 1 : 0)
    if (action === 'interrupt') {
      h.intake.userInputEnded()
      h.intake.userResponseCompleted()
      await h.intake.settled()
      assert.equal(h.dispatched.length, 1)
    }
  })
}

test('a lost confirmed admission receipt remains unknown and cannot be re-confirmed', async () => {
  const h = harness({settings: {clarification_depth: 'balanced', plan_readback: 'confirm'}})
  h.intake.open(request, 'Fix it', 'u1', 'e')
  await h.intake.settled()
  const operation = h.confirmation.acceptDirectDecision({proposalId: h.intake.view!.proposal_id!, confirmed: true}).operation!
  assert.equal(h.intake.beginConfirmed(operation), true)
  h.intake.settleConfirmed({accepted: false, code: 'callback_failed'})
  assert.equal(h.intake.view?.state, 'dispatch_unknown')
  assert.match(h.facts.at(-1)!, /可能已开始/)
  assert.equal(h.intake.beginConfirmed(operation), false)
})

test('a noncooperative model hits the deadline without dispatch and ignores its late result', async () => {
  const clock = new VirtualClock()
  let release!: (value: unknown) => void
  const h = harness({clock, models: {assess: () => new Promise(resolve => { release = resolve })}})
  h.intake.open(request, 'Fix it', 'u1', 'e')
  clock.advanceTo(30)
  await h.intake.settled()
  assert.equal(h.intake.view?.state, 'failed')
  release(assessment({intake_id: h.intake.view.intake_id, revision: 1}))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.dispatched.length, 0)
  assert.equal(h.intake.view?.state, 'failed')
  assert.equal(clock.waiterCount(), 0)
})

test('a spoken interruption during steering does not discard an accepted receipt', async () => {
  let release!: (value: {accepted: boolean; delegate_id: string}) => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const h = harness({running: () => [{work_id: 'running', project: 'Project', title: 'Task'}],
    models: {assess: input => Promise.resolve(assessment(input, {kind: 'steer'}))},
    steer: () => { entered(); return new Promise(resolve => { release = resolve }) },
  })
  h.intake.open(request, 'Update the task', 'u1', 'e')
  await started
  h.intake.userInputStarted()
  release({accepted: true, delegate_id: 'running'})
  await h.intake.settled()
  assert.equal(h.intake.view?.outcome, 'routed')
  assert.equal(h.intake.preparing, false)
})

test('speech pauses preserve the failed assessment retry budget', async () => {
  let calls = 0
  let failed!: () => void
  const firstFailure = new Promise<void>(resolve => { failed = resolve })
  const h = harness({record: (_s, kind) => { if (kind === 'intake.failure') failed() }, models: {
    assess: () => { calls++; return Promise.reject(new GatewayError('HTTPStatus503')) },
  }})
  h.intake.open(request, 'Fix it', 'u1', 'e')
  await firstFailure
  h.intake.userInputStarted()
  await h.intake.settled()
  h.intake.userResponseCompleted()
  await h.intake.settled()
  assert.equal(calls, 2)
  assert.equal(h.intake.view?.state, 'failed')
})

test('stuck evidence retrieval times out and aborts without launching', async () => {
  const clock = new VirtualClock()
  let entered!: () => void
  let signal!: AbortSignal
  const started = new Promise<void>(resolve => { entered = resolve })
  const h = harness({clock, attachEvidence: (_order, _workspace, abortSignal) => {
    signal = abortSignal; entered(); return new Promise(() => { /* deliberately noncooperative */ })
  }})
  h.intake.open(request, 'Fix it', 'u1', 'e')
  await started
  clock.advanceTo(30)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.intake.view?.state, 'failed')
  assert.equal(signal.aborted, true)
  assert.equal(h.dispatched.length, 0)
})

test('failed proposal delivery invalidates its pending confirmation', async () => {
  const h = harness({settings: {clarification_depth: 'balanced', plan_readback: 'confirm'},
    fact: (session) => { if (session.proposal_id !== null) throw new Error('delivery unavailable') },
  })
  h.intake.open(request, 'Fix it', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.intake.view?.state, 'failed')
  assert.equal(h.intake.view?.proposal_id, null)
})

test('failed speech preserves a pending intake proposal and accepts the next explicit confirmation', async () => {
  const h = harness({settings: {clarification_depth: 'balanced', plan_readback: 'confirm'}})
  h.intake.open(request, 'Fix empty password', 'u1', 'e')
  await h.intake.settled()
  const before = h.intake.view!
  h.intake.userInputStarted()
  h.intake.userInputFailed()
  assert.equal(h.intake.view?.proposal_id, before.proposal_id)
  assert.equal(h.intake.view?.intake_id, before.intake_id)
  assert.equal(h.dispatched.length, 0)
  confirmProposal(h)
  assert.equal(h.intake.view?.outcome, 'dispatched')
  assert.equal(h.planned(), 1)
})

test('failed speech during planning keeps the draft paused through unrelated turns until dispatch revises it', async () => {
  let release!: (value: unknown) => void
  let input!: Readonly<Record<string, unknown>>
  const h = harness({models: {plan: current => {input = current; return new Promise(resolve => {release = resolve})}}})
  h.intake.open(request, 'Fix empty password', 'u1', 'e')
  await new Promise(resolve => setImmediate(resolve))
  h.intake.userInputStarted()
  h.intake.userInputFailed()
  release(plan(input))
  await h.intake.settled()
  h.intake.userInputStarted()
  h.intake.userInputEnded()
  h.intake.userResponseCompleted()
  await h.intake.settled()
  assert.equal(h.dispatched.length, 0)
  assert.notEqual(h.intake.view?.state, 'closed')
  h.intake.open(request, 'Fix the corrected requirement', 'u2', 'e')
  await new Promise(resolve => setImmediate(resolve))
  release(plan(input))
  await h.intake.settled()
  assert.equal(h.dispatched.length, 1)
})

for (const readback of ['summary', 'confirm'] as const) {
  test(`planning disabled preserves validated work order and ${readback} confirmation`, async () => {
    const h = harness({settings: {clarification_depth: 'balanced', plan_readback: readback, generate_plan: false}})
    h.intake.open(request, 'Fix empty password', 'u1', 'e')
    await h.intake.settled()
    assert.equal(h.planned(), 0)
    assert.match(h.intake.view!.work_order!, /Login only/)
    assert.match(h.intake.view!.work_order!, /Keep public API/)
    assert.equal(h.dispatched.length, readback === 'confirm' ? 0 : 1)
    if (readback === 'confirm') assert.ok(h.intake.view!.proposal_id)
  })
}

for (const kind of ['switch', 'create'] as const) {
  test(`${kind}-only resumes a cached assessment after speech without planning or duplicate proposal`, async () => {
    let assessments = 0, resolutions = 0
    let release!: (value: IntakeTarget) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const h = harness({
      models: {assess: input => { assessments++; return Promise.resolve(assessment(input, {
        kind, project: 'Project', slots: {...slots, goal: missing},
      })) }},
      resolveTarget: () => {
        if (++resolutions > 1) return Promise.resolve({...target, action: kind === 'create' ? 'create' : 'select'})
        entered()
        return new Promise(resolve => { release = resolve })
      },
    })
    h.intake.open(request, kind === 'switch' ? 'Switch to Project' : 'Create Project', 'u1', 'e')
    await started
    h.intake.userInputStarted()
    release({...target, action: kind === 'create' ? 'create' : 'select'})
    await h.intake.settled()
    assert.equal(h.intake.view?.proposal_id, null)
    assert.equal(h.intake.view?.work_order, null)
    h.intake.userResponseCompleted()
    await h.intake.settled()
    assert.equal(assessments, 1)
    assert.equal(h.planned(), 0)
    assert.equal(h.dispatched.length, 0)
    assert.ok(h.intake.view?.proposal_id)
    assert.equal(h.facts.filter(text => text.includes('仅通过 confirm')).length, 1)
    h.intake.userInputStarted()
    h.intake.userInputEnded()
    h.intake.userResponseCompleted()
    await h.intake.settled()
    assert.equal(h.facts.filter(text => text.includes('仅通过 confirm')).length, 1)
  })
}

test('a cached successful assessment does not repeat its clarification after an unrelated turn', async () => {
  let assessments = 0
  let release!: (value: unknown) => void
  let input!: Readonly<Record<string, unknown>>
  const h = harness({models: {assess: current => {
    assessments++; input = current; return new Promise(resolve => { release = resolve })
  }}})
  h.intake.open(request, 'Fix something', 'u1', 'e')
  h.intake.userInputStarted()
  release(assessment(input, {kind: 'unclear', candidate_question: {owner: 'user', text: 'Which feature?'}}))
  await h.intake.settled()
  h.intake.userResponseCompleted()
  await h.intake.settled()
  assert.equal(assessments, 1)
  assert.equal(h.intake.view?.questions_asked, 1)
  assert.equal(h.facts.filter(text => text.includes('Which feature?')).length, 1)
  assert.equal(h.planned(), 0)
})

test('intake timing falls back for empty or absent planner models and keeps explicit models', async () => {
  for (const planner_model of [undefined, '', 'planner']) {
    const timings: unknown[] = []
    const h = harness({
      settings: {clarification_depth: 'balanced', plan_readback: 'summary',
        ...(planner_model === undefined ? {} : {planner_model}), fast_model: 'fast'},
      record: (_current, kind, detail) => {
        if (kind === 'intake.timing' && detail.stage === 'plan') timings.push(detail.model)
      },
    })
    h.intake.open(request, 'Fix empty password', 'conversation:1', 'epoch1')
    await h.intake.settled()
    assert.deepEqual(timings, [planner_model === 'planner' ? 'planner' : 'fast'])
  }
})

test('project confirmation repairs the logged null-evidence failure without asking again', async () => {
  let replies = 0
  let repair: Readonly<Record<string, unknown>> | undefined
  const h = harness({resolveTarget: () => Promise.resolve({...target, workspace_display_name: 'blog'}),models: {assess: input => {
    if (input.revision === 1) return Promise.resolve(assessment(input, {project: 'blog'}))
    if (++replies === 1) return Promise.resolve(assessment(input, {project: 'blog'}))
    repair = input
    return Promise.resolve(assessment(input, {project: 'blog', project_confirmation: projectAnswer(input, 'confirmed')}))
  }}})
  h.intake.open(request, '做一个博客页面', 'u1', 'e')
  await h.intake.settled()
  h.intake.open(request, '对对对', 'u2', 'e')
  await h.intake.settled()
  assert.equal(replies, 2)
  assert.match(String(repair?.validation_feedback), /project_confirmation/)
  assert.equal(h.intake.view?.questions_asked, 1)
  assert.equal(h.decisions.length, 1)
  assert.equal(h.intake.view?.state, 'readback', 'cross-project execution still needs the existing workspace proposal')
  assert.equal(h.dispatched.length, 0)
  confirmProposal(h)
  assert.equal(h.intake.view?.outcome, 'dispatched')
})

test('exhausted confirmation repair retains the original task instead of exhausting user questions', async () => {
  let calls = 0
  const h = harness({models: {assess: input => {
    calls++
    return Promise.resolve(assessment(input, {project: 'blog'}))
  }}})
  h.intake.open(request, '做一个博客页面', 'u1', 'e')
  await h.intake.settled()
  h.intake.open(request, '是的', 'u2', 'e')
  await h.intake.settled()
  assert.equal(calls, 3)
  assert.equal(h.intake.view?.questions_asked, 1)
  assert.equal(h.intake.view?.state, 'failed')
  assert.equal(h.intake.view?.outcome, null)
  assert.equal(h.intake.view?.opening, '做一个博客页面')
  assert.match(h.facts.at(-1)!, /原需求已保留/)
  assert.equal(h.decisions.length, 0)
  assert.equal(h.dispatched.length, 0)
})

for (const invalid of ['wrong_turn', 'invented_quote', 'wrong_project', 'rejected_selection'] as const) {
  test(`invalid project confirmation ${invalid} cannot authorize a target`, async () => {
    const h = harness({models: {assess: input => {
      if (input.revision === 1) return Promise.resolve(assessment(input, {project: 'blog'}))
      const confirmation = projectAnswer(input, invalid === 'rejected_selection' ? 'rejected' : 'confirmed')
      if (invalid === 'wrong_turn') confirmation.turn_index = 9
      if (invalid === 'invented_quote') confirmation.evidence = '没有说过这句话'
      return Promise.resolve(assessment(input, {project: invalid === 'wrong_project' ? 'Project' : 'blog', project_confirmation: confirmation}))
    }}})
    h.intake.open(request, '做一个博客页面', 'u1', 'e')
    await h.intake.settled()
    h.intake.open(request, invalid === 'rejected_selection' ? '不是' : '是的', 'u2', 'e')
    await h.intake.settled()
    assert.equal(h.intake.view?.state, 'failed')
    assert.equal(h.intake.view?.questions_asked, 1)
    assert.equal(h.decisions.length, 0)
  })
}

test('confirmed project survives requirement answers without another project question', async () => {
  const inputs: Readonly<Record<string, unknown>>[] = []
  const h = harness({resolveTarget: () => Promise.resolve({...target, workspace_display_name: 'blog'}),settings: {clarification_depth: 'thorough', plan_readback: 'silent'}, models: {assess: input => {
    inputs.push(input)
    if (input.revision === 1) return Promise.resolve(assessment(input, {project: 'blog'}))
    if (input.revision === 2) return Promise.resolve(assessment(input, {project: 'blog',
      project_confirmation: projectAnswer(input, 'confirmed'), slots: {...slots, constraints: missing},
      candidate_question: {owner: 'user', text: '需要深色模式吗？'}}))
    return Promise.resolve(assessment(input, {project: 'blog'}))
  }}})
  h.intake.open(request, '做一个博客页面', 'u1', 'e')
  await h.intake.settled()
  h.intake.open(request, '对', 'u2', 'e')
  await h.intake.settled()
  assert.equal(h.intake.view?.pending_question, '需要深色模式吗？')
  h.intake.open(request, '需要', 'u3', 'e')
  await h.intake.settled()
  assert.deepEqual(inputs.at(-1)?.confirmed_project, {project: 'blog', turn_index: 0, evidence: '对'})
  assert.equal(h.intake.view?.questions_asked, 2)
  assert.equal(h.intake.view?.state, 'readback')
  assert.equal(h.decisions.length, 2)
})

test('changing target invalidates earlier confirmed evidence and cannot resurrect it later', async () => {
  const h = harness({settings: {clarification_depth: 'thorough', plan_readback: 'silent'}, models: {assess: input => {
    if (input.revision === 1) return Promise.resolve(assessment(input, {project: 'blog'}))
    if (input.revision === 2) return Promise.resolve(assessment(input, {project: 'blog',
      project_confirmation: projectAnswer(input, 'confirmed'), slots: {...slots, constraints: missing},
      candidate_question: {owner: 'user', text: '需要深色模式吗？'}}))
    if (input.revision === 3) return Promise.resolve(assessment(input, {project: 'Project',
      slots: {...slots, constraints: missing}, candidate_question: {owner: 'user', text: '需要保留什么？'}}))
    return Promise.resolve(assessment(input, {project: 'blog', project_confirmation: {turn_index: 0, decision: 'confirmed', evidence: '对'}}))
  }}})
  h.intake.open(request, '做一个博客页面', 'u1', 'e')
  await h.intake.settled()
  h.intake.open(request, '对', 'u2', 'e')
  await h.intake.settled()
  h.intake.open(request, '改到 Project 项目，先确定保留哪些内容', 'u3', 'e')
  await h.intake.settled()
  assert.equal(h.intake.view?.confirmed_project, null)
  const decisions = h.decisions.length
  h.intake.open(request, '保留登录页面', 'u4', 'e')
  await h.intake.settled()
  assert.equal(h.intake.view?.state, 'failed')
  assert.equal(h.decisions.length, decisions)
  assert.equal(h.dispatched.length, 0)
})

test('cancellation after a project question does not require confirmation fields', async () => {
  const h = harness({models: {assess: input => Promise.resolve(assessment(input,
    input.revision === 1 ? {project: 'blog'} : {abandon: true}))}})
  h.intake.open(request, '做一个博客页面', 'u1', 'e')
  await h.intake.settled()
  h.intake.open(request, '算了，取消', 'u2', 'e')
  await h.intake.settled()
  assert.equal(h.intake.view?.outcome, 'cancelled')
  assert.equal(h.dispatched.length, 0)
})

test('a rejected answer cannot later be relabelled as a confirmation', async () => {
  const h = harness({models: {assess: input => {
    if (input.revision === 1) return Promise.resolve(assessment(input, {project: 'blog'}))
    if (input.revision === 2) return Promise.resolve(assessment(input, {kind: 'unclear', project: null,
      project_confirmation: projectAnswer(input, 'rejected'), candidate_question: {owner: 'user', text: '请选择项目。'}}))
    return Promise.resolve(assessment(input, {project: 'blog', project_confirmation: {turn_index: 0, decision: 'confirmed', evidence: '不是'}}))
  }}})
  h.intake.open(request, '做一个博客页面', 'u1', 'e')
  await h.intake.settled()
  h.intake.open(request, '不是', 'u2', 'e')
  await h.intake.settled()
  h.intake.open(request, '先保留登录页', 'u3', 'e')
  await h.intake.settled()
  assert.equal(h.intake.view?.state, 'failed')
  assert.equal(h.decisions.length, 0)
})

for (const action of ['cancel', 'revise'] as const) {
  test(`late project confirmation cannot survive ${action}`, async () => {
    let release!: (value: unknown) => void
    let oldInput!: Readonly<Record<string, unknown>>
    const h = harness({models: {assess: input => {
      if (input.revision === 1) return Promise.resolve(assessment(input, {project: 'blog'}))
      if (input.revision === 2) { oldInput = input; return new Promise(resolve => { release = resolve }) }
      return Promise.resolve(assessment(input, {abandon: true}))
    }}})
    h.intake.open(request, '做一个博客页面', 'u1', 'e')
    await h.intake.settled()
    h.intake.open(request, '对', 'u2', 'e')
    if (action === 'cancel') h.intake.cancel()
    else h.intake.open(request, '不是，取消', 'u3', 'e')
    release(assessment(oldInput, {project: 'blog', project_confirmation: projectAnswer(oldInput, 'confirmed')}))
    await h.intake.settled()
    assert.equal(h.intake.view?.outcome, 'cancelled')
    assert.equal(h.intake.view?.confirmed_project, null)
    assert.equal(h.decisions.length, 0)
  })
}

for (const decision of ['rejected', 'unclear'] as const) for (const kind of ['create', 'work'] as const) {
  test(`${decision} cannot silently ${kind} in another project`, async () => {
    const h = harness({models: {assess: input => Promise.resolve(assessment(input, input.revision === 1
      ? {project: 'blog'} : {kind, project: kind === 'create' ? 'new-blog' : 'Project', project_confirmation: projectAnswer(input, decision)}))}})
    h.intake.open(request, '做一个博客页面', 'u1', 'e')
    await h.intake.settled()
    h.intake.open(request, decision === 'rejected' ? '不是' : '还没决定', 'u2', 'e')
    await h.intake.settled()
    assert.equal(h.intake.view?.state, 'failed')
    assert.equal(h.decisions.length, 0)
    assert.equal(h.dispatched.length, 0)
  })
}

test('an explicit redirect names its new project in the same answer', async () => {
  for (const evidence of ['Project', null]) {
    const h = harness({models: {assess: input => Promise.resolve(assessment(input, input.revision === 1
      ? {project: 'blog'} : {project: 'Project', project_evidence: evidence, project_confirmation: projectAnswer(input, 'redirected')}))}})
    h.intake.open(request, '做一个博客页面', 'u1', 'e')
    await h.intake.settled()
    h.intake.open(request, '不是，用 Project 项目', 'u2', 'e')
    await h.intake.settled()
    assert.equal(h.decisions.length, evidence === null ? 0 : 1)
    assert.equal(h.intake.view?.state, evidence === null ? 'failed' : 'closed')
  }
})


const boundWorkspace = {workspace_id: 'w1', revision: 1}
const boundOptions = {boundTarget: () => boundWorkspace}
const confirmSettings = {clarification_depth: 'balanced', plan_readback: 'confirm'} as const

test('current-workspace aliases use the bound target without rewriting the user objective', async () => {
  for (const alias of ['当前项目', ' 当前工作区 ', 'current workspace']) {
    const h = harness({...boundOptions, models: {assess: input => Promise.resolve(assessment(input, {project: alias}))}})
    h.intake.open(request, '把标题改为“当前项目”', 'u1', 'e')
    await h.intake.settled()
    assert.equal(h.decisions[0]?.project, 'Project')
    assert.equal(h.intake.view?.opening, '把标题改为“当前项目”')
    assert.equal(h.dispatched.length, 1)
  }
  const h = harness({activeProject: () => null, resolveTarget: () => Promise.reject(new ProjectResolutionError('unknown_project', {reason: 'explicit_project_required'})),
    models: {assess: input => Promise.resolve(assessment(input, {project: '当前项目'}))}})
  h.intake.open(request, '在当前项目修复按钮', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.dispatched.length, 0)
  assert.ok(h.facts.some(fact => fact.includes('执行工作区')))
})

test('new work ignores inferred continuity, old source quotes and remembered model session defaults', async () => {
  for (const text of ['修复按钮', '把标题改为“继续刚才的任务”', '把标题改为 \"\n继续刚才的任务\n\"', '不要继续旧会话，修复按钮']) {
    const h = harness()
    h.intake.open({...request, source_quotes: ['继续刚才的任务，直接开始']}, text, 'u1', 'e')
    await h.intake.settled()
    assert.equal(h.decisions[0]?.session, 'new', text)
  }
})

test('explicit continuation survives a same-intake clarification but a later new-session directive wins', async () => {
  for (const answer of ['login.ts', '新开一个会话，修改 login.ts']) {
    const h = harness({models: {assess: input => Promise.resolve(assessment(input, (input.turns as unknown[]).length ? {} : {
      slots: {...slots, scope: missing, acceptance: missing, constraints: missing}, candidate_question: {owner: 'user', text: '哪个文件？'},
    }))}})
    h.intake.open(request, '继续刚才的任务', 'u1', 'e')
    await h.intake.settled()
    h.intake.open(request, answer, 'u2', 'e')
    await h.intake.settled()
    assert.equal(h.decisions.at(-1)?.session, answer === 'login.ts' ? 'latest' : 'new')
  }
})

test('only latest-revision explicit direct start in a bound workspace bypasses plan confirmation', async () => {
  for (const [text, direct] of [
    ['修复按钮，直接开始', true], ['直接开始修复按钮', true], ['Fix the button. Go ahead', true],
    ['修复按钮', false], ['不要直接开始修复按钮', false], ['把标题改为“直接开始”', false],
    ['把按钮文案设为直接开始', false], ['用户可能会说直接开始', false], ['直接开始之前先问我', false], ['直接开始了吗？', false],
    ['直接开始是不允许的', false], ['把标题改为 \"\n直接开始\n\"', false], ["把标题改为 '\n直接开始\n'", false], ["Don't go ahead. Fix the label", false],
  ] as const) {
    const h = harness({...boundOptions, settings: confirmSettings,
      models: {assess: input => Promise.resolve(assessment(input, {early_exit: true, execution_mode: 'direct'}))}})
    h.intake.open({...request, source_quotes: ['直接开始']}, text, 'u1', 'e')
    await h.intake.settled()
    assert.equal(h.dispatched.length, direct ? 1 : 0, text)
    assert.equal(h.intake.view?.proposal_id !== null, !direct, text)
  }
  const unbound = harness({settings: confirmSettings, models: {assess: input => Promise.resolve(assessment(input, {early_exit: true}))}})
  unbound.intake.open(request, '修复按钮，直接开始', 'u1', 'e')
  await unbound.intake.settled()
  assert.equal(unbound.dispatched.length, 0, 'global active project is not a conversation binding')
})

test('direct start never bypasses a different workspace or create/switch confirmation', async () => {
  for (const [kind, action] of [['work', 'reuse'], ['create', 'create'], ['switch', 'select']] as const) {
    const h = harness({...boundOptions, settings: confirmSettings,
      models: {assess: input => Promise.resolve(assessment(input, {kind, project: 'blog', project_evidence: 'blog', early_exit: true}))},
      resolveTarget: () => Promise.resolve({...target, action, workspace_id: action === 'create' ? null : 'other', workspace_display_name: 'blog'}),
    })
    h.intake.open(request, '在 blog 修复按钮，直接开始', 'u1', 'e')
    await h.intake.settled()
    assert.equal(h.dispatched.length, 0, kind)
    assert.ok(h.intake.view?.proposal_id, kind)
  }
})

test('direct-start evidence expires on an amended revision before planning finishes', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {release = resolve})
  let entered!: () => void
  const started = new Promise<void>(resolve => {entered = resolve})
  const h = harness({...boundOptions, settings: confirmSettings, models: {
    assess: input => Promise.resolve(assessment(input, {early_exit: true})),
    plan: async input => {if (input.revision === 1) {entered(); await gate}; return plan(input)},
  }})
  h.intake.open(request, '修复按钮，直接开始', 'u1', 'e')
  await started
  h.intake.open(request, '改成只分析 login.ts', 'u2', 'e')
  release()
  await h.intake.settled()
  assert.equal(h.dispatched.length, 0)
  assert.ok(h.intake.view?.proposal_id)
})

for (const stage of ['assess', 'resolve', 'plan', 'evidence'] as const) {
  test(`a changed conversation binding fences deferred ${stage} before proposal or dispatch`, async () => {
    let binding = {...boundWorkspace}
    let release!: () => void
    const gate = new Promise<void>(resolve => {release = resolve})
    let entered!: () => void
    const started = new Promise<void>(resolve => {entered = resolve})
    const pause = async (here: string) => {if (here === stage) {entered(); await gate}}
    const options = {boundTarget: () => binding}
    const h = harness({...options, settings: confirmSettings,
      models: {assess: async input => {await pause('assess'); return assessment(input, {early_exit: true})}, plan: async input => {await pause('plan'); return plan(input)}},
      resolveTarget: async () => {await pause('resolve'); return target},
      attachEvidence: async () => {await pause('evidence'); return {}},
    })
    h.intake.open(request, '修复按钮，直接开始', 'u1', 'e')
    await started
    binding = {workspace_id: 'w2', revision: 2}
    release()
    await h.intake.settled()
    assert.equal(h.dispatched.length, 0)
    assert.equal(h.intake.view?.proposal_id, null)
    assert.equal(h.intake.view?.outcome, 'cancelled')
  })
}

test('binding change invalidates an existing proposal before confirmed admission', async () => {
  let binding = {...boundWorkspace}
  const options = {boundTarget: () => binding}
  const h = harness({...options, settings: confirmSettings})
  h.intake.open(request, '修复按钮', 'u1', 'e')
  await h.intake.settled()
  const operation = h.confirmation.acceptDirectDecision({proposalId: h.intake.view!.proposal_id!, confirmed: true}).operation!
  binding = {workspace_id: 'w2', revision: 2}
  assert.equal(h.intake.beginConfirmed(operation), false)
})

test('a named-session model guess cannot turn literal or historical title text into continuation authority', async () => {
  for (const text of ['继续 Named task？', '不确定是否继续 Named task', '继续 Named task 之前先问我', '不要继续 Named task', '把标题改为“Named task”', '添加一个叫 Named task 的按钮', '修复按钮', '继续刚才的任务，把标题改为“Named task”']) {
    const h = harness({roster: () => [{name: 'Project', last_used_at: 1, last_session_title: 'Named task', running: [], sessions: ['Named task']}],
      models: {assess: input => Promise.resolve(assessment(input, {session: {mode: 'named', title: 'Named task'}}))}})
    h.intake.open({...request, source_quotes: ['继续 Named task 会话']}, text, 'u1', 'e')
    await h.intake.settled()
    assert.equal(h.dispatched.length, 0, text)
    assert.ok(h.intake.view?.pending_question)
  }
})

test('an explicit exact continuation can start directly in the bound workspace', async () => {
  const h = harness({...boundOptions, settings: confirmSettings,
    models: {assess: input => Promise.resolve(assessment(input, {early_exit: true}))},
    resolveTarget: () => Promise.resolve({...target, action: 'resume', session_id: 'exact-session'}),
  })
  h.intake.open(request, '继续刚才的任务，直接开始', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.decisions[0]?.session, 'latest')
  assert.equal(h.intake.view?.target?.session_id, 'exact-session')
})

test('uncertain continuation or disagreement asks instead of silently choosing a session', async () => {
  for (const [text, mode] of [['继续刚才的任务了吗？', 'latest'], ['我不确定是否继续刚才任务', 'latest'], ['继续刚才的任务', 'new']] as const) {
    const h = harness({models: {assess: input => Promise.resolve(assessment(input, {session: {mode}}))}})
    h.intake.open(request, text, 'u1', 'e')
    await h.intake.settled()
    assert.equal(h.dispatched.length, 0, text)
    assert.ok(h.intake.view?.pending_question, text)
  }
  const h = harness()
  h.intake.open(request, '在当前工作区继续刚才的任务', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.decisions[0]?.session, 'latest')
})


test('review boundary: stale confirmation cannot cancel committing or unknown admission', async () => {
  for (const unknown of [false, true]) {
    let binding = {...boundWorkspace}
    const h = harness({boundTarget: () => binding, settings: confirmSettings})
    h.intake.open(request, '修复按钮', 'u1', 'e')
    await h.intake.settled()
    const operation = h.confirmation.acceptDirectDecision({proposalId: h.intake.view!.proposal_id!, confirmed: true}).operation!
    assert.equal(h.intake.beginConfirmed(operation), true)
    if (unknown) h.intake.settleConfirmed({accepted: false, code: 'callback_failed'})
    const state = h.intake.view!.state
    binding = {...binding, revision: 2}
    assert.equal(h.intake.beginConfirmed(operation), false)
    assert.equal(h.intake.view?.state, state)
    assert.notEqual(h.intake.view?.outcome, 'cancelled')
    h.intake.open(request, '再试一次', 'u2', 'e')
    await h.intake.settled()
    assert.equal(h.intake.view?.state, state)
    assert.equal(h.dispatched.length, 0)
  }
})

test('review boundary: idle clarification restarts after target change without old requirements', async () => {
  let binding = {...boundWorkspace}
  const inputs: Readonly<Record<string, unknown>>[] = []
  const h = harness({boundTarget: () => binding, models: {assess: input => {
    inputs.push(input)
    return Promise.resolve(assessment(input, {kind: 'unclear', candidate_question: {owner: 'user', text: '哪个文件？'}}))
  }}})
  h.intake.open(request, '修复旧工作区按钮', 'u1', 'e')
  await h.intake.settled()
  const id = h.intake.view!.intake_id
  binding = {workspace_id: 'w2', revision: 2}
  h.intake.open(request, '新工作区的 login.ts', 'u2', 'e')
  await h.intake.settled()
  assert.notEqual(h.intake.view?.intake_id, id)
  assert.equal(h.intake.view?.opening, '新工作区的 login.ts')
  assert.deepEqual(h.intake.view?.turns, [])
  assert.equal(JSON.stringify(inputs.at(-1)).includes('修复旧工作区按钮'), false)
})

test('review boundary: explicit named-session selection needs no literal continue verb', async () => {
  for (const text of ['继续 Named task', '在 Named task 会话里修复按钮', '用 Named task 会话修复按钮', 'In the Named task session, fix the button']) {
    const h = harness({roster: () => [{name: 'Project', last_used_at: 1, last_session_title: 'Named task', running: [], sessions: ['Named task']}],
      models: {assess: input => Promise.resolve(assessment(input, {session: {mode: 'named', title: 'Named task'}}))}})
    h.intake.open(request, text, 'u1', 'e')
    await h.intake.settled()
    assert.equal(h.decisions[0]?.session_title, 'Named task', text)
    assert.equal(h.dispatched.length, 1, text)
  }
})

test('review boundary: ordinary continuation words with model new keep a new session', async () => {
  for (const text of ['给播放器加一个继续播放按钮', '先修按钮，接着补测试', '把标题改为“继续刚才的任务”']) {
    const h = harness({models: {assess: input => Promise.resolve(assessment(input, {session: {mode: 'new'}}))}})
    h.intake.open(request, text, 'u1', 'e')
    await h.intake.settled()
    assert.equal(h.decisions[0]?.session, 'new', text)
    assert.equal(h.dispatched.length, 1, text)
  }
})


for (const [answer, modelTitle, dispatched] of [
  ['login.ts', 'Named task', true],
  ['先问我是否继续 Named task', 'Named task', false],
  ['先问我', 'Named task', false],
  ['是否继续 Named task？', 'Named task', false],
  ['不要继续 Named task', 'Named task', false],
  ['新开一个会话', 'Named task', false],
  ['在 Other task 会话里修复按钮', 'Named task', false],
  ['在 Other task 会话里修复按钮', 'Other task', true],
] as const) {
  test(`latest session directive boundary: ${answer} / ${modelTitle}`, async () => {
    const h = harness({roster: () => [{name: 'Project', last_used_at: 1, last_session_title: 'Named task', running: [], sessions: ['Named task', 'Other task']}],
      models: {assess: input => Promise.resolve(assessment(input, {
        session: {mode: 'named', title: (input.turns as unknown[]).length ? modelTitle : 'Named task'},
        ...((input.turns as unknown[]).length ? {} : {
          slots: {...slots, scope: missing, acceptance: missing, constraints: missing}, candidate_question: {owner: 'user', text: '哪个文件？'},
        }),
      }))}})
    h.intake.open(request, '继续 Named task', 'u1', 'e')
    await h.intake.settled()
    assert.equal(h.dispatched.length, 0)
    assert.ok(h.intake.view?.pending_question)
    h.intake.open(request, answer, 'u2', 'e')
    await h.intake.settled()
    assert.equal(h.dispatched.length, dispatched ? 1 : 0)
    if (dispatched) assert.equal(h.decisions.at(-1)?.session_title, modelTitle)
    else assert.ok(h.intake.view?.pending_question)
  })
}


test('independent target resolver drives switch confirmation without requirement target fields',async()=>{
 let targetCalls=0
 const models=intakeModels({stream:()=>{throw Error('unused')},complete:request=>{
  const input=JSON.parse(request.prompt) as Record<string,unknown>
  const base=assessment(input,{slots:{goal:missing,scope:missing,acceptance:missing,constraints:missing}})
  const requirements=requirementsSchema.strip().parse(base)
  return Promise.resolve({text:JSON.stringify(requirements)})
 }},'support','planner',{
  resolveIntake:input=>{targetCalls++;return Promise.resolve({intake_id:input.intake_id,revision:input.revision,
   kind:'switch',project:'blog',project_evidence:'blog',session:{mode:'new'},question:null})},
  resolveWork:()=>Promise.resolve(null),
 })
 const h=harness({models,resolveTarget:()=>Promise.resolve({...target,workspace_display_name:'blog',action:'select'})})
 h.intake.open(request,'切到 blog','u1','e')
 await h.intake.settled()
 assert.equal(targetCalls,1)
 assert.equal(h.intake.view?.kind,'switch')
 assert.ok(h.intake.view?.proposal_id)
 assert.equal(h.dispatched.length,0)
 assert.equal(h.planned(),0)
})

test('a target result delayed across a new user revision cannot select or ask for the old target',async()=>{
 let started!:()=>void, release!:()=>void
 const entered=new Promise<void>(resolve=>{started=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 let targets=0
 const models=intakeModels({stream:()=>{throw Error('unused')},complete:request=>{
  const input=JSON.parse(request.prompt) as Record<string,unknown>
  const requirements=requirementsSchema.strip().parse(assessment(input))
  return Promise.resolve({text:JSON.stringify(requirements)})
 }},'support','planner',{
  resolveIntake:async input=>{targets++;if(targets===1){started();await gate}
   return {intake_id:input.intake_id,revision:input.revision,kind:'unclear',project:null,project_evidence:null,session:{mode:'new'},question:input.revision===1?'STALE TARGET':'CURRENT TARGET'}},
  resolveWork:()=>Promise.resolve(null),
 })
 const h=harness({models})
 h.intake.open(request,'Original work','u1','e');await entered
 h.intake.open(request,'Different work','u2','e');release();await h.intake.settled()
 assert.equal(targets,2)
 assert.equal(h.dispatched.length,0)
 assert.ok(!h.facts.some(text=>text.includes('STALE TARGET')))
 assert.ok(h.facts.some(text=>text.includes('CURRENT TARGET')))
})

for(const stage of ['requirements','target'] as const){
 test(`two-stage intake sends ${stage} validation feedback only to its owning model`,async()=>{
  const requirementInputs:Record<string,unknown>[]=[],targetInputs:Readonly<Record<string,unknown>>[]=[]
  const models=intakeModels({stream:()=>{throw Error('unused')},complete:request=>{
   const input=JSON.parse(request.prompt) as Record<string,unknown>;requirementInputs.push(input)
   const output=requirementsSchema.strip().parse(assessment(input,{execution_mode:'direct'}))
   return Promise.resolve({text:JSON.stringify(stage==='requirements'&&requirementInputs.length===1?{...output,kind:'work'}:output)})
  }},'support','planner',{
   resolveIntake:input=>{
    targetInputs.push(input)
    return Promise.resolve({intake_id:input.intake_id,revision:input.revision,kind:'work',project:null,project_evidence:null,
     ...(stage==='target'&&targetInputs.length===1?{}:{session:{mode:'new'}}),question:null})
   },resolveWork:()=>Promise.resolve(null),
  })
  const h=harness({models});h.intake.open(request,'Fix button','u1','e');await h.intake.settled()
  assert.equal(h.dispatched.length,1)
  if(stage==='requirements'){
   assert.match(String(requirementInputs[1]?.validation_feedback),/requirements/)
   assert.ok(targetInputs.every(input=>input.validation_feedback===undefined))
  }else{
   assert.ok(requirementInputs.every(input=>input.validation_feedback===undefined))
   assert.match(String(targetInputs[1]?.validation_feedback),/target/)
  }
 })
}

test('stale requirements after a project question are discarded before confirmation validation',async()=>{
 let selections=0
 const models=intakeModels({stream:()=>{throw Error('unused')},complete:request=>{
  const input=JSON.parse(request.prompt) as Record<string,unknown>
  return Promise.resolve({text:JSON.stringify(requirementsSchema.strip().parse(assessment({...input,revision:1})))})
 }},'support','planner',{
  resolveIntake:input=>{selections++;return Promise.resolve({intake_id:input.intake_id,revision:input.revision,kind:'work',project:'blog',project_evidence:null,session:{mode:'new'},question:null})},
  resolveWork:()=>Promise.resolve(null),
 })
 const h=harness({models});h.intake.open(request,'改一下博客的暗色模式','u1','e');await h.intake.settled()
 assert.equal(h.intake.view?.pending_project_question,'blog')
 h.intake.open(request,'对','u2','e');await h.intake.settled()
 assert.equal(selections,1)
 assert.equal(h.dispatched.length,0)
 assert.ok(h.diagnostics.includes('intake_stale_result'))
 assert.ok(!h.diagnostics.includes('intake_assess_invalid_output'))
})
