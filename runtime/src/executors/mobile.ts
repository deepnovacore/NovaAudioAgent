import {randomUUID} from 'node:crypto'
import {mkdir} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {z} from 'zod'
import {executorManifestSchema} from '../core/ports.js'
import type {ExecutorAdapter, ExecutorDispatchContext, ExecutorHandoff} from '../core/causal-runtime.js'
import type {HostApprovalController} from '../core/approval.js'
import type {AgentController, AgentRuntimeDispatchPort} from './agent-controller.js'
import {acquireDeviceLock, releaseDeviceLock} from './device-lock.js'
import type {MobileIosConfig, runMobileIos} from './mobile-ios.js'

const instructionSchema = z.string().trim().min(1).max(4000)
const requestSchema = z.object({instruction: instructionSchema, run_id: z.string().uuid()}).strict()
const resultSchema = z.object({code: z.enum(['model_finished', 'declined', 'cancelled', 'timeout', 'step_limit',
  'action_failed', 'model_failed', 'screen_changed', 'needs_user_action', 'invalid_configuration', 'cleanup_unknown']),
  steps: z.number().int().min(0).max(100)}).strict()
export const MOBILE_DESCRIPTOR = Object.freeze({name: 'mobile', summary:
  'Operates the configured phone under user supervision. Every device action needs confirmation. Screenshots go to the configured model service.',
  ownedChannels: Object.freeze(['mobile'])})

export function loadMobileConfig(env: NodeJS.ProcessEnv): MobileIosConfig {
  const values = {
    ENGINE: env.MOBILE_ENGINE,
    DEVICE_TYPE: env.MOBILE_DEVICE_TYPE,
    DEVICE_ID: env.MOBILE_DEVICE_ID,
    BASE_URL: env.MOBILE_BASE_URL,
    WDA_URL: env.MOBILE_WDA_URL,
    MODEL: env.MOBILE_MODEL,
    MODEL_FAMILY: env.MOBILE_MODEL_FAMILY,
    API_KEY: env.MOBILE_API_KEY,
    MAX_STEPS: env.MOBILE_MAX_STEPS,
    TIMEOUT_SECONDS: env.MOBILE_TIMEOUT_SECONDS,
    SETTLE_MS: env.MOBILE_SETTLE_MS,
  }
  const required = (name: keyof typeof values, fallback?: string, max = 4096): string => {
    const value = (values[name] ?? fallback)?.trim()
    if (!value || value.length > max || /[\x00-\x1f]/u.test(value)) throw new Error(`invalid_mobile_configuration:${name}`)
    return value
  }
  const integer = (name: keyof typeof values, fallback: number, max: number, min = 1): number => {
    const value = Number(values[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid_mobile_configuration:${name}`)
    return value
  }
  if (required('ENGINE', 'midscene') !== 'midscene') throw new Error('invalid_mobile_engine')
  const deviceType = required('DEVICE_TYPE', 'ios')
  if (deviceType !== 'ios' && deviceType !== 'ios-simulator' && deviceType !== 'android') throw new Error('invalid_mobile_device_type')
  const deviceId = required('DEVICE_ID', undefined, 128)
  if (!/^[A-Za-z0-9_.:\-]+$/u.test(deviceId)) throw new Error('invalid_mobile_device')
  const baseUrl = required('BASE_URL', undefined, 2048)
  const wdaUrl = required('WDA_URL', 'http://127.0.0.1:8100', 2048)
  for (const value of [baseUrl, wdaUrl]) {
    const url = new URL(value)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error('invalid_mobile_endpoint')
    if (value === wdaUrl && deviceType === 'ios-simulator' && (!local || url.protocol !== 'http:' || url.pathname !== '/')) throw new Error('invalid_mobile_wda_endpoint')
  }
  return {deviceId, deviceType, wdaUrl, baseUrl, model: required('MODEL', undefined, 200),
    modelFamily: required('MODEL_FAMILY', undefined, 200), apiKey: required('API_KEY'),
    maxSteps: integer('MAX_STEPS', 30, 100), budgetMs: integer('TIMEOUT_SECONDS', 600, 1800) * 1000,
    settleMs: integer('SETTLE_MS', 4000, 30000, 0),
    // Share the existing phone quarantine across engines; changing engines must not bypass ownership.
    lockRoot: join(homedir(), '.nova-audio-agent', 'autoglm-devices')}
}

function handoff(code: string, outcome: ExecutorHandoff['outcome'], extra: Record<string, string | number> = {}): ExecutorHandoff {
  return {outcome, trust: 'untrusted_external', content: {code, verified: false, effects: 'unknown', ...extra}}
}

export class MobileExecutor implements ExecutorAdapter {
  readonly descriptor = MOBILE_DESCRIPTOR
  readonly manifest
  #reservation: string | null = null
  #active: {abort: AbortController; done: Promise<ExecutorHandoff>} | null = null
  #closed = false
  constructor(readonly config: MobileIosConfig, readonly approvals: HostApprovalController,
    readonly runner: typeof runMobileIos = async (...args) => (await import('./mobile-ios.js')).runMobileIos(...args)) {
    this.manifest = executorManifestSchema.parse({name: 'mobile', display_name: '手机助手', roles: [], approvals: true,
      model_visibility: 'hidden', probe_policy: 'none', ops: [{name: 'run', description: 'Run a supervised phone task.',
        params: {type: 'object', properties: {instruction: {type: 'string', minLength: 1, maxLength: 4000}, run_id: {type: 'string'}},
          required: ['instruction', 'run_id'], additionalProperties: false}, readonly: false, confirm: false,
        deadline_budget: config.budgetMs / 1000 + 5, verifies: [], sensitive_params: ['instruction'], sync_result: false}],
      policy: {channel: 'mobile', priority: 50, wake: 'surrogate', typical_latency: 10, compress_watermark: 8000, progress_via_surrogate: true}})
  }

  controller(port: AgentRuntimeDispatchPort): AgentController {
    let delegateId: string | null = null
    return {descriptor: MOBILE_DESCRIPTOR, dispatch: async request => {
      if (!request.stillWanted()) return {code: 'superseded', accepted: false, detail: {}}
      if (this.#closed) return {code: 'runtime_rejected', accepted: false, detail: {}}
      if (this.#reservation !== null) return {code: 'busy', accepted: true, detail: {}}
      const instruction = instructionSchema.safeParse(request.instruction)
      if (!instruction.success) return {code: 'clarification_required', accepted: true, detail: {}}
      const runId = randomUUID()
      this.#reservation = runId
      try {
        const admitted = await port.dispatch({channel: 'mobile', op: 'run', request: {instruction: instruction.data, run_id: runId},
          origin_ref: request.origin_ref, stillWanted: () => {
            const wanted = this.#reservation === runId && !this.#closed && request.stillWanted()
            if (!wanted && this.#reservation === runId && this.#active === null) this.#reservation = null
            return wanted
          }})
        if (!admitted.accepted || admitted.delegate_id === null) {
          if (this.#reservation === runId) this.#reservation = null
          return {code: 'runtime_rejected', accepted: false, detail: {}}
        }
        delegateId = admitted.delegate_id
        return {code: 'delegated', accepted: true, delegate_id: delegateId, detail: {channel: 'mobile', op: 'run'}}
      } catch {
        if (this.#reservation === runId) this.#reservation = null
        return {code: 'runtime_rejected', accepted: false, detail: {}}
      }
    }, cancel: async request => {
      if (!request.stillWanted()) return {code: 'superseded', accepted: false, detail: {}}
      if (this.#reservation === null) return {code: 'not_running', accepted: true, detail: {}}
      if (delegateId !== null) port.cancelPendingDispatch?.(delegateId)
      this.#active?.abort.abort()
      await this.#active?.done
      if (this.#active === null) this.#reservation = null
      delegateId = null
      return {code: 'accepted', accepted: true, detail: {}}
    }}
  }

  admitRequest(op: string, request: Readonly<Record<string, unknown>>) {
    const parsed = requestSchema.safeParse(request)
    return op === 'run' && parsed.success && parsed.data.run_id === this.#reservation && !this.#closed
      ? {ok: true as const, request: parsed.data, sync_result: false} : {ok: false as const}
  }

  async dispatch(op: string, request: Readonly<Record<string, unknown>>, context: ExecutorDispatchContext): Promise<ExecutorHandoff> {
    const admission = this.admitRequest(op, request)
    if (!admission.ok || this.#active !== null) return handoff('invalid_request', 'refused')
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, context.signal])
    const done = this.#run(admission.request.instruction, admission.request.run_id, context, signal)
      .catch(() => handoff('runner_failed', 'unknown'))
    this.#active = {abort, done}
    try { return await done } finally { this.#active = null; this.#reservation = null }
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#active?.abort.abort()
    await this.#active?.done
    this.#reservation = null
  }

  async #run(instruction: string, taskId: string, context: ExecutorDispatchContext, cancelled: AbortSignal): Promise<ExecutorHandoff> {
    if (cancelled.aborted) return handoff('cancelled', 'cancelled')
    const budgetMs = Math.floor(Math.min(this.config.budgetMs, Math.max(0, ((context.delegate.deadline ?? Infinity) - context.clock.now()) * 1000)))
    if (budgetMs <= 0) return handoff('timeout', 'unknown')
    const deadline = AbortSignal.timeout(budgetMs)
    const signal = AbortSignal.any([cancelled, deadline])
    await mkdir(this.config.lockRoot, {recursive: true, mode: 0o700})
    const acquired = await acquireDeviceLock(this.config.lockRoot, this.config.deviceType, this.config.deviceId, taskId)
    if (!acquired.ok) return handoff(acquired.reason, 'refused')
    const approval = this.approvals.forWork({work_id: taskId, project: this.config.deviceType === 'android' ? 'Android' : 'iOS', title: '手机任务'})
    const observed: Record<string, string | number> = {}
    let activity = 0
    let quarantined = false
    try {
      let result: ExecutorHandoff
      try {
        signal.throwIfAborted()
        const returned = resultSchema.parse(await this.runner({...this.config, budgetMs}, instruction, {signal,
          approve: async (actionName, params) => {
            if (signal.aborted || !/^[A-Za-z][A-Za-z _-]{0,39}$/u.test(actionName)) return false
            const scope = `${actionName}: ${JSON.stringify(params)}`
            if (scope.length > 1024) return false
            const resolution = await approval.offer({kind: 'permissions', local_detail: {kind: 'permissions', scope},
              operation_summary: `手机操作：${actionName}`, allowed_decisions: ['accept', 'decline'],
              executorIdentity: {executor: 'mobile', display_name: '手机助手'}}, signal)
            const decision = resolution === null ? 'decline' : approval.consume(resolution)
            return !signal.aborted && decision === 'accept'
          },
          progress: event => {
            if (event?.phase === 'action_returned') {
              observed.last_returned_step = event.steps
              if (event.actionName !== undefined) observed.last_action = event.actionName
            }
            if (signal.aborted) return
            const summary = event?.phase === 'planning' ? '正在观察屏幕并规划下一步'
              : event?.phase === 'action_pending' ? '等待批准'
              : event?.phase === 'action_returned' ? '动作已返回，等待下一次观察'
              : event?.phase === 'model_finished' ? '模型已结束，结果尚未验证' : '正在执行手机任务'
            context.progress({phase: 'working', internal_activity: ++activity,
              elapsed: Math.max(0, context.clock.now() - context.delegate.dispatched_at), summary})
          }}))
        quarantined = returned.code === 'cleanup_unknown'
        const outcome = returned.code === 'model_finished' ? 'ok'
          : returned.code === 'cancelled' ? 'cancelled'
          : ['timeout', 'cleanup_unknown'].includes(returned.code) ? 'unknown'
          : ['declined', 'screen_changed', 'needs_user_action', 'invalid_configuration'].includes(returned.code) ? 'refused' : 'failed'
        result = handoff(returned.code, outcome, {steps: returned.steps, ...observed})
      } catch { result = handoff('runner_failed', 'unknown', observed) }
      if (quarantined) return {...result, content: {...result.content, cleanup_required: true,
        ...(cancelled.aborted ? {cancel_requested: true} : {})}}
      if (cancelled.aborted) return handoff('cancelled', 'cancelled', observed)
      if (deadline.aborted) return handoff('timeout', 'unknown', observed)
      return result
    } finally {
      // Do not race the runner against abort: even cancellation retains ownership through cleanup.
      approval.invalidate('mobile_finished')
      // A timed-out device write can outlive the host request; retain quarantine for manual recovery.
      if (!quarantined) await releaseDeviceLock(acquired.lock)
    }
  }
}
