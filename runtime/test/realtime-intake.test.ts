import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {VirtualClock} from '../src/clock.js'
import {IntakeController, isIntakeAction, type IntakeOptions} from '../src/realtime/intake.js'
import {intakeModels, type IntakeModels, type IntakeSlots} from '../src/realtime/intake-model.js'
import {ProjectConfirmationController} from '../src/project-confirmation.js'
import {renderWorkOrder, workOrderSchema} from '../src/realtime/work-order.js'

const stated = (note: string) => ({state: 'stated' as const, note})
const missing = {state: 'missing' as const, note: ''}
const slots: IntakeSlots = {goal: stated('Fix empty password'), scope: stated('Login only'), acceptance: stated('Show validation error'), constraints: stated('Keep public API')}
const order = workOrderSchema.parse({objective: slots.goal.note, scope_in: ['Login only'], acceptance: ['Show validation error']})
const assessment = (input: Readonly<Record<string, unknown>>, changes = {}) => ({
  intake_id: input.intake_id, revision: input.revision, slots, readiness: 1,
  intent_to_proceed: true, candidate_question: null, discovery: [], early_exit: false, abandon: false,
  ...changes,
})
const plan = (input: Readonly<Record<string, unknown>>) => ({intake_id: input.intake_id, revision: input.revision, work_order: order})
const request = {action: 'start_session', session: 'Named task', work_order: 'draft'}
const target = {workspace: '/canonical/project', action: 'reuse' as const, workspace_display_name: 'Project', workspace_id: 'w1', session_title: 'Named task', session_id: null}

function harness(options: Partial<IntakeOptions> = {}) {
  let sequence = 0
  let planned = 0
  const facts: string[] = [], records: string[] = [], diagnostics: string[] = []
  const dispatched: unknown[] = []
  const confirmation = new ProjectConfirmationController({clock: new VirtualClock(), idFactory: () => `proposal-${++sequence}`})
  const intake = new IntakeController({
    idFactory: () => `intake-${++sequence}`,
    settings: {clarification_depth: 'balanced', plan_readback: 'summary'},
    models: {assess: input => Promise.resolve(assessment(input)), plan: input => { planned++; return Promise.resolve(plan(input)) }},
    resolveTarget: () => Promise.resolve(target),
    prepare: current => confirmation.prepare({...target, intake_id: current.intake_id, plan_revision: current.plan_revision!, origin_ref: current.origin_ref, work_order: current.work_order}),
    dispatch: current => { dispatched.push(current); return {accepted: true, delegate_id: 'd1'} },
    invalidateProposal: () => { confirmation.invalidate('amended') },
    fact: (_current, text) => { facts.push(text) },
    record: (_current, kind) => { records.push(kind) },
    diagnostic: code => { diagnostics.push(code) },
    ...options,
  })
  return {intake, confirmation, facts, records, diagnostics, dispatched, planned: () => planned}
}

test('intake zero-question fast path compiles once, preserves target/session and closes only on acceptance', async () => {
  const h = harness()
  h.intake.open(request, 'Fix empty password', 'conversation:1', 'epoch1')
  await h.intake.settled()
  assert.equal(h.intake.view?.outcome, 'dispatched')
  assert.equal(h.intake.view?.questions_asked, 0)
  assert.equal(h.intake.view?.workspace, '/canonical/project')
  assert.equal(h.intake.view?.codex_session, 'Named task')
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

test('only coding project actions enter intake', () => {
  for (const action of ['list_workspaces', 'list_sessions', 'select_workspace', 'create_workspace']) assert.equal(isIntakeAction({action}), false)
  for (const action of ['start_session', 'resume_session', 'create_workspace']) assert.equal(isIntakeAction({action, work_order: 'task'}), true)
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
