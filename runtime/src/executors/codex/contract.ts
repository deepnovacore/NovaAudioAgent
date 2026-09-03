import {createHash} from 'node:crypto'
import type {ExecutorProgress} from '../../causal-runtime.js'
import type {JsonValue} from '../../events.js'
import {snapshotJsonRecord} from './safe-json.js'
import {validProgressSummary} from '../../events.js'
import {hasOtherCategory as hasPinnedOtherCategory} from '../../unicode-tables.js'
import {normalizeNfcPinned} from '../../unicode-normalize.js'
import {isPythonSpace, isWellFormed, stripLikePython} from '../../python-text.js'
import {executorManifestSchema, type ExecutorManifest, type OpSpec} from '../../ports.js'

export const INTERNAL_CODEX_RUN_DEADLINE = 540
export const MAX_CODEX_EVENTS = 16_384
export const MAX_CODEX_EVIDENCE_COUNTER = 1_048_576

const CODEX_POLICY = {
  channel: 'codex',
  priority: 50,
  wake: 'fast',
  typical_latency: 180,
  compress_watermark: 5,
  suggest: false,
  progress_via_surrogate: true,
} as const

const RUN: OpSpec = {
  name: 'run',
  description: '在配置好的工作区中执行一个有界、非交互的 Codex 工作单',
  params: {
    type: 'object',
    properties: {work_order: {type: 'string', minLength: 1, maxLength: 4000}},
    required: ['work_order'],
    additionalProperties: false,
  },
  readonly: false,
  confirm: false,
  deadline_budget: 600,
  verifies: [],
  sensitive_params: ['work_order'],
  sync_result: false,
  host_confirmation: false,
}

const STATUS: OpSpec = {
  name: 'status',
  description: '读取当前或最近一次 Codex 运行的进程状态',
  params: {type: 'object', properties: {}, additionalProperties: false},
  readonly: true,
  confirm: false,
  deadline_budget: 5,
  verifies: [],
  sensitive_params: [],
  sync_result: true,
  host_confirmation: false,
}

const STEER: OpSpec = {
  name: 'steer',
  description: '向当前仍在执行的 Codex turn 追加约束；不终止、不重启、不创建下一轮。',
  params: {
    type: 'object',
    properties: {instruction: {type: 'string', minLength: 1, maxLength: 2000}},
    required: ['instruction'],
    additionalProperties: false,
  },
  readonly: false,
  confirm: false,
  deadline_budget: 30,
  verifies: [],
  sensitive_params: ['instruction'],
  sync_result: false,
  host_confirmation: false,
}

const PROJECT: Readonly<Record<string, JsonValue>> = {
  type: ['string', 'null'], minLength: 1, maxLength: 80,
  description: '目标项目的 roster 名称；null 表示当前活动项目',
}

/** Project-mode `run`: the coordinator's decision rides with the work order (spec 08). */
const RUN_PROJECT: OpSpec = {
  ...RUN,
  description: '在 coordinator 选定的项目/会话中执行一个有界、非交互的 Codex 工作单',
  params: {
    type: 'object',
    properties: {
      work_order: {type: 'string', minLength: 1, maxLength: 4000},
      project: PROJECT,
      session: {type: 'string', enum: ['latest', 'new'], description: 'latest 续用活动会话；new 开新线程'},
      title: {type: 'string', minLength: 1, maxLength: 120, description: '宿主为新会话派生的标题'},
    },
    required: ['work_order'],
    additionalProperties: false,
  },
}

const STEER_PROJECT: OpSpec = {
  ...STEER,
  params: {
    type: 'object',
    properties: {
      instruction: {type: 'string', minLength: 1, maxLength: 2000},
      project: PROJECT,
    },
    required: ['instruction'],
    additionalProperties: false,
  },
}

const CANCEL: OpSpec = {
  name: 'cancel',
  description: '停止一个正在执行的 Codex work；会话与历史保留。',
  params: {
    type: 'object',
    properties: {work_id: {type: 'string', minLength: 1, maxLength: 128}},
    required: ['work_id'],
    additionalProperties: false,
  },
  readonly: false,
  confirm: false,
  deadline_budget: 30,
  verifies: [],
  sensitive_params: [],
  sync_result: true,
  host_confirmation: false,
}

/** One description line in the host `dispatch` tool; the voice model never sees the ops above. */
export const CODEX_AGENT_SUMMARY = '在已配置的项目工作区里执行编码任务（改代码、修 bug、写测试、重构）'

function manifest(ops: readonly OpSpec[], approvals = false): ExecutorManifest {
  return deepFreeze(executorManifestSchema.parse({
    name: 'codex',
    display_name: 'Codex',
    roles: ['coding'],
    approvals,
    agent: {summary: CODEX_AGENT_SUMMARY},
    ops,
    policy: CODEX_POLICY,
  }))
}

export const CODEX_BASE_MANIFEST = manifest([RUN, STATUS])
export const CODEX_LIVE_MANIFEST = manifest([RUN, STEER, STATUS])
export const CODEX_PROJECT_MANIFEST = manifest([RUN_PROJECT, STEER_PROJECT, STATUS, CANCEL])
export const CODEX_PROJECT_APPROVAL_MANIFEST = manifest([RUN_PROJECT, STEER_PROJECT, STATUS, CANCEL], true)

export type CodexVariant = 'base' | 'live' | 'project'
export type CodexRequestValidation =
  | {readonly ok: true; readonly value: Readonly<Record<string, unknown>>}
  | {readonly ok: false; readonly error: 'unknown_op' | 'invalid_params'; readonly op: string}

export function validateCodexRequest(
  variant: CodexVariant,
  op: string,
  request: unknown,
): CodexRequestValidation {
  try {
    return validateCodexRequestChecked(variant, op, request)
  } catch {
    return failure('invalid_params', op)
  }
}

function validateCodexRequestChecked(
  variant: CodexVariant,
  op: string,
  request: unknown,
): CodexRequestValidation {
  const operations = variant === 'base'
    ? new Set(['run', 'status'])
    : variant === 'live'
      ? new Set(['run', 'steer', 'status'])
      : new Set(['run', 'steer', 'status', 'cancel'])
  if (!operations.has(op)) return failure('unknown_op', op)
  const requestSnapshot = snapshotJsonRecord(request)
  if (op === 'status') {
    return Object.keys(requestSnapshot).length === 0
      ? success({})
      : failure('invalid_params', op)
  }
  if (op === 'cancel') {
    const workId = exactBoundedString(requestSnapshot, 'work_id', 128)
    return workId === null ? failure('invalid_params', op) : success({work_id: workId})
  }
  if (variant !== 'project') {
    const name = op === 'steer' ? 'instruction' : 'work_order'
    const value = exactBoundedString(requestSnapshot, name, op === 'steer' ? 2000 : 4000)
    return value === null ? failure('invalid_params', op) : success({[name]: value})
  }
  return op === 'steer' ? validateProjectSteer(requestSnapshot) : validateProjectRun(requestSnapshot)
}

/** `project` is a nullable roster name, defaulting to the active project; unknown keys fail closed. */
function projectField(request: Record<string, unknown>, result: Record<string, unknown>): boolean {
  if (!Object.hasOwn(request, 'project') || request.project === null) { result.project = null; return true }
  const project = normalizedString(request.project, 80)
  if (project === null) return false
  result.project = project
  return true
}

function validateProjectRun(request: Record<string, unknown>): CodexRequestValidation {
  const allowed = new Set(['work_order', 'project', 'session', 'title'])
  if (Object.keys(request).some(key => !allowed.has(key))) return failure('invalid_params', 'run')
  const workOrder = normalizedString(request.work_order, 4000)
  if (workOrder === null) return failure('invalid_params', 'run')
  const result: Record<string, unknown> = {work_order: workOrder}
  if (!projectField(request, result)) return failure('invalid_params', 'run')
  const session = Object.hasOwn(request, 'session') ? request.session : 'latest'
  if (session !== 'latest' && session !== 'new') return failure('invalid_params', 'run')
  result.session = session
  if (Object.hasOwn(request, 'title')) {
    const title = normalizedString(request.title, 120)
    if (title === null) return failure('invalid_params', 'run')
    result.title = title
  }
  return success(result)
}

function validateProjectSteer(request: Record<string, unknown>): CodexRequestValidation {
  const allowed = new Set(['instruction', 'project'])
  if (Object.keys(request).some(key => !allowed.has(key))) return failure('invalid_params', 'steer')
  const instruction = normalizedString(request.instruction, 2000)
  if (instruction === null) return failure('invalid_params', 'steer')
  const result: Record<string, unknown> = {instruction}
  if (!projectField(request, result)) return failure('invalid_params', 'steer')
  return success(result)
}

function exactBoundedString(
  request: Record<string, unknown>,
  name: string,
  limit: number,
): string | null {
  if (Object.keys(request).length !== 1 || !Object.hasOwn(request, name)) return null
  return normalizedString(request[name], limit)
}

function normalizedString(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = stripLikePython(value)
  const size = codePointLength(normalized)
  return size >= 1 && size <= limit ? normalized : null
}

function success(value: Record<string, unknown>): CodexRequestValidation {
  return Object.freeze({ok: true, value: deepFreeze(value)})
}

function failure(error: 'unknown_op' | 'invalid_params', op: string): CodexRequestValidation {
  return Object.freeze({ok: false, error, op})
}

export function createInitialCodexStatus(
  options: {readonly live: boolean},
): Readonly<Record<string, unknown>> {
  const status: Record<string, unknown> = {
    op: 'status',
    state: 'idle',
    run_sequence: 0,
    started_at: null,
    finished_at: null,
    elapsed: null,
    process: {running: false, exited: false, exit_code: null},
    protocol: {terminal: null},
    preflight: {verdict: 'not_run'},
  }
  if (options.live) status.prewarm = {state: 'cold'}
  return deepFreeze(status)
}

export interface CodexStatusSnapshot {
  readonly state: 'idle' | 'running' | 'exited'
  readonly run_sequence: number
  readonly started_at: number | null
  readonly finished_at: number | null
  readonly elapsed: number | null
  readonly process_running: boolean
  readonly process_exited: boolean
  readonly terminal: 'completed' | 'failed' | null
  readonly exit_code: number | null
  readonly preflight: 'not_run' | 'passed' | 'failed'
  readonly prewarm: 'cold' | 'warming' | 'ready' | 'failed'
}

export function projectCodexStatus(
  snapshot: CodexStatusSnapshot,
  now: number,
  options: {readonly live: boolean; readonly progress?: ExecutorProgress | null},
): Readonly<Record<string, unknown>> {
  const elapsed = snapshot.state === 'running'
    && snapshot.started_at !== null
    && Number.isFinite(now)
    ? Math.max(0, now - snapshot.started_at)
    : snapshot.elapsed
  const content: Record<string, unknown> = {
    op: 'status',
    state: snapshot.state,
    run_sequence: snapshot.run_sequence,
    started_at: snapshot.started_at,
    finished_at: snapshot.finished_at,
    elapsed,
    process: {
      running: snapshot.process_running,
      exited: snapshot.process_exited,
      exit_code: snapshot.exit_code,
    },
    protocol: {terminal: snapshot.terminal},
    preflight: {verdict: snapshot.preflight},
  }
  if (options.live) content.prewarm = {state: snapshot.prewarm}
  const progress = options.progress
  if (
    options.live
    && snapshot.state === 'running'
    && progress !== undefined
    && progress !== null
    && safeIntegerBetween(progress.internal_activity, 0, MAX_CODEX_EVIDENCE_COUNTER)
    && validProgressSummary(progress.summary, progress.phase)
  ) {
    content.progress = {
      internal_activity: progress.internal_activity,
      ...(progress.summary === null ? {} : {summary: progress.summary}),
    }
  }
  return deepFreeze(content)
}

export function createCodexRunEnvelope(
  code: unknown,
  preflight: Readonly<Record<string, unknown>>,
  evidence?: unknown,
  stage?: 'preflight' | 'credential' | 'spawn' | 'thread_start',
): Readonly<Record<string, unknown>> {
  const admitted = evidence === undefined ? null : sanitizeCodexEvidence(evidence)
  return deepFreeze({
    op: 'run',
    worker: 'codex',
    code: safeWorkerCode(code),
    ...(stage === undefined ? {} : {stage}),
    ...(admitted ?? {}),
    preflight: sanitizeCodexPreflightReport(preflight) ?? {},
    goal_verification: 'unverified',
  })
}

export function sanitizeCodexPreflightReport(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    return sanitizeCodexPreflightReportChecked(snapshotJsonRecord(value))
  } catch {
    return null
  }
}

function sanitizeCodexPreflightReportChecked(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  if (!isPlainObject(value)) return null
  const result: Record<string, unknown> = {}
  if (Object.hasOwn(value, 'version')) {
    if (typeof value.version !== 'string' || !CODEX_VERSION.test(value.version)) return null
    result.version = value.version
  }
  if (Object.hasOwn(value, 'root_matches')) {
    if (typeof value.root_matches !== 'boolean') return null
    result.root_matches = value.root_matches
  }
  for (const [name, expected] of [
    ['mount', 'workspace_only'], ['subprocess', 'contained'], ['network', 'blocked'],
  ] as const) {
    if (!Object.hasOwn(value, name)) continue
    if (value[name] !== expected) return null
    result[name] = expected
  }
  if (Object.hasOwn(value, 'credential')) {
    if (!isPlainObject(value.credential)) return null
    const credential: Record<string, unknown> = {}
    if (Object.hasOwn(value.credential, 'present')) {
      if (typeof value.credential.present !== 'boolean') return null
      credential.present = value.credential.present
    }
    if (Object.hasOwn(value.credential, 'identity')) {
      if (
        value.credential.identity !== 'chatgpt'
        && value.credential.identity !== 'api_key'
        && value.credential.identity !== 'unknown'
      ) return null
      credential.identity = value.credential.identity
    }
    if (Object.hasOwn(value.credential, 'policy')) {
      if (value.credential.policy !== 'saved_login' && value.credential.policy !== 'process_only') {
        return null
      }
      credential.policy = value.credential.policy
    }
    result.credential = credential
  }
  if (Object.hasOwn(value, 'limits')) {
    if (!isPlainObject(value.limits)) return null
    const limits: Record<string, string> = {}
    for (const [name, classification] of Object.entries(value.limits)) {
      if (
        !/^[a-z0-9_]{1,32}$/u.test(name)
        || (classification !== 'finite'
          && classification !== 'unbounded'
          && classification !== 'unavailable')
      ) return null
      defineJsonProperty(limits, name, classification)
    }
    result.limits = limits
  }
  return deepFreeze(result)
}

export function sanitizeCodexEvidence(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    return sanitizeCodexEvidenceChecked(snapshotJsonRecord(value))
  } catch {
    return null
  }
}

function sanitizeCodexEvidenceChecked(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isPlainObject(value)) return null
  const keys = Object.keys(value)
  if (!sameKeySet(keys, ['events', 'protocol', 'process'])
    && !sameKeySet(keys, ['events', 'protocol', 'process', 'result'])) return null
  const events = sanitizeEvents(value.events)
  const protocol = sanitizeProtocol(value.protocol)
  const processEvidence = sanitizeProcess(value.process)
  if (events === null || protocol === null || processEvidence === null) return null
  const result = Object.hasOwn(value, 'result') ? sanitizeResult(value.result) : undefined
  if (Object.hasOwn(value, 'result') && result === null) return null
  return deepFreeze({
    events,
    protocol,
    process: processEvidence,
    ...(result === undefined ? {} : {result}),
  })
}

function sanitizeEvents(value: unknown): readonly Readonly<Record<string, unknown>>[] | null {
  if (!Array.isArray(value) || value.length > MAX_CODEX_EVENTS) return null
  const result: Readonly<Record<string, unknown>>[] = []
  let activitySeen = false
  for (const event of value) {
    if (!isPlainObject(event) || typeof event.type !== 'string') return null
    if (event.type === 'internal_activity') {
      if (
        activitySeen
        || !sameKeySet(Object.keys(event), ['type', 'count'])
        || !safeIntegerBetween(event.count, 1, MAX_CODEX_EVIDENCE_COUNTER)
      ) return null
      activitySeen = true
      result.push({type: 'internal_activity', count: event.count})
      continue
    }
    if (
      !sameKeySet(Object.keys(event), ['type'])
      || !EVENT_TYPES.has(event.type)
    ) return null
    result.push({type: event.type})
  }
  return result
}

function sanitizeProtocol(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isPlainObject(value) || !sameKeySet(Object.keys(value), [
    'thread_started', 'turn_started', 'terminal', 'transport_closed', 'unknown_event_count',
  ])) return null
  if (typeof value.thread_started !== 'boolean' || typeof value.turn_started !== 'boolean') return null
  if (value.terminal !== null && value.terminal !== 'completed' && value.terminal !== 'failed') return null
  if (typeof value.transport_closed !== 'boolean') return null
  if (!safeIntegerBetween(value.unknown_event_count, 0, MAX_CODEX_EVIDENCE_COUNTER)) return null
  return {
    thread_started: value.thread_started,
    turn_started: value.turn_started,
    terminal: value.terminal,
    transport_closed: value.transport_closed,
    unknown_event_count: value.unknown_event_count,
  }
}

function sanitizeProcess(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isPlainObject(value) || !sameKeySet(Object.keys(value), ['started', 'exit_code', 'stop'])) {
    return null
  }
  if (value.started !== true) return null
  if (value.exit_code !== null && !safeInteger(value.exit_code)) return null
  if (value.stop !== 'none' && value.stop !== 'terminate' && value.stop !== 'kill') return null
  return {started: true, exit_code: value.exit_code, stop: value.stop}
}

function sanitizeResult(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isPlainObject(value) || !sameKeySet(Object.keys(value), ['final_message'])) return null
  const message = value.final_message
  if (!isPlainObject(message) || !sameKeySet(Object.keys(message), [
    'text', 'original_chars', 'truncated', 'sha256',
  ])) return null
  const text = message.text
  if (
    typeof text !== 'string'
    || !isWellFormed(text)
    || codePointLength(text) > 4000
    || normalizeNfcPinned(text) !== text
    || !pythonPrintable(text)
  ) return null
  const textLength = codePointLength(text)
  if (!safeIntegerBetween(message.original_chars, textLength, 65_536)) return null
  if (typeof message.truncated !== 'boolean' || message.truncated !== (message.original_chars > textLength)) {
    return null
  }
  if (typeof message.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(message.sha256)) return null
  if (!message.truncated && sha256(text) !== message.sha256) return null
  return {final_message: {
    text,
    original_chars: message.original_chars,
    truncated: message.truncated,
    sha256: message.sha256,
  }}
}

export function classifyCodexResult(value: {
  readonly classification: 'completed' | 'refused' | 'uncertain'
  readonly turnWritten: boolean
}): Readonly<{outcome: 'ok' | 'failed' | 'unknown'; trust: 'trusted_system' | 'untrusted_external'}> {
  if (value.classification === 'completed') {
    return Object.freeze({outcome: 'ok', trust: 'untrusted_external'})
  }
  if (value.classification === 'refused' && !value.turnWritten) {
    return Object.freeze({outcome: 'failed', trust: 'trusted_system'})
  }
  return Object.freeze({outcome: 'unknown', trust: 'untrusted_external'})
}

export const PUBLIC_PREFLIGHT_CODES = Object.freeze([
  'adapter_timeout',
  'binary_missing',
  'credential_missing',
  'preflight_failed',
  'preflight_timeout',
  'sandbox_failed',
  'spawn_failed',
  'unsupported_protocol',
  'unsupported_version',
  'workspace_invalid',
  'workspace_root_mismatch',
] as const)

const PUBLIC_PREFLIGHT_CODE_SET: ReadonlySet<string> = new Set(PUBLIC_PREFLIGHT_CODES)

export function sanitizePublicPreflightCode(value: unknown, fallback: string): string {
  if (typeof value === 'string' && PUBLIC_PREFLIGHT_CODE_SET.has(value)) return value
  return PUBLIC_PREFLIGHT_CODE_SET.has(fallback) ? fallback : 'preflight_failed'
}

function safeWorkerCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    ? value
    : 'invalid_worker_code'
}

function pythonPrintable(value: string): boolean {
  for (const character of value) {
    if (character !== ' ' && (isPythonSpace(character) || hasPinnedOtherCategory(character))) return false
  }
  return true
}

function codePointLength(value: string): number {
  return Array.from(value).length
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function safeIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return safeInteger(value) && value >= minimum && value <= maximum
}

function sameKeySet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every(key => actual.includes(key))
}

function defineJsonProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

const CODEX_VERSION = /^(?:codex-cli )?\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?(?:\+[A-Za-z0-9._-]+)?$/u
const EVENT_TYPES = new Set([
  'thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error',
])
