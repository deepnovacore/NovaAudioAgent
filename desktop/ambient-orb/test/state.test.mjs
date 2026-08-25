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
  workspace: '',
  session: '',
  pendingConfirmation: false,
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

test('projects voice and Codex state into one compact visible line', () => {
  const state = deriveOrbState({
    ...base,
    capture: 'listening',
    codex: 'working',
    workspace: 'alpha',
    session: 'Task 1',
  })

  assert.equal(state.statusLine, '聆听中 · Codex 工作中')
  assert.doesNotMatch(state.statusLine, /工作区|Session|AEC/u)

  const waiting = deriveOrbState({ ...base, pendingConfirmation: true })
  assert.equal(waiting.statusLine, '待命 · Codex 等待确认')
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

test('keeps microphone recovery states distinct and actionable', () => {
  for (const [microphone, name, copy] of [
    ['permission_denied', 'permission-denied', /权限被拒绝/],
    ['restricted', 'microphone-restricted', /系统策略/],
    ['no_input_device', 'microphone-no-device', /未检测到/],
    ['device_busy', 'microphone-busy', /占用/],
    ['capture_unavailable', 'microphone-unavailable', /不可用/],
    ['audio_pipeline_error', 'audio-pipeline-error', /音频管线/],
  ]) {
    const state = deriveOrbState({ ...base, microphone })
    assert.equal(state.name, name, microphone)
    assert.match(state.label, copy, microphone)
  }
})

test('shows booting until the first connection instead of an immediate disconnect', () => {
  // The renderer's axes start out booting with connected=false, so a plain
  // "disconnected wins" precedence made 'booting' unreachable: the very first
  // frames have to read as an agent starting up, not as one that already died.
  assert.equal(deriveOrbState({ ...base, booting: true, connected: false }).name, 'booting')
  assert.match(deriveOrbState({ ...base, booting: true, connected: false }).label, /正在启动/)

  // A disconnect that lands after boot still collapses the orb.
  assert.equal(deriveOrbState({ ...base, connected: false }).name, 'disconnected')

  // A failed bootstrap is an error, not a boot still in progress.
  assert.equal(
    deriveOrbState({ ...base, booting: true, connected: false, error: 'bootstrap' }).name,
    'error',
  )
})

test('derives candidate from the onset attack window', () => {
  const candidate = deriveOrbState({ ...base, capture: 'candidate' })

  assert.equal(candidate.name, 'candidate')
  assert.match(candidate.label, /检测到可能的语音/)
  // A confirmed onset outranks the attack window it grew out of.
  assert.equal(deriveOrbState({ ...base, capture: 'listening' }).name, 'listening')
})

test('does not claim an AEC implementation before microphone activation', () => {
  const state = deriveOrbState({
    ...base,
    activated: false,
    audioMode: 'inactive',
  })

  assert.equal(state.aecLabel, 'AEC 未启用')
})

test('backend terminal and reconnecting states remain distinguishable', () => {
  const base = {
    booting: false, connected: false, permission: 'granted', activated: false,
    capture: 'idle', playback: 'idle', codex: 'idle', workspace: '', session: '',
    pendingConfirmation: false, error: '', audioMode: 'inactive', shellExpanded: false,
  }
  assert.equal(deriveOrbState({...base, backendState: 'reconnecting'}).name, 'reconnecting')
  assert.equal(deriveOrbState({...base, backendState: 'configuration_required'}).name, 'configuration-required')
  assert.equal(deriveOrbState({...base, backendState: 'authentication_failed'}).name, 'authentication-failed')
  assert.equal(deriveOrbState({...base, backendState: 'unavailable'}).name, 'backend-unavailable')
})

test('projects only public workspace session and confirmation into the Codex label', () => {
  const state = deriveOrbState({
    ...base,
    workspace: 'alpha',
    session: 'Task 1',
    pendingConfirmation: true,
  })

  assert.equal(state.codexLabel, '工作区 alpha · Session Task 1 · 等待确认 · Codex 空闲')
})

test('adds a Windows-specific hint to the permission-denied label', () => {
  const state = deriveOrbState({ ...base, permission: 'denied', platform: 'win32' })

  assert.equal(state.name, 'permission-denied')
  assert.equal(
    state.label,
    '麦克风权限被拒绝(请在 系统设置 → 隐私 → 麦克风 中允许桌面应用)',
  )
})

test('keeps the shorter permission-denied label on non-Windows platforms', () => {
  const darwin = deriveOrbState({ ...base, permission: 'denied', platform: 'darwin' })
  const unspecified = deriveOrbState({ ...base, permission: 'denied' })

  assert.equal(darwin.label, '麦克风权限被拒绝')
  assert.equal(unspecified.label, '麦克风权限被拒绝')
})
