import assert from 'node:assert/strict'
import {spawn, spawnSync} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, readFile, writeFile, stat, rm, realpath, open} from 'node:fs/promises'
import {createServer} from 'node:https'
import {createServer as createProbe} from 'node:net'
import {tmpdir} from 'node:os'
import {resolve, join, dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {WebSocket, WebSocketServer} from 'ws'
import {generateSmokeCertificate} from '../clients/desktop/scripts/smoke-tls.mjs'

// Exercise the installed package without a display, Electron or external providers.
const executable = resolve(process.argv[2])
const root = await mkdtemp(join(tmpdir(), 'nova-installed-server-'))
let child, provider, sockets
let output = ''
async function exchange(port, path, frame) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  const timer = setTimeout(() => socket.terminate(), 5000)
  try {
    await once(socket, 'open')
    const reply = once(socket, 'message')
    socket.send(JSON.stringify(frame))
    return JSON.parse(String((await reply)[0]))
  } finally { clearTimeout(timer); socket.terminate() }
}
try {
  const packageRoot = resolve(dirname(await realpath(executable)), '..')
  const {loadProjectNativeHostFromResources} = await import(pathToFileURL(join(packageRoot, 'runtime/dist/src/projects/project-native-resource.js')))
  const {loadCodexSandboxProbeFromResources} = await import(pathToFileURL(join(packageRoot, 'runtime/dist/src/executors/codex/production-host.js')))
  const nativeOptions = {resourcesPath: join(packageRoot, 'resources'), platform: process.platform, arch: process.arch, electronAbi: process.versions.modules}
  assert.ok(loadCodexSandboxProbeFromResources(nativeOptions), 'installed sandbox probe missing')
  const nativeHost = loadProjectNativeHostFromResources(nativeOptions)
  assert.ok(nativeHost, 'installed Node-API project host missing')
  for (const name of ['MANIFEST.json', 'speech-16k-s16le.pcm', 'silence-16k-s16le.pcm']) {
    assert.ok((await stat(join(packageRoot, 'resources/endpointing/volcengine-v1', name))).size > 0)
  }
  process.env.CODEX_RESOURCES_PATH = nativeOptions.resourcesPath
  const capability = await import(pathToFileURL(join(packageRoot, 'runtime/dist/src/realtime/volcengine/endpointing-capability.js')))
  // The probe unrefs its deadline; keep this standalone harness alive until it finishes.
  const keepalive = setInterval(() => {}, 1000)
  try {
    const endpointing = await capability.probeEndpointingCapability({
      signal: new AbortController().signal, cache: capability.createEndpointingCapabilityCache(),
    })
    assert.deepEqual(endpointing.vad, {available: true, reason: 'ready'}, 'installed VAD native unavailable')
  } finally {clearInterval(keepalive)}
  const lockFile = await open(join(root, 'project.lock'), 'wx', 0o600)
  try {
    const lease = nativeHost.nativeLocks.acquire(lockFile.fd)
    assert.equal(lease.status, 'acquired'); lease.release()
  } finally { await lockFile.close() }
  const certificate = join(root, 'cert.pem'), privateKey = join(root, 'key.pem')
  await generateSmokeCertificate({certificate, privateKey})
  provider = createServer({cert: await readFile(certificate), key: await readFile(privateKey)})
  sockets = new WebSocketServer({server: provider})
  sockets.on('connection', socket => {
    socket.send(JSON.stringify({type: 'session.created', session: {id: 'headless-smoke'}}))
    socket.on('message', data => {
      if (JSON.parse(String(data)).type === 'session.update') socket.send(JSON.stringify({type: 'session.updated', session: {id: 'headless-smoke'}}))
    })
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const probe = createProbe(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(done => probe.close(done))
  const capabilities = join(root, 'capabilities.json')
  await writeFile(capabilities, JSON.stringify({version: 1, modules: Object.fromEntries(['coding', 'search', 'camera', 'knowledge'].map(name => [name, {enabled: false}]))}))
  const tokenFile = join(root, 'token')
  const envFile = join(root, 'server.env')
  const settings = {
    SERVER_PORT: String(port), SERVER_TOKEN_FILE: tokenFile,
    QWEN_REALTIME_URL: `wss://127.0.0.1:${provider.address().port}/`,
    CAPABILITIES_CONFIG: capabilities,
    CODEX_WORKSPACE: root, EXECUTORS: 'fast_sim', EXECUTOR: 'fast_sim',
    DASHSCOPE_API_KEY: 'smoke-key', TAVILY_API_KEY: 'smoke-key',
  }
  await writeFile(envFile, Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'), {mode: 0o600})
  const env = {PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', NODE_EXTRA_CA_CERTS: certificate}
  const run = args => spawnSync(executable, ['--env-file', envFile, ...args], {env, encoding: 'utf8', timeout: 15000})
  assert.equal(run(['token-init']).status, 0)
  const token = (await readFile(tokenFile, 'utf8')).trim()
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600)
  assert.equal(run(['token-init']).status, 2, 'must not replace a credential')
  assert.equal((await readFile(tokenFile, 'utf8')).trim(), token)
  child = spawn(executable, ['--env-file', envFile, 'start'], {env, stdio: ['ignore', 'pipe', 'pipe']})
  const exited = once(child, 'exit')
  child.stdout.on('data', bytes => {output += bytes})
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('headless readiness timeout')), 30000)
    child.once('error', error => {clearTimeout(timeout); reject(error)})
    child.once('exit', () => {clearTimeout(timeout); reject(new Error('headless exited before readiness'))})
    child.stderr.on('data', bytes => {
      output += bytes
      if (output.includes('[server-ready]')) {clearTimeout(timeout); done()}
    })
  })
  const invitation = await exchange(port, '/client/pair-admin', {type: 'pair.create', token, server: 'wss://example.test'})
  assert.equal(invitation.type, 'nova.pair')
  const device = await exchange(port, '/client/pair', {type: 'pair.redeem', code: invitation.code, device_name: 'package-smoke'})
  assert.equal(device.type, 'pair.ready')
  assert.equal((await exchange(port, '/client/pair', {type: 'pair.redeem', code: invitation.code, device_name: 'replay'})).type, 'pair.error')
  const ready = await exchange(port, '/client/v1', {type: 'hello', token: device.token, protocol_version: 1})
  assert.equal(ready.type, 'client.ready')
  assert.equal(ready.input_audio.sample_rate, 16000)
  assert.equal(run(['pair', 'wss://example.test']).status, 2, 'redirected QR output must be rejected')
  // util-linux script gives the pairing command a real PTY in Linux CI.
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const qr = spawn('script', ['-qefc', `stty cols 160; exec ${quote(executable)} --env-file ${quote(envFile)} pair wss://127.0.0.1:${port}`, '/dev/null'], {env, stdio: ['pipe', 'pipe', 'pipe']})
  let qrOutput = '', cancelled = false
  const qrTimeout = setTimeout(() => qr.kill('SIGTERM'), 15000)
  qr.stdout.on('data', bytes => {
    qrOutput += bytes
    if (!cancelled && qrOutput.includes('Ctrl+C')) {cancelled = true; qr.stdin.write('\x03')}
  })
  try {
    assert.equal((await once(qr, 'exit'))[0], 0, 'interactive QR must cancel cleanly')
    assert.ok(cancelled && qrOutput.includes('\x1b[47m'), 'terminal QR missing')
  } finally {clearTimeout(qrTimeout); qr.kill('SIGTERM')}
  assert.equal((await exchange(port, '/client/v1', {type: 'hello', token: device.token, protocol_version: 1})).type, 'client.ready', 'QR cancellation must leave the host running')
  child.kill('SIGTERM')
  assert.equal((await exited)[0], 0)
  assert.ok(!output.includes(token) && !output.includes(device.token))
  console.log('installed headless package passed: native probe/project lock/VAD, no display/stdin, private credentials, one-use pairing, interactive QR cancellation, client handshake, SIGTERM cleanup')
} catch (error) {
  console.error(output.replace(/[a-f0-9]{32}/g, '[redacted]').slice(-4000))
  throw error
} finally {
  if (child?.exitCode === null) child.kill('SIGKILL')
  if (sockets) {for (const socket of sockets.clients) socket.terminate(); sockets.close()}
  if (provider?.listening) await new Promise(done => provider.close(done))
  await rm(root, {recursive: true, force: true})
}
