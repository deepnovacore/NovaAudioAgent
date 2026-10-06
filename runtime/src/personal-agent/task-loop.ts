import { z } from 'zod'
import type { TaskFence, TaskRecord, TaskService } from './tasks.js'
export const taskDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reconcile'), input_refs: z.array(z.string().min(1).max(512)).min(1), goal_change: z.object({ goal: z.string().trim().min(1).max(16000), acceptance: z.array(z.string().trim().min(1).max(2000)).max(64) }).strict().nullable()
  }).strict(),
  // criteria maps each acceptance criterion (by index) to the evidence that proves it.
  z.object({
    kind: z.literal('complete'), evidence_refs: z.array(z.string().min(1)).max(128), criteria: z.array(z.object({ index: z.number().int().nonnegative(), evidence_refs: z.array(z.string().min(1)).min(1).max(32) }).strict()).max(64).optional()
  }).strict(),
  z.object({
    kind: z.literal('correct'), instruction: z.string().trim().min(1).max(16000), evidence_refs: z.array(z.string().min(1)).max(128)
  }).strict(),
  z.object({
    kind: z.literal('wait'), reason: z.string().trim().min(1).max(4000), evidence_refs: z.array(z.string().min(1)).max(128)
  }).strict(),
])
export type TaskDecision = z.infer<typeof taskDecisionSchema>
export interface TaskLoopPorts {
  ready?(task: TaskRecord): boolean
  evaluate(task: TaskRecord, signal: AbortSignal): Promise<TaskDecision>
  execute(task: TaskRecord, instruction: string, fence: TaskFence): Promise<void>
  publish?(task: TaskRecord): Promise<void>
  syncTodo(task: TaskRecord): Promise<'synced' | 'conflict'>
}
export class TaskExecutionRejected extends Error {
}
export class TaskLoop {
  #runs = new Map<string, Promise<void>>()
  #again = new Set<string>()
  #stop = new AbortController()
  constructor(readonly tasks: TaskService, readonly ports: TaskLoopPorts) { }
  wake(taskId: string): Promise<void> {
    if (this.#stop.signal.aborted)
      return Promise.resolve()
    const existing = this.#runs.get(taskId)
    if (existing) {
      this.#again.add(taskId)
      return existing
    }
    const run = Promise.resolve().then(async () => {
      do {
        this.#again.delete(taskId)
        await this.#step(taskId)
      } while (this.#again.has(taskId) && !this.#stop.signal.aborted)
    }).finally(() => this.#runs.delete(taskId))
    this.#runs.set(taskId, run)
    return run
  }
  async close(): Promise<void> { this.#stop.abort(); await Promise.allSettled(this.#runs.values()); }
  async #step(taskId: string): Promise<void> {
    let task = this.tasks.get(taskId)
    if (task.phase === 'completed') {
      try {
        await this.ports.publish?.(task)
      }
      catch { /* idempotent publication retries on the next wake */ }
      if (task.todo_sync === 'pending')
        try {
          await this.tasks.markTodoSync(task.id, task.goal_revision, await this.ports.syncTodo(task))
        }
        catch { /* durable projection remains pending; execution is never retried */ }
      return
    }
    if (task.pending_delivery || this.ports.ready?.(task) === false)
      return
    if (task.phase === 'cancelled' || task.controller.kind !== 'nova' || this.tasks.activeWork(task.id).length)
      return
    const fence = { task_id: task.id, control_revision: task.control_revision, goal_revision: task.goal_revision }
    try {
      if (this.tasks.hasUnknownWork(task.id) || this.tasks.pendingEffect(task.id) || this.tasks.inputReceipts(task.id).some(receipt => receipt.status === 'unknown')) {
        await this.tasks.wait(fence, 'task_effect_unknown')
        return
      }
      if (task.work_ids.length === 0 && this.tasks.evidence(task.id).length === 0 && !this.tasks.pendingUserInputs(task.id).length) {
        const effect = await this.tasks.reserveInitial(fence)
        await this.#execute(task, task.goal, fence, effect)
        return
      }
      const decision = await this.ports.evaluate(task, this.#stop.signal)
      this.#stop.signal.throwIfAborted()
      task = await this.tasks.applyDecision(fence, decision)
      if (decision.kind === 'reconcile') {
        this.#again.add(taskId)
        return
      }
      if (task.phase === 'completed') {
        try {
          await this.ports.publish?.(task)
        }
        catch { /* idempotent publication retries on the next wake */ }
        if (task.todo_sync === 'pending')
          try {
            await this.tasks.markTodoSync(task.id, task.goal_revision, await this.ports.syncTodo(task))
          }
          catch { /* retry only projection on next wake */ }
      }
      else if (decision.kind === 'correct' && task.phase === 'queued') {
        const effect = this.tasks.pendingEffect(task.id)!
        await this.#execute(task, decision.instruction, fence, effect.id)
      }
    }
    catch (error) {
      if (this.#stop.signal.aborted)
        return
      try {
        await this.tasks.wait(fence, error instanceof Error && ['task_effect_unknown', 'task_initial_pending', 'task_input_reconciliation_required', 'task_input_reconciliation_stale'].includes(error.message) ? error.message : 'task_check_unavailable')
      }
      catch { /* stale controller, goal or terminal state wins */ }
    }
  }
  async #execute(task: TaskRecord, instruction: string, fence: TaskFence, effectId: string): Promise<void> {
    let invoked = false
    try {
      this.#stop.signal.throwIfAborted()
      this.tasks.assertWritable(fence, { kind: 'nova' })
      await this.tasks.markEffectDispatching(effectId)
      this.tasks.assertWritable(fence, { kind: 'nova' })
      this.tasks.assertExecutionAllowed(fence.task_id, { kind: 'nova' })
      invoked = true
      await this.ports.execute(task, instruction, fence)
      await this.tasks.settleEffect(effectId, 'accepted')
    }
    catch (error) {
      const known = !invoked || error instanceof TaskExecutionRejected
      await this.tasks.settleEffect(effectId, known ? 'failed' : 'unknown')
      if (this.#stop.signal.aborted)
        return
      try {
        await this.tasks.wait(fence, known ? (error instanceof Error ? error.message : 'task_execution_rejected') : 'task_execution_unconfirmed')
      }
      catch { /* a newer owner wins */ }
    }
  }
}
