import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveOrbState } from '../src/renderer/state.mjs'

const base = {
  booting: false,
  activated: true,
  capture: 'idle',
  playback: 'idle',
  codex: 'idle',
  connected: true,
  permission: 'granted',
  error: '',
  shellExpanded: false,
  audioMode: 'voice_processing_io',
}

test('keeps capture playback codex and shell as independent axes', () => {
  const state = deriveOrbState({
    ...base,
    capture: 'listening',
    codex: 'working',
    shellExpanded: true,
  })

  assert.equal(state.name, 'listening')
  assert.match(state.label, /正在聆听/)
  assert.equal(state.codexLabel, 'Codex 正在后台工作')
  assert.equal(state.shellExpanded, true)
  assert.equal(state.aecLabel, '系统级 AEC')
})

test('labels the browser AEC path without implying it is a fallback', () => {
  const state = deriveOrbState({ ...base, audioMode: 'browser_aec' })

  assert.equal(state.aecLabel, '浏览器 AEC')
})

test('provides stable accessible labels for permission disconnect and interruption', () => {
  assert.equal(deriveOrbState({ ...base, permission: 'denied' }).name, 'permission-denied')
  assert.equal(deriveOrbState({ ...base, connected: false }).name, 'disconnected')
  assert.equal(deriveOrbState({ ...base, playback: 'interrupted' }).name, 'interrupted')
  assert.ok(deriveOrbState({ ...base, playback: 'speaking' }).label)
})

test('does not claim an AEC implementation before microphone activation', () => {
  const state = deriveOrbState({
    ...base,
    activated: false,
    audioMode: 'inactive',
  })

  assert.equal(state.aecLabel, 'AEC 未启用')
})
