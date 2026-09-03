/**
 * The three host tools the voice model uses for agent executors (spec 08).
 *
 * `dispatch` / `cancel` are one global `host` binding each; the executor names come from every
 * manifest carrying `agent` and the per-executor summaries are description lines, because a realtime
 * function schema cannot be assumed to support per-enum-value branches. `confirm` is the one yes/no
 * tool for project proposals and executor approvals; the `id` selects the FSM.
 */
import type {JsonValue} from './events.js'
import {stripLikePython} from './python-text.js'

export const DISPATCH_TOOL = 'dispatch'
export const CANCEL_TOOL = 'cancel'
export const CONFIRM_TOOL = 'confirm'
export const HOST_TOOL_NAMES: ReadonlySet<string> = new Set([DISPATCH_TOOL, CANCEL_TOOL, CONFIRM_TOOL])

// ponytail: one app-server child per CODEX_HOME, i.e. per workspace; a settings key is the upgrade
// path once real usage shows the need.
export const MAX_CONCURRENT_WORK = 3

const MAX_SESSION_TITLE_CODE_POINTS = 20
const SENTENCE_BREAK = /[。！？!?;；\n]|\. /u

/** First sentence of the objective, stripped, ≤20 code points; `uniqueSessionTitle` disambiguates later. */
export function deriveSessionTitle(objective: string): string {
  const first = stripLikePython(objective.split(SENTENCE_BREAK, 1)[0] ?? '')
  return [...first].slice(0, MAX_SESSION_TITLE_CODE_POINTS).join('')
}

export interface AgentSummary {
  readonly name: string
  readonly summary: string
}

export interface HostToolSpec {
  readonly name: string
  readonly description: string
  readonly params: Readonly<Record<string, JsonValue>>
  /** `dispatch` carries the user's origin for intake; `cancel` and `confirm` do not dispatch. */
  readonly inject_origin_ref: boolean
}

const INSTRUCTION = {type: 'string', minLength: 1, maxLength: 4000} as const

function executorLines(agents: readonly AgentSummary[]): string {
  return agents.map(agent => `${agent.name}: ${agent.summary}`).join('；')
}

export function dispatchToolSpec(agents: readonly AgentSummary[]): HostToolSpec {
  return {
    name: DISPATCH_TOOL,
    description: `把用户的自然语言需求交给一个 agent 执行器；由宿主判断项目、会话、是否追问。executor 可选：${executorLines(agents)}`,
    params: {
      type: 'object',
      properties: {
        executor: {type: 'string', enum: agents.map(agent => agent.name)},
        instruction: {...INSTRUCTION, description: '用户这次想要完成的事，保留目标、约束和验收，不缩成第一步'},
      },
      required: ['executor', 'instruction'],
      additionalProperties: false,
    },
    inject_origin_ref: true,
  }
}

export function cancelToolSpec(agents: readonly AgentSummary[]): HostToolSpec {
  return {
    name: CANCEL_TOOL,
    description: `停止一个正在执行的任务；用户明确要求停止或取消时调用。executor 可选：${executorLines(agents)}`,
    params: {
      type: 'object',
      properties: {
        executor: {type: 'string', enum: agents.map(agent => agent.name)},
        instruction: {...INSTRUCTION, description: '同时有多个任务在跑时，用户对要停哪一个的描述'},
      },
      required: ['executor'],
      additionalProperties: false,
    },
    inject_origin_ref: false,
  }
}

export const CONFIRM_TOOL_SPEC: HostToolSpec = {
  name: CONFIRM_TOOL,
  description: [
    '对宿主提出的是/否问题作答：待确认的项目操作或权限请求。只有本轮用户明确同意或明确拒绝才调用；',
    'id 从宿主事实原样复制，accepted=true 表示同意，false 表示拒绝、取消或暂缓；',
    '只调用一次，同一 response 不输出普通音频或文本，也不调用其他工具；表达含糊时不要调用，等待宿主澄清',
  ].join(''),
  params: {
    type: 'object',
    properties: {
      id: {type: 'string', minLength: 1, maxLength: 128},
      accepted: {type: 'boolean'},
    },
    required: ['id', 'accepted'],
    additionalProperties: false,
  },
  inject_origin_ref: false,
}

/** Exact `{id, accepted}` as the provider sent it, or `null`. */
export function confirmArguments(value: unknown): {readonly id: string; readonly accepted: boolean} | null {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes('id') || !keys.includes('accepted')) return null
  // Data descriptors only: a provider-supplied getter is never evaluated at this trust boundary.
  const {id, accepted} = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor | undefined>
  if (id === undefined || accepted === undefined || !('value' in id) || !('value' in accepted)) return null
  if (typeof id.value !== 'string' || id.value === '' || [...id.value].length > 128 || typeof accepted.value !== 'boolean') {
    return null
  }
  return {id: id.value, accepted: accepted.value}
}
