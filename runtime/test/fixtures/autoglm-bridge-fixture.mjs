// Fake-only protocol peer: instruction selects a test scenario, never a device action.
import assert from 'node:assert/strict'
import {appendFileSync} from 'node:fs'
import {join} from 'node:path'
import {createInterface} from 'node:readline'

const lines = createInterface({input: process.stdin})
let start
const send = value => process.stdout.write(`${JSON.stringify({version: 1, taskId: start.taskId, ...value})}\n`)
const record = value => appendFileSync(join(process.env.AUTOGLM_SOURCE_PATH, 'protocol.jsonl'), `${JSON.stringify(value)}\n`)
lines.on('line', line => {
  const message = JSON.parse(line)
  record(message)
  if (start === undefined) {
    assert.deepEqual(Object.keys(message).sort(), ['baseUrl', 'budgetMs', 'deviceId', 'deviceType', 'instruction', 'maxSteps', 'model', 'taskId', 'type', 'version', ...(message.deviceType === 'ios' ? ['wdaUrl'] : [])].sort())
    assert.equal(message.version, 1)
    assert.equal(message.type, 'start')
    assert.match(message.taskId, /^[a-f0-9-]{36}$/u)
    assert.equal(message.deviceId, 'fake-serial')
    assert.ok(['ios', 'android'].includes(message.deviceType))
    if (message.deviceType === 'ios') assert.equal(message.wdaUrl, 'http://127.0.0.1:8100')
    assert.equal(message.baseUrl, 'http://127.0.0.1:8000/v1')
    assert.equal(message.model, 'fake-model')
    assert.equal(message.maxSteps, 3)
    assert.ok(message.budgetMs > 0 && message.budgetMs <= 5000)
    assert.equal(process.env.AUTOGLM_API_KEY, 'fake-secret')
    start = message
    if (start.instruction === 'malformed') { process.stdout.write('{invalid}\n'); return }
    if (start.instruction === 'oversized') { process.stdout.write('x'.repeat(65537)); return }
    if (start.instruction === 'wrong-task') { send({type: 'ready', taskId: 'other-task', upstreamCommit: 'a'.repeat(40)}); return }
    if (start.instruction === 'unready-terminal') { send({type: 'terminal', code: 'model_finished', steps: 0}); return }
    send({type: 'ready', upstreamCommit: 'a'.repeat(40)})
    if (start.instruction === 'eof') { process.exit(0) }
    send({type: 'progress', step: 1, phase: 'model'})
    send({type: 'approval', requestId: 'action-1', step: 1,
      action: {_metadata: 'do', action: 'Tap', element: [100, 200]},
      screenDigest: 'b'.repeat(64), packageName: 'example.fake'})
    if (start.instruction === 'exit-approval') process.stdout.write('', () => process.exit(0))
    return
  }
  assert.deepEqual(message, {version: 1, type: 'decision', taskId: start.taskId, requestId: 'action-1', decision: message.decision})
  assert.ok(['accept', 'decline'].includes(message.decision))
  if (message.decision === 'accept') {
    record({executed: true})
    send({type: 'progress', step: 1, phase: 'action_returned', lastAction: 'Tap'})
    if (start.instruction === 'partial-wait') return
  }
  send({type: 'terminal', code: message.decision === 'accept' ? 'model_finished' : 'declined', steps: 1, lastAction: 'Tap'})
})
