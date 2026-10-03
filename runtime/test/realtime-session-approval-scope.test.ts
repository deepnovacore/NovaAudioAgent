import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {ApprovalOffer} from '../src/core/approval.js'
import {APPROVAL_TTL_SECONDS} from '../src/core/approval-port.js'
import {
  beginExecutorApprovalCarrier, propose, realtimeServiceHarness, reserveConfirmationTurn,
} from './support/realtime-service-harness.js'

const offer: ApprovalOffer = {
  kind: 'command_execution',
  local_detail: {kind: 'command_execution', command: 'npm test', cwd: '/workspace'},
  operation_summary: 'Run tests',
  allowed_decisions: ['accept', 'acceptForSession', 'decline'],
}

for (const scenario of ['once', 'session', 'unsupported', 'expired'] as const) {
  test(`structured permission confirmation scope: ${scenario}`, async () => {
    const {service, executorApproval, clock, injectedContents, telemetry} = realtimeServiceHarness('pipeline', {
      projectTool: true, withExecutorApproval: true,
    })
    assert.ok(executorApproval)
    await service.connect()
    const waiting = executorApproval.offer({
      ...offer, ...(scenario === 'unsupported' ? {allowed_decisions: ['accept', 'decline'] as const} : {}),
    }, new AbortController().signal)
    const id = executorApproval.view.pending_approval_id!
    await beginExecutorApprovalCarrier(service, {itemId: 'decision-item', responseId: 'decision-response'})
    if (scenario === 'expired') {
      clock.advanceTo(clock.now() + APPROVAL_TTL_SECONDS)
      await Promise.resolve()
    }
    await service.handleEvent({
      kind: 'tool_call_ready', session_epoch: 1, call_id: 'decision-call', item_id: 'decision-function',
      response_id: 'decision-response', name: 'confirm',
      arguments: {id, accepted: true, ...(scenario === 'once' ? {} : {scope: 'session'})},
    })
    assert.equal(telemetry.findLast(event => event.kind === 'approval.decision')?.payload.requested_scope, scenario === 'expired' ? undefined : scenario === 'once' ? 'once' : 'session')
    if (scenario === 'session') assert.ok(injectedContents.some(content => content.includes('"code":"approval_accepted"') && content.includes('"scope":"session"')))
    if (scenario === 'once') assert.ok(injectedContents.some(content => content.includes('"code":"approval_accepted"') && !content.includes('"scope"')))
    if (scenario === 'unsupported') {
      assert.equal(executorApproval.pending, true, 'unsupported scope never silently degrades to one-shot approval')
      assert.ok(injectedContents.some(content => content.includes('approval_scope_unsupported') && content.includes('"state":"retryable"')))
      assert.equal(injectedContents.some(content => content.includes('"code":"approval_accepted"')), false)
      executorApproval.invalidate('test_cleanup')
    }
    const resolution = await waiting
    assert.ok(resolution)
    assert.equal(executorApproval.consume(resolution), scenario === 'once' ? 'accept'
      : scenario === 'session' ? 'acceptForSession' : 'decline')
    assert.equal(executorApproval.consume(resolution), 'decline', 'all decisions remain single-use')
  })
}

test('approval separates private decision context from public narration', async () => {
  const {service, executorApproval, injectedItems} = realtimeServiceHarness('pipeline', {
    projectTool: true, withExecutorApproval: true,
  })
  assert.ok(executorApproval)
  await service.connect()
  const pending = executorApproval.offer(offer, new AbortController().signal)
  await beginExecutorApprovalCarrier(service, {itemId: 'context-item', responseId: 'context-response'})
  const item = injectedItems.find(item => item.event_id.startsWith('approval:'))!
  assert.ok(item.content.includes('acceptForSession'))
  const speech = (item as typeof item & {speech_content?: string}).speech_content
  assert.ok(speech?.includes('Run tests'))
  assert.doesNotMatch(speech!, /confirm\(|allowed_decisions|id=|command_execution/u)
  executorApproval.invalidate('test_cleanup')
  await pending
})

test('a session grant belongs only to the selected work and cannot grant the next queued work', async () => {
  const {service, executorApproval} = realtimeServiceHarness('pipeline', {projectTool: true, withExecutorApproval: true})
  assert.ok(executorApproval)
  await service.connect()
  const alpha = executorApproval.forWork({work_id: 'alpha', project: 'A', title: 'A'})
  const beta = executorApproval.forWork({work_id: 'beta', project: 'B', title: 'B'})
  const first = alpha.offer(offer, new AbortController().signal)
  const firstId = executorApproval.view.pending_approval_id!
  const second = beta.offer(offer, new AbortController().signal)
  await beginExecutorApprovalCarrier(service, {itemId: 'first-item', responseId: 'first-response'})
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1, call_id: 'first-call', item_id: 'first-function',
    response_id: 'first-response', name: 'confirm', arguments: {id: firstId, accepted: true, scope: 'session'},
  })
  assert.equal(alpha.consume((await first)!), 'acceptForSession')
  assert.equal(executorApproval.view.work?.work_id, 'beta')
  assert.equal(executorApproval.pending, true)
  assert.equal(service.executorApprovalDecision(firstId, true, 'session'), false)
  assert.equal(executorApproval.pending, true)
  beta.invalidate('test_cleanup')
  assert.equal(beta.consume((await second)!), 'decline')
})

test('project confirmation rejects permission session scope without admitting the operation', async () => {
  const {service, controller, injected, actions} = realtimeServiceHarness('confirmation')
  await service.connect()
  const proposal = propose(controller)
  await reserveConfirmationTurn(service, {itemId: 'project-item', responseId: 'project-response'})
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1, call_id: 'project-call', item_id: 'project-function',
    response_id: 'project-response', name: 'confirm',
    arguments: {id: proposal.proposal_id, accepted: true, scope: 'session'},
  })
  assert.equal(controller.pending, true)
  assert.equal(actions.includes('commit'), false)
  assert.match(injected.at(-1)?.content ?? '', /"code":"confirmation_invalid"/u)
})
