import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import * as nativeAudioModule from '../src/main/native-audio.mjs'

const { startNativeAudio } = nativeAudioModule

async function startReadyNativeAudio({ onCommand = () => {}, now } = {}) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {}
  const commands = []
  const events = []
  child.stdin.on('data', chunk => {
    const command = JSON.parse(chunk.toString().trim())
    commands.push(command)
    onCommand(command, child)
  })
  const audio = await startNativeAudio({
    binary: '/tmp/macos-voice-io',
    spawnImpl: () => {
      queueMicrotask(() => child.stdout.write(
        '{"type":"ready","aecMode":"voice_processing_io","systemAEC":true}\n',
      ))
      return child
    },
    onEvent: event => events.push(event),
    ...(now === undefined ? {} : {now}),
  })
  return { audio, child, commands, events }
}

function activeTimeoutCount() {
  return process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length
}

function pauseForClearTimeout() {
  return new Promise(resolve => setTimeout(resolve, 300))
}

async function beginIdentityClear(audio) {
  const timeoutCount = activeTimeoutCount()
  let settlements = 0
  const clearing = audio.clear('u-1', 3).then(value => {
    settlements += 1
    return value
  })
  await new Promise(resolve => setImmediate(resolve))
  return { clearing, timeoutCount, settlements: () => settlements }
}

async function assertSettlesWithoutLaterTimeout({ clearing, events, timeoutCount, settlements }) {
  assert.deepEqual(await clearing, { playedMs: 0 })
  assert.equal(settlements(), 1)
  assert.equal(activeTimeoutCount(), timeoutCount)
  await pauseForClearTimeout()
  assert.equal(settlements(), 1)
  assert.equal(activeTimeoutCount(), timeoutCount)
  assert.deepEqual(events.filter(event => event.code === 'native_clear_timeout'), [])
}

test('macOS helper is pinned to Apple VoiceProcessingIO system AEC', async () => {
  const source = await readFile(new URL('../native/macos_voice_io.swift', import.meta.url), 'utf8')

  assert.match(source, /kAudioUnitSubType_VoiceProcessingIO/)
  assert.match(source, /kAudioOutputUnitProperty_EnableIO/)
  assert.match(source, /kAudioUnitProperty_SetRenderCallback/)
  assert.match(source, /kAudioOutputUnitProperty_SetInputCallback/)
  assert.doesNotMatch(source, /BypassVoiceProcessing|bypassVoiceProcessing/)
})

test('macOS helper tracks playback underruns and callback latency for telemetry', async () => {
  const source = await readFile(new URL('../native/macos_voice_io.swift', import.meta.url), 'utf8')
  assert.match(source, /underrunSamples/)
  assert.match(source, /maxCallbackUs/)
  assert.match(source, /playback\.telemetry/)
  assert.match(source, /playback_stats/)
})

test('macOS playback queue counts only active underruns and isolates final generation metrics', {
  skip: process.platform !== 'darwin',
}, async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'nova-playback-telemetry-'))
  try {
    const main = resolve(temporary, 'main.swift')
    const executable = resolve(temporary, 'playback-telemetry-test')
    await copyFile(
      new URL('./fixtures/playback_queue_telemetry.swift', import.meta.url),
      main,
    )
    const compiled = spawnSync('/usr/bin/swiftc', [
      resolve(import.meta.dirname, '../native/playback_queue.swift'),
      main,
      '-o',
      executable,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: resolve(temporary, 'clang-cache'),
        SWIFT_MODULECACHE_PATH: resolve(temporary, 'swift-cache'),
      },
    })
    assert.equal(compiled.status, 0, compiled.stderr)
    const result = spawnSync(executable, [], {encoding: 'utf8'})
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'playback telemetry behavior passed')
  } finally {
    await rm(temporary, {recursive: true, force: true})
  }
})

test('native audio forwards generation-scoped periodic and final playback telemetry', async () => {
  let currentTime = 100
  const { audio, child, events } = await startReadyNativeAudio({
    now: () => currentTime,
    onCommand: (command, emitter) => {
      if (command.type !== 'playback_stats') return
      emitter.stdout.write(`${JSON.stringify({
        type: 'playback.telemetry',
        utteranceId: 'u-1',
        generationEpoch: 1,
        final: false,
        windowMs: 800,
        queuedSamples: 960,
        queuedSamplesMax: 1440,
        underrunSamples: 480,
        underrunCallbacks: 1,
        maxConsecutiveUnderrunSamples: 240,
        renderCallbacks: 10,
        maxCallbackUs: 1200,
        pcmNearSilenceMsMax: 20,
      })}\n`)
    },
  })
  audio.play(new Uint8Array([0, 0, 1, 0]), 'u-1', 1)
  currentTime = 125
  audio.play(new Uint8Array([0, 0, 2, 0]), 'u-1', 1)
  audio.requestPlaybackStats()
  await new Promise(resolve => setImmediate(resolve))
  const telemetry = events.find(event => event.type === 'playback.telemetry')
  assert.deepEqual(telemetry, {
    type: 'playback.telemetry',
    utteranceId: 'u-1',
    generationEpoch: 1,
    final: false,
    windowMs: 800,
    queuedSamples: 960,
    queuedSamplesMax: 1440,
    underrunSamples: 480,
    underrunCallbacks: 1,
    maxConsecutiveUnderrunSamples: 240,
    renderCallbacks: 10,
    maxCallbackUs: 1200,
    frameGapMsMax: 25,
    pcmNearSilenceMsMax: 20,
    stdinBufferedBytesMax: 0,
    stdinBackpressureCount: 0,
    stdinDrainMsMax: 0,
  })

  currentTime = 200
  audio.play(new Uint8Array([0, 0]), 'u-2', 2)
  child.stdout.write(`${JSON.stringify({
    type: 'playback.telemetry',
    utteranceId: 'u-2', generationEpoch: 2, final: true, windowMs: 4,
    queuedSamples: 0, queuedSamplesMax: 2, underrunSamples: 0,
    underrunCallbacks: 0, maxConsecutiveUnderrunSamples: 0,
    renderCallbacks: 1, maxCallbackUs: 50, pcmNearSilenceMsMax: 1,
  })}\n`)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events.at(-1), {
    type: 'playback.telemetry',
    utteranceId: 'u-2',
    generationEpoch: 2,
    final: true,
    windowMs: 4,
    queuedSamples: 0,
    queuedSamplesMax: 2,
    underrunSamples: 0,
    underrunCallbacks: 0,
    maxConsecutiveUnderrunSamples: 0,
    renderCallbacks: 1,
    maxCallbackUs: 50,
    frameGapMsMax: 0,
    pcmNearSilenceMsMax: 1,
    stdinBufferedBytesMax: 0,
    stdinBackpressureCount: 0,
    stdinDrainMsMax: 0,
  })
  child.stdout.destroy()
})

test('native audio attributes stdin backpressure and drain latency to one generation', async () => {
  let currentTime = 50
  const child = new EventEmitter()
  const commands = []
  child.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    destroyed: false,
    writableLength: 4096,
    write(raw) {
      commands.push(JSON.parse(raw.trim()))
      return false
    },
  })
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {}
  const events = []
  const audio = await startNativeAudio({
    binary: '/tmp/macos-voice-io',
    spawnImpl: () => {
      queueMicrotask(() => child.stdout.write(
        '{"type":"ready","aecMode":"voice_processing_io","systemAEC":true}\n',
      ))
      return child
    },
    onEvent: event => events.push(event),
    now: () => currentTime,
  })

  assert.equal(audio.play(new Uint8Array([0, 0]), 'u-backpressure', 3), true)
  currentTime = 63.5
  child.stdin.writableLength = 0
  child.stdin.emit('drain')
  child.stdout.write(`${JSON.stringify({
    type: 'playback.telemetry',
    utteranceId: 'u-backpressure', generationEpoch: 3, final: true, windowMs: 20,
    queuedSamples: 0, queuedSamplesMax: 2, underrunSamples: 0,
    underrunCallbacks: 0, maxConsecutiveUnderrunSamples: 0,
    renderCallbacks: 1, maxCallbackUs: 20, pcmNearSilenceMsMax: 1,
  })}\n`)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(commands.length, 1)
  assert.equal(events.at(-1).stdinBufferedBytesMax, 4096)
  assert.equal(events.at(-1).stdinBackpressureCount, 1)
  assert.equal(events.at(-1).stdinDrainMsMax, 13.5)

  currentTime = 100
  child.stdin.writableLength = 2048
  assert.equal(audio.play(new Uint8Array([0, 0]), 'u-pending-drain', 4), true)
  currentTime = 121
  child.stdout.write(`${JSON.stringify({
    type: 'playback.telemetry',
    utteranceId: 'u-pending-drain', generationEpoch: 4, final: true, windowMs: 20,
    queuedSamples: 0, queuedSamplesMax: 2, underrunSamples: 0,
    underrunCallbacks: 0, maxConsecutiveUnderrunSamples: 0,
    renderCallbacks: 1, maxCallbackUs: 20, pcmNearSilenceMsMax: 1,
  })}\n`)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(events.at(-1).stdinDrainMsMax, 21, 'an in-flight drain is visible in a final snapshot')
})

test('macOS helper mute writes silence while preserving playback progress and receipts', async () => {
  const source = await readFile(new URL('../native/playback_queue.swift', import.meta.url), 'utf8')
  const renderStart = source.indexOf('func render(into output:')
  const renderEnd = source.length
  const render = source.slice(renderStart, renderEnd)

  assert.match(render, /output\.baseAddress\?\.initialize\(repeating: 0, count: output\.count\)/)
  assert.match(render, /if !muted \{[\s\S]*?output\.baseAddress\?\.advanced\(by: offset\)\.update/)
  assert.match(render, /signals\.append\(\.started\(identity\)\)/)
  assert.match(render, /offset \+= amount[\s\S]*?renderedSamples\[identity, default: 0\] \+= amount/)
  assert.match(render, /signals\.append\(\.done\(/)
})

test('uses VoiceProcessingIO readiness and preserves Nova Audio Agent generation identity', {
  skip: process.platform !== 'darwin',
}, async () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {}
  const commands = []
  const events = []
  child.stdin.on('data', chunk => commands.push(JSON.parse(chunk.toString().trim())))

  const pending = startNativeAudio({
    binary: '/tmp/macos-voice-io',
    spawnImpl(command, args) {
      assert.equal(command, '/tmp/macos-voice-io')
      assert.deepEqual(args, [])
      queueMicrotask(() => child.stdout.write(
        '{"type":"ready","aecMode":"voice_processing_io","systemAEC":true}\n',
      ))
      return child
    },
    onEvent: event => events.push(event),
  })
  const audio = await pending

  assert.equal(audio.status.systemAEC, true)
  assert.equal(audio.play(Buffer.from([0, 1]), 'u-1', 3), true)
  assert.equal(audio.terminal('u-1', 3), true)
  child.stdout.write(
    '{"type":"playback.done","utteranceId":"u-1","generationEpoch":3,"renderedSamples":1200}\n',
  )

  const clearing = audio.clear('u-1', 3)
  await new Promise(resolve => setImmediate(resolve))
  const clearCommand = commands.at(-1)
  let clearSettled = false
  clearing.then(() => { clearSettled = true })
  await Promise.resolve()
  assert.equal(clearSettled, false)
  child.stdout.write(`${JSON.stringify({
    type: 'playback.cleared',
    requestId: clearCommand.requestId,
    utteranceId: 'u-1',
    generationEpoch: 3,
    renderedSamples: 0,
  })}\n`)
  assert.deepEqual(await clearing, { playedMs: 25 })

  assert.deepEqual(commands, [
    {
      type: 'play',
      audio: 'AAE=',
      utteranceId: 'u-1',
      generationEpoch: 3,
    },
    { type: 'terminal', utteranceId: 'u-1', generationEpoch: 3 },
    {
      type: 'clear',
      requestId: clearCommand.requestId,
      utteranceId: 'u-1',
      generationEpoch: 3,
    },
  ])
  assert.deepEqual(events, [{
    type: 'playback.done',
    utteranceId: 'u-1',
    generationEpoch: 3,
    playedMs: 25,
  }])
})

test('native playback mute is a bounded command that leaves the helper running', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { audio, commands } = await startReadyNativeAudio()

  assert.equal(audio.setPlaybackMuted(true), true)
  assert.equal(audio.setPlaybackMuted(false), true)
  assert.deepEqual(commands, [
    { type: 'playback_muted', enabled: true },
    { type: 'playback_muted', enabled: false },
  ])
})

test('bounds an unresponsive identity-qualified native clear', {
  skip: process.platform !== 'darwin',
  timeout: 500,
}, async () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {}
  const events = []
  const audio = await startNativeAudio({
    binary: '/tmp/macos-voice-io',
    spawnImpl: () => {
      queueMicrotask(() => child.stdout.write(
        '{"type":"ready","aecMode":"voice_processing_io","systemAEC":true}\n',
      ))
      return child
    },
    onEvent: event => events.push(event),
  })

  let settlements = 0
  const clearing = audio.clear('u-1', 3).then(value => {
    settlements += 1
    return value
  })

  assert.deepEqual(await clearing, { playedMs: 0 })
  child.emit('error', new Error('late helper error'))
  child.emit('close', 0)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(settlements, 1)
  assert.deepEqual(events.filter(event => event.type === 'error'), [
    { type: 'error', code: 'native_clear_timeout' },
  ])
})

test('normal native clear acknowledgement settles once and releases its timer', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { audio, child, commands, events } = await startReadyNativeAudio()
  const pending = await beginIdentityClear(audio)
  const clearCommand = commands.at(-1)

  child.stdout.write(`${JSON.stringify({
    type: 'playback.cleared',
    requestId: clearCommand.requestId,
    utteranceId: 'u-1',
    generationEpoch: 3,
    renderedSamples: 0,
  })}\n`)

  await assertSettlesWithoutLaterTimeout({ ...pending, events })
})

test('native clear send failure settles once and releases its timer', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { audio, child, events } = await startReadyNativeAudio()
  child.stdin.destroy()

  await assertSettlesWithoutLaterTimeout({
    ...await beginIdentityClear(audio),
    events,
  })
})

test('native helper error settles a pending clear once and releases its timer', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { audio, child, events } = await startReadyNativeAudio()
  const pending = await beginIdentityClear(audio)
  child.emit('error', new Error('helper failed'))

  await assertSettlesWithoutLaterTimeout({ ...pending, events })
})

test('native helper close settles a pending clear once and releases its timer', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { audio, child, events } = await startReadyNativeAudio()
  const pending = await beginIdentityClear(audio)
  child.emit('close', 0)

  await assertSettlesWithoutLaterTimeout({ ...pending, events })
})

test('explicit native close settles a pending clear once and releases its timer', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { audio, events } = await startReadyNativeAudio({
    onCommand: (command, child) => {
      if (command.type === 'close') queueMicrotask(() => child.emit('close', 0))
    },
  })
  const pending = await beginIdentityClear(audio)
  const closing = audio.close()

  await closing
  await assertSettlesWithoutLaterTimeout({ ...pending, events })
})

test('native clear timeout returns cached same-identity playback evidence', {
  skip: process.platform !== 'darwin',
  timeout: 500,
}, async () => {
  const { audio, child, events } = await startReadyNativeAudio()
  assert.equal(audio.play(Buffer.from([0, 1]), 'u-1', 3), true)
  child.stdout.write(
    '{"type":"playback.done","utteranceId":"u-1","generationEpoch":3,"renderedSamples":1200}\n',
  )

  assert.deepEqual(await audio.clear('u-1', 3), { playedMs: 25 })
  assert.deepEqual(events.filter(event => event.type === 'error'), [
    { type: 'error', code: 'native_clear_timeout' },
  ])
})

test('capture manager waits for native readiness and falls back on startup failure', async () => {
  assert.equal(typeof nativeAudioModule.createNativeAudioManager, 'function')
  let resolveStart
  const commands = []
  const manager = nativeAudioModule.createNativeAudioManager({
    binary: '/tmp/macos-voice-io',
    startImpl: () => new Promise(resolve => { resolveStart = resolve }),
  })

  const activation = manager.activate()
  assert.equal(manager.play(Buffer.from([0, 1]), 'u-1', 1), false)
  let settled = false
  activation.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  resolveStart({
    setCaptureEnabled: enabled => commands.push(enabled),
    close: async () => {},
  })
  assert.deepEqual(await activation, { audioMode: 'voice_processing_io' })
  assert.deepEqual(commands, [true])

  const fallback = nativeAudioModule.createNativeAudioManager({
    binary: '/tmp/macos-voice-io',
    startImpl: async () => { throw new Error('permission denied') },
  })
  assert.deepEqual(await fallback.activate(), { audioMode: 'browser_aec' })
})

test('capture manager remembers output mute before activation and applies it to a new helper', async () => {
  let resolveStart
  const commands = []
  const manager = nativeAudioModule.createNativeAudioManager({
    binary: '/tmp/macos-voice-io',
    startImpl: () => new Promise(resolve => { resolveStart = resolve }),
  })

  assert.equal(manager.setPlaybackMuted(true), true)
  const activation = manager.activate()
  resolveStart({
    setPlaybackMuted: muted => { commands.push(['mute', muted]); return true },
    setCaptureEnabled: enabled => { commands.push(['capture', enabled]); return true },
    close: async () => {},
  })

  assert.deepEqual(await activation, { audioMode: 'voice_processing_io' })
  assert.deepEqual(commands, [['mute', true], ['capture', true]])
  assert.equal(manager.setPlaybackMuted(false), true)
  assert.deepEqual(commands.at(-1), ['mute', false])
})

test('capture manager never remembers a mute command rejected by a live helper', async () => {
  let helperId = 0
  const commands = []
  const manager = nativeAudioModule.createNativeAudioManager({
    binary: '/tmp/macos-voice-io',
    startImpl: async () => {
      const id = ++helperId
      return {
        setPlaybackMuted: muted => {
          commands.push([id, 'mute', muted])
          return !(id === 1 && muted === false)
        },
        setCaptureEnabled: enabled => { commands.push([id, 'capture', enabled]); return true },
        close: async () => {},
      }
    },
  })

  assert.equal(manager.setPlaybackMuted(true), true, 'pre-activation intent is remembered')
  assert.deepEqual(await manager.activate(), { audioMode: 'voice_processing_io' })
  assert.equal(manager.setPlaybackMuted(false), false, 'the live helper rejects unmute')
  await manager.deactivate()
  assert.deepEqual(await manager.activate(), { audioMode: 'voice_processing_io' })
  assert.deepEqual(commands, [
    [1, 'mute', true],
    [1, 'capture', true],
    [1, 'mute', false],
    [2, 'mute', true],
    [2, 'capture', true],
  ])
})

test('capture manager stops advertising readiness after an unexpected helper exit', async () => {
  let emit
  const manager = nativeAudioModule.createNativeAudioManager({
    binary: '/tmp/macos-voice-io',
    startImpl: async ({ onEvent }) => {
      emit = onEvent
      return {
        setCaptureEnabled: () => true,
        close: async () => {},
      }
    },
  })

  assert.deepEqual(await manager.activate(), { audioMode: 'voice_processing_io' })
  assert.equal(manager.ready, true)
  emit({ type: 'exit' })
  assert.equal(manager.ready, false)
})

test('capture manager closes a ready helper that reports an error', async () => {
  let emit
  let closeCalls = 0
  const manager = nativeAudioModule.createNativeAudioManager({
    binary: '/tmp/macos-voice-io',
    startImpl: async ({ onEvent }) => {
      emit = onEvent
      return {
        setCaptureEnabled: () => true,
        close: async () => { closeCalls += 1 },
      }
    },
  })

  await manager.activate()
  emit({ type: 'error', code: 'voice_processing_unavailable' })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(manager.ready, false)
  assert.equal(closeCalls, 1)
})

test('native close resolves only after the helper process exits', {
  skip: process.platform !== 'darwin',
}, async () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {}
  const pending = startNativeAudio({
    binary: '/tmp/macos-voice-io',
    spawnImpl: () => {
      queueMicrotask(() => child.stdout.write(
        '{"type":"ready","aecMode":"voice_processing_io","systemAEC":true}\n',
      ))
      return child
    },
  })
  const audio = await pending

  const closing = audio.close()
  let settled = false
  Promise.resolve(closing).then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  child.emit('close', 0)
  await closing
})
