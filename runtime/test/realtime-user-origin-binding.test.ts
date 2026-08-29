import assert from 'node:assert/strict'
import test from 'node:test'

import {UserOriginBindingLedger} from '../src/realtime/user-origin-binding.js'

test('origin ledger binds responses by epoch and exact user revision', () => {
  const ledger = new UserOriginBindingLedger(8)
  ledger.beginEpoch(1)
  assert.equal(ledger.registerUserItem({epoch: 1, revision: 1, itemId: 'orphan'}), true)
  assert.equal(ledger.registerUserItem({epoch: 1, revision: 2, itemId: 'current'}), true)

  assert.deepEqual(ledger.bindResponse({epoch: 1, revision: 2, responseId: 'response'}), {
    status: 'bound', item_id: 'current', revision: 2,
  })
  assert.equal(ledger.itemForResponse(1, 'response'), 'current')
  assert.equal(ledger.revisionForItem(1, 'current'), 2)
  assert.equal(ledger.unboundCount, 1)
  assert.equal(
    ledger.bindResponse({epoch: 1, revision: 1, responseId: 'late-response'}).status,
    'bound',
    'the old item is usable only by a response that itself captured the old revision',
  )
})

test('origin ledger fails closed for old epochs, missing items and failed transcripts', () => {
  const ledger = new UserOriginBindingLedger(8)
  ledger.beginEpoch(2)
  ledger.registerUserItem({epoch: 2, revision: 1, itemId: 'failed-item'})
  assert.equal(ledger.failTranscript(2, 'failed-item'), true)
  assert.equal(
    ledger.bindResponse({epoch: 2, revision: 1, responseId: 'failed-response'}).status,
    'missing_item',
  )
  assert.equal(
    ledger.bindResponse({epoch: 1, revision: 1, responseId: 'old-response'}).status,
    'epoch_mismatch',
  )
  assert.equal(
    ledger.bindResponse({epoch: 2, revision: 99, responseId: 'missing-response'}).status,
    'missing_item',
  )
})

test('confirmation retry reuses only the resolved reserved provider item', () => {
  const ledger = new UserOriginBindingLedger(8)
  ledger.beginEpoch(1)
  ledger.registerUserItem({epoch: 1, revision: 1, itemId: 'reserved'})
  ledger.bindResponse({epoch: 1, revision: 1, responseId: 'source'})
  assert.equal(
    ledger.bindRetryResponse({epoch: 1, responseId: 'retry-before-asr', itemId: 'reserved'}),
    false,
  )
  assert.equal(ledger.resolveTranscript({
    epoch: 1, itemId: 'reserved', originRef: 'conversation:10',
  }), true)
  assert.equal(
    ledger.bindRetryResponse({epoch: 1, responseId: 'retry', itemId: 'reserved'}),
    true,
  )
  assert.equal(ledger.itemForResponse(1, 'retry'), 'reserved')
  assert.equal(
    ledger.bindRetryResponse({epoch: 1, responseId: 'wrong', itemId: 'missing'}),
    false,
  )
})

test('origin ledger evicts oldest item and every response edge at its bound', () => {
  const ledger = new UserOriginBindingLedger(2)
  ledger.beginEpoch(1)
  for (const revision of [1, 2, 3]) {
    ledger.registerUserItem({epoch: 1, revision, itemId: `item-${revision}`})
    ledger.bindResponse({epoch: 1, revision, responseId: `response-${revision}`})
  }
  assert.equal(ledger.itemForResponse(1, 'response-1'), undefined)
  assert.deepEqual(ledger.boundResponses, [
    ['1:response-2', 'item-2'],
    ['1:response-3', 'item-3'],
  ])
})
