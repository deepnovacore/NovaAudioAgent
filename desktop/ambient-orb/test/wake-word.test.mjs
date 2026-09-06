import test from 'node:test'
import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WakeWordRuntime } from '../src/main/wake-word/runtime.mjs'
import { WakeAudioRouter } from '../src/renderer/wake-audio.mjs'
import { normalizeSettings, applySettingsUpdate, orbSettings } from '../src/main/settings-store.mjs'

class Worker extends EventEmitter {
  messages = []
  postMessage(value) { this.messages.push(value) }
  terminations = 0
  terminate() { this.terminations++ }
}
function setup() {
  let now = 0
  let shown = 0
  let hidden = 0
  const runtime = new WakeWordRuntime({modelRoot: '/unused', WorkerClass: Worker,
    now: () => now, show: () => shown++, hide: () => hidden++})
  runtime.configure({wakeWordEnabled: true, autoHideSeconds: 60})
  const worker = runtime.worker
  worker.emit('message', {type: 'ready'})
  const report = (idle = true, muted = false) => { runtime.lastIdle = idle; return runtime.report({idle, muted, activated: true, epoch: runtime.epoch}) }
  return {runtime, worker, report, time: value => { while (now + 1000 < value) { now += 1000; report(runtime.lastIdle ?? true) }; now = value }, shown: () => shown, hidden: () => hidden}
}
test('sleep waits for settled work, heartbeat and model; duplicate/stale detections cannot wake', () => {
  const s = setup()
  s.report(); s.time(59000); s.report(false); s.time(60000); s.report()
  assert.equal(s.runtime.state, 'active')
  s.time(119000); s.report(); assert.equal(s.hidden(), 0)
  s.time(120000); s.report(); assert.equal(s.hidden(), 1)
  const epoch = s.runtime.epoch
  s.worker.emit('message', {type: 'detected', epoch: epoch - 1})
  assert.equal(s.shown(), 0)
  s.worker.emit('message', {type: 'detected', epoch})
  s.worker.emit('message', {type: 'detected', epoch})
  assert.equal(s.shown(), 1)
  assert.equal(s.runtime.state, 'active')
})
test('closed microphone, stale input and worker backlog are rejected; failure stays upload-blocked', () => {
  const s = setup()
  s.report(); s.time(60000); s.report()
  s.report(true, true)
  const payload = () => ({epoch: s.runtime.epoch, pcm: new Uint8Array(640)})
  assert.equal(s.runtime.accept(payload()), false)
  s.worker.emit('message', {type: 'detected', epoch: s.runtime.epoch})
  assert.equal(s.shown(), 0)
  s.report(true, false)
  assert.equal(s.runtime.accept({...payload(), epoch: -1}), false)
  assert.equal(s.runtime.accept(payload()), true)
  for (let i = 0; i < 5; i++) assert.equal(s.runtime.accept(payload()), true)
  assert.equal(s.runtime.accept(payload()), false)
  s.worker.emit('error', new Error('failure'))
  assert.equal(s.runtime.state, 'blocked')
  assert.equal(s.shown(), 1)
  s.runtime.wake()
  assert.equal(s.runtime.state, 'active')
})
test('disabled/replaced workers and malformed IPC cannot activate or retain audio', () => {
  const s = setup()
  s.report(); s.time(60000); s.report()
  const epoch = s.runtime.epoch
  s.runtime.configure({wakeWordEnabled: false, autoHideSeconds: 60})
  s.worker.emit('message', {type: 'detected', epoch})
  assert.equal(s.runtime.worker, null)
  assert.equal(s.runtime.accept({epoch, pcm: new Uint8Array(640)}), false)
  assert.equal(s.runtime.report({idle: true}), false)
})
test('browser and native ingress handlers gate stale and muted PCM before the shared router', async () => {
  const {readFile} = await import('node:fs/promises')
  const {runInNewContext} = await import('node:vm')
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')
  const browserStart = source.indexOf('nextProcessor.port.onmessage = event => {')
  const browserEnd = source.indexOf('\n    }\n    nextSource.connect', browserStart)
  const nativeStart = source.indexOf('window.novaAudioAgentDesktop.nativeAudio.onEvent(event => {')
  const nativeAudioStart = source.indexOf("if (event.type === 'audio') {", nativeStart)
  const nativeAudioEnd = source.indexOf("\n      } else if (event.type === 'playback.started')", nativeAudioStart)
  assert.ok(browserStart >= 0 && browserEnd >= 0, 'browser ingress extraction succeeded')
  assert.ok(nativeStart >= 0 && nativeAudioStart >= 0 && nativeAudioEnd >= 0, 'native ingress extraction succeeded')
  const browserHandler = source.slice(
    browserStart + 'nextProcessor.port.onmessage = '.length,
    browserEnd + '\n    }'.length,
  )
  const nativeHandler = `event => {${source.slice(
    source.indexOf('\n', nativeAudioStart) + 1,
    nativeAudioEnd,
  )}\n}`

  for (const [name, handlerSource, eventFor] of [
    ['browser', browserHandler, epoch => ({data: {epoch, samples: new Float32Array([0, 0.25])}})],
    ['native', nativeHandler, epoch => ({type: 'audio', wakeEpoch: epoch, pcm: new Uint8Array([0, 0])})],
  ]) {
    let now = 0
    const uploaded = []
    const detected = []
    const axes = {activated: true, muted: false, connected: true}
    const wakeAudio = new WakeAudioRouter({
      now: () => now,
      upload: pcm => uploaded.push(pcm),
      detect: value => detected.push(value),
    })
    const sandbox = {
      Float32Array,
      Uint8Array,
      axes,
      context: {sampleRate: 16_000},
      microphoneGated: () => axes.muted,
      nativeReady: true,
      wakeAudio,
      floatToPcm16: samples => new Uint8Array(samples.length * 2),
    }
    const handler = runInNewContext(`(${handlerSource})`, sandbox)
    wakeAudio.apply({state: 'sleeping', epoch: 7})
    now = 200
    handler(eventFor(6))
    assert.equal(detected.length, 0, `${name}: stale PCM is rejected`)
    handler(eventFor(7))
    assert.equal(uploaded.length, 0, `${name}: sleeping PCM is never uploaded`)
    assert.equal(detected.length, 1, `${name}: current sleeping PCM reaches the detector`)
    axes.muted = true
    handler(eventFor(7))
    assert.equal(detected.length, 1, `${name}: muted PCM never reaches the detector`)
    axes.muted = false
    wakeAudio.apply({state: 'active', epoch: 8})
    now = 400
    handler(eventFor(7))
    assert.equal(uploaded.length, 0, `${name}: pre-transition PCM cannot upload`)
    if (name === 'native') {
      sandbox.nativeReady = false
      handler(eventFor(8))
      assert.equal(uploaded.length, 0, 'native: unavailable helper PCM is rejected')
      sandbox.nativeReady = true
    }
    axes.activated = false
    handler(eventFor(8))
    assert.equal(uploaded.length, 0, `${name}: inactive capture cannot upload`)
    axes.activated = true
    handler(eventFor(8))
    assert.equal(uploaded.length, 1, `${name}: current active PCM uploads once`)
  }
})

test('shared router drains transition frames and blocks upload outside active state', () => {
  let now = 0
  const uploaded = []
  const detected = []
  const router = new WakeAudioRouter({
    now: () => now,
    upload: pcm => uploaded.push(pcm),
    detect: value => detected.push(value),
  })
  const pcm = new Uint8Array(640)
  const axes = {activated: true, muted: false, connected: true}
  router.apply({state: 'active', epoch: 1})
  router.accept(pcm, axes)
  now = 120
  router.accept(pcm, axes)
  assert.equal(uploaded.length, 1)
  router.apply({state: 'sleeping', epoch: 2})
  router.accept(pcm, axes)
  assert.equal(detected.length, 0, 'transition drain drops queued frames')
  now = 240
  router.accept(pcm, axes)
  assert.equal(detected.length, 1)
  router.apply({state: 'blocked', epoch: 3})
  now = 360
  router.accept(pcm, axes)
  assert.equal(uploaded.length, 1)
  assert.equal(detected.length, 1)
})

test('failed workers are released and stale worker messages cannot cross a retry', () => {
  const workers = []
  class TrackingWorker extends Worker {
    constructor(...args) { super(...args); workers.push(this) }
  }
  let shown = 0
  const runtime = new WakeWordRuntime({
    modelRoot: '/unused', WorkerClass: TrackingWorker, now: () => 0, show: () => shown++,
  })
  runtime.configure({wakeWordEnabled: true, autoHideSeconds: 60})
  const first = workers[0]
  first.emit('message', {type: 'ready'})
  runtime.report({epoch: runtime.epoch, idle: true, muted: false, activated: true})
  assert.equal(runtime.sleep(), true)
  first.emit('error', new Error('failure'))
  assert.equal(first.terminations, 1)
  assert.equal(runtime.worker, null)

  runtime.start()
  const second = workers[1]
  second.emit('message', {type: 'ready'})
  runtime.report({epoch: runtime.epoch, idle: true, muted: false, activated: true})
  runtime.wake()
  assert.equal(runtime.sleep(), true)
  const beforeStaleDetection = shown
  const beforeStaleReady = {status: runtime.status, epoch: runtime.epoch}
  first.emit('message', {type: 'ready'})
  assert.deepEqual({status: runtime.status, epoch: runtime.epoch}, beforeStaleReady)
  first.emit('message', {type: 'detected', epoch: runtime.epoch})
  assert.equal(shown, beforeStaleDetection)
  second.emit('message', {type: 'detected', epoch: runtime.epoch})
  assert.equal(shown, beforeStaleDetection + 1)
})
test('wake settings default safely, validate and survive public/update paths', () => {
  assert.equal(normalizeSettings({}).wakeWordEnabled, false)
  assert.equal(normalizeSettings({autoHideSeconds: 29}).autoHideSeconds, 60)
  const settings = applySettingsUpdate(normalizeSettings({}), {wakeWordEnabled: true, autoHideSeconds: 0}, {available: () => false})
  assert.equal(orbSettings(settings).wakeWordEnabled, true)
  assert.equal(orbSettings(settings).autoHideSeconds, 0)
})

test('missing model and inactive capture cannot hide; explicitly hiding uses the same sleep gate', () => {
  let hidden = 0
  const runtime = new WakeWordRuntime({modelRoot: '/unused', WorkerClass: Worker, hide: () => hidden++})
  runtime.configure({wakeWordEnabled: true, autoHideSeconds: 60})
  assert.equal(runtime.sleep(), false)
  runtime.worker.emit('message', {type: 'ready'})
  assert.equal(runtime.sleep(), false)
  runtime.report({epoch: runtime.epoch, idle: true, activated: true, muted: false})
  assert.equal(runtime.sleep(), true)
  assert.equal(hidden, 1)
})

test('all busy states and stale backend heartbeats prevent automatic sleep', async () => {
  const {canAutoSleep} = await import('../src/renderer/wake-audio.mjs')
  const idle = {connected: true, backendState: 'connected', error: '', capture: 'idle', playback: 'idle', codex: 'idle', pendingConfirmation: false, activationPending: false}
  assert.equal(canAutoSleep(idle, true, 100, 100), true)
  for (const patch of [{connected: false}, {backendState: 'reconnecting'}, {error: 'backend'}, {capture: 'listening'}, {capture: 'candidate'}, {playback: 'speaking'}, {codex: 'working'}, {pendingConfirmation: true}, {activationPending: true}]) {
    assert.equal(canAutoSleep({...idle, ...patch}, true, 100, 100), false)
  }
  assert.equal(canAutoSleep(idle, false, 100, 100), false)
  assert.equal(canAutoSleep(idle, true, 100, 3000), false)
})

test('worklet resets partial capture and tags audio at production time', async () => {
  const {readFile} = await import('node:fs/promises')
  const {runInNewContext} = await import('node:vm')
  const {CaptureAccumulator} = await import('../src/renderer/audio.mjs')
  const emitted = []
  let Processor
  class Base { port = {postMessage: value => emitted.push(value)} }
  const source = (await readFile(new URL('../src/renderer/capture-worklet.mjs', import.meta.url), 'utf8'))
    .replace("import { CaptureAccumulator } from './audio.mjs'", '')
  runInNewContext(source, {CaptureAccumulator, AudioWorkletProcessor: Base, registerProcessor: (_name, value) => { Processor = value }})
  const processor = new Processor()
  processor.process([[new Float32Array(128)]])
  processor.port.onmessage({data: {epoch: 7}})
  processor.process([[new Float32Array(512)]])
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].epoch, 7)
  assert.equal(emitted[0].samples.length, 512)
})


test('disabling or retrying after a sleeping detector failure restores user-controlled muted input', () => {
  for (const action of ['disable', 'retry']) {
    const s = setup()
    s.report(); s.runtime.sleep()
    s.worker.emit('error', new Error('decode failed'))
    assert.equal(s.runtime.state, 'blocked')
    assert.equal(s.runtime.muted, true)
    s.report(true, false)
    assert.equal(s.runtime.muted, true, 'blocked reports cannot release forced mute')
    if (action === 'disable') s.runtime.configure({wakeWordEnabled: false, autoHideSeconds: 60})
    else {
      s.runtime.start()
      s.runtime.worker.emit('message', {type: 'ready'})
    }
    assert.equal(s.runtime.state, 'active')
    assert.equal(s.runtime.muted, true, 'recovery never unmutes')
    s.report(true, false)
    assert.equal(s.runtime.muted, false, 'user can unmute after recovery')
  }
})

test('short decode stalls queue at most 100 ms; transitions and stale acknowledgements discard old audio', () => {
  const s = setup()
  s.report(); s.runtime.sleep()
  const epoch = s.runtime.epoch
  const pcm = new Uint8Array(640)
  const audio = () => s.worker.messages.filter(value => value.type === 'audio')
  for (let i = 0; i < 6; i++) assert.equal(s.runtime.accept({epoch, pcm}), true)
  assert.equal(s.runtime.accept({epoch, pcm}), false)
  assert.equal(audio().length, 1)
  assert.equal(s.runtime.droppedFrames, 1)
  s.worker.emit('message', {type: 'consumed', epoch})
  assert.equal(audio().length, 2, 'next buffered frame delivered after decode')
  s.runtime.wake()
  s.worker.emit('message', {type: 'consumed', epoch})
  assert.equal(audio().length, 2, 'old buffered frames cannot cross wake')
  s.runtime.sleep()
  assert.equal(s.runtime.accept({epoch: s.runtime.epoch, pcm}), true)
  assert.equal(s.runtime.accept({epoch: s.runtime.epoch, pcm}), true)
  s.time(101)
  s.worker.emit('message', {type: 'consumed', epoch: s.runtime.epoch})
  assert.equal(audio().length, 3, 'expired buffer is not replayed')
  assert.equal(s.runtime.droppedFrames, 2)
})

test('heartbeat expiry while draining discards the remaining queue before new live input', () => {
  const s = setup()
  s.report(); s.runtime.sleep()
  s.runtime.lastReport = -2490
  const epoch = s.runtime.epoch
  const pcm = new Uint8Array(640)
  for (let i = 0; i < 3; i++) assert.equal(s.runtime.accept({epoch, pcm}), true)
  s.time(20)
  s.worker.emit('message', {type: 'consumed', epoch})
  s.report()
  assert.equal(s.runtime.accept({epoch: s.runtime.epoch, pcm}), true)
  s.worker.emit('message', {type: 'consumed', epoch: s.runtime.epoch})
  assert.equal(s.worker.messages.filter(value => value.type === 'audio').length, 2)
  assert.equal(s.runtime.droppedFrames, 2)
})


test('manual hide falls back when sleep is unavailable', () => {
  const source = readFileSync(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const body = source.match(/function hideOrb\(\) \{([\s\S]*?)\n\}/)[1]
  for (const wakeWord of [undefined, {enabled: false}, {enabled: true, state: 'active', sleep: () => false}]) {
    let hidden = 0
    new Function('wakeWord', 'mainWindow', body)(wakeWord, {hide: () => hidden++})
    assert.equal(hidden, 1)
  }
  let hidden = 0
  new Function('wakeWord', 'mainWindow', body)({enabled: true, state: 'active', sleep: () => true}, {hide: () => hidden++})
  assert.equal(hidden, 0)
})
