import {z} from 'zod'
import type {ExecutorProgress} from './desktop-progress.js'
import type {PublicProjectView} from './desktop-wire.js'
const id = z.string().min(1).max(128).refine(s => s.trim().length > 0 && !/[\p{C}]/u.test(s))
const label = z.string().min(1).refine(s => [...s].length <= 120 && !/[\p{C}]/u.test(s))
export const taskActionSchema = z.object({type: z.literal('executor.task_action'), request_id: id, work_id: id, executor: id, action: z.enum(['open', 'cancel'])}).strict()
export const taskActionResultSchema = z.object({type: z.literal('executor.task_action_result'), request_id: id, work_id: id, action: z.enum(['open', 'cancel']), status: z.enum(['opened', 'cancelling', 'not_running', 'unavailable', 'failed'])}).strict()
export type TaskAction = z.infer<typeof taskActionSchema>
export type TaskActionStatus = z.infer<typeof taskActionResultSchema>['status']
export const executorTasksSchema = z.object({type: z.literal('executor.tasks'), revision: z.number().int().nonnegative(), active_project: label.nullable(), tasks: z.array(z.object({work_id: id, executor: id, project: label, title: label, phase: z.enum(['started', 'working', 'completed', 'failed', 'refused', 'unknown', 'cancelled']), summary: z.string().min(1).max(180), ts: z.number().finite().nonnegative()}).strict()).max(16)}).strict()
type Task = z.infer<typeof executorTasksSchema>['tasks'][number]
const bounded = (value: string, n: number): string => [...value.replace(/[\p{C}]/gu, '')].slice(0, n).join('')
const running = (task: Task): boolean => task.phase === 'started' || task.phase === 'working'
/** Retention is independent of presentation and delivery preferences. */
export class DesktopTasks {
  readonly #executor: string | null
  readonly #tasks = new Map<string, Task>()
  #revision = 0
  #project: string | null = null
  #view: PublicProjectView | null = null
  constructor(executor: string | null) { this.#executor = executor }
  has(work: string, executor: string): boolean { return this.#tasks.get(work)?.executor === executor }
  isRunning(work: string): boolean { const task = this.#tasks.get(work); return task !== undefined && running(task) }
  progress(frame: ExecutorProgress): void {
    if (frame.executor !== this.#executor || frame.phase === 'alert') return
    const previous = this.#tasks.get(frame.delegate_id)
    if (previous !== undefined && (!running(previous) || frame.ts < previous.ts)) return
    if (previous === undefined && this.#tasks.size >= 6) {
      const evict = [...this.#tasks].find(([, task]) => !running(task))?.[0]
      if (evict === undefined) return
      this.#tasks.delete(evict)
    }
    this.#tasks.set(frame.delegate_id, {work_id: frame.delegate_id, executor: frame.executor, project: previous?.project ?? bounded(frame.executor, 120), title: previous?.title ?? '任务', phase: frame.phase, summary: frame.summary, ts: frame.ts})
    this.#revision++
    if (this.#view !== null) this.project(this.#view)
  }
  project(view: PublicProjectView): void {
    this.#view = view
    const before = JSON.stringify(this.snapshot())
    this.#project = view.workspace_display_name === null ? null : bounded(view.workspace_display_name, 120) || null
    for (const entry of view.roster ?? []) for (const work of entry.running) {
      const task = this.#tasks.get(work.work_id)
      if (task !== undefined) { task.project = bounded(entry.name, 120) || bounded(task.executor, 120); task.title = bounded(work.title, 120) || '任务' }
    }
    if (before !== JSON.stringify(this.snapshot())) this.#revision++
  }
  snapshot(): z.infer<typeof executorTasksSchema> {
    return {type: 'executor.tasks', revision: this.#revision, active_project: this.#project, tasks: [...this.#tasks.values()].sort((a, b) => Number(running(b)) - Number(running(a)) || b.ts - a.ts).map(task => ({...task}))}
  }
}
