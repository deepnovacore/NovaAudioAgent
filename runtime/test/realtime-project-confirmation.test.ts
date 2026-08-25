import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VirtualClock } from '../src/clock.js'
import {
  ProjectConfirmationController,
  type ProjectConfirmationView,
} from '../src/realtime/project-confirmation.js'

function createController(
  clock: VirtualClock = new VirtualClock(10),
  changes?: ProjectConfirmationView[],
): ProjectConfirmationController {
  let nextId = 0
  const base = {
    clock,
    idFactory: () => `proposal-${++nextId}`,
  }
  if (changes === undefined) return new ProjectConfirmationController(base)
  return new ProjectConfirmationController({...base, onChange: view => { changes.push(view) }})
}

function prepareSelect(controller: ProjectConfirmationController) {
  return controller.prepare({
    action: 'select',
    workspace_display_name: '天气看板',
    workspace_id: 'workspace-private',
    session_title: null,
    session_id: null,
    work_order: null,
    origin_ref: 'user:1',
  })
}

test('a matching structured true decision grants one-shot identity authority', () => {
  const controller = createController()
  const proposal = prepareSelect(controller)

  assert.equal(proposal.proposal_id, 'proposal-1')
  assert.equal('nonce' in proposal, false)
  assert.equal(controller.reserveUserItem({epoch: 1, itemId: 'user-1'}), true)
  const accepted = controller.acceptDecision({
    epoch: 1,
    itemId: 'user-1',
    proposalId: proposal.proposal_id,
    confirmed: true,
  })

  assert.equal(accepted.kind, 'confirmed')
  assert.ok(accepted.operation)
  assert.equal(accepted.operation.proposal_id, proposal.proposal_id)
  assert.equal('nonce' in accepted.operation, false)
  assert.equal(Object.isFrozen(accepted.operation), true)
  assert.equal(controller.pending, false)
  assert.equal(controller.claimConfirmed(accepted.operation), true)
  assert.equal(controller.claimConfirmed(accepted.operation), false)
})

test('a reconstructed operation cannot claim identity authority', () => {
  const controller = createController()
  const proposal = prepareSelect(controller)
  controller.reserveUserItem({epoch: 1, itemId: 'user-1'})
  const accepted = controller.acceptDecision({
    epoch: 1,
    itemId: 'user-1',
    proposalId: proposal.proposal_id,
    confirmed: true,
  })
  assert.ok(accepted.operation)

  assert.equal(controller.claimConfirmed({...accepted.operation}), false)
  assert.equal(controller.claimConfirmed(accepted.operation), true)
})

test('a matching structured false decision cancels without authority', () => {
  const controller = createController()
  const proposal = prepareSelect(controller)
  controller.reserveUserItem({epoch: 2, itemId: 'user-2'})

  const cancelled = controller.acceptDecision({
    epoch: 2,
    itemId: 'user-2',
    proposalId: proposal.proposal_id,
    confirmed: false,
  })

  assert.equal(cancelled.kind, 'cancelled')
  assert.equal(cancelled.operation, null)
  assert.equal(cancelled.response_text, '已取消。')
  assert.equal(controller.pending, false)
})

test('wrong proposal ID and non-boolean decisions are invalid and never commit', () => {
  const controller = createController()
  const proposal = prepareSelect(controller)
  controller.reserveUserItem({epoch: 3, itemId: 'user-3'})

  for (const input of [
    {proposalId: 'proposal-other', confirmed: true},
    {proposalId: proposal.proposal_id, confirmed: 'true' as unknown as boolean},
    {proposalId: proposal.proposal_id, confirmed: 1 as unknown as boolean},
  ]) {
    const invalid = controller.acceptDecision({epoch: 3, itemId: 'user-3', ...input})
    assert.equal(invalid.kind, 'invalid')
    assert.equal(invalid.operation, null)
    assert.equal(controller.pending, true)
  }

  const accepted = controller.acceptDecision({
    epoch: 3,
    itemId: 'user-3',
    proposalId: proposal.proposal_id,
    confirmed: true,
  })
  assert.ok(accepted.operation)
  assert.equal(controller.claimConfirmed(accepted.operation), true)
})

test('a non-string proposal ID is ignored without moving state', () => {
  const controller = createController()
  const proposal = prepareSelect(controller)
  controller.reserveUserItem({epoch: 3, itemId: 'user-3'})

  const ignored = controller.acceptDecision({
    epoch: 3,
    itemId: 'user-3',
    proposalId: 7 as unknown as string,
    confirmed: true,
  })

  assert.equal(ignored.kind, 'ignored')
  assert.equal(ignored.operation, null)
  assert.equal(controller.pending, true)
  assert.equal(controller.acceptDecision({
    epoch: 3,
    itemId: 'user-3',
    proposalId: proposal.proposal_id,
    confirmed: false,
  }).kind, 'cancelled')
})

test('wrong epoch or item is ignored without moving the reservation', () => {
  const controller = createController()
  const proposal = prepareSelect(controller)
  controller.reserveUserItem({epoch: 4, itemId: 'reserved'})

  for (const [epoch, itemId] of [
    [5, 'reserved'],
    [4, 'other'],
    [4, 7 as unknown as string],
  ] as const) {
    const ignored = controller.acceptDecision({
      epoch,
      itemId,
      proposalId: proposal.proposal_id,
      confirmed: true,
    })
    assert.equal(ignored.kind, 'ignored')
    assert.equal(ignored.operation, null)
  }

  assert.equal(controller.acceptDecision({
    epoch: 4,
    itemId: 'reserved',
    proposalId: proposal.proposal_id,
    confirmed: false,
  }).kind, 'cancelled')
})

test('expired decisions clear the proposal and notify expiry without committing', () => {
  const clock = new VirtualClock(1)
  const controller = createController(clock)
  const expiries: boolean[] = []
  const proposal = prepareSelect(controller)
  controller.observeExpiry(() => expiries.push(true))
  controller.reserveUserItem({epoch: 1, itemId: 'user-1'})
  clock.advanceTo(91)

  const expired = controller.acceptDecision({
    epoch: 1,
    itemId: 'user-1',
    proposalId: proposal.proposal_id,
    confirmed: true,
  })

  assert.equal(expired.kind, 'expired')
  assert.equal(expired.operation, null)
  assert.equal(controller.pending, false)
  assert.deepEqual(expiries, [true])
})

test('releaseUndecided releases only the matching reservation', () => {
  const controller = createController()
  const proposal = prepareSelect(controller)
  controller.reserveUserItem({epoch: 1, itemId: 'first'})

  assert.equal(controller.releaseUndecided({epoch: 2, itemId: 'first'}), false)
  assert.equal(controller.releaseUndecided({epoch: 1, itemId: 'other'}), false)
  assert.equal(controller.releaseUndecided({epoch: 1, itemId: 'first'}), true)
  assert.equal(controller.releaseUndecided({epoch: 1, itemId: 'first'}), false)
  assert.equal(controller.pending, true)
  assert.equal(controller.reserveUserItem({epoch: 1, itemId: 'second'}), true)

  const accepted = controller.acceptDecision({
    epoch: 1,
    itemId: 'second',
    proposalId: proposal.proposal_id,
    confirmed: true,
  })
  assert.equal(accepted.kind, 'confirmed')
})

test('a released proposal remains live only until its original 90-second expiry', () => {
  const clock = new VirtualClock(10)
  const controller = createController(clock)
  prepareSelect(controller)
  controller.reserveUserItem({epoch: 1, itemId: 'first'})
  assert.equal(controller.releaseUndecided({epoch: 1, itemId: 'first'}), true)

  clock.advanceTo(99.9)
  assert.equal(controller.pending, true)
  clock.advanceTo(100)
  assert.equal(controller.pending, false)
  assert.equal(controller.reserveUserItem({epoch: 1, itemId: 'late'}), false)
})

test('duplicate and replayed decisions fail closed', () => {
  const controller = createController()
  const proposal = prepareSelect(controller)
  controller.reserveUserItem({epoch: 1, itemId: 'user-1'})
  const accepted = controller.acceptDecision({
    epoch: 1,
    itemId: 'user-1',
    proposalId: proposal.proposal_id,
    confirmed: true,
  })
  assert.ok(accepted.operation)

  const replay = controller.acceptDecision({
    epoch: 1,
    itemId: 'user-1',
    proposalId: proposal.proposal_id,
    confirmed: true,
  })
  assert.equal(replay.kind, 'ignored')
  assert.equal(replay.operation, null)
  assert.equal(controller.claimConfirmed(accepted.operation), true)
  assert.equal(controller.claimConfirmed(accepted.operation), false)
})

test('a replacement proposal invalidates the old reservation and ID', () => {
  const controller = createController()
  const first = prepareSelect(controller)
  controller.reserveUserItem({epoch: 1, itemId: 'old'})
  const second = controller.prepare({
    action: 'create',
    workspace_display_name: '新项目',
    workspace_id: null,
    session_title: null,
    session_id: null,
    work_order: '创建 README',
    origin_ref: 'user:2',
  })

  assert.notEqual(first.proposal_id, second.proposal_id)
  assert.equal(controller.acceptDecision({
    epoch: 1,
    itemId: 'old',
    proposalId: first.proposal_id,
    confirmed: true,
  }).kind, 'ignored')
})

test('provider invalidation clears both a proposal and unspent authority', () => {
  const controller = createController()
  let proposal = prepareSelect(controller)
  controller.reserveUserItem({epoch: 1, itemId: 'user-1'})
  assert.equal(controller.invalidate('provider_replaced'), true)
  assert.equal(controller.pending, false)

  proposal = prepareSelect(controller)
  controller.reserveUserItem({epoch: 2, itemId: 'user-2'})
  const accepted = controller.acceptDecision({
    epoch: 2,
    itemId: 'user-2',
    proposalId: proposal.proposal_id,
    confirmed: true,
  })
  assert.ok(accepted.operation)
  assert.equal(controller.invalidate('provider_replaced'), true)
  assert.equal(controller.claimConfirmed(accepted.operation), false)
})

test('public view and prompt expose labels but no private bindings', () => {
  const changes: ProjectConfirmationView[] = []
  const controller = createController(new VirtualClock(10), changes)
  const proposal = controller.prepare({
    action: 'resume',
    workspace_display_name: '天气看板',
    workspace_id: 'workspace-secret',
    session_title: '登录修复',
    session_id: 'session-secret',
    work_order: '继续修复',
    origin_ref: 'user:1',
  })

  assert.equal(proposal.confirmation_prompt, '准备切换到天气看板，并继续 Session“登录修复”，请确认或取消。')
  const rendered = JSON.stringify(controller.view)
  for (const privateValue of [
    'workspace-secret', 'session-secret', proposal.proposal_id, 'user:1', '继续修复',
  ]) {
    assert.equal(rendered.includes(privateValue), false)
    assert.equal(proposal.confirmation_prompt.includes(privateValue), false)
  }
  assert.deepEqual(changes.at(-1), controller.view)
})

test('invalid proposal IDs are rejected before replacing pending state', () => {
  for (const proposalId of ['', 'x'.repeat(129)]) {
    const controller = new ProjectConfirmationController({
      clock: new VirtualClock(),
      idFactory: () => proposalId,
    })
    assert.throws(() => prepareSelect(controller), /invalid confirmation proposal id/u)
  }
})
