import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_REALTIME_TEXT } from '../src/realtime/protocol.js'
import { TextChunker } from '../src/realtime/volcengine/tts.js'

test('text chunker flushes first, soft, hard, and newline boundaries in code points', () => {
  const first = new TextChunker()
  assert.deepEqual(first.push('短，余'), ['短，'])
  assert.deepEqual(first.finish(), ['余'])

  const soft = new TextChunker({softLimit: 4, hardLimit: 8})
  assert.deepEqual(soft.push('一，二三四。余'), ['一，', '二三四。'])
  assert.deepEqual(soft.finish(), ['余'])

  const hard = new TextChunker({softLimit: 4, hardLimit: 5})
  assert.deepEqual(hard.push('🙂🙂🙂🙂🙂🙂'), ['🙂🙂🙂🙂🙂'])
  assert.deepEqual(hard.finish(), ['🙂'])

  const newline = new TextChunker()
  assert.deepEqual(newline.push('一行\n二行'), ['一行\n'])
})

test('text chunker bounds each delta by code points and preserves state on invalid input', () => {
  const exact = new TextChunker()
  assert.doesNotThrow(() => exact.push('🙂'.repeat(MAX_REALTIME_TEXT)))
  const over = new TextChunker()
  assert.throws(() => over.push('🙂'.repeat(MAX_REALTIME_TEXT + 1)))

  const state = new TextChunker()
  assert.deepEqual(state.push('保留'), [])
  assert.throws(() => state.push(42))
  assert.deepEqual(state.finish(), ['保留'])
  assert.deepEqual(state.finish(), [])
})

test('text chunker validates limits before creating mutable state', () => {
  assert.throws(() => new TextChunker({softLimit: 0}))
  assert.throws(() => new TextChunker({softLimit: 5, hardLimit: 4}))
})

test('text chunker default hard cap is exactly 48 code points', () => {
  const chunker = new TextChunker()
  assert.deepEqual(chunker.push('a'.repeat(49)), ['a'.repeat(48)])
  assert.deepEqual(chunker.finish(), ['a'])
})
