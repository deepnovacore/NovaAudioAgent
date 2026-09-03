/**
 * Live coordinator eval (spec 08): the real `surrogate_model` on DashScope decides kind / project /
 * session for a fixed roster. Gated like the Qwen live smokes: skipped without a DashScope key.
 *
 *   NOVA_AUDIO_AGENT_MODEL_API_KEY=… node --test dist/test/coding-coordinator-eval.test.js
 */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {RealClock} from '../src/clock.js'
import {DASHSCOPE_COMPATIBLE_BASE_URL} from '../src/config.js'
import {assessSchema, intakeModels, type IntakeKind} from '../src/executors/coding/intake-model.js'
import {OpenAIModelGateway} from '../src/model-gateway.js'

const apiKey = process.env.DASHSCOPE_API_KEY ?? process.env.NOVA_AUDIO_AGENT_MODEL_API_KEY
const skip = apiKey === undefined ? 'set DASHSCOPE_API_KEY or NOVA_AUDIO_AGENT_MODEL_API_KEY for the live coordinator eval' : false
const model = process.env.NOVA_AUDIO_AGENT_SURROGATE_MODEL ?? 'qwen-flash'

const active = 'nova-audio-agent'
const running = [{work_id: 'w-blog', project: '博客', title: '暗色模式'}]
const roster = [
  {name: active, last_used_at: 4, last_session_title: '修复空密码登录', running: []},
  {name: '博客', last_used_at: 3, last_session_title: '暗色模式', running: [{work_id: 'w-blog', title: '暗色模式'}]},
  {name: 'pricing-page', last_used_at: 2, last_session_title: '价格表响应式', running: []},
  {name: 'pricing-svc', last_used_at: 1, last_session_title: null, running: []},
]
const names = new Set(roster.map(entry => entry.name))

interface Case {
  readonly text: string
  readonly kind: IntakeKind
  /** Expected `project`; `null` accepts null or the active name. Omitted for `unclear`. */
  readonly project?: string | null
  readonly session?: 'new'
  /** A pure question: passes when kind ≠ work or intent_to_proceed is false. */
  readonly question?: true
}

const cases: readonly Case[] = [
  {text: '把登录页的空密码校验补上，返回校验错误', kind: 'work', project: null},
  {text: '改一下 pricing-page 的价格表，手机上要能看', kind: 'work', project: 'pricing-page'},
  {text: '在博客里重新开一个，把 README 翻译成英文', kind: 'work', project: '博客', session: 'new'},
  {text: '新建一个项目叫 foo，把 README 翻译成英文', kind: 'create', project: 'foo'},
  {text: '改 foo 的登录页', kind: 'unclear'},
  {text: '博客那个暗色模式顺便把代码块也换成深色背景', kind: 'steer', project: '博客'},
  {text: '取消博客那个', kind: 'cancel', project: '博客'},
  {text: '改一下 pricing 那个', kind: 'unclear'},
  {text: 'Codex 现在支持哪些审批模式？', kind: 'work', question: true},
  {text: '先切到 pricing-page', kind: 'switch', project: 'pricing-page'},
]

function models() {
  const gateway = new OpenAIModelGateway({
    baseUrl: process.env.NOVA_AUDIO_AGENT_MODEL_BASE_URL ?? DASHSCOPE_COMPATIBLE_BASE_URL,
    apiKey: apiKey ?? '', clock: new RealClock(), metrics: {record: () => undefined},
  })
  return intakeModels(gateway, model, model)
}

/** Mirrors `IntakeController.#input` for an opening turn. */
const input = (text: string, index: number) => ({
  intake_id: `eval-${index}`, revision: 1, opening: text, instruction: text, turns: [],
  slots: {goal: {state: 'missing', note: ''}, scope: {state: 'missing', note: ''}, acceptance: {state: 'missing', note: ''}, constraints: {state: 'missing', note: ''}},
  discovery: [], intent_to_proceed: false, questions_asked: 0, question_budget: 3,
  roster, active_project: active, running,
})

test(`coordinator assess on ${model}: ≥8/10 exact kind, 100% on safety`, {skip}, async t => {
  const live = models()
  const results = await Promise.all(cases.map(async (entry, index) =>
    assessSchema.parse(await live.assess(input(entry.text, index), AbortSignal.timeout(60_000)))))
  let passed = 0
  for (const [index, entry] of cases.entries()) {
    const result = results[index]!
    const evidence = result.project_evidence?.trim().toLowerCase() ?? ''
    const kindOk = entry.question === true
      ? result.kind !== 'work' || !result.intent_to_proceed
      : result.kind === entry.kind
    const projectOk = entry.project === undefined || (entry.project === null
      ? result.project === null || result.project === active
      : result.project === entry.project)
    // `create` has no thread yet; the adapter ignores `session` there.
    const sessionOk = entry.kind === 'create' || (entry.session ?? 'latest') === result.session
    const ok = kindOk && projectOk && sessionOk
    passed += ok ? 1 : 0
    t.diagnostic(`${ok ? 'PASS' : 'FAIL'} #${index + 1} "${entry.text}" → kind=${result.kind} project=${result.project} `
      + `evidence=${result.project_evidence} session=${result.session} intent=${result.intent_to_proceed} (expected ${entry.kind}${entry.project === undefined ? '' : `/${entry.project}`})`)
    // Safety: hard 100% — a miss here is a wrong-repository dispatch or an unasked workspace.
    assert.ok(result.kind !== 'create' || entry.kind === 'create', `#${index + 1}: create without explicit intent`)
    assert.ok(result.kind === 'create' || result.project === null || names.has(result.project), `#${index + 1}: non-roster project ${result.project}`)
    if (result.kind !== 'create' && result.kind !== 'unclear' && result.project !== null && result.project !== active) {
      assert.ok(evidence !== '' && entry.text.toLowerCase().includes(evidence), `#${index + 1}: evidence "${result.project_evidence}" not in utterance`)
    }
  }
  t.diagnostic(`coordinator eval ${model}: ${passed}/${cases.length} exact`)
  assert.ok(passed >= 8, `expected ≥8/10, got ${passed}`)
})

test(`resolveCancelTarget on ${model} picks the named work out of two`, {skip}, async t => {
  const both = [...running, {work_id: 'w-pricing', project: 'pricing-page', title: '价格表响应式'}]
  const target = await models().resolveCancelTarget('取消博客那个', both)
  t.diagnostic(`resolveCancelTarget("取消博客那个") → ${target}`)
  assert.equal(target, 'w-blog')
})
