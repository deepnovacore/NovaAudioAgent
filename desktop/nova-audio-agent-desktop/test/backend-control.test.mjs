import assert from 'node:assert/strict'
import test from 'node:test'
import {EventEmitter} from 'node:events'
import {createBackendControl} from '../src/main/backend-control.mjs'
test('private requests correlate, reject on close, and ignore late status', async () => {
  const child = new EventEmitter(), sent = [], statuses = []
  child.postMessage = value => sent.push(value)
  const control = createBackendControl(child, {onStatus: status => statuses.push(status)})
  const request = control.request('capabilities.status', {})
  child.emit('message', {type: 'nova.control.reply', id: sent[0].id, result: {ok: true}})
  assert.deepEqual(await request, {ok: true})
  const pending = control.request('knowledge.reindex', {})
  control.close()
  await assert.rejects(pending, /unavailable/)
  child.emit('message', {type: 'nova.capabilities', status: {toolCount: 8, toolBudget: 24}})
  assert.equal(statuses.length, 0)
  assert.equal(child.listenerCount('message'), 0)
})

test('private status projects only safe public fields and bounded exact counts', async () => {
  const {publicRuntimeCapabilityStatus} = await import('../src/main/backend-control.mjs')
  const projected = publicRuntimeCapabilityStatus({state: 'startup_failed', toolCount: 27, toolBudget: 24,
    modules: {search: {enabled: true, provider: 'mcp', mcp: {headers: {authorization: 'private-secret'}}}}, registry: 'private-secret',
    servers: [{name: 'docs', status: 'failed', reason: 'discovery_failed', config: 'private-secret', codex: {status: 'failed', reason: 'codex_timeout_unrepresentable'}}]})
  assert.equal(projected.toolCount, 27)
  assert.equal(projected.toolBudget, 24)
  assert.equal(projected.state, 'startup_failed')
  assert.ok(!JSON.stringify(projected).includes('private-secret'))
  assert.equal(publicRuntimeCapabilityStatus({toolCount: -1, toolBudget: 24}), null)
})

test('usage stays private, validates numbers and ignores closed children', () => {
  const child = new EventEmitter(), received = []
  const control = createBackendControl(child, {onUsage: report => received.push(report)})
  const report = {id:'request-1',provider:'qwen',service:'llm',model:'qwen-flash',status:'complete',inputTokens:10,secret:'private'}
  child.emit('message',{type:'nova.usage',report:{...report,inputTokens:Infinity}})
  child.emit('message',{type:'nova.usage',report})
  assert.equal(received.length,1)
  assert.equal(received[0].secret,undefined)
  control.close()
  child.emit('message',{type:'nova.usage',report})
  assert.equal(received.length,1)
})
