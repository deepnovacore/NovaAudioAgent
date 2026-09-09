import test from 'node:test'
import assert from 'node:assert/strict'
import {Transcript} from '../src/transcript.mjs'
test('partial captions replace in place; finals persist; stale frames do not duplicate history', () => {
  const log = new Transcript(3)
  log.receive({role:'user', text:'你好', final:false, sequence:1})
  log.receive({role:'user', text:'你好 Nova', final:true, sequence:2})
  log.receive({role:'assistant', text:'你好', final:true, sequence:3})
  log.receive({role:'user', text:'迟到', final:true, sequence:2})
  assert.deepEqual(log.items.map(x=>x.text), ['你好 Nova','你好'])
  log.receive({role:'user', text:'第二句', final:true, sequence:4})
  log.receive({role:'assistant', text:'回复', final:true, sequence:5})
  assert.equal(log.items.length,3)
  log.newServer()
  log.receive({role:'user', text:'重启后', final:true, sequence:1})
  assert.equal(log.items.at(-1).text,'重启后')
  assert.equal(new Set(log.items.map(x=>x.id)).size,3)
})

test('blank final clears only speculative text for that role and retains confirmed history', () => {
  const log = new Transcript()
  log.receive({role:'user', text:'保留', final:true, sequence:1})
  log.receive({role:'assistant', text:'过期的草稿', final:false, sequence:2})
  assert.equal(log.receive({role:'assistant', text:'', final:true, sequence:3}), true)
  assert.deepEqual(log.items.map(x=>x.text), ['保留'])
  const empty = new Transcript()
  empty.receive({role:'user', text:'草稿', final:false, sequence:1})
  empty.receive({role:'user', text:'', final:true, sequence:2})
  assert.deepEqual(empty.items, [])
})

test('interleaved roles finish their own partial caption without duplicating it', () => {
  const log = new Transcript()
  log.receive({role:'user', text:'请帮', final:false, sequence:1})
  log.receive({role:'assistant', text:'好的', final:false, sequence:2})
  log.receive({role:'user', text:'请帮我', final:true, sequence:3})
  assert.deepEqual(log.items.map(x=>x.text), ['请帮我','好的'])
})
