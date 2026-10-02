import assert from 'node:assert/strict'
import {test} from 'node:test'
import {HostApprovalController, type ApprovalOffer} from '../src/core/approval.js'
import {VirtualClock} from '../src/core/clock.js'

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


test('background hold survives project release and queued promotion without weakening cancel', async () => {
  const clock=new VirtualClock(0);let sequence=0
  const host=new HostApprovalController({clock,idFactory:()=>`r${++sequence}`})
  const hold=host.hold.bind(host) as (reason?:string)=>boolean
  const release=host.release.bind(host) as (reason?:string)=>boolean
  hold('background')
  const abort=new AbortController()
  const a=host.offer(offer,abort.signal)
  const b=host.offer(offer,new AbortController().signal)
  hold('project');release('project')
  clock.advanceTo(7200);await Promise.resolve()
  assert.equal(host.pending,true,'background keeps the first approval alive')
  assert.equal(host.view.pending_approval_id,'r1')
  abort.abort();assert.equal((await a)?.decision,'decline')
  clock.advanceTo(14400);await Promise.resolve()
  assert.equal(host.view.pending_approval_id,'r2','promoted entry inherits background hold')
  assert.equal(host.pending,true)
  release('background')
  assert.equal(host.view.expires_at,14460)
  assert.equal(host.acceptDecision({approvalId:'r1',decision:'accept'}),false)
  assert.equal(host.acceptDecision({approvalId:'r2',decision:'accept'}),true)
  const resolution=(await b)!;assert.equal(host.consume(resolution),'accept');assert.equal(host.consume(resolution),'decline')
})


test('queued background approvals wait for their own card presentation',async()=>{
 const clock=new VirtualClock(0);let sequence=0
 const host=new HostApprovalController({clock,idFactory:()=>`r${++sequence}`})
 host.hold('background')
 const a=host.offer(offer,new AbortController().signal),b=host.offer(offer,new AbortController().signal)
 host.release('background')
 assert.equal(host.acceptDecision({approvalId:'r1',decision:'accept'}),true)
 host.consume((await a)!)
 clock.advanceTo(7200);await Promise.resolve()
 assert.equal(host.pending,true);assert.equal(host.view.pending_approval_id,'r2')
 assert.equal(host.release('background'),true)
 assert.equal(host.view.expires_at,7260)
 host.invalidate('test_cleanup');await b
})


test('foreground stops holding new offers but preserves unseen background entries',async()=>{
 const clock=new VirtualClock(0);let sequence=0
 const host=new HostApprovalController({clock,idFactory:()=>`r${++sequence}`})
 host.hold('background')
 host.release('background',{awaitPresentation:true})
 const a=host.offer(offer,new AbortController().signal)
 assert.equal(host.view.held,undefined)
 host.hold('background');host.release('background',{awaitPresentation:true})
 assert.equal(host.view.held,true)
 clock.advanceTo(7200);await Promise.resolve();assert.equal(host.pending,true)
 host.release('background');host.acceptDecision({approvalId:'r1',decision:'accept'});host.consume((await a)!)
 const b=host.offer(offer,new AbortController().signal)
 assert.equal(host.view.held,undefined)
 host.invalidate('cleanup');await b
})

test('a shared controller admits one extra head per phone executor without shrinking the coding cap', async () => {
  const clock = new VirtualClock(0)
  let n = 0
  const offer: ApprovalOffer = {kind: 'permissions', local_detail: {kind: 'permissions', scope: 'x'}, operation_summary: 'x'}
  for (const [capacity, admitted] of [[undefined, 3], [4, 4]] as const) {
    const controller = new HostApprovalController({clock, idFactory: () => `id-${++n}`, ...(capacity === undefined ? {} : {capacity})})
    const signal = new AbortController().signal
    const results = Array.from({length: 5}, (_, i) => controller.forWork({work_id: `w${i}`, project: 'p', title: 't'}).offer(offer, signal))
    await Promise.resolve()
    let declined = 0
    for (const result of results) {
      const settled = await Promise.race([result, new Promise<'pending'>(resolve => setImmediate(() => resolve('pending')))])
      if (settled !== 'pending' && settled?.decision === 'decline') declined++
    }
    assert.equal(5 - declined, admitted)
    for (let i = 0; i < 5; i++) controller.forWork({work_id: `w${i}`, project: 'p', title: 't'}).invalidate('test')
  }
})
