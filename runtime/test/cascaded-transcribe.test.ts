import assert from 'node:assert/strict'
import {test} from 'node:test'
import {transcribeDraft} from '../src/realtime/cascaded/transcribe.js'

test('draft ASR returns only a final transcript and closes the isolated session', async () => {
  let finished = false, closed = false, bytes = 0
  let release!: () => void
  const done = new Promise<void>(resolve => {release = resolve})
  const result = await transcribeDraft({open: () => Promise.resolve({
    append: pcm => {bytes += pcm.length; return Promise.resolve()},
    finish: () => {finished = true; release(); return Promise.resolve()},
    events: async function* () {yield {text: '部', final: false}; await done; yield {text: '可以编辑的草稿', final: true}},
    close: () => {closed = true; return Promise.resolve()},
  })}, new Uint8Array(6400), new AbortController().signal)
  assert.equal(result, '可以编辑的草稿'); assert.equal(bytes, 6400)
  assert.equal(finished, true); assert.equal(closed, true)
})

test('empty final transcript fails and closes without producing a user turn', async () => {
  let closed = false
  await assert.rejects(transcribeDraft({open: () => Promise.resolve({
    append: () => Promise.resolve(), finish: () => Promise.resolve(),
    events: async function* () {await Promise.resolve(); yield {text: 'partial only', final: false}},
    close: () => {closed = true; return Promise.resolve()},
  })}, new Uint8Array(2), new AbortController().signal))
  assert.equal(closed, true)
})
