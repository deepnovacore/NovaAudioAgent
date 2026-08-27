import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONVERSATION_CHANNEL,
  Channel,
  Memory,
  applyStructuredUpdate,
  handoffPolicySchema,
  makeMemoryRef,
  parseMemoryRef,
  structuredStateSchema,
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

test('structured updates overwrite named fields and bump only their revision', () => {
  const initial = structuredStateSchema.parse({
    intent: {
      objective_hypothesis: 'dim the light',
      constraints: ['do not switch off'],
      unresolved_questions: ['how dim?'],
      uncertainty: 0.4,
      revision: 2,
    },
    goal: {objective: 'light below 40%', revision: 1},
  })
  const result = applyStructuredUpdate(initial, 'intent', {uncertainty: 0.1})

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.state.intent.uncertainty, 0.1)
  assert.equal(result.state.intent.revision, 3)
  assert.deepEqual(result.state.intent.constraints, ['do not switch off'])
  assert.deepEqual(result.state.goal, initial.goal)
})

test('structured updates use explicit target and field maps', () => {
  const initial = structuredStateSchema.parse({})
  assert.deepEqual(
    applyStructuredUpdate(initial, 'made_up', {objective: 'x'}),
    {ok: false, reason: 'unknown_target'},
  )
  assert.deepEqual(
    applyStructuredUpdate(initial, 'intent', {}),
    {ok: false, reason: 'empty_delta'},
  )
  assert.deepEqual(
    applyStructuredUpdate(initial, 'intent', {revision: 99, mood: 'calm'}),
    {ok: false, reason: 'unknown_fields', unknown: ['mood', 'revision']},
  )
  assert.deepEqual(
    applyStructuredUpdate(initial, 'intent', {constraints: [['nested']]}),
    {ok: false, reason: 'bad_types', fields: ['constraints']},
  )
  assert.deepEqual(
    applyStructuredUpdate(initial, 'intent', {uncertainty: true}),
    {ok: false, reason: 'bad_types', fields: ['uncertainty']},
  )
  const paused = applyStructuredUpdate(initial, 'goal', {status: 'paused'})
  assert.equal(paused.ok, true)
  if (paused.ok) assert.equal(paused.state.goal.status, 'paused')

  const shapeOnly = applyStructuredUpdate(initial, 'intent', {uncertainty: 2})
  assert.equal(shapeOnly.ok, true)
  if (shapeOnly.ok) assert.equal(shapeOnly.state.intent.uncertainty, 2)

  const evidence = applyStructuredUpdate(initial, 'authorization', {
    evidence_refs: ['not-a-canonical-memory-ref'],
  })
  assert.equal(evidence.ok, true)
  if (evidence.ok) {
    assert.deepEqual(evidence.state.authorization.evidence_refs, ['not-a-canonical-memory-ref'])
  }
})
