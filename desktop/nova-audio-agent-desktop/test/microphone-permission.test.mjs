import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyMicrophoneFailure,
  preflightMicrophone,
} from '../src/renderer/microphone-permission.mjs'

test('microphone preflight requests audio once and immediately stops every track', async () => {
  const constraints = []
  const stopped = []
  const result = await preflightMicrophone({
    mediaDevices: {
      async getUserMedia(value) {
        constraints.push(value)
        return {
          getTracks: () => [
            { stop: () => stopped.push('first') },
            { stop: () => stopped.push('second') },
          ],
        }
      },
    },
  })

  assert.deepEqual(constraints, [{ audio: true, video: false }])
  assert.deepEqual(stopped, ['first', 'second'])
  assert.deepEqual(result, { status: 'granted' })
})

test('microphone preflight reports permission denial without retaining or exposing the error', async () => {
  const result = await preflightMicrophone({
    mediaDevices: {
      async getUserMedia() {
        const error = new Error('C:/private/path-sentinel')
        error.name = 'NotAllowedError'
        throw error
      },
    },
  })

  assert.deepEqual(result, { status: 'permission_denied' })
  assert.doesNotMatch(JSON.stringify(result), /path-sentinel/)
})

test('microphone preflight is stable when media capture is unavailable', async () => {
  assert.deepEqual(
    await preflightMicrophone({ mediaDevices: null }),
    { status: 'capture_unavailable' },
  )
  assert.deepEqual(
    await preflightMicrophone({ mediaDevices: {} }),
    { status: 'capture_unavailable' },
  )
})

test('microphone failures retain an actionable bounded taxonomy', () => {
  for (const [name, systemStatus, expected] of [
    ['NotAllowedError', 'unknown', 'permission_denied'],
    ['SecurityError', 'unknown', 'permission_denied'],
    ['NotFoundError', 'unknown', 'no_input_device'],
    ['DevicesNotFoundError', 'unknown', 'no_input_device'],
    ['NotReadableError', 'unknown', 'device_busy'],
    ['TrackStartError', 'unknown', 'device_busy'],
    ['AbortError', 'unknown', 'device_busy'],
    ['UnknownError', 'unknown', 'capture_unavailable'],
    ['NotAllowedError', 'restricted', 'restricted'],
  ]) {
    assert.equal(classifyMicrophoneFailure({ name }, systemStatus), expected, name)
  }
})

test('a definitive macOS system denial wins over an ambiguous browser failure', async () => {
  const result = await preflightMicrophone({
    systemStatus: 'denied',
    mediaDevices: {
      async getUserMedia() {
        throw Object.assign(new Error('opaque'), { name: 'UnknownError' })
      },
    },
  })

  assert.deepEqual(result, { status: 'permission_denied' })
})
