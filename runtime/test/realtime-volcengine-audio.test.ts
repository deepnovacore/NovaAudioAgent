import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_VOLCENGINE_WIRE_FRAME_BYTES,
  VOLCENGINE_INPUT_AUDIO_FORMAT,
  VOLCENGINE_OUTPUT_AUDIO_FORMAT,
  pcm16BytesForDuration,
  volcengineInputPcm,
  volcengineOutputPcm,
} from '../src/realtime/volcengine/audio.js'
import { MAX_REALTIME_PCM_BYTES } from '../src/realtime/protocol.js'

test('Volcengine PCM boundaries attach exact directional formats and copy caller bytes', () => {
  const inputBytes = new Uint8Array([1, 2, 3, 4])
  const outputBytes = new Uint8Array([5, 6, 7, 8])
  const input = volcengineInputPcm(inputBytes)
  const output = volcengineOutputPcm(outputBytes)
  inputBytes[0] = 9
  outputBytes[0] = 9
  assert.equal(input.format, VOLCENGINE_INPUT_AUDIO_FORMAT)
  assert.equal(output.format, VOLCENGINE_OUTPUT_AUDIO_FORMAT)
  assert.deepEqual([...input.pcm], [1, 2, 3, 4])
  assert.deepEqual([...output.pcm], [5, 6, 7, 8])
})

test('Volcengine PCM boundaries reject empty, odd, and oversized frames', () => {
  assert.doesNotThrow(() => volcengineInputPcm(new Uint8Array(MAX_REALTIME_PCM_BYTES)))
  assert.throws(() => volcengineInputPcm(new Uint8Array(MAX_REALTIME_PCM_BYTES + 2)))
  assert.doesNotThrow(() => volcengineOutputPcm(new Uint8Array(MAX_VOLCENGINE_WIRE_FRAME_BYTES)))
  assert.throws(() => volcengineOutputPcm(new Uint8Array(MAX_VOLCENGINE_WIRE_FRAME_BYTES + 2)))
  for (const invalid of [new Uint8Array(), new Uint8Array(3)]) {
    assert.throws(() => volcengineInputPcm(invalid))
    assert.throws(() => volcengineOutputPcm(invalid))
  }
})

test('PCM duration bytes use the Python integer-floor formula', () => {
  assert.equal(pcm16BytesForDuration(16_000, 200), 6_400)
  assert.equal(pcm16BytesForDuration(3, 500), 2)
  for (const [rate, duration] of [[0, 1], [1, 0], [1.5, 2], [2, Number.MAX_SAFE_INTEGER]]) {
    assert.throws(() => pcm16BytesForDuration(rate!, duration!))
  }
  assert.throws(() => pcm16BytesForDuration(1, 1))
})
