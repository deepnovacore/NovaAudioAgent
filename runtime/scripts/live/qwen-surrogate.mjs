/**
 * Credential-gated live smoke for the real Qwen Proactive model.
 *
 * This is deliberately separate from deterministic tests: it calls the configured
 * OpenAI-compatible endpoint and fails loudly when credentials are absent. It records
 * no credentials; failed assertions include the synthetic-case verdict for diagnosis.
 */

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {VirtualClock} from '../../dist/src/core/clock.js'
import {DASHSCOPE_COMPATIBLE_BASE_URL} from '../../dist/src/config/config.js'
import {GatewayProactivity} from '../../dist/src/model/proactivity.js'
import {OpenAIModelGateway} from '../../dist/src/model/model-gateway.js'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

function dotenv() {
  const values = {}
  try {
    const envPath = process.env.ENV_FILE ?? resolve(repositoryRoot, '.env')
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim())
      if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* environment-only configuration is valid */ }
  return values
}

const file = dotenv()
const setting = name => process.env[name] ?? file[name]
const apiKey = setting('DASHSCOPE_API_KEY') ?? setting('MODEL_API_KEY')
if (!apiKey) {
  console.error('missing DASHSCOPE_API_KEY or MODEL_API_KEY')
  process.exit(2)
}

const gateway = new OpenAIModelGateway({
  baseUrl: setting('MODEL_BASE_URL') ?? DASHSCOPE_COMPATIBLE_BASE_URL,
  apiKey,
  clock: new VirtualClock(0),
  requestTimeout: 45,
  metrics: {record: () => undefined},
})
const proactive = new GatewayProactivity({
  gateway,
  model: setting('SUPPORT_MODEL') ?? 'qwen-plus',
  proactivityPreset: 'eager',
})

const cases = [{
  id: 'repeated-known-pomodoro-requirements',
  goal: '创建单文件番茄计时器，25分钟工作5分钟休息，支持开始暂停重置，完成后打开浏览器',
  previous: '正在安排任务',
  summary: '我会创建单文件番茄计时器，验证25/5分钟循环和开始暂停重置功能，完成后打开浏览器。',
  expectedClass: 'routine_delta', expectedSpeak: false,
}, {
  id: 'concrete-working-plan',
  goal: '实现一个网页版贪吃蛇游戏',
  previous: '任务已开始',
  summary: '我会用单个 HTML 文件实现，采用网格和方向键控制，并检查碰撞、计分及加速逻辑。',
  expectedClass: 'routine_delta',
  expectedSpeak: true,
}, {
  // The completed milestone stays verbatim in the cumulative summary; only the file count moves.
  id: 'cumulative-old-milestone-file-count-only',
  previous: '根因定位已完成；已修改 2 个文件',
  summary: '根因定位已完成；已修改 3 个文件',
  expectedClass: 'routine_delta',
  expectedSpeak: false,
}, {
  id: 'verified-milestone',
  previous: '已完成实现，正在运行定向测试',
  summary: '定向测试全部通过，确认修复有效',
  expectedClass: 'milestone',
  expectedSpeak: true,
}]

for (const scope of ['current-reply', 'task-progress']) cases.push({
  id: `silence-scope-${scope}`,
  goal: '创建一个网页工具',
  previous: '先检查工作区',
  summary: '工作区没有现有页面，将以内部 ID 区分同名条目，避免记录混淆。',
  conversation: [
    {trust: 'trusted_system', content: {text: '需要介绍导出和统计这几个可选功能吗？'}},
    {trust: 'trusted_user', content: {text: scope === 'current-reply' ? '不用，不用讲。' : '这个任务的中间进度都不要播报，只告诉我最终结果。'}},
    {trust: 'trusted_system', content: {text: '好，等它跑完我再说结果。'}},
  ],
  expectedClass: 'routine_delta', expectedSpeak: scope === 'current-reply',
})

function view(testCase) {
  const progress = {
    op: 'run',
    phase: 'working',
    internal_activity: 3,
    elapsed: 20,
    summary: testCase.summary,
  }
  return {
    structured: {
      intent: {objective_hypothesis: '', constraints: [], unresolved_questions: [], uncertainty: 0, revision: 0},
      goal: {objective: testCase.goal ?? '修复进度播报', acceptance_criteria: [], status: 'accepted', revision: 0},
      authorization: {allow: [], deny: [], evidence_refs: [], revision: 0},
    },
    channels: [{
      name: 'conversation', summary: null, omitted: 0,
      recent: testCase.conversation?.map((item, index) => ({channel: 'conversation', seq: index + 1, ts: index, priority: 100, outcome: null, refs: [], ...item})) ?? [{
        channel: 'conversation', seq: 1, ts: 0, trust: 'trusted_user', priority: 100,
        content: {text: testCase.goal ?? '请修复进度播报'}, outcome: null, refs: [],
      }],
    }, {
      name: 'codex', summary: null, omitted: 0,
      recent: [{
        channel: 'codex', seq: 1, ts: 20, trust: 'trusted_system', priority: 50,
        content: progress, outcome: null, refs: ['conversation:1'],
      }],
    }],
    in_flight: [{
      delegate_id: 'd-1', what: 'codex.run', eta: 120, deadline: 120,
      origin_ref: 'conversation:1', routing_class: 'ambient', dispatched_at: 0,
    }],
    affordances: [{
      source: 'suggestion', ref: 's-1', conclusive: null,
      content: {
        kind: 'notify', salience: 50, evidence_refs: ['codex:1'],
        suggestion: {summary: testCase.summary, previous_summary: testCase.previous},
      },
    }, {
      source: 'channel_update', ref: 'codex:1', conclusive: null,
      content: {channel: 'codex', observation: progress, outcome: null, ts: 20},
    }],
    floor: 'idle',
    now: 20,
    trigger_kind: 'progress',
  }
}

const failures = []
for (const testCase of cases) {
  const verdict = await proactive.select(view(testCase))
  if (verdict.progress_class !== testCase.expectedClass || verdict.speak !== testCase.expectedSpeak) {
    failures.push(`${testCase.id}: unexpected classification or speech decision: ${JSON.stringify(verdict)}`)
  }
  if (verdict.speak && verdict.suggestion_id !== 's-1') {
    failures.push(`${testCase.id}: spoken verdict did not select the offered suggestion`)
  }
  if (!verdict.speak && verdict.suggestion_id !== null) {
    failures.push(`${testCase.id}: silent verdict selected a suggestion`)
  }
  console.log(`${testCase.id}: class=${verdict.progress_class}, speak=${verdict.speak}`)
}

if (failures.length) throw new Error(failures.join('\n'))
console.log('Qwen Proactive progress smoke passed')
