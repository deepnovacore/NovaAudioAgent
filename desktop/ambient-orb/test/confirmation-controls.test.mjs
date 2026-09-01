import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CodexApprovalDecisionController,
  ConfirmationDecisionController,
  ConfirmationPresentationController,
  parseCodexApprovalMessage,
} from '../src/renderer/confirmation-controls.mjs'

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

test('host busy disables decisions and a runtime rollback re-enables the same proposal', () => {
  const sent = []
  const controller = new ConfirmationDecisionController({send: frame => {
    sent.push(frame)
    return true
  }})

  controller.sync({pending: true, proposalId: 'proposal-busy', busy: false})
  assert.equal(controller.decide(true), true)
  assert.equal(controller.enabled, false)
  controller.sync({pending: true, proposalId: 'proposal-busy', busy: true})
  assert.equal(controller.enabled, false)
  controller.sync({pending: true, proposalId: 'proposal-busy', busy: false})
  assert.equal(controller.enabled, true)
  assert.equal(controller.decide(false), true)
  assert.deepEqual(sent.map(frame => frame.confirmed), [true, false])
})

test('Codex approval controls send their independent exact one-shot frame', () => {
  const sent = []
  const controller = new CodexApprovalDecisionController({send: frame => {
    sent.push(frame)
    return true
  }})
  controller.sync({pending: true, approvalId: 'approval-1'})
  assert.equal(controller.decide(false), true)
  assert.equal(controller.decide(true), false)
  assert.deepEqual(sent, [{
    type: 'codex.approval_decision', approval_id: 'approval-1', approved: false,
  }])
})

test('one confirmation presentation wins and overlap never hides its authority', () => {
  const presentation = new ConfirmationPresentationController()
  assert.equal(presentation.sync('project', true), true)
  assert.equal(presentation.activeKind, 'project')
  assert.equal(presentation.sync('codex', true), false)
  assert.equal(presentation.sync('codex', false), false)
  assert.equal(presentation.activeKind, 'project')
  assert.equal(presentation.sync('project', false), true)
  assert.equal(presentation.activeKind, null)
})

test('Codex approval renderer schema is strict, bounded, and keeps detail local', () => {
  const valid = parseCodexApprovalMessage({
    type: 'codex.approval',
    pending_approval: true,
    pending_approval_busy: false,
    pending_approval_id: 'approval-1',
    kind: 'command_execution',
    local_detail: {kind: 'command_execution', command: 'npm test', cwd: 'C:\\workspace'},
    operation_summary: 'Codex 请求执行一条工作区命令。',
    expires_in_seconds: 60,
  })
  assert.equal(valid?.operation, '执行命令：npm test')
  for (const malformed of [
    {...valid, type: 'codex.approval', extra: true},
    {
      type: 'codex.approval', pending_approval: true, pending_approval_busy: false,
      pending_approval_id: 'approval-1', kind: 'command_execution',
      local_detail: {kind: 'command_execution', command: '', cwd: 'C:\\workspace'},
      operation_summary: 'summary', expires_in_seconds: 60,
    },
    {
      type: 'codex.approval', pending_approval: true, pending_approval_busy: false,
      pending_approval_id: 'approval-1', kind: 'command_execution',
      local_detail: {kind: 'command_execution', command: '\u001c', cwd: 'C:\\workspace'},
      operation_summary: 'summary', expires_in_seconds: 60,
    },
  ]) assert.equal(parseCodexApprovalMessage(malformed), null)
})
