import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {parseEnv} from 'node:util'
import { app, utilityProcess } from 'electron'
import {mkdtempSync, rmSync} from 'node:fs'
import {createServer} from 'node:https'
import {randomBytes} from 'node:crypto'
import vm from 'node:vm'
import {WebSocketServer} from 'ws'
import {createBackendControl} from '../src/main/backend-control.mjs'
import {createBackendSupervisor} from '../src/main/backend-supervisor.mjs'
import {classifyBackendFailure, createBackendDiagnosticCollector} from '../src/main/backend-diagnostics.mjs'
import {readCapabilityDocument} from '../src/main/capabilities-settings.mjs'
import {requestDebugBoard} from '../src/main/debug-board-client.mjs'
import {validateBootstrap} from '../src/main/security.mjs'
import { WebSocket } from 'ws'
import {generateReleaseSmokeCertificate} from './release-smoke-certificate.mjs'
import {
  backendLaunchSpec,
  createReadinessListener,
  shutdownBackend,
  shutdownBackendBestEffort,
  watchBackendExit,
} from '../src/main/backend.mjs'

const TOKEN = 'abcdef0123456789abcdef0123456789'
const capabilityMode = process.argv.includes('--capability-status')
const memoryClearMode = capabilityMode && process.argv.includes('--memory-clear')
const ownedChildren = new Set()
let fixtureRoot, deadline
const trace = message => process.stderr.write(`[utility-capabilities] ${message}\n`)
function finish(code, error) {
  clearTimeout(deadline)
  if (error) console.error(error)
  for (const child of ownedChildren) child.kill()
  if (fixtureRoot) rmSync(fixtureRoot, {recursive: true, force: true})
  app.exit(code)
}
if (capabilityMode) {
  process.on('uncaughtException', error => finish(1, error))
  process.on('unhandledRejection', error => finish(1, error))
  deadline = setTimeout(() => finish(1, new Error('capability smoke exceeded 45 seconds')), 45_000)
  fixtureRoot = mkdtempSync('/private/tmp/nova-utility-capabilities-')
  app.setPath('userData', fixtureRoot)
  trace('isolated userData; waiting for app readiness')
} else {
  deadline = setTimeout(() => finish(1, new Error('utility smoke exceeded 30 seconds')), 30_000)
}

function openSocket(endpoint) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(endpoint)
    socket.once('open', () => resolveSocket(socket))
    socket.once('error', reject)
  })
}

function readBootstrap(socket, count) {
  return new Promise((resolveFrames, reject) => {
    const frames = []
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        reject(new Error('utility runtime sent an unexpected binary bootstrap frame'))
        return
      }
      frames.push(data.toString('utf8'))
      if (frames.length === count) resolveFrames(frames)
    })
    socket.once('close', () => {
      if (frames.length < count) reject(new Error('utility runtime closed before bootstrap'))
    })
  })
}

async function waitUntil(label, predicate, timeoutMs = 5_000) {
  const deadlineAt = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadlineAt) throw new Error(`${label} did not become true`)
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
}

function boardContains(snapshot, text) {
  return snapshot.channels.some(channel => channel.items.some(item => item.content.includes(text)))
}

function boardCleared(snapshot, oldText) {
  return !boardContains(snapshot, oldText)
    && snapshot.channels.every(channel => channel.items.length === 0 && channel.summary === null)
}

function sendUserFinal(peer, itemId, text) {
  peer.send(JSON.stringify({type: 'input_audio_buffer.speech_started', item_id: itemId}))
  peer.send(JSON.stringify({type: 'input_audio_buffer.speech_stopped', item_id: itemId}))
  peer.send(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: text,
  }))
}

async function exerciseMemoryClear(context, providerPeers) {
  await waitUntil('initial Qwen connection', () => providerPeers.length >= 1)
  const control = context.backendControl
  const connection = context.backendSupervisor.status().connection
  assert.ok(control)
  assert.ok(connection)
  const oldText = 'utility clear old turn'
  sendUserFinal(providerPeers[0], 'utility-clear-old', oldText)
  await waitUntil('old turn on memory board', async () => {
    const snapshot = await requestDebugBoard(connection, {board: 'memory', detail: 'full'})
    return boardContains(snapshot, oldText)
  })
  trace('memory-clear: old turn persisted')
  const clearResult = await control.request('conversation.clear', {}, {timeoutMs: 15_000})
  trace(`memory-clear: control result=${JSON.stringify(clearResult)}`)
  assert.deepEqual(clearResult, {cleared: true})
  await waitUntil('replacement Qwen connection', () => providerPeers.length >= 2)
  trace('memory-clear: replacement provider connected')
  let clearedSnapshot
  await waitUntil('cleared memory board', async () => {
    const snapshot = await requestDebugBoard(connection, {board: 'memory', detail: 'full'})
    if (!boardCleared(snapshot, oldText)) return false
    clearedSnapshot = snapshot
    return true
  })
  trace(`memory-clear: board cleared channels=${clearedSnapshot.channels.length}`)
  assert.equal(context.backendSupervisor.status().state, 'connected')
  const newText = 'utility clear new turn'
  sendUserFinal(providerPeers.at(-1), 'utility-clear-new', newText)
  await waitUntil('new turn on memory board', async () => {
    const snapshot = await requestDebugBoard(connection, {board: 'memory', detail: 'full'})
    return boardContains(snapshot, newText)
  })
  trace('memory-clear: new turn persisted')
  assert.equal(context.backendSupervisor.status().state, 'connected')
  return {clearResult, channelsAfterClear: clearedSnapshot.channels.length}
}

async function run() {
  const listener = createReadinessListener({ token: TOKEN, timeoutMs: 20_000 })
  const packageRoot = resolve(import.meta.dirname, '..')
  const workspace = resolve(packageRoot, '../..')
  const cascaded = process.argv.includes('--cascaded')
  const envIndex = process.argv.indexOf('--env-file')
  if (envIndex !== -1 && !process.argv[envIndex + 1]) throw new Error('env-file path is required')
  const file = envIndex === -1 ? {} : parseEnv(await readFile(process.argv[envIndex + 1], 'utf8'))
  const parentEnv = {...file, ...process.env}
  const {environmentContract} = await import('../../../runtime/dist/src/environment-contract.js')
  for (const entry of environmentContract) if (entry.owner.startsWith('retired_')) delete parentEnv[entry.name]
  const isolated = cascaded ? await mkdtemp(resolve(tmpdir(), 'nova-utility-cascaded-')) : null
  if (isolated) {
    await writeFile(resolve(isolated, 'capabilities.json'), JSON.stringify({version: 1, modules: {
      coding: {enabled: false}, camera: {enabled: false}, search: {enabled: false},
    }}))
    parentEnv.NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED = 'false'
  }
  const spec = backendLaunchSpec({
    backend: 'node',
    nodeEntry: resolve(workspace, 'runtime/dist/src/desktop-entry.js'),
    nodeResourcesPath: resolve(packageRoot, 'build'),
    workspace,
    token: TOKEN,
    readyEndpoint: await listener.endpoint,
    parentEnv,
    ...(isolated ? {settings: {
      pipelineMode: 'cascaded', cascadedLlmProvider: 'ark',
      capabilitiesConfigPath: resolve(isolated, 'capabilities.json'),
    }} : {}),
  })
  const child = utilityProcess.fork(spec.entry, spec.argv, {
    cwd: workspace,
    env: spec.env,
    stdio: spec.stdio,
    serviceName: 'Nova Runtime Smoke',
  })
  let diagnostics = ''
  child.stderr?.on('data', chunk => { diagnostics += chunk.toString('utf8') })
  const exited = new Promise(resolveExit => child.once('exit', resolveExit))

  try {
    const ready = await listener.readiness
    const socket = await openSocket(ready.endpoint)
    const bootstrap = readBootstrap(socket, cascaded ? 1 : 2)
    socket.send(JSON.stringify({ type: 'hello', token: TOKEN }))
    assert.deepEqual(await bootstrap, cascaded ? ['{"type":"desktop.ready"}'] : [
      '{"type":"desktop.ready"}',
      '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"idle"}',
    ])

    await shutdownBackend(child, { graceMs: 2000 })
    assert.equal(await exited, 0, diagnostics)
  } catch (error) {
    const diagnostic = diagnostics.match(/\[(?:runtime|desktop)-diagnostic\] [a-z_]+/u)?.[0] ?? 'unavailable'
    throw new Error(`utility_runtime_smoke_failed diagnostic=${diagnostic}`, {cause: error})
  } finally {
    listener.close()
    if (child.pid !== undefined) child.kill()
    if (isolated) await rm(isolated, {recursive: true, force: true})
  }
}

// Dummy-only native integration: actual main launch/supervisor bodies and compiled entry.
// No settings window, keychain, user project or external provider is opened.
async function runCapabilityStatus() {
  const root = fixtureRoot
  const packageRoot = resolve(import.meta.dirname, '..')
  const source = await readFile(resolve(packageRoot, 'src/main/main.mjs'), 'utf8')
  const launchSource = source.slice(source.indexOf('async function launchBackend('), source.indexOf('function initializeDesktopBootstrap('))
  const supervisorStart = source.indexOf('  backendSupervisor = createBackendSupervisor({')
  const supervisorSource = source.slice(supervisorStart, source.indexOf('\n  })', supervisorStart) + '\n  })'.length)
  let listed = 0, called = 0, providerConnections = 0
  const providerPeers = []
  const certificate = resolve(root, 'cert.pem'), privateKey = resolve(root, 'key.pem')
  await generateReleaseSmokeCertificate({certificate, privateKey})
  const cert = await readFile(certificate), key = await readFile(privateKey)
  const http = createServer({cert, key}, async (request, response) => {
    if (request.method !== 'POST') {response.writeHead(405); response.end(); return}
    let bytes = ''
    for await (const chunk of request) bytes += chunk
    const message = JSON.parse(bytes)
    if (!Object.hasOwn(message, 'id')) {response.writeHead(202); response.end(); return}
    let result
    if (message.method === 'initialize') result = {protocolVersion: '2025-03-26', capabilities: {tools: {}}, serverInfo: {name: 'fixture', version: '1'}}
    else if (message.method === 'tools/list') {
      listed++
      result = {tools: [{name: 'lookup.raw', description: 'Local fixture', inputSchema: {type: 'object', properties: {}}, annotations: {readOnlyHint: true}}]}
    } else {called++; result = {}}
    response.writeHead(200, {'content-type': 'application/json'})
    response.end(JSON.stringify({jsonrpc: '2.0', id: message.id, result}))
  })
  const wss = new WebSocketServer({noServer: true})
  http.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, peer => wss.emit('connection', peer)))
  wss.on('connection', peer => {
    providerConnections++
    providerPeers.push(peer)
    peer.send(JSON.stringify({type: 'session.created', session: {id: 'fixture-session'}}))
    peer.on('message', bytes => {
      if (JSON.parse(bytes.toString()).type === 'session.update') peer.send(JSON.stringify({type: 'session.updated', session: {id: 'fixture-session'}}))
    })
  })
  await new Promise(resolveListen => http.listen(0, '127.0.0.1', resolveListen))
  const port = http.address().port
  trace('loopback fixture listening')
  const outcomes = []
  try {
    for (const budget of [1, 24]) {
      const path = resolve(root, 'capabilities.json')
      const server = {transport: 'streamable-http', url: `https://127.0.0.1:${port}/mcp`, headers: {accept: 'application/json'},
        exposeTo: {frontbrain: true, codex: false}, tools: {'lookup.raw': {enabled: true}}}
      await writeFile(path, JSON.stringify({version: 1, frontbrainToolBudget: budget,
        modules: {search: {enabled: false}, coding: {enabled: false}, camera: {enabled: false}},
        mcpServers: {local: server, disabled: {...server, enabled: false}, malformed: {transport: 'invalid'}}}))
      trace(`starting budget=${budget}`)
      const events = [], snapshots = []
      let readinessTimeouts = 0
      let finishExit
      const exited = new Promise(resolveExit => {finishExit = resolveExit})
      const environment = {PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMPDIR: '/private/tmp',
        NOVA_AUDIO_AGENT_MODEL_API_KEY: 'dummy-model-key', NOVA_AUDIO_AGENT_MODEL_BASE_URL: `https://127.0.0.1:${port}`,
        DASHSCOPE_API_KEY: 'dummy-dashscope-key', NOVA_AUDIO_AGENT_QWEN_REALTIME_URL: `wss://127.0.0.1:${port}/qwen`,
        NOVA_AUDIO_AGENT_BLACKBOARD_PATH: resolve(root, 'blackboard.sqlite'), NOVA_AUDIO_AGENT_BLACKBOARD_OWNER_ID: 'utility-smoke',
        NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED: 'false', NODE_EXTRA_CA_CERTS: certificate}
      const context = vm.createContext({readCapabilityDocument, classifyBackendFailure, createBackendDiagnosticCollector, createBackendControl,
        createReadinessListener: options => createReadinessListener({...options, onTimeout: () => {
          readinessTimeouts++; trace('readiness timeout requests child cleanup'); options.onTimeout?.()
        }}), shutdownBackend, shutdownBackendBestEffort, watchBackendExit, validateBootstrap, backendLaunchSpec, randomBytes, resolve,
        process: {env: environment, cwd: () => root}, app: {isPackaged: false, getAppPath: () => packageRoot}, packageRoot,
        currentSettings: {capabilitiesConfigPath: path, pipelineMode: 'integrated'}, desktopConfig: {workspace: root, modelBaseUrl: `https://127.0.0.1:${port}`}, codexStatus: {status: 'ready'},
        settingsGeneration: 9, launchGeneration: 0, runtimeCapabilities: null, backendControl: null, backend: null, backendGeneration: 0,
        mainWindow: null, secretCodec: {}, decryptSecretsForSpawn: () => ({}), nodeRuntimeEntry: () => resolve(packageRoot, '../../runtime/dist/src/desktop-entry.js'),
        backendKind: 'node', smokeChannel: null, settingsApplyStatus: 'idle', backendStatus: {state: 'stopped', connection: null}, backendSupervisor: null,
        console: {error: trace}, sendToOrb: () => {},
        settingsView: () => ({runtime: context.runtimeCapabilities, backend: context.backendStatus.state}),
        sendToSettings: (_channel, value) => snapshots.push(structuredClone(value)),
        utilityProcess: {fork: (...args) => {
          const child = utilityProcess.fork(...args)
          ownedChildren.add(child)
          child.once('spawn', () => trace(`child spawned pid=${child.pid}`))
          let diagnosticBytes = 0
          child.stderr?.on('data', chunk => {
            if (diagnosticBytes < 4096) trace(chunk.toString('utf8').slice(0, 4096 - diagnosticBytes))
            diagnosticBytes += chunk.length
          })
          child.on('message', message => {if (message.type === 'nova.capabilities') events.push(message.status.state)})
          child.once('exit', code => {ownedChildren.delete(child); events.push('exit'); trace(`child exit=${code}`); finishExit(code)})
          return child
        }},
        createBackendSupervisor: options => createBackendSupervisor({...options, schedule: () => 1, cancel: () => {}}),
      })
      vm.runInContext(launchSource + '\n' + supervisorSource, context)
      try {
        await context.backendSupervisor.start()
        trace(`supervisor=${context.backendSupervisor.status().state}; events=${events.join(',')}`)
        const value = context.runtimeCapabilities
        assert.equal(value.toolCount, 2)
        assert.equal(value.toolBudget, budget)
        assert.equal(value.diskGeneration, 9)
        let memoryClear
        if (budget === 1) {
          await exited
          assert.equal(context.backendSupervisor.status().state, 'configuration_required')
          assert.equal(readinessTimeouts, 0)
          assert.equal(value.state, 'startup_failed')
          assert.deepEqual(events, ['startup_failed', 'exit'])
          assert.ok(snapshots.some(snapshot => snapshot.runtime?.state === 'startup_failed'))
        } else {
          assert.equal(context.backendSupervisor.status().state, 'connected')
          assert.equal(value.state, 'running')
          assert.ok(snapshots.some(snapshot => snapshot.runtime?.state === 'compiled'))
          assert.ok(snapshots.some(snapshot => snapshot.runtime?.state === 'running' && snapshot.backend === 'connected'))
          assert.deepEqual(value.servers.map(item => [item.name, item.status]), [['local', 'ok'], ['disabled', 'disabled'], ['malformed', 'failed']])
          memoryClear = memoryClearMode ? await exerciseMemoryClear(context, providerPeers) : undefined
          await context.backendSupervisor.stop()
          await exited
        }
        outcomes.push({budget, count: value.toolCount, state: value.state, events,
          publicStates: [...new Set(snapshots.map(snapshot => snapshot.runtime?.state).filter(Boolean))], readinessTimeouts, servers: value.servers,
          ...(memoryClear === undefined ? {} : {memoryClear})})
      } finally {await context.backendSupervisor.stop()}
    }
    assert.equal(listed, 2)
    assert.equal(called, 0)
    assert.equal(providerConnections, memoryClearMode ? 2 : 1)
    process.stdout.write(JSON.stringify({electron: process.versions.electron, outcomes, listed, toolCalls: called, providerConnections, dummyLoopbackOnly: true}) + '\n')
  } finally {
    for (const client of wss.clients) client.terminate()
    wss.close()
    http.closeAllConnections()
    await new Promise(resolveClose => http.close(resolveClose))
  }
}

// Let Electron finish evaluating the main module before it emits ready.
void app.whenReady().then(async () => {
  if (capabilityMode) trace('app ready')
  if (capabilityMode) await runCapabilityStatus()
  else await run()
  process.stdout.write('Node utility runtime smoke passed\n')
  finish(0)
}).catch(error => finish(1, error))
