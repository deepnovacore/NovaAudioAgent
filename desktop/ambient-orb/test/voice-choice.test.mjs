import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CUSTOM_VOICE_VALUE,
  QWEN_VOICES,
  VOLCENGINE_TTS_VOICES,
  resolveVoiceChoice,
} from '../src/renderer/voice-choice.mjs'

test('a known voice stays selected without inventing a custom draft', () => {
  assert.deepEqual(resolveVoiceChoice('longanlingxi', QWEN_VOICES), {
    selected: 'longanlingxi',
    custom: '',
  })
})

test('an unknown cloned voice is exposed as a custom value unchanged', () => {
  assert.deepEqual(
    resolveVoiceChoice('qwen-audio-3.0-realtime-plus-myvoice-a1b2', QWEN_VOICES),
    {
      selected: CUSTOM_VOICE_VALUE,
      custom: 'qwen-audio-3.0-realtime-plus-myvoice-a1b2',
    },
  )
})

test('an empty stored voice remains editable rather than selecting a false preset', () => {
  assert.deepEqual(resolveVoiceChoice('', VOLCENGINE_TTS_VOICES), {
    selected: CUSTOM_VOICE_VALUE,
    custom: '',
  })
})

test('the preset catalogs contain the supported Qwen systems and current TTS default', () => {
  assert.deepEqual(QWEN_VOICES.map(voice => voice.value), [
    'longanqian',
    'longanlingxin',
    'longanlingxi',
    'longanxiaoxin',
    'longanlufeng',
  ])
  assert.equal(VOLCENGINE_TTS_VOICES[0].value, 'zh_female_vv_uranus_bigtts')
})
