import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { BoundedJsonStore } from '../storage/bounded-json.js'
import type { TaskDispatchContext } from '../core/task-tools.js'
import { taskDecisionSchema, type TaskDecision } from './task-loop.js'
import { canonicalJson } from '../text/canonical-json.js'
export type TaskPhase = 'queued' | 'running' | 'verifying' | 'waiting' | 'completed' | 'cancelled'
export type TaskActor = {
  kind: 'nova'
} | {
  kind: 'user'
  client_id: string
}
export interface TaskFence {
  task_id: string
  control_revision: number
  goal_revision: number
}
export interface TaskInput {
  execution_route?: string | undefined
  conversation_generation?: number | undefined
  conversation_id: string
  goal: string
  acceptance: string[]
  origin_ref: string
  todo_ref?: {
    id: string
    version: number
  }
}
/** One dispatch: the executor that ran it and the one executor session it ran in. */
export interface TaskWork {
  work_id: string
  executor: string
  session_id?: string
}
export interface TaskRecord extends TaskInput {
  reconciled_inputs?: string[]
  pending_delivery?: string
  original_goal?: string
  execution_route?: string | undefined
  id: string
  phase: TaskPhase
  controller: TaskActor
  control_revision: number
  goal_revision: number
  corrections: number
  work_ids: string[]
  session_ids: string[]
  works?: TaskWork[]
  primary_session_id?: string
  evidence_refs: string[]
  criteria_evidence?: {
    index: number
    evidence_refs: string[]
  }[]
  artifact_refs: string[]
  waiting_reason: string | null
  todo_sync: 'none' | 'pending' | 'synced' | 'conflict'
}
export interface TaskEvent {
  seq: number
  task_id: string
  work_id?: string
  session_id?: string
  thread_id?: string
  turn_id?: string
  item_id?: string
  stage?: 'started' | 'completed'
  kind: 'message' | 'tool' | 'artifact' | 'control' | 'verification' | 'status'
  sender?: 'nova' | 'user-to-executor' | 'executor'
  text: string
  refs: string[]
  text_truncated?: boolean
}
const eventSchema = z.object({
  thread_id: z.string().min(1).max(512).optional(), turn_id: z.string().min(1).max(512).optional(), item_id: z.string().min(1).max(512).optional(), stage: z.enum(['started', 'completed']).optional(), seq: z.number().int().positive(), task_id: z.string().min(1).max(512), work_id: z.string().min(1).max(512).optional(), session_id: z.string().min(1).max(512).optional(), kind: z.enum(['message', 'tool', 'artifact', 'control', 'verification', 'status']), sender: z.enum(['nova', 'user-to-executor', 'executor']).optional(), text: z.string().max(16000), refs: z.array(z.string().min(1).max(512)).max(128), text_truncated: z.boolean().optional()
}).strict().refine(event => event.kind !== 'message' || event.sender !== undefined, 'message_sender_required')
const id = z.string().trim().min(1).max(512)
export const taskInputSchema = z.object({
  execution_route: id.optional(), conversation_generation: z.number().int().nonnegative().optional(), conversation_id: id, goal: z.string().trim().min(1).max(16000), acceptance: z.array(z.string().trim().min(1).max(2000)).max(64), origin_ref: id, todo_ref: z.object({ id, version: z.number().int().nonnegative() }).strict().optional()
}).strict()
const actorSchema = z.union([z.object({ kind: z.literal('nova') }).strict(), z.object({ kind: z.literal('user'), client_id: id }).strict()])
export const taskFenceSchema = z.object({
  task_id: id, control_revision: z.number().int().nonnegative(), goal_revision: z.number().int().nonnegative()
}).strict()
const goalSchema = taskInputSchema.pick({ goal: true, acceptance: true })
const controlChangeSchema = z.object({ fence: taskFenceSchema, actor: actorSchema, nextActor: actorSchema }).strict()
const goalChangeSchema = z.object({
  fence: taskFenceSchema, actor: actorSchema, goal: goalSchema.shape.goal, acceptance: goalSchema.shape.acceptance
}).strict()
const recordSchema = taskInputSchema.extend({
  reconciled_inputs: z.array(id).default([]), pending_delivery: id.optional(), original_goal: z.string().optional(), execution_route: z.string().optional(), id, phase: z.enum(['queued', 'running', 'verifying', 'waiting', 'completed', 'cancelled']), controller: actorSchema, control_revision: z.number().int().nonnegative(), goal_revision: z.number().int().nonnegative(), corrections: z.number().int().nonnegative(), work_ids: z.array(id), session_ids: z.array(id), works: z.array(z.object({ work_id: id, executor: id, session_id: id.optional() }).strict()).default([]), primary_session_id: id.optional(), evidence_refs: z.array(id), criteria_evidence: z.array(z.object({ index: z.number().int().nonnegative(), evidence_refs: z.array(id) }).strict()).optional(), artifact_refs: z.array(id).default([]), waiting_reason: z.string().trim().min(1).max(4000).nullable(), todo_sync: z.enum(['none', 'pending', 'synced', 'conflict'])
}).strict()
type StoredTask = z.infer<typeof recordSchema>
const evidenceSchema = z.object({
  observations: z.array(eventSchema).max(32).default([]), observations_truncated: z.boolean().default(false), ref: id, task_id: id, goal_revision: z.number().int().nonnegative(), kind: z.enum(['work', 'delivery', 'input']), work_id: id.optional(), outcome: z.string(), content: z.string().max(131072), refs: z.array(id).max(128)
}).strict()
export type TaskEvidence = z.infer<typeof evidenceSchema>
const pendingSchema = z.object({
  id, task_id: id, fence: taskFenceSchema, instruction: z.string().max(16000), write_started: z.boolean().optional(), status: z.enum(['pending', 'accepted', 'failed', 'unknown'])
}).strict()
const stateSchema = z.object({
  instruction_work_ids: z.array(id).default([]), outcomes: z.array(evidenceSchema).default([]), work_fences: z.record(z.string(), taskFenceSchema).default({}), pending_effects: z.record(z.string(), pendingSchema).default({}), replay_incomplete: z.array(id).default([]), events: z.array(eventSchema).default([]), event_keys: z.record(z.string(), z.object({ seq: z.number().int().positive(), hash: z.string(), task_id: id.optional() }).strict()).default({}), event_seq: z.number().int().nonnegative().default(0), truncated: z.record(z.string(), z.number().int().nonnegative()).default({}), effects: z.record(z.string(), z.object({
    hash: z.string(), status: z.enum(['accepted', 'failed', 'unknown']), task_id: id.optional(), session_id: id.optional(), fence: taskFenceSchema.optional(), actor: actorSchema.optional(), text: z.string().max(16000).optional()
  }).strict()).default({}), tasks: z.array(recordSchema), receipts: z.record(z.string(), z.object({ hash: z.string(), task_id: id, result: recordSchema.optional() }).strict()), handbacks: z.record(z.string(), z.object({ hash: z.string(), command: z.string().max(16384).optional(), result: z.array(recordSchema).optional() }).strict()).default({})
}).strict()
type TaskState = z.infer<typeof stateSchema>
const RETAINED_FINISHED_TASKS = 200, RETAINED_HANDBACKS = 256, RETAINED_TOMBSTONES = 20000, PRUNE_ABOVE_BYTES = 12 * 1024 * 1024, PRUNE_TO_BYTES = 8 * 1024 * 1024
const empty = (): TaskState => ({
  instruction_work_ids: [], outcomes: [], work_fences: {}, pending_effects: {}, replay_incomplete: [], events: [], event_keys: {}, event_seq: 0, truncated: {}, tasks: [], receipts: {}, handbacks: {}, effects: {}
})
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const sameGoal = (task: Pick<TaskInput, 'goal' | 'acceptance'>, goal: string, acceptance: readonly string[]) => task.goal === goal && task.acceptance.length === acceptance.length && task.acceptance.every((criterion, index) => criterion === acceptance[index])
const grants = new WeakMap<object, {
  tasks: TaskService
  actor: TaskActor
}>()
export function taskGrantService(context: TaskDispatchContext): TaskService {
  const grant = grants.get(context)
  if (!grant)
    throw Error('invalid_continuation')
  grant.tasks.assertExecutionAllowed(context.fence.task_id, grant.actor)
  grant.tasks.assertWritable(context.fence, grant.actor)
  if (grant.tasks.get(context.fence.task_id).origin_ref !== context.origin_ref)
    throw Error('invalid_origin_ref')
  return grant.tasks
}
export class TaskService {
  #grants = new WeakSet<object>()
  #incompleteReplay = new Set<string>()
  continuationContext(fence: TaskFence): TaskDispatchContext { return this.instructionContext(fence, { kind: 'nova' }); }
  instructionContext(fence: TaskFence, actor: TaskActor): TaskDispatchContext {
    fence = Object.freeze(taskFenceSchema.parse(fence))
    actor = Object.freeze(actorSchema.parse(actor))
    this.assertExecutionAllowed(fence.task_id, actor)
    this.assertWritable(fence, actor)
    const context = Object.freeze({
      fence, origin_ref: this.get(fence.task_id).origin_ref, stillWanted: () => {
        try {
          this.assertExecutionAllowed(fence.task_id, actor)
          this.assertWritable(fence, actor)
          return true
        }
        catch {
          return false
        }
      }
    })
    this.#grants.add(context)
    grants.set(context, { tasks: this, actor: structuredClone(actor) })
    return context
  }
  validateContinuation(context: TaskDispatchContext): void {
    if (!this.#grants.has(context))
      throw Error('invalid_continuation')
    this.assertExecutionAllowed(context.fence.task_id, { kind: 'nova' })
    this.assertWritable(context.fence, { kind: 'nova' })
    if (context.origin_ref !== this.get(context.fence.task_id).origin_ref)
      throw Error('invalid_origin_ref')
  }
  assertWritable(fence: TaskFence, actor: TaskActor): void {
    this.assertCurrent(fence, actor)
    const task = this.get(fence.task_id)
    if (task.phase === 'completed' || task.phase === 'cancelled')
      throw Error('task_terminal')
  }
  #store: BoundedJsonStore<TaskState>
  #state: TaskState = empty()
  #tail: Promise<unknown> = Promise.resolve()
  constructor(readonly path: string, readonly changed: () => void = () => { /* optional projection observer */ }, readonly admitExecution: (taskId: string) => void = () => { /* standalone task service */ }) { this.#store = new BoundedJsonStore(path, stateSchema, 16 * 1024 * 1024); }
  async open(): Promise<void> {
    try {
      this.#state = await this.#store.read(empty())
      for (const task of this.#state.tasks)
        task.original_goal ??= Object.values(this.#state.receipts).find(receipt => receipt.task_id === task.id && receipt.result?.goal_revision === 0)?.result?.goal ?? (task.goal_revision === 0 ? task.goal : 'Original goal unavailable')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
    if (Object.values(this.#state.pending_effects).some(effect => effect.status === 'pending') || this.#state.tasks.some(task => task.work_ids.some(work => !this.#state.work_fences[work])))
      await this.#mutate(next => {
        for (const effect of Object.values(next.pending_effects))
          if (effect.status === 'pending')
            effect.status = effect.write_started === false ? 'failed' : 'unknown'
        for (const task of next.tasks)
          if (task.work_ids.some(work => !next.work_fences[work]) && task.phase !== 'completed' && task.phase !== 'cancelled') {
            task.phase = 'waiting'
            task.waiting_reason = 'work_fence_unavailable'
          }
      })
  }
  cancel(requestId: string, fence: TaskFence, actor: TaskActor): Promise<TaskRecord> {
    return this.#change(requestId, { fence: taskFenceSchema.parse(fence), actor: actorSchema.parse(actor), operation: 'cancel' }, task => {
      if (task.phase === 'completed')
        throw Error('task_terminal')
      task.phase = 'cancelled'
      task.waiting_reason = this.hasUnresolvedExecution(task.id) ? 'cancellation_pending' : null
    }, task => this.#assertDecider(task, fence, actor, false))
  }
  readonly #liveInputs = new Set<string>()
  async input(requestId: string, fence: TaskFence, actor: TaskActor, sessionId: string, text: string, send: (grant: TaskDispatchContext) => Promise<'accepted' | 'failed' | 'unknown'>): Promise<'accepted' | 'failed' | 'unknown'> {
    const request = id.parse(requestId), session = id.parse(sessionId), instruction = z.string().trim().min(1).max(16000).parse(text), body = hash({ fence, actor, session, instruction })
    const prior = await this.#mutate(next => {
      const receipt = next.effects[request]
      if (receipt) {
        if (receipt.hash !== body)
          throw Error('request_conflict')
        return receipt.status
      }
      this.assertExecutionAllowed(fence.task_id)
      this.assertWritable(fence, actor)
      if (!this.get(fence.task_id).session_ids.includes(session))
        throw Error('session_not_found')
      next.effects[request] = {
        hash: body, status: 'unknown', task_id: fence.task_id, session_id: session, fence: { ...fence }, actor: { ...actor }, text: instruction
      }
      next.events.push({
        seq: ++next.event_seq, task_id: fence.task_id, session_id: session, kind: 'message', sender: actor.kind === 'user' ? 'user-to-executor' : 'nova', text: instruction, refs: []
      })
      return null
    })
    if (prior)
      return prior
    let status: 'accepted' | 'failed' | 'unknown' = 'unknown'
    let grant: TaskDispatchContext | undefined
    try {
      grant = this.instructionContext(fence, actor)
    }
    catch {
      status = 'failed'
    }
    this.#liveInputs.add(request)
    try {
      if (grant)
        try {
          status = await send(grant)
        }
        catch {
          status = 'unknown'
        }
      await this.#mutate(next => {
        next.effects[request] = { ...next.effects[request]!, hash: body, status }
        next.events.push({
          seq: ++next.event_seq, task_id: fence.task_id, session_id: session, kind: 'control', text: 'Input delivery: ' + status, refs: []
        });
        // A handback can land while the send is in flight; the executor still got the message, so say so in the activity feed.
        const now = next.tasks.find(task => task.id === fence.task_id)
        if (status === 'accepted' && now && now.control_revision !== fence.control_revision)
          next.events.push({
            seq: ++next.event_seq, task_id: fence.task_id, session_id: session, kind: 'control', text: JSON.stringify({ operation: 'input_before_handback', control_revision: now.control_revision }), refs: []
          })
      })
      return status
    }
    finally {
      this.#liveInputs.delete(request)
    }
  }
  async close(): Promise<void> { await this.#tail; }
  get(taskId: string): TaskRecord {
    const task = this.#state.tasks.find(item => item.id === id.parse(taskId))
    if (!task)
      throw Error('task_not_found')
    return structuredClone(task) as TaskRecord
  }
  appendEvent(event: Omit<TaskEvent, 'seq'>, sourceKey: string): Promise<TaskEvent> {
    const key = hash({ task: event.task_id, source: z.string().min(1).max(2048).parse(sourceKey) }), text = event.text.slice(0, 16000)
    const parsed = eventSchema.parse({ ...event, text, ...(event.text.length > 16000 ? { text_truncated: true } : {}), seq: 1 })
    return this.#mutate(next => {
      const task = next.tasks.find(task => task.id === parsed.task_id)
      if (!task)
        throw Error('task_not_found')
      if (parsed.work_id && !task.work_ids.includes(parsed.work_id))
        throw Error('work_not_found')
      if (parsed.session_id && !task.session_ids.includes(parsed.session_id))
        throw Error('session_not_found')
      const body = hash(parsed), prior = next.event_keys[key]
      if (prior) {
        if (prior.hash !== body)
          throw Error('event_conflict')
        return { ...parsed, seq: prior.seq } as TaskEvent
      }
      const item = { ...parsed, seq: ++next.event_seq }
      next.events.push(item)
      next.event_keys[key] = { seq: item.seq, hash: body, task_id: parsed.task_id }
      for (const ref of item.refs)
        if (!task.artifact_refs.includes(ref))
          task.artifact_refs.push(ref)
      return structuredClone(item) as TaskEvent
    })
  }
  markReplayIncomplete(taskId: string): void {
    this.get(taskId)
    this.#incompleteReplay.add(taskId)
    try {
      this.changed()
    }
    catch { /* notification failure cannot change executor outcome */ }
  }
  events(taskId: string, after: number): {
    items: TaskEvent[]
    next: number
    truncated: boolean
    incomplete: boolean
  } {
    this.get(taskId)
    z.number().int().nonnegative().parse(after)
    const items = this.#state.events.filter(event => event.task_id === taskId && event.seq > after).slice(0, 100)
    return {
      incomplete: this.#incompleteReplay.has(taskId) || this.#state.replay_incomplete.includes(taskId), items: structuredClone(items) as TaskEvent[], next: items.at(-1)?.seq ?? after, truncated: (this.#state.truncated[taskId] ?? 0) > after
    }
  }
  inputReceipts(taskId: string) {
    return Object.entries(this.#state.effects).filter(([, receipt]) => receipt.task_id === taskId).map(([request_id, receipt]) => ({ request_id, ...structuredClone(receipt) }))
  }
  list(): TaskRecord[] { return structuredClone(this.#state.tasks) as TaskRecord[]; }
  delegate(requestId: string, input: TaskInput): Promise<TaskRecord> {
    const request = id.parse(requestId), parsed = taskInputSchema.parse(input), payload = hash(parsed)
    return this.#mutate<TaskRecord>(next => {
      const prior = next.receipts[request]
      if (prior) {
        if (prior.hash !== payload)
          throw Error('request_conflict')
        if (!prior.result)
          throw Error('task_retired')
        return structuredClone(prior.result) as TaskRecord
      }
      const task: TaskRecord & {
        reconciled_inputs: string[]
        works: TaskWork[]
      } = {
        reconciled_inputs: [], works: [], ...(parsed.execution_route ? { execution_route: parsed.execution_route } : {}), original_goal: parsed.goal, ...(parsed.conversation_generation === undefined ? {} : { conversation_generation: parsed.conversation_generation }), conversation_id: parsed.conversation_id, goal: parsed.goal, acceptance: parsed.acceptance, origin_ref: parsed.origin_ref, ...(parsed.todo_ref ? { todo_ref: parsed.todo_ref } : {}), id: randomUUID(), phase: 'queued', controller: { kind: 'nova' }, control_revision: 0, goal_revision: 0, corrections: 0, work_ids: [], session_ids: [], evidence_refs: [], artifact_refs: [], waiting_reason: null, todo_sync: 'none'
      }
      next.tasks.push(task)
      next.receipts[request] = { hash: payload, task_id: task.id, result: structuredClone(task) }
      return structuredClone(task)
    })
  }
  control(requestId: string, fence: TaskFence, actor: TaskActor, nextActor: TaskActor): Promise<TaskRecord> {
    const parsed = controlChangeSchema.parse({ fence, actor, nextActor })
    return this.#change(requestId, parsed, task => { task.controller = parsed.nextActor; task.control_revision++; })
  }
  returnFromUserOrigin(requestId: string, fence: TaskFence, provenance: {
    conversation_id: string
    conversation_generation: number
    origin_ref: string
  }, stillWanted: () => boolean): Promise<TaskRecord> {
    const request = id.parse(requestId), parsed = {
      fence: taskFenceSchema.parse(fence), provenance: z.object({ conversation_id: id, conversation_generation: z.number().int().nonnegative(), origin_ref: id }).strict().parse(provenance), operation: 'user_origin_return'
    }, body = hash(parsed)
    return this.#mutate(next => {
      const prior = next.receipts[request]
      if (prior) {
        if (prior.hash !== body)
          throw Error('request_conflict')
        if (!prior.result)
          throw Error('task_retired')
        return structuredClone(prior.result) as TaskRecord
      }
      if (!stillWanted())
        throw Error('superseded')
      const task = next.tasks.find(task => task.id === parsed.fence.task_id)
      if (!task)
        throw Error('task_not_found')
      this.#assertFence(task, parsed.fence)
      if (task.conversation_id !== parsed.provenance.conversation_id)
        throw Error('task_not_owned')
      task.controller = { kind: 'nova' }
      task.control_revision++
      next.events.push({ seq: ++next.event_seq, task_id: task.id, kind: 'control', text: 'Control returned to Nova', refs: [] })
      const result = structuredClone(task)
      next.receipts[request] = { hash: body, task_id: task.id, result }
      return result as TaskRecord
    })
  }
  reservePresentationRequest(requestId: string, clientId: string, command: string): Promise<void> {
    const request = id.parse(requestId), body = hash({ client: id.parse(clientId) }), identity = z.string().min(1).max(16384).parse(command)
    return this.#mutate(next => {
      const prior = next.handbacks[request]
      if (prior) {
        if (prior.hash !== body || prior.command !== identity)
          throw Error('request_conflict')
        return
      }
      next.handbacks[request] = { hash: body, command: identity }
    })
  }
  returnClientTasks(requestId: string, clientId: string): Promise<TaskRecord[]> {
    const request = id.parse(requestId), client = id.parse(clientId), body = hash({ client })
    return this.#mutate(next => {
      const prior = next.handbacks[request]
      if (prior) {
        if (prior.hash !== body)
          throw Error('request_conflict')
        if (prior.result)
          return structuredClone(prior.result) as TaskRecord[]
      }
      const result = next.tasks.filter(task => task.controller.kind === 'user' && task.controller.client_id === client)
      for (const task of result) {
        task.controller = { kind: 'nova' }
        task.control_revision++
        next.events.push({ seq: ++next.event_seq, task_id: task.id, kind: 'control', text: 'Control returned to Nova', refs: [] })
      }
      next.handbacks[request] = { ...prior, hash: body, result: structuredClone(result) }
      return structuredClone(result) as TaskRecord[]
    })
  }
  controlClient(requestId: string, fence: TaskFence, clientId: string, action: 'takeover' | 'return'): Promise<TaskRecord> {
    const parsed = {
      fence: taskFenceSchema.parse(fence), actor: actorSchema.parse({ kind: 'user', client_id: clientId }), action: z.enum(['takeover', 'return']).parse(action)
    }
    return this.#change(requestId, parsed, task => {
      task.controller = parsed.action === 'takeover' ? parsed.actor : { kind: 'nova' }
      task.control_revision++
    }, task => {
      this.#assertFence(task, parsed.fence)
      if (parsed.action === 'takeover' && task.controller.kind === 'user' && task.controller.client_id !== clientId)
        throw Error('not_controller')
    })
  }
  assertCurrent(fence: TaskFence, actor: TaskActor): void {
    const parsed = taskFenceSchema.parse(fence), task = this.#state.tasks.find(item => item.id === parsed.task_id)
    if (!task)
      throw Error('task_not_found')
    this.#assert(task, parsed, actorSchema.parse(actor))
  }
  bindWork(fence: TaskFence, workId: string, sessionId?: string, primary = true): Promise<void> {
    const parsed = taskFenceSchema.parse(fence), work = id.parse(workId), session = sessionId === undefined ? undefined : id.parse(sessionId)
    return this.#mutate(next => {
      const task = next.tasks.find(item => item.id === parsed.task_id)
      if (!task)
        throw Error('task_not_found')
      this.#assertFence(task, parsed)
      if (task.phase === 'completed' || task.phase === 'cancelled')
        throw Error('task_terminal')
      const active = (item: StoredTask) => item.phase !== 'completed' && item.phase !== 'cancelled'
      if (next.tasks.some(item => item.id !== task.id && active(item) && item.work_ids.includes(work)))
        throw Error('work_active')
      if (session)
        for (const previous of next.tasks.filter(item => item.id !== task.id && item.session_ids.includes(session))) {
          // An unfinished task keeps its session even between works, so its corrections continue where they started.
          if (active(previous) || this.hasUnresolvedExecution(previous.id))
            throw Error('session_active')
          previous.session_ids = previous.session_ids.filter(id => id !== session)
          if (previous.primary_session_id === session)
            delete previous.primary_session_id
        }
      if (task.phase === 'queued' || task.phase === 'waiting') {
        task.phase = 'running'
        task.waiting_reason = null
      }
      if (!primary && !next.instruction_work_ids.includes(work))
        next.instruction_work_ids.push(work)
      next.work_fences[work] ??= parsed
      if (!task.work_ids.includes(work))
        task.work_ids.push(work)
      if (session && !task.session_ids.includes(session))
        task.session_ids.push(session);
      // Each work runs on exactly one executor session; the first bound session is where continuations go by default.
      const entry = task.works.find(item => item.work_id === work) ?? (task.works.push({ work_id: work, executor: task.execution_route ?? 'unknown' }), task.works.at(-1)!)
      if (session) {
        if (entry.session_id && entry.session_id !== session)
          throw Error('work_session_conflict')
        entry.session_id = session
        if (!task.primary_session_id || !task.session_ids.includes(task.primary_session_id))
          task.primary_session_id = session
      }
    })
  }
  reviseGoal(requestId: string, fence: TaskFence, actor: TaskActor, goal: string, acceptance: string[]): Promise<TaskRecord> {
    const parsed = goalChangeSchema.parse({ fence, actor, goal, acceptance })
    return this.#change(requestId, parsed, task => {
      if (task.phase === 'completed' || task.phase === 'cancelled')
        throw Error('task_terminal')
      if (!sameGoal(task, parsed.goal, parsed.acceptance)) {
        task.goal = parsed.goal
        task.acceptance = parsed.acceptance
        task.goal_revision++
      }
    })
  }
  setRoute(fence: TaskFence, route: string): Promise<void> {
    return this.#mutate(next => {
      this.assertWritable(fence, { kind: 'nova' })
      next.tasks.find(task => task.id === fence.task_id)!.execution_route = id.parse(route)
    })
  }
  evidence(taskId: string): TaskEvidence[] {
    this.get(taskId)
    return structuredClone(this.#state.outcomes.filter(item => item.task_id === taskId))
  }
  assertExecutionAllowed(taskId: string, actor?: TaskActor): void {
    this.get(taskId)
    this.admitExecution(taskId)
    if (this.hasUnknownWork(taskId))
      throw Error('task_effect_unknown')
    if (actor?.kind === 'nova' && this.pendingUserInputs(taskId).length)
      throw Error('task_input_reconciliation_required')
  }
  hasUnknownWork(taskId: string): boolean {
    return this.#state.outcomes.some(item => item.task_id === taskId && item.work_id && !['ok', 'failed', 'refused', 'cancelled'].includes(item.outcome))
  }
  acceptedUserInputs(taskId: string) {
    return this.inputReceipts(taskId).filter(receipt => receipt.status === 'accepted' && receipt.actor?.kind === 'user')
  }
  pendingUserInputs(taskId: string) {
    const task = this.get(taskId)
    return this.acceptedUserInputs(taskId).filter(receipt => !task.reconciled_inputs?.includes(receipt.request_id))
  }
  hasUnresolvedExecution(taskId: string): boolean {
    const task = this.get(taskId)
    return !!task.pending_delivery || this.pendingEffect(taskId) !== null || this.inputReceipts(taskId).some(receipt => receipt.status === 'unknown') || task.work_ids.some(work => !this.#state.outcomes.some(item => item.task_id === taskId && item.work_id === work && ['ok', 'failed', 'refused', 'cancelled'].includes(item.outcome)))
  }
  activeWork(taskId: string): string[] {
    return this.get(taskId).work_ids.filter(work => !this.#state.outcomes.some(item => item.task_id === taskId && item.work_id === work))
  }
  pendingEffect(taskId: string) {
    return structuredClone(Object.values(this.#state.pending_effects).find(item => item.task_id === taskId && (item.status === 'pending' || item.status === 'unknown')) ?? null)
  }
  async recordWorkOutcome(workId: string, outcome: string, content: unknown, refs: string[] = []): Promise<string | null> {
    return this.#mutate(next => {
      const task = next.tasks.find(task => task.work_ids.includes(workId))
      if (!task)
        return null
      const ref = 'task-work:' + workId, prior = next.outcomes.find(item => item.ref === ref)
      if (prior)
        return ref
      const workFence = next.work_fences[workId]
      if (!workFence)
        throw Error('work_fence_unavailable')
      const observed = next.events.filter(event => event.work_id === workId && event.task_id === task.id && event.kind === 'tool' && event.stage === 'completed')
      let bytes = 0
      const observations = observed.slice(-32).filter(event => { bytes += Buffer.byteLength(JSON.stringify(event)); return bytes <= 65536; })
      next.outcomes.push(evidenceSchema.parse({
        observations, observations_truncated: observations.length < observed.length || observations.some(event => event.text_truncated) || !!next.truncated[task.id] || this.#incompleteReplay.has(task.id) || next.replay_incomplete.includes(task.id), ref, task_id: task.id, goal_revision: workFence.goal_revision, kind: next.instruction_work_ids.includes(workId) ? 'input' : 'work', work_id: workId, outcome, content: JSON.stringify(content).slice(0, 131072), refs
      }))
      return ref
    })
  }
  recordDelivery(fence: TaskFence, deliveryId: string, text: string): Promise<void> {
    return this.#mutate(next => {
      this.assertWritable(fence, { kind: 'nova' })
      const task = next.tasks.find(task => task.id === fence.task_id)!
      task.execution_route ??= 'nova'
      const ref = 'task-delivery:' + id.parse(deliveryId)
      const prior = next.outcomes.find(item => item.ref === ref)
      if (prior) {
        if (prior.task_id !== fence.task_id || prior.content !== text)
          throw Error('evidence_conflict')
        return
      }
      next.outcomes.push(evidenceSchema.parse({
        ref, task_id: fence.task_id, goal_revision: fence.goal_revision, kind: 'delivery', outcome: 'delivered', content: text, refs: []
      }))
    })
  }
  continue(requestId: string, fence: TaskFence, actor: TaskActor): Promise<TaskRecord> {
    return this.#change(requestId, { fence, actor, operation: 'continue' }, task => {
      if (task.phase === 'cancelled' || task.phase === 'completed')
        throw Error('task_terminal')
      this.assertExecutionAllowed(task.id)
      task.controller = { kind: 'nova' }
      task.corrections = 0
      task.waiting_reason = null
      task.phase = task.work_ids.length ? 'verifying' : 'queued'
      task.control_revision++
    }, task => this.#assertDecider(task, fence, actor, true))
  }
  /** A user attests what happened to execution whose outcome Nova could not observe, so a waiting task can move on. */
  reconcile(requestId: string, fence: TaskFence, actor: TaskActor, resolution: 'done' | 'not_run'): Promise<TaskRecord> {
    const parsed = {
      fence: taskFenceSchema.parse(fence), actor: actorSchema.parse(actor), operation: 'reconcile', resolution: z.enum(['done', 'not_run']).parse(resolution)
    }
    return this.#change(requestId, parsed, (task, next) => {
      // Only durably uncertain execution is the user's to settle; a reserved or in-flight effect or send still reports its own result.
      if (Object.values(next.pending_effects).some(effect => effect.task_id === task.id && effect.status === 'pending') || [...this.#liveInputs].some(request => next.effects[request]?.task_id === task.id))
        throw Error('execution_in_flight')
      const done = parsed.resolution === 'done'
      let changed = false
      for (const item of next.outcomes)
        if (item.task_id === task.id && item.work_id && !['ok', 'failed', 'refused', 'cancelled'].includes(item.outcome)) {
          item.outcome = done ? 'ok' : 'cancelled'
          changed = true
        }
      for (const effect of Object.values(next.pending_effects))
        if (effect.task_id === task.id && effect.status === 'unknown') {
          effect.status = done ? 'accepted' : 'failed'
          changed = true;
          // A confirmed step becomes evidence, so the loop verifies it instead of dispatching it again.
          if (done)
            next.outcomes.push({
              observations: [], observations_truncated: false, ref: 'task-attested:' + effect.id, task_id: task.id, goal_revision: task.goal_revision, kind: 'work', outcome: 'ok', content: 'The user checked and confirmed this step ran, although Nova did not observe its result: ' + effect.instruction.slice(0, 4000), refs: []
            })
        }
      for (const receipt of Object.values(next.effects))
        if (receipt.task_id === task.id && receipt.status === 'unknown') {
          receipt.status = done ? 'accepted' : 'failed'
          changed = true
        }
      if (!changed)
        throw Error('nothing_to_reconcile')
      task.waiting_reason = 'user_reconciled'
      task.control_revision++
    }, task => {
      this.#assertDecider(task, parsed.fence, parsed.actor, true)
      if (parsed.actor.kind !== 'user')
        throw Error('not_controller')
    })
  }
  needsReconcile(taskId: string): boolean {
    const task = this.get(taskId)
    return task.phase === 'waiting' && (this.hasUnknownWork(taskId) || this.pendingEffect(taskId) !== null || this.inputReceipts(taskId).some(receipt => receipt.status === 'unknown'))
  }
  wait(fence: TaskFence, reason: string): Promise<TaskRecord> { return this.applyDecision(fence, { kind: 'wait', reason, evidence_refs: [] }); }
  applyDecision(fence: TaskFence, raw: TaskDecision): Promise<TaskRecord> {
    const decision = taskDecisionSchema.parse(raw)
    return this.#mutate(next => {
      this.assertWritable(fence, { kind: 'nova' })
      const task = next.tasks.find(task => task.id === fence.task_id)!
      if (decision.kind !== 'wait' && this.hasUnknownWork(task.id))
        throw Error('task_effect_unknown')
      if (task.pending_delivery && decision.kind !== 'wait')
        throw Error('task_delivery_pending')
      if (this.activeWork(task.id).length)
        throw Error('task_work_active')
      if (decision.kind === 'reconcile') {
        const pending = this.pendingUserInputs(task.id).map(receipt => receipt.request_id)
        if (!pending.length || hash(pending) !== hash(decision.input_refs))
          throw Error('task_input_reconciliation_stale')
        if (this.pendingEffect(task.id) || this.inputReceipts(task.id).some(receipt => receipt.status === 'unknown'))
          throw Error('task_effect_unknown')
        task.reconciled_inputs.push(...pending)
        task.control_revision++
        if (decision.goal_change && !sameGoal(task, decision.goal_change.goal, decision.goal_change.acceptance)) {
          task.goal = decision.goal_change.goal
          task.acceptance = decision.goal_change.acceptance
          task.goal_revision++
        }
        task.phase = 'verifying'
        task.waiting_reason = null
        next.events.push({ seq: ++next.event_seq, task_id: task.id, kind: 'control', text: JSON.stringify(decision), refs: [] })
        return structuredClone(task) as TaskRecord
      }
      if (decision.kind !== 'wait' && this.pendingUserInputs(task.id).length)
        throw Error('task_input_reconciliation_required')
      const evidence = this.evidence(task.id).filter(item => item.goal_revision === task.goal_revision && item.kind !== 'input')
      if (decision.evidence_refs.some(ref => !evidence.some(item => item.ref === ref)))
        throw Error('invalid_evidence')
      if (decision.kind === 'complete' && !decision.evidence_refs.length)
        throw Error('missing_evidence')
      if (decision.kind !== 'wait' && (this.pendingEffect(task.id) || this.inputReceipts(task.id).some(receipt => receipt.status === 'unknown')))
        throw Error('task_effect_unknown')
      if (decision.kind === 'complete' && decision.criteria) {
        if (decision.criteria.some(item => item.index >= task.acceptance.length || item.evidence_refs.some(ref => !evidence.some(entry => entry.ref === ref))))
          throw Error('invalid_evidence')
      }
      task.evidence_refs = decision.evidence_refs
      if (decision.kind === 'complete' && decision.criteria)
        task.criteria_evidence = decision.criteria.map(item => ({ index: item.index, evidence_refs: [...item.evidence_refs] }))
      if (decision.kind === 'complete') {
        task.phase = 'completed'
        task.waiting_reason = null
        task.todo_sync = task.todo_ref ? 'pending' : 'none'
      }
      else if (decision.kind === 'wait') {
        task.phase = 'waiting'
        task.waiting_reason = decision.reason
      }
      else if (task.corrections >= 3) {
        task.phase = 'waiting'
        task.waiting_reason = 'correction_limit'
      }
      else {
        task.corrections++
        task.phase = 'queued'
        task.waiting_reason = null
        const effectId = task.id + ':' + task.control_revision + ':' + task.goal_revision + ':' + task.corrections
        next.pending_effects[effectId] = {
          id: effectId, task_id: task.id, fence, instruction: decision.instruction, status: 'pending', write_started: false
        }
      }
      next.events.push({
        seq: ++next.event_seq, task_id: task.id, kind: 'verification', text: JSON.stringify(decision), refs: decision.evidence_refs
      })
      return structuredClone(task) as TaskRecord
    })
  }
  beginDelivery(fence: TaskFence, deliveryId: string): Promise<void> {
    return this.#mutate(next => {
      this.assertWritable(fence, { kind: 'nova' })
      const task = next.tasks.find(task => task.id === fence.task_id)!
      if (task.pending_delivery)
        throw Error('task_delivery_pending')
      task.pending_delivery = id.parse(deliveryId)
    })
  }
  finishDelivery(taskId: string, deliveryId: string): Promise<void> {
    return this.#mutate(next => {
      const task = next.tasks.find(task => task.id === taskId)
      if (task?.pending_delivery === deliveryId)
        delete task.pending_delivery
    })
  }
  reserveInitial(fence: TaskFence): Promise<string> {
    return this.#mutate(next => {
      this.assertWritable(fence, { kind: 'nova' })
      if (this.hasUnknownWork(fence.task_id) || this.pendingEffect(fence.task_id) || this.inputReceipts(fence.task_id).some(receipt => receipt.status === 'unknown'))
        throw Error('task_effect_unknown')
      if (this.pendingUserInputs(fence.task_id).length)
        throw Error('task_input_reconciliation_required')
      const task = next.tasks.find(task => task.id === fence.task_id)!, prefix = task.id + ':initial:' + task.control_revision + ':' + task.goal_revision, prior = Object.values(next.pending_effects).filter(effect => effect.id === prefix || effect.id.startsWith(prefix + ':'))
      if (prior.some(effect => effect.status !== 'failed'))
        throw Error('task_initial_pending')
      const effectId = prefix + ':' + prior.length
      next.pending_effects[effectId] = { id: effectId, task_id: task.id, fence, instruction: task.goal, status: 'pending', write_started: false }
      return effectId
    })
  }
  markEffectDispatching(effectId: string): Promise<void> {
    return this.#mutate(next => {
      const effect = next.pending_effects[effectId]
      if (effect?.status !== 'pending')
        throw Error('effect_not_pending')
      this.assertWritable(effect.fence, { kind: 'nova' })
      this.assertExecutionAllowed(effect.task_id)
      if (this.pendingUserInputs(effect.task_id).length)
        throw Error('task_input_reconciliation_required')
      effect.write_started = true
    })
  }
  recoveryWait(taskId: string, reason: string | null): Promise<void> {
    return this.#mutate(next => {
      const task = next.tasks.find(task => task.id === taskId)
      if (!task)
        throw Error('task_not_found')
      if (task.phase === 'completed' || task.phase === 'cancelled')
        return
      task.waiting_reason = reason
      if (reason)
        task.phase = 'waiting'
      else if (task.phase === 'waiting')
        task.phase = task.work_ids.length ? 'verifying' : 'queued'
    })
  }
  resourceState(taskId: string, reason: string | null): Promise<void> {
    return this.#mutate(next => {
      const task = next.tasks.find(task => task.id === taskId)
      if (!task || task.phase === 'completed' || task.phase === 'cancelled')
        return
      task.waiting_reason = reason
      task.phase = reason ? 'waiting' : 'running'
    })
  }
  settleEffect(effectId: string, status: 'accepted' | 'failed' | 'unknown'): Promise<void> {
    return this.#mutate(next => {
      const effect = next.pending_effects[effectId]
      if (!effect)
        throw Error('effect_not_found')
      if (effect.status === 'pending')
        effect.status = status
    })
  }
  markTodoSync(taskId: string, goalRevision: number, status: 'synced' | 'conflict'): Promise<void> {
    return this.#mutate(next => {
      const task = next.tasks.find(task => task.id === taskId)
      if (task?.phase !== 'completed' || task.goal_revision !== goalRevision)
        throw Error('stale_task')
      task.todo_sync = status
    })
  }
  #change(requestId: string, parsed: {
    fence: TaskFence
    actor: TaskActor
  } & Record<string, unknown>, change: (task: StoredTask, next: TaskState) => void, authorize?: (task: StoredTask) => void): Promise<TaskRecord> {
    const request = id.parse(requestId), body = hash(parsed)
    return this.#mutate(next => {
      const prior = next.receipts[request]
      if (prior) {
        if (prior.hash !== body)
          throw Error('request_conflict')
        if (!prior.result)
          throw Error('task_retired')
        return structuredClone(prior.result) as TaskRecord
      }
      const task = next.tasks.find(item => item.id === parsed.fence.task_id)
      if (!task)
        throw Error('task_not_found')
      if (authorize)
        authorize(task)
      else
        this.#assert(task, parsed.fence, parsed.actor)
      change(task, next)
      next.events.push({
        seq: ++next.event_seq, task_id: task.id, kind: 'control', text: JSON.stringify({
          operation: parsed.operation ?? parsed.action ?? ('nextActor' in parsed ? 'controller_changed' : 'goal_revised'), ...(parsed.resolution ? { resolution: parsed.resolution } : {}), controller: task.controller, control_revision: task.control_revision, goal_revision: task.goal_revision
        }), refs: []
      })
      const result = structuredClone(task)
      next.receipts[request] = { hash: body, task_id: task.id, result }
      return result as TaskRecord
    })
  }
  /** The controller may always decide; a user may also stop, or unblock a waiting task, while Nova holds control. */
  #assertDecider(task: StoredTask, fence: TaskFence, actor: TaskActor, waitingOnly: boolean): void {
    this.#assertFence(task, fence)
    if (JSON.stringify(task.controller) === JSON.stringify(actor))
      return
    if (actor.kind === 'user' && task.controller.kind === 'nova' && (!waitingOnly || task.phase === 'waiting'))
      return
    throw Error('not_controller')
  }
  #assert(task: StoredTask, fence: TaskFence, actor: TaskActor): void {
    this.#assertFence(task, fence)
    if (JSON.stringify(task.controller) !== JSON.stringify(actor))
      throw Error('not_controller')
  }
  #assertFence(task: StoredTask, fence: TaskFence): void {
    if (task.control_revision !== fence.control_revision || task.goal_revision !== fence.goal_revision)
      throw Error('stale_task')
  }
  /**
   * Finished tasks beyond the newest RETAINED_FINISHED_TASKS leave the store with everything keyed to them, and so do the oldest
   * ones while the store is above PRUNE_ABOVE_BYTES, down to PRUNE_TO_BYTES; unresolved ones stay.
   */
  #pruneRetired(next: TaskState): void {
    const unresolved = (taskId: string) => Object.values(next.pending_effects).some(effect => effect.task_id === taskId && (effect.status === 'pending' || effect.status === 'unknown')) || Object.values(next.effects).some(effect => effect.task_id === taskId && effect.status === 'unknown')
    const finished = next.tasks.filter(task => (task.phase === 'completed' || task.phase === 'cancelled') && !task.pending_delivery && !task.waiting_reason && !unresolved(task.id))
    const last = new Map<string, number>()
    for (const event of next.events)
      last.set(event.task_id, event.seq)
    const oldest = finished.map((task, order) => ({ id: task.id, rank: last.get(task.id) ?? order })).sort((a, b) => a.rank - b.rank).map(task => task.id)
    const retired = new Set(oldest.slice(0, Math.max(0, oldest.length - RETAINED_FINISHED_TASKS)))
    let size = Buffer.byteLength(JSON.stringify(next))
    if (size > PRUNE_ABOVE_BYTES) {
      // Large results can fill the store long before the count cap, so retire by footprint too.
      const footprint = new Map<string, number>(oldest.map(taskId => [taskId, 0]))
      const add = (taskId: string | undefined, value: unknown) => { if (taskId && footprint.has(taskId)) footprint.set(taskId, footprint.get(taskId)! + Buffer.byteLength(JSON.stringify(value ?? null))) }
      for (const task of next.tasks)
        add(task.id, task)
      for (const event of next.events)
        add(event.task_id, event)
      for (const outcome of next.outcomes)
        add(outcome.task_id, outcome)
      for (const receipt of Object.values(next.receipts))
        add(receipt.task_id, receipt.result)
      for (const effect of Object.values(next.effects))
        add(effect.task_id, effect)
      for (const taskId of retired)
        size -= footprint.get(taskId)!
      for (const taskId of oldest) {
        if (size <= PRUNE_TO_BYTES)
          break
        if (!retired.has(taskId)) {
          retired.add(taskId)
          size -= footprint.get(taskId)!
        }
      }
    }
    if (retired.size) {
      const works = new Set(next.tasks.filter(task => retired.has(task.id)).flatMap(task => task.work_ids))
      next.tasks = next.tasks.filter(task => !retired.has(task.id))
      next.events = next.events.filter(event => !retired.has(event.task_id))
      next.outcomes = next.outcomes.filter(outcome => !retired.has(outcome.task_id))
      next.instruction_work_ids = next.instruction_work_ids.filter(work => !works.has(work))
      next.replay_incomplete = next.replay_incomplete.filter(taskId => !retired.has(taskId))
      // A retired task's receipts become tombstones, so replaying its request cannot start the work again.
      for (const value of Object.values(next.receipts))
        if (retired.has(value.task_id))
          delete value.result
      for (const [key, value] of Object.entries(next.effects))
        if (value.task_id && retired.has(value.task_id))
          delete next.effects[key]
      for (const [key, value] of Object.entries(next.pending_effects))
        if (retired.has(value.task_id))
          delete next.pending_effects[key]
      for (const [key, value] of Object.entries(next.work_fences))
        if (retired.has(value.task_id) || works.has(key))
          delete next.work_fences[key]
      for (const [key, value] of Object.entries(next.event_keys))
        if (value.task_id && retired.has(value.task_id))
          delete next.event_keys[key]
      for (const taskId of retired)
        delete next.truncated[taskId]
    }
    const tombstones = Object.entries(next.receipts).filter(([, receipt]) => !receipt.result).map(([key]) => key)
    for (const key of tombstones.slice(0, Math.max(0, tombstones.length - RETAINED_TOMBSTONES)))
      delete next.receipts[key]
    const handbacks = Object.keys(next.handbacks)
    for (const key of handbacks.slice(0, Math.max(0, handbacks.length - RETAINED_HANDBACKS)))
      delete next.handbacks[key]
  }
  #pruneDisplay(next: TaskState): void {
    // ponytail: bounded linear retention; move display history to indexed storage if task volume grows.
    const counts = new Map<string, number>(), bytes = new Map<string, number>()
    let total = 0
    const eligible = (event: TaskState['events'][number]) => event.kind !== 'control' && event.kind !== 'verification'
    for (const event of next.events)
      if (eligible(event)) {
        const size = Buffer.byteLength(JSON.stringify(event))
        counts.set(event.task_id, (counts.get(event.task_id) ?? 0) + 1)
        bytes.set(event.task_id, (bytes.get(event.task_id) ?? 0) + size)
        total += size
      }
    const budget = Math.max(0, Math.min(4 * 1024 * 1024, 16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(next)) + total - 4096))
    next.events = next.events.filter(event => {
      if (!eligible(event) || ((counts.get(event.task_id) ?? 0) <= 1000 && (bytes.get(event.task_id) ?? 0) <= 1024 * 1024 && total <= budget))
        return true
      const size = Buffer.byteLength(JSON.stringify(event))
      counts.set(event.task_id, counts.get(event.task_id)! - 1)
      bytes.set(event.task_id, bytes.get(event.task_id)! - size)
      total -= size
      next.truncated[event.task_id] = Math.max(next.truncated[event.task_id] ?? 0, event.seq)
      return false
    })
  }
  #mutate<T>(change: (next: TaskState) => Promise<T> | T): Promise<T> {
    const run = this.#tail.then(async () => {
      const next = structuredClone(this.#state), result = await change(next)
      for (const taskId of this.#incompleteReplay)
        if (!next.replay_incomplete.includes(taskId))
          next.replay_incomplete.push(taskId)
      this.#pruneRetired(next)
      this.#pruneDisplay(next)
      await this.#store.write(next)
      this.#state = next
      this.changed()
      return result
    })
    this.#tail = run.catch(() => { /* keep mutation queue available */ })
    return run
  }
}
