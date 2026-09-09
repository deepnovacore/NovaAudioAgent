import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
const source = (await readFile(new URL('../src/audio.mjs', import.meta.url), 'utf8'))
  .replace("'/shared/audio.mjs'", JSON.stringify(new URL('../../desktop/src/renderer/audio.mjs', import.meta.url).href))
const {createBrowserAudio} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

function setup(getUserMedia) {
  const contexts = [], processors = [], sent = []
  const track = {enabled: true, stopped: false, stop() { this.stopped = true }, getSettings: () => ({echoCancellation: true})}
  const stream = {getTracks: () => [track], getAudioTracks: () => [track]}
  const node = () => ({connect() {}, disconnect() {}, gain: {value: 1}})
  globalThis.AudioContext = class {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 48_000; this.destination = {}; this.sources = []; this.audioWorklet = {addModule: async () => {}}; contexts.push(this) }
    async resume() { this.state = 'running' }
    async close() { this.state = 'closed' }
    createGain() { return node() }
    createAnalyser() { return {...node(), getByteTimeDomainData: array => array.fill(128)} }
    createMediaStreamSource() { return node() }
    createBuffer(_, length) { return {getChannelData: () => new Float32Array(length)} }
    createBufferSource() { const result = {...node(), start(at) { this.at = at }, stop() { this.stopped = true }}; this.sources.push(result); return result }
  }
  globalThis.AudioWorkletNode = class {
    constructor() { Object.assign(this, node()); this.port = {postMessage: message => { this.epoch = message.epoch }}; processors.push(this) }
  }
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {mediaDevices: {
    getUserMedia: getUserMedia ?? (async () => stream), enumerateDevices: async () => [],
  }}})
  const audio = createBrowserAudio({send: value => sent.push(value)})
  return {audio, contexts, processors, sent, stream, track}
}
function frame(sequence = 0, bytes = 48_000, epoch = 1) {
  const header = new TextEncoder().encode(JSON.stringify({utterance_id: 'u', generation_epoch: epoch, sequence}))
  const value = new Uint8Array(6 + header.length + bytes)
  value.set(new TextEncoder().encode('NOVA'))
  new DataView(value.buffer).setUint16(4, header.length)
  value.set(header, 6)
  return value
}

test('startup activates context synchronously and releases a late permission result after stop', async () => {
  let resolve
  const state = setup(() => new Promise(done => { resolve = done }))
  const pending = state.audio.start()
  assert.equal(state.contexts[0].state, 'running')
  state.audio.stop()
  resolve(state.stream)
  await pending
  assert.equal(state.track.stopped, true)
  assert.equal(state.processors.length, 0)
})

test('capture resamples the actual context rate and fences samples across mute/unmute', async () => {
  const {audio, processors, sent} = setup()
  await audio.start()
  try {
    const processor = processors[0]
    const initialEpoch = processor.epoch
    const deliver = epoch => processor.port.onmessage({data: {epoch, samples: new Float32Array(480)}})
    deliver(initialEpoch)
    assert.equal(sent[0].byteLength, 320)
    audio.setMuted(true)
    audio.setMuted(false)
    deliver(initialEpoch)
    assert.equal(sent.length, 1)
    deliver(processor.epoch)
    assert.equal(sent.length, 2)
  } finally { audio.stop() }
})

test('clear accounts for partially audible frames and fences subsequent old generation frames', async () => {
  const {audio, contexts, sent} = setup()
  await audio.start()
  try {
    await audio.receive(frame())
    contexts[0].currentTime = 0.375
    await audio.control({type: 'playback.clear', utterance_id: 'u', generation_epoch: 1})
    assert.equal(sent.at(-1).played_ms, 375)
    assert.equal(contexts[0].sources[0].stopped, true)
    await audio.receive(frame(1))
    assert.equal(contexts[0].sources.length, 1)
  } finally { audio.stop() }
})

test('done requires terminal and every scheduled source to finish', async () => {
  const {audio, contexts, sent} = setup()
  await audio.start()
  try {
    await audio.receive(frame())
    await audio.receive(frame(1))
    await audio.control({type: 'playback.terminal', utterance_id: 'u', generation_epoch: 1})
    contexts[0].sources[0].onended()
    assert.equal(sent.some(value => value.type === 'playback.done'), false)
    contexts[0].sources[1].onended()
    assert.equal(sent.at(-1).type, 'playback.done')
    assert.equal(sent.at(-1).played_ms, 2000)
    assert.equal(sent.filter(value => value.type === 'playback.started').length, 1)
  } finally { audio.stop() }
})

test('scheduled horizon stops explicitly at 60 seconds', async () => {
  const {audio, contexts, sent} = setup()
  await audio.start()
  try {
    for (let i = 0; i < 61; i++) await audio.receive(frame(i))
    assert.equal(contexts[0].sources.length, 60)
    assert.equal(sent.at(-1).type, 'playback.stopped')
    assert.equal(contexts[0].sources.every(node => node.stopped), true)
  } finally { audio.stop() }
})

test('reconnect clears output, preserves capture, and resets epochs only for a changed server', async () => {
  const {audio, contexts, track} = setup()
  await audio.start()
  try {
    await audio.receive(frame())
    audio.resetPlayback()
    assert.equal(track.stopped, false)
    assert.equal(contexts[0].sources[0].stopped, true)
    await audio.receive(frame())
    assert.equal(contexts[0].sources.length, 1)
    audio.resetPlayback({serverChanged: true})
    await audio.receive(frame())
    assert.equal(contexts[0].sources.length, 2)
  } finally { audio.stop() }
})

test('stopping a muted session resets capture mute on the next start', async () => {
  const {audio, processors, sent, track} = setup()
  await audio.start()
  audio.setMuted(true)
  audio.stop()
  await audio.start()
  try {
    assert.equal(track.enabled, true)
    const processor = processors.at(-1)
    processor.port.onmessage({data: {epoch: processor.epoch, samples: new Float32Array(480)}})
    assert.equal(sent.at(-1).byteLength, 320)
  } finally { audio.stop() }
})
