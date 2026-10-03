import assert from 'node:assert/strict'
import test from 'node:test'
import {describeStartupError} from '../src/desktop/startup-error.js'

test('startup error text keeps name, code and message on one line', () => {
  const error = Object.assign(new Error('boom\nsecond line'), {code: 'ENOENT'})
  assert.equal(describeStartupError(error, '/Users/someone'), 'Error [ENOENT]: boom second line')
})

test('startup error text replaces the home directory and token-like strings', () => {
  const error = new Error(`open /Users/someone/.nova-audio-agent/x.jsonl failed; Bearer abc.def key sk-${'a1'.repeat(20)} https://h/x?token=hunter2&y=1`)
  const text = describeStartupError(error, '/Users/someone')
  assert.ok(text.includes('~/.nova-audio-agent/x.jsonl'))
  assert.ok(!text.includes('/Users/someone'))
  assert.ok(!text.includes('abc.def'))
  assert.ok(!text.includes('a1a1a1a1'))
  assert.ok(!text.includes('hunter2'))
})

test('startup error text is capped and tolerates non-error values', () => {
  assert.equal(describeStartupError(new Error('word '.repeat(200)), '/h').length, 296)
  assert.equal(describeStartupError('plain', '/h'), 'string')
})
