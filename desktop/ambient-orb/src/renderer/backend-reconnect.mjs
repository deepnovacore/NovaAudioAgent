export const BACKEND_RECONNECT_BASE_DELAY_MS = 250
export const BACKEND_RECONNECT_MAX_DELAY_MS = 5_000
export const MAX_PENDING_CONNECTION_DIAGNOSTICS = 16

const tokenPattern = /^[a-f0-9]{32}$/u

export class BackendReconnectController {
  #open
  #scheduleTimeout
  #cancelTimeout
  #random
  #onState
  #sendDiagnostic
  #baseDelayMs
  #maxDelayMs
  #connection = null
  #timer = null
  #attempt = 0
  #generation = 0
  #recovering = false
  #diagnostics = []

  constructor({
    open,
    scheduleTimeout = globalThis.setTimeout.bind(globalThis),
    cancelTimeout = globalThis.clearTimeout.bind(globalThis),
    random = Math.random,
    onState = () => {},
    sendDiagnostic = () => false,
    baseDelayMs = BACKEND_RECONNECT_BASE_DELAY_MS,
    maxDelayMs = BACKEND_RECONNECT_MAX_DELAY_MS,
  } = {}) {
    if (typeof open !== 'function'
      || typeof scheduleTimeout !== 'function'
      || typeof cancelTimeout !== 'function'
      || typeof random !== 'function'
      || typeof onState !== 'function'
      || typeof sendDiagnostic !== 'function'
      || !Number.isFinite(baseDelayMs)
      || baseDelayMs <= 0
      || !Number.isFinite(maxDelayMs)
      || maxDelayMs < baseDelayMs) throw new TypeError('invalid backend reconnect controller')
    this.#open = open
    this.#scheduleTimeout = scheduleTimeout
    this.#cancelTimeout = cancelTimeout
    this.#random = random
    this.#onState = onState
    this.#sendDiagnostic = sendDiagnostic
    this.#baseDelayMs = baseDelayMs
    this.#maxDelayMs = maxDelayMs
  }

  setConnection(connection) {
    validateConnection(connection)
    this.#cancelRetry()
    this.#connection = Object.freeze({
      endpoint: connection.endpoint,
      token: connection.token,
    })
    this.#generation += 1
    this.#attempt = 0
    this.#recovering = false
    this.#tryOpen(0, this.#generation)
  }

  socketOpened() {
    if (this.#connection === null) return false
    const attempt = this.#attempt
    const recovering = this.#recovering
    this.#cancelRetry()
    this.#flushDiagnostics()
    if (recovering) {
      this.#record({
        phase: 'reconnect_result',
        attempt,
        result: 'connected',
      })
    }
    this.#attempt = 0
    this.#recovering = false
    this.#publishState('connected')
    return true
  }

  socketClosed(event = {}) {
    if (this.#connection === null) return false
    this.#recovering = true
    this.#record({
      phase: 'closed',
      close_code: validCloseCode(event.code),
      reason: closeReason(event.code),
    })
    this.#publishState('reconnecting')
    this.#scheduleRetry()
    return true
  }

  backendExited() {
    this.#connection = null
    this.#generation += 1
    this.#attempt = 0
    this.#recovering = false
    this.#diagnostics.length = 0
    this.#cancelRetry()
  }

  dispose() {
    this.backendExited()
  }

  #tryOpen(attempt, generation) {
    if (this.#connection === null || generation !== this.#generation) return
    try {
      this.#open(this.#connection, Object.freeze({attempt}))
    } catch {
      this.#recovering = true
      this.#record({
        phase: 'reconnect_result',
        attempt,
        result: 'open_failed',
      })
      this.#publishState('reconnecting')
      this.#scheduleRetry()
    }
  }

  #scheduleRetry() {
    if (this.#connection === null || this.#timer !== null) return
    this.#attempt = Math.min(1_000_000, this.#attempt + 1)
    const exponential = Math.min(
      this.#maxDelayMs,
      this.#baseDelayMs * (2 ** Math.min(20, this.#attempt - 1)),
    )
    const random = Number(this.#random())
    const jitter = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5
    const delayMs = Math.max(1, Math.round(exponential * (0.8 + jitter * 0.4)))
    const generation = this.#generation
    const attempt = this.#attempt
    this.#record({
      phase: 'reconnect_attempt',
      attempt,
      delay_ms: delayMs,
    })
    this.#timer = this.#scheduleTimeout(() => {
      this.#timer = null
      this.#tryOpen(attempt, generation)
    }, delayMs)
  }

  #cancelRetry() {
    if (this.#timer === null) return
    const timer = this.#timer
    this.#timer = null
    this.#cancelTimeout(timer)
  }

  #record(diagnostic) {
    try {
      if (this.#sendDiagnostic(Object.freeze({...diagnostic})) === true) return
    } catch { /* diagnostics never own recovery */ }
    this.#diagnostics.push(Object.freeze({...diagnostic}))
    if (this.#diagnostics.length > MAX_PENDING_CONNECTION_DIAGNOSTICS) {
      this.#diagnostics.splice(0, this.#diagnostics.length - MAX_PENDING_CONNECTION_DIAGNOSTICS)
    }
  }

  #flushDiagnostics() {
    while (this.#diagnostics.length > 0) {
      const diagnostic = this.#diagnostics[0]
      try {
        if (this.#sendDiagnostic(diagnostic) !== true) return
      } catch {
        return
      }
      this.#diagnostics.shift()
    }
  }

  #publishState(state) {
    try { this.#onState(state) } catch { /* presentation cannot own recovery */ }
  }
}

function validateConnection(connection) {
  if (!connection || typeof connection !== 'object'
    || typeof connection.endpoint !== 'string'
    || !tokenPattern.test(connection.token)) throw new TypeError('invalid backend connection')
  let endpoint
  try {
    endpoint = new URL(connection.endpoint)
  } catch {
    throw new TypeError('invalid backend connection')
  }
  if (endpoint.protocol !== 'ws:'
    || endpoint.hostname !== '127.0.0.1'
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || (endpoint.pathname !== '/' && endpoint.pathname !== '')) {
    throw new TypeError('invalid backend connection')
  }
}

function validCloseCode(code) {
  return Number.isInteger(code) && code >= 0 && code <= 4_999 ? code : 0
}

function closeReason(code) {
  return ({
    1000: 'normal',
    1001: 'going_away',
    1002: 'protocol_error',
    1003: 'unsupported_data',
    1006: 'abnormal',
    1008: 'policy',
    1009: 'message_too_big',
    1011: 'internal_error',
    4003: 'protocol_rejected',
    4009: 'client_unavailable',
  })[validCloseCode(code)] ?? 'other'
}
