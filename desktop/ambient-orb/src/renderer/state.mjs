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

export function deriveOrbState(input) {
  let name
  if (input.error) name = 'error'
  else if (!input.connected) name = 'disconnected'
  else if (input.permission === 'denied') name = 'permission-denied'
  else if (input.booting) name = 'booting'
  else if (!input.activated) name = 'inactive'
  else if (input.capture === 'listening') name = 'listening'
  else if (input.capture === 'candidate') name = 'candidate'
  else if (input.playback === 'interrupted') name = 'interrupted'
  else if (input.playback === 'speaking') name = 'speaking'
  else name = 'idle'
  const project = [
    input.workspace ? `工作区 ${input.workspace}` : '',
    input.session ? `Session ${input.session}` : '',
    input.pendingConfirmation === true ? '等待确认' : '',
  ].filter(Boolean)
  const codexStatus = input.codex === 'working' ? 'Codex 正在后台工作' : 'Codex 空闲'
  return Object.freeze({
    name,
    label: LABELS[name],
    codexLabel: [...project, codexStatus].join(' · '),
    aecLabel: input.audioMode === 'voice_processing_io'
      ? 'macOS 系统级 AEC'
      : input.audioMode === 'browser_aec'
        ? '浏览器 AEC 回退'
        : 'AEC 未启用',
    shellExpanded: input.shellExpanded === true,
  })
}
