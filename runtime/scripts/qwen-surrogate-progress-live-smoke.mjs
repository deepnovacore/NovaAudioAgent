/**
 * Credential-gated live smoke for the real Qwen Surrogate model.
 *
 * This is deliberately separate from deterministic tests: it calls the configured
 * OpenAI-compatible endpoint and fails loudly when credentials are absent. It records
 * no prompt, model reason, credential, or progress content.
 */

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {VirtualClock} from '../dist/src/clock.js'
import {DASHSCOPE_COMPATIBLE_BASE_URL} from '../dist/src/config.js'
import {GatewaySurrogate} from '../dist/src/model-adapters.js'
import {OpenAIModelGateway} from '../dist/src/model-gateway.js'

const repositoryRoot = resolve(import.meta.dirname, '../..')

function dotenv() {
  const values = {}
  try {
    const envPath = process.env.NOVA_AUDIO_AGENT_ENV_FILE ?? resolve(repositoryRoot, '.env')
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim())
      if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* environment-only configuration is valid */ }
  return values
}

const file = dotenv()
const setting = name => process.env[name] ?? file[name]
const apiKey = setting('DASHSCOPE_API_KEY') ?? setting('NOVA_AUDIO_AGENT_MODEL_API_KEY')
if (!apiKey) {
  console.error('missing DASHSCOPE_API_KEY or NOVA_AUDIO_AGENT_MODEL_API_KEY')
  process.exit(2)
}

const gateway = new OpenAIModelGateway({
  baseUrl: setting('NOVA_AUDIO_AGENT_MODEL_BASE_URL') ?? DASHSCOPE_COMPATIBLE_BASE_URL,
  apiKey,
  clock: new VirtualClock(0),
  requestTimeout: 45,
  metrics: {record: () => undefined},
})
const surrogate = new GatewaySurrogate({
  gateway,
  model: setting('NOVA_AUDIO_AGENT_SURROGATE_MODEL') ?? 'qwen-flash',
  proactivityPreset: 'eager',
})

const cases = [{
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

function view(testCase) {
  const progress = {
    phase: 'working',
    internal_activity: 3,
    elapsed: 20,
    summary: testCase.summary,
  }
  return {
    structured: {
      intent: {objective_hypothesis: '', constraints: [], unresolved_questions: [], uncertainty: 0, revision: 0},
      goal: {objective: '修复进度播报', acceptance_criteria: [], status: 'accepted', revision: 0},
      authorization: {allow: [], deny: [], evidence_refs: [], revision: 0},
    },
    channels: [{
      name: 'conversation', summary: null, omitted: 0,
      recent: [{
        channel: 'conversation', seq: 1, ts: 0, trust: 'trusted_user', priority: 100,
        content: {text: '请修复进度播报'}, outcome: null, refs: [],
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

for (const testCase of cases) {
  const verdict = await surrogate.watch(view(testCase))
  if (verdict.progress_class !== testCase.expectedClass || verdict.speak !== testCase.expectedSpeak) {
    throw new Error(`${testCase.id}: unexpected classification or speech decision`)
  }
  if (verdict.speak && verdict.suggestion_id !== 's-1') {
    throw new Error(`${testCase.id}: spoken verdict did not select the offered suggestion`)
  }
  if (!verdict.speak && verdict.suggestion_id !== null) {
    throw new Error(`${testCase.id}: silent verdict selected a suggestion`)
  }
  console.log(`${testCase.id}: class=${verdict.progress_class}, speak=${verdict.speak}`)
}

console.log('Qwen Surrogate progress smoke passed')
