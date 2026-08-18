const LABELS = Object.freeze({
  booting: 'Nova Audio Agent 正在启动',
  inactive: '语音未启用',
  idle: '语音已启用，等待输入',
  candidate: '检测到可能的语音',
  listening: '正在聆听',
  speaking: 'Nova Audio Agent 正在说话',
  interrupted: '播放已中断，正在聆听',
  'permission-denied': '麦克风权限被拒绝',
  disconnected: 'Nova Audio Agent 已断开',
  error: 'Nova Audio Agent 发生错误',
})

// The single source of truth for the `data-state` vocabulary: the visual layer
// derives its per-state parameters from this list rather than restating it.
export const ORB_STATE_NAMES = Object.freeze(Object.keys(LABELS))

// Windows has no systemPreferences prompt to point users at, so the denied
// label carries its own navigation hint there; other platforms keep the
// shorter copy above.
const WINDOWS_PERMISSION_DENIED_LABEL =
  '麦克风权限被拒绝(请在 系统设置 → 隐私 → 麦克风 中允许桌面应用)'

export function deriveOrbState(input) {
  let name
  if (input.error) name = 'error'
  // A renderer that has not finished bootstrapping has not connected yet
  // either, so plain "disconnected wins" made 'booting' unreachable at the one
  // moment it describes. Booting only shields the socket axis: an error still
  // outranks it, and a disconnect that lands after boot still collapses.
  else if (!input.connected && !input.booting) name = 'disconnected'
  else if (input.permission === 'denied') name = 'permission-denied'
  else if (input.booting) name = 'booting'
  else if (!input.activated) name = 'inactive'
  else if (input.capture === 'listening') name = 'listening'
  else if (input.capture === 'candidate') name = 'candidate'
  else if (input.playback === 'interrupted') name = 'interrupted'
  else if (input.playback === 'speaking') name = 'speaking'
  else name = 'idle'
  const label = name === 'permission-denied' && input.platform === 'win32'
    ? WINDOWS_PERMISSION_DENIED_LABEL
    : LABELS[name]
  return Object.freeze({
    name,
    label,
    codexLabel: input.codex === 'working' ? 'Codex 正在后台工作' : 'Codex 空闲',
    aecLabel: input.audioMode === 'voice_processing_io'
      ? '系统级 AEC'
      : input.audioMode === 'browser_aec'
        ? '浏览器 AEC'
        : 'AEC 未启用',
    shellExpanded: input.shellExpanded === true,
  })
}
