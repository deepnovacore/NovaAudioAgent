import assert from 'node:assert/strict'
import {spawn, spawnSync} from 'node:child_process'
import {once} from 'node:events'
import {createServer} from 'node:https'
import {cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises'
import {basename, normalize, resolve} from 'node:path'
import {parseArgs} from 'node:util'
import {listPackage, statFile} from '@electron/asar'
import {WebSocket, WebSocketServer} from 'ws'
import {generateSmokeCertificate} from './smoke-tls.mjs'
import {expectedNativeResources} from './native-resource-contract.mjs'
import {candidateScratchParent, prepareWindowsSmokeHomeOwnership} from './windows-smoke-home.mjs'
import {normalizeSettings, saveSettings} from '../src/main/settings-store.mjs'

const product = 'Nova Audio Agent Desktop'
const native = /\.(node|dylib|dll|so(?:\.\d+)*)$/u
const timeoutMs = 30_000

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', timeout: 120_000, ...options})
  assert.equal(result.status, 0, `${basename(command)} failed: ${result.error?.code ?? result.stderr}`)
}

export async function inspectApplication(resourcesRoot, targetId) {
  const archive = resolve(resourcesRoot, 'app.asar')
  const files = listPackage(archive).map(path => path.replace(/^[/\\]/u, '').replaceAll('\\', '/'))
  assert.ok(files.includes('src/main/main.mjs'), 'packaged main missing')
  for (const path of files) {
    assert.ok(path !== '' && !path.split('/').some(part => part === '..' || part === '.' || part === ''), 'invalid ASAR path')
    const entry = statFile(archive, normalize(path))
    assert.ok(!entry.link, `ASAR link forbidden: ${path}`)
    if (entry.files) continue
    const allowed = path.startsWith('node_modules/sherpa-onnx/') || (path.startsWith('node_modules/') && native.test(path))
    assert.equal(Boolean(entry.unpacked), allowed, `ASAR unpack placement: ${path}`)
    if (entry.unpacked) {
      const status = await lstat(resolve(`${archive}.unpacked`, path))
      assert.ok(status.isFile() && !status.isSymbolicLink() && status.size === entry.size, `unpacked file missing: ${path}`)
    }
  }
  const unpackedRoot = `${archive}.unpacked`
  for (const path of await readdir(unpackedRoot, {recursive: true})) {
    const local = path.replaceAll('\\', '/')
    const status = await lstat(resolve(unpackedRoot, path))
    assert.ok(!status.isSymbolicLink(), `unpacked link forbidden: ${local}`)
    if (status.isDirectory()) continue
    assert.ok(files.includes(local) && statFile(archive, normalize(local)).unpacked, `unexpected unpacked file: ${local}`)
  }
  for (const resource of expectedNativeResources(targetId)) {
    const status = await lstat(resolve(resourcesRoot, resource.relative_path))
    assert.ok(status.isFile() && !status.isSymbolicLink() && status.size > 0, `native resource missing: ${resource.id}`)
  }
  const manifest = JSON.parse(await readFile(resolve(resourcesRoot, 'native-resources-v1.json'), 'utf8'))
  assert.equal(manifest.target, targetId, 'native manifest target mismatch')
}

async function provider(scratch) {
  const certificate = resolve(scratch, 'cert.pem')
  const privateKey = resolve(scratch, 'key.pem')
  await generateSmokeCertificate({certificate, privateKey})
  const server = createServer({
    cert: await readFile(certificate),
    key: await readFile(privateKey),
  })
  const sockets = new WebSocketServer({server})
  sockets.on('connection', socket => {
    socket.send(JSON.stringify({type: 'session.created', session: {id: 'release-smoke'}}))
    socket.on('message', data => {
      try {
        if (JSON.parse(data).type === 'session.update') socket.send(JSON.stringify({type: 'session.updated', session: {id: 'release-smoke'}}))
      } catch { socket.close() }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    certificate,
    endpoint: `wss://127.0.0.1:${server.address().port}/`,
    async close() {
      for (const socket of sockets.clients) socket.terminate()
      sockets.close()
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
    },
  }
}

export function readReadiness(stream) {
  return new Promise((done, reject) => {
    let text = ''
    const fail = () => { clearTimeout(timer); reject(new Error('backend readiness failed')) }
    const timer = setTimeout(fail, timeoutMs)
    stream.on('data', chunk => {
      text += chunk.toString()
      if (text.length > 4096) return fail()
      if (!text.includes('\n')) return
      try {
        const value = JSON.parse(text.split('\n')[0])
        assert.equal(value.type, 'ready')
        assert.match(value.token, /^[0-9a-f]{32}$/u)
        assert.match(value.endpoint, /^ws:\/\/127\.0\.0\.1:([0-9]{1,5})\/$/u)
        const port = new URL(value.endpoint).port
        assert.ok(Number(port) > 0 && Number(port) <= 65535)
        clearTimeout(timer)
        done(value)
      } catch { fail() }
    })
    stream.once('error', fail)
    stream.once('end', () => { if (!text.includes('\n')) fail() })
  })
}

async function authenticate({endpoint, token}) {
  const socket = new WebSocket(endpoint)
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('backend handshake timeout')), timeoutMs)
      const finish = error => { clearTimeout(timer); error ? reject(error) : done() }
      socket.once('error', finish)
      socket.once('close', () => finish(new Error('backend closed before handshake')))
      socket.once('open', () => socket.send(JSON.stringify({type: 'hello', token})))
      socket.on('message', data => {
        try { if (JSON.parse(data).type === 'desktop.ready') finish() } catch { finish(new Error('backend handshake invalid')) }
      })
    })
  } finally { socket.terminate() }
}

export async function prepareSmokeHome(home) {
  await mkdir(home, {mode: 0o700})
  prepareWindowsSmokeHomeOwnership({home, environment: process.env})
  await saveSettings(resolve(home, 'ambient-orb-settings.json'), normalizeSettings({pipelineMode: 'integrated', cascadedLlmProvider: 'qwen'}))
}

async function smoke(executable, scratch) {
  const home = resolve(scratch, 'home')
  await prepareSmokeHome(home)
  // Installed-backend acceptance uses only the loopback provider, never a host Codex or external tools.
  const capabilities = resolve(home, 'capabilities.json')
  await writeFile(capabilities, JSON.stringify({version: 1, modules: {
    coding: {enabled: false}, search: {enabled: false}, camera: {enabled: false}, knowledge: {enabled: false},
  }}))
  const mock = await provider(scratch)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|LANG|LC_.*|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR)$/iu.test(key)))
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
    NODE_EXTRA_CA_CERTS: mock.certificate,
    RELEASE_SMOKE: 'installed-candidate-v1',
    CAPABILITIES_CONFIG: capabilities,
    CODEX_BIN: resolve(home, 'unavailable-codex'),
    QWEN_REALTIME_URL: mock.endpoint,
    QWEN_REALTIME_MODEL: 'release-smoke-model',
    QWEN_REALTIME_VOICE: 'release-smoke-voice',
    CODEX_WORKSPACE: home,
    EXECUTOR: 'fast_sim', EXECUTORS: 'fast_sim',
    DASHSCOPE_API_KEY: 'public-release-smoke-key', MODEL_API_KEY: 'public-release-smoke-key',
    TAVILY_API_KEY: 'public-release-smoke-key',
  })
  const child = spawn(executable, [`--user-data-dir=${home}`, '--open-settings', ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : [])], {
    cwd: home, env, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32',
  })
  let output = ''
  let settingsOutput = ''
  let settingsReady
  const settingsLoaded = new Promise(resolveReady => { settingsReady = resolveReady })
  child.stdout.on('data', chunk => {
    output = (output + chunk).slice(-8192)
    settingsOutput = (settingsOutput + chunk).slice(-8192)
    if (settingsOutput.includes('[desktop-smoke] settings_ready\n')) settingsReady()
  })
  child.stderr.on('data', data => { output = (output + data).slice(-8192) })
  const exited = once(child, 'exit')
  // Register rejection immediately, including failed spawn before readiness arrives.
  exited.catch(() => {})
  let timer
  try {
    await Promise.race([
      (async () => {
        await Promise.all([authenticate(await readReadiness(child.stdio[3])), settingsLoaded])
        child.stdio[4].end('quit\n')
        const [code, signal] = await exited
        assert.equal(code, 0, `application exit: ${signal}`)
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('application smoke timeout')), 60_000) }),
    ])
  } catch (error) {
    // Emit bounded product diagnostics, never readiness tokens or user paths.
    const diagnostic = output.match(/\[(?:desktop|backend|runtime)-diagnostic\] [a-z_]+/gu)?.join(', ') ?? 'unavailable'
    throw new Error(`${error.message}; exit=${child.exitCode} signal=${child.signalCode}; diagnostic=${diagnostic}`)
  } finally {
    clearTimeout(timer)
    if (child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true})
      else { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
    }
    try {
      if (child.exitCode === null && child.signalCode === null) await exited
    } finally { await mock.close() }
  }
}

async function findApp(directory, depth = 0) {
  if (process.platform === 'darwin' && directory.endsWith('.app')) return directory
  const entries = await readdir(directory, {withFileTypes: true})
  const executable = process.platform === 'win32' ? `${product}.exe` : 'nova-audio-agent-desktop'
  if (process.platform !== 'darwin' && entries.some(entry => entry.name === executable)) return directory
  if (depth < 3) {
    for (const entry of entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))) {
      const found = await findApp(resolve(directory, entry.name), depth + 1)
      if (found) return found
    }
  }
  return null
}

export async function verifyRelease({app, artifact, distRoot, unsigned = false}) {
  const scratch = await realpath(await mkdtemp(resolve(candidateScratchParent(), 'nova-release-')))
  const install = resolve(scratch, 'install')
  const mount = resolve(scratch, 'dmg')
  await mkdir(install)
  let mounted = false
  let uninstall
  try {
    if (artifact) {
      artifact = resolve(artifact)
      if (artifact.endsWith('.dmg') && process.platform === 'darwin') {
        await mkdir(mount)
        run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, artifact]); mounted = true
        const bundled = await findApp(mount)
        assert.ok(bundled, 'DMG application not found')
        await cp(bundled, resolve(install, basename(bundled)), {recursive: true, verbatimSymlinks: true})
      } else if (artifact.endsWith('.zip')) {
        if (process.platform === 'darwin') run('/usr/bin/ditto', ['-x', '-k', artifact, install])
        else run('tar', ['-xf', artifact, '-C', install])
      } else if (artifact.endsWith('.exe') && process.platform === 'win32') {
        run(artifact, ['/S', `/D=${install}`], {windowsVerbatimArguments: true})
        uninstall = () => run(resolve(install, `Uninstall ${product}.exe`), ['/S'], {windowsVerbatimArguments: true})
      } else if (artifact.endsWith('.AppImage') && process.platform === 'linux') {
        run(artifact, ['--appimage-extract'], {cwd: install})
      } else if (artifact.endsWith('.deb') && process.platform === 'linux') {
        run('dpkg-deb', ['-x', artifact, install])
      } else throw new Error('unsupported artifact; provide an unpacked --app')
      app = await findApp(install)
    } else {
      app = app ? resolve(app) : await findApp(resolve(distRoot ?? resolve(import.meta.dirname, '../dist')))
      assert.ok(app, 'packaged application not found')
      const destination = resolve(install, basename(app))
      await cp(app, destination, {recursive: true, verbatimSymlinks: true})
      app = destination
    }
    assert.ok(app, 'installed application not found')
    const resources = resolve(app, process.platform === 'darwin' ? 'Contents/Resources' : 'resources')
    const executable = resolve(app, process.platform === 'darwin' ? `Contents/MacOS/${product}` : process.platform === 'win32' ? `${product}.exe` : 'nova-audio-agent-desktop')
    const targetId = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`
    await inspectApplication(resources, targetId)
    if (unsigned) process.stdout.write('signing verification skipped (--unsigned)\n')
    else if (process.platform === 'darwin') {
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
      run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app])
    } else if (process.platform === 'win32') {
      run('powershell.exe', ['-NoProfile', '-Command', 'if ((Get-AuthenticodeSignature -LiteralPath $env:NOVA_VERIFY_APPLICATION).Status -ne "Valid") { exit 1 }'], {env: {...process.env, NOVA_VERIFY_APPLICATION: executable}})
    } else throw new Error('signed verification unavailable for Linux; use --unsigned')
    await smoke(executable, scratch)
    process.stdout.write('release verification passed: ASAR/native placement and installed backend handshake\n')
  } finally {
    try { if (uninstall) uninstall() } finally {
      if (mounted) run('/usr/bin/hdiutil', ['detach', mount])
      await rm(scratch, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {app: {type: 'string'}, artifact: {type: 'string'}, 'dist-root': {type: 'string'}, unsigned: {type: 'boolean'}}})
  await verifyRelease({...values, distRoot: values['dist-root']})
}
