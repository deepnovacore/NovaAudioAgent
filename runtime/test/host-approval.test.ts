import assert from 'node:assert/strict'
import {test} from 'node:test'
import {HostApprovalController, type ApprovalOffer} from '../src/approval.js'
import {VirtualClock} from '../src/clock.js'

// The host accepts display facts already validated by an executor's protocol adapter.
const offer: ApprovalOffer = Object.freeze({kind: 'permissions', local_detail: {kind: 'permissions', scope: 'read project'}, operation_summary: 'Read project'} as const)

test('generic host FIFO preserves parked work, fresh promotion TTL and single-use decisions across epoch invalidation', async () => {
  const clock = new VirtualClock(10)
  let next = 0
  const host = new HostApprovalController({clock, idFactory: () => `request-${++next}`})
  const alpha = host.forWork({work_id: 'alpha', project: 'A', title: 'A work'})
  const beta = host.forWork({work_id: 'beta', project: 'B', title: 'B work'})
  const a = alpha.offer(offer, new AbortController().signal)
  const b = beta.offer(offer, new AbortController().signal)
  clock.advanceTo(69)
  assert.equal(host.hold(), true, 'parking before expiry keeps the work')
  clock.advanceTo(200)
  assert.equal(host.pending, true)
  assert.equal(host.view.work?.work_id, 'alpha')
  assert.equal(host.release(), true)
  assert.equal(host.view.expires_at, 260)
  assert.equal(host.acceptDecision({approvalId: 'request-1', decision: 'accept'}), true)
  const accepted = (await a)!
  host.invalidate('provider_replaced')
  assert.equal(alpha.consume(accepted), 'decline', 'an epoch change revokes an unspent response')
  assert.equal(host.view.work?.work_id, 'beta')
  assert.equal(host.view.expires_at, 260, 'the queued work gets its full TTL at promotion')
  assert.equal(host.acceptDecision({approvalId: 'request-1', decision: 'accept'}), false)
  assert.equal(host.acceptDecision({approvalId: 'request-2', decision: 'accept'}), true)
  const second = (await b)!
  assert.equal(beta.consume(second), 'accept')
  assert.equal(beta.consume(second), 'decline')
  assert.equal(host.pending, false)
})
