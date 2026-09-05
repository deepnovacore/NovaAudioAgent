import assert from 'node:assert/strict'
import test from 'node:test'
import {createKnowledgeActions} from '../src/main/knowledge-actions.mjs'

test('file ingestion admits native paths only after data disclosure consent', async () => {
  const requests = []
  let dialogs = 0
  const actions = createKnowledgeActions({
    request: async (method, params) => {requests.push({method, params}); return {ok: true}},
    pick: async () => {dialogs++; return {canceled: false, filePaths: ['/documents/manual.md']}},
  })
  await assert.rejects(actions.run({action: 'files', paths: ['/private/secret']}), /rejected/)
  await assert.rejects(actions.run({action: 'files', consent: false}), /rejected/)
  assert.equal(dialogs, 0)
  await actions.run({action: 'files', consent: true})
  assert.deepEqual(requests, [{method: 'knowledge.ingest', params: {kind: 'file', locator: '/documents/manual.md', consent: true}}])
})

test('cancelled picker and malformed actions never reach utility process', async () => {
  let calls = 0
  const actions = createKnowledgeActions({request: async () => {calls++}, pick: async () => ({canceled: true, filePaths: []})})
  assert.deepEqual(await actions.run({action: 'folder', consent: true}), {cancelled: true})
  for (const input of [{action: 'remove', id: '../escape'}, {action: 'url', url: 'file:///private/a', consent: true},
    {action: 'reindex', id: 'abc', consent: false}, {action: 'status', path: '/tmp'}]) {
    await assert.rejects(actions.run(input), /rejected/)
  }
  assert.equal(calls, 0)
})

test('read-only status and id-bound mutations have exact payloads', async () => {
  const requests = []
  const actions = createKnowledgeActions({request: async (method, params) => {requests.push({method, params}); return {}}, pick: async () => {throw Error('unexpected')}})
  await actions.run({action: 'status'})
  await actions.run({action: 'remove', id: 'source-1'})
  await actions.run({action: 'reindex', id: 'source-1', consent: true})
  assert.deepEqual(requests, [{method: 'knowledge.status', params: {}}, {method: 'knowledge.remove', params: {id: 'source-1'}},
    {method: 'knowledge.reindex', params: {id: 'source-1', consent: true}}])
})
