import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Floor } from '../src/floor.js'
import { USER_PRIORITY } from '../src/memory.js'

test('idle allows, user speech defers, and agent speech requires higher priority', () => {
  assert.equal(new Floor().decide(1), 'allow')
  assert.equal(new Floor({state: 'user_speaking'}).decide(USER_PRIORITY + 1), 'defer')

  const speaking = new Floor().onSpeakStart('u-1', 50)
  assert.equal(speaking.decide(100), 'preempt')
  assert.equal(speaking.decide(50), 'defer')
  assert.equal(speaking.decide(10), 'defer')
})

test('only the active utterance or user speech can release the floor', () => {
  const preempted = new Floor().onSpeakStart('u-1', 50).onSpeakStart('u-2', 100)
  assert.equal(preempted.onSpeakEnd('u-1'), preempted)
  assert.equal(preempted.onSpeakEnd('u-2').state, 'idle')

  const user = preempted.onUserSpeakStart('speech-user')
  assert.equal(user.onSpeakEnd('u-2'), user)
  assert.equal(user.onUserSpeakEnd('speech-other'), user)
  assert.equal(user.onUserSpeakEnd('speech-user').state, 'idle')
})
