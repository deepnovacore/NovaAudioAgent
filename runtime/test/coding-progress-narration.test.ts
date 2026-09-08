import assert from 'node:assert/strict'
import test from 'node:test'
import {CodingProgressNarrationState} from '../src/coding-progress-narration.js'
import {settingsSchema} from '../src/config.js'

test('coding narration defaults to smart and switches only coding progress routing', () => {
  assert.equal(settingsSchema.parse({executors: []}).coding_progress_narration, 'smart')
  const state = new CodingProgressNarrationState()
  assert.equal(state.viaSurrogate(true, true), true)
  state.setMode('continuous')
  assert.equal(state.viaSurrogate(true, true), false)
  assert.equal(state.viaSurrogate(false, true), true, 'non-coding channels keep policy')
  state.setMode('smart')
  assert.equal(state.viaSurrogate(true, true), true)
})
