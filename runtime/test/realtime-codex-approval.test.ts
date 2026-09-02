import assert from 'node:assert/strict'
import {test} from 'node:test'

import {VirtualClock} from '../src/clock.js'
import {
  CODEX_APPROVAL_TTL_SECONDS,
  CodexApprovalController,
  type CodexApprovalResolution,
  type CodexApprovalView,
} from '../src/realtime/codex-approval.js'

function controller(
  clock = new VirtualClock(10),
  views: CodexApprovalView[] = [],
): CodexApprovalController {
  let nextId = 0
  const approval = new CodexApprovalController({
    clock,
    idFactory: () => `nova-approval-${++nextId}`,
  })
  approval.observe(view => { views.push(view) })
  return approval
}

function offerCommand(
  approval: CodexApprovalController,
  signal: AbortSignal = new AbortController().signal,
): Promise<CodexApprovalResolution | null> {
  return approval.offer({
    kind: 'command_execution',
    local_detail: {
      kind: 'command_execution',
      command: 'npm test --workspace runtime',
      cwd: 'C:\\workspace',
    },
    operation_summary: 'Codex 请求执行一条工作区命令。',
  }, signal)
}

test('one exact opaque decision is consumed once while observers see the busy edge', async () => {
  const views: CodexApprovalView[] = []
  const approval = controller(new VirtualClock(10), views)
  const waiting = offerCommand(approval)

  assert.deepEqual(approval.view, {
    pending_approval: true,
    pending_approval_busy: false,
    pending_approval_id: 'nova-approval-1',
    kind: 'command_execution',
    local_detail: {
      kind: 'command_execution',
      command: 'npm test --workspace runtime',
      cwd: 'C:\\workspace',
    },
    operation_summary: 'Codex 请求执行一条工作区命令。',
    expires_at: 10 + CODEX_APPROVAL_TTL_SECONDS,
  })
  assert.equal(approval.acceptDecision({approvalId: 'stale', decision: 'accept'}), false)
  assert.equal(approval.acceptDecision({approvalId: 'nova-approval-1', decision: 'accept'}), true)
  assert.equal(approval.view.pending_approval_busy, true)
  assert.equal(approval.acceptDecision({approvalId: 'nova-approval-1', decision: 'decline'}), false)

  const resolution = await waiting
  assert.notEqual(resolution, null)
  assert.equal(approval.consume(resolution!), 'accept')
  assert.equal(approval.consume(resolution!), 'decline', 'the resolution is one-shot')
  assert.deepEqual(approval.view, {
    pending_approval: false,
    pending_approval_busy: false,
    kind: null,
    local_detail: null,
    operation_summary: null,
    expires_at: null,
  })
  assert.equal(views.some(view => view.pending_approval_busy), true)
})

test('concurrency, invalidation, signal loss, and expiry all settle fail-closed', async () => {
  const clock = new VirtualClock(5)
  const approval = controller(clock)

  const first = offerCommand(approval)
  assert.equal(await offerCommand(approval), null, 'only one approval may be pending')
  assert.equal(approval.invalidate('turn_completed'), true)
  const invalidated = await first
  assert.notEqual(invalidated, null)
  assert.equal(approval.consume(invalidated!), 'decline')
  assert.equal(approval.invalidate('already_clear'), false)

  const transport = new AbortController()
  const lost = offerCommand(approval, transport.signal)
  transport.abort()
  const lostResolution = await lost
  assert.notEqual(lostResolution, null)
  assert.equal(approval.consume(lostResolution!), 'decline')

  const expired = offerCommand(approval)
  clock.advanceTo(clock.now() + CODEX_APPROVAL_TTL_SECONDS)
  await Promise.resolve()
  const expiredResolution = await expired
  assert.notEqual(expiredResolution, null)
  assert.equal(approval.consume(expiredResolution!), 'decline')
  assert.equal(approval.pending, false)
})

test('file display data is snapshotted and observer failures cannot strand authority', async () => {
  const approval = new CodexApprovalController({
    clock: new VirtualClock(),
    idFactory: () => 'file-public-id',
  })
  let healthyObserverCalls = 0
  approval.observe(() => { throw new Error('renderer gone') })
  approval.observe(() => { healthyObserverCalls += 1 })
  const changes = [{change: 'update' as const, path: 'src/a.ts', move_path: 'src/b.ts'}]
  const waiting = approval.offer({
    kind: 'file_change',
    local_detail: {kind: 'file_change', changes},
    operation_summary: 'Codex 请求修改工作区文件。',
  }, new AbortController().signal)
  changes[0]!.path = 'PRIVATE-MUTATION'

  assert.deepEqual(approval.view.local_detail, {
    kind: 'file_change',
    changes: [{change: 'update', path: 'src/a.ts', move_path: 'src/b.ts'}],
  })
  assert.equal(approval.acceptDecision({approvalId: 'file-public-id', decision: 'decline'}), true)
  const resolution = await waiting
  assert.notEqual(resolution, null)
  assert.equal(approval.consume(resolution!), 'decline')
  assert.equal(healthyObserverCalls >= 3, true)
})

test('invalid generated IDs and malformed public decisions never replace pending state', async () => {
  for (const idFactory of [() => '', () => 'x'.repeat(129)]) {
    const approval = new CodexApprovalController({clock: new VirtualClock(), idFactory})
    await assert.rejects(offerCommand(approval), /invalid Codex approval id/u)
    assert.equal(approval.pending, false)
  }

  const approval = controller()
  const waiting = offerCommand(approval)
  assert.equal(approval.acceptDecision({
    approvalId: 'nova-approval-1',
    decision: 'acceptForSession' as 'accept',
  }), false)
  assert.equal(approval.pending, true)
  approval.invalidate('test_cleanup')
  await waiting
})
