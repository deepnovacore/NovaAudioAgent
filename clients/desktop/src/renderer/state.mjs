import {t} from './locale.mjs'
const LABELS = Object.freeze({
  booting: t("Nova Audio Agent 正在启动"),
  inactive: t("语音未启用"),
  idle: t("语音已启用，等待输入"),
  candidate: t("检测到可能的语音"),
  listening: t("正在聆听"),
  speaking: t("Nova Audio Agent 正在说话"),
  muted: t("已闭麦，暂停接收麦克风输入"),
  'permission-denied': t("麦克风权限被拒绝"),
  'microphone-restricted': t("麦克风被系统策略限制"),
  'microphone-no-device': t("未检测到麦克风输入设备"),
  'microphone-busy': t("麦克风正被其他应用占用"),
  'microphone-unavailable': t("当前环境的麦克风采集不可用"),
  'audio-pipeline-error': t("麦克风音频管线启动失败"),
  disconnected: t("Nova Audio Agent 已断开"),
  reconnecting: t("Nova Audio Agent 正在重新连接"),
  'configuration-required': t("Nova Audio Agent 需要补全配置"),
  'authentication-failed': t("Nova Audio Agent 鉴权失败"),
  'backend-unavailable': t("Nova Audio Agent 后台不可用"),
  error: t("Nova Audio Agent 发生错误"),
})

// The compact line is the only status text the transparent orb still shows, so
// keep its expected states concise and fall back to readable copy if a future
// state reaches the renderer before this table is extended.
const COMPACT_LABELS = Object.freeze({
  booting: t("启动中"),
  inactive: t("未启用"),
  idle: t("待命"),
  candidate: t("检测中"),
  listening: t("聆听中"),
  speaking: t("回复中"),
  muted: t("已闭麦"),
  'permission-denied': t("麦克风未授权"),
  'microphone-restricted': t("麦克风被限制"),
  'microphone-no-device': t("无麦克风"),
  'microphone-busy': t("麦克风被占用"),
  'microphone-unavailable': t("麦克风不可用"),
  'audio-pipeline-error': t("音频管线错误"),
  disconnected: t("已断开"),
  reconnecting: t("重连中"),
  'configuration-required': t("配置不完整 · 点此设置"),
  'authentication-failed': t("鉴权失败"),
  'backend-unavailable': t("后台不可用"),
  error: t("出错"),
})

export function compactOrbLabel(name) {
  return typeof name === 'string' && Object.hasOwn(COMPACT_LABELS, name)
    ? COMPACT_LABELS[name]
    : t("状态异常")
}

// The single source of truth for the `data-state` vocabulary: the visual layer
// derives its per-state parameters from this list rather than restating it.
export const ORB_STATE_NAMES = Object.freeze(Object.keys(LABELS))

// Windows has no systemPreferences prompt to point users at, so the denied
// label carries its own navigation hint there; other platforms keep the
// shorter copy above.
const WINDOWS_PERMISSION_DENIED_LABEL =
  t("麦克风权限被拒绝(请在 系统设置 → 隐私 → 麦克风 中允许桌面应用)")

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
  else if (input.playback === 'speaking') name = 'speaking'
  else name = 'idle'
  const pendingConfirmation = input.pendingConfirmation === true
  const pendingSeconds = Number.isFinite(input.pendingExpiresInSeconds)
    ? Math.ceil(Math.max(0, input.pendingExpiresInSeconds)).toFixed(0)
    : ''
  const pendingExpiry = pendingSeconds === '' ? '' : t("{0} 秒后自动取消", pendingSeconds)
  const pendingOperation = pendingConfirmation ? confirmationOperation(input) : ''
  const pendingStatus = pendingConfirmation
    ? [t("尚未执行"), pendingExpiry].filter(Boolean).join(' · ')
    : ''
  const confirmationCompactStatus = pendingConfirmation
    ? input.pendingConfirmationBusy === true
      ? t("处理中")
      : pendingSeconds !== ''
        ? t("{0} 秒", pendingSeconds)
        : t("待确认")
    : ''
  const project = pendingConfirmation
    ? [
      pendingOperation,
      pendingStatus,
    ].filter(Boolean)
    : [
      input.workspace ? t("工作区 {0}", input.workspace) : '',
      input.session ? `Session ${input.session}` : '',
    ].filter(Boolean)
  const target = [input.workspace, input.session].filter(Boolean).join(' · ')
  const projectLabel = target ? t("当前对话 · {0}", target) : ''
  const codexMode = pendingConfirmation
    ? 'confirmation'
    : projectLabel === '' ? 'hidden' : 'project'
  const codexLabel = pendingConfirmation ? project.join('\n') : projectLabel
  const label = name === 'permission-denied' && input.platform === 'win32'
    ? WINDOWS_PERMISSION_DENIED_LABEL
    : LABELS[name]
  return Object.freeze({
    name,
    label,
    statusLine: pendingConfirmation
      ? t("需要你的确认")
      : name === 'idle' && input.codex === 'preparing' ? t("正在安排任务") : compactOrbLabel(name),
    // Only the missing-configuration line acts: it opens first-run setup.
    statusAction: name === 'configuration-required' && !pendingConfirmation ? 'setup' : null,
    codexLabel,
    projectLabel,
    codexMode,
    sessionWorking: codexMode === 'project' && !!input.session && input.codex === 'working'
      && (input.tasks ?? []).some(task => task.project === input.workspace && task.phase === 'working'),
    accessibleCodexLabel: pendingConfirmation
      ? t("{0}；尚未执行；等待你的确认", pendingOperation)
      : codexLabel,
    confirmationVisible: pendingConfirmation,
    confirmationOperation: pendingOperation,
    confirmationStatus: pendingStatus,
    confirmationCompactStatus,
    aecLabel: input.audioMode === 'voice_processing_io'
      ? t("系统级 AEC")
      : input.audioMode === 'browser_aec'
        ? t("浏览器 AEC")
        : t("AEC 未启用"),
    shellExpanded: input.shellExpanded === true,
  })
}

// Hover reveals controls without changing audio wake state.
// Background work alone must not expand a sleeping orb.
export function orbDormant(input) {
  if (input?.wakeState === 'sleeping') return !input.hovered && !input.confirmationVisible && !input.bubblesVisible
  return input?.stateName === 'inactive'
    && input.hovered !== true
    && input.executorWorking !== true
    && input.confirmationVisible !== true
    && input.bubblesVisible !== true
}

function confirmationOperation(input) {
  if (typeof input.pendingOperation === 'string' && input.pendingOperation !== '') {
    return input.pendingOperation
  }
  const workspace = typeof input.pendingWorkspace === 'string' ? input.pendingWorkspace : ''
  const session = typeof input.pendingSession === 'string' ? input.pendingSession : ''
  if (input.pendingAction === 'create_workspace' && workspace) {
    return t("创建工作区 “{0}”", workspace)
  }
  if (input.pendingAction === 'reuse_workspace' && workspace) {
    return t("使用现有工作区 “{0}”并开始任务", workspace)
  }
  if (input.pendingAction === 'select_workspace' && workspace) {
    return t("切换到工作区 “{0}”", workspace)
  }
  if (input.pendingAction === 'resume_session' && workspace && session) {
    return t("恢复 “{0} / {1}”", workspace, session)
  }
  return t("项目操作等待确认")
}
