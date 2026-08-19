import assert from 'node:assert/strict'
import { resolve } from 'node:path'
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

function readBootstrap(socket) {
  return new Promise((resolveFrames, reject) => {
    const frames = []
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        reject(new Error('utility runtime sent an unexpected binary bootstrap frame'))
        return
      }
      frames.push(data.toString('utf8'))
      if (frames.length === 2) resolveFrames(frames)
    })
    socket.once('close', () => {
      if (frames.length < 2) reject(new Error('utility runtime closed before bootstrap'))
    })
  })
}

async function run() {
  const listener = createReadinessListener({ token: TOKEN, timeoutMs: 5000 })
  const packageRoot = resolve(import.meta.dirname, '..')
  const workspace = resolve(packageRoot, '../..')
  const spec = backendLaunchSpec({
    backend: 'node',
    nodeEntry: resolve(workspace, 'runtime/dist/src/desktop-entry.js'),
    workspace,
    token: TOKEN,
    readyEndpoint: await listener.endpoint,
    parentEnv: process.env,
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
    const bootstrap = readBootstrap(socket)
    socket.send(JSON.stringify({ type: 'hello', token: TOKEN }))
    assert.deepEqual(await bootstrap, [
      '{"type":"desktop.ready"}',
      '{"type":"codex.state","state":"idle"}',
    ])

    await shutdownBackend(child, { graceMs: 2000 })
    assert.equal(await exited, 0, diagnostics)
  } finally {
    listener.close()
    if (child.pid !== undefined) child.kill()
  }
}

await app.whenReady()
try {
  await run()
  process.stdout.write('Node utility runtime smoke passed\n')
  app.exit(0)
} catch (error) {
  console.error(error)
  app.exit(1)
}
