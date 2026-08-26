const LABELS = Object.freeze({
  booting: 'Nova Audio Agent 正在启动',
  inactive: '语音未启用',
  idle: '语音已启用，等待输入',
  candidate: '检测到可能的语音',
  listening: '正在聆听',
  speaking: 'Nova Audio Agent 正在说话',
  interrupted: '播放已中断，正在聆听',
  muted: '已闭麦，暂停接收麦克风输入',
  'permission-denied': '麦克风权限被拒绝',
  'microphone-restricted': '麦克风被系统策略限制',
  'microphone-no-device': '未检测到麦克风输入设备',
  'microphone-busy': '麦克风正被其他应用占用',
  'microphone-unavailable': '当前环境的麦克风采集不可用',
  'audio-pipeline-error': '麦克风音频管线启动失败',
  disconnected: 'Nova Audio Agent 已断开',
  reconnecting: 'Nova Audio Agent 正在重新连接',
  'configuration-required': 'Nova Audio Agent 需要补全配置',
  'authentication-failed': 'Nova Audio Agent 鉴权失败',
  'backend-unavailable': 'Nova Audio Agent 后台不可用',
  error: 'Nova Audio Agent 发生错误',
})

// The compact line is the only status text the transparent orb still shows, so
// keep its expected states concise and fall back to readable copy if a future
// state reaches the renderer before this table is extended.
const COMPACT_LABELS = Object.freeze({
  booting: '启动中',
  inactive: '未启用',
  idle: '待命',
  candidate: '检测中',
  listening: '聆听中',
  speaking: '回复中',
  interrupted: '聆听中',
  muted: '已闭麦',
  'permission-denied': '麦克风未授权',
  'microphone-restricted': '麦克风被限制',
  'microphone-no-device': '无麦克风',
  'microphone-busy': '麦克风被占用',
  'microphone-unavailable': '麦克风不可用',
  'audio-pipeline-error': '音频管线错误',
  disconnected: '已断开',
  reconnecting: '重连中',
  'configuration-required': '配置不完整',
  'authentication-failed': '鉴权失败',
  'backend-unavailable': '后台不可用',
  error: '出错',
})

export function compactOrbLabel(name) {
  return typeof name === 'string' && Object.hasOwn(COMPACT_LABELS, name)
    ? COMPACT_LABELS[name]
    : '状态异常'
}

// The single source of truth for the `data-state` vocabulary: the visual layer
// derives its per-state parameters from this list rather than restating it.
export const ORB_STATE_NAMES = Object.freeze(Object.keys(LABELS))

// Windows has no systemPreferences prompt to point users at, so the denied
// label carries its own navigation hint there; other platforms keep the
// shorter copy above.
const WINDOWS_PERMISSION_DENIED_LABEL =
  '麦克风权限被拒绝(请在 系统设置 → 隐私 → 麦克风 中允许桌面应用)'

export function deriveOrbState(input) {
  const microphone = input.microphone
    ?? (input.permission === 'denied' ? 'permission_denied' : input.permission)
  let name
  if (input.error) name = 'error'
  // A renderer that has not finished bootstrapping has not connected yet
  // either, so plain "disconnected wins" made 'booting' unreachable at the one
  // moment it describes. Booting only shields the socket axis: an error still
  // outranks it, and a disconnect that lands after boot still collapses.
  else if (input.backendState === 'configuration_required') name = 'configuration-required'
  else if (input.backendState === 'authentication_failed') name = 'authentication-failed'
  else if (input.backendState === 'unavailable') name = 'backend-unavailable'
  else if (input.backendState === 'reconnecting') name = 'reconnecting'
  else if (!input.connected && !input.booting) name = 'disconnected'
  else if (microphone === 'permission_denied') name = 'permission-denied'
  else if (microphone === 'restricted') name = 'microphone-restricted'
  else if (microphone === 'no_input_device') name = 'microphone-no-device'
  else if (microphone === 'device_busy') name = 'microphone-busy'
  else if (microphone === 'capture_unavailable') name = 'microphone-unavailable'
  else if (microphone === 'audio_pipeline_error') name = 'audio-pipeline-error'
  else if (input.booting) name = 'booting'
  else if (!input.activated) name = 'inactive'
  // A deliberate mute outranks capture and playback: the mic being off is the
  // state the user acted on, and playback stays audible while it shows.
  else if (input.muted) name = 'muted'
  else if (input.capture === 'listening') name = 'listening'
  else if (input.capture === 'candidate') name = 'candidate'
  else if (input.playback === 'interrupted') name = 'interrupted'
  else if (input.playback === 'speaking') name = 'speaking'
  else name = 'idle'
  const pendingConfirmation = input.pendingConfirmation === true
  const pendingExpiry = Number.isFinite(input.pendingExpiresInSeconds)
    ? `${Math.ceil(Math.max(0, input.pendingExpiresInSeconds)).toFixed(0)} 秒后自动取消`
    : ''
  const pendingOperation = pendingConfirmation ? confirmationOperation(input) : ''
  const pendingStatus = pendingConfirmation
    ? ['尚未执行', pendingExpiry].filter(Boolean).join(' · ')
    : ''
  const project = pendingConfirmation
    ? [
      pendingOperation,
      pendingStatus,
    ].filter(Boolean)
    : [
      input.workspace ? `工作区 ${input.workspace}` : '',
      input.session ? `Session ${input.session}` : '',
    ].filter(Boolean)
  const codexStatus = input.codex === 'working' ? 'Codex 正在后台工作' : 'Codex 空闲'
  const compactCodexStatus = pendingConfirmation
    ? '等待你的确认'
    : input.codex === 'working'
      ? 'Codex 工作中'
      : 'Codex 空闲'
  const codexLabel = [...project, ...(pendingConfirmation ? [] : [codexStatus])]
    .join(pendingConfirmation ? '\n' : ' · ')
  const label = name === 'permission-denied' && input.platform === 'win32'
    ? WINDOWS_PERMISSION_DENIED_LABEL
    : LABELS[name]
  return Object.freeze({
    name,
    label,
    statusLine: pendingConfirmation
      ? '需要你的确认'
      : `${compactOrbLabel(name)} · ${compactCodexStatus}`,
    codexLabel,
    accessibleCodexLabel: pendingConfirmation
      ? `${pendingOperation}；尚未执行；等待你的确认`
      : codexLabel,
    confirmationVisible: pendingConfirmation,
    confirmationOperation: pendingOperation,
    confirmationStatus: pendingStatus,
    aecLabel: input.audioMode === 'voice_processing_io'
      ? '系统级 AEC'
      : input.audioMode === 'browser_aec'
        ? '浏览器 AEC'
        : 'AEC 未启用',
    shellExpanded: input.shellExpanded === true,
  })
}

function confirmationOperation(input) {
  const workspace = typeof input.pendingWorkspace === 'string' ? input.pendingWorkspace : ''
  const session = typeof input.pendingSession === 'string' ? input.pendingSession : ''
  if (input.pendingAction === 'create_workspace' && workspace) {
    return `创建工作区 “${workspace}”`
  }
  if (input.pendingAction === 'select_workspace' && workspace) {
    return `切换到工作区 “${workspace}”`
  }
  if (input.pendingAction === 'resume_session' && workspace && session) {
    return `恢复 “${workspace} / ${session}”`
  }
  return '项目操作等待确认'
}
