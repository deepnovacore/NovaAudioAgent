import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfirmationDecisionController } from '../src/renderer/confirmation-controls.mjs'

test('confirmation buttons send one exact bound decision and fail closed after it', () => {
  const sent = []
  const controller = new ConfirmationDecisionController({send: frame => {
    sent.push(frame)
    return true
  }})

  controller.sync({pending: true, proposalId: 'proposal-1'})
  assert.equal(controller.enabled, true)
  assert.equal(controller.decide(true), true)
  assert.equal(controller.enabled, false)
  assert.equal(controller.decide(false), false)
  assert.deepEqual(sent, [{
    type: 'project.confirmation_decision',
    proposal_id: 'proposal-1',
    confirmed: true,
  }])

  controller.sync({pending: false, proposalId: null})
  assert.equal(controller.decide(false), false)
  controller.sync({pending: true, proposalId: 'proposal-2'})
  assert.equal(controller.decide(false), true)
  assert.equal(sent.at(-1).proposal_id, 'proposal-2')
})

test('confirmation controls reject malformed proposal bindings', () => {
  const controller = new ConfirmationDecisionController({send: () => true})
  for (const proposalId of [null, '', 'x'.repeat(129), 7]) {
    controller.sync({pending: true, proposalId})
    assert.equal(controller.enabled, false)
    assert.equal(controller.decide(true), false)
  }
})

test('a dropped send stays retryable and reconnect releases an uncertain click', () => {
  let deliver = false
  const sent = []
  const controller = new ConfirmationDecisionController({send: frame => {
    sent.push(frame)
    return deliver
  }})

  controller.sync({pending: true, proposalId: 'proposal-reconnect'})
  assert.equal(controller.decide(true), false)
  assert.equal(controller.enabled, true)

  deliver = true
  assert.equal(controller.decide(true), true)
  assert.equal(controller.enabled, false)
  controller.deliveryLost()
  assert.equal(controller.enabled, true)
  assert.equal(controller.decide(false), true)
  assert.deepEqual(sent.map(frame => frame.confirmed), [true, true, false])
})
