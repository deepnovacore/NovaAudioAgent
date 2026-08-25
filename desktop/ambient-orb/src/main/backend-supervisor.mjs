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
      return attempt(expectedGeneration)
    }, delay)
  }
  const attempt = async expectedGeneration => {
    if (!running || expectedGeneration !== generation) return
    publish('starting')
    let returnedBackend = null
    let earlyFailure = null
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
        await stopBackend(returnedBackend).catch(() => {})
        if (earlyFailure !== null) handleFailure(earlyFailure, expectedGeneration)
        return
      }
      backend = returnedBackend
      retryAttempt = 0
      publish('connected', Object.freeze({...result.connection}))
    } catch (error) {
      if (returnedBackend !== null) await stopBackend(returnedBackend).catch(() => {})
      handleFailure(earlyFailure ?? error, expectedGeneration)
    }
  }
  const restart = async () => {
    running = true
    generation += 1
    const expectedGeneration = generation
    cancelRetry()
    retryAttempt = 0
    const previous = backend
    backend = null
    if (previous !== null) await stopBackend(previous).catch(() => {})
    await attempt(expectedGeneration)
  }
  const stop = async () => {
    running = false
    generation += 1
    cancelRetry()
    const previous = backend
    backend = null
    if (previous !== null) await stopBackend(previous).catch(() => {})
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
