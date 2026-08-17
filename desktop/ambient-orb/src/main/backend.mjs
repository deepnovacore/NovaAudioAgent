import { createServer } from 'node:net'
import { timingSafeEqual } from 'node:crypto'

const MAX_READINESS_BYTES = 4096
const TOKEN_PATTERN = /^[a-f0-9]{32}$/
const READY_ENDPOINT_PATTERN = /^127\.0\.0\.1:([0-9]{1,5})$/
const NEWLINE = 0x0a

export function backendLaunchSpec({ python, workspace, token, readyEndpoint, parentEnv }) {
  if (typeof python !== 'string' || !python) throw new Error('python is required')
  if (typeof workspace !== 'string' || !workspace) throw new Error('workspace is required')
  if (!TOKEN_PATTERN.test(token)) throw new Error('128-bit token is required')
  const endpointMatch = typeof readyEndpoint === 'string'
    ? READY_ENDPOINT_PATTERN.exec(readyEndpoint)
    : null
  const endpointPort = endpointMatch ? Number(endpointMatch[1]) : 0
  if (endpointPort < 1 || endpointPort > 65535) {
    throw new Error('loopback readiness endpoint is required')
  }
  const env = {
    ...parentEnv,
    NOVA_AUDIO_AGENT_DESKTOP_TOKEN: token,
    NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT: readyEndpoint,
    NOVA_AUDIO_AGENT_CODEX_WORKSPACE: workspace,
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
  }
  // The inherited fd-3 readiness pipe is gone: stdio stops at stderr and the
  // backend dials back instead, so a stale parent value must never imply one.
  delete env.NOVA_AUDIO_AGENT_DESKTOP_READY_FD
  return {
    command: python,
    argv: ['-m', 'nova_audio_agent.realtime.desktop'],
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }
}

export function parseReadiness(raw, token) {
  if (!TOKEN_PATTERN.test(token)) throw new Error('128-bit token is required')
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_READINESS_BYTES) {
    throw new Error('desktop readiness is too large')
  }
  let value
  try {
    value = JSON.parse(raw.trim())
  } catch {
    throw new Error('desktop readiness is invalid')
  }
  if (
    !value
    || typeof value !== 'object'
    || Object.keys(value).sort().join(',') !== 'host,port,token'
  ) {
    throw new Error('desktop readiness fields are invalid')
  }
  if (typeof value.token !== 'string') throw new Error('desktop readiness token is invalid')
  // Length first so timingSafeEqual never sees mismatched buffers, then a
  // constant-time compare so a wrong guess leaks nothing about the real token.
  const candidate = Buffer.from(value.token, 'utf8')
  const expected = Buffer.from(token, 'utf8')
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    throw new Error('desktop readiness token is invalid')
  }
  if (value.host !== '127.0.0.1') throw new Error('desktop readiness must use loopback')
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error('desktop readiness port is invalid')
  }
  return Object.freeze({
    host: value.host,
    port: value.port,
    endpoint: `ws://127.0.0.1:${value.port}/`,
  })
}

/**
 * Listen on an ephemeral loopback port for the backend's readiness dial-back.
 *
 * The listener must exist before the backend is spawned, so `endpoint` resolves
 * to the `127.0.0.1:<port>` string that goes into the child environment. Only
 * the first authenticated payload wins: it closes the listener, so every later
 * client is refused. Every rejected client is destroyed while the listener keeps
 * waiting, so one bad dialer cannot deny the real backend its handshake.
 */
export function createReadinessListener({
  token,
  timeoutMs = 15_000,
  onTimeout = () => {},
} = {}) {
  if (!TOKEN_PATTERN.test(token)) throw new Error('128-bit token is required')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('desktop readiness timeout is invalid')
  }

  const sockets = new Set()
  const server = createServer()
  let settled = false
  let timer
  let settleReadiness

  const readiness = new Promise((resolveReadiness, rejectReadiness) => {
    settleReadiness = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      shutdown()
      if (error) rejectReadiness(error)
      else resolveReadiness(value)
    }
  })
  // Keeps a close() before the handshake from surfacing as an unhandled
  // rejection; awaiting `readiness` still observes the failure.
  readiness.catch(() => {})

  const endpoint = new Promise((resolveEndpoint, rejectEndpoint) => {
    // `on`, not `once`: an unlistened 'error' would throw inside the Electron
    // main process, and both settles below are already one-shot.
    server.on('error', error => {
      rejectEndpoint(error)
      settleReadiness(error)
    })
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (!address || typeof address !== 'object') {
        const error = new Error('desktop readiness listener did not bind')
        rejectEndpoint(error)
        settleReadiness(error)
        return
      }
      resolveEndpoint(`127.0.0.1:${address.port}`)
    })
  })

  function shutdown() {
    if (server.listening) server.close()
    for (const socket of sockets) socket.destroy()
    sockets.clear()
  }

  server.on('connection', socket => {
    sockets.add(socket)
    let buffer = Buffer.alloc(0)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      const newline = buffer.indexOf(NEWLINE)
      if (newline < 0) {
        if (buffer.length > MAX_READINESS_BYTES) socket.destroy()
        return
      }
      const line = buffer.subarray(0, newline + 1).toString('utf8')
      socket.destroy()
      let ready
      try {
        ready = parseReadiness(line, token)
      } catch {
        return
      }
      settleReadiness(null, ready)
    })
  })

  timer = setTimeout(() => {
    onTimeout()
    settleReadiness(new Error('desktop readiness timed out'))
  }, timeoutMs)

  return {
    endpoint,
    readiness,
    // Closing before the handshake fails it: a caller that already knows the
    // backend is gone should not wait out the full timeout. Idempotent, so the
    // success path can close the listener without disturbing the result.
    close: (reason = new Error('desktop readiness listener closed')) => settleReadiness(reason),
  }
}

// One drain per child, so a quit that re-enters (or a readiness timeout racing
// the quit) joins the sequence already in flight instead of starting a new one.
const drains = new WeakMap()

/**
 * Shut the backend down on the stdin-EOF sentinel, escalating only if it hangs.
 *
 * Closing stdin is the portable half of the contract: the parent never writes
 * there, so the backend reads EOF as "drain and exit" on every platform. POSIX
 * additionally gets SIGTERM, which the backend's signal handlers route into the
 * same drain; Windows has no SIGTERM, and `kill()` there is an immediate
 * TerminateProcess — precisely the abrupt teardown the sentinel replaces. A
 * backend that has not exited within the grace window is killed outright.
 *
 * Resolves once the child is gone or has been force killed; never rejects, so a
 * `before-quit` handler can always reach `app.exit(0)`.
 */
export function shutdownBackend(child, { graceMs = 3000, platform = process.platform } = {}) {
  const started = drains.get(child)
  if (started) return started
  const drained = new Promise(resolve => {
    // `!= null` deliberately: a live child reports null for both, so anything
    // else means it is already gone and nothing should wait out the grace.
    if (child.exitCode != null || child.signalCode != null) {
      resolve()
      return
    }
    let timer
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    // Listen before signalling so an instant exit cannot be missed.
    child.once('exit', finish)
    // A destroyed/non-writable stdin throws ERR_STREAM_DESTROYED asynchronously
    // on end() — outside this promise, so it would surface as an uncaught
    // exception during quit instead of failing the shutdown gracefully.
    if (child.stdin && child.stdin.writable && !child.stdin.destroyed) child.stdin.end()
    if (platform !== 'win32') child.kill('SIGTERM')
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish()
    }, graceMs)
    // 'exit' can fire synchronously above (reachable with test doubles), in
    // which case finish() already resolved before the timer existed to clear.
    if (settled) clearTimeout(timer)
  })
  drains.set(child, drained)
  return drained
}
