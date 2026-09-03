import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONFIRM_TOOL_SPEC,
  HOST_TOOL_NAMES,
  MAX_CONCURRENT_WORK,
  cancelToolSpec,
  confirmArguments,
  deriveSessionTitle,
  dispatchToolSpec,
} from '../src/work-tools.js'

test('deriveSessionTitle keeps the first sentence, stripped, at most 20 code points', () => {
  assert.equal(deriveSessionTitle('  给博客加暗色模式。然后再写测试  '), '给博客加暗色模式')
  assert.equal(deriveSessionTitle('Fix the login bug! Then refactor'), 'Fix the login bug')
  assert.equal(deriveSessionTitle('first line\nsecond line'), 'first line')
  assert.equal(deriveSessionTitle('Add tests. Then ship'), 'Add tests')
  assert.equal(deriveSessionTitle('v1.2 is broken'), 'v1.2 is broken', 'a dot without a following space is not a break')
  assert.equal(deriveSessionTitle('a;b；c'), 'a')
  assert.equal([...deriveSessionTitle('😀'.repeat(30))].length, 20)
  assert.equal(deriveSessionTitle('   '), '')
})

test('host tool specs fold every agent executor into one enum with one description line each', () => {
  const agents = [{name: 'codex', summary: '改代码'}, {name: 'acp', summary: '别的'}]
  const dispatch = dispatchToolSpec(agents)
  assert.equal(dispatch.name, 'dispatch')
  assert.ok(dispatch.inject_origin_ref)
  const properties = dispatch.params.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(properties.executor?.enum, ['codex', 'acp'])
  assert.match(dispatch.description, /codex: 改代码；acp: 别的/u)
  const cancel = cancelToolSpec(agents)
  assert.equal(cancel.name, 'cancel')
  assert.ok(!cancel.inject_origin_ref)
  assert.deepEqual(cancel.params.required, ['executor'])
  assert.deepEqual(CONFIRM_TOOL_SPEC.params.required, ['id', 'accepted'])
  assert.deepEqual([...HOST_TOOL_NAMES].sort(), ['cancel', 'confirm', 'dispatch'])
  assert.equal(MAX_CONCURRENT_WORK, 3)
})

test('confirmArguments accepts exactly {id, accepted} and nothing else', () => {
  assert.deepEqual(confirmArguments({id: 'p-1', accepted: true}), {id: 'p-1', accepted: true})
  assert.deepEqual(confirmArguments({accepted: false, id: 'a'}), {id: 'a', accepted: false})
  for (const bad of [
    null, 'x', [], {}, {id: 'p'}, {accepted: true}, {id: '', accepted: true}, {id: 'p', accepted: 'yes'},
    {id: 'p', accepted: true, extra: 1}, {id: 'x'.repeat(129), accepted: true},
  ]) assert.equal(confirmArguments(bad), null, JSON.stringify(bad))
})
