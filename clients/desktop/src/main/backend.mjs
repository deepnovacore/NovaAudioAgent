import { createServer } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { CONTROL_CHARACTERS, RUNTIME_DEFAULTS as SETTINGS_DEFAULTS } from './settings-defaults.mjs'

const MAX_READINESS_BYTES = 4096
const TOKEN_PATTERN = /^[a-f0-9]{32}$/
const READY_ENDPOINT_PATTERN = /^127\.0\.0\.1:([0-9]{1,5})$/
const NEWLINE = 0x0a

// decryptedSecrets key -> env var name. Only a non-empty decrypted string maps
// to an override; an absent/empty key is omitted entirely so the user's own
// `.env` (or parent environment) keeps winning. Names match the Settings
// aliases accepted by the Node runtime configuration contract exactly.
export const SECRET_ENV_MAP = Object.freeze({
  composioApiKey: 'COMPOSIO_API_KEY',
  dashscopeApiKey: 'DASHSCOPE_API_KEY',
  stepfunApiKey: 'STEPFUN_API_KEY',
  openaiApiKey: 'OPENAI_API_KEY',
  geminiApiKey: 'GEMINI_API_KEY',
  tavilyApiKey: 'TAVILY_API_KEY',
  openrouterApiKey: 'OPENROUTER_API_KEY',
  modelApiKey: 'MODEL_API_KEY',
  codexApiKey: 'CODEX_API_KEY',
  arkApiKey: 'ARK_API_KEY',
  deepseekApiKey: 'DEEPSEEK_API_KEY',
  doubaoBigmodelApiKey: 'DOUBAO_BIGMODEL_API_KEY',
  doubaoAsrApiKey: 'DOUBAO_ASR_API_KEY',
})

// Main-only values and a separate public projection share the same precedence.
export function resolveSecretConfiguration(saved = {}, environment = {}, developmentEnv = {}) {
  const secrets = {}, secretsPresent = {}, secretSources = {}
  for (const [key, name] of Object.entries(SECRET_ENV_MAP)) {
    if (key === 'composioApiKey' && saved[key] === '') { secrets[key]=''; secretsPresent[key]=false; secretSources[key]='cleared'; continue }
    const candidates = key === 'composioApiKey' ? [['settings',saved[key]],['dotenv',developmentEnv[name]],['environment',environment[name]]] : [['dotenv', developmentEnv[name]], ['settings', saved[key]], ['environment', environment[name]]]
    const selected = candidates.find(([, value]) => typeof value === 'string' && value.trim() && !CONTROL_CHARACTERS.test(value))
    secretsPresent[key] = Boolean(selected)
    if (selected) {
      secrets[key] = selected[1].trim()
      secretSources[key] = selected[0]
    }
  }
  return {secrets, secretsPresent, secretSources}
}

const ALWAYS_ACTIVE_SECRET_KEYS = Object.freeze([
  'openrouterApiKey',
  'composioApiKey',
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
 * This has to outlast the teardown it is waiting on, not merely feel generous. The runtime
 * answers the drain request with `assembly.stop()`, which runs the codex app-server shutdown:
 * INTERRUPT_GRACE (2s) for the in-flight turn plus EXIT_GRACE (5s) for the process tree to
 * go. Blackboard commit and close each have a 10s RPC timeout. Allow those two
 * waits, the 7s Codex drain, and 5s for the other cleanup phases before force killing.
 */
export const BACKEND_DRAIN_GRACE_MS = 32000
export const BACKEND_FORCE_EXIT_CONFIRM_MS = 2000

export function selectedBackend(env = process.env, { isPackaged = false } = {}) {
  void isPackaged
  const value = env?.BACKEND ?? 'node'
  if (value === 'python') {
    const error = new Error('source_rollback_unavailable')
    error.code = 'source_rollback_unavailable'
    throw error
  }
  if (value !== 'node') throw new Error('BACKEND must be node')
  return value
}

export function nodeRuntimeEntry({ isPackaged, appPath, packageRoot, environment = process.env }) {
  if (typeof appPath !== 'string' || !isAbsolute(appPath)) {
    throw new Error('absolute Electron app path is required')
  }
  if (typeof packageRoot !== 'string' || !isAbsolute(packageRoot)) {
    throw new Error('absolute desktop package root is required')
  }
  const override = environment.DEV_BACKEND_ENTRY
  if (!isPackaged && override) {
    if (typeof override !== 'string' || !isAbsolute(override)) throw new Error('absolute development runtime entry is required')
    return override
  }
  return isPackaged
    ? resolve(
      appPath,
      'node_modules/@nova-audio-agent/runtime/dist/src/desktop-entry.js',
    )
    : resolve(packageRoot, '../../runtime/dist/src/desktop-entry.js')
}

export function searchProxyUrlFromRules(rules) {
  if (typeof rules !== 'string') return ''
  for (const rule of rules.split(';')) {
    const match = /^ *(PROXY|HTTPS) +([^ ;]+) *$/u.exec(rule)
    if (!match) continue
    const scheme = match[1] === 'HTTPS' ? 'https' : 'http'
    try {
      const url = new URL(`${scheme}://${match[2]}`)
      const portMatch = /:(\d{1,5})$/u.exec(match[2])
      const port = portMatch ? Number(portMatch[1]) : 0
      if (!url.hostname || port < 1 || port > 65535 || url.username || url.password) continue
      return `${scheme}://${match[2]}`
    } catch {
      continue
    }
  }
  return ''
}

export function backendLaunchSpec({
  nodeEntry,
  nodeResourcesPath,
  workspace,
  token,
  readyEndpoint,
  parentEnv,
  settings,
  decryptedSecrets,
  resolvedConfig,
  searchProxyUrl,
  newsLanguage = 'en',
  capabilitiesDocument,
}) {
  if (typeof nodeEntry !== 'string' || !isAbsolute(nodeEntry)) {
    throw new Error('absolute Node runtime entry is required')
  }
  if (typeof nodeResourcesPath !== 'string' || !isAbsolute(nodeResourcesPath)) {
    throw new Error('absolute Node resource root is required')
  }
  const effectiveWorkspace = resolvedConfig?.workspace ?? workspace
  if (typeof effectiveWorkspace !== 'string' || !effectiveWorkspace) {
    throw new Error('workspace is required')
  }
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
  const v4 = {
    CODEX_APPROVAL_MODE: settings?.codexApprovalMode
      ?? SETTINGS_DEFAULTS.codexApprovalMode,
    CLARIFICATION_DEPTH: settings?.clarificationDepth
      ?? SETTINGS_DEFAULTS.clarificationDepth,
    GENERATE_PLAN: String(settings?.generatePlan ?? SETTINGS_DEFAULTS.generatePlan),
    PLAN_READBACK: settings?.planReadback ?? SETTINGS_DEFAULTS.planReadback,
    PROGRESS_BUBBLES: settings?.progressBubbles
      ?? SETTINGS_DEFAULTS.progressBubbles,
    EMBEDDING_PROVIDER: settings?.embeddingProvider
      ?? SETTINGS_DEFAULTS.embeddingProvider,
  }
  const env = {
    ...parentEnv,
    DESKTOP_TOKEN: token,
    DESKTOP_READY_ENDPOINT: readyEndpoint,
    BACKEND: 'node',
    CODEX_WORKSPACE: effectiveWorkspace,
    EXECUTOR: 'codex',
    PROACTIVITY_PRESET: proactivity,
    CODING_PROGRESS_NARRATION: settings?.codingProgressNarration ?? 'smart',
    CODEX_WORKING_INTERVAL: String(codexHeartbeatSeconds),
    PROMPT_LANGUAGE: settings?.language ?? 'zh-CN',
    NEWS_LANGUAGE: newsLanguage === 'zh-CN' ? 'zh-CN' : 'en',
    PIPELINE_MODE: pipelineMode,
    CODEX_RESOURCES_PATH: nodeResourcesPath,
    ...v4,
    MEMORY_PRERECALL_ENABLED: String(settings?.memoryPrerecallEnabled ?? false),
    CONVERSATION_VISION_ENABLED: String(settings?.conversationVisionEnabled ?? false),
    MONITOR_CAMERA_DEVICE_ID: settings?.monitorCameraDeviceId ?? '',
  }
  for (const [name, value] of [
    ['WATCH_MODEL', settings?.watchModel ?? ''],
    ['PLANNER_MODEL', settings?.plannerModel ?? SETTINGS_DEFAULTS.plannerModel],
    ['EMBEDDING_MODEL', settings?.embeddingModel
      ?? SETTINGS_DEFAULTS.embeddingModel],
    ['CAPABILITIES_CONFIG', settings?.capabilitiesConfigPath
      ?? SETTINGS_DEFAULTS.capabilitiesConfigPath],
    ['KNOWLEDGE_PATH', settings?.knowledgePath ?? SETTINGS_DEFAULTS.knowledgePath],
  ]) {
    if (typeof value === 'string' && value) env[name] = value
  }
  if (env.CAPABILITIES_CONFIG && !env.CAPABILITIES_CONFIG.startsWith('~/')) {
    env.CAPABILITIES_CONFIG = resolve(env.CAPABILITIES_CONFIG)
  }
  const inheritedProxy = parentEnv.HTTPS_PROXY
    ?? parentEnv.https_proxy
    ?? parentEnv.HTTP_PROXY
    ?? parentEnv.http_proxy
  if (!inheritedProxy && typeof searchProxyUrl === 'string' && searchProxyUrl) {
    env.HTTPS_PROXY = searchProxyUrl
  }
  if (resolvedConfig && typeof resolvedConfig === 'object') {
    delete env.CODEX_BIN
    delete env.CODEX_PREFIX_ARGS
    delete env.CODEX_MANAGED_ROOT
    delete env.CODEX_PROJECT_STATE_ROOT
    delete env.MODEL_BASE_URL
    if (typeof resolvedConfig.codexBinaryPath === 'string' && resolvedConfig.codexBinaryPath) {
      env.CODEX_BIN = resolvedConfig.codexBinaryPath
    }
    if (Array.isArray(resolvedConfig.codexBinaryPrefixArgs)
      && resolvedConfig.codexBinaryPrefixArgs.length > 0) {
      env.CODEX_PREFIX_ARGS = JSON.stringify(
        resolvedConfig.codexBinaryPrefixArgs,
      )
    }
    if (typeof resolvedConfig.managedRoot === 'string' && resolvedConfig.managedRoot) {
      env.CODEX_MANAGED_ROOT = resolvedConfig.managedRoot
    }
    if (typeof resolvedConfig.stateRoot === 'string' && resolvedConfig.stateRoot) {
      env.CODEX_PROJECT_STATE_ROOT = resolvedConfig.stateRoot
    }
    if (typeof resolvedConfig.modelBaseUrl === 'string' && resolvedConfig.modelBaseUrl) {
      env.MODEL_BASE_URL = resolvedConfig.modelBaseUrl
    }
  }
  if (pipelineMode === 'cascaded') {
    const llmProvider = settings?.cascadedLlmProvider
      ?? SETTINGS_DEFAULTS.cascadedLlmProvider
    const rememberedModels = settings?.cascadedLlmModels
    const activeModel = rememberedModels?.[llmProvider]
      ?? SETTINGS_DEFAULTS.cascadedLlmModels[llmProvider]
      ?? SETTINGS_DEFAULTS.cascadedLlmModels.qwen
    Object.assign(env, {
      DOUBAO_ASR_VOICEPRINT_ENABLED: String(settings?.voiceprintEnabled === true && Boolean(settings?.voiceprintUploadUrl)),
      DOUBAO_ASR_VOICEPRINT_HEALTH_URL: settings?.voiceprintUploadUrl ? `${settings.voiceprintUploadUrl}/healthz` : '',
      DOUBAO_ASR_VOICEPRINT_ID: settings?.voiceprintId ?? '',
      DOUBAO_ASR_VOICEPRINT_NAME: settings?.voiceprintName ?? '',
      CASCADE_ENDPOINTING_PROVIDER: settings?.cascadedEndpointingProvider
        ?? SETTINGS_DEFAULTS.cascadedEndpointingProvider,
      GEMINI_ASR_MODEL: settings?.geminiAsrModel ?? SETTINGS_DEFAULTS.geminiAsrModel,
      GEMINI_TTS_MODEL: settings?.geminiTtsModel ?? SETTINGS_DEFAULTS.geminiTtsModel,
      GEMINI_TTS_VOICE: settings?.geminiTtsVoice ?? SETTINGS_DEFAULTS.geminiTtsVoice,
      CASCADE_ASR_PROVIDER: settings?.cascadedAsrProvider
        ?? SETTINGS_DEFAULTS.cascadedAsrProvider,
      CASCADE_LLM_PROVIDER: llmProvider,
      CASCADE_LLM_MODEL: activeModel,
      CASCADE_TTS_PROVIDER: settings?.cascadedTtsProvider
        ?? SETTINGS_DEFAULTS.cascadedTtsProvider,
      DOUBAO_TTS_VOICE: settings?.cascadedTtsVoice
        ?? SETTINGS_DEFAULTS.cascadedTtsVoice,
    })
  } else {
    const provider = settings?.integratedProvider ?? SETTINGS_DEFAULTS.integratedProvider
    const prefix = provider.toUpperCase()
    const providerDefaults = {openai: ['gpt-realtime-2.1-mini','marin'], gemini: ['gemini-3.8-live','Kore']}[provider]
    Object.assign(env, {
      INTEGRATED_PROVIDER: settings?.integratedProvider
        ?? SETTINGS_DEFAULTS.integratedProvider,
      [`${prefix}_REALTIME_MODEL`]:
        settings?.integratedModel ?? providerDefaults?.[0] ?? SETTINGS_DEFAULTS.integratedModel,
      [`${prefix}_REALTIME_VOICE`]:
        settings?.integratedVoice ?? providerDefaults?.[1] ?? SETTINGS_DEFAULTS.integratedVoice,
    })
  }
  // The inherited fd-3 readiness pipe is gone: stdio stops at stderr and the
  // backend dials back instead, so a stale parent value must never imply one.
  delete env.DESKTOP_READY_FD
  // Overrides only: an absent, empty, or whitespace-only decrypted value
  // leaves the key out of `env` entirely, so whatever the launcher's own
  // `.env`/parent env supplied keeps winning. Never a replacement with an
  // empty (or effectively empty) string. Trimmed *before* the emptiness
  // check so a whitespace-only secret ("   ") can't slip through as truthy
  // and silently clobber a working parent value with something unusable —
  // and the value actually injected is the trimmed one, so accidental
  // surrounding whitespace in a pasted key is cleaned up too.
  Object.assign(env, capabilityEnvironment(settings, decryptedSecrets, env, capabilitiesDocument))
  return {
    kind: 'node',
    entry: nodeEntry,
    argv: [],
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
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
  timeoutMs = 60_000,
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

export async function waitForBackendReadiness(child, readiness, diagnostic, stop = shutdownBackend) {
  try {
    return await readiness
  } catch {
    // No readiness is not proof of a permanent configuration problem. Preserve
    // explicit runtime diagnostics, but retry an otherwise unexplained timeout.
    const failure = diagnostic.failure('backend_start_timeout')
    try { await stop(child) } catch {
      throw Object.freeze({kind: 'unavailable', code: 'backend_stop_failed'})
    }
    throw failure
  }
}

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
 * Resolves only after the child has actually emitted `exit`. A successful kill
 * request is not proof that the process is gone: lifecycle callers must not
 * start a replacement or publish `stopped` until termination is observed.
 */
export function shutdownBackend(
  child,
  {
    graceMs = BACKEND_DRAIN_GRACE_MS,
    forceExitMs = BACKEND_FORCE_EXIT_CONFIRM_MS,
    platform = process.platform,
  } = {},
) {
  const started = drains.get(child)
  if (started) return started
  const drained = new Promise((resolve, reject) => {
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
    let graceTimer = null
    let forceTimer = null
    let settled = false
    const finish = () => {
      exitedBackends.add(child)
      if (settled) return
      settled = true
      clearTimeout(graceTimer)
      clearTimeout(forceTimer)
      resolve()
    }
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(graceTimer)
      clearTimeout(forceTimer)
      const error = new Error('backend termination unconfirmed')
      error.code = 'backend_termination_unconfirmed'
      reject(error)
    }
    // Listen before signalling so an instant exit cannot be missed.
    child.once('exit', finish)
    // A destroyed/non-writable stdin throws ERR_STREAM_DESTROYED asynchronously
    // on end() — outside this promise, so it would surface as an uncaught
    // exception during quit instead of failing the shutdown gracefully.
    try {
      if (utility) child.postMessage({ type: 'nova.shutdown' })
      else if (child.stdin && child.stdin.writable && !child.stdin.destroyed) child.stdin.end()
    } catch {}
    try {
      if (!utility && platform !== 'win32') child.kill('SIGTERM')
    } catch {}
    graceTimer = setTimeout(() => {
      try {
        if (utility) child.kill()
        else child.kill('SIGKILL')
      } catch {}
      if (settled) return
      forceTimer = setTimeout(fail, forceExitMs)
    }, graceMs)
    // 'exit' can fire synchronously above (reachable with test doubles), in
    // which case finish() already resolved before the timer existed to clear.
    if (settled) clearTimeout(graceTimer)
  })
  drains.set(child, drained)
  const forget = () => {
    if (drains.get(child) === drained) drains.delete(child)
  }
  void drained.then(forget, forget)
  return drained
}

/** Quit-only containment: lifecycle code must use the strict function above. */
export async function shutdownBackendBestEffort(child, options) {
  try {
    await shutdownBackend(child, options)
    return true
  } catch {
    return false
  }
}

/** Shared by registry validation and the actual child launch. */
export function capabilityEnvironment(settings, decryptedSecrets, parentEnv = {}, document) {
  const env = {...parentEnv}
  const pipelineMode = settings?.pipelineMode ?? SETTINGS_DEFAULTS.pipelineMode
  if (decryptedSecrets && typeof decryptedSecrets === 'object') {
    const activeSecretKeys = new Set(ALWAYS_ACTIVE_SECRET_KEYS)
    if (pipelineMode === 'cascaded') {
      const llmProvider = settings?.cascadedLlmProvider
        ?? SETTINGS_DEFAULTS.cascadedLlmProvider
      activeSecretKeys.add(llmProvider === 'qwen' ? 'dashscopeApiKey' : `${llmProvider}ApiKey`)
      activeSecretKeys.add((settings?.cascadedTtsProvider ?? 'volcengine') === 'gemini' ? 'geminiApiKey' : 'doubaoBigmodelApiKey')
      // Optional override only. When absent, the runtime falls back to the
      // big-model key; Main does not synthesize a duplicate secret value.
      activeSecretKeys.add((settings?.cascadedAsrProvider ?? 'volcengine') === 'gemini' ? 'geminiApiKey' : 'doubaoAsrApiKey')
      if ((settings?.cascadedAsrProvider ?? 'volcengine') === 'volcengine') activeSecretKeys.add('doubaoBigmodelApiKey')
    } else {
      const integrated = settings?.integratedProvider ?? 'qwen'
      activeSecretKeys.add(integrated === 'qwen' ? 'dashscopeApiKey' : `${integrated}ApiKey`)
      if (settings?.integratedProvider === 'stepfun') activeSecretKeys.add('dashscopeApiKey')
    }
    const search = document?.modules?.search
    const provider = parentEnv.SEARCH_PROVIDER?.trim() || search?.provider || 'tavily'
    const consumers = Object.values(document?.mcpServers ?? {}).filter(server => server?.enabled !== false)
    if (search?.enabled !== false && provider === 'mcp') {
      const preset = !parentEnv.SEARCH_MCP_URL?.trim() && search?.mcp?.url === undefined
      consumers.push({...search?.mcp, headers: search?.mcp?.headers ?? (preset ? {authorization: '${DASHSCOPE_API_KEY}'} : {})})
    }
    const references = JSON.stringify(consumers)
    if ((parentEnv.MEMORY_CONNECTION?.trim() || 'local') === 'local'
      || (document?.modules?.knowledge?.enabled === true
      && (settings?.embeddingProvider ?? 'dashscope') === 'dashscope')) activeSecretKeys.add('dashscopeApiKey')
    for (const [key, name] of Object.entries(SECRET_ENV_MAP)) {
      if (references.includes('${' + name + '}') || (search?.enabled !== false && provider === 'tavily' && search?.tavily?.apiKeyEnv === name)) activeSecretKeys.add(key)
    }
    for (const [secretKey, envName] of Object.entries(SECRET_ENV_MAP)) {
      if (!activeSecretKeys.has(secretKey)) continue
      const value = decryptedSecrets[secretKey]
      if (secretKey === 'composioApiKey' && value === '') { env[envName]=''; continue }
      if (typeof value !== 'string') continue
      if (CONTROL_CHARACTERS.test(value)) continue
      const trimmed = value.trim()
      // A control character in the value would make Node reject the whole
      // spawn, so the key is dropped exactly like an empty one: the launch
      // proceeds, and whatever the parent environment holds keeps winning.
      if (trimmed) env[envName] = trimmed
    }
  }
  return env
}
