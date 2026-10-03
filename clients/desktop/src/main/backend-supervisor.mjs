import {publicUsageReport} from './frontend-usage.mjs'
import {randomUUID} from 'node:crypto'

const FAILURE_KINDS = new Set([
  'configuration_required', 'authentication_failed', 'unavailable', 'recoverable',
])
const DEFAULT_POLICY = Object.freeze({baseMs: 1_000, capMs: 30_000, jitterRatio: 0.2})

function failureOf(value) {
  if (value && typeof value === 'object' && FAILURE_KINDS.has(value.kind)) {
    const code = typeof value.code === 'string' && /^[a-z0-9_]{1,64}$/.test(value.code)
      ? value.code
      : value.kind
    return Object.freeze({kind: value.kind, code})
  }
  return Object.freeze({kind: 'recoverable', code: 'backend_disconnected'})
}

function validatePolicy(policy) {
  if (!policy || !Number.isInteger(policy.baseMs) || policy.baseMs < 0
    || !Number.isInteger(policy.capMs) || policy.capMs < policy.baseMs || policy.capMs > 60_000
    || typeof policy.jitterRatio !== 'number' || !Number.isFinite(policy.jitterRatio)
    || policy.jitterRatio < 0 || policy.jitterRatio > 0.5) {
    throw new Error('backend supervisor retry policy is invalid')
  }
  return Object.freeze({...policy})
}

export function createBackendSupervisor({
  start,
  stopBackend,
  onStatus,
  schedule = setTimeout,
  cancel = clearTimeout,
  random = Math.random,
  retryPolicy = DEFAULT_POLICY,
}) {
  if (typeof start !== 'function' || typeof stopBackend !== 'function'
    || typeof onStatus !== 'function' || typeof random !== 'function') {
    throw new Error('backend supervisor dependencies are invalid')
  }
  const policy = validatePolicy(retryPolicy)
  let running = false
  let generation = 0
  let backend = null
  let timer = null
  let retryAttempt = 0
  const activeAttempts = new Set()
  let current = Object.freeze({
    state: 'stopped', connection: null, retryInMs: null, diagnostic: null,
  })

  const publish = (state, connection = null, retryInMs = null, diagnostic = null) => {
    current = Object.freeze({state, connection, retryInMs, diagnostic})
    onStatus(current)
  }
  const cancelRetry = () => {
    if (timer !== null) cancel(timer)
    timer = null
  }
  const stopConfirmed = async candidate => {
    try {
      const result = await stopBackend(candidate)
      if (result === false) throw new Error('backend termination unconfirmed')
    } catch (error) {
      publish('unavailable', null, null, 'backend_stop_failed')
      throw error
    }
  }
  const retryDelay = () => {
    const exponential = Math.min(policy.capMs, policy.baseMs * (2 ** retryAttempt))
    retryAttempt += 1
    const sample = Number(random())
    const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5
    const multiplier = 1 + (((normalized * 2) - 1) * policy.jitterRatio)
    return Math.max(0, Math.round(exponential * multiplier))
  }
  const handleFailure = (value, expectedGeneration) => {
    if (!running || expectedGeneration !== generation) return
    const failure = failureOf(value)
    if (failure.kind !== 'recoverable') {
      cancelRetry()
      publish(failure.kind, null, null, failure.code)
      return
    }
    if (timer !== null) return
    const delay = retryDelay()
    publish('reconnecting', null, delay, failure.code)
    timer = schedule(() => {
      timer = null
      void runAttempt(expectedGeneration).catch(() => {})
    }, delay)
  }
  const attempt = async expectedGeneration => {
    if (!running || expectedGeneration !== generation) return
    publish('starting')
    let returnedBackend = null
    let earlyFailure = null
    let cleanupStarted = false
    const onExit = failure => {
      if (!running || expectedGeneration !== generation) return
      if (returnedBackend === null) {
        earlyFailure = failureOf(failure)
        return
      }
      if (backend === returnedBackend) backend = null
      handleFailure(failure, expectedGeneration)
    }
    try {
      const result = await start(onExit)
      returnedBackend = result?.backend ?? null
      if (!result || returnedBackend === null || !result.connection) {
        throw failureOf({kind: 'unavailable', code: 'backend_start_failed'})
      }
      if (!running || expectedGeneration !== generation || earlyFailure !== null) {
        cleanupStarted = true
        await stopConfirmed(returnedBackend)
        if (earlyFailure !== null) handleFailure(earlyFailure, expectedGeneration)
        return
      }
      backend = returnedBackend
      retryAttempt = 0
      publish('connected', Object.freeze({...result.connection}))
    } catch (error) {
      if (cleanupStarted) throw error
      if (returnedBackend !== null && !cleanupStarted) await stopConfirmed(returnedBackend)
      handleFailure(earlyFailure ?? error, expectedGeneration)
    }
  }
  const runAttempt = expectedGeneration => {
    const started = attempt(expectedGeneration)
    activeAttempts.add(started)
    const remove = () => activeAttempts.delete(started)
    started.then(remove, remove)
    return started
  }
  const settleStaleAttempts = async () => {
    const stale = [...activeAttempts]
    if (stale.length > 0) await Promise.all(stale)
  }
  const restart = async () => {
    running = true
    generation += 1
    const expectedGeneration = generation
    cancelRetry()
    retryAttempt = 0
    const previous = backend
    if (previous !== null) {
      await stopConfirmed(previous)
      if (backend === previous) backend = null
    }
    await settleStaleAttempts()
    await runAttempt(expectedGeneration)
  }
  const stop = async () => {
    running = false
    generation += 1
    cancelRetry()
    const previous = backend
    if (previous !== null) {
      await stopConfirmed(previous)
      if (backend === previous) backend = null
    }
    await settleStaleAttempts()
    publish('stopped')
  }
  return Object.freeze({
    start: restart,
    restart,
    retry: restart,
    stop,
    status: () => current,
  })
}


export function publicRuntimeCapabilityStatus(value) {
  if (!value || (value.toolCount !== null && (!Number.isSafeInteger(value.toolCount) || value.toolCount < 0 || value.toolCount > 100000))
    || !Number.isSafeInteger(value.toolBudget) || value.toolBudget < 1 || value.toolBudget > 256) return null
  const result = {toolCount: value.toolCount, toolBudget: value.toolBudget,
    state: value.state === 'startup_failed' ? 'startup_failed' : 'compiled'}
  if (value.modules) {
    result.modules = {}
    for (const name of ['search', 'camera', 'coding', 'knowledge']) {
      const module = value.modules[name]
      if (typeof module?.enabled !== 'boolean') continue
      result.modules[name] = {enabled: module.enabled}
      if (typeof module.reason === 'string' && /^missing_environment:[A-Z][A-Z0-9_]{0,63}$/u.test(module.reason)) result.modules[name].reason = module.reason
    }
    if (result.modules.search && value.modules.search.fallback === 'bailian_mcp') result.modules.search.fallback = 'bailian_mcp'
    if (result.modules.search && ['mcp', 'tavily'].includes(value.modules.search.provider)) result.modules.search.provider = value.modules.search.provider
    if (result.modules.knowledge) result.modules.knowledge.exposeToCodex = value.modules.knowledge.exposeToCodex === true
  }
  const states = ['configured', 'ok', 'failed', 'disabled']
  const status = server => ({status: states.includes(server?.status) ? server.status : 'failed',
    ...(typeof server?.reason === 'string' && /^[a-zA-Z0-9_.: -]{1,160}$/u.test(server.reason) ? {reason: server.reason} : {})})
  result.servers = (Array.isArray(value.servers) ? value.servers : []).slice(0, 8).filter(server => /^[a-z][a-z0-9_]{0,31}$/u.test(server?.name ?? '')).map(server => ({name: server.name, ...status(server), ...(server.codex ? {codex: status(server.codex)} : {})}))
  if (result.state === 'startup_failed' && value.reason === 'configuration_required') {
    result.reason = 'configuration_required'
    if (['integrated', 'cascaded'].includes(value.pipeline)) result.pipeline = value.pipeline
    result.missing = (Array.isArray(value.missing) ? value.missing : []).slice(0, 4).filter(name => BLOCKING_CREDENTIALS.has(name))
  }
  result.overrides = (Array.isArray(value.overrides) ? value.overrides : []).filter(name => ['SEARCH_PROVIDER', 'SEARCH_MCP_URL', 'SEARCH_MCP_TOOL', 'CAMERA_MODULE_ENABLED', 'CODING_MODULE_ENABLED'].includes(name))
  return result
}

const BLOCKING_CREDENTIALS = new Set(['DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY', 'ARK_API_KEY', 'DOUBAO_BIGMODEL_API_KEY'])

/** One private utility child owns every pending request; replacement closes this handle. */
export function createBackendControl(child, {onStatus = () => {}, onUsage = () => {}} = {}) {
  const pending = new Map()
  let closed = false
  const unavailable = () => new Error('backend control unavailable')
  const receive = message => {
    if (closed || !message || typeof message !== 'object') return
    if (message.type === 'nova.usage') {
      const report = publicUsageReport(message.report)
      if (report) onUsage(report)
      return
    }
    if (message.type === 'nova.capabilities') {
      const value = publicRuntimeCapabilityStatus(message.status)
      if (value) onStatus(value)
      return
    }
    if (message.type !== 'nova.control.reply' || typeof message.id !== 'string') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(unavailable())
    else request.resolve(message.result)
  }
  function close() {
    if (closed) return
    closed = true
    child.off('message', receive)
    child.off('exit', close)
    child.off('error', close)
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(unavailable()) }
    pending.clear()
  }
  child.on('message', receive)
  child.once('exit', close)
  child.once('error', close)
  return {
    close,
    request(method, params = {}, {timeoutMs = 30000} = {}) {
      if (closed || pending.size >= 8 || typeof method !== 'string' || method.length > 80
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) return Promise.reject(unavailable())
      return new Promise((resolve, reject) => {
        const id = randomUUID()
        const timer = setTimeout(() => {pending.delete(id); reject(unavailable())}, timeoutMs)
        pending.set(id, {resolve, reject, timer})
        try { child.postMessage({type: 'nova.control.request', id, method, params}) }
        catch { pending.delete(id); clearTimeout(timer); reject(unavailable()) }
      })
    },
  }
}

const RUNTIME_CODES = new Set([
  'configuration_required', 'authentication_failed', 'backend_unavailable', 'assembly_failed',
  'filesystem_permissions', 'state_permissions', 'state_busy', 'state_lock_failed', 'personal_store_locked', 'workspace_not_found', 'workspace_invalid',
])
const CODEX_DIAGNOSTIC_CODES = new Set([
  'codex_login_status_nonzero',
  'codex_login_status_no_output',
  'codex_login_status_multiple_streams',
  'codex_login_status_unrecognized',
  'codex_credential_snapshot_private_home_failed',
  'codex_credential_snapshot_api_key_failed',
  'codex_credential_snapshot_saved_login_failed',
  'codex_credential_snapshot_environment_failed',
  'codex_project_view_refresh_project_state_error',
  'codex_project_view_refresh_type_error',
  'codex_project_view_refresh_unexpected_error',
  ...[
    'workspace_name_invalid', 'session_title_invalid', 'state_lock_failed', 'state_busy',
    'state_permissions', 'state_corrupt', 'state_too_large', 'state_version_unsupported',
    'state_write_failed', 'context_delivery_failed', 'managed_root_unsafe', 'workspace_invalid',
    'workspace_not_found', 'workspace_name_conflict', 'workspace_path_conflict', 'workspace_limit',
    'workspace_create_failed', 'workspace_boundary_changed', 'session_not_found',
    'session_unavailable', 'session_workspace_mismatch', 'session_state_conflict', 'session_limit',
    'thread_id_invalid', 'id_factory_invalid', 'clock_invalid',
  ].map(code => `codex_project_view_refresh_${code}`),
])
const LINE = /\[runtime-diagnostic\]\s+([a-z0-9_]{1,64})/g
const CONFIG_WARNING = /\[config-warning\] [\x20-\x7e]{1,160}/g
const STARTUP_ERROR = /\[runtime-startup-error\] [^\r\n]{1,296}/g

/** Runtime configuration warnings name only variables, never values, so the main process can echo them verbatim. */
export function configWarnings(chunk) {
  return String(chunk).match(CONFIG_WARNING) ?? []
}

/** The runtime's sanitised startup exception; terminal-only, never a failure code. */
export function startupErrors(chunk) {
  return String(chunk).match(STARTUP_ERROR) ?? []
}

export function classifyBackendFailure(code) {
  if (['credential_access_failed', 'credential_invalid', 'startup_presentation_required', 'filesystem_permissions', 'state_permissions', 'state_busy', 'state_lock_failed', 'personal_store_locked', 'workspace_not_found', 'workspace_invalid'].includes(code)) return Object.freeze({kind: 'unavailable', code})
  if (code === 'backend_start_timeout') {
    return Object.freeze({kind: 'recoverable', code})
  }
  if (code === 'configuration_required' || code === 'manual_path_required'
    || code === 'model_base_url_invalid') {
    return Object.freeze({kind: 'configuration_required', code})
  }
  if (code === 'authentication_failed') {
    return Object.freeze({kind: 'authentication_failed', code})
  }
  if (code === 'backend_unavailable' || code === 'codex_unavailable') {
    return Object.freeze({kind: 'unavailable', code})
  }
  return Object.freeze({kind: 'recoverable', code: 'backend_disconnected'})
}

export function createBackendDiagnosticCollector() {
  let buffer = ''
  let code = null
  let startupFailure = null
  return Object.freeze({
    pushCapabilityStatus(value) {
      const status = publicRuntimeCapabilityStatus(value)
      if (status?.state === 'startup_failed' && (status.reason === 'configuration_required'
        || (status.toolCount !== null && status.toolCount > status.toolBudget))) {
        startupFailure = classifyBackendFailure('configuration_required')
      }
    },
    push(chunk) {
      buffer = `${buffer}${String(chunk)}`.slice(-1024)
      for (const match of buffer.matchAll(LINE)) {
        if (RUNTIME_CODES.has(match[1]) || CODEX_DIAGNOSTIC_CODES.has(match[1])) code = match[1]
      }
      return code
    },
    failure(fallback = 'backend_disconnected') {
      // Utility exit can arrive before stderr; structured configuration failures
      // must not become reconnect loops just because their log line arrives late.
      return startupFailure ?? classifyBackendFailure(code !== null && RUNTIME_CODES.has(code) ? code : fallback)
    },
    code: () => code,
  })
}
