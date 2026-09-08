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

test('retention removes records without reusing their references or retaining their summary', () => {
  const channel = new Channel('conversation')
  const append = (text: string) => channel.append({
    ts: 1, trust: 'trusted_user', priority: 100, content: {text},
  })
  append('expired')
  append('kept')
  const revision = channel.retentionRevision
  assert.equal(channel.replaceSummary('expired and kept', 2, revision), true)
  channel.pruneThrough(1)
  assert.equal(channel.getBySeq(1), undefined)
  assert.equal(channel.getBySeq(2)?.content.text, 'kept')
  assert.equal(channel.summary, null)
  assert.equal(channel.uncompressed, 1)
  assert.equal(channel.replaceSummary('expired came back', 2, revision), false)
  assert.equal(append('next').seq, 3)
  channel.pruneThrough(3)
  assert.equal(append('after clearing every record').seq, 4)
  assert.equal(channel.getBySeq(3), undefined)
  assert.throws(() => channel.pruneThrough(Number.NaN), RangeError)
  assert.equal(channel.items.length, 1)
})

test('memory clear drops every live record and summary without reusing channel sequences', () => {
  const memory = new Memory({policies: [slowPolicy]})
  const conversation = memory.append('conversation', {
    ts: 1, trust: 'trusted_user', priority: 100, content: {text: 'forget this'},
  })
  const slow = memory.append('slow_sim', {
    ts: 2, trust: 'trusted_system', priority: 50, content: {state: 'working'},
  })
  memory.channels.get('conversation')!.replaceSummary('old conversation', conversation.seq, 0)
  memory.channels.get('slow_sim')!.replaceSummary('old task', slow.seq, 0)

  memory.clear()

  for (const channel of memory.channels.values()) {
    assert.deepEqual(channel.items, [])
    assert.equal(channel.summary, null)
    assert.equal(channel.uncompressed, 0)
    assert.equal(channel.retentionRevision, 1)
  }
  assert.equal(memory.channels.get('conversation')!.replaceSummary('stale compressor', 1, 0), false)
  assert.equal(memory.append('conversation', {
    ts: 3, trust: 'trusted_user', priority: 100, content: {text: 'new turn'},
  }).seq, 2)
  assert.equal(memory.append('slow_sim', {
    ts: 4, trust: 'trusted_system', priority: 50, content: {state: 'new'},
  }).seq, 2)
})

test('summary coverage counts new records rather than subtracting all earlier records twice', () => {
  const channel = new Channel('conversation')
  const append = () => channel.append({ts: 1, trust: 'trusted_user', priority: 100, content: {}})
  append()
  append()
  channel.replaceSummary('first two', 2, channel.retentionRevision)
  append()
  append()
  channel.replaceSummary('first three', 3, channel.retentionRevision)
  assert.equal(channel.uncompressed, 1)
  channel.replaceSummary('all four', 4, channel.retentionRevision)
  assert.equal(channel.replaceSummary('late first two', 2, channel.retentionRevision), false)
  assert.equal(channel.summary, 'all four')
  assert.equal(channel.uncompressed, 0)
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

test('handoff policies default to ordinary tasks and reject task alert delivery', () => {
  const ordinary = handoffPolicySchema.parse({
    channel: 'ordinary', priority: 40, wake: 'surrogate', typical_latency: 1, compress_watermark: 20,
  })
  assert.equal(ordinary.operation_class, 'task')
  assert.equal(ordinary.alert_delivery, 'none')

  for (const alert_delivery of ['deferred', 'preemptive']) {
    assert.throws(() => handoffPolicySchema.parse({
      channel: 'invalid-task', priority: 40, wake: 'surrogate', typical_latency: 1,
      compress_watermark: 20, operation_class: 'task', alert_delivery,
    }), /task.*none|none.*task/u)
  }
})
