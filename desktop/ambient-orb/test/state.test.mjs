import assert from 'node:assert/strict'
import test from 'node:test'

import * as orbState from '../src/renderer/state.mjs'

const { compactOrbLabel, deriveOrbState, ORB_STATE_NAMES } = orbState

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
  pendingAction: null,
  pendingWorkspace: '',
  pendingSession: '',
  pendingExpiresInSeconds: null,
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

  const waiting = deriveOrbState({
    ...base,
    pendingConfirmation: true,
    pendingAction: 'create_workspace',
    pendingWorkspace: 'tetris-game',
    pendingExpiresInSeconds: 89.25,
  })
  assert.equal(waiting.statusLine, '需要你的确认')
  assert.equal(
    waiting.codexLabel,
    '创建工作区 “tetris-game”\n尚未执行 · 90 秒后自动取消',
  )
  assert.equal(waiting.confirmationVisible, true)
})

test('describes workspace reuse as reuse rather than creation', () => {
  const waiting = deriveOrbState({
    ...base,
    pendingConfirmation: true,
    pendingAction: 'reuse_workspace',
    pendingWorkspace: 'timer-app',
    pendingSession: 'Initial',
    pendingExpiresInSeconds: 360,
  })

  assert.equal(
    waiting.codexLabel,
    '使用现有工作区 “timer-app”并开始任务\n尚未执行 · 360 秒后自动取消',
  )
  assert.doesNotMatch(waiting.codexLabel, /创建/u)
})

test('explains incomplete configuration on the visible status line', () => {
  const state = deriveOrbState({ ...base, backendState: 'configuration_required' })

  assert.equal(state.statusLine, '配置不完整 · Codex 空闲')
})

test('uses a readable fallback instead of leaking undefined for a future state', () => {
  assert.equal(compactOrbLabel('future-state'), '状态异常')
})

// The compact line is the only status text the transparent orb still shows, so
// every state in the `data-state` vocabulary needs its own compact label.
test('every orb state carries a compact label on the one visible status line', () => {
  const inputs = {
    booting: { ...base, booting: true, connected: false },
    inactive: { ...base, activated: false },
    idle: base,
    candidate: { ...base, capture: 'candidate' },
    listening: { ...base, capture: 'listening' },
    speaking: { ...base, playback: 'speaking' },
    interrupted: { ...base, playback: 'interrupted' },
    muted: { ...base, muted: true },
    'permission-denied': { ...base, microphone: 'permission_denied' },
    'microphone-restricted': { ...base, microphone: 'restricted' },
    'microphone-no-device': { ...base, microphone: 'no_input_device' },
    'microphone-busy': { ...base, microphone: 'device_busy' },
    'microphone-unavailable': { ...base, microphone: 'capture_unavailable' },
    'audio-pipeline-error': { ...base, microphone: 'audio_pipeline_error' },
    disconnected: { ...base, connected: false },
    reconnecting: { ...base, backendState: 'reconnecting' },
    'configuration-required': { ...base, backendState: 'configuration_required' },
    'authentication-failed': { ...base, backendState: 'authentication_failed' },
    'backend-unavailable': { ...base, backendState: 'unavailable' },
    error: { ...base, error: 'boom' },
  }

  assert.deepEqual(Object.keys(inputs).sort(), [...ORB_STATE_NAMES].sort())
  for (const name of ORB_STATE_NAMES) {
    const state = deriveOrbState(inputs[name])
    assert.equal(state.name, name, `${name} must be reachable`)
    assert.doesNotMatch(state.statusLine, /undefined/u, `${name} needs a compact label`)
    assert.match(state.statusLine, /^\S.* · Codex /u, `${name} statusLine shape`)
  }
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

test('muted outranks capture and playback but never faults', () => {
  // The mic being off is the state the user acted on: it wins over anything
  // the (now silent) capture or the still-audible playback would show.
  assert.equal(deriveOrbState({ ...base, muted: true }).name, 'muted')
  assert.equal(deriveOrbState({ ...base, muted: true, capture: 'listening' }).name, 'muted')
  assert.equal(deriveOrbState({ ...base, muted: true, playback: 'speaking' }).name, 'muted')
  assert.match(deriveOrbState({ ...base, muted: true }).label, /已闭麦/)
  // Faults and errors still outrank a deliberate mute; inactive means there is
  // nothing to mute.
  assert.equal(deriveOrbState({ ...base, muted: true, error: 'boom' }).name, 'error')
  assert.equal(deriveOrbState({ ...base, muted: true, connected: false }).name, 'disconnected')
  assert.equal(deriveOrbState({ ...base, muted: true, activated: false }).name, 'inactive')
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
    pendingAction: 'resume_session',
    pendingWorkspace: 'beta',
    pendingSession: 'Task 2',
    pendingExpiresInSeconds: 40,
  })

  assert.equal(state.codexLabel, '恢复 “beta / Task 2”\n尚未执行 · 40 秒后自动取消')
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
