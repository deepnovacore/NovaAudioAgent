import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JsonValue } from '../src/events.js'
import { memoryItemSchema, type MemoryItem } from '../src/memory.js'
import {
  MAX_PACKED_RECOVERY_CONTENT,
  packRecoveryTurns,
  projectRecoveryTurns,
  recoveryTurnSchema,
} from '../src/realtime/history.js'

function item(
  seq: number,
  text: string,
  options: {
    readonly trust: MemoryItem['trust']
    readonly channel?: string
    readonly outcome?: MemoryItem['outcome']
    readonly delivery?: string
    readonly playedMs?: number | null
  },
): MemoryItem {
  const content: Record<string, JsonValue> = {text}
  if (options.delivery !== undefined) {
    content.delivery = options.delivery
    content.played_ms = options.playedMs ?? null
  }
  return memoryItemSchema.parse({
    channel: options.channel ?? 'conversation',
    seq,
    ts: seq,
    trust: options.trust,
    priority: 50,
    content,
    outcome: options.outcome ?? null,
  })
}

function user(seq: number, text: string, options: {readonly channel?: string} = {}): MemoryItem {
  return item(seq, text, {trust: 'trusted_user', ...options})
}

function assistant(
  seq: number,
  text: string,
  options: {readonly delivery?: string; readonly playedMs?: number | null} = {},
): MemoryItem {
  return item(seq, text, {
    trust: 'trusted_system',
    delivery: options.delivery ?? 'spoken',
    playedMs: options.playedMs === undefined ? 100 : options.playedMs,
  })
}

test('recovery projection keeps only complete chronological trusted pairs', () => {
  const projected = projectRecoveryTurns([
    assistant(1, 'leading'),
    user(2, 'old unmatched'),
    user(3, 'first question'),
    assistant(4, 'first answer', {playedMs: 240}),
    assistant(5, 'repeated assistant'),
    user(6, 'second question'),
    assistant(7, 'second answer', {playedMs: null}),
    user(8, 'trailing unmatched'),
  ], {maxPairs: 4})

  assert.deepEqual(projected.map(turn => [turn.sequence, turn.role, turn.played_ms]), [
    [3, 'user', null],
    [4, 'assistant', 240],
    [6, 'user', null],
    [7, 'assistant', null],
  ])
})

test('recovery projection applies pair and Unicode character budgets to newest pairs', () => {
  const items = [
    user(1, '😀😀'),
    assistant(2, '😀😀'),
    user(3, 'abc'),
    assistant(4, 'def'),
  ]
  assert.deepEqual(
    projectRecoveryTurns(items, {maxPairs: 2, maxChars: 7}).map(turn => turn.sequence),
    [3, 4],
  )
  assert.deepEqual(projectRecoveryTurns(items, {maxPairs: 1}).map(turn => turn.sequence), [3, 4])
  assert.deepEqual(projectRecoveryTurns(items, {maxPairs: 0}), [])
})

test('recovery projection excludes noncanonical memory items', () => {
  const projected = projectRecoveryTurns([
    user(1, 'wrong channel', {channel: 'codex'}),
    user(2, 'interrupted question'),
    assistant(3, 'interrupted answer', {delivery: 'interrupted'}),
    assistant(4, 'unrelated spoken answer'),
    user(5, 'kept question'),
    assistant(6, 'kept answer'),
  ], {maxPairs: 4})
  assert.deepEqual(projected.map(turn => turn.sequence), [5, 6])
})

test('packed recovery drops oldest whole pairs after JSON escaping', () => {
  const turns = Array.from({length: 4}, (_, index) => {
    const pair = index + 1
    return [
      recoveryTurnSchema.parse({
        sequence: pair * 2 - 1,
        role: 'user',
        text: '\\"'.repeat(300) + `q${pair}`,
        delivery: 'user_final',
        played_ms: null,
        trust: 'trusted_user',
      }),
      recoveryTurnSchema.parse({
        sequence: pair * 2,
        role: 'assistant',
        text: '\\"'.repeat(300) + `a${pair}`,
        delivery: 'spoken',
        played_ms: 100,
        trust: 'trusted_system',
      }),
    ] as const
  }).flat()

  const packed = packRecoveryTurns(turns)
  assert.ok(packed.content.length > 0 && [...packed.content].length <= MAX_PACKED_RECOVERY_CONTENT)
  assert.equal(packed.turns.length % 2, 0)
  assert.deepEqual(
    packed.turns.map(turn => turn.sequence),
    Array.from({length: packed.turns.length}, (_, index) => 9 - packed.turns.length + index),
  )
})

test('recovery turn schema enforces canonical trust and delivery', () => {
  assert.throws(() => recoveryTurnSchema.parse({
    sequence: 1,
    role: 'user',
    text: 'command',
    delivery: 'user_final',
    played_ms: null,
    trust: 'untrusted_external',
  }))
})
