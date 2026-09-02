import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfirmationTurnIsolation } from '../src/realtime/confirmation-turn-isolation.js'

function begin(
  isolation: ConfirmationTurnIsolation<unknown>,
  overrides: Partial<{
    authorityId: string
    sessionEpoch: number
    createdUserRevision: number
    expiresAt: number
  }> = {},
) {
  return isolation.beginAuthority({
    authorityId: 'authority-1',
    sessionEpoch: 7,
    createdUserRevision: 10,
    expiresAt: 100,
    ...overrides,
  })
}

function reserve(isolation: ConfirmationTurnIsolation<unknown>, overrides: Partial<{
  sessionEpoch: number
  itemId: string
  userRevision: number
}> = {}) {
  return isolation.reserveUserItem({
    sessionEpoch: 7,
    itemId: 'user-item-1',
    userRevision: 11,
    ...overrides,
  })
}

test('instances keep authorities and reservations independent', () => {
  const first = new ConfirmationTurnIsolation<unknown>(2)
  const second = new ConfirmationTurnIsolation<unknown>(2)
  const input = {authorityId: 'authority-first', sessionEpoch: 1, createdUserRevision: 2, expiresAt: 50}

  const authority = first.beginAuthority(input)
  input.authorityId = 'mutated-after-begin'
  assert.equal(authority.authorityId, 'authority-first')
  assert.equal(Object.isFrozen(authority), true)
  assert.equal(first.reserveUserItem({sessionEpoch: 1, itemId: 'first-item', userRevision: 3}), 'reserved')
  assert.equal(second.authority, null)
  assert.equal(second.blocking.responseId, null)

  begin(second, {authorityId: 'authority-second'})
  assert.equal(reserve(second), 'reserved')
  assert.equal(first.reservation?.itemId, 'first-item')
  assert.equal(second.reservation?.itemId, 'user-item-1')
})

test('binds only the exact reserved item and retains a stable response binding', () => {
  const isolation = new ConfirmationTurnIsolation<string>(2)
  begin(isolation)
  reserve(isolation)

  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'other-item', userRevision: 11, responseId: 'response-1',
  }), 'stale')
  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 12, responseId: 'response-1',
  }), 'stale')
  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-1',
  }), 'bound')
  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-1',
  }), 'idempotent')
  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-2',
  }), 'stale')
  assert.deepEqual(isolation.blocking, {
    responseId: 'response-1', closing: false, quarantined: false, transcript: 'pending',
  })
})

test('binds an initial carrier and one exact retry carrier to the same reservation', () => {
  const isolation = new ConfirmationTurnIsolation<unknown>(4)
  begin(isolation)
  reserve(isolation)

  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-initial',
  }), 'bound')
  assert.equal(isolation.bindRetryResponse({
    sessionEpoch: 7, itemId: 'other-item', userRevision: 11, responseId: 'response-retry',
  }), 'stale')
  assert.equal(isolation.bindRetryResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 12, responseId: 'response-retry',
  }), 'stale')
  assert.equal(isolation.bindRetryResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-retry',
  }), 'bound')
  assert.equal(isolation.isAuthorizationCarrier({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-initial',
  }), true)
  assert.equal(isolation.isAuthorizationCarrier({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-retry',
  }), true)
  assert.equal(isolation.reservation?.responseId, 'response-initial')
})

test('tainted responses block independently but cannot become authorization carriers', () => {
  const isolation = new ConfirmationTurnIsolation<unknown>(4)
  begin(isolation)
  reserve(isolation)
  isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-carrier',
  })

  assert.equal(isolation.markBlockedResponse({
    sessionEpoch: 7, responseId: 'response-unrelated',
  }), 'tracked')
  assert.equal(isolation.isBlockedResponse({
    sessionEpoch: 7, responseId: 'response-unrelated',
  }), true)
  assert.equal(isolation.isAuthorizationCarrier({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-unrelated',
  }), false)
  assert.equal(isolation.markQuarantined({
    sessionEpoch: 7, responseId: 'response-unrelated',
  }), true)
  assert.equal(isolation.beginClosing({
    sessionEpoch: 7, responseId: 'response-unrelated',
  }), true)
  assert.deepEqual(isolation.responseState({
    sessionEpoch: 7, responseId: 'response-unrelated',
  }), {
    sessionEpoch: 7,
    responseId: 'response-unrelated',
    userRevision: null,
    authorizationCarrier: false,
    blocked: true,
    closing: true,
    quarantined: true,
    transcript: null,
  })
  assert.equal(isolation.clearResponse({
    sessionEpoch: 7, responseId: 'response-unrelated',
  }), true)
  assert.equal(isolation.responseState({
    sessionEpoch: 7, responseId: 'response-unrelated',
  }), null)
  assert.equal(isolation.reservation?.itemId, 'user-item-1')
  assert.equal(isolation.isAuthorizationCarrier({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-carrier',
  }), true)
})

test('reservation release retains bounded response cleanup state', () => {
  const isolation = new ConfirmationTurnIsolation<unknown>(2)
  begin(isolation)
  reserve(isolation)
  isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-carrier',
  })
  isolation.markBlockedResponse({sessionEpoch: 7, responseId: 'response-carrier'})
  isolation.markQuarantined({sessionEpoch: 7, responseId: 'response-carrier'})

  assert.equal(isolation.releaseReservation({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11,
  }), true)
  assert.equal(isolation.reservation, null)
  assert.equal(isolation.responseState({
    sessionEpoch: 7, responseId: 'response-carrier',
  })?.quarantined, true)
  assert.equal(isolation.clearQuarantined({
    sessionEpoch: 7, responseId: 'response-carrier',
  }), true)
  assert.equal(isolation.responseState({
    sessionEpoch: 7, responseId: 'response-carrier',
  })?.quarantined, false)
  assert.equal(reserve(isolation, {itemId: 'user-item-2', userRevision: 12}), 'reserved')
  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-2', userRevision: 12, responseId: 'response-next',
  }), 'bound')
})

test('carrier binding preserves prior taint and survives terminal cleanup while reserved', () => {
  const isolation = new ConfirmationTurnIsolation<unknown>(2)
  begin(isolation)
  reserve(isolation)
  isolation.markBlockedResponse({sessionEpoch: 7, responseId: 'response-carrier'})
  isolation.markQuarantined({sessionEpoch: 7, responseId: 'response-carrier'})

  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-carrier',
  }), 'bound')
  assert.equal(isolation.responseState({
    sessionEpoch: 7, responseId: 'response-carrier',
  })?.blocked, true)
  assert.equal(isolation.responseState({
    sessionEpoch: 7, responseId: 'response-carrier',
  })?.quarantined, true)

  assert.equal(isolation.clearResponse({
    sessionEpoch: 7, responseId: 'response-carrier',
  }), true)
  assert.equal(isolation.responseState({
    sessionEpoch: 7, responseId: 'response-carrier',
  }), null)
  assert.equal(isolation.isAuthorizationCarrier({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-carrier',
  }), true)
  assert.equal(isolation.reservation?.itemId, 'user-item-1')
})

test('defers a pre-binding call and releases it exactly once after the response binds', () => {
  const isolation = new ConfirmationTurnIsolation<{readonly callId: string}>(2)
  begin(isolation)
  reserve(isolation)
  const call = {callId: 'function-before-binding'}

  assert.equal(isolation.deferCall({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1', call,
  }), 'deferred')
  assert.deepEqual(isolation.releaseCallsForResponse({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1',
  }), [])
  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-1',
  }), 'bound')
  assert.deepEqual(isolation.releaseCallsForResponse({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1',
  }), [call])
  assert.deepEqual(isolation.releaseCallsForResponse({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1',
  }), [])
})

test('holds a post-authority response call until its exact user item is revealed', () => {
  const isolation = new ConfirmationTurnIsolation<{readonly callId: string}>(2)
  begin(isolation)
  const call = {callId: 'function-before-item'}

  assert.equal(isolation.deferCall({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1', call,
  }), 'deferred')
  assert.equal(isolation.deferCall({
    sessionEpoch: 7, userRevision: 10, responseId: 'stale-response', call,
  }), 'stale')
  assert.equal(isolation.reserveUserItem({
    sessionEpoch: 7, itemId: 'revealed-item', userRevision: 11,
  }), 'reserved')
  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'revealed-item', userRevision: 11, responseId: 'response-1',
  }), 'bound')
  assert.deepEqual(isolation.releaseCallsForResponse({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1',
  }), [call])
})

test('promotes one bounded final-only response after its next user item is revealed', () => {
  const isolation = new ConfirmationTurnIsolation<{readonly callId: string}>(2)
  begin(isolation)
  const call = {callId: 'function-before-final-only-transcript'}

  assert.equal(isolation.trackProvisionalResponse({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1',
  }), 'tracked')
  assert.equal(
    isolation.blockedResponses.find(response => response.responseId === 'response-1')?.userRevision,
    11,
  )
  assert.equal(isolation.deferProvisionalCall({
    sessionEpoch: 7, responseId: 'response-1', call,
  }), 'deferred')
  assert.equal(isolation.markProvisionalTerminal({
    sessionEpoch: 7, responseId: 'response-1',
  }), true)
  assert.equal(reserve(isolation), 'reserved')

  assert.deepEqual(isolation.bindProvisionalResponse(), {
    kind: 'bound', responseId: 'response-1', terminal: true,
  })
  assert.equal(isolation.isAuthorizationCarrier({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1',
  }), true)
  assert.deepEqual(isolation.releaseCallsForResponse({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1',
  }), [call])
})

test('ambiguous final-only responses never inherit one revealed user item', () => {
  const isolation = new ConfirmationTurnIsolation<string>(3)
  begin(isolation)
  for (const responseId of ['response-a', 'response-b']) {
    assert.equal(isolation.trackProvisionalResponse({
      sessionEpoch: 7, userRevision: 11, responseId,
    }), 'tracked')
    assert.equal(isolation.deferProvisionalCall({
      sessionEpoch: 7, responseId, call: responseId,
    }), 'deferred')
  }
  assert.equal(reserve(isolation), 'reserved')

  assert.deepEqual(isolation.bindProvisionalResponse(), {kind: 'ambiguous'})
  assert.deepEqual(isolation.takeAbandonedCalls().sort(), ['response-a', 'response-b'])
})

test('refuses deferred-call overflow without retaining the overflow call', () => {
  const isolation = new ConfirmationTurnIsolation<string>(1)
  begin(isolation)
  reserve(isolation)

  assert.equal(isolation.deferCall({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1', call: 'kept',
  }), 'deferred')
  assert.equal(isolation.deferCall({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1', call: 'discarded',
  }), 'overflow')
  isolation.bindResponse({sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-1'})
  assert.deepEqual(isolation.releaseCallsForResponse({sessionEpoch: 7, userRevision: 11, responseId: 'response-1'}), ['kept'])
})

test('a newer revision stales an old reservation before another item can reserve', () => {
  const isolation = new ConfirmationTurnIsolation<unknown>(2)
  begin(isolation)
  reserve(isolation)

  assert.equal(reserve(isolation, {itemId: 'user-item-2', userRevision: 12}), 'stale')
  assert.equal(isolation.reservation, null)
  assert.equal(reserve(isolation, {itemId: 'user-item-2', userRevision: 12}), 'reserved')
  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'old-response',
  }), 'stale')
})

test('closing and quarantine expose blocking without selecting confirmation policy', () => {
  const isolation = new ConfirmationTurnIsolation<unknown>(2)
  begin(isolation)
  reserve(isolation)
  isolation.bindResponse({sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-1'})

  assert.equal(isolation.beginClosing({sessionEpoch: 7, userRevision: 11, responseId: 'response-1'}), true)
  assert.equal(isolation.blocking.closing, true)
  assert.equal(isolation.endClosing({sessionEpoch: 7, userRevision: 11, responseId: 'wrong-response'}), false)
  assert.equal(isolation.markQuarantined({sessionEpoch: 7, userRevision: 11, responseId: 'response-1'}), true)
  assert.deepEqual(isolation.blocking, {
    responseId: 'response-1', closing: true, quarantined: true, transcript: 'pending',
  })
  assert.equal(isolation.endClosing({sessionEpoch: 7, userRevision: 11, responseId: 'response-1'}), true)
  assert.equal(isolation.blocking.closing, false)
  assert.equal(isolation.blocking.quarantined, true)
})

test('epoch invalidation clears all state for only its own instance', () => {
  const first = new ConfirmationTurnIsolation<string>(2)
  const second = new ConfirmationTurnIsolation<string>(2)
  begin(first)
  begin(second)
  reserve(first)
  reserve(second)
  first.deferCall({sessionEpoch: 7, userRevision: 11, responseId: 'response-1', call: 'deferred'})
  first.bindResponse({sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-1'})
  first.markQuarantined({sessionEpoch: 7, userRevision: 11, responseId: 'response-1'})

  assert.equal(first.invalidate(), true)
  assert.equal(first.authority, null)
  assert.equal(first.reservation, null)
  assert.deepEqual(first.blocking, {
    responseId: null, closing: false, quarantined: false, transcript: null,
  })
  assert.equal(first.releaseCallsForResponse({sessionEpoch: 7, userRevision: 11, responseId: 'response-1'}).length, 0)
  assert.equal(second.authority?.authorityId, 'authority-1')
  assert.equal(second.reservation?.itemId, 'user-item-1')
})

test('transcript completion and failure remain text-free correlation metadata', () => {
  const isolation = new ConfirmationTurnIsolation<unknown>(2)
  begin(isolation)
  reserve(isolation)
  isolation.bindResponse({sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-1'})

  assert.equal(isolation.markResponse({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1', transcript: 'completed',
  }), true)
  assert.equal(isolation.blocking.transcript, 'completed')
  assert.equal(isolation.markResponse({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1', transcript: 'failed',
  }), true)
  assert.equal(isolation.blocking.transcript, 'failed')
  assert.equal(isolation.reservation?.itemId, 'user-item-1')
  assert.equal(JSON.stringify(isolation.blocking).includes('transcript text'), false)
})

test('applies pre-binding transcript completion to the exact later response', () => {
  const isolation = new ConfirmationTurnIsolation<unknown>(2)
  begin(isolation)
  reserve(isolation)

  assert.equal(isolation.markResponse({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1', transcript: 'completed',
  }), true)
  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-1',
  }), 'bound')
  assert.equal(isolation.blocking.transcript, 'completed')
  assert.equal(isolation.reservation?.itemId, 'user-item-1')
})

test('applies pre-binding transcript failure without releasing the reservation', () => {
  const isolation = new ConfirmationTurnIsolation<unknown>(2)
  begin(isolation)
  reserve(isolation)

  assert.equal(isolation.markResponse({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-1', transcript: 'failed',
  }), true)
  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-1',
  }), 'bound')
  assert.equal(isolation.blocking.transcript, 'failed')
  assert.equal(isolation.reservation?.responseId, 'response-1')
})

test('binding a later response drops deferred calls for losing response identities', () => {
  const isolation = new ConfirmationTurnIsolation<string>(2)
  begin(isolation)
  reserve(isolation)
  isolation.deferCall({sessionEpoch: 7, userRevision: 11, responseId: 'response-a', call: 'drop'})
  isolation.deferCall({sessionEpoch: 7, userRevision: 11, responseId: 'response-b', call: 'release'})

  assert.equal(isolation.bindResponse({
    sessionEpoch: 7, itemId: 'user-item-1', userRevision: 11, responseId: 'response-b',
  }), 'bound')
  const observed = isolation as ConfirmationTurnIsolation<string> & {readonly deferredCallCount: number}
  assert.equal(observed.deferredCallCount, 1)
  assert.deepEqual(isolation.releaseCallsForResponse({
    sessionEpoch: 7, userRevision: 11, responseId: 'response-b',
  }), ['release'])
  assert.equal(observed.deferredCallCount, 0)
})

test('rejects malformed authority identities and nonpositive deferred bounds', () => {
  assert.throws(() => new ConfirmationTurnIsolation<unknown>(0), /positive integer/u)
  const isolation = new ConfirmationTurnIsolation<unknown>(1)
  assert.throws(() => begin(isolation, {authorityId: '', expiresAt: Number.POSITIVE_INFINITY}), /authority/u)
})
