import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONVERSATION_CHANNEL,
  Channel,
  Memory,
  handoffPolicySchema,
  makeMemoryRef,
  parseMemoryRef,
} from '../src/memory.js'

const slowPolicy = handoffPolicySchema.parse({
  channel: 'slow_sim',
  priority: 50,
  wake: 'fast',
  typical_latency: 5,
  compress_watermark: 8,
})

test('channels append exactly once and keep per-channel sequence and watermark state', () => {
  const channel = new Channel('slow_sim')
  const first = channel.append({
    ts: 1,
    trust: 'trusted_system',
    priority: 50,
    content: {n: 1},
  })
  const before = channel.items
  const second = channel.append({
    ts: 2,
    trust: 'trusted_system',
    priority: 50,
    content: {n: 2},
  })

  assert.deepEqual(channel.items.slice(0, before.length), before)
  assert.equal(channel.items.length, before.length + 1)
  assert.equal(channel.items.at(-1), second)
  assert.deepEqual([first.seq, second.seq], [1, 2])
  assert.equal(channel.uncompressed, 2)
  assert.equal(channel.summary, null)
})

test('MemoryRef is the canonical channel and sequence pair', () => {
  assert.equal(makeMemoryRef('conversation', 1), 'conversation:1')
  assert.deepEqual(parseMemoryRef('conversation:1'), ['conversation', 1])
  assert.deepEqual(parseMemoryRef('executor:nested:7'), ['executor:nested', 7])
  assert.throws(() => parseMemoryRef('missing-sequence'))
})

test('memory opens configured channels and rejects unknown channel writes', () => {
  const memory = new Memory({policies: [slowPolicy]})
  assert.deepEqual([...memory.channels.keys()], [CONVERSATION_CHANNEL, 'slow_sim'])

  const item = memory.append('slow_sim', {
    ts: 3,
    trust: 'trusted_system',
    priority: 50,
    content: {brightness: 30},
    outcome: 'ok',
    refs: ['conversation:1'],
  })
  assert.equal(memory.channels.get('slow_sim')?.items[0], item)
  assert.equal(memory.channels.get(CONVERSATION_CHANNEL)?.items.length, 0)
  assert.throws(() => memory.append('missing', {
    ts: 0,
    trust: 'trusted_system',
    priority: 1,
    content: {},
  }), /unknown memory channel/u)
})

test('memory preserves refused separately from failed and unknown', () => {
  const memory = new Memory({policies: [slowPolicy]})
  const item = memory.append('slow_sim', {
    ts: 3,
    trust: 'trusted_system',
    priority: 50,
    content: {code: 'needs_selection'},
    outcome: 'refused',
    refs: ['conversation:1'],
  })

  assert.equal(item.outcome, 'refused')
})
