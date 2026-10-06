import assert from 'node:assert/strict'
import {test} from 'node:test'
import {transcribeDraft} from '../src/realtime/cascaded/transcribe.js'
import {DictationError} from '../src/realtime/dictation.js'

function tone(bytes: number, amplitude = 4000): Uint8Array {
  const pcm = new Uint8Array(bytes), view = new DataView(pcm.buffer)
  for (let index = 0; index < bytes / 2; index++) view.setInt16(index * 2, index % 2 ? amplitude : -amplitude, true)
  return pcm
}

test('draft ASR returns only a final transcript and closes the isolated session', async () => {
  let finished = false, closed = false, bytes = 0
  let release!: () => void
  const done = new Promise<void>(resolve => {release = resolve})
  const result = await transcribeDraft({open: () => Promise.resolve({
    append: pcm => {bytes += pcm.length; return Promise.resolve()},
    finish: () => {finished = true; release(); return Promise.resolve()},
    events: async function* () {yield {text: '部', final: false}; await done; yield {text: '可以编辑的草稿', final: true}},
    close: () => {closed = true; return Promise.resolve()},
  })}, tone(6400), new AbortController().signal)
  assert.equal(result, '可以编辑的草稿'); assert.equal(bytes, 6400)
  assert.equal(finished, true); assert.equal(closed, true)
})

test('an empty final falls back to the last partial the recognizer produced', async () => {
  let closed = false
  const result = await transcribeDraft({open: () => Promise.resolve({
    append: () => Promise.resolve(), finish: () => Promise.resolve(),
    events: async function* () {await Promise.resolve(); yield {text: '打开设置', final: false}; yield {text: '', final: true}},
    close: () => {closed = true; return Promise.resolve()},
  })}, tone(9600), new AbortController().signal)
  assert.equal(result, '打开设置'); assert.equal(closed, true)
})

test('audio the recognizer heard nothing in fails as no_speech and closes', async () => {
  let closed = false
  await assert.rejects(transcribeDraft({open: () => Promise.resolve({
    append: () => Promise.resolve(), finish: () => Promise.resolve(),
    events: async function* () {await Promise.resolve(); yield {text: '', final: true}},
    close: () => {closed = true; return Promise.resolve()},
  })}, tone(9600), new AbortController().signal), (error: unknown) => error instanceof DictationError && error.code === 'no_speech')
  assert.equal(closed, true)
})

test('silent or too short audio fails as no_audio without opening the recognizer', async () => {
  let opened = 0
  const client = {open: () => { opened++; return Promise.reject(new Error('must not open')) }}
  for (const pcm of [new Uint8Array(0), new Uint8Array(32000), tone(2000)]) {
    await assert.rejects(transcribeDraft(client, pcm, new AbortController().signal), (error: unknown) => error instanceof DictationError && error.code === 'no_audio')
  }
  assert.equal(opened, 0)
})

test('malformed audio still fails as a generic error', async () => {
  await assert.rejects(transcribeDraft({open: () => Promise.reject(new Error('unused'))}, new Uint8Array(3), new AbortController().signal), (error: unknown) => !(error instanceof DictationError))
})
