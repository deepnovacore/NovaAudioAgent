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
  controller.sync({pending: true, approvalId: 'approval-1', executor: 'codex'})
  assert.equal(controller.decide(false), true)
  assert.equal(controller.decide(true), false)
  assert.deepEqual(sent, [{
    type: 'executor.approval_decision', executor: 'codex', approval_id: 'approval-1', approved: false,
  }])
})

test('session grants require the advertised decision and never change the boolean accept path', () => {
  const sent = []
  const controller = new CodexApprovalDecisionController({send: frame => { sent.push(frame); return true }})
  controller.sync({pending: true, approvalId: 'approval', executor: 'codex', allowedDecisions: ['accept', 'decline']})
  assert.equal(controller.canAcceptForSession, false)
  assert.equal(controller.decide(true, 'session'), false)
  assert.equal(controller.decide(true), true)
  assert.equal(sent[0].scope, undefined)
  controller.sync({pending: true, approvalId: 'next', executor: 'codex', allowedDecisions: ['acceptForSession', 'decline']})
  assert.equal(controller.canAccept, false)
  assert.equal(controller.canAcceptForSession, true)
  assert.equal(controller.decide(true), false)
  assert.equal(controller.decide(false, 'session'), false)
  assert.equal(controller.decide(true, 'session'), true)
  assert.deepEqual(sent.at(-1), {type: 'executor.approval_decision', executor: 'codex', approval_id: 'next', approved: true, scope: 'session'})
})

test('permission scope and allowed buttons survive the wire while unknown authority is rejected', () => {
  const frame = {type: 'executor.approval', executor: 'codex', display_name: 'Codex', pending_approval: true, pending_approval_busy: false,
    pending_approval_id: 'p', kind: 'permissions', local_detail: {kind: 'permissions', scope: 'write: 工作区外；网络：请求访问'},
    operation_summary: 'Codex 请求提升权限。', expires_in_seconds: 60,
    allowed_decisions: ['accept', 'acceptForSession', 'decline']}
  assert.match(parseCodexApprovalMessage(frame).operation, /工作区外/)
  assert.equal(parseCodexApprovalMessage({...frame, allowed_decisions: ['acceptWithExecpolicyAmendment']}), null)
  assert.equal(parseCodexApprovalMessage({...frame, local_detail: {kind: 'permissions', scope: 'x'.repeat(1025)}}), null)
})

test('the pending loser is promoted after the visible Codex confirmation settles', () => {
  const presentation = new ConfirmationPresentationController()
  const sent = []
  const project = new ConfirmationDecisionController({send: frame => {
    sent.push(frame)
    return true
  }})
  const codex = new CodexApprovalDecisionController({send: () => true})
  codex.sync({pending: true, approvalId: 'approval-1', executor: 'codex'})
  project.sync({pending: true, proposalId: 'proposal-1'})

  assert.equal(presentation.sync('codex', true), true)
  assert.equal(presentation.sync('project', true), false)
  assert.equal(presentation.activeKind, 'codex')
  assert.equal(presentation.sync('codex', false), true)
  codex.sync({pending: false, approvalId: null})
  assert.equal(presentation.activeKind, 'project')
  assert.equal(project.enabled, true)
  assert.equal(project.decide(true), true)
  assert.deepEqual(sent, [{
    type: 'project.confirmation_decision', proposal_id: 'proposal-1', confirmed: true,
  }])
})

test('the pending Codex loser is promoted after the visible project confirmation settles', () => {
  const presentation = new ConfirmationPresentationController()
  const sent = []
  const project = new ConfirmationDecisionController({send: () => true})
  const codex = new CodexApprovalDecisionController({send: frame => {
    sent.push(frame)
    return true
  }})
  project.sync({pending: true, proposalId: 'proposal-1'})
  codex.sync({pending: true, approvalId: 'approval-1', executor: 'codex'})
  assert.equal(presentation.sync('project', true), true)
  assert.equal(presentation.sync('codex', true), false)
  assert.equal(presentation.activeKind, 'project')
  assert.equal(presentation.sync('project', false), true)
  project.sync({pending: false, proposalId: null})
  assert.equal(presentation.activeKind, 'codex')
  assert.equal(codex.enabled, true)
  assert.equal(codex.decide(false), true)
  assert.deepEqual(sent, [{
    type: 'executor.approval_decision', executor: 'codex', approval_id: 'approval-1', approved: false,
  }])
  assert.equal(presentation.sync('codex', false), true)
  assert.equal(presentation.activeKind, null)
})

test('Codex approval renderer schema is strict, bounded, and keeps detail local', () => {
  const valid = parseCodexApprovalMessage({
    type: 'executor.approval',
    executor: 'codex',
    display_name: 'Codex',
    pending_approval: true,
    pending_approval_busy: false,
    pending_approval_id: 'approval-1',
    kind: 'command_execution',
    local_detail: {kind: 'command_execution', command: 'npm test', cwd: 'C:\\workspace'},
    operation_summary: 'Codex 请求执行一条工作区命令。',
    expires_in_seconds: 60,
  })
  assert.equal(valid?.operation, '执行命令：npm test')

  // Spec 08 §desktop: the pill names the asking work's project and session title when the wire carries it.
  const frame = {...valid, local_detail: {kind: 'command_execution', command: 'npm test', cwd: 'C:\\workspace'}}
  delete frame.operation
  // A head parked behind a project confirmation carries no countdown; a negative or oversized one is still refused.
  assert.equal(parseCodexApprovalMessage({...frame, expires_in_seconds: null})?.expires_in_seconds, null)
  assert.equal(parseCodexApprovalMessage({...frame, expires_in_seconds: 61}), null)
  const work = {work_id: 'work-1', project: 'blog', title: '暗色模式'}
  assert.equal(parseCodexApprovalMessage({...frame, work})?.operation, 'blog / 暗色模式：执行命令：npm test')
  for (const bad of [
    null, [], {...work, extra: 1}, {work_id: 'work-1', project: 'blog'},
    {...work, project: ''}, {...work, title: 't'.repeat(121)}, {...work, work_id: 1},
  ]) assert.equal(parseCodexApprovalMessage({...frame, work: bad}), null, JSON.stringify(bad))

  for (const malformed of [
    {...valid, type: 'executor.approval', extra: true},
    {...valid, type: 'codex.approval'},
    {...valid, display_name: ''},
    {
      type: 'executor.approval', executor: 'codex', display_name: 'Codex', pending_approval: true, pending_approval_busy: false,
      pending_approval_id: 'approval-1', kind: 'command_execution',
      local_detail: {kind: 'command_execution', command: '', cwd: 'C:\\workspace'},
      operation_summary: 'summary', expires_in_seconds: 60,
    },
    {
      type: 'executor.approval', executor: 'codex', display_name: 'Codex', pending_approval: true, pending_approval_busy: false,
      pending_approval_id: 'approval-1', kind: 'command_execution',
      local_detail: {kind: 'command_execution', command: '\u001c', cwd: 'C:\\workspace'},
      operation_summary: 'summary', expires_in_seconds: 60,
    },
  ]) assert.equal(parseCodexApprovalMessage(malformed), null)
})
