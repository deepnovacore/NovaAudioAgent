import {randomBytes} from 'node:crypto'
import {WebSocket} from 'ws'

export const DEBUG_BOARD_PATH = '/debug-board'
export const DEBUG_BOARD_TIMEOUT_MS = 5_000
export const MAX_DEBUG_BOARD_RESPONSE_BYTES = 256 * 1024
const MAX_MEMORY_BOARD_EXPORT_BYTES = 1024 * 1024

const tokenPattern = /^[a-f0-9]{32}$/u
const requestIdPattern = /^debug-[a-f0-9]{16}$/u

export class DebugBoardClientError extends Error {
  constructor(code) {
    super(code)
    this.name = 'DebugBoardClientError'
    this.code = code
  }
}

export function requestDebugBoard(connection, request, {
  createSocket = (url, options) => new WebSocket(url, options),
  scheduleTimeout = globalThis.setTimeout.bind(globalThis),
  cancelTimeout = globalThis.clearTimeout.bind(globalThis),
  timeoutMs = DEBUG_BOARD_TIMEOUT_MS,
  randomId = () => `debug-${randomBytes(8).toString('hex')}`,
} = {}) {
  const endpoint = debugBoardEndpoint(connection)
  const normalized = normalizeRequest(request)
  const requestId = randomId()
  if (!requestIdPattern.test(requestId)) throw new TypeError('invalid debug board request id')
  if (typeof createSocket !== 'function'
    || typeof scheduleTimeout !== 'function'
    || typeof cancelTimeout !== 'function'
    || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0) throw new TypeError('invalid debug board client options')

  return new Promise((resolve, reject) => {
    let socket
    let timer = null
    let settled = false
    const settle = (error, payload) => {
      if (settled) return
      settled = true
      if (timer !== null) cancelTimeout(timer)
      if (socket) {
        socket.off?.('open', onOpen)
        socket.off?.('message', onMessage)
        socket.off?.('error', onError)
        socket.off?.('close', onClose)
      }
      if (error) reject(error)
      else resolve(payload)
    }
    const fail = code => {
      try { socket?.terminate?.() } catch { /* already gone */ }
      settle(new DebugBoardClientError(code))
    }
    const onOpen = () => {
      try {
        socket.send(JSON.stringify({type: 'hello', token: connection.token}))
        socket.send(JSON.stringify({
          type: 'debug.board.request',
          request_id: requestId,
          board: normalized.board,
          detail: normalized.detail,
        }))
      } catch {
        fail('unavailable')
      }
    }
    const onMessage = (data, isBinary) => {
      if (isBinary === true) return fail('invalid_response')
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (bytes.byteLength > MAX_DEBUG_BOARD_RESPONSE_BYTES) return fail('invalid_response')
      let payload
      try {
        payload = JSON.parse(bytes.toString('utf8'))
      } catch {
        return fail('invalid_response')
      }
      const expectedType = normalized.board === 'memory'
        ? 'memory.board'
        : 'workspace_graph.board'
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || payload.type !== expectedType
        || payload.request_id !== requestId) return fail('invalid_response')
      try { socket.close?.(1000, 'debug complete') } catch { /* response already owns success */ }
      settle(null, payload)
    }
    const onError = () => fail('unavailable')
    const onClose = () => {
      if (!settled) settle(new DebugBoardClientError('unavailable'))
    }
    timer = scheduleTimeout(() => fail('timeout'), timeoutMs)
    if (settled) {
      cancelTimeout(timer)
      return
    }
    try {
      socket = createSocket(endpoint, {
        perMessageDeflate: false,
        maxPayload: MAX_DEBUG_BOARD_RESPONSE_BYTES,
      })
      socket.once('open', onOpen)
      socket.on('message', onMessage)
      socket.once('error', onError)
      socket.once('close', onClose)
    } catch {
      fail('unavailable')
    }
  })
}

export function createDebugBoardRequester({request = requestDebugBoard} = {}) {
  if (typeof request !== 'function') throw new TypeError('invalid debug board requester')
  const byConnection = new WeakMap()
  return (connection, input) => {
    if (!connection || typeof connection !== 'object') {
      return Promise.reject(new DebugBoardClientError('unavailable'))
    }
    const normalized = normalizeRequest(input)
    let pending = byConnection.get(connection)
    if (!pending) {
      pending = new Map()
      byConnection.set(connection, pending)
    }
    const key = `${normalized.board}:${normalized.detail}`
    const active = pending.get(key)
    if (active) return active
    let operation
    try {
      operation = Promise.resolve(request(connection, normalized))
    } catch (error) {
      operation = Promise.reject(error)
    }
    const owned = operation.finally(() => {
      if (pending.get(key) === owned) pending.delete(key)
    })
    pending.set(key, owned)
    return owned
  }
}

export function formatMemoryBoardExport(snapshot, {now = () => new Date()} = {}) {
  if (!snapshot || !Array.isArray(snapshot.channels)
    || snapshot.diagnostics?.version !== 1
    || !Array.isArray(snapshot.diagnostics.records)
    || snapshot.diagnostics.records.length > 128
    || !snapshot.diagnostics.records.every(record => (
      record !== null
      && typeof record === 'object'
      && Number.isSafeInteger(record.seq)
      && record.seq > 0
      && Number.isFinite(record.ts)
      && typeof record.kind === 'string'
      && record.payload !== null
      && typeof record.payload === 'object'
      && !Array.isArray(record.payload)
    ))) return {error: 'invalid_payload'}
  const exportedAt = now().toISOString()
  const body = JSON.stringify({
    exported_at: exportedAt,
    channels: snapshot.channels,
    diagnostics: snapshot.diagnostics,
  }, null, 2)
  if (Buffer.byteLength(body, 'utf8') > MAX_MEMORY_BOARD_EXPORT_BYTES) {
    return {error: 'too_large'}
  }
  return {body, stamp: exportedAt.replace(/[:.]/g, '-')}
}

function debugBoardEndpoint(connection) {
  if (!connection || typeof connection !== 'object'
    || typeof connection.endpoint !== 'string'
    || !tokenPattern.test(connection.token)) throw new TypeError('invalid debug board connection')
  let endpoint
  try {
    endpoint = new URL(connection.endpoint)
  } catch {
    throw new TypeError('invalid debug board connection')
  }
  if (endpoint.protocol !== 'ws:'
    || endpoint.hostname !== '127.0.0.1'
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || (endpoint.pathname !== '/' && endpoint.pathname !== '')) {
    throw new TypeError('invalid debug board connection')
  }
  endpoint.pathname = DEBUG_BOARD_PATH
  return endpoint.toString()
}

function normalizeRequest(request) {
  if (!request || typeof request !== 'object'
    || !['memory', 'workspace_graph'].includes(request.board)
    || !['compact', 'full'].includes(request.detail)) {
    throw new TypeError('invalid debug board request')
  }
  return Object.freeze({board: request.board, detail: request.detail})
}
