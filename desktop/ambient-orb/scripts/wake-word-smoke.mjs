// Run with Node or Electron. PCM must be mono, 16 kHz, signed 16-bit little-endian.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {Worker} from 'node:worker_threads'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'

async function run() {
const {values} = parseArgs({options: {
  'model-root': {type: 'string'}, pcm: {type: 'string'},
  'expect-hits': {type: 'string'}, 'app-root': {type: 'string'}, realtime: {type: 'boolean'},
}})
assert.ok(values['model-root'] && values.pcm && values['expect-hits'],
  '--model-root DIR --pcm FILE --expect-hits N [--app-root unpacked-app-or-app.asar]')
const appRoot = values['app-root'] ?? resolve(import.meta.dirname, '..')
const pcm = Buffer.concat([await readFile(values.pcm), Buffer.alloc(32000)])
if (values.realtime) {
  const {WakeWordRuntime} = await import(pathToFileURL(resolve(appRoot, 'src/main/wake-word/runtime.mjs')))
  let hits = 0, offered = 0, accepted = 0
  const runtime = new WakeWordRuntime({modelRoot: resolve(values['model-root']), show: () => hits++})
  try {
    runtime.configure({wakeWordEnabled: true, autoHideSeconds: 0})
    const deadline = performance.now() + 150_000
    while (runtime.status === 'loading' && performance.now() < deadline) await delay(20)
    assert.equal(runtime.status, 'ready', 'model must become ready')
    const report = () => runtime.report({epoch: runtime.epoch, idle: true, activated: true, muted: false})
    report()
    assert.equal(runtime.sleep(), true)
    // Native capture supplies 10 ms frames. Pace independently of Worker replies.
    for (let i = 0; i < pcm.length && runtime.state === 'sleeping'; i += 320) {
      report(); offered++
      if (runtime.accept({epoch: runtime.epoch, pcm: pcm.subarray(i, i + 320)})) accepted++
      await delay(10)
    }
    await delay(150)
    assert.equal(runtime.status, 'ready', 'detector must remain healthy')
    assert.equal(hits, Number(values['expect-hits']))
    console.log(JSON.stringify({engine: 'sherpa-onnx', keyword: '你好星核', realtime: true,
      hits, offered, accepted, droppedFrames: runtime.droppedFrames, pcm: values.pcm, appRoot}))
  } finally { runtime.stop() }
  return
}
const worker = new Worker(pathToFileURL(resolve(appRoot, 'src/main/wake-word/worker.mjs')), {
  workerData: {modelRoot: resolve(values['model-root'])},
})
let resolveMessage
let rejectMessage
let hits = 0
const pending = () => new Promise((resolve, reject) => { resolveMessage = resolve; rejectMessage = reject })
worker.on('error', error => rejectMessage?.(error))
worker.on('message', message => {
  if (message.type === 'error') rejectMessage?.(new Error('wake worker failed'))
  if (message.type === 'detected') hits++
  if (message.type === 'ready' || message.type === 'consumed') resolveMessage?.()
})
const timeout = setTimeout(() => { rejectMessage?.(new Error('wake smoke timeout')) }, 150_000)
try {
  await pending()
  worker.postMessage({type: 'reset', epoch: 1})
  for (let i = 0; i < pcm.length; i += 640) {
    const consumed = pending()
    worker.postMessage({type: 'audio', epoch: 1, pcm: pcm.subarray(i, i + 640)})
    await consumed
  }
  assert.equal(hits, Number(values['expect-hits']))
  console.log(JSON.stringify({engine: 'sherpa-onnx', keyword: '你好星核', hits, pcm: values.pcm, appRoot}))
} finally {
  clearTimeout(timeout)
  await worker.terminate()
}
}

try { await run() }
catch (error) { console.error(error); process.exitCode = 1 }
finally {
  if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
    const {app} = await import('electron')
    app.exit(process.exitCode ?? 0)
  }
}
