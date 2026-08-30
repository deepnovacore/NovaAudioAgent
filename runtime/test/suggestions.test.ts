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
  assert.equal(first.delivery_policy, 'once')
  assert.equal(first.condition_key, null)
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

  assert.equal(pool.get(suggestion.id)?.cooldown_until, 0)
  assert.equal(isSuggestionAvailable(pool.get(suggestion.id)!, 10_000), false)
})

test('once suggestions never rearm from later evidence', () => {
  const pool = new SuggestionPool()
  const suggestion = pool.add({
    origin: 'executor',
    kind: 'notify',
    content: {text: 'root cause found'},
    evidence_refs: ['codex:1'],
  })
  pool.fire(suggestion.id, 0, 60)

  assert.equal(pool.refreshCondition({
    condition_key: 'codex:progress',
    now: 70,
    evidence_ref: 'codex:2',
    content: {text: 'another file changed'},
  }), false)
  assert.equal(pool.get(suggestion.id)?.status, 'fired')
})

test('a persistent condition rearms only for the same key with fresh evidence after cooldown', () => {
  const pool = new SuggestionPool()
  const suggestion = pool.add({
    origin: 'executor',
    kind: 'notify',
    content: {text: 'door is open'},
    evidence_refs: ['watch:1'],
    delivery_policy: 'while_condition_true',
    condition_key: 'watch:door_open',
  })
  pool.fire(suggestion.id, 0, 60)

  assert.equal(pool.refreshCondition({
    condition_key: 'watch:window_motion',
    now: 70,
    evidence_ref: 'watch:2',
    content: {text: 'window moved'},
  }), false)
  assert.equal(pool.refreshCondition({
    condition_key: 'watch:door_open',
    now: 30,
    evidence_ref: 'watch:2',
    content: {text: 'door remains open'},
  }), false)
  assert.equal(pool.refreshCondition({
    condition_key: 'watch:door_open',
    now: 70,
    evidence_ref: 'watch:1',
    content: {text: 'door remains open'},
  }), false, 'the evidence ref must advance')

  assert.equal(pool.refreshCondition({
    condition_key: 'watch:door_open',
    now: 70,
    evidence_ref: 'watch:3',
    content: {text: 'door remains open'},
  }), true)
  assert.equal(pool.get(suggestion.id)?.status, 'pending')
  assert.deepEqual(pool.get(suggestion.id)?.evidence_refs, ['watch:3'])
  assert.deepEqual(pool.get(suggestion.id)?.content, {text: 'door remains open'})

  pool.fire(suggestion.id, 70, 60)
  assert.equal(pool.refreshCondition({
    condition_key: 'watch:door_open',
    now: 140,
    evidence_ref: 'watch:1',
    content: {text: 'stale door evidence replayed'},
  }), false, 'an older evidence ref cannot be replayed later in the same episode')
  assert.equal(pool.get(suggestion.id)?.status, 'fired')
})

test('clearing a persistent condition permanently withdraws its current episode', () => {
  const pool = new SuggestionPool()
  const suggestion = pool.add({
    origin: 'executor',
    kind: 'notify',
    content: {text: 'kettle is boiling'},
    evidence_refs: ['watch:1'],
    delivery_policy: 'while_condition_true',
    condition_key: 'watch:kettle_boiling',
  })
  pool.fire(suggestion.id, 0, 60)

  assert.equal(pool.clearCondition('watch:kettle_boiling'), true)
  assert.equal(pool.get(suggestion.id)?.status, 'withdrawn')
  assert.equal(pool.refreshCondition({
    condition_key: 'watch:kettle_boiling',
    now: 70,
    evidence_ref: 'watch:2',
    content: {text: 'kettle is still boiling'},
  }), false)
})

test('persistent delivery requires a stable condition key', () => {
  const pool = new SuggestionPool()
  assert.throws(() => pool.add({
    origin: 'executor',
    kind: 'notify',
    content: {text: 'still open'},
    delivery_policy: 'while_condition_true',
  } as never), /condition key/u)
  assert.throws(() => pool.add({
    origin: 'executor',
    kind: 'notify',
    content: {text: 'one-time fact'},
    delivery_policy: 'once',
    condition_key: 'not-valid-for-once',
  }), /once delivery/u)
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
