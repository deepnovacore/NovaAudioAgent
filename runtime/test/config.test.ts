import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ConfigurationError,
  loadSettings,
  resolveProactivity,
} from '../src/config.js'

test('backend defaults to Python and supports the explicit Node development switch', () => {
  assert.equal(loadSettings({}).backend, 'python')
  assert.equal(loadSettings({NOVA_AUDIO_AGENT_BACKEND: 'node'}).backend, 'node')
})

test('proactivity presets and individual overrides preserve the Python table', () => {
  assert.deepEqual(
    resolveProactivity(loadSettings({NOVA_AUDIO_AGENT_PROACTIVITY_PRESET: 'conservative'})),
    {cooldown: 120, fresh_window: 20},
  )
  assert.deepEqual(resolveProactivity(loadSettings({
    NOVA_AUDIO_AGENT_PROACTIVITY_PRESET: 'eager',
    NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN: '5',
  })), {cooldown: 5, fresh_window: 45})
})

test('numeric overrides reject negative, non-finite, and out-of-range values', () => {
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN: '-1'}),
    ConfigurationError,
  )
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_FRESH_WINDOW: 'NaN'}),
    /NOVA_AUDIO_AGENT_FRESH_WINDOW/u,
  )
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL: '601'}),
    ConfigurationError,
  )
})

test('executor list is trimmed, ordered, unique, and non-empty', () => {
  assert.deepEqual(loadSettings({NOVA_AUDIO_AGENT_EXECUTORS: ' slow_sim , codex '}).executors, [
    'slow_sim',
    'codex',
  ])
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_EXECUTORS: 'codex,,slow_sim'}),
    /empty name/u,
  )
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_EXECUTORS: 'codex,codex'}),
    /duplicate/u,
  )
})

test('retired executors return explicit removal errors', () => {
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_EXECUTOR: 'ha'}),
    /was removed/u,
  )
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_EXECUTORS: 'codex,autoglm'}),
    /was removed/u,
  )
})

test('configuration failures never echo secret values', () => {
  const secret = 'never-echo-this-secret'
  let message = ''
  try {
    loadSettings({
      NOVA_AUDIO_AGENT_MODEL_API_KEY: secret,
      NOVA_AUDIO_AGENT_BACKEND: 'invalid',
    })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.equal(message.includes(secret), false)
  assert.match(message, /BACKEND/u)
})
