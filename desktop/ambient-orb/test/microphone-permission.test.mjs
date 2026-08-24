import assert from 'node:assert/strict'
import test from 'node:test'

import { preflightMicrophone } from '../src/renderer/microphone-permission.mjs'

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

test('microphone preflight reports denial without retaining or exposing the error', async () => {
  const result = await preflightMicrophone({
    mediaDevices: {
      async getUserMedia() {
        throw new Error('C:/private/path-sentinel')
      },
    },
  })

  assert.deepEqual(result, { status: 'denied' })
  assert.doesNotMatch(JSON.stringify(result), /path-sentinel/)
})

test('microphone preflight is stable when media capture is unavailable', async () => {
  assert.deepEqual(await preflightMicrophone({ mediaDevices: null }), { status: 'unavailable' })
  assert.deepEqual(await preflightMicrophone({ mediaDevices: {} }), { status: 'unavailable' })
})
