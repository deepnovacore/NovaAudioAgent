import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {parseEnv} from 'node:util'
import { app, utilityProcess } from 'electron'
import { WebSocket } from 'ws'
import {
  backendLaunchSpec,
  createReadinessListener,
  shutdownBackend,
} from '../src/main/backend.mjs'

const TOKEN = 'abcdef0123456789abcdef0123456789'

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

// Do not block ESM entry evaluation on readiness: Electron must finish loading
// its entry before it can emit ready. Bound startup as well as the handshake.
const deadline = setTimeout(() => {
  process.stderr.write('Node utility runtime smoke timed out\n')
  app.exit(1)
}, 30_000)
void app.whenReady().then(async () => {
  try {
    await run()
    process.stdout.write('Node utility runtime smoke passed\n')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    clearTimeout(deadline)
  }
})
