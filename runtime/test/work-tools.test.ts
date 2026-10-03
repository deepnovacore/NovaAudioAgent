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
} from '../src/core/work-tools.js'

test('deriveSessionTitle keeps the first sentence, stripped, at most 20 code points', () => {
  assert.equal(deriveSessionTitle('  给博客加暗色模式。然后再写测试  '), '给博客加暗色模式')
  assert.equal(deriveSessionTitle('Fix the login bug! Then refactor'), 'Fix the login bug')
  assert.equal(deriveSessionTitle('first line\nsecond line'), 'first line')
  assert.equal(deriveSessionTitle('Add tests. Then ship'), 'Add tests')
  assert.equal(deriveSessionTitle('v1.2 is broken'), 'v1.2 is broken', 'a dot without a following space is not a break')
  assert.equal(deriveSessionTitle('a;b；c'), 'a')
  for (const character of ['a', '😀']) {
    for (const length of [19, 20]) assert.equal(deriveSessionTitle(character.repeat(length)), character.repeat(length))
    assert.equal(deriveSessionTitle(character.repeat(21)), character.repeat(19) + '…')
    assert.equal(deriveSessionTitle(character.repeat(30) + '。more'), character.repeat(19) + '…')
  }
  assert.equal(deriveSessionTitle('   '), '')
})

test('host tool specs fold every registered controller into one enum with one description line each', () => {
  const agents = [
    {name: 'codex', summary: '改代码', ownedChannels: ['codex']},
    {name: 'acp', summary: '别的', ownedChannels: ['acp']},
  ]
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
  assert.deepEqual([...HOST_TOOL_NAMES].sort(), ['cancel', 'confirm', 'dispatch', 'task'])
  assert.equal(MAX_CONCURRENT_WORK, 3)
})

test('confirmArguments accepts exact one-shot or explicit positive session decisions', () => {
  assert.deepEqual(confirmArguments({id: 'p-1', accepted: true}), {id: 'p-1', accepted: true})
  assert.deepEqual(confirmArguments({accepted: false, id: 'a'}), {id: 'a', accepted: false})
  assert.deepEqual(confirmArguments({id: 'p', accepted: true, scope: 'session'}), {id: 'p', accepted: true, scope: 'session'})
  let getterRead = false
  assert.equal(confirmArguments({id: 'p', accepted: true, get scope() { getterRead = true; return 'session' }}), null)
  assert.equal(getterRead, false)
  for (const bad of [
    {id: 'p', accepted: false, scope: 'session'}, {id: 'p', accepted: true, scope: 'global'},
    {id: 'p', accepted: true, scope: undefined},
    null, 'x', [], {}, {id: 'p'}, {accepted: true}, {id: '', accepted: true}, {id: 'p', accepted: 'yes'},
    {id: 'p', accepted: true, extra: 1}, {id: 'x'.repeat(129), accepted: true},
  ]) assert.equal(confirmArguments(bad), null, JSON.stringify(bad))
})
