import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {test} from 'node:test'
import * as jsonlModule from '../src/codex-jsonl.js'
import {
  CodexJsonlParser,
  CodexJsonlProtocolError,
  MAX_LINE_BYTES,
  MAX_STDOUT_BYTES,
} from '../src/codex-jsonl.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../tests/fixtures/codex')
const encoder = new TextEncoder()

function parseFixture(name: string): ReturnType<CodexJsonlParser['close']> {
  const parser = new CodexJsonlParser()
  const bytes = readFileSync(resolve(fixtureRoot, name))
  let start = 0
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue
    parser.feed(bytes.subarray(start, index + 1))
    start = index + 1
  }
  if (start < bytes.byteLength) parser.feed(bytes.subarray(start))
  return parser.close()
}

function code(error: unknown): string | undefined {
  return error instanceof CodexJsonlProtocolError ? error.code : undefined
}

function unknownLine(size: number): Uint8Array {
  const prefix = encoder.encode('{"type":"future.progress","padding":"')
  const suffix = encoder.encode('"}\n')
  const line = new Uint8Array(size)
  line.set(prefix)
  line.fill(0x78, prefix.byteLength, size - suffix.byteLength)
  line.set(suffix, size - suffix.byteLength)
  return line
}

test('completed historical fixture reduces to exact sanitized milestones', () => {
  assert.deepEqual(parseFixture('completed.jsonl'), {
    events: [
      {type: 'thread.started'},
      {type: 'turn.started'},
      {type: 'internal_activity', count: 3},
      {type: 'turn.completed'},
    ],
    thread_started: true,
    turn_started: true,
    terminal: 'completed',
    transport_closed: true,
    unknown_event_count: 0,
    internal_activity_count: 3,
  })
})

test('malicious fixture erases every private payload before retaining milestones', () => {
  const rendered = JSON.stringify(parseFixture('malicious-items.jsonl'))
  for (const sentinel of [
    'do-not-retain-thread-id',
    'do-not-retain-work-order',
    'do-not-retain-item-id',
    'do-not-retain-tool-name',
    'do-not-retain-token',
    '/do/not/retain/private/path',
    'do-not-retain-reasoning',
    'do-not-retain-command',
    'do-not-retain-output',
    'do-not-retain-final-message',
  ]) assert.equal(rendered.includes(sentinel), false)
})

test('error milestones retain no provider message', () => {
  const parser = new CodexJsonlParser()
  parser.feed(encoder.encode('{"type":"thread.started","thread_id":"PRIVATE"}\n'))
  parser.feed(encoder.encode('{"type":"turn.started","work_order":"PRIVATE"}\n'))
  parser.feed(encoder.encode('{"type":"error","message":"PRIVATE-ERROR"}\n'))
  parser.feed(encoder.encode('{"type":"turn.failed","output":"PRIVATE"}\n'))
  const summary = parser.close()
  assert.deepEqual(summary.events, [
    {type: 'thread.started'}, {type: 'turn.started'}, {type: 'error'}, {type: 'turn.failed'},
  ])
  assert.equal(JSON.stringify(summary).includes('PRIVATE'), false)
})

test('malformed UTF-8, JSON constants, unsafe integers, and invalid events fail privately', () => {
  const cases: readonly [Uint8Array, string][] = [
    [Uint8Array.of(0xff), 'malformed_jsonl'],
    [encoder.encode('{"type":'), 'malformed_jsonl'],
    [encoder.encode('{"type":"future","value":NaN}'), 'malformed_jsonl'],
    [encoder.encode('{"type":"future","value":Infinity}'), 'malformed_jsonl'],
    [encoder.encode('{"type":"future","value":9007199254740993}'), 'malformed_jsonl'],
    [encoder.encode('[]'), 'invalid_event'],
    [encoder.encode('{}'), 'invalid_event'],
    [encoder.encode('{"type":42}'), 'invalid_event_type'],
  ]
  for (const [line, wanted] of cases) {
    const parser = new CodexJsonlParser()
    assert.throws(() => parser.feed(line), error => code(error) === wanted)
  }
})

test('line and aggregate stdout limits include newlines at exact boundaries', () => {
  const exactLine = new CodexJsonlParser()
  exactLine.feed(unknownLine(MAX_LINE_BYTES))
  exactLine.feed(encoder.encode('{"type":"thread.started"}\n'))
  exactLine.feed(encoder.encode('{"type":"turn.started"}\n'))
  exactLine.feed(encoder.encode('{"type":"turn.completed"}\n'))
  assert.equal(exactLine.close().unknown_event_count, 1)

  const overLine = new CodexJsonlParser()
  assert.throws(() => overLine.feed(unknownLine(MAX_LINE_BYTES + 1)), error => (
    code(error) === 'line_too_large'
  ))

  const exactStdout = new CodexJsonlParser()
  for (let index = 0; index < MAX_STDOUT_BYTES / MAX_LINE_BYTES; index += 1) {
    exactStdout.feed(unknownLine(MAX_LINE_BYTES))
  }
  assert.throws(() => exactStdout.feed(Uint8Array.of(0x0a)), error => (
    code(error) === 'stdout_too_large'
  ))
})

test('event ordering failures are exact and never retain their hostile line', () => {
  const scenarios: readonly [readonly string[], string][] = [
    [['turn.started'], 'turn_before_thread'],
    [['thread.started', 'thread.started'], 'duplicate_thread'],
    [['thread.started', 'turn.started', 'turn.started'], 'duplicate_turn'],
    [['thread.started', 'turn.started', 'thread.started'], 'duplicate_thread'],
    [['thread.started', 'item.started'], 'item_outside_turn'],
    [['thread.started', 'turn.completed'], 'terminal_without_turn'],
    [['thread.started', 'turn.started', 'turn.completed', 'turn.failed'], 'duplicate_terminal'],
  ]
  for (const [events, wanted] of scenarios) {
    const parser = new CodexJsonlParser()
    assert.throws(() => {
      for (const event of events) {
        parser.feed(encoder.encode(`{"type":"${event}","secret":"PRIVATE"}\n`))
      }
    }, error => {
      assert.equal(code(error), wanted)
      assert.equal(String(error).includes('PRIVATE'), false)
      return true
    })
  }
})

test('unknown events are opaque bounded counts and item activity is retained only as one count', () => {
  const parser = new CodexJsonlParser()
  parser.feed(encoder.encode('{"type":"thread.started"}\n'))
  parser.feed(encoder.encode('{"type":"turn.started"}\n'))
  parser.feed(encoder.encode('{"type":"future.progress","secret":"PRIVATE"}\n'))
  parser.feed(encoder.encode('{"type":"item.started","item":{"secret":"PRIVATE"}}\n'))
  parser.feed(encoder.encode('{"type":"item.updated","item":{"secret":"PRIVATE"}}\n'))
  parser.feed(encoder.encode('{"type":"turn.completed"}\n'))
  const summary = parser.close()
  assert.equal(summary.unknown_event_count, 1)
  assert.equal(summary.internal_activity_count, 2)
  assert.deepEqual(summary.events, [
    {type: 'thread.started'},
    {type: 'turn.started'},
    {type: 'internal_activity', count: 2},
    {type: 'turn.completed'},
  ])
  assert.equal(JSON.stringify(summary).includes('PRIVATE'), false)
})

test('close without terminal still closes transport and all later calls fail closed', () => {
  const parser = new CodexJsonlParser()
  parser.feed(encoder.encode('{"type":"thread.started"}\n'))
  parser.feed(encoder.encode('{"type":"turn.started"}\n'))
  assert.throws(() => parser.close(), error => code(error) === 'missing_terminal')
  assert.throws(() => parser.feed(encoder.encode('{"type":"turn.completed"}\n')), error => (
    code(error) === 'transport_closed'
  ))
  assert.throws(() => parser.close(), error => code(error) === 'transport_closed')
})

test('the fixture parser module exposes no run, command, stream, or process path', () => {
  for (const forbidden of ['run', 'exec', 'spawn', 'process', 'stream', 'command']) {
    assert.equal(Object.hasOwn(jsonlModule, forbidden), false)
  }
  assert.equal(CodexJsonlParser.MAX_LINE_BYTES, MAX_LINE_BYTES)
  assert.equal(CodexJsonlParser.MAX_STDOUT_BYTES, MAX_STDOUT_BYTES)
})
