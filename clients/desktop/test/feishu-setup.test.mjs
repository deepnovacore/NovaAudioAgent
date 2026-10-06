import test from 'node:test'
import assert from 'node:assert/strict'
import {join, resolve} from 'node:path'
import {createFeishuSetupOwner} from '../src/main/feishu-setup.mjs'
test('setup-only owner shares paths, excludes collectors, reuses owner and drains before handoff', async () => {
  const calls = []; let options
  class Connector {
    constructor(value) {options = value; calls.push('new')}
    async open() {calls.push('open')}
    async command(method) {calls.push(method); return {configured: false}}
    async close() {calls.push('close')}
  }
  const setup = createFeishuSetupOwner({Connector, environment: {BLACKBOARD_PATH: '/tmp/isolated.sqlite'}})
  await setup.request('feishu.status', {})
  await setup.request('feishu.app.status', {})
  assert.equal(options.bootstrapOnly, true)
  assert.equal(options.credentialRoot, join(resolve('/tmp/isolated.sqlite') + '.personal.json.feishu', 'credentials'))
  assert.equal(options.ingest, undefined)
  await assert.rejects(setup.request('feishu.sync', {}))
  await setup.release()
  assert.deepEqual(calls, ['new', 'open', 'feishu.status', 'feishu.app.status', 'close'])
})
