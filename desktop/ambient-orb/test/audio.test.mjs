import assert from 'node:assert/strict'
import test from 'node:test'

import * as audioModule from '../src/renderer/audio.mjs'

const {
  AlertTone,
  GenerationPlayback,
  applyAlertCommand,
  decodeAudioFrame,
  floatToPcm16,
  observePcmOnset,
} = audioModule

function audioFrame({ utterance = 'u-1', epoch = 1, sequence = 0, pcm = [0, 1] } = {}) {
  const header = Buffer.from(JSON.stringify({
    utterance_id: utterance,
    generation_epoch: epoch,
    sequence,
  }))
  const prefix = Buffer.alloc(6)
  prefix.write('NOVA')
  prefix.writeUInt16BE(header.length, 4)
  return Buffer.concat([prefix, header, Buffer.from(pcm)])
}

test('converts captured floats to aligned 16 kHz little-endian PCM16', () => {
  const pcm = floatToPcm16(new Float32Array([-1, 0, 1, 0]), 32_000, 16_000)
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)

  assert.equal(pcm.byteLength, 4)
  assert.equal(view.getInt16(0, true), -32768)
  assert.equal(view.getInt16(2, true), 32767)
})

test('decodes the atomic Python audio envelope', () => {
  const decoded = decodeAudioFrame(audioFrame({ epoch: 4, sequence: 7 }))

  assert.equal(decoded.utteranceId, 'u-1')
  assert.equal(decoded.generationEpoch, 4)
  assert.equal(decoded.sequence, 7)
  assert.deepEqual([...decoded.pcm], [0, 1])
})

test('fences locally and rejects stale or out-of-order PCM', () => {
  let stopped = 0
  const playback = new GenerationPlayback({ stopAll: () => { stopped += 1 } })

  assert.equal(playback.accept(decodeAudioFrame(audioFrame())), true)
  assert.equal(playback.accept(decodeAudioFrame(audioFrame({ sequence: 2 }))), false)
  assert.deepEqual(playback.clear('u-1', 1), { playedMs: 0 })
  assert.equal(stopped, 1)
  assert.equal(playback.accept(decodeAudioFrame(audioFrame({ sequence: 1 }))), false)
  assert.equal(playback.accept(decodeAudioFrame(audioFrame({
    utterance: 'u-2', epoch: 2, sequence: 0,
  }))), true)
})

test('acknowledges done only after provider terminal and local drain', () => {
  const playback = new GenerationPlayback()
  const frame = decodeAudioFrame(audioFrame())
  playback.accept(frame)
  const queued = playback.dequeue()

  assert.equal(playback.markProviderTerminal('u-1', 1), null)
  assert.deepEqual(playback.frameEnded(queued), {
    type: 'playback.done',
    utterance_id: 'u-1',
    generation_epoch: 1,
    played_ms: 0,
  })
  assert.equal(playback.frameEnded(queued), null)
})

test('reports playback start exactly once per generation', () => {
  const playback = new GenerationPlayback()

  assert.equal(playback.markStarted(), null)
  playback.accept(decodeAudioFrame(audioFrame()))
  assert.deepEqual(playback.markStarted(), {
    type: 'playback.started',
    utterance_id: 'u-1',
    generation_epoch: 1,
  })
  assert.equal(playback.markStarted(), null)

  playback.clear('u-1', 1)
  playback.accept(decodeAudioFrame(audioFrame({ utterance: 'u-2', epoch: 2 })))
  assert.deepEqual(playback.markStarted(), {
    type: 'playback.started',
    utterance_id: 'u-2',
    generation_epoch: 2,
  })
})

test('accumulates audible milliseconds from ended frames into the done acknowledgement', () => {
  const playback = new GenerationPlayback()
  const frame = decodeAudioFrame(audioFrame({ pcm: new Array(96).fill(0) }))
  playback.accept(frame)
  const queued = playback.dequeue()
  playback.markProviderTerminal('u-1', 1)

  const acknowledgement = playback.frameEnded(queued)

  assert.equal(acknowledgement.played_ms, 2)
})

test('remembers the last completed acknowledgement as late-clear evidence', () => {
  const playback = new GenerationPlayback()
  const frame = decodeAudioFrame(audioFrame({ pcm: new Array(96).fill(0) }))
  playback.accept(frame)
  const queued = playback.dequeue()
  playback.markProviderTerminal('u-1', 1)
  playback.frameEnded(queued)

  assert.deepEqual(playback.lastCompletion, {
    type: 'playback.done',
    utterance_id: 'u-1',
    generation_epoch: 1,
    played_ms: 2,
  })
  assert.equal(playback.clear('u-1', 1), null)
})

test('clear reports ended plus in-flight audible milliseconds exactly once', () => {
  const playback = new GenerationPlayback({ stopAll: () => 30 })
  const first = decodeAudioFrame(audioFrame({ pcm: new Array(96).fill(0) }))
  const second = decodeAudioFrame(audioFrame({ sequence: 1, pcm: new Array(48).fill(0) }))
  playback.accept(first)
  playback.accept(second)
  const queuedFirst = playback.dequeue()
  playback.frameEnded(queuedFirst)

  assert.deepEqual(playback.clear('u-1', 1), { playedMs: 32 })
  assert.equal(playback.clear('u-1', 1), null)
})

test('clear fences a generation even when it overtakes the first audio frame', () => {
  const playback = new GenerationPlayback()

  assert.equal(playback.clear('u-1', 3), null)
  assert.equal(playback.accept(decodeAudioFrame(audioFrame({ epoch: 3 }))), false)
  assert.equal(playback.accept(decodeAudioFrame(audioFrame({
    utterance: 'u-2', epoch: 4,
  }))), true)
})

test('alert command clears the exact old generation before starting one tone', async () => {
  const order = []
  const playback = new GenerationPlayback({
    stopAll: () => {
      order.push('clear')
      return 12
    },
  })
  playback.accept(decodeAudioFrame(audioFrame()))

  const result = await applyAlertCommand(
    playback,
    { type: 'playback.alert', utterance_id: 'u-1', generation_epoch: 1 },
    {
      startTone: () => order.push('tone'),
      clearNative: () => order.push('native'),
    },
  )

  assert.deepEqual(order, ['clear', 'tone'])
  assert.deepEqual(result, { cleared: true, playedMs: 12 })
})

test('stale and tone-only alerts beep without clearing a newer generation', async () => {
  const tones = []
  const playback = new GenerationPlayback()
  playback.accept(decodeAudioFrame(audioFrame({ utterance: 'new', epoch: 2 })))

  assert.deepEqual(await applyAlertCommand(
    playback,
    { type: 'playback.alert', utterance_id: 'old', generation_epoch: 1 },
    { startTone: () => tones.push('stale'), clearNative: () => assert.fail() },
  ), { cleared: false, playedMs: 0 })
  assert.equal(playback.current.utteranceId, 'new')

  assert.deepEqual(await applyAlertCommand(
    playback,
    { type: 'playback.alert' },
    { startTone: () => tones.push('tone-only'), clearNative: () => assert.fail() },
  ), { cleared: false, playedMs: 0 })
  assert.equal(playback.current.utteranceId, 'new')
  assert.deepEqual(tones, ['stale', 'tone-only'])
})

test('alert command rejects half an identity', async () => {
  const playback = new GenerationPlayback()

  await assert.rejects(
    applyAlertCommand(
      playback,
      { type: 'playback.alert', utterance_id: 'old' },
      { startTone: () => {}, clearNative: () => {} },
    ),
    /identity/,
  )
})

test('native alert starts one tone after local fencing and native clear dispatch', async () => {
  const calls = []
  let releaseClear
  const playback = new GenerationPlayback()
  playback.accept(decodeAudioFrame(audioFrame()))
  playback.current.backend = 'native'
  const originalClear = playback.clear.bind(playback)
  playback.clear = (...args) => {
    calls.push('playback.clear')
    return originalClear(...args)
  }

  const command = applyAlertCommand(
    playback,
    { type: 'playback.alert', utterance_id: 'u-1', generation_epoch: 1 },
    {
      startTone: () => calls.push('tone.start'),
      clearNative: (utteranceId, generationEpoch) => new Promise(resolve => {
        calls.push('native.clear')
        releaseClear = value => {
          calls.push('native.clear.resolved')
          resolve(value)
        }
      }),
    },
  )

  await Promise.resolve()
  assert.deepEqual(calls.slice(0, 3), ['playback.clear', 'native.clear', 'tone.start'])
  let clearResolved = false
  command.then(() => { clearResolved = true })
  await Promise.resolve()
  assert.equal(clearResolved, false)
  releaseClear({ playedMs: 25 })
  assert.deepEqual(await command, { cleared: true, playedMs: 25 })
  assert.equal(calls.at(-1), 'native.clear.resolved')
  assert.equal(calls.filter(call => call === 'tone.start').length, 1)
})

test('alert tone replaces the prior oscillator and stops at exactly 100 ms', () => {
  const oscillators = []
  const context = {
    currentTime: 2,
    destination: {},
    createOscillator() {
      const oscillator = {
        type: '',
        frequency: { setValueAtTime: () => {} },
        stops: [],
        connect: () => {},
        disconnect: () => {},
        start: () => {},
        stop(when) { this.stops.push(when) },
        onended: null,
      }
      oscillators.push(oscillator)
      return oscillator
    },
    createGain() {
      return {
        gain: {
          setValueAtTime: () => {},
          linearRampToValueAtTime: () => {},
        },
        connect: () => {},
        disconnect: () => {},
      }
    },
  }
  const tone = new AlertTone()

  tone.play(context)
  assert.deepEqual(oscillators[0].stops, [2.1])
  tone.play(context)
  assert.deepEqual(oscillators[0].stops, [2.1, undefined])
  assert.deepEqual(oscillators[1].stops, [2.1])
  tone.stop()
  tone.stop()
  assert.deepEqual(oscillators[1].stops, [2.1, undefined])
})

test('releases the completed generation so the next response can play', () => {
  const playback = new GenerationPlayback()
  const first = decodeAudioFrame(audioFrame())
  playback.accept(first, 'browser')
  const active = playback.dequeue()
  playback.markProviderTerminal('u-1', 1)
  assert.ok(playback.frameEnded(active))

  assert.equal(playback.current, null)
  assert.equal(playback.accept(decodeAudioFrame(audioFrame({
    utterance: 'u-2', epoch: 2, sequence: 0,
  })), 'native'), true)
})

test('pins one playback backend for the complete generation', () => {
  const playback = new GenerationPlayback()
  const first = decodeAudioFrame(audioFrame({ utterance: 'utterance-1' }))
  const second = decodeAudioFrame(audioFrame({ utterance: 'utterance-1', sequence: 1 }))

  assert.equal(playback.accept(first, 'browser'), true)
  assert.equal(playback.current.backend, 'browser')
  assert.equal(playback.accept(second, 'native'), false)
  assert.equal(playback.accept(second, 'browser'), true)
  assert.equal(playback.current.backend, 'browser')
})

test('waits for native capture result before selecting native or browser AEC', async () => {
  assert.equal(typeof audioModule.activateCaptureMode, 'function')
  let resolveNative
  let browserCalls = 0
  const activation = audioModule.activateCaptureMode({
    nativeAvailable: true,
    activateNative: () => new Promise(resolve => { resolveNative = resolve }),
    activateBrowser: async () => {
      browserCalls += 1
      return { audioMode: 'browser_aec' }
    },
  })
  let settled = false
  activation.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(browserCalls, 0)

  resolveNative({ audioMode: 'browser_aec' })
  assert.deepEqual(await activation, { audioMode: 'browser_aec' })
  assert.equal(browserCalls, 1)
})

test('releases a late browser fallback after the user deactivates capture', async () => {
  assert.equal(typeof audioModule.fallbackToBrowserCapture, 'function')
  const state = { activated: true, activationPending: false }
  let resolveCapture
  let releases = 0
  const fallback = audioModule.fallbackToBrowserCapture({
    state,
    activateBrowser: () => new Promise(resolve => { resolveCapture = resolve }),
    releaseBrowser: () => { releases += 1 },
  })

  assert.equal(state.activationPending, true)
  state.activated = false
  resolveCapture({ audioMode: 'browser_aec' })

  assert.equal(await fallback, null)
  assert.equal(releases, 1)
  assert.equal(state.activationPending, false)
})

test('batches capture quanta before transfer out of an AudioWorklet', () => {
  assert.equal(typeof audioModule.CaptureAccumulator, 'function')
  const capture = new audioModule.CaptureAccumulator(4)

  assert.deepEqual(capture.push([[new Float32Array([0.25, -0.5])]]), [])
  const batches = capture.push([[new Float32Array([0.75, -1])]])

  assert.equal(batches.length, 1)
  assert.deepEqual([...batches[0]], [0.25, -0.5, 0.75, -1])
  assert.deepEqual(capture.push([]), [])
})

test('bounds queued PCM bytes', () => {
  const playback = new GenerationPlayback({ maxQueuedBytes: 2 })
  assert.equal(playback.accept(decodeAudioFrame(audioFrame())), true)
  assert.equal(playback.accept(decodeAudioFrame(audioFrame({ sequence: 1 }))), false)
})

test('onset tracker sends one onset then periodic refreshes with a stable id', () => {
  let minted = 0
  const tracker = new audioModule.OnsetTracker({ mintId: () => `s-${minted += 1}` })

  assert.equal(tracker.observe(0.1, 10, 10), null)
  assert.deepEqual(tracker.observe(0.1, 60, 50), { type: 'onset', speechId: 's-1' })
  assert.equal(tracker.observe(0.1, 5060), null)
  assert.deepEqual(tracker.observe(0.1, 10_060), { type: 'refresh', speechId: 's-1' })
  assert.equal(tracker.observe(0.1, 15_060), null)
  assert.equal(tracker.active, true)
})

test('onset tracker mints a new utterance only after the hangover expires', () => {
  let minted = 0
  const tracker = new audioModule.OnsetTracker({ mintId: () => `s-${minted += 1}` })
  tracker.observe(0.1, 10, 10)
  tracker.observe(0.1, 60, 50)

  assert.equal(tracker.observe(0.0, 100), null)
  assert.equal(tracker.active, true)
  assert.equal(tracker.observe(0.0, 300), null)
  assert.equal(tracker.active, false)
  assert.equal(tracker.observe(0.1, 410, 10), null)
  assert.deepEqual(tracker.observe(0.1, 460, 50), { type: 'onset', speechId: 's-2' })
  tracker.reset()
  assert.equal(tracker.active, false)
})

test('onset tracker ignores a one-frame level spike', () => {
  let minted = 0
  const tracker = new audioModule.OnsetTracker({ mintId: () => `s-${minted += 1}` })

  assert.equal(tracker.observe(0.1, 10, 10), null)
  assert.equal(tracker.observe(0.0, 20), null)
  assert.equal(tracker.active, false)
  assert.equal(minted, 0)
})

for (const sampleRate of [44_100, 48_000]) {
  test(`browser onset verdict arrives within 60 ms at ${sampleRate} Hz`, () => {
    let minted = 0
    const tracker = new audioModule.OnsetTracker({ mintId: () => `s-${minted += 1}` })
    const capture = new audioModule.CaptureAccumulator()
    const captured = new Float32Array(capture.frameLength).fill(0.1)
    const pcm = floatToPcm16(captured, sampleRate)
    const frameMs = captured.length / sampleRate * 1000
    let deliveredAt = 0
    let verdict = null
    while (verdict === null && deliveredAt <= 100) {
      deliveredAt += frameMs
      verdict = observePcmOnset(pcm, tracker, deliveredAt)
    }

    assert.deepEqual(verdict, {
      type: 'onset', speechId: 's-1',
    })
    assert.ok(deliveredAt <= 60)
  })
}

test('reset clears a pending onset candidate', () => {
  let minted = 0
  const tracker = new audioModule.OnsetTracker({ mintId: () => `s-${minted += 1}` })

  assert.equal(tracker.observe(0.1, 40, 40), null)
  tracker.reset()
  assert.equal(tracker.observe(0.1, 60, 20), null)
  assert.equal(minted, 0)
})
