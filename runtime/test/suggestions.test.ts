import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SuggestionPool, isSuggestionAvailable } from '../src/suggestions.js'

test('the pool owns stable insertion-order suggestion ids and content copies', () => {
  const content = {text: 'door is open'}
  const pool = new SuggestionPool()
  const first = pool.add({origin: 'fast_brain', kind: 'notify', content})
  const second = pool.add({origin: 'surrogate', kind: 'question', content: {text: 'close it?'}})
  content.text = 'mutated'

  assert.deepEqual(pool.all().map(item => item.id), ['s-1', 's-2'])
  assert.deepEqual(first.content, {text: 'door is open'})
  assert.equal(second.status, 'pending')
  assert.equal(isSuggestionAvailable(first, 0), true)
})

test('fire locks once and cooldown alone never rearms', () => {
  const pool = new SuggestionPool()
  const suggestion = pool.add({
    origin: 'executor',
    kind: 'notify',
    content: {text: 'still open'},
    evidence_refs: ['watch:1'],
  })
  pool.fire(suggestion.id, 100, 60)
  pool.fire(suggestion.id, 130, 60)

  assert.equal(pool.get(suggestion.id)?.cooldown_until, 160)
  assert.equal(isSuggestionAvailable(pool.get(suggestion.id)!, 10_000), false)
})

test('rearm requires both elapsed cooldown and fresh evidence on the exact channel', () => {
  const pool = new SuggestionPool()
  const suggestion = pool.add({
    origin: 'executor',
    kind: 'notify',
    content: {text: 'still open'},
    evidence_refs: ['slow_sim:1'],
  })
  pool.fire(suggestion.id, 0, 60)

  pool.rearmFrom('slow_sim', 30)
  pool.rearmFrom('slow', 70)
  assert.equal(pool.get(suggestion.id)?.status, 'fired')

  pool.rearmFrom('slow_sim', 70)
  assert.equal(pool.get(suggestion.id)?.status, 'pending')
})

test('withdraw changes only a pending suggestion and expiry is lazy', () => {
  const pool = new SuggestionPool()
  const pending = pool.add({origin: 'executor', kind: 'notify', content: {text: 'old'}})
  const fired = pool.add({origin: 'executor', kind: 'notify', content: {text: 'said'}})
  const stale = pool.add({
    origin: 'executor',
    kind: 'notify',
    content: {text: 'expired'},
    expires_at: 5,
  })
  pool.fire(fired.id, 0)

  assert.equal(pool.withdraw(pending.id), true)
  assert.equal(pool.withdraw(fired.id), false)
  assert.equal(isSuggestionAvailable(stale, 10), false)
})
