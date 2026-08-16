import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import * as nativeAudioModule from '../src/main/native-audio.mjs'

const { startNativeAudio } = nativeAudioModule

async function startReadyNativeAudio({ onCommand = () => {} } = {}) {
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
