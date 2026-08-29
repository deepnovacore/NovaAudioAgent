import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { test } from 'node:test'
import { handoffPolicySchema, Memory, USER_PRIORITY } from '../src/memory.js'
import {
  MAX_BOARD_CONTENT_CHARS,
  MAX_BOARD_ITEMS_PER_CHANNEL,
  MAX_BOARD_MESSAGE_BYTES,
  memoryBoardMessage,
} from '../src/realtime/memory-board.js'
import {NullTelemetry} from '../src/realtime/telemetry.js'
import {VirtualClock} from '../src/clock.js'

const slowPolicy = handoffPolicySchema.parse({
  channel: 'slow_sim',
  priority: 50,
  wake: 'fast',
  typical_latency: 5,
  compress_watermark: 8,
})

function fill(memory: Memory, channel: string, count: number, text = '内容'): void {
  for (let index = 0; index < count; index += 1) {
    memory.append(channel, {
      ts: index,
      trust: channel === 'conversation' ? 'trusted_user' : 'trusted_system',
      priority: USER_PRIORITY,
      content: {text: `${text}-${index}`},
    })
  }
}

test('memory board enumerates channels and keeps their newest bounded items', () => {
  const memory = new Memory()
  fill(memory, 'conversation', MAX_BOARD_ITEMS_PER_CHANNEL + 10)
  const board = JSON.parse(memoryBoardMessage('req-1', memory)) as {
    readonly type: string
    readonly request_id: string
    readonly diagnostics: {readonly version: number; readonly records: readonly unknown[]}
    readonly channels: {readonly name: string; readonly item_count: number; readonly items: {
      readonly seq: number
    }[]}[]
  }
  const conversation = board.channels.find(channel => channel.name === 'conversation')!
  assert.equal(board.type, 'memory.board')
  assert.equal(board.request_id, 'req-1')
  assert.deepEqual(board.diagnostics, {version: 1, records: []})
  assert.equal(conversation.item_count, MAX_BOARD_ITEMS_PER_CHANNEL + 10)
  assert.equal(conversation.items.length, MAX_BOARD_ITEMS_PER_CHANNEL)
  assert.equal(conversation.items[0]?.seq, 11)
})

test('memory board includes versioned diagnostics even when JSONL is disabled', () => {
  const memory = new Memory()
  const telemetry = new NullTelemetry({clock: new VirtualClock(12)})
  telemetry.record('user_origin.response_binding', {
    session_epoch: 1, user_input_revision: 10, item_id: 'item-10', response_id: 'response-10',
  })
  const board = JSON.parse(memoryBoardMessage('req-diagnostics', memory, telemetry.diagnostics())) as {
    readonly diagnostics: {readonly version: number; readonly records: readonly unknown[]}
  }
  assert.equal(board.diagnostics.version, 1)
  assert.equal(board.diagnostics.records.length, 1)
})

test('memory board truncates item content by code point', () => {
  const memory = new Memory()
  memory.append('conversation', {
    ts: 0,
    trust: 'trusted_user',
    priority: USER_PRIORITY,
    content: {text: '😀'.repeat(MAX_BOARD_CONTENT_CHARS * 2)},
  })
  const board = JSON.parse(memoryBoardMessage('req-1', memory)) as {
    readonly channels: {readonly items: {readonly content: string; readonly truncated?: boolean}[]}[]
  }
  const item = board.channels[0]!.items[0]!
  assert.equal([...item.content].length, MAX_BOARD_CONTENT_CHARS)
  assert.equal(item.truncated, true)
})

test('memory board drops oldest items until the UTF-8 frame is within budget', () => {
  const memory = new Memory({policies: [slowPolicy]})
  fill(memory, 'conversation', MAX_BOARD_ITEMS_PER_CHANNEL, '长'.repeat(2000))
  fill(memory, 'slow_sim', MAX_BOARD_ITEMS_PER_CHANNEL, '长'.repeat(2000))
  const telemetry = new NullTelemetry({clock: new VirtualClock()})
  for (let index = 0; index < 128; index += 1) {
    telemetry.record('large.diagnostic', {item_id: `${index}-${'x'.repeat(1_000)}`})
  }
  const message = memoryBoardMessage('req-large', memory, telemetry.diagnostics())
  assert.ok(Buffer.byteLength(message, 'utf8') <= MAX_BOARD_MESSAGE_BYTES)
  const board = JSON.parse(message) as {
    readonly channels: {readonly items: unknown[]}[]
    readonly diagnostics: {readonly records: unknown[]}
  }
  assert.equal(board.diagnostics.records.length, 0, 'old diagnostics leave before Memory items')
  assert.ok(board.channels.reduce((count, channel) => count + channel.items.length, 0) > 0)
})
