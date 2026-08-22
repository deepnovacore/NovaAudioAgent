import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {spawn, spawnSync} from 'node:child_process'
import {createServer as createHttpsServer} from 'node:https'
import {copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {isAbsolute, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {WebSocket, WebSocketServer} from 'ws'

export const RELEASE_SMOKE_MODE = 'installed-candidate-v1'
export const CAMERA_CAPABILITY_PENDING = 'camera-file-integration: chromium_codec_unavailable'

const TOKEN_PATTERN = /^[0-9a-f]{32}$/u
const READY_LIMIT = 4096
const OUTPUT_LIMIT = 64 * 1024
const SETTLE_MS = 30_000

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
  poisonPath,
  workspace,
  caCertificate,
  providerEndpoint,
  cameraFile,
  userDataRoot = workspace,
}) {
  const env = {...parentEnvironment}
  for (const key of [
    'NOVA_AUDIO_AGENT_BACKEND', 'NOVA_AUDIO_AGENT_PYTHON', 'PYTHONPATH', 'PYTHONHOME',
    'VIRTUAL_ENV', 'CONDA_PREFIX', 'DASHSCOPE_API_KEY', 'NOVA_AUDIO_AGENT_MODEL_API_KEY',
    'NOVA_AUDIO_AGENT_CODEX_API_KEY', 'NOVA_AUDIO_AGENT_CODEX_BIN',
    'NOVA_AUDIO_AGENT_RELEASE_CAMERA_SMOKE',
  ]) delete env[key]
  Object.assign(env, {
    PATH: poisonPath,
    HOME: userDataRoot,
    XDG_CONFIG_HOME: userDataRoot,
    APPDATA: userDataRoot,
    LOCALAPPDATA: userDataRoot,
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
    NOVA_ORB_OPAQUE: '1',
  })
  if (cameraFile !== undefined) env.NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE = cameraFile
  else delete env.NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE
  return env
}

export function classifyCameraCapability(exitCode, stdout) {
  if (exitCode === 0 && stdout === '{"ok":true}\n') return Object.freeze({status: 'passed'})
  if (exitCode === 75 && stdout === `${CAMERA_CAPABILITY_PENDING}\n`) {
    return Object.freeze({status: 'pending', result_code: 'chromium_codec_unavailable'})
  }
  throw new Error('installed_camera_smoke_failed')
}

export function classifySourceRollbackResult(result) {
  const stdout = Buffer.isBuffer(result?.stdout)
    ? result.stdout.toString('utf8')
    : result?.stdout
  const stderr = Buffer.isBuffer(result?.stderr)
    ? result.stderr.toString('utf8')
    : result?.stderr
  const readiness = Buffer.isBuffer(result?.readiness)
    ? result.readiness
    : Buffer.from(result?.readiness ?? '')
  if (result?.error !== undefined || result?.signal !== null || result?.status !== 0
    || stdout !== ''
    || stderr !== '[desktop-diagnostic] source_rollback_unavailable\n'
    || readiness.length !== 0) {
    throw new Error('installed_source_rollback_failed')
  }
  return Object.freeze({status: 'passed'})
}

async function runInstalledCandidate({target, artifact, expectedSha256, commit, cameraFile}) {
  requireHostTarget(target)
  const candidate = await exactCandidate(artifact, expectedSha256)
  requireCandidateAttestation(candidate, commit)
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
  const provider = await createQwenSmokeProvider()
  let child
  let failure = null
  let cameraCapability = null
  try {
    await runActions(plan.install)
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
    child = spawn(executable, [`--user-data-dir=${userData}`], {
      cwd: workspace,
      env: environment,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    })
    const output = boundedOutput(child)
    const readiness = await readReadiness(child.stdio[3])
    await authenticateAndExercise(readiness)
    child.stdio[4].end('quit\n')
    const exit = await settleExit(child)
    if (exit.code !== 0 || exit.signal !== null) throw new Error('installed_candidate_launch_failed')
    await output
    await requireTreeGone(child.pid)
    await runPackagedSourceRollback({
      executable,
      environment,
      workspace,
      userData: resolve(scratch, 'rollback-user-data'),
    })
    if (cameraFile !== undefined) {
      cameraCapability = await runPackagedCameraCapability({
        executable,
        environment,
        userData,
      })
    }
  } catch (error) {
    failure = error
  }
  if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL')
  try { await provider.close() } catch {
    failure ??= new Error('installed_candidate_provider_failed')
  }
  try { await runActions(plan.uninstall) } catch {
    failure ??= new Error('installed_candidate_uninstall_failed')
  }
  for (const residue of plan.residue) {
    try { await requireAbsent(residue) } catch {
      failure ??= new Error('installed_candidate_residue')
    }
  }
  try { await rm(scratch, {recursive: true, force: true}) } catch {
    failure ??= new Error('installed_candidate_residue')
  }
  if (failure !== null) throw failure
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
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  })
  classifySourceRollbackResult({...result, readiness: result.output?.[3] ?? ''})
  await requireTreeGone(result.pid)
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
  if (result.error !== undefined || result.signal !== null || !Number.isInteger(result.pid)) {
    throw new Error('installed_camera_smoke_failed')
  }
  const capability = classifyCameraCapability(result.status, result.stdout)
  await requireTreeGone(result.pid)
  return capability
}

async function runActions(actions) {
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
    close: () => new Promise(resolveClose => {
      for (const socket of sockets.clients) socket.terminate()
      sockets.close(() => server.close(() => resolveClose()))
    }),
  }
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
  return new Promise((resolveOutput, reject) => {
    let size = 0
    let streams = 2
    const finish = () => { if (--streams === 0) resolveOutput() }
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => {
        size += Buffer.byteLength(chunk)
        if (size > OUTPUT_LIMIT) reject(new Error('installed_candidate_output_failed'))
      })
      stream.once('end', finish)
      stream.once('error', () => reject(new Error('installed_candidate_output_failed')))
    }
  })
}

async function requireTreeGone(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('installed_candidate_tree_failed')
  if (process.platform === 'win32') {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const script = `$root=${pid};$p=Get-CimInstance Win32_Process;`+
      '$ids=@($root);do{$n=@($p|?{$ids -contains $_.ParentProcessId}|% ProcessId|?{$ids -notcontains $_});$ids+= $n}while($n.Count);' +
      '$alive=@($p|?{$ids -contains $_.ProcessId});if($alive.Count){exit 1}'
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: OUTPUT_LIMIT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.status !== 0 || result.error !== undefined || result.signal !== null) {
      throw new Error('installed_candidate_tree_failed')
    }
    return
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0) } catch (error) {
      if (error?.code === 'ESRCH') return
      throw new Error('installed_candidate_tree_failed')
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error('installed_candidate_tree_failed')
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

function requireCandidateAttestation(candidate, commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('installed_candidate_attestation_failed')
  }
  const result = spawnSync('gh', [
    'attestation', 'verify', candidate,
    '--repo', 'deepnovacore/NovaAudioAgent',
    '--signer-workflow',
    'deepnovacore/NovaAudioAgent/.github/workflows/release-candidate.yml',
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

function cliOptions(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!['--target', '--artifact', '--sha256', '--sha256-file', '--commit', '--camera-file'].includes(name)
      || value === undefined || values.has(name)) throw new Error('installed_candidate_usage_failed')
    values.set(name, value)
  }
  if (values.has('--sha256') === values.has('--sha256-file')) {
    throw new Error('installed_candidate_usage_failed')
  }
  for (const required of ['--target', '--artifact', '--commit']) {
    if (!values.has(required)) throw new Error('installed_candidate_usage_failed')
  }
  return values
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  void (async () => {
    const values = cliOptions(process.argv.slice(2))
    const expectedSha256 = values.has('--sha256-file')
      ? (await readFile(resolve(values.get('--sha256-file')), 'utf8')).replace(/\n$/u, '')
      : values.get('--sha256')
    const camera = await runInstalledCandidate({
      target: values.get('--target'),
      artifact: resolve(values.get('--artifact')),
      expectedSha256,
      commit: values.get('--commit'),
      ...(values.has('--camera-file') ? {cameraFile: resolve(values.get('--camera-file'))} : {}),
    })
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
