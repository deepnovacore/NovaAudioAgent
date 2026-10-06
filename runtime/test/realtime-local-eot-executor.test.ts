import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import {createEndpointingCapabilityFactory} from '../src/realtime/volcengine/endpointing-capability.js'
import {localEotExecutor} from '../src/realtime/volcengine/local-eot-executor.js'
import {LiveKitVolcEndpointing} from '../src/realtime/volcengine/livekit-endpointing.js'

test('local EOT rejects unsupported methods and malformed PCM before loading native code', async () => {
  await assert.rejects(localEotExecutor.doInference('unknown', {pcm: 'AAA='}), TypeError)
  await assert.rejects(localEotExecutor.doInference('lk_eot_audio', {}), TypeError)
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(38_402)]) {
    await assert.rejects(localEotExecutor.doInference('lk_eot_audio', {pcm: bytes.toString('base64')}), RangeError)
  }
})

test('standalone production factory runs native VAD and EOT and commits an audio turn', {
  skip: process.env.NOVA_TEST_NATIVE_EOT !== '1',
  timeout: 30_000,
}, async () => {
  // A fresh Node test worker has no LiveKit JobContext or injected executor.
  const keepalive = setInterval(() => undefined, 1_000)
  let endpointing: LiveKitVolcEndpointing | undefined
  try {
    const signal = AbortSignal.timeout(25_000)
    const prepared = await createEndpointingCapabilityFactory()({signal})
    assert.deepEqual(prepared.result.vad, {available: true, reason: 'ready'})
    assert.deepEqual(prepared.result.eot, {available: true, reason: 'ready'})
    assert.equal(prepared.result.mode, 'livekit_v1_mini')
    assert.ok(prepared.surface)
    assert.ok(prepared.executor)
    endpointing = new LiveKitVolcEndpointing({surface: prepared.surface, executor: prepared.executor,
      config: {vadThreshold: 0.5, vadPreRollMs: 260, vadMinSpeechMs: 250,
        vadSilenceEndMs: 300, vadSpeechPadMs: 30, vadMaxUtteranceMs: 60_000}})
    const speech = await readFile(new URL('../../../assets/endpointing/volcengine-v1/speech-16k-s16le.pcm', import.meta.url))
    const input = Buffer.concat([speech, Buffer.alloc(16_000 * 2 * 3)])
    const events = []
    for (let offset = 0; offset < input.length; offset += 1_024) {
      events.push(...await endpointing.feed(input.subarray(offset, offset + 1_024), signal))
    }
    assert.ok(events.some(event => event.kind === 'speech_start'))
    assert.ok(events.some(event => event.kind === 'speech_audio'))
    assert.ok(events.some(event => event.kind === 'speech_end' && event.commit))
  } finally {
    await endpointing?.close()
    clearInterval(keepalive)
  }
})
