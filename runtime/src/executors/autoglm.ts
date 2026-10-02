/** Optional, supervised phone executor. Device identity and credentials stay host-owned. */
import {spawn} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {access, mkdir, realpath, rmdir, unlink, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {isAbsolute, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {z} from 'zod'
import {executorManifestSchema} from '../core/ports.js'
import type {ExecutorAdapter, ExecutorDispatchContext, ExecutorHandoff} from '../core/causal-runtime.js'
import type {HostApprovalController, ApprovalPort} from '../core/approval.js'
import type {AgentController, AgentRuntimeDispatchPort} from './agent-controller.js'

const instructionSchema = z.string().trim().min(1).max(4000)
const requestSchema = z.object({instruction: instructionSchema, run_id: z.string().uuid()}).strict()
const identifier = z.string().min(1).max(128)
const actionNames = ['Launch', 'Tap', 'Type', 'Type_Name', 'Swipe', 'Back', 'Home', 'Double Tap', 'Long Press'] as const
const terminalCodes = ['model_finished', 'model_failed', 'action_failed', 'step_limit', 'timeout', 'declined',
  'screen_changed', 'needs_user_action', 'invalid_configuration', 'protocol_error'] as const
const envelope = {version: z.literal(1), taskId: identifier}
const messageSchema = z.discriminatedUnion('type', [
  z.object({...envelope, type: z.literal('ready'), upstreamCommit: z.string().regex(/^[a-f0-9]{40}$/u)}).strict(),
  z.object({...envelope, type: z.literal('progress'), step: z.number().int().nonnegative(),
    phase: z.enum(['model', 'action', 'action_returned']), lastAction: z.string().max(40).optional()}).strict(),
  z.object({...envelope, type: z.literal('approval'), requestId: identifier, step: z.number().int().positive(),
    action: z.object({_metadata: z.literal('do'), action: z.enum(actionNames)}).catchall(z.unknown()),
    screenDigest: z.string().regex(/^[a-f0-9]{64}$/u), packageName: z.string().min(1).max(256)}).strict(),
  z.object({...envelope, type: z.literal('terminal'), code: z.enum(terminalCodes), steps: z.number().int().nonnegative(),
    message: z.string().max(2048).optional(), lastAction: z.string().max(40).optional()}).strict(),
])

export const AUTOGLM_DESCRIPTOR = Object.freeze({name: 'autoglm',
  summary: 'Operates the configured phone (iOS by default) under user supervision. Every device action needs confirmation. Screenshots go to the configured model service.',
  ownedChannels: Object.freeze(['autoglm'])})

export interface AutoGlmConfig {
  readonly python: string
  readonly sourcePath: string
  readonly deviceId: string
  readonly deviceType: 'ios' | 'ios-simulator' | 'android'
  readonly wdaUrl?: string
  readonly baseUrl: string
  readonly model: string
  readonly apiKey: string
  readonly maxSteps: number
  readonly budgetMs: number
  readonly lockRoot: string
}

/** Called only when `autoglm` is explicitly selected; no automatic install or device selection. */
export function loadAutoGlmConfig(env: NodeJS.ProcessEnv): AutoGlmConfig {
  const required = (key: string, limit = 4096): string => {
    const value = env[key]?.trim()
    if (!value || value.length > limit || /[\x00-\x1f]/u.test(value)) throw new Error(`invalid_autoglm_configuration:${key}`)
    return value
  }
  const integer = (key: string, fallback: number, max: number): number => {
    const value = env[key] === undefined ? fallback : Number(env[key])
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`invalid_autoglm_configuration:${key}`)
    return value
  }
  const python = required('AUTOGLM_PYTHON')
  const sourcePath = required('AUTOGLM_SOURCE_PATH')
  if (!isAbsolute(python) || !isAbsolute(sourcePath)) throw new Error('invalid_autoglm_paths')
  const baseUrl = required('AUTOGLM_BASE_URL', 2048)
  const url = new URL(baseUrl)
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('invalid_autoglm_endpoint')
  const deviceType = env.AUTOGLM_DEVICE_TYPE ?? 'ios'
  if (deviceType !== 'ios' && deviceType !== 'ios-simulator' && deviceType !== 'android') throw new Error('invalid_autoglm_device_type')
  const wdaUrl = deviceType !== 'android' ? (env.AUTOGLM_WDA_URL ?? 'http://127.0.0.1:8100') : undefined
  if (wdaUrl !== undefined) {
    const wda = new URL(wdaUrl)
    if (deviceType === 'ios-simulator' && (wda.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(wda.hostname) || wda.pathname !== '/')) throw new Error('invalid_autoglm_wda_endpoint')
    if (wda.username || wda.password || wda.hash || wda.search || (wda.protocol !== 'https:'
      && !(wda.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(wda.hostname)))) throw new Error('invalid_autoglm_wda_endpoint')
  }
  const deviceId = required('AUTOGLM_DEVICE_ID')
  if (deviceId.length > 128 || !/^[A-Za-z0-9_.:\-]+$/u.test(deviceId)) throw new Error('invalid_autoglm_device')
  return {python, sourcePath, deviceId, deviceType, ...(wdaUrl === undefined ? {} : {wdaUrl}), baseUrl, model: required('AUTOGLM_MODEL', 200),
    apiKey: required('AUTOGLM_API_KEY'),
    maxSteps: integer('AUTOGLM_MAX_STEPS', 30, 100),
    budgetMs: integer('AUTOGLM_TIMEOUT_SECONDS', 600, 1800) * 1000,
    lockRoot: join(homedir(), '.nova-audio-agent', 'autoglm-devices')}
}

function handoff(code: string, outcome: ExecutorHandoff['outcome'], extra: Record<string, string | number> = {}): ExecutorHandoff {
  return {outcome, trust: 'untrusted_external', content: {code, verified: false, effects: 'unknown', ...extra}}
}

export class AutoGlmExecutor implements ExecutorAdapter {
  readonly descriptor = AUTOGLM_DESCRIPTOR
  readonly manifest
  #reservation: string | null = null
  #active: {abort: AbortController; done: Promise<ExecutorHandoff>} | null = null
  #closed = false
  constructor(readonly config: AutoGlmConfig, readonly approvals: HostApprovalController,
    readonly bridgePath = fileURLToPath(new URL('../../../scripts/autoglm-bridge.py', import.meta.url))
      .replace(/([/\\])app\.asar([/\\])/u, '$1app.asar.unpacked$2')) {
    this.manifest = executorManifestSchema.parse({name: 'autoglm', display_name: 'AutoGLM', roles: [], approvals: true,
      model_visibility: 'hidden', probe_policy: 'none', ops: [{name: 'run', description: 'Run a supervised phone task.',
        params: {type: 'object', properties: {instruction: {type: 'string', minLength: 1, maxLength: 4000}, run_id: {type: 'string'}},
          required: ['instruction', 'run_id'], additionalProperties: false}, readonly: false, confirm: false,
        deadline_budget: config.budgetMs / 1000 + 5, verifies: [], sensitive_params: ['instruction'], sync_result: false}],
      policy: {channel: 'autoglm', priority: 50, wake: 'surrogate', typical_latency: 10, compress_watermark: 8000, progress_via_surrogate: true}})
  }

  controller(port: AgentRuntimeDispatchPort): AgentController {
    let delegateId: string | null = null
    return {descriptor: AUTOGLM_DESCRIPTOR, dispatch: async request => {
      if (!request.stillWanted()) return {code: 'superseded', accepted: false, detail: {}}
      if (this.#closed) return {code: 'runtime_rejected', accepted: false, detail: {}}
      if (this.#reservation !== null) return {code: 'busy', accepted: true, detail: {}}
      const instruction = instructionSchema.safeParse(request.instruction)
      if (!instruction.success) return {code: 'clarification_required', accepted: true, detail: {}}
      const runId = randomUUID()
      this.#reservation = runId
      try {
        const admission = await port.dispatch({channel: 'autoglm', op: 'run',
          request: {instruction: instruction.data, run_id: runId}, origin_ref: request.origin_ref,
          stillWanted: () => {
            const wanted = this.#reservation === runId && !this.#closed && request.stillWanted()
            if (!wanted && this.#reservation === runId && this.#active === null) this.#reservation = null
            return wanted
          }})
        if (!admission.accepted || admission.delegate_id === null) {
          if (this.#reservation === runId) this.#reservation = null
          return {code: 'runtime_rejected', accepted: false, detail: {}}
        }
        delegateId = admission.delegate_id
        return {code: 'delegated', accepted: true, delegate_id: delegateId, detail: {channel: 'autoglm', op: 'run'}}
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
    const abortFromRuntime = () => abort.abort()
    context.signal.addEventListener('abort', abortFromRuntime, {once: true})
    if (context.signal.aborted) abort.abort()
    const done = this.#run(admission.request.instruction, admission.request.run_id, context, abort.signal)
      .catch(() => handoff('bridge_failed', 'unknown'))
    this.#active = {abort, done}
    try { return await done } finally {
      context.signal.removeEventListener('abort', abortFromRuntime)
      this.#active = null
      this.#reservation = null
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#active?.abort.abort()
    await this.#active?.done
    this.#reservation = null
  }

  async #run(instruction: string, taskId: string, context: ExecutorDispatchContext, cancelled: AbortSignal): Promise<ExecutorHandoff> {
    if (process.platform === 'win32') return handoff('unsupported_host', 'refused')
    if (cancelled.aborted) return handoff('cancelled', 'cancelled')
    const {config} = this
    const budgetMs = Math.min(config.budgetMs, Math.max(0, ((context.delegate.deadline ?? Infinity) - context.clock.now()) * 1000))
    if (budgetMs <= 0) return handoff('timeout', 'unknown')
    const deadlineSignal = AbortSignal.timeout(Math.floor(budgetMs))
    const processStop = new AbortController()
    const signal = AbortSignal.any([cancelled, deadlineSignal, processStop.signal])
    // Keep the venv executable path: resolving its symlink launches the base interpreter.
    await access(config.python)
    const python = config.python
    const sourcePath = await realpath(config.sourcePath)
    await access(this.bridgePath)
    await mkdir(config.lockRoot, {recursive: true, mode: 0o700})
    const lock = join(config.lockRoot, createHash('sha256').update(`${config.deviceType}:${config.deviceId}`).digest('hex'))
    try { await mkdir(lock, {mode: 0o700}) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return handoff('device_busy', 'refused')
      return handoff('device_lock_failed', 'refused')
    }
    // ponytail: crash leaves a quarantine directory; manual recovery after checking the device/processes.
    let treeGone = true
    const approval = this.approvals.forWork({work_id: taskId, project: config.deviceType === 'android' ? 'Android' : 'iOS', title: 'AutoGLM 手机任务'})
    let result = handoff('bridge_eof', 'unknown')
    const observation: Record<string, string | number> = {}
    try {
      await writeFile(join(lock, 'owner.json'), JSON.stringify({taskId, hostPid: process.pid}), {mode: 0o600, flag: 'wx'})
      if (signal.aborted) return handoff(cancelled.aborted ? 'cancelled' : 'timeout', cancelled.aborted ? 'cancelled' : 'unknown')
      const child = spawn(python, [this.bridgePath], {shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1',
          ...(config.deviceType === 'ios-simulator' && process.env.DEVELOPER_DIR ? {DEVELOPER_DIR: process.env.DEVELOPER_DIR} : {}),
          PYTHONDONTWRITEBYTECODE: '1', AUTOGLM_API_KEY: config.apiKey, AUTOGLM_SOURCE_PATH: sourcePath}})
      treeGone = child.pid === undefined
      let waitingForApproval = false, exited = false
      child.once('exit', () => {
        exited = true
        if (waitingForApproval) processStop.abort()
      })
      child.once('error', () => { exited = true; processStop.abort() })
      const exit = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()) })
      child.stdin.on('error', () => { child.stdout.destroy(new Error('bridge_input_failed')) })
      child.stderr.on('data', () => { /* Drain and discard upstream logs, including input text. */ })
      const terminate = () => {
        approval.invalidate('autoglm_stopped')
        if (child.pid !== undefined) try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
        child.stdout.destroy(new Error('bridge_stopped'))
      }
      signal.addEventListener('abort', terminate, {once: true})
      try {
        if (signal.aborted) terminate()
        else {
          child.stdin.write(`${JSON.stringify({version: 1, type: 'start', taskId, instruction, deviceId: config.deviceId,
            deviceType: config.deviceType, ...(config.wdaUrl === undefined ? {} : {wdaUrl: config.wdaUrl}),
            maxSteps: config.maxSteps, budgetMs: Math.floor(budgetMs), baseUrl: config.baseUrl, model: config.model})}\n`)
          result = await this.#read(child.stdout, async value => {
            await new Promise<void>((resolve, reject) => child.stdin.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve()))
          }, taskId, context, signal, approval, observation, waiting => {
            waitingForApproval = waiting
            if (waiting && exited) processStop.abort()
          })
        }
      } catch { result = handoff('bridge_protocol_failed', 'unknown') } finally {
        signal.removeEventListener('abort', terminate)
        terminate()
        await Promise.race([exit, delay(250)])
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
          for (let retry = 0; retry < 20; retry += 1) {
            try { process.kill(-child.pid, 0) } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') treeGone = true
              break
            }
            await delay(25)
          }
        }
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
      }
      if (!treeGone) return handoff('cleanup_unknown', 'unknown', observation)
      if (cancelled.aborted) return handoff('cancelled', 'cancelled', observation)
      if (deadlineSignal.aborted) return handoff('timeout', 'unknown', observation)
      return {...result, content: {...result.content, ...observation}}
    } finally {
      approval.invalidate('autoglm_finished')
      if (treeGone) { await unlink(join(lock, 'owner.json')).catch(() => undefined); await rmdir(lock) }
    }
  }

  async #read(output: AsyncIterable<Buffer>, send: (value: unknown) => Promise<void>, taskId: string,
    context: ExecutorDispatchContext, signal: AbortSignal, approval: ApprovalPort,
    observation: Record<string, string | number>,
    waiting: (value: boolean) => void): Promise<ExecutorHandoff> {
    let buffer = Buffer.alloc(0), total = 0, ready = false, step = 0
    const seen = new Set<string>()
    for await (const chunk of output) {
      total += chunk.length
      if (total > 1024 * 1024) throw new Error('protocol_limit')
      buffer = Buffer.concat([buffer, chunk])
      let end: number
      while ((end = buffer.indexOf(10)) !== -1) {
        if (end > 65536 || signal.aborted) throw new Error('protocol_limit')
        const line = new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, end))
        buffer = buffer.subarray(end + 1)
        const message = messageSchema.parse(JSON.parse(line))
        if (message.taskId !== taskId) throw new Error('wrong_task')
        if (message.type === 'ready') {
          if (ready) throw new Error('duplicate_ready')
          ready = true
          continue
        }
        // Startup refusals may precede readiness; never accept a successful unready terminal.
        if (!ready && !(message.type === 'terminal' && message.code === 'invalid_configuration')) throw new Error('not_ready')
        if (message.type === 'terminal') {
          const outcome = message.code === 'model_finished' ? 'ok' : message.code === 'timeout' ? 'unknown'
            : ['declined', 'needs_user_action', 'invalid_configuration', 'screen_changed'].includes(message.code) ? 'refused' : 'failed'
          return handoff(message.code, outcome, {steps: message.steps,
            ...(message.message === undefined ? {} : {message: message.message.replace(/[\x00-\x1f\x7f]/gu, ' ').slice(0, 2048)}),
            ...(message.lastAction === undefined ? {} : {last_action: message.lastAction})})
        }
        if (message.step < step || message.step > this.config.maxSteps) throw new Error('invalid_step')
        step = message.step
        if (message.type === 'progress') {
          if (message.phase === 'action_returned') {
            observation.last_returned_step = step
            if (message.lastAction !== undefined) observation.last_action = message.lastAction
          }
          context.progress({phase: 'working', internal_activity: step, elapsed: Math.max(0, context.clock.now() - context.delegate.dispatched_at), summary: null})
          continue
        }
        if (seen.has(message.requestId)) throw new Error('duplicate_approval')
        seen.add(message.requestId)
        const scope = `${message.packageName}: ${JSON.stringify(message.action)}`
        if (scope.length > 1024) return handoff('approval_too_large', 'refused')
        waiting(true)
        const resolution = await approval.offer({kind: 'permissions', local_detail: {kind: 'permissions', scope},
          operation_summary: `AutoGLM 手机操作：${message.action.action}`,
          allowed_decisions: ['accept', 'decline'], executorIdentity: {executor: 'autoglm', display_name: 'AutoGLM'}}, signal)
        waiting(false)
        if (signal.aborted) throw new Error('stopped')
        const decision = resolution === null ? 'decline' : approval.consume(resolution)
        if (signal.aborted) throw new Error('stopped')
        await send({version: 1, type: 'decision', taskId, requestId: message.requestId,
          decision: decision === 'accept' ? 'accept' : 'decline'})
      }
      if (buffer.length > 65536) throw new Error('protocol_limit')
    }
    return handoff('bridge_eof', 'unknown')
  }
}
