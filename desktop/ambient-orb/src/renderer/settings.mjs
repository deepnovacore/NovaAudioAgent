// Settings are edited as one local transaction. Public drafts live in the
// controller; secret plaintext remains only in password inputs until Save.
import {
  codexModeVisibility,
  createSettingsController,
  settingsButtonState,
} from './settings-controller.mjs'
import { createSecretRevisions } from './secret-revisions.mjs'
import {
  CUSTOM_VOICE_VALUE,
  QWEN_VOICES,
  VOLCENGINE_TTS_VOICES,
  resolveVoiceChoice,
} from './voice-choice.mjs'

const api = window.novaAudioAgentDesktop.settings
const SECRET_KEYS = [
  'dashscopeApiKey', 'tavilyApiKey', 'modelApiKey', 'codexApiKey',
  'arkApiKey', 'doubaoBigmodelApiKey', 'doubaoAsrApiKey',
]
const SECRET_LABELS = {
  dashscopeApiKey: 'DashScope',
  tavilyApiKey: 'Tavily',
  modelApiKey: '模型网关',
  codexApiKey: 'Codex',
  arkApiKey: 'Ark',
  doubaoBigmodelApiKey: '豆包大模型',
  doubaoAsrApiKey: '豆包 ASR',
}
const WORKSPACE_STATUS_TEXT = Object.freeze({
  opened: '已打开当前托管 workspace',
  open_failed: '系统未能打开当前托管 workspace',
  cleared: '已清空托管 workspace',
  cancelled: '已取消',
  not_managed: '当前 workspace 不是 Nova 托管目录',
  empty: '没有可清空的托管 workspace',
  busy: '另一项保存或维护操作正在进行',
  stop_failed: '后台未能安全停止，未清空 workspace',
  clear_failed: 'workspace 清空未完整完成，可重试清理',
  restart_failed: 'workspace 已处理，但后台恢复失败，请重试连接',
  clear_and_restart_failed: 'workspace 清理未完整完成，后台恢复也失败；请重启后重试清理',
  rollback_pending: 'workspace 原内容尚未安全恢复，后台保持停止；请先处理回滚',
  cleanup_pending: 'workspace 清理仍在进行，请稍后重试',
  unavailable: 'workspace 维护状态暂时不可用',
  recovered: 'workspace 恢复完成，后台已开始重新连接',
})

const secretRevisions = createSecretRevisions(SECRET_KEYS)
const dirtySecretKeys = new Set()
let currentView = null
let controllerState = {dirty: false, busy: false}
let workspaceBusy = false

const statusLabel = document.querySelector('#status')
const restartNotice = document.querySelector('#restart-notice')
const warning = document.querySelector('#keyring-warning')
const settingsSave = document.querySelector('#settings-save')
const workspaceOpenCurrent = document.querySelector('#workspace-open-current')
const workspaceClearCurrent = document.querySelector('#workspace-clear-current')
const workspaceClearAll = document.querySelector('#workspace-clear-all')
const workspaceRetryRecovery = document.querySelector('#workspace-retry-recovery')
const workspaceActionStatus = document.querySelector('#workspace-action-status')
const paletteInputs = [...document.querySelectorAll('input[name="palette"]')]
const proactivityInputs = [...document.querySelectorAll('input[name="proactivity"]')]
const pipelineModeInputs = [...document.querySelectorAll('input[name="pipelineMode"]')]
const heartbeat = document.querySelector('#heartbeat')
const heartbeatValue = document.querySelector('#heartbeat-value')
const codexModeInputs = [...document.querySelectorAll('input[name="codexBinaryMode"]')]
const codexBinaryPath = document.querySelector('#codexBinaryPath')
const codexStatus = document.querySelector('#codex-status')
const codexManualSettings = document.querySelector('#codex-manual-settings')
const codexRescan = document.querySelector('#codex-rescan')
const codexWorkspace = document.querySelector('#codexWorkspace')
const codexManagedRoot = document.querySelector('#codexManagedRoot')
const modelBaseUrl = document.querySelector('#modelBaseUrl')
const effectiveWorkspace = document.querySelector('#effective-workspace')
const effectiveManagedRoot = document.querySelector('#effective-managed-root')
const integratedSection = document.querySelector('#integrated-pipeline')
const cascadedSection = document.querySelector('#cascaded-pipeline')
const integratedProvider = document.querySelector('#integratedProvider')
const integratedModel = document.querySelector('#integratedModel')
const integratedVoicePreset = document.querySelector('#integratedVoicePreset')
const integratedVoiceCustom = document.querySelector('#integratedVoiceCustom')
const cascadedEndpointingProvider = document.querySelector('#cascadedEndpointingProvider')
const cascadedAsrProvider = document.querySelector('#cascadedAsrProvider')
const cascadedLlmProvider = document.querySelector('#cascadedLlmProvider')
const cascadedLlmModel = document.querySelector('#cascadedLlmModel')
const cascadedTtsProvider = document.querySelector('#cascadedTtsProvider')
const cascadedTtsVoicePreset = document.querySelector('#cascadedTtsVoicePreset')
const cascadedTtsVoiceCustom = document.querySelector('#cascadedTtsVoiceCustom')

function populateVoiceOptions(select, presets) {
  for (const preset of presets) {
    const option = document.createElement('option')
    option.value = preset.value
    option.textContent = preset.label
    select.append(option)
  }
  const custom = document.createElement('option')
  custom.value = CUSTOM_VOICE_VALUE
  custom.textContent = '自定义音色 ID…'
  select.append(custom)
}

populateVoiceOptions(integratedVoicePreset, QWEN_VOICES)
populateVoiceOptions(cascadedTtsVoicePreset, VOLCENGINE_TTS_VOICES)

function secretInput(key) { return document.querySelector(`#${key}`) }

function renderBadges(present) {
  for (const key of SECRET_KEYS) {
    const badge = document.querySelector(`#badge-${key}`)
    const stored = present?.[key] === true
    badge.textContent = stored ? '已设置' : '未设置'
    badge.dataset.present = stored ? '1' : '0'
  }
}

// These labels reflect selected public providers only, never any key material.
function keyUsage(view) {
  return {
    dashscopeApiKey: view.pipelineMode === 'integrated'
      || view.cascadedLlmProvider === 'qwen' ? '必需' : '当前未使用',
    arkApiKey: view.pipelineMode === 'cascaded'
      && view.cascadedLlmProvider === 'ark' ? '必需' : '当前未使用',
    doubaoBigmodelApiKey: view.pipelineMode === 'cascaded' ? '必需' : '当前未使用',
    doubaoAsrApiKey: view.pipelineMode === 'cascaded' ? '可选覆盖' : '当前未使用',
    tavilyApiKey: '可选', modelApiKey: '可选', codexApiKey: '可选',
  }
}

function renderKeyUsage(view) {
  for (const [key, usage] of Object.entries(keyUsage(view))) {
    document.querySelector(`#usage-${key}`).textContent = usage
  }
}

function renderVoice(select, customInput, value, presets) {
  const choice = resolveVoiceChoice(value, presets)
  select.value = choice.selected
  customInput.hidden = choice.selected !== CUSTOM_VOICE_VALUE
  if (choice.selected === CUSTOM_VOICE_VALUE) customInput.value = choice.custom
}

function renderCodexStatus(view) {
  const status = view.codexStatus
  if (status?.status !== 'ready') {
    codexStatus.textContent = '未找到可用的 Codex CLI；可重新扫描或指定原生可执行文件。'
    codexStatus.dataset.ready = '0'
    return
  }
  codexStatus.textContent = `已连接 ${status.version} · ${status.path}`
  codexStatus.dataset.ready = '1'
}

function updateButtons() {
  const state = settingsButtonState({
    dirty: controllerState.dirty || dirtySecretKeys.size > 0,
    controllerBusy: controllerState.busy,
    lifecycleBusy: currentView?.managedWorkspaces?.lifecycleBusy === true,
    workspaceBusy,
    managedHealth: currentView?.managedWorkspaces?.health,
    currentManagedAvailable: currentView?.managedWorkspaces?.current?.available === true,
    allManagedAvailable: currentView?.managedWorkspaces?.all?.available === true,
  })
  settingsSave.disabled = state.saveDisabled
  workspaceOpenCurrent.disabled = state.currentDisabled
  workspaceClearCurrent.disabled = state.currentDisabled
  workspaceClearAll.disabled = state.workspaceDisabled
  workspaceRetryRecovery.disabled = state.recoveryDisabled
}

function render(view, _drafts, state) {
  if (!view) return
  currentView = view
  controllerState = state
  for (const input of paletteInputs) input.checked = input.value === view.palette
  for (const input of proactivityInputs) input.checked = input.value === view.proactivity
  for (const input of pipelineModeInputs) input.checked = input.value === view.pipelineMode
  heartbeat.value = String(view.codexHeartbeatSeconds)
  heartbeatValue.textContent = `${view.codexHeartbeatSeconds} 秒`
  for (const input of codexModeInputs) input.checked = input.value === view.codexBinaryMode
  const codexVisibility = codexModeVisibility(view.codexBinaryMode)
  codexManualSettings.hidden = codexVisibility.manualConfigurationHidden
  codexRescan.hidden = codexVisibility.rescanHidden
  codexBinaryPath.disabled = view.codexBinaryMode !== 'manual'
  codexBinaryPath.value = view.codexBinaryPath ?? ''
  codexWorkspace.value = view.codexWorkspace ?? ''
  codexManagedRoot.value = view.codexManagedRoot ?? ''
  modelBaseUrl.value = view.modelBaseUrl ?? ''
  effectiveWorkspace.textContent = view.effectivePaths?.workspace ?? ''
  effectiveManagedRoot.textContent = view.effectivePaths?.managedRoot ?? ''
  renderCodexStatus(view)
  integratedSection.hidden = view.pipelineMode !== 'integrated'
  cascadedSection.hidden = view.pipelineMode !== 'cascaded'
  integratedProvider.value = view.integratedProvider
  integratedModel.value = view.integratedModel ?? ''
  renderVoice(integratedVoicePreset, integratedVoiceCustom, view.integratedVoice, QWEN_VOICES)
  cascadedEndpointingProvider.value = view.cascadedEndpointingProvider
  cascadedAsrProvider.value = view.cascadedAsrProvider
  cascadedLlmProvider.value = view.cascadedLlmProvider
  cascadedLlmModel.value = view.cascadedLlmModels?.[view.cascadedLlmProvider] ?? ''
  cascadedTtsProvider.value = view.cascadedTtsProvider
  renderVoice(cascadedTtsVoicePreset, cascadedTtsVoiceCustom, view.cascadedTtsVoice, VOLCENGINE_TTS_VOICES)
  renderBadges(view.secretsPresent)
  renderKeyUsage(view)
  warning.hidden = view.keyringAvailable !== false
  const rollbackPending = view.managedWorkspaces?.health === 'rollback_pending'
  workspaceRetryRecovery.hidden = !rollbackPending
  if (rollbackPending && !workspaceBusy) {
    workspaceActionStatus.textContent = WORKSPACE_STATUS_TEXT.rollback_pending
  }
  updateButtons()
}

function updateRestartNotice(phase) {
  restartNotice.hidden = false
  restartNotice.dataset.state = phase
  if (phase === 'restarting') {
    restartNotice.textContent = '已保存，后台正在重启并重新连接'
    return
  }
  if (phase === 'failed') {
    restartNotice.textContent = '已保存，但后台未能应用新配置；当前仍在使用旧配置'
    return
  }
  if (phase === 'restart_failed') {
    restartNotice.textContent = '已保存并载入新配置，但后台重启失败；请检查后台状态后重试'
    return
  }
  restartNotice.textContent = '已保存，后台已重启并重新连接'
}

const controller = createSettingsController({
  api, render,
  status: note => { statusLabel.textContent = note },
  notice: updateRestartNotice,
})
api.onChanged(view => { controller.syncView(view) })

function bindStage(element, event, patch) {
  element.addEventListener(event, () => { controller.stage(patch()) })
}

for (const input of paletteInputs) bindStage(input, 'change', () => ({palette: input.value}))
for (const input of proactivityInputs) bindStage(input, 'change', () => ({proactivity: input.value}))
for (const input of pipelineModeInputs) bindStage(input, 'change', () => ({pipelineMode: input.value}))
heartbeat.addEventListener('input', () => {
  heartbeatValue.textContent = `${heartbeat.value} 秒`
  controller.stage({codexHeartbeatSeconds: Number(heartbeat.value)})
})
for (const input of codexModeInputs) bindStage(input, 'change', () => ({codexBinaryMode: input.value}))
bindStage(codexBinaryPath, 'input', () => ({codexBinaryPath: codexBinaryPath.value}))
bindStage(codexWorkspace, 'input', () => ({codexWorkspace: codexWorkspace.value}))
bindStage(codexManagedRoot, 'input', () => ({codexManagedRoot: codexManagedRoot.value}))
bindStage(modelBaseUrl, 'input', () => ({modelBaseUrl: modelBaseUrl.value}))
bindStage(integratedProvider, 'change', () => ({integratedProvider: integratedProvider.value}))
bindStage(integratedModel, 'input', () => ({integratedModel: integratedModel.value}))
bindStage(cascadedEndpointingProvider, 'change', () => ({cascadedEndpointingProvider: cascadedEndpointingProvider.value}))
bindStage(cascadedAsrProvider, 'change', () => ({cascadedAsrProvider: cascadedAsrProvider.value}))
bindStage(cascadedLlmProvider, 'change', () => ({cascadedLlmProvider: cascadedLlmProvider.value}))
cascadedLlmModel.addEventListener('input', () => {
  const provider = cascadedLlmProvider.value
  const value = cascadedLlmModel.value
  controller.stage({cascadedLlmModels: { [provider]: value }})
})
bindStage(cascadedTtsProvider, 'change', () => ({cascadedTtsProvider: cascadedTtsProvider.value}))

function bindVoicePicker(field, select, customInput) {
  select.addEventListener('change', () => {
    const custom = select.value === CUSTOM_VOICE_VALUE
    customInput.hidden = !custom
    if (custom) {
      customInput.focus()
      return
    }
    controller.stage({[field]: select.value})
  })
  customInput.addEventListener('input', () => { controller.stage({[field]: customInput.value}) })
}

bindVoicePicker('integratedVoice', integratedVoicePreset, integratedVoiceCustom)
bindVoicePicker('cascadedTtsVoice', cascadedTtsVoicePreset, cascadedTtsVoiceCustom)

for (const key of SECRET_KEYS) {
  secretInput(key).addEventListener('input', () => {
    secretRevisions.noteInput(key)
    dirtySecretKeys.add(key)
    updateButtons()
  })
}
for (const button of document.querySelectorAll('button.clear')) {
  button.addEventListener('click', () => {
    const key = button.dataset.key
    const input = secretInput(key)
    input.value = ''
    secretRevisions.noteInput(key)
    dirtySecretKeys.add(key)
    updateButtons()
  })
}

function stagedSecrets() {
  return Object.fromEntries([...dirtySecretKeys].map(key => [key, secretInput(key).value]))
}

async function saveAll() {
  const submissions = Object.fromEntries([...dirtySecretKeys].map(key => {
    const input = secretInput(key)
    return [key, secretRevisions.capture(key, input.value)]
  }))
  const result = await controller.save(stagedSecrets())
  for (const key of result.acceptedSecrets ?? []) {
    const input = secretInput(key)
    if (secretRevisions.matches(key, input.value, submissions[key])) {
      input.value = ''
      dirtySecretKeys.delete(key)
    }
  }
  if (result.rejectedSecrets.length) {
    const labels = result.rejectedSecrets.map(key => SECRET_LABELS[key])
    statusLabel.textContent = `部分密钥未保存(含非法字符): ${labels.join('、')}`
  }
  updateButtons()
}

settingsSave.addEventListener('click', () => { void saveAll() })

codexRescan.addEventListener('click', async () => {
  statusLabel.textContent = '正在扫描 Codex…'
  try {
    controller.syncView(await api.rescanCodex(), {trackRestart: false})
    statusLabel.textContent = 'Codex 扫描完成'
  } catch {
    statusLabel.textContent = 'Codex 扫描失败'
  }
})
document.querySelector('#projects-repair').addEventListener('click', async () => {
  statusLabel.textContent = '正在修复 Projects 目录权限…'
  try {
    const results = await Promise.all(['state', 'managed', 'workspace'].map(root => api.repairProjects(root)))
    statusLabel.textContent = results.every(result => result?.status === 'ok')
      ? 'Projects 目录权限已修复'
      : '部分 Projects 目录无法修复，请检查路径是否存在'
  } catch {
    statusLabel.textContent = 'Projects 目录权限修复失败'
  }
})

async function runWorkspaceAction(action) {
  workspaceBusy = true
  workspaceActionStatus.textContent = '正在处理…'
  updateButtons()
  try {
    const result = await action()
    workspaceActionStatus.textContent = WORKSPACE_STATUS_TEXT[result?.status] ?? '操作未完成'
    if (result?.view) controller.syncView(result.view, {trackRestart: false})
  } catch {
    workspaceActionStatus.textContent = '操作未完成'
  } finally {
    workspaceBusy = false
    updateButtons()
  }
}

workspaceOpenCurrent.addEventListener('click', () => {
  void runWorkspaceAction(() => api.openCurrentManagedWorkspace())
})
workspaceClearCurrent.addEventListener('click', () => {
  void runWorkspaceAction(() => api.clearCurrentManagedWorkspace())
})
workspaceClearAll.addEventListener('click', () => {
  void runWorkspaceAction(() => api.clearAllManagedWorkspaces())
})
workspaceRetryRecovery.addEventListener('click', () => {
  void runWorkspaceAction(async () => {
    const view = await api.retryBackend()
    return {
      status: view?.managedWorkspaces?.health === 'rollback_pending'
        ? 'rollback_pending'
        : 'recovered',
      view,
    }
  })
})

void (async () => {
  try {
    controller.setView(await api.get())
  } catch {
    statusLabel.textContent = '读取设置失败'
  }
})()
