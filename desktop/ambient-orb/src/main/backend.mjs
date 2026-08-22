import { createServer } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { isAbsolute, posix, resolve, win32 } from 'node:path'

const MAX_READINESS_BYTES = 4096
const TOKEN_PATTERN = /^[a-f0-9]{32}$/
const READY_ENDPOINT_PATTERN = /^127\.0\.0\.1:([0-9]{1,5})$/
const NEWLINE = 0x0a

// Mirrors settings-store.mjs's DEFAULT_SETTINGS for the runtime-facing fields
// this module injects. Duplicated rather than imported: backend.mjs stays importable
// without the settings-store module (and its node:fs/node:crypto surface) ever
// loading, and a missing/corrupt settings file must never produce the literal
// string "undefined" in a child's environment.
const SETTINGS_DEFAULTS = Object.freeze({
  proactivity: 'balanced',
  codexHeartbeatSeconds: 30,
  pipelineMode: 'integrated',
  integratedProvider: 'qwen',
  integratedModel: 'qwen-audio-3.0-realtime-plus',
  integratedVoice: 'longanqian',
  cascadedEndpointingProvider: 'auto',
  cascadedAsrProvider: 'volcengine',
  cascadedLlmProvider: 'qwen',
  cascadedLlmModels: Object.freeze({
    qwen: 'qwen-flash',
    ark: 'doubao-seed-2-0-pro-260215',
  }),
  cascadedTtsProvider: 'volcengine',
  cascadedTtsVoice: 'zh_female_vv_uranus_bigtts',
})

// Duplicated from settings-store.mjs for the same reason SETTINGS_DEFAULTS is:
// this module stays importable on its own. Node refuses a C0 control character
// in a child's environment value and throws out of `spawn`, so a stored secret
// that somehow carries one must be dropped here rather than take the launch —
// and with it the app — down before the panel can clear it.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

// decryptedSecrets key -> env var name. Only a non-empty decrypted string maps
// to an override; an absent/empty key is omitted entirely so the user's own
// `.env` (or parent environment) keeps winning. Names match the Settings
// aliases in src/nova_audio_agent/config.py exactly.
const SECRET_ENV_MAP = Object.freeze({
  dashscopeApiKey: 'DASHSCOPE_API_KEY',
  tavilyApiKey: 'TAVILY_API_KEY',
  modelApiKey: 'NOVA_AUDIO_AGENT_MODEL_API_KEY',
  codexApiKey: 'NOVA_AUDIO_AGENT_CODEX_API_KEY',
  arkApiKey: 'ARK_API_KEY',
  doubaoBigmodelApiKey: 'DOUBAO_BIGMODEL_API_KEY',
  doubaoAsrApiKey: 'DOUBAO_ASR_API_KEY',
})

const ALWAYS_ACTIVE_SECRET_KEYS = Object.freeze([
  'tavilyApiKey',
  'modelApiKey',
  'codexApiKey',
])

/**
 * How long one connection may hold a file descriptor without authenticating.
 *
 * The readiness handshake is a single line the backend sends the instant it connects, so
 * three seconds is orders of magnitude more than the real client needs. Without a
 * per-socket bound, a client that connects and says nothing keeps its descriptor for the
 * whole global readiness timeout, and enough of them exhaust the table before the real
 * backend ever gets to dial.
 */
export const READINESS_SOCKET_AUTH_TIMEOUT_MS = 3000

/**
 * How long the backend gets to drain after the stdin-EOF sentinel before it is force killed.
 *
 * This has to outlast the teardown it is waiting on, not merely feel generous. The Python
 * side answers EOF with `assembly.stop()`, which runs the codex app-server shutdown:
 * INTERRUPT_GRACE (2s) for the in-flight turn plus EXIT_GRACE (5s) for the process tree to
 * go. Anything shorter SIGKILLs the backend *during* its own cleanup and orphans exactly the
 * codex tree it was reaping. 5 + 2 + 1s of margin.
 */
export const BACKEND_DRAIN_GRACE_MS = 8000

/**
 * Resolve the interpreter inside a virtualenv rooted at `venvDir`, per platform.
 *
 * `platform` is an explicit parameter (not read from `process.platform` inside
 * a shared `path` import) so the Windows branch is testable from any host: the
 * separators must follow the *target* platform, not the one running the test.
 */
export function venvPython(venvDir, platform = process.platform) {
  if (typeof venvDir !== 'string' || !venvDir) throw new Error('venvDir is required')
  return platform === 'win32'
    ? win32.join(venvDir, 'Scripts', 'python.exe')
    : posix.join(venvDir, 'bin', 'python')
}

/** Bare interpreter name to fall back on when no venv is configured. */
export function fallbackPython(platform = process.platform) {
  return platform === 'win32' ? 'python' : 'python3'
}

export function selectedBackend(env = process.env, { isPackaged = false } = {}) {
  const value = env?.NOVA_AUDIO_AGENT_BACKEND ?? (isPackaged ? 'node' : 'python')
  if (value !== 'python' && value !== 'node') {
    throw new Error('NOVA_AUDIO_AGENT_BACKEND must be python or node')
  }
  if (value === 'python' && isPackaged) {
    const error = new Error('source_rollback_unavailable')
    error.code = 'source_rollback_unavailable'
    throw error
  }
  return value
}

export function nodeRuntimeEntry({ isPackaged, appPath, packageRoot }) {
  if (typeof appPath !== 'string' || !isAbsolute(appPath)) {
    throw new Error('absolute Electron app path is required')
  }
  if (typeof packageRoot !== 'string' || !isAbsolute(packageRoot)) {
    throw new Error('absolute desktop package root is required')
  }
  return isPackaged
    ? resolve(
      appPath,
      'node_modules/@nova-audio-agent/runtime/dist/src/desktop-entry.js',
    )
    : resolve(packageRoot, '../../runtime/dist/src/desktop-entry.js')
}

export function backendLaunchSpec({
  backend = 'python',
  python,
  nodeEntry,
  workspace,
  token,
  readyEndpoint,
  parentEnv,
  settings,
  decryptedSecrets,
}) {
  if (backend !== 'python' && backend !== 'node') throw new Error('backend kind is invalid')
  if (backend === 'python' && (typeof python !== 'string' || !python)) {
    throw new Error('python is required')
  }
  if (backend === 'node' && (typeof nodeEntry !== 'string' || !isAbsolute(nodeEntry))) {
    throw new Error('absolute Node runtime entry is required')
  }
  if (typeof workspace !== 'string' || !workspace) throw new Error('workspace is required')
  if (!TOKEN_PATTERN.test(token)) throw new Error('128-bit token is required')
  const endpointMatch = typeof readyEndpoint === 'string'
    ? READY_ENDPOINT_PATTERN.exec(readyEndpoint)
    : null
  const endpointPort = endpointMatch ? Number(endpointMatch[1]) : 0
  if (endpointPort < 1 || endpointPort > 65535) {
    throw new Error('loopback readiness endpoint is required')
  }
  // Per-field fallback, not just a whole-object one: a partially-populated
  // settings object (or none at all, e.g. before the store's first write)
  // still resolves every field rather than handing the child `undefined`.
  const proactivity = settings?.proactivity ?? SETTINGS_DEFAULTS.proactivity
  const codexHeartbeatSeconds = settings?.codexHeartbeatSeconds
    ?? SETTINGS_DEFAULTS.codexHeartbeatSeconds
  const pipelineMode = settings?.pipelineMode ?? SETTINGS_DEFAULTS.pipelineMode
  const env = {
    ...parentEnv,
    NOVA_AUDIO_AGENT_DESKTOP_TOKEN: token,
    NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT: readyEndpoint,
    NOVA_AUDIO_AGENT_BACKEND: backend,
    NOVA_AUDIO_AGENT_CODEX_WORKSPACE: workspace,
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    NOVA_AUDIO_AGENT_PROACTIVITY_PRESET: proactivity,
    NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL: String(codexHeartbeatSeconds),
    NOVA_AUDIO_AGENT_PIPELINE_MODE: pipelineMode,
  }
  if (pipelineMode === 'cascaded') {
    const llmProvider = settings?.cascadedLlmProvider
      ?? SETTINGS_DEFAULTS.cascadedLlmProvider
    const rememberedModels = settings?.cascadedLlmModels
    const activeModel = rememberedModels?.[llmProvider]
      ?? SETTINGS_DEFAULTS.cascadedLlmModels[llmProvider]
      ?? SETTINGS_DEFAULTS.cascadedLlmModels.qwen
    Object.assign(env, {
      NOVA_AUDIO_AGENT_CASCADE_ENDPOINTING_PROVIDER: settings?.cascadedEndpointingProvider
        ?? SETTINGS_DEFAULTS.cascadedEndpointingProvider,
      NOVA_AUDIO_AGENT_CASCADE_ASR_PROVIDER: settings?.cascadedAsrProvider
        ?? SETTINGS_DEFAULTS.cascadedAsrProvider,
      NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: llmProvider,
      NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL: activeModel,
      NOVA_AUDIO_AGENT_CASCADE_TTS_PROVIDER: settings?.cascadedTtsProvider
        ?? SETTINGS_DEFAULTS.cascadedTtsProvider,
      NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE: settings?.cascadedTtsVoice
        ?? SETTINGS_DEFAULTS.cascadedTtsVoice,
    })
  } else {
    Object.assign(env, {
      NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER: settings?.integratedProvider
        ?? SETTINGS_DEFAULTS.integratedProvider,
      NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL: settings?.integratedModel
        ?? SETTINGS_DEFAULTS.integratedModel,
      NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE: settings?.integratedVoice
        ?? SETTINGS_DEFAULTS.integratedVoice,
    })
  }
  // The inherited fd-3 readiness pipe is gone: stdio stops at stderr and the
  // backend dials back instead, so a stale parent value must never imply one.
  delete env.NOVA_AUDIO_AGENT_DESKTOP_READY_FD
  // Overrides only: an absent, empty, or whitespace-only decrypted value
  // leaves the key out of `env` entirely, so whatever the launcher's own
  // `.env`/parent env supplied keeps winning. Never a replacement with an
  // empty (or effectively empty) string. Trimmed *before* the emptiness
  // check so a whitespace-only secret ("   ") can't slip through as truthy
  // and silently clobber a working parent value with something unusable —
  // and the value actually injected is the trimmed one, so accidental
  // surrounding whitespace in a pasted key is cleaned up too.
  if (decryptedSecrets && typeof decryptedSecrets === 'object') {
    const activeSecretKeys = new Set(ALWAYS_ACTIVE_SECRET_KEYS)
    if (pipelineMode === 'cascaded') {
      const llmProvider = settings?.cascadedLlmProvider
        ?? SETTINGS_DEFAULTS.cascadedLlmProvider
      activeSecretKeys.add(llmProvider === 'ark' ? 'arkApiKey' : 'dashscopeApiKey')
      activeSecretKeys.add('doubaoBigmodelApiKey')
      // Optional override only. When absent, the runtime falls back to the
      // big-model key; Main does not synthesize a duplicate secret value.
      activeSecretKeys.add('doubaoAsrApiKey')
    } else {
      activeSecretKeys.add('dashscopeApiKey')
    }
    for (const [secretKey, envName] of Object.entries(SECRET_ENV_MAP)) {
      if (!activeSecretKeys.has(secretKey)) continue
      const value = decryptedSecrets[secretKey]
      if (typeof value !== 'string') continue
      if (CONTROL_CHARACTERS.test(value)) continue
      const trimmed = value.trim()
      // A control character in the value would make Node reject the whole
      // spawn, so the key is dropped exactly like an empty one: the launch
      // proceeds, and whatever the parent environment holds keeps winning.
      if (trimmed) env[envName] = trimmed
    }
  }
  return backend === 'node'
    ? {
      kind: 'node',
      entry: nodeEntry,
      argv: [],
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    : {
      kind: 'python',
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
  socketAuthTimeoutMs = READINESS_SOCKET_AUTH_TIMEOUT_MS,
  onTimeout = () => {},
} = {}) {
  if (!TOKEN_PATTERN.test(token)) throw new Error('128-bit token is required')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('desktop readiness timeout is invalid')
  }
  if (!Number.isFinite(socketAuthTimeoutMs) || socketAuthTimeoutMs <= 0) {
    throw new Error('desktop readiness socket timeout is invalid')
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
    // Its own deadline, independent of the global one: an unauthenticated socket
    // is a held descriptor, and the real backend authenticates immediately. No
    // unref needed — the listener is closed on settle, which destroys the socket
    // and clears this through the 'close' handler below.
    const authDeadline = setTimeout(() => socket.destroy(), socketAuthTimeoutMs)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(authDeadline)
      sockets.delete(socket)
    })
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

/**
 * Route both ways a spawned backend can die onto one handler, and fail the handshake now.
 *
 * A child that ran and stopped emits 'exit'. A child that never ran at all — a missing or
 * unusable interpreter, i.e. ENOENT — emits 'error' *instead of* 'exit', and Node throws an
 * unlistened ChildProcess 'error' into the process, so an exit-only hook does not merely
 * miss the failure: it takes the Electron main process down with it.
 *
 * Either death means the backend will never dial back, so the pending handshake is closed
 * with the reason rather than left to sit out its full timeout. Closing after the handshake
 * already succeeded is a no-op, so `onExit` is also the live-backend death notification.
 * Fires `onExit` exactly once: Node is free to follow an 'error' with an 'exit', and one
 * death is one notification.
 */
export function watchBackendExit(child, { closeReadiness, onExit }) {
  let dead = false
  const die = reason => {
    if (dead) return
    dead = true
    exitedBackends.add(child)
    closeReadiness(new Error(reason))
    onExit(reason)
  }
  child.once('error', error => die(
    `desktop backend failed to spawn: ${error?.code || error?.message || 'unknown'}`,
  ))
  child.once('exit', () => die('desktop backend exited before readiness'))
}

// One drain per child, so a quit that re-enters (or a readiness timeout racing
// the quit) joins the sequence already in flight instead of starting a new one.
const drains = new WeakMap()
const exitedBackends = new WeakSet()

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
 * The grace is a ceiling, not a wait: the race resolves on the child's actual
 * exit, so an ordinary quit is as fast as the backend is.
 *
 * Resolves once the child is gone or has been force killed; never rejects, so a
 * `before-quit` handler can always reach `app.exit(0)`.
 */
export function shutdownBackend(
  child,
  { graceMs = BACKEND_DRAIN_GRACE_MS, platform = process.platform } = {},
) {
  const started = drains.get(child)
  if (started) return started
  const drained = new Promise(resolve => {
    const utility = typeof child.postMessage === 'function'
    // `!= null` deliberately: a live child reports null for both, so anything
    // else means it is already gone and nothing should wait out the grace.
    if (
      child.exitCode != null
      || child.signalCode != null
      || (utility && exitedBackends.has(child))
    ) {
      resolve()
      return
    }
    let timer
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      exitedBackends.add(child)
      clearTimeout(timer)
      resolve()
    }
    // Listen before signalling so an instant exit cannot be missed.
    child.once('exit', finish)
    // A destroyed/non-writable stdin throws ERR_STREAM_DESTROYED asynchronously
    // on end() — outside this promise, so it would surface as an uncaught
    // exception during quit instead of failing the shutdown gracefully.
    if (utility) child.postMessage({ type: 'nova.shutdown' })
    else if (child.stdin && child.stdin.writable && !child.stdin.destroyed) child.stdin.end()
    if (!utility && platform !== 'win32') child.kill('SIGTERM')
    timer = setTimeout(() => {
      if (utility) child.kill()
      else child.kill('SIGKILL')
      finish()
    }, graceMs)
    // 'exit' can fire synchronously above (reachable with test doubles), in
    // which case finish() already resolved before the timer existed to clear.
    if (settled) clearTimeout(timer)
  })
  drains.set(child, drained)
  return drained
}
