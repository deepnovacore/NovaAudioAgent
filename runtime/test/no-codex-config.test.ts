import assert from 'node:assert/strict'
import {test} from 'node:test'

import {loadSettings} from '../src/config.js'

test('sim-only settings ignore codex env vars instead of failing parse', () => {
  assert.doesNotThrow(() => loadSettings({
    NOVA_AUDIO_AGENT_EXECUTORS: 'slow_sim',
    NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL: '\u001c5\u0085',
    NOVA_AUDIO_AGENT_CODEX_APPROVAL_MODE: 'yolo',
  }))
  const settings = loadSettings({
    NOVA_AUDIO_AGENT_EXECUTORS: 'slow_sim',
    NOVA_AUDIO_AGENT_CODEX_APPROVAL_MODE: 'yolo',
  })
  assert.equal(settings.codex_approval_mode, 'ask')
  assert.equal(settings.codex_working_interval, 30)
})
