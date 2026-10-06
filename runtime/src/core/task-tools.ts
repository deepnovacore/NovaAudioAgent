import { z } from 'zod'
import type { HostToolSpec } from './work-tools.js'
import type { TaskFence, TaskService } from '../personal-agent/tasks.js'
const identity = z.string().trim().min(1).max(512)
const sources = z.array(identity).max(8)
const goal = z.string().trim().min(1).max(16000)
const acceptance = z.array(z.string().trim().min(1).max(2000)).max(64)
export const taskToolArguments = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('declare'), link_source_todo: z.boolean().optional(), goal, acceptance, source_refs: sources
  }).strict(),
  z.object({ operation: z.literal('revise'), task_id: identity, goal, acceptance, source_refs: sources }).strict(),
  z.object({ operation: z.literal('cancel'), task_id: identity, source_refs: sources }).strict(),
  z.object({ operation: z.literal('continue'), task_id: identity, source_refs: sources }).strict(),
  z.object({ operation: z.literal('return'), task_id: identity, source_refs: sources }).strict(),
])
export interface TaskDispatchContext {
  readonly fence: TaskFence
  readonly origin_ref: string
  readonly stillWanted: () => boolean
}
export interface TaskToolHost {
  readonly sourceTodo?: (origin: string) => {
    id: string
    version: number
  } | undefined
  readonly tasks: TaskService
  readonly conversation_id: string
  readonly conversation_generation?: number
  readonly isCurrent?: () => boolean
  readonly wake?: (taskId: string) => Promise<void>
  readonly cancel?: (requestId: string, fence: TaskFence) => Promise<unknown>
}
export const TASK_TOOL_SPEC: HostToolSpec = {
  name: 'task', description: 'Declare explicitly delegated work, including Nova-only deliverables, or revise/return/continue/cancel an existing task. Todo/Idea capture, questions, and suggestions do not authorize work. Copy source_refs from final user inputs. declare returns task_id for dispatch. Set link_source_todo=true only for a task explicitly handling the linked Todo selected by the user; other independent tasks must omit it. The host supplies the Todo identity.', params: {
    type: 'object', properties: {
      link_source_todo: { type: 'boolean' }, operation: { type: 'string', enum: ['declare', 'revise', 'continue', 'return', 'cancel'] }, task_id: { type: 'string' }, goal: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } }, source_refs: { type: 'array', items: { type: 'string' } }
    }, oneOf: taskToolArguments.options.map(option => z.toJSONSchema(option))
  } as HostToolSpec['params'], inject_origin_ref: true
}
