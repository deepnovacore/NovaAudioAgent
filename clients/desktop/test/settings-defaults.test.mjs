import assert from 'node:assert/strict'
import test from 'node:test'
import {RUNTIME_DEFAULTS} from '../src/main/settings-defaults.mjs'
import {DEFAULT_SETTINGS} from '../src/main/settings-store.mjs'

test('settings-store defaults include every runtime default unchanged', () => {
  for (const [key, value] of Object.entries(RUNTIME_DEFAULTS)) assert.deepEqual(DEFAULT_SETTINGS[key], value, key)
})
