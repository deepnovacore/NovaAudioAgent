import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compileContextView } from '../src/context-view.js'
import { Memory } from '../src/memory.js'
import { RealtimeRuntimeBridge } from '../src/realtime/bridge.js'
import { compileToolSchema } from '../src/tool-schema.js'

test('compiled tools omit retired structured update tools while preserving recall', () => {
  const tools = compileToolSchema([], {includeMemoryRecall: true})
  const names = tools.schemas.map(schema => String(
    (schema.function as {readonly name?: unknown} | undefined)?.name,
  ))

  assert.ok(!names.includes('update_intent'))
  assert.ok(!names.includes('update_goal'))
  assert.ok(!names.includes('update_authorization'))
  assert.ok(names.includes('memory__recall'))
})

test('context views omit retired structured state and unresolved-question affordances', () => {
  const view = compileContextView(new Memory(), 'idle', 0)
  assert.ok(!Object.hasOwn(view, 'structured'))
  assert.deepEqual(view.affordances, [])
})

test('retired update calls use ordinary unknown-tool refusal', () => {
  const bridge = new RealtimeRuntimeBridge({
    runtime: {} as never,
    tools: compileToolSchema([]),
    idFactory: () => 'id',
  })
  const result = bridge.acceptToolCall({
    kind: 'tool_call_ready',
    session_epoch: 1,
    item_id: 'item-1',
    response_id: null,
    name: 'update_intent',
    call_id: 'call-1',
    arguments: {uncertainty: 0.1},
  })
  assert.equal(result.accepted, false)
  assert.equal(result.code, 'unknown_tool')
})
