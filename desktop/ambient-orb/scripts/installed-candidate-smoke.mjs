import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {spawn, spawnSync} from 'node:child_process'
import {createServer as createHttpsServer} from 'node:https'
import {copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {isAbsolute, join, resolve, win32} from 'node:path'
import {fileURLToPath} from 'node:url'

import {WebSocket, WebSocketServer} from 'ws'

export const RELEASE_SMOKE_MODE = 'installed-candidate-v1'
export const CAMERA_CAPABILITY_PENDING = 'camera-file-integration: chromium_codec_unavailable'
export const CAMERA_CAPABILITY_PASSED_EXIT_CODE = 76
export const CAMERA_CAPABILITY_PENDING_EXIT_CODE = 75
export const SOURCE_ROLLBACK_UNAVAILABLE_EXIT_CODE = 78
export const SCRATCH_REMOVAL_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: 100,
  retryDelay: 50,
})

const DEFAULT_SIGNER_WORKFLOW = 'deepnovacore/NovaAudioAgent/.github/workflows/release-candidate.yml'
const SIGNER_WORKFLOWS = new Set([
  DEFAULT_SIGNER_WORKFLOW,
])

const TOKEN_PATTERN = /^[0-9a-f]{32}$/u
const READY_LIMIT = 4096
const OUTPUT_LIMIT = 64 * 1024
const OUTPUT_DRAIN_MS = 5_000
const SETTLE_MS = 30_000
const COMMON_CHILD_ENVIRONMENT = Object.freeze(['LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ'])
const PLATFORM_CHILD_ENVIRONMENT = Object.freeze({
  darwin: Object.freeze(['__CF_USER_TEXT_ENCODING', 'SECURITYSESSIONID']),
  linux: Object.freeze([
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE',
  ]),
  win32: Object.freeze(['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'SystemDrive']),
})

export function candidateInstallPlan({target, artifact, scratch}) {
  for (const value of [artifact, scratch]) {
    assert.ok(typeof value === 'string' && isAbsolute(value), 'installed_candidate_invalid')
  }
  const installRoot = resolve(scratch, 'install')
  const mountRoot = resolve(scratch, 'mount')
  const appName = 'Nova Audio Agent Ambient Orb.app'
  let executable
  let install
  let uninstall
  let residue
  if (target === 'darwin-arm64:app' || target === 'darwin-x64:app') {
    executable = resolve(installRoot, appName, 'Contents/MacOS/Nova Audio Agent Ambient Orb')
    install = [{op: 'spawn', command: '/usr/bin/ditto', args: ['-x', '-k', artifact, installRoot]}]
    uninstall = [{op: 'remove_tree', path: installRoot}]
    residue = installRoot
  } else if (target === 'darwin-arm64:dmg' || target === 'darwin-x64:dmg') {
    executable = resolve(mountRoot, appName, 'Contents/MacOS/Nova Audio Agent Ambient Orb')
    install = [{
      op: 'spawn',
      command: '/usr/bin/hdiutil',
      args: ['attach', '-nobrowse', '-readonly', '-mountpoint', mountRoot, artifact],
    }]
    uninstall = [{op: 'spawn', command: '/usr/bin/hdiutil', args: ['detach', mountRoot]}]
    residue = executable
  } else if (target === 'win32-x64:nsis') {
    executable = resolve(installRoot, 'Nova Audio Agent Ambient Orb.exe')
    install = [{op: 'spawn', command: artifact, args: ['/S', `/D=${installRoot}`]}]
    uninstall = [{
      op: 'spawn',
      command: resolve(installRoot, 'Uninstall Nova Audio Agent Ambient Orb.exe'),
      args: ['/S'],
    }]
    residue = installRoot
  } else if (target === 'linux-x64-gnu:appimage') {
    executable = resolve(installRoot, 'squashfs-root/AppRun')
    install = [
      {op: 'chmod', path: artifact, mode: 0o700},
      {op: 'spawn', command: artifact, args: ['--appimage-extract'], cwd: installRoot},
    ]
    uninstall = [{op: 'remove_tree', path: installRoot}]
    residue = installRoot
  } else if (target === 'linux-x64-gnu:deb') {
    executable = '/usr/bin/nova-ambient-orb'
    install = [{op: 'spawn', command: '/usr/bin/sudo', args: ['/usr/bin/dpkg', '-i', artifact]}]
    uninstall = [{
      op: 'spawn',
      command: '/usr/bin/sudo',
      args: ['/usr/bin/dpkg', '--purge', 'nova-audio-agent-ambient-orb'],
    }]
    residue = executable
  } else {
    throw new Error('installed_candidate_invalid')
  }
  return Object.freeze({
    target,
    executable,
    install: Object.freeze(install.map(value => Object.freeze(value))),
    uninstall: Object.freeze(uninstall.map(value => Object.freeze(value))),
    installRoot,
    mountRoot,
    residue: Object.freeze([residue]),
  })
}

export function smokeEnvironment({
  parentEnvironment,
  platform = process.platform,
  poisonPath,
  workspace,
  caCertificate,
  providerEndpoint,
  cameraFile,
  userDataRoot = workspace,
}) {
  const env = candidateBaseEnvironment({
    parentEnvironment,
    platform,
    userDataRoot,
    path: poisonPath,
  })
  Object.assign(env, {
    NODE_EXTRA_CA_CERTS: caCertificate,
    NOVA_AUDIO_AGENT_RELEASE_SMOKE: RELEASE_SMOKE_MODE,
    NOVA_AUDIO_AGENT_QWEN_REALTIME_URL: providerEndpoint,
    NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL: 'release-smoke-model',
    NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE: 'release-smoke-voice',
    NOVA_AUDIO_AGENT_CODEX_WORKSPACE: workspace,
    NOVA_AUDIO_AGENT_EXECUTOR: 'fast_sim',
    NOVA_AUDIO_AGENT_EXECUTORS: 'fast_sim',
    DASHSCOPE_API_KEY: 'public-release-smoke-key',
    NOVA_AUDIO_AGENT_MODEL_API_KEY: 'public-release-smoke-key',
    TAVILY_API_KEY: 'public-release-smoke-key',
    NOVA_ORB_OPAQUE: '1',
  })
  if (cameraFile !== undefined) env.NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE = cameraFile
  else delete env.NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE
  return env
}

export function candidateBaseEnvironment({
  parentEnvironment,
  platform = process.platform,
  userDataRoot,
  path,
}) {
  if (parentEnvironment === null || typeof parentEnvironment !== 'object'
    || !Object.hasOwn(PLATFORM_CHILD_ENVIRONMENT, platform)
    || typeof userDataRoot !== 'string' || typeof path !== 'string') {
    throw new Error('installed_candidate_invalid')
  }
  const env = {}
  for (const key of [...COMMON_CHILD_ENVIRONMENT, ...PLATFORM_CHILD_ENVIRONMENT[platform]]) {
    if (typeof parentEnvironment[key] === 'string') env[key] = parentEnvironment[key]
  }
  Object.assign(env, {
    PATH: path,
    HOME: userDataRoot,
    XDG_CONFIG_HOME: userDataRoot,
    XDG_CACHE_HOME: userDataRoot,
    XDG_DATA_HOME: userDataRoot,
    APPDATA: userDataRoot,
    LOCALAPPDATA: userDataRoot,
    TMPDIR: userDataRoot,
    TMP: userDataRoot,
    TEMP: userDataRoot,
  })
  if (platform === 'win32') {
    env.USERPROFILE = userDataRoot
    const systemRoot = env.SystemRoot ?? env.WINDIR
    if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\/u.test(systemRoot)) {
      throw new Error('installed_candidate_invalid')
    }
    env.PSModulePath = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`
  }
  return env
}

export function classifyCameraCapability(result) {
  if (result?.error !== undefined || result?.signal !== null) {
    throw new Error('installed_camera_smoke_failed')
  }
  if (result.status === CAMERA_CAPABILITY_PASSED_EXIT_CODE) {
    return Object.freeze({status: 'passed'})
  }
  if (result.status === CAMERA_CAPABILITY_PENDING_EXIT_CODE) {
    return Object.freeze({status: 'pending', result_code: 'chromium_codec_unavailable'})
  }
  throw new Error('installed_camera_smoke_failed')
}

export function classifySourceRollbackResult(result) {
  const stdout = Buffer.isBuffer(result?.stdout)
    ? result.stdout.toString('utf8')
    : result?.stdout
  if (result?.error !== undefined || result?.signal !== null
    || result?.status !== SOURCE_ROLLBACK_UNAVAILABLE_EXIT_CODE || stdout !== '') {
    throw new Error('installed_source_rollback_failed')
  }
  return Object.freeze({status: 'passed'})
}

export function sourceRollbackResultDiagnostic(result) {
  const status = Number.isInteger(result?.status) && result.status >= 0 && result.status <= 255
    ? String(result.status)
    : 'none'
  const presence = value => {
    if (Buffer.isBuffer(value)) return value.length === 0 ? 'empty' : 'set'
    if (typeof value === 'string') return value.length === 0 ? 'empty' : 'set'
    return value === undefined || value === null ? 'empty' : 'set'
  }
  const stderr = Buffer.isBuffer(result?.stderr)
    ? result.stderr.toString('utf8')
    : typeof result?.stderr === 'string' ? result.stderr : ''
  const stderrKind = stderr === ''
    ? 'empty'
    : stderr.includes('[desktop-diagnostic] source_rollback_unavailable')
      ? 'expected'
      : 'other'
  return `source_rollback_result_status_${status}`
    + `_error_${result?.error === undefined ? 'none' : 'set'}`
    + `_signal_${result?.signal === null ? 'none' : 'set'}`
    + `_stdout_${presence(result?.stdout)}_stderr_${stderrKind}`
}

export function canonicalSignerWorkflow(value = DEFAULT_SIGNER_WORKFLOW) {
  if (!SIGNER_WORKFLOWS.has(value)) throw new Error('installed_candidate_attestation_failed')
  return value
}

async function runInstalledCandidate({
  target,
  artifact,
  expectedSha256,
  commit,
  signerWorkflow,
  cameraFile,
  trustMode,
}) {
  requireHostTarget(target)
  const candidate = await exactCandidate(artifact, expectedSha256)
  if (trustMode === 'attested') requireCandidateAttestation(candidate, commit, signerWorkflow)
  else if (trustMode !== 'workflow-artifact') throw new Error('installed_candidate_attestation_failed')
  reportInstalledSmokeStage('candidate_verified')
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'nova-installed-candidate-')))
  const plan = candidateInstallPlan({target, artifact: candidate, scratch})
  const poisonPath = resolve(scratch, 'poison-path')
  const workspace = resolve(scratch, 'workspace')
  const userData = resolve(scratch, 'user-data')
  await Promise.all([
    mkdir(poisonPath, {mode: 0o700}),
    mkdir(workspace, {mode: 0o700}),
    mkdir(userData, {mode: 0o700}),
    mkdir(plan.installRoot, {recursive: true, mode: 0o700}),
    mkdir(plan.mountRoot, {recursive: true, mode: 0o700}),
  ])
  await installPoisonInterpreters(poisonPath)
  const systemEnvironment = candidateBaseEnvironment({
    parentEnvironment: process.env,
    platform: process.platform,
    userDataRoot: scratch,
    path: systemPath(process.platform, process.env),
  })
  const provider = await createQwenSmokeProvider()
  reportInstalledSmokeStage('provider_ready')
  let failure = null
  let cameraCapability = null
  let cleanupSafe = true
  try {
    await runActions(plan.install, systemEnvironment)
    reportInstalledSmokeStage('install_complete')
    const executable = await realpath(plan.executable)
    const status = await lstat(executable)
    assert.ok(status.isFile() && !status.isSymbolicLink(), 'installed_candidate_invalid')
    const environment = smokeEnvironment({
      parentEnvironment: process.env,
      poisonPath,
      workspace,
      userDataRoot: userData,
      caCertificate: provider.certificate,
      providerEndpoint: provider.endpoint,
      ...(cameraFile === undefined ? {} : {cameraFile: await exactCameraFile(cameraFile)}),
    })
    const child = spawn(executable, [`--user-data-dir=${userData}`], {
      cwd: workspace,
      env: environment,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    })
    await withCandidateProcessTree(child, environment, () => exerciseCandidateChild(child))
    reportInstalledSmokeStage('launch_complete')
    await runPackagedSourceRollback({
      executable,
      environment,
      workspace,
      userData: resolve(scratch, 'rollback-user-data'),
    })
    reportInstalledSmokeStage('source_rollback_complete')
    if (cameraFile !== undefined) {
      cameraCapability = await runPackagedCameraCapability({
        executable,
        environment,
        userData,
      })
      reportInstalledSmokeStage('camera_complete')
    }
  } catch (error) {
    failure = error
    if (error?.code === 'installed_candidate_tree_failed') cleanupSafe = false
  } finally {
    try {
      await provider.close()
      reportInstalledSmokeStage('provider_closed')
    } catch {
      failure ??= new Error('installed_candidate_provider_failed')
    }
    if (cleanupSafe) {
      try {
        await runActions(plan.uninstall, systemEnvironment)
        reportInstalledSmokeStage('uninstall_complete')
      } catch {
        failure ??= new Error('installed_candidate_uninstall_failed')
      }
      for (const residue of plan.residue) {
        try { await requireAbsent(residue) } catch {
          failure ??= new Error('installed_candidate_residue')
        }
      }
      try {
        await rm(scratch, SCRATCH_REMOVAL_OPTIONS)
        reportInstalledSmokeStage('cleanup_complete')
      } catch {
        failure ??= new Error('installed_candidate_residue')
      }
    }
  }
  if (failure !== null) {
    reportInstalledSmokeFailure(installedSmokeDiagnostic(failure))
    throw failure
  }
  return cameraCapability
}

async function runPackagedSourceRollback({executable, environment, workspace, userData}) {
  await mkdir(userData, {mode: 0o700})
  const rollbackEnvironment = {
    ...environment,
    NOVA_AUDIO_AGENT_BACKEND: 'python',
  }
  const result = spawnSync(executable, [`--user-data-dir=${userData}`], {
    cwd: workspace,
    env: rollbackEnvironment,
    detached: process.platform !== 'win32',
    windowsHide: true,
    encoding: 'utf8',
    timeout: SETTLE_MS,
    maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return withCandidateProcessTree(result, rollbackEnvironment, () => {
    try {
      return classifySourceRollbackResult(result)
    } catch (error) {
      reportInstalledSmokeStage(sourceRollbackResultDiagnostic(result))
      throw error
    }
  })
}

async function runPackagedCameraCapability({executable, environment, userData}) {
  const cameraEnvironment = {...environment}
  delete cameraEnvironment.NOVA_AUDIO_AGENT_RELEASE_SMOKE
  cameraEnvironment.NOVA_AUDIO_AGENT_RELEASE_CAMERA_SMOKE = 'installed-file-v1'
  const result = spawnSync(executable, [`--user-data-dir=${userData}`], {
    cwd: environment.NOVA_AUDIO_AGENT_CODEX_WORKSPACE,
    env: cameraEnvironment,
    detached: process.platform !== 'win32',
    windowsHide: true,
    encoding: 'utf8',
    timeout: SETTLE_MS,
    maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return withCandidateProcessTree(result, cameraEnvironment, () => {
    if (!Number.isInteger(result.pid)) throw new Error('installed_camera_smoke_failed')
    return classifyCameraCapability(result)
  })
}

async function runActions(actions, environment) {
  for (const action of actions) {
    if (action.op === 'remove_tree') {
      await rm(action.path, {recursive: true, force: true})
      continue
    }
    if (action.op === 'chmod') {
      const {chmod} = await import('node:fs/promises')
      await chmod(action.path, action.mode)
      continue
    }
    const result = spawnSync(action.command, action.args, {
      ...(action.cwd === undefined ? {} : {cwd: action.cwd}),
      env: environment,
      encoding: 'utf8', timeout: SETTLE_MS, maxBuffer: OUTPUT_LIMIT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error !== undefined || result.signal !== null || result.status !== 0) {
      throw new Error('installed_candidate_install_failed')
    }
  }
}

async function createQwenSmokeProvider() {
  const certificate = resolve(import.meta.dirname, 'release-smoke-cert.pem')
  const privateKey = resolve(import.meta.dirname, 'release-smoke-key.pem')
  const [cert, key] = await Promise.all([readFile(certificate), readFile(privateKey)])
  const server = createHttpsServer({cert, key})
  const sockets = new WebSocketServer({server, perMessageDeflate: false})
  sockets.on('connection', socket => {
    const sessionId = 'release-smoke-session'
    socket.send(JSON.stringify({type: 'session.created', session: {id: sessionId}}))
    socket.on('message', data => {
      let value
      try { value = JSON.parse(data.toString('utf8')) } catch { socket.close(); return }
      if (value?.type === 'session.update') {
        socket.send(JSON.stringify({type: 'session.updated', session: {id: sessionId}}))
      }
    })
  })
  await new Promise((resolveListening, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListening)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object', 'installed_candidate_provider_failed')
  return {
    certificate,
    endpoint: `wss://127.0.0.1:${address.port}/`,
    close: () => closeQwenSmokeProvider({server, sockets}),
  }
}

export function closeQwenSmokeProvider({server, sockets}, timeoutMs = 5_000) {
  if (server === null || typeof server !== 'object' || typeof server.close !== 'function'
    || sockets === null || typeof sockets !== 'object' || typeof sockets.close !== 'function'
    || sockets.clients === null || sockets.clients === undefined
    || typeof sockets.clients[Symbol.iterator] !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    return Promise.reject(new Error('installed_candidate_provider_failed'))
  }
  return new Promise((resolveClose, rejectClose) => {
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolveClose()
      else rejectClose(new Error('installed_candidate_provider_failed'))
    }
    const forceClose = () => {
      try {
        for (const socket of sockets.clients) socket.terminate()
      } catch {}
      try { server.closeAllConnections?.() } catch {}
      try { server.closeIdleConnections?.() } catch {}
      try { server.unref?.() } catch {}
    }
    const timer = setTimeout(() => {
      forceClose()
      finish(new Error('installed_candidate_provider_failed'))
    }, timeoutMs)
    try {
      for (const socket of sockets.clients) socket.terminate()
      // ws may withhold its callback while an upgraded socket is unwinding.
      // HTTP server closure is the owned-handle boundary, so do not chain it
      // behind that callback.
      sockets.close()
      server.close(error => {
        if (error) forceClose()
        finish(error)
      })
      server.closeAllConnections?.()
      server.closeIdleConnections?.()
    } catch (error) {
      forceClose()
      finish(error)
    }
  })
}

function reportInstalledSmokeStage(stage) {
  if (process.env.NOVA_RELEASE_SMOKE_DIAGNOSTICS !== '1') return
  try { process.stderr.write(`[installed-smoke] ${stage}\n`) } catch {}
}

function readReadiness(stream) {
  return new Promise((resolveReady, reject) => {
    let bytes = Buffer.alloc(0)
    const timer = setTimeout(() => reject(new Error('installed_candidate_readiness_failed')), SETTLE_MS)
    const fail = () => {
      clearTimeout(timer)
      reject(new Error('installed_candidate_readiness_failed'))
    }
    stream.on('data', chunk => {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)])
      if (bytes.length > READY_LIMIT) return fail()
      const newline = bytes.indexOf(0x0a)
      if (newline < 0) return
      clearTimeout(timer)
      try {
        const value = JSON.parse(bytes.subarray(0, newline).toString('utf8'))
        if (value?.type !== 'ready' || !TOKEN_PATTERN.test(value.token)
          || !/^ws:\/\/127\.0\.0\.1:[0-9]{1,5}\/$/u.test(value.endpoint)) throw new Error()
        resolveReady(Object.freeze({endpoint: value.endpoint, token: value.token}))
      } catch { fail() }
    })
    stream.once('error', fail)
    stream.once('close', () => { if (bytes.indexOf(0x0a) < 0) fail() })
  })
}

function authenticateAndExercise(readiness) {
  return new Promise((resolveExercise, reject) => {
    const socket = new WebSocket(readiness.endpoint)
    let ready = false
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('installed_candidate_socket_failed'))
    }, SETTLE_MS)
    const fail = () => {
      clearTimeout(timer)
      reject(new Error('installed_candidate_socket_failed'))
    }
    socket.once('open', () => socket.send(JSON.stringify({type: 'hello', token: readiness.token})))
    socket.on('message', (data, isBinary) => {
      if (isBinary) return fail()
      let value
      try { value = JSON.parse(data.toString('utf8')) } catch { return fail() }
      if (value?.type !== 'desktop.ready' || ready) return
      ready = true
      socket.send(JSON.stringify({type: 'speech.onset', speech_id: 'release-smoke'}), error => {
        clearTimeout(timer)
        if (error) fail()
        else {
          socket.close(1000)
          resolveExercise()
        }
      })
    })
    socket.once('error', fail)
    socket.once('close', () => { if (!ready) fail() })
  })
}

function settleExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({code: child.exitCode, signal: child.signalCode})
  }
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('installed_candidate_quit_failed')), SETTLE_MS)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveExit({code, signal})
    })
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('installed_candidate_launch_failed'))
    })
  })
}

function boundedOutput(child) {
  let rejectFailure
  let stderr = ''
  const failure = new Promise((resolveNever, reject) => { rejectFailure = reject })
  const done = new Promise(resolveOutput => {
    let size = 0
    let streams = 2
    let failed = false
    const fail = () => {
      if (failed) return
      failed = true
      rejectFailure(new Error('installed_candidate_output_failed'))
    }
    const finish = () => { if (--streams === 0) resolveOutput() }
    for (const [index, stream] of [child.stdout, child.stderr].entries()) {
      stream.on('data', chunk => {
        size += Buffer.byteLength(chunk)
        if (index === 1 && stderr.length < OUTPUT_LIMIT) {
          stderr += chunk.toString('utf8').slice(0, OUTPUT_LIMIT - stderr.length)
        }
        if (size > OUTPUT_LIMIT) fail()
      })
      stream.once('end', finish)
      stream.once('error', fail)
    }
  })
  return Object.freeze({
    done,
    failure,
    diagnostic: error => installedSmokeDiagnostic(error, {
      stderr,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    }),
  })
}

export async function exerciseCandidateChild(child) {
  const output = boundedOutput(child)
  try {
    const readiness = await Promise.race([readReadiness(child.stdio[3]), output.failure])
    await Promise.race([authenticateAndExercise(readiness), output.failure])
    child.stdio[4].end('quit\n')
    const exit = await Promise.race([settleExit(child), output.failure])
    if (exit.code !== 0 || exit.signal !== null) throw new Error('installed_candidate_launch_failed')
    await settleCandidateOutput(output)
  } catch (error) {
    reportInstalledSmokeFailure(output.diagnostic(error))
    throw error
  }
}

export function installedSmokeDiagnostic(error, child = {}) {
  const failures = []
  const seen = new Set()
  const visit = value => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (typeof value.message === 'string' && /^installed_[a-z0-9_]+$/u.test(value.message)
      && !failures.includes(value.message)) failures.push(value.message)
    if (Array.isArray(value.errors)) for (const nested of value.errors) visit(nested)
    visit(value.cause)
  }
  visit(error)
  const codes = []
  const stderr = typeof child.stderr === 'string' ? child.stderr : ''
  const pattern = /\[(?:backend|runtime|realtime|desktop)-diagnostic\]\s+([a-z][a-z0-9_]*_[a-z0-9_]+)/gu
  for (const match of stderr.matchAll(pattern)) {
    if (!codes.includes(match[1])) codes.push(match[1])
  }
  const state = Number.isInteger(child.exitCode)
    ? `exit_${child.exitCode}`
    : typeof child.signalCode === 'string' && /^[A-Z0-9]+$/u.test(child.signalCode)
      ? `signal_${child.signalCode}`
      : 'running'
  return `failure=${failures.join('+') || 'unknown'} child=${codes.join('+') || 'none'} state=${state}`
}

function reportInstalledSmokeFailure(diagnostic) {
  if (process.env.NOVA_RELEASE_SMOKE_DIAGNOSTICS !== '1') return
  try { process.stderr.write(`[installed-smoke] ${diagnostic}\n`) } catch {}
}

export async function settleCandidateOutput(output, timeoutMs = OUTPUT_DRAIN_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('installed_candidate_output_failed')
  }
  let timer
  const timeout = new Promise((resolveNever, reject) => {
    timer = setTimeout(() => reject(new Error('installed_candidate_output_failed')), timeoutMs)
  })
  try {
    await Promise.race([output.done, output.failure, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export async function withCandidateProcessTree(child, environment, operation) {
  let value
  let operationFailure = null
  try {
    value = await operation()
  } catch (error) {
    operationFailure = error
  }
  try {
    if (Number.isInteger(child?.pid)) await stopAndRequireTreeGone(child, environment)
  } catch (cleanupFailure) {
    const error = new Error('installed_candidate_tree_failed', {
      cause: operationFailure === null
        ? cleanupFailure
        : new AggregateError([operationFailure, cleanupFailure]),
    })
    error.code = 'installed_candidate_tree_failed'
    reportInstalledSmokeFailure(installedSmokeDiagnostic(error, {
      stderr: '',
      exitCode: child?.exitCode,
      signalCode: child?.signalCode,
    }))
    releaseCandidateChildHandles(child)
    throw error
  }
  if (operationFailure !== null) throw operationFailure
  return value
}

async function stopAndRequireTreeGone(child, environment) {
  const pid = child.pid
  const alreadyExited = Number.isInteger(child.status)
    || child.exitCode !== null && child.exitCode !== undefined
    || child.signal !== null && child.signal !== undefined
    || child.signalCode !== null && child.signalCode !== undefined
  if (!alreadyExited && process.platform === 'win32') terminateWindowsTree(pid, environment)
  else if (!alreadyExited) {
    try { process.kill(-pid, 'SIGKILL') } catch (error) {
      if (error?.code !== 'ESRCH') throw new Error('installed_candidate_tree_failed')
    }
  }
  if (child.exitCode === null && child.signalCode === null && typeof child.once === 'function') {
    await new Promise((resolveExit, rejectExit) => {
      const timer = setTimeout(() => rejectExit(new Error('installed_candidate_tree_failed')), 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolveExit()
      })
      child.once('error', () => {
        clearTimeout(timer)
        rejectExit(new Error('installed_candidate_tree_failed'))
      })
    })
  }
  if (process.platform !== 'win32') await requireTreeGone(pid, environment)
}

function terminateWindowsTree(pid, environment) {
  const plan = windowsTreeTermination(pid, environment)
  const result = spawnSync(plan.command, plan.args, {
    env: environment,
    encoding: 'utf8', timeout: 10_000, maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0 || result.error !== undefined || result.signal !== null) {
    throw new Error('installed_candidate_tree_failed')
  }
}

export function windowsTreeTermination(pid, environment) {
  const systemRoot = environment?.SystemRoot ?? environment?.WINDIR
  if (!Number.isInteger(pid) || pid < 1
    || typeof systemRoot !== 'string' || !/^[A-Za-z]:\\/u.test(systemRoot)) {
    throw new Error('installed_candidate_tree_failed')
  }
  return Object.freeze({
    command: win32.join(systemRoot, 'System32', 'taskkill.exe'),
    args: Object.freeze(['/PID', String(pid), '/T', '/F']),
  })
}

export function releaseCandidateChildHandles(child) {
  if (child === null || typeof child !== 'object') return
  if (Array.isArray(child.stdio)) {
    for (const stream of child.stdio) {
      try { stream?.destroy?.() } catch {}
      try { stream?.unref?.() } catch {}
    }
  }
  try { child.unref?.() } catch {}
}

async function requireTreeGone(pid, environment) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('installed_candidate_tree_failed')
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0) } catch (error) {
      if (error?.code === 'ESRCH') return
      if (error?.code !== 'EPERM') throw new Error('installed_candidate_tree_failed')
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error('installed_candidate_tree_failed')
}

function systemPath(platform, parentEnvironment) {
  if (platform === 'darwin') return '/usr/bin:/bin:/usr/sbin:/sbin'
  if (platform === 'linux') return '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  const systemRoot = parentEnvironment.SystemRoot ?? parentEnvironment.WINDIR
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\/u.test(systemRoot)) {
    throw new Error('installed_candidate_invalid')
  }
  return `${systemRoot}\\System32;${systemRoot};${systemRoot}\\System32\\Wbem`
}

async function requireAbsent(path) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      await stat(path)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error('installed_candidate_residue')
}

async function exactCandidate(input, expectedSha256) {
  if (typeof input !== 'string' || !isAbsolute(input) || !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
    throw new Error('installed_candidate_invalid')
  }
  const canonical = await realpath(input)
  const status = await lstat(input)
  if (canonical !== resolve(input) || status.isSymbolicLink() || !status.isFile()
    || status.size < 1 || status.size > 4 * 1024 * 1024 * 1024) {
    throw new Error('installed_candidate_invalid')
  }
  if (await digestFile(canonical) !== expectedSha256) throw new Error('installed_candidate_digest_failed')
  return canonical
}

function digestFile(path) {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256')
    import('node:fs').then(({createReadStream}) => {
      const input = createReadStream(path)
      input.once('error', reject)
      input.on('data', chunk => hash.update(chunk))
      input.once('end', () => resolveDigest(hash.digest('hex')))
    }, reject)
  })
}

function requireCandidateAttestation(candidate, commit, signerWorkflow) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('installed_candidate_attestation_failed')
  }
  const canonicalWorkflow = canonicalSignerWorkflow(signerWorkflow)
  const result = spawnSync('gh', [
    'attestation', 'verify', candidate,
    '--repo', 'deepnovacore/NovaAudioAgent',
    '--signer-workflow',
    canonicalWorkflow,
    '--source-digest', commit,
  ], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error('installed_candidate_attestation_failed')
  }
}

async function exactCameraFile(input) {
  if (typeof input !== 'string' || !isAbsolute(input)) throw new Error('installed_camera_smoke_failed')
  const canonical = await realpath(input)
  const status = await lstat(canonical)
  if (status.isSymbolicLink() || !status.isFile() || canonical !== resolve(input)) {
    throw new Error('installed_camera_smoke_failed')
  }
  return canonical
}

async function installPoisonInterpreters(root) {
  const names = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python', 'python3']
  await Promise.all(names.map(name => copyFile(process.execPath, resolve(root, name))))
}

function requireHostTarget(target) {
  const host = process.platform === 'darwin'
    ? `darwin-${process.arch}:`
    : process.platform === 'win32'
      ? `win32-${process.arch}:`
      : `linux-${process.arch}-gnu:`
  if (!target.startsWith(host)) throw new Error('installed_candidate_target_failed')
}

function parseCliOptions(argv, {attested}) {
  const values = new Map()
  const allowed = [
    '--target', '--artifact', '--sha256', '--sha256-file', '--camera-file',
    ...(attested ? ['--commit', '--signer-workflow'] : []),
  ]
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!allowed.includes(name)
      || value === undefined || values.has(name)) throw new Error('installed_candidate_usage_failed')
    values.set(name, value)
  }
  if (values.has('--sha256') === values.has('--sha256-file')) {
    throw new Error('installed_candidate_usage_failed')
  }
  for (const required of ['--target', '--artifact', ...(attested ? ['--commit'] : [])]) {
    if (!values.has(required)) throw new Error('installed_candidate_usage_failed')
  }
  if (attested) {
    values.set('--signer-workflow', canonicalSignerWorkflow(values.get('--signer-workflow')))
  }
  return values
}

export function cliOptions(argv) {
  return parseCliOptions(argv, {attested: true})
}

export function workflowArtifactCliOptions(argv) {
  return parseCliOptions(argv, {attested: false})
}

async function expectedSha256(values) {
  return values.has('--sha256-file')
    ? (await readFile(resolve(values.get('--sha256-file')), 'utf8')).replace(/\n$/u, '')
    : values.get('--sha256')
}

export async function runInstalledCandidateCli(argv) {
  const values = cliOptions(argv)
  return runInstalledCandidate({
    target: values.get('--target'),
    artifact: resolve(values.get('--artifact')),
    expectedSha256: await expectedSha256(values),
    commit: values.get('--commit'),
    signerWorkflow: values.get('--signer-workflow'),
    trustMode: 'attested',
    ...(values.has('--camera-file') ? {cameraFile: resolve(values.get('--camera-file'))} : {}),
  })
}

export async function runWorkflowArtifactCandidateCli(argv) {
  const values = workflowArtifactCliOptions(argv)
  return runInstalledCandidate({
    target: values.get('--target'),
    artifact: resolve(values.get('--artifact')),
    expectedSha256: await expectedSha256(values),
    trustMode: 'workflow-artifact',
    ...(values.has('--camera-file') ? {cameraFile: resolve(values.get('--camera-file'))} : {}),
  })
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  void (async () => {
    const camera = await runInstalledCandidateCli(process.argv.slice(2))
    if (camera?.status === 'pending') {
      process.stdout.write(`${CAMERA_CAPABILITY_PENDING}\n`)
      process.exitCode = 75
    } else {
      process.stdout.write('installed candidate smoke passed\n')
    }
  })().catch(() => {
    process.stderr.write('installed candidate smoke rejected\n')
    process.exitCode = 1
  })
}
