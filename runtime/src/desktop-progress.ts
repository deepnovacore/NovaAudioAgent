import {z} from 'zod'
import type {CausalRuntime} from './causal-runtime.js'
import {validProgressSummary, type EventRecord} from './events.js'
import type {Suggestion} from './suggestions.js'

const identifier = z.string().min(1).max(128)
const summary = z.string().min(1).max(180)
const credentialName = /(?:^|[\s_-])(?:[a-z0-9]+[_-])*?(?:secret|token|password|api[_-]?key|access[_-]?key|authorization)(?:[_-][a-z0-9]+)*(?:\s*[:=]|\s+)|(?:^|\s)--?(?:token|password|secret|api[_-]?key|access[_-]?key|authorization)(?:=|\s+)/iu
const executorResultBodySchema = z.object({
  delegate_id: identifier, executor: identifier,
  outcome: z.enum(['ok', 'failed', 'refused', 'unknown', 'cancelled']), summary,
  started_at: z.number().finite().nonnegative(), ended_at: z.number().finite().nonnegative(),
  changed_files: z.number().int().nonnegative().nullable(),
}).refine(value => value.ended_at >= value.started_at, {
  message: 'executor result must end at or after it starts',
})
export const executorProgressSchema = z.object({
  type: z.literal('executor.progress'), delegate_id: identifier, executor: identifier,
  phase: z.enum(['started', 'working', 'completed', 'failed', 'refused', 'unknown', 'cancelled', 'alert']),
  summary, level: z.enum(['milestone', 'detail']), ts: z.number().finite().nonnegative(),
})
export type ExecutorProgress = z.infer<typeof executorProgressSchema>
export const executorResultSchema = z.object({
  type: z.literal('executor.result'),
  result: executorResultBodySchema.nullable(),
})
export type ExecutorResult = z.infer<typeof executorResultSchema>['result']
export type ProgressMode = 'off' | 'milestones' | 'all'
type RuntimeEvidence = Pick<CausalRuntime, 'inFlightDelegate' | 'claimedHandoff' | 'delegateFor' | 'terminatedByDeadline'>
  & {readonly executors?: ReadonlyMap<string, {readonly manifest: {readonly display_name?: string | undefined}}>}

/** Prefer a neutral reminder to exposing a command, path or credential in the orb. */
export function safeProgressSummary(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length > 180 || !value.trim()
    || /[\p{C}\/\\`$]|https?:|bearer|(?:sk|rk|pk)-/iu.test(value)
    || credentialName.test(value)
    || /(?:^|\s)(?:curl|npm|pip|sudo|git|node|python)\s/iu.test(value)) return fallback
  return value.trim()
}

/** Event-to-level table: start/final/guard hit=milestone; working/watch hit=detail. */
export function projectExecutorEvent(
  event: EventRecord,
  runtime: RuntimeEvidence,
  agentNameForChannel: (channel: string) => string | null = () => null,
): {
  progress: ExecutorProgress; result?: ExecutorResult
} | null {
  if (event.kind !== 'progress' && event.kind !== 'handoff' && event.kind !== 'observation' && event.kind !== 'deadline') return null
  const id = event.payload.delegate_id
  const delegate = event.kind === 'handoff' ? runtime.claimedHandoff(event.seq)
    : event.kind === 'deadline' ? runtime.terminatedByDeadline(event.seq, id) ? runtime.delegateFor(id) : undefined
      : runtime.inFlightDelegate(id)
  if (delegate?.delegate_id !== id) return null
  if (event.kind !== 'deadline' && delegate.executor !== event.payload.channel) return null
  if ((event.kind === 'progress' || event.kind === 'observation') && delegate.op !== event.payload.op) return null
  if ((event.kind === 'handoff' || event.kind === 'observation') && delegate.origin_ref !== event.payload.origin_ref) return null
  const agentName = agentNameForChannel(delegate.executor)
  const label = agentName ?? (delegate.executor === 'guard' ? '监护' : delegate.executor === 'watch' ? '观察'
    : runtime.executors?.get(delegate.executor)?.manifest.display_name ?? '任务')
  const publicExecutor = agentName ?? delegate.executor
  let phase: ExecutorProgress['phase']
  let level: ExecutorProgress['level'] = 'milestone'
  let text: string
  let result: ExecutorResult | undefined
  if (event.kind === 'progress') {
    const p = event.payload
    if (!validProgressSummary(p.summary, p.phase) || p.elapsed < 0 || !Number.isFinite(p.elapsed)
      || !Number.isInteger(p.internal_activity)
      || (p.phase === 'started' ? p.internal_activity !== 0 : p.internal_activity < 1 || p.internal_activity > 1_048_576)) return null
    phase = p.phase
    if (phase === 'working') {
      if (p.summary === null || delegate.executor === 'guard' || delegate.executor === 'watch') return null
      level = 'detail'
    } else result = null
    text = phase === 'started' ? `${label} 已开始处理任务。` : safeProgressSummary(p.summary, `${label} 正在处理任务。`)
  } else if (event.kind === 'observation') {
    if (event.payload.content.hit !== true) return null
    phase = 'alert'
    level = delegate.executor === 'guard' ? 'milestone' : 'detail'
    text = `${label} 发现需要关注的变化。`
  } else {
    const outcome = event.kind === 'deadline' ? 'unknown' : event.payload.outcome
    phase = outcome === 'ok' ? 'completed' : outcome
    const fallback = outcome === 'ok' ? `${label} 已完成任务。` : `${label} ${outcome === 'unknown' ? '结果尚未确认' : outcome === 'refused' ? '请求被拒绝' : outcome === 'cancelled' ? '任务已停止' : '执行失败'}。`
    text = event.kind === 'handoff' ? safeProgressSummary(event.payload.content.summary, fallback) : fallback
    const changed = event.kind === 'handoff' ? event.payload.content.changed_files : null
    result = {delegate_id: id, executor: publicExecutor, outcome, summary: text,
      started_at: delegate.dispatched_at, ended_at: event.ts,
      changed_files: typeof changed === 'number' && Number.isSafeInteger(changed) && changed >= 0 ? changed : null}
  }
  const parsed = executorProgressSchema.safeParse({type: 'executor.progress', delegate_id: id,
    executor: publicExecutor, phase, summary: text, level, ts: event.ts})
  if (!parsed.success) return null
  if (result === undefined) return {progress: parsed.data}
  const parsedResult = executorResultSchema.safeParse({type: 'executor.result', result})
  if (!parsedResult.success) return null
  return {progress: parsed.data, result: parsedResult.data.result}
}

export function projectExecutorSuggestion(suggestion: Suggestion, now: number): ExecutorProgress | null {
  if (suggestion.origin !== 'surrogate' || suggestion.kind === 'question') return null
  const content = safeProgressSummary(suggestion.content.summary, '')
  if (!content) return null
  const parsed = executorProgressSchema.safeParse({type: 'executor.progress', delegate_id: suggestion.id,
    executor: 'surrogate', phase: 'working', summary: content, level: 'milestone', ts: now})
  return parsed.success ? parsed.data : null
}
