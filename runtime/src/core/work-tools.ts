/**
 * The three host tools the voice model uses for registered agent controllers (spec 08).
 *
 * `dispatch` / `cancel` are one global `host` binding each; the public agent names come from host
 * controller descriptors and the per-agent summaries are description lines, because a realtime
 * function schema cannot be assumed to support per-enum-value branches. `confirm` is the one yes/no
 * tool for project proposals and executor approvals; the `id` selects the FSM.
 */
import type {JsonValue} from './events.js'
import type {AgentDescriptor} from '../executors/agent-controller.js'
import {stripLikePython} from '../text/python-text.js'

export const DISPATCH_TOOL = 'dispatch'
export const CANCEL_TOOL = 'cancel'
export const CONFIRM_TOOL = 'confirm'
export const HOST_TOOL_NAMES: ReadonlySet<string> = new Set([DISPATCH_TOOL, CANCEL_TOOL, CONFIRM_TOOL, 'task'])

// ponytail: one app-server child per CODEX_HOME, i.e. per workspace; a settings key is the upgrade
// path once real usage shows the need.
export const MAX_CONCURRENT_WORK = 3

const MAX_SESSION_TITLE_CODE_POINTS = 20
const SENTENCE_BREAK = /[。！？!?;；\n]|\. /u

/** First sentence of the objective, stripped, ≤20 code points; `uniqueSessionTitle` disambiguates later. */
export function deriveSessionTitle(objective: string): string {
  const first = stripLikePython(objective.split(SENTENCE_BREAK, 1)[0] ?? '')
  const points = [...first]
  return points.length > MAX_SESSION_TITLE_CODE_POINTS ? points.slice(0, MAX_SESSION_TITLE_CODE_POINTS - 1).join('') + '…' : first
}

export interface HostToolSpec {
  readonly name: string
  readonly description: string
  readonly params: Readonly<Record<string, JsonValue>>
  /** `dispatch` carries the user's origin for intake; `cancel` and `confirm` do not dispatch. */
  readonly inject_origin_ref: boolean
}

const INSTRUCTION = {type: 'string', minLength: 1, maxLength: 4000} as const

function executorLines(agents: readonly AgentDescriptor[]): string {
  return agents.map(agent => `${agent.name}: ${agent.summary}`).join('；')
}

export function dispatchToolSpec(agents: readonly AgentDescriptor[]): HostToolSpec {
  return {
    name: DISPATCH_TOOL,
    description: `把已经明确的任务交给 agent，包括只新建或切换工作区（不执行编码）、新任务、继续、追加和修改。派发的是已经明确的用户任务，不是让下游替前台澄清需求。产物类别、当前目录或“可以做出来”本身不算依据；当不同用法会让用户得到明显不同的结果而又没有其他依据时，先问最关键的一点。依据可以来自用户当前描述、相关历史或明确委托，不要求固定字段，不重复询问已知内容。关键歧义消除后调用。不要在调用前再问是否执行或复核已给出的名称。下游 coordinator 决定项目和会话，宿主会为确需授权的操作生成带 id 的确认提议。executor 可选：${executorLines(agents)}`,
    params: {
      type: 'object',
      properties: {
        task_id: {type: 'string', minLength: 1, maxLength: 512},
        executor: {type: 'string', enum: agents.map(agent => agent.name)},
        instruction: {...INSTRUCTION, description: '本次任务已明确的完整目标、约束和验收，合并最新纠正，不只传最后一句、不添加未要求的约束'},
        source_refs: {type: 'array', maxItems: 8, items: {type: 'string'}, description: '从用户原话引用目录选择本次任务相关的 ref，包含多轮澄清中的最初目标和指定项目；不引用助手建议或无关旧任务。只有当前一句足够时省略。'},
      },
      required: ['executor', 'instruction'],
      additionalProperties: false,
    },
    inject_origin_ref: true,
  }
}

export function cancelToolSpec(agents: readonly AgentDescriptor[]): HostToolSpec {
  return {
    name: CANCEL_TOOL,
    description: `停止一个正在准备或执行的任务；用户明确要求停止或取消时必须调用，不要只口头答应。用户说先别停止或只讨论是否停止时不要调用。executor 可选：${executorLines(agents)}`,
    params: {
      type: 'object',
      properties: {
        task_id: {type: 'string', minLength: 1, maxLength: 512},
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
    'id 从宿主事实原样复制，accepted=true 表示同意，false 表示明确拒绝或取消；尚未决定或追问原因不表示拒绝；',
    "For Chinese replies to the pending permission question, \"始终确认\", \"永远确认\", and \"始终允许\" mean YES with session scope: accepted=true, scope=session. They are NOT refusals. Distinguish requests to keep asking: \"始终让我确认\", \"每次都问我\", \"always ask me to confirm\", or \"always require my confirmation\" express a prompting preference, NOT a decision on the pending operation; do not call confirm at all for these. Ordinary yes approves once without scope. scope is the requested authorization: the host validates allowed_decisions; unsupported session scope must not be silently downgraded. Project operations cannot request session scope. Negation, quotation and questions are not consent.",
    '只调用一次，同一 response 不输出普通音频或文本，也不调用其他工具；表达含糊时不要调用，等待宿主澄清',
  ].join(''),
  params: {
    type: 'object',
    properties: {
      id: {type: 'string', minLength: 1, maxLength: 128},
      accepted: {type: 'boolean', description: 'Decision on the CURRENT operation only. A preference such as always ask me to confirm is neither approval nor refusal: do not call confirm for that preference.'},
      scope: {type: 'string', enum: ['session'], description: 'Requested session permission only when the user wants approval without asking again (always allow). Never use for a request to keep asking for confirmation. Ordinary one-shot approval omits scope.'},
    },
    required: ['id', 'accepted'],
    additionalProperties: false,
  },
  inject_origin_ref: false,
}

/** Exact `{id, accepted}` as the provider sent it, or `null`. */
export function confirmArguments(value: unknown): {readonly id: string; readonly accepted: boolean; readonly scope?: 'session'} | null {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null
  const keys = Reflect.ownKeys(value)
  if ((keys.length !== 2 && keys.length !== 3) || !keys.includes('id') || !keys.includes('accepted') || keys.some(key => !['id', 'accepted', 'scope'].includes(String(key)))) return null
  // Data descriptors only: a provider-supplied getter is never evaluated at this trust boundary.
  const {id, accepted, scope} = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor | undefined>
  if (id === undefined || accepted === undefined || !('value' in id) || !('value' in accepted)) return null
  if (typeof id.value !== 'string' || id.value === '' || [...id.value].length > 128 || typeof accepted.value !== 'boolean') {
    return null
  }
  if (keys.includes('scope') && (scope === undefined || !('value' in scope) || scope.value !== 'session' || accepted.value !== true)) return null
  return {id: id.value, accepted: accepted.value, ...(scope === undefined ? {} : {scope: 'session' as const})}
}
