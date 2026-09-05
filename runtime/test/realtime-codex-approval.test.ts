import assert from 'node:assert/strict'
import {test} from 'node:test'

import {VirtualClock} from '../src/clock.js'
import {
  CODEX_APPROVAL_TTL_SECONDS,
  CodexApprovalController,
  type CodexApprovalResolution,
  type CodexApprovalView,
} from '../src/executors/codex/approval.js'

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
    work: null,
    queued: 0,
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
    work: null,
    queued: 0,
  })
  assert.equal(views.some(view => view.pending_approval_busy), true)
})

test('concurrency, invalidation, signal loss, and expiry all settle fail-closed', async () => {
  const clock = new VirtualClock(5)
  const approval = controller(clock)

  // Spec 08: a concurrent offer queues behind the head; only one is visible at a time.
  const first = offerCommand(approval)
  const second = offerCommand(approval)
  assert.equal(approval.view.queued, 1, 'the second offer waits in the queue')
  assert.equal(approval.invalidate('turn_completed'), true)
  const invalidated = await first
  assert.notEqual(invalidated, null)
  assert.equal(approval.consume(invalidated!), 'decline')
  assert.equal(approval.view.pending_approval, true, 'dropping the head promotes the queued offer')
  assert.equal(approval.view.queued, 0)
  assert.equal(approval.invalidate('turn_completed'), true)
  assert.equal(approval.consume((await second)!), 'decline')
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

test('a held head outlives its TTL, still takes a click, and release re-arms a full TTL', async () => {
  const clock = new VirtualClock(5)
  const views: CodexApprovalView[] = []
  const approval = controller(clock, views)
  const first = offerCommand(approval)
  assert.equal(approval.hold(), true)
  assert.equal(approval.hold(), false, 'idempotent')
  assert.equal(approval.view.held, true)
  clock.advanceTo(clock.now() + CODEX_APPROVAL_TTL_SECONDS + 30)
  await Promise.resolve()
  assert.equal(approval.pending, true, 'no expiry while held')
  assert.equal(approval.release(), true)
  assert.equal(approval.release(), false)
  assert.equal(approval.view.held, undefined)
  assert.equal(approval.view.expires_at, clock.now() + CODEX_APPROVAL_TTL_SECONDS)
  clock.advanceTo(clock.now() + CODEX_APPROVAL_TTL_SECONDS)
  await Promise.resolve()
  assert.equal(approval.consume((await first)!), 'decline', 'expires normally once released')

  // A renderer click is an explicit decision and works while held, even past the stale deadline.
  const second = offerCommand(approval)
  approval.hold()
  clock.advanceTo(clock.now() + CODEX_APPROVAL_TTL_SECONDS + 1)
  assert.equal(approval.acceptDecision({approvalId: 'nova-approval-2', decision: 'accept'}), true)
  assert.equal(approval.consume((await second)!), 'accept')
  assert.equal(approval.hold(), false, 'nothing to hold')
  assert.equal(approval.release(), false)
})

test('hold cannot revive an approval whose deadline has already arrived', async () => {
  const clock = new VirtualClock(5)
  const approval = controller(clock)
  const waiting = offerCommand(approval)
  clock.advanceTo(clock.now() + CODEX_APPROVAL_TTL_SECONDS)
  assert.equal(approval.hold(), false)
  assert.equal(approval.consume((await waiting)!), 'decline')
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
    await assert.rejects(offerCommand(approval), /invalid approval id/u)
    assert.equal(approval.pending, false)
  }

  const approval = controller()
  const waiting = offerCommand(approval)
  assert.equal(approval.acceptDecision({
    approvalId: 'nova-approval-1',
    decision: 'acceptForSession',
  }), false)
  assert.equal(approval.pending, true)
  approval.invalidate('test_cleanup')
  await waiting
})
