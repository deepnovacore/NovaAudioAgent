import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_PLAYBACK_FRAME_BYTES,
  MAX_RENDERER_TOMBSTONES,
  PlaybackRegistry,
  type PlaybackFrame,
  type PlaybackGeneration,
} from '../src/playback.js'

function ids(...values: string[]): () => string {
  let offset = 0
  return () => {
    const value = values[offset]
    if (value === undefined) throw new Error('test id sequence exhausted')
    offset += 1
    return value
  }
}

function registry(options: {
  readonly values?: readonly string[]
  readonly frames?: PlaybackFrame[]
  readonly clears?: [string, number][]
  readonly alerts?: [string | null, number | null][]
} = {}): PlaybackRegistry {
  return new PlaybackRegistry({
    idFactory: ids(...(options.values ?? ['generation-1', 'utterance-1'])),
    onFrame: frame => options.frames?.push(frame),
    onClear: (utteranceId, epoch) => options.clears?.push([utteranceId, epoch]),
    onAlert: (utteranceId, epoch) => options.alerts?.push([utteranceId, epoch]),
  })
}

test('unknown and fenced response PCM never reaches the renderer', () => {
  const frames: PlaybackFrame[] = []
  const clears: [string, number][] = []
  const playback = registry({frames, clears})
  assert.equal(playback.pushAudio({sessionEpoch: 1, responseId: 'foreign', pcm: Uint8Array.of(0, 1)}), false)
  const generation = playback.openResponse({sessionEpoch: 1, responseId: 'response-1'})
  assert.equal(playback.pushAudio({sessionEpoch: 1, responseId: 'response-1', pcm: Uint8Array.of(0, 1)}), true)
  assert.deepEqual(playback.fenceCurrent(), generation)
  assert.equal(playback.pushAudio({sessionEpoch: 1, responseId: 'response-1', pcm: Uint8Array.of(2, 3)}), false)
  assert.deepEqual(clears, [['utterance-1', 1]])
  assert.deepEqual(frames.map(frame => ({...frame, pcm: [...frame.pcm]})), [{
    utterance_id: 'utterance-1', generation_epoch: 1, sequence: 0, pcm: [0, 1],
  }])
})

test('done acknowledgement requires exact identity and provider terminal', () => {
  const playback = registry()
  const generation = playback.openResponse({sessionEpoch: 1, responseId: 'response-1'})
  playback.pushAudio({sessionEpoch: 1, responseId: 'response-1', pcm: Uint8Array.of(0, 1)})
  playback.setTranscript({sessionEpoch: 1, responseId: 'response-1', text: 'done'})
  assert.equal(playback.ackDone(generation.utterance_id, generation.generation_epoch), null)
  playback.markProviderTerminal({sessionEpoch: 1, responseId: 'response-1'})
  assert.equal(playback.ackDone('foreign', generation.generation_epoch), null)
  assert.deepEqual(playback.ackDone(generation.utterance_id, generation.generation_epoch, 100), {
    session_epoch: 1,
    response_id: 'response-1',
    utterance_id: 'utterance-1',
    generation_epoch: 1,
    text: 'done',
    disposition: 'spoken',
    started: false,
    played_ms: 100,
  })
  assert.equal(playback.ackDone(generation.utterance_id, generation.generation_epoch), null)
})

test('barge-in completion distinguishes audible interruption from suppression', () => {
  const audible = registry()
  const first = audible.openResponse({sessionEpoch: 1, responseId: 'first'})
  audible.setTranscript({sessionEpoch: 1, responseId: 'first', text: 'interrupted'})
  audible.markStarted(first.utterance_id, first.generation_epoch)
  audible.fenceCurrent()
  assert.equal(audible.hasUnreportedFence, true)
  assert.deepEqual(audible.recordCleared(first.utterance_id, first.generation_epoch, 350), {
    session_epoch: 1,
    response_id: 'first',
    utterance_id: 'utterance-1',
    generation_epoch: 1,
    text: 'interrupted',
    disposition: 'interrupted',
    started: true,
    played_ms: 350,
  })
  assert.equal(audible.hasUnreportedFence, false)

  const suppressed = registry()
  const second = suppressed.openResponse({sessionEpoch: 1, responseId: 'second'})
  suppressed.fenceCurrent()
  assert.equal(suppressed.recordCleared(second.utterance_id, second.generation_epoch, 0)?.disposition, 'suppressed')
})

test('an interrupted provider terminal cannot become spoken after drain', () => {
  const playback = registry()
  const generation = playback.openResponse({sessionEpoch: 1, responseId: 'old'})
  playback.pushAudio({sessionEpoch: 1, responseId: 'old', pcm: Uint8Array.of(0, 1)})
  playback.markProviderTerminal({sessionEpoch: 1, responseId: 'old', disposition: 'interrupted'})
  assert.equal(playback.ackDone(generation.utterance_id, generation.generation_epoch, 20)?.disposition, 'interrupted')

  const silent = registry()
  const silentGeneration = silent.openResponse({sessionEpoch: 1, responseId: 'old'})
  silent.pushAudio({sessionEpoch: 1, responseId: 'old', pcm: Uint8Array.of(0, 1)})
  silent.markProviderTerminal({sessionEpoch: 1, responseId: 'old', disposition: 'interrupted'})
  assert.equal(silent.ackDone(silentGeneration.utterance_id, silentGeneration.generation_epoch, 0)?.disposition, 'suppressed')
})

test('provider terminal and fence retain late transcript until renderer delivery', () => {
  const terminal = registry()
  terminal.openResponse({sessionEpoch: 1, responseId: 'response-1'})
  terminal.pushAudio({sessionEpoch: 1, responseId: 'response-1', pcm: Uint8Array.of(0, 1)})
  terminal.markProviderTerminal({sessionEpoch: 1, responseId: 'response-1'})
  assert.equal(terminal.setTranscript({sessionEpoch: 1, responseId: 'response-1', text: 'final'}), true)
  assert.equal(terminal.ackDone('utterance-1', 1)?.text, 'final')

  const fenced = registry()
  const generation = fenced.openResponse({sessionEpoch: 1, responseId: 'response-1'})
  fenced.fenceCurrent()
  assert.equal(fenced.setTranscript({sessionEpoch: 1, responseId: 'response-1', text: 'interrupted final'}), true)
  assert.equal(fenced.recordCleared(generation.utterance_id, generation.generation_epoch, 10)?.text, 'interrupted final')
})

test('zero-frame terminal retires without an invented renderer completion', () => {
  const playback = registry()
  const generation = playback.openResponse({sessionEpoch: 1, responseId: 'response-1'})
  assert.equal(playback.markProviderTerminal({sessionEpoch: 1, responseId: 'response-1'}), true)
  assert.equal(playback.current, null)
  assert.equal(playback.ackDone(generation.utterance_id, generation.generation_epoch), null)
})

test('large PCM deltas split into copied, ordered, bounded frames', () => {
  const frames: PlaybackFrame[] = []
  const playback = registry({frames})
  playback.openResponse({sessionEpoch: 1, responseId: 'response-1'})
  const pcm = new Uint8Array(MAX_PLAYBACK_FRAME_BYTES + 34)
  assert.equal(playback.pushAudio({sessionEpoch: 1, responseId: 'response-1', pcm}), true)
  assert.deepEqual(frames.map(frame => frame.sequence), [0, 1])
  assert.deepEqual(frames.map(frame => frame.pcm.byteLength), [MAX_PLAYBACK_FRAME_BYTES, 34])
  pcm[0] = 255
  assert.equal(frames[0]?.pcm[0], 0)
})

test('provider identity includes session epoch when response ids repeat', () => {
  const frames: PlaybackFrame[] = []
  const clears: [string, number][] = []
  const playback = registry({
    values: ['generation-old', 'utterance-old', 'generation-new', 'utterance-new'],
    frames,
    clears,
  })
  const old = playback.openResponse({sessionEpoch: 1, responseId: 'reused'})
  playback.pushAudio({sessionEpoch: 1, responseId: 'reused', pcm: Uint8Array.of(0, 1)})
  playback.switchGeneration(old)
  const fresh = playback.openResponse({sessionEpoch: 2, responseId: 'reused'})
  playback.pushAudio({sessionEpoch: 2, responseId: 'reused', pcm: Uint8Array.of(2, 3)})
  assert.equal(playback.pushAudio({sessionEpoch: 3, responseId: 'reused', pcm: Uint8Array.of(4, 5)}), false)
  playback.setTranscript({sessionEpoch: 1, responseId: 'reused', text: 'old'})
  playback.setTranscript({sessionEpoch: 2, responseId: 'reused', text: 'new'})
  playback.markProviderTerminal({sessionEpoch: 2, responseId: 'reused'})
  assert.equal(playback.recordCleared(old.utterance_id, old.generation_epoch, 10)?.text, 'old')
  assert.equal(playback.ackDone(fresh.utterance_id, fresh.generation_epoch, 20)?.text, 'new')
  assert.deepEqual(clears, [['utterance-old', 1]])
  assert.deepEqual(frames.map(frame => frame.utterance_id), ['utterance-old', 'utterance-new'])
})

test('generation switches and alerts require the exact generation value', () => {
  const clears: [string, number][] = []
  const alerts: [string | null, number | null][] = []
  const playback = registry({
    values: ['generation-1', 'utterance-1', 'generation-2', 'utterance-2'],
    clears,
    alerts,
  })
  const first = playback.openResponse({sessionEpoch: 1, responseId: 'response'})
  const wrong: PlaybackGeneration = {...first, session_epoch: 2}
  assert.equal(playback.switchGeneration(wrong), false)
  assert.equal(playback.switchGeneration(first), true)
  assert.equal(playback.switchGeneration(first), false)
  const second = playback.openResponse({sessionEpoch: 2, responseId: 'response'})
  assert.equal(playback.alertFenceGeneration(first), false)
  assert.equal(playback.alertFenceGeneration(second), true)
  assert.equal(playback.alertFenceGeneration(second), false)
  assert.deepEqual(clears, [['utterance-1', 1]])
  assert.deepEqual(alerts, [['utterance-2', 2]])
})

test('retiring an unknown clear keeps late ack inert after replacement', () => {
  const playback = registry({values: ['generation-old', 'utterance-old', 'generation-new', 'utterance-new']})
  const old = playback.openResponse({sessionEpoch: 1, responseId: 'reused'})
  playback.pushAudio({sessionEpoch: 1, responseId: 'reused', pcm: Uint8Array.of(0, 1)})
  playback.switchGeneration(old)
  assert.equal(playback.retireClearUnknown({...old, session_epoch: 2}), false)
  assert.equal(playback.retireClearUnknown(old), true)
  const fresh = playback.openResponse({sessionEpoch: 2, responseId: 'reused'})
  assert.equal(playback.recordCleared(old.utterance_id, old.generation_epoch, 100), null)
  assert.deepEqual(playback.current, fresh)
})

test('normal retirement bounds renderer tombstones', () => {
  let sequence = 0
  const playback = new PlaybackRegistry({
    idFactory: () => `id-${++sequence}`,
    onFrame: () => undefined,
    onClear: () => undefined,
  })
  let first: PlaybackGeneration | null = null
  for (let index = 0; index < MAX_RENDERER_TOMBSTONES + 17; index += 1) {
    const generation = playback.openResponse({sessionEpoch: 1, responseId: `response-${index}`})
    first ??= generation
    playback.pushAudio({sessionEpoch: 1, responseId: generation.response_id, pcm: Uint8Array.of(0, 1)})
    playback.markProviderTerminal({sessionEpoch: 1, responseId: generation.response_id})
    assert.notEqual(playback.ackDone(generation.utterance_id, generation.generation_epoch), null)
  }
  assert.equal(playback.rendererTombstoneCount, MAX_RENDERER_TOMBSTONES)
  assert.equal(playback.ackDone(first!.utterance_id, first!.generation_epoch), null)
})
