import assert from 'node:assert/strict'
import {test} from 'node:test'
import {IntakeController} from '../src/executors/coding/intake.js'
import {assessSchema, intakeModels, requirementsSchema} from '../src/executors/coding/intake-model.js'
import {MAX_PROJECT_SESSION_TITLE} from '../src/projects/project-state.js'
import {GatewayError} from '../src/model/model-gateway.js'

const LEAK = 'SECRET-MODEL-TEXT'

function harness(assess: (input: Readonly<Record<string, unknown>>) => Promise<unknown>) {
  const failures: Record<string, unknown>[] = [], diagnostics: string[] = []
  let sequence = 0
  const intake = new IntakeController({
    idFactory: () => `intake-${++sequence}`,
    settings: {clarification_depth: 'balanced', plan_readback: 'summary'},
    models: {assess, plan: () => Promise.reject(new Error('unused')),
      targets: {resolveIntake: () => Promise.reject(new Error('unused')), resolveWork: () => Promise.resolve(null)}},
    roster: () => [], running: () => [], activeProject: () => null,
    resolveTarget: () => Promise.reject(new Error('unused')),
    prepare: () => { throw new Error('unused') },
    dispatch: () => ({accepted: true}), steer: () => ({accepted: true}),
    invalidateProposal: () => undefined, fact: () => undefined,
    record: (_s, kind, data) => { if (kind === 'intake.failure') failures.push({...data}) },
    diagnostic: code => { diagnostics.push(code) },
  })
  return {intake, failures, diagnostics}
}

test('invalid intake output records schema paths and codes, never model values', async () => {
  const h = harness(input => Promise.resolve({intake_id: input.intake_id, revision: input.revision, slots: LEAK, readiness: LEAK}))
  h.intake.open({work_order: 'draft', project: null, session: 'latest'}, 'Build it', 'u1', 'e')
  await h.intake.settled()
  assert.equal(h.failures.length, 2)
  const detail = String(h.failures.at(-1)!.detail)
  assert.match(detail, /slots:invalid_type>object/)
  assert.match(detail, /readiness:invalid_type>number/)
  assert.ok(h.diagnostics.includes('intake_assess_invalid_output'))
  assert.ok(h.diagnostics.some(line => line.startsWith('intake_failure_detail stage=assess attempt=2 detail=')))
  assert.ok(![...h.diagnostics, JSON.stringify(h.failures)].some(text => text.includes(LEAK)))
})

test('constraint feedback names only the paraphrased lines so the retry can fix them', async () => {
  const stated = (note: string) => ({state: 'stated' as const, note})
  const models = intakeModels({stream: () => { throw Error('unused') }, complete: request => {
    const input = JSON.parse(request.prompt) as Record<string, unknown>
    return Promise.resolve({text: JSON.stringify(requirementsSchema.strip().parse({
      intake_id: input.intake_id, revision: input.revision, readiness: 1, intent_to_proceed: true,
      candidate_question: null, discovery: [], early_exit: false, abandon: false,
      slots: {goal: stated('做游戏'), scope: stated('单页'), acceptance: stated('能玩'), constraints: stated('约束仅为“单文件 HTML”\n原样保留原文约束')},
    }))})
  }}, 'support', 'planner', {resolveIntake: () => Promise.reject(new Error('unused')), resolveWork: () => Promise.resolve(null)})
  await assert.rejects(models.assess({intake_id: 'i', revision: 1, opening: '做游戏，约束仅为“单文件 HTML”。请原样保留。', source_quotes: [], turns: []}, new AbortController().signal),
    (error: {issues?: {message: string}[]}) => {
      const message = error.issues?.[0]?.message ?? ''
      return message.includes('Not found verbatim: "原样保留原文约束".') && !message.includes('"约束仅为')
    })
})

test('reordered verbatim sentences on one line pass; a fabricated sentence among them is named', async () => {
  const stated = (note: string) => ({state: 'stated' as const, note})
  const opening = '做游戏。不要安装依赖、不要发布。约束仅为“单文件 HTML”。本请求不预授权全局配置更改。'
  const assess = (constraints: string) => intakeModels({stream: () => { throw Error('unused') }, complete: request => {
    const input = JSON.parse(request.prompt) as Record<string, unknown>
    return Promise.resolve({text: JSON.stringify(requirementsSchema.strip().parse({
      intake_id: input.intake_id, revision: input.revision, readiness: 1, intent_to_proceed: true,
      candidate_question: null, discovery: [], early_exit: false, abandon: false,
      slots: {goal: stated('做游戏'), scope: stated('单页'), acceptance: stated('能玩'), constraints: stated(constraints)},
    }))})
  }}, 'support', 'planner', {
    resolveIntake: input => Promise.resolve({intake_id: input.intake_id, revision: input.revision, kind: 'work', project: null, project_evidence: null, session: {mode: 'new'}, question: null}),
    resolveWork: () => Promise.resolve(null),
  }).assess({intake_id: 'i', revision: 1, opening, source_quotes: [], turns: []}, new AbortController().signal)
  const result = await assess('约束仅为“单文件 HTML”。不要安装依赖、不要发布。本请求不预授权全局配置更改。') as {slots: {constraints: {note: string}}}
  assert.equal(result.slots.constraints.note, '约束仅为“单文件 HTML”。不要安装依赖、不要发布。本请求不预授权全局配置更改。')
  await assert.rejects(assess('约束仅为“单文件 HTML”。不得使用任何框架。'), (error: {issues?: {message: string}[]}) =>
    (error.issues?.[0]?.message ?? '').includes('Not found verbatim: "不得使用任何框架。".'))
})

test('a stored session title at the store limit can be named verbatim by target resolution', () => {
  const stated = (note: string) => ({state: 'stated' as const, note})
  const base = {intake_id: 'i', revision: 1, slots: {goal: stated('g'), scope: stated('s'), acceptance: stated('a'), constraints: {state: 'missing' as const, note: ''}},
    readiness: 1, intent_to_proceed: true, candidate_question: null, discovery: [], early_exit: false, abandon: false,
    kind: 'work', project: 'Tetris', project_evidence: null, project_confirmation: null}
  const stored = 'WorkOrder v2 Objective: - '.padEnd(MAX_PROJECT_SESSION_TITLE, '题')
  assert.equal(assessSchema.safeParse({...base, session: {mode: 'named', title: stored}}).success, true)
  assert.equal(assessSchema.safeParse({...base, session: {mode: 'named', title: stored + '题'}}).success, false)
})

test('unparsable output and provider rejections keep a fixed detail; known transport classes add none', async () => {
  const parse = harness(() => Promise.reject(new SyntaxError(`Unexpected token in ${LEAK}`)))
  parse.intake.open({work_order: 'draft', project: null, session: 'latest'}, 'Build it', 'u1', 'e')
  await parse.intake.settled()
  assert.equal(parse.failures.at(-1)!.detail, 'json_parse')
  assert.ok(!parse.diagnostics.join('\n').includes(LEAK))

  const rejected = harness(() => Promise.reject(new GatewayError('HTTPStatus400')))
  rejected.intake.open({work_order: 'draft', project: null, session: 'latest'}, 'Build it', 'u1', 'e')
  await rejected.intake.settled()
  assert.deepEqual(rejected.failures, [{stage: 'assess', reason: 'provider_rejected', attempt: 1, retrying: false, detail: 'HTTPStatus400'}])

  const auth = harness(() => Promise.reject(new GatewayError('HTTPStatus401')))
  auth.intake.open({work_order: 'draft', project: null, session: 'latest'}, 'Build it', 'u1', 'e')
  await auth.intake.settled()
  assert.deepEqual(auth.failures, [{stage: 'assess', reason: 'authentication', attempt: 1, retrying: false}])
})
