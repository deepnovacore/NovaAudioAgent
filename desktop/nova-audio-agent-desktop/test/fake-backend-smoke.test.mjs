import assert from 'node:assert/strict'
import test from 'node:test'

import { GenerationPlayback, decodeAudioFrame } from '../src/renderer/audio.mjs'

function frame(utteranceId, epoch, sequence) {
  const header = Buffer.from(JSON.stringify({
    utterance_id: utteranceId,
    generation_epoch: epoch,
    sequence,
  }))
  const prefix = Buffer.alloc(6)
  prefix.write('NOVA')
  prefix.writeUInt16BE(header.length, 4)
  return decodeAudioFrame(Buffer.concat([prefix, header, Buffer.from([0, 1])]))
}

test('fake backend response interruption and replacement session complete safely', () => {
  let localStops = 0
  const playback = new GenerationPlayback({ stopAll: () => { localStops += 1 } })

  assert.equal(playback.accept(frame('progress-utterance', 1, 0)), true)
  assert.ok(playback.dequeue())
  assert.deepEqual(playback.clear('progress-utterance', 1), { playedMs: 0 })
  assert.equal(localStops, 1)
  assert.equal(playback.accept(frame('progress-utterance', 1, 1)), false)

  assert.equal(playback.accept(frame('foreground-utterance', 2, 0)), true)
  const foreground = playback.dequeue()
  assert.equal(playback.markProviderTerminal('foreground-utterance', 2), null)
  assert.deepEqual(playback.frameEnded(foreground), {
    type: 'playback.done',
    utterance_id: 'foreground-utterance',
    generation_epoch: 2,
    played_ms: 0,
  })
})
