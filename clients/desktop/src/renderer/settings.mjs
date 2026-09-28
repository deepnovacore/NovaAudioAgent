import {createSkinPanel} from './skin-panel.mjs'
import {t} from './locale.mjs'
import {localizeDocument} from './locale.mjs'
localizeDocument(document)
import {createPhonePanel} from './phone-panel.mjs'
import {frontendUsageText, renderFrontendUsage} from './frontend-usage.mjs'
import {createCapabilitiesEditor} from './capabilities-editor.mjs'
import {createKnowledgePanel} from './knowledge-panel.mjs'
// Settings are edited as one local transaction. Public drafts live in the
// controller; secret plaintext remains only in password inputs until Save.
import {
  codexModeVisibility,
  createSettingsController,
  settingsButtonState,
} from './settings-controller.mjs'
import { createSecretRevisions } from './secret-revisions.mjs'
import {
  SETTINGS_CATEGORIES,
  categoryTabForKey,
  isValidCategory,
} from './settings-categories.mjs'
import {
  CUSTOM_VOICE_VALUE,
  QWEN_VOICES,
  VOLCENGINE_TTS_VOICES,
  resolveVoiceChoice,
} from './voice-choice.mjs'

const api = window.novaAudioAgentDesktop.settings
const SECRET_KEYS = [
  'dashscopeApiKey', 'tavilyApiKey',
  'arkApiKey', 'deepseekApiKey', 'doubaoBigmodelApiKey',
]
const SECRET_LABELS = {
  dashscopeApiKey: 'DashScope',
  tavilyApiKey: 'Tavily',
  arkApiKey: 'Ark',
  deepseekApiKey: t("DeepSeek（官方）"),
  doubaoBigmodelApiKey: t("火山语音"),
}
const WORKSPACE_STATUS_TEXT = Object.freeze({
  opened: t("已打开当前工作区"),
  open_failed: t("系统未能打开当前工作区"),
  cleared: t("已清空工作区"),
  cancelled: t("已取消"),
  not_managed: t("当前工作区不在 Nova 工作区根目录中"),
  empty: t("没有可清空的工作区"),
  busy: t("另一项保存或维护操作正在进行"),
  stop_failed: t("后台未能安全停止，未清空工作区"),
  clear_failed: t("工作区清空未完整完成，可重试清理"),
  restart_failed: t("工作区已处理，但后台恢复失败，请重试连接"),
  clear_and_restart_failed: t("工作区清理未完整完成，后台恢复也失败；请重启后重试清理"),
  rollback_pending: t("工作区原内容尚未安全恢复，后台保持停止；请先处理回滚"),
  cleanup_pending: t("工作区清理仍在进行，请稍后重试"),
  unavailable: t("工作区维护状态暂时不可用"),
  recovered: t("工作区恢复完成，后台已开始重新连接"),
  recovery_failed: t("工作区恢复尚未完成，后台保持停止；请重试恢复"),
})

const secretRevisions = createSecretRevisions(SECRET_KEYS)
const dirtySecretKeys = new Set()
let currentView = null
let controllerState = {dirty: false, busy: false}
let workspaceBusy = false

const statusLabel = document.querySelector('#status')
const restartNotice = document.querySelector('#restart-notice')
const warning = document.querySelector('#keyring-warning')
const settingsRestore = document.querySelector('#settings-restore')
const settingsSave = document.querySelector('#settings-save')
const phoneFields = {phoneServerPort: document.querySelector('#phone-server-port'), phoneServerTokenFile: document.querySelector('#phone-server-token-file'), phoneServerUrl: document.querySelector('#phone-server-url')}
const phonePairingOpen = document.querySelector('#phone-pairing-open')
const settingsRestart = document.querySelector('#settings-restart')
let restarting = false
const workspaceOpenCurrent = document.querySelector('#workspace-open-current')
const workspaceClearCurrent = document.querySelector('#workspace-clear-current')
const workspaceClearAll = document.querySelector('#workspace-clear-all')
const workspaceRetryRecovery = document.querySelector('#workspace-retry-recovery')
const workspaceActionStatus = document.querySelector('#workspace-action-status')
const wakeEnabled = document.querySelector('#wake-word-enabled')
const autoHideSeconds = document.querySelector('#auto-hide-seconds')
const wakeStatus = document.querySelector('#wake-word-status')
const wakeRetry = document.querySelector('#wake-word-retry')
const codingProgressNarrationInput = document.querySelector('#coding-progress-narration')
const proactivityInputs = [...document.querySelectorAll('input[name="proactivity"]')]
const pipelineModeInputs = [...document.querySelectorAll('input[name="pipelineMode"]')]
const codexApprovalModeInputs = [...document.querySelectorAll('input[name="codexApprovalMode"]')]
const generatePlanInput = document.querySelector('#generatePlan')
const planReadbackInputs = [...document.querySelectorAll('input[name="planReadback"]')]
const progressBubblesInputs = [...document.querySelectorAll('input[name="progressBubbles"]')]
const heartbeat = document.querySelector('#heartbeat')
const heartbeatValue = document.querySelector('#heartbeat-value')
const codexModeInputs = [...document.querySelectorAll('input[name="codexBinaryMode"]')]
const codexBinaryPath = document.querySelector('#codexBinaryPath')
const codexStatus = document.querySelector('#codex-status')
const yoloWarning = document.querySelector('#codex-yolo-warning')
const codexManualSettings = document.querySelector('#codex-manual-settings')
const codexRescan = document.querySelector('#codex-rescan')
const codexWorkspace = document.querySelector('#codexWorkspace')
const codexManagedRoot = document.querySelector('#codexManagedRoot')
const effectiveWorkspace = document.querySelector('#effective-workspace')
const effectiveManagedRoot = document.querySelector('#effective-managed-root')
const integratedSection = document.querySelector('#integrated-pipeline')
const cascadedSection = document.querySelector('#cascaded-pipeline')
const integratedProvider = document.querySelector('#integratedProvider')
const integratedModel = document.querySelector('#integratedModel')
const integratedVoicePreset = document.querySelector('#integratedVoicePreset')
const integratedVoiceCustom = document.querySelector('#integratedVoiceCustom')
const cascadedAsrProvider = document.querySelector('#cascadedAsrProvider')
const cascadedLlmProvider = document.querySelector('#cascadedLlmProvider')
const cascadedLlmModelPreset = document.querySelector('#cascadedLlmModelPreset')
const cascadedLlmModel = document.querySelector('#cascadedLlmModel')
const cascadedTtsProvider = document.querySelector('#cascadedTtsProvider')
const cascadedTtsVoicePreset = document.querySelector('#cascadedTtsVoicePreset')
const cascadedTtsVoiceCustom = document.querySelector('#cascadedTtsVoiceCustom')
const clarificationDepth = document.querySelector('#clarificationDepth')

const categoryButtons = SETTINGS_CATEGORIES.map(category => document.querySelector(`#category-${category.id}`))
let activeCategory = SETTINGS_CATEGORIES[0].id
const skinPanel = createSkinPanel({document, stage: patch => controller.stage(patch), discard: () => controller.discardFields(['skinId', 'importedSkins'])})
window.addEventListener('beforeunload', () => skinPanel.destroy(), {once: true})
const phonePanel = createPhonePanel({document, api, save: saveAll})

// Sections are addressed by id from the category table rather than by a markup
// attribute, so showing a category never depends on document order.
function applyCategory(id) {
  if (!isValidCategory(id)) return
  activeCategory = id
  phonePanel.setActive(id === 'phone')
  document.querySelector('footer').hidden = id === 'phone'
  for (const category of SETTINGS_CATEGORIES) {
    const visible = category.id === id
    for (const sectionId of category.sections) {
      const section = document.getElementById(sectionId)
      if (section) section.hidden = !visible
    }
  }
  for (const [index, button] of categoryButtons.entries()) {
    const selected = SETTINGS_CATEGORIES[index].id === id
    button.setAttribute('aria-current', selected ? 'true' : 'false')
    button.tabIndex = selected ? 0 : -1
  }
}

for (const [index, button] of categoryButtons.entries()) {
  const id = SETTINGS_CATEGORIES[index].id
  button.addEventListener('click', () => { applyCategory(id) })
  button.addEventListener('keydown', event => {
    const next = categoryTabForKey(activeCategory, event.key)
    if (next === null) return
    event.preventDefault()
    applyCategory(next)
    document.querySelector(`#category-${next}`).focus?.()
  })
}

const capabilityEditor = createCapabilitiesEditor({root: document.querySelector('#capabilities-editor'),
  cameraRoot: document.querySelector('#camera-executor-toggle'), codingRoot: document.querySelector('#coding-executor-toggle'),
  problemsLabel: document.querySelector('#capabilities-problems'),
  stage: patch => controller.stage(patch), probe: payload => api.probeCapabilities(payload)})
document.getElementById('coding-executor-configure').addEventListener('click', () => {
  applyCategory('codex')
  document.getElementById('codex-projects').open = true
})
const capabilitySettings = ['embeddingProvider', 'embeddingModel', 'knowledgePath', 'capabilitiesConfigPath'].map(key => document.getElementById(key))
const knowledgePanel = createKnowledgePanel({document, action: payload => api.knowledgeAction(payload)})

function populatePresetOptions(select, presets, customLabel = t("自定义音色 ID…")) {
  select.replaceChildren()
  for (const preset of presets) {
    const option = document.createElement('option')
    option.value = preset.value
    option.textContent = preset.label
    select.append(option)
  }
  const custom = document.createElement('option')
  custom.value = CUSTOM_VOICE_VALUE
  custom.textContent = customLabel
  select.append(custom)
}

populatePresetOptions(integratedVoicePreset, QWEN_VOICES)
populatePresetOptions(cascadedTtsVoicePreset, VOLCENGINE_TTS_VOICES)

function secretInput(key) { return document.querySelector(`#${key}`) }
function secretClearButton(key) { return document.querySelector(`button.clear[data-key="${key}"]`) }

function renderBadges(present, sources) {
  for (const key of SECRET_KEYS) {
    const badge = document.querySelector(`#badge-${key}`)
    const stored = present?.[key] === true
    const fromFile = sources?.[key] === 'dotenv'
    badge.textContent = fromFile ? t("来自 .env") : stored ? (sources?.[key] === 'environment' ? t("来自环境变量") : t("已设置")) : t("未设置")
    secretInput(key).hidden = stored && !dirtySecretKeys.has(key)
    secretInput(key).disabled = fromFile
    secretClearButton(key).disabled = fromFile
    secretClearButton(key).title = fromFile ? t("此密钥由 .env 管理，请在文件中清除并重启") : t("清除并输入新密钥")
    secretInput(key).placeholder = fromFile ? t("在 repo .env 中修改，重启后生效") : t("输入新密钥")
    badge.dataset.present = stored ? '1' : '0'
  }
}

// These labels reflect selected public providers only, never any key material.
function keyUsage(view) {
  return {
    dashscopeApiKey: view.pipelineMode === 'integrated'
      || view.cascadedLlmProvider === 'qwen' ? t("必需") : t("当前未使用"),
    deepseekApiKey: view.pipelineMode === 'cascaded' && view.cascadedLlmProvider === 'deepseek' ? t("必需") : t("当前未使用"),
    arkApiKey: view.pipelineMode === 'cascaded'
      && view.cascadedLlmProvider === 'ark' ? t("必需") : t("当前未使用"),
    doubaoBigmodelApiKey: view.pipelineMode === 'cascaded' ? t("必需") : t("当前未使用"),
    tavilyApiKey: t("可选"),
  }
}

function renderKeyUsage(view) {
  for (const [key, usage] of Object.entries(keyUsage(view))) {
    document.querySelector(`#usage-${key}`).textContent = usage
  }
}

function renderPreset(select, customInput, value, presets) {
  const choice = resolveVoiceChoice(value, presets)
  select.value = choice.selected
  customInput.hidden = choice.selected !== CUSTOM_VOICE_VALUE
  if (choice.selected === CUSTOM_VOICE_VALUE) customInput.value = choice.custom
}

function renderCodexStatus(view) {
  const status = view.codexStatus
  if (status?.status !== 'ready') {
    codexStatus.textContent = t("未找到可用的 Codex CLI；可刷新或指定原生可执行文件。")
    codexStatus.dataset.ready = '0'
    return
  }
  codexStatus.textContent = t("已连接 {0}", status.version)
  codexStatus.dataset.ready = '1'
}

function updateButtons() {
  const state = settingsButtonState({
    dirty: controllerState.dirty || dirtySecretKeys.size > 0,
    controllerBusy: controllerState.busy,
    lifecycleBusy: currentView?.managedWorkspaces?.lifecycleBusy === true,
    workspaceBusy,
    managedHealth: currentView?.managedWorkspaces?.health,
    managedRecoveryStatus: currentView?.managedWorkspaces?.recoveryStatus,
    currentManagedAvailable: currentView?.managedWorkspaces?.current?.available === true,
    allManagedAvailable: currentView?.managedWorkspaces?.all?.available === true,
  })
  settingsSave.disabled = state.saveDisabled || restarting
  settingsRestart.disabled = controllerState.busy || workspaceBusy || restarting || currentView?.managedWorkspaces?.lifecycleBusy === true
  workspaceOpenCurrent.disabled = state.currentDisabled
  workspaceClearCurrent.disabled = state.currentDisabled
  workspaceClearAll.disabled = state.workspaceDisabled
  workspaceRetryRecovery.disabled = state.recoveryDisabled
  settingsRestore.disabled = controllerState.busy || workspaceBusy || currentView?.managedWorkspaces?.lifecycleBusy === true
}

const conversationVision = document.getElementById('conversation-vision-enabled')
const monitorCamera = document.getElementById('monitor-camera')
let cameraDevices = []
function renderVision(view) {
  const supported = view.pipelineMode === 'cascaded' && view.visionModels?.[view.cascadedLlmProvider]?.includes(view.cascadedLlmModels?.[view.cascadedLlmProvider]) === true
  conversationVision.checked = supported && view.conversationVisionEnabled === true
  conversationVision.disabled = !supported
  document.getElementById('conversation-vision-status').textContent = ''
  const enabled = view.capabilitiesDocument?.modules?.camera?.enabled !== false
  const watchSelect = document.getElementById('watch-model')
  const presets = Object.entries(view.visionModels ?? {}).flatMap(([provider, models]) =>
    view.secretsPresent?.[({qwen: 'dashscopeApiKey', ark: 'arkApiKey'})[provider]]
      ? models.map(model => ({value: model, label: `${provider === 'qwen' ? 'Qwen' : t("豆包")} · ${model}`})) : [])
  watchSelect.replaceChildren()
  for (const row of [{value: '', label: presets.length ? t("选择监控模型") : t("请先配置视觉模型 API Key")}, ...presets]) {
    const option = document.createElement('option'); option.value = row.value; option.textContent = row.label
    option.disabled = row.value === ''; watchSelect.append(option)
  }
  if (view.watchModel && !presets.some(row => row.value === view.watchModel)) {
    const option = document.createElement('option'); option.value = view.watchModel
    option.textContent = t("{0}（当前不可选）", view.watchModel); option.disabled = true; watchSelect.append(option)
  }
  watchSelect.value = view.watchModel ?? ''
  watchSelect.disabled = !enabled || presets.length === 0
  monitorCamera.disabled = !enabled
  document.getElementById('camera-refresh').disabled = !enabled
  const selected = view.monitorCameraDeviceId ?? ''
  monitorCamera.replaceChildren()
  const rows = [{deviceId: '', label: t("系统默认摄像头")}, ...cameraDevices]
  if (selected && !rows.some(row => row.deviceId === selected)) rows.push({deviceId: selected, label: t("已选摄像头（未检测到）")})
  for (const row of rows) {
    const option = document.createElement('option'); option.value = row.deviceId; option.textContent = row.label; monitorCamera.append(option)
  }
  monitorCamera.value = selected
}
conversationVision.addEventListener('change', async () => {
  const enabled = conversationVision.checked
  if (enabled) {
    try { if (await window.novaAudioAgentDesktop.camera.requestPermission() !== 'granted') throw Error('permission') }
    catch { conversationVision.checked = false; document.getElementById('conversation-vision-status').textContent = t("摄像头权限未授予"); return }
  }
  if (conversationVision.checked !== enabled || conversationVision.disabled) return
  controller.stage({conversationVisionEnabled: enabled})
})
monitorCamera.addEventListener('change', () => controller.stage({monitorCameraDeviceId: monitorCamera.value}))
document.getElementById('watch-model').addEventListener('change', event => {
  if (!event.target.disabled && event.target.value) controller.stage({watchModel: event.target.value})
})
document.getElementById('camera-refresh').addEventListener('click', async () => {
  const status = document.getElementById('camera-devices-status')
  try {
    cameraDevices = await window.novaAudioAgentDesktop.camera.listDevices()
    status.textContent = cameraDevices.length ? '' : t("未检测到摄像头；授权并连接设备后重试")
    renderVision(currentView)
  } catch { status.textContent = t("无法获取摄像头列表") }
})

let usageScope = 'session'
function renderUsage() {
  const usage = currentView?.frontendUsage
  const selected = usageScope === 'history' ? usage?.history : usage
  for (const scope of ['history', 'session']) {
    const value = scope === 'history' ? usage?.history : usage
    const cost = value?.requests && !value?.unavailable ? frontendUsageText(value).split('\n')[0] : '—'
    document.getElementById(`usage-${scope}-cost`).textContent = cost
    document.getElementById(`usage-${scope}-count`).textContent = value?.unavailable ? t("读取失败") : t("{0} 次调用", value?.requests ?? 0)
    document.getElementById(`usage-${scope}`).dataset.empty = String(!value?.requests)
    document.getElementById(`usage-${scope}`).setAttribute('aria-pressed', String(usageScope === scope))
  }
  const notices = []
  if (selected?.missingReports) notices.push(t("缺少用量 {0} 次", selected.missingReports))
  if (selected?.unpricedReports) notices.push(t("无法估价 {0} 次", selected.unpricedReports))
  const status = document.getElementById('frontend-usage')
  status.textContent = usage?.persistenceError
    ? (usage.persistenceError === 'read_failed' ? t("历史记录读取失败，原文件已保留；当前仅显示本次启动用量。") : t("历史用量保存失败，本次用量仍保留在内存中。"))
    : selected?.requests ? notices.join(' · ') : t("开始对话后显示用量")
  status.hidden = !status.textContent
  const breakdown = document.getElementById('usage-breakdown')
  breakdown.hidden = !selected?.requests
  if (breakdown.hidden) breakdown.open = true
  renderFrontendUsage(document.getElementById('frontend-usage-details'), selected, document)
}
for (const scope of ['history', 'session']) document.getElementById(`usage-${scope}`).addEventListener('click', () => {
  usageScope = scope
  renderUsage()
})

function render(view, _drafts, state) {
  if (!view) return
  document.getElementById('language').value = view.language ?? 'zh-CN'
  currentView = view
  skinPanel.render(view, state)
  renderUsage()
  renderVision(view)
  capabilityEditor.render(view)
  knowledgePanel.render(view)
  for (const input of capabilitySettings) input.value = view[input.id] ?? ''
  for (const [key, input] of Object.entries(phoneFields)) input.value = String(view[key] || '')
  phonePairingOpen.disabled = state.busy
  controllerState = state
  wakeEnabled.checked = view.wakeWordEnabled === true
  autoHideSeconds.value = String(view.autoHideSeconds ?? 60)
  wakeStatus.hidden = !['loading', 'error'].includes(view.wakeWord?.status)
  wakeStatus.textContent = ({off: '', loading: t("正在准备唤醒模型…"), ready: t("本地唤醒已就绪"), error: t("唤醒模型不可用，请重试；可用托盘显示窗口。")})[view.wakeWord?.status] ?? ''
  wakeRetry.hidden = view.wakeWord?.status !== 'error'

  codingProgressNarrationInput.value = view.codingProgressNarration
  for (const input of proactivityInputs) input.checked = input.value === view.proactivity
  for (const input of pipelineModeInputs) input.checked = input.value === view.pipelineMode
  for (const input of codexApprovalModeInputs) {
    input.checked = input.value === view.codexApprovalMode
  }
  generatePlanInput.checked = view.generatePlan !== false
  for (const input of planReadbackInputs) input.checked = input.value === view.planReadback
  for (const input of progressBubblesInputs) input.checked = input.value === view.progressBubbles
  yoloWarning.hidden = view.codexApprovalMode !== 'yolo'
  clarificationDepth.value = view.clarificationDepth
  heartbeat.value = String(view.codexHeartbeatSeconds)
  heartbeatValue.textContent = t("{0} 秒", view.codexHeartbeatSeconds)
  for (const input of codexModeInputs) input.checked = input.value === view.codexBinaryMode
  const codexVisibility = codexModeVisibility(view.codexBinaryMode)
  codexManualSettings.hidden = codexVisibility.manualConfigurationHidden
  codexRescan.hidden = codexVisibility.rescanHidden
  codexBinaryPath.disabled = view.codexBinaryMode !== 'manual'
  codexBinaryPath.value = view.codexBinaryPath ?? ''
  codexWorkspace.value = view.codexWorkspace ?? ''
  codexManagedRoot.value = view.codexManagedRoot ?? ''
  effectiveWorkspace.textContent = view.effectivePaths?.workspace ?? ''
  effectiveManagedRoot.textContent = view.effectivePaths?.managedRoot ?? ''
  renderCodexStatus(view)
  integratedSection.hidden = view.pipelineMode !== 'integrated'
  cascadedSection.hidden = view.pipelineMode !== 'cascaded'
  integratedProvider.value = view.integratedProvider
  if (view.integratedModel && ![...integratedModel.children].some(option => option.value === view.integratedModel)) {
    const option = document.createElement('option'); option.value = view.integratedModel; option.textContent = view.integratedModel; integratedModel.append(option)
  }
  integratedModel.value = view.integratedModel ?? ''
  const voices = view.integratedModel?.startsWith('qwen3.5-omni-') ? [{value: 'Ethan', label: t("Ethan（默认）")}] : QWEN_VOICES
  populatePresetOptions(integratedVoicePreset, voices)
  renderPreset(integratedVoicePreset, integratedVoiceCustom, view.integratedVoice, voices)
  cascadedAsrProvider.value = view.cascadedAsrProvider
  cascadedLlmProvider.value = view.cascadedLlmProvider
  const modelPresets = ({
    qwen: [
      {value: 'qwen3.8-flash', label: t("qwen3.8-flash · 第一档 · ★★★★★")},
      {value: 'qwen-flash', label: t("qwen-flash · 第二档 · ★★★★☆")},
      {value: 'qwen3.8-max', label: t("qwen3.8-max · 第二档 · ★★★★☆")},
      {value: 'qwen-plus', label: t("qwen-plus · 第三档 · ★★★☆☆")},
    ],
    deepseek: [{value: 'deepseek-flash', label: t("deepseek-flash · 第一档 · ★★★★★")}],
    ark: [{value: 'doubao-seed-2-0-pro-260215', label: 'doubao-seed-2-0-pro-260215'}],
  }[view.cascadedLlmProvider] ?? [])
  populatePresetOptions(cascadedLlmModelPreset, modelPresets, t("自定义模型 ID…"))
  renderPreset(cascadedLlmModelPreset, cascadedLlmModel, view.cascadedLlmModels?.[view.cascadedLlmProvider], modelPresets)
  cascadedTtsProvider.value = view.cascadedTtsProvider
  renderPreset(cascadedTtsVoicePreset, cascadedTtsVoiceCustom, view.cascadedTtsVoice, VOLCENGINE_TTS_VOICES)
  renderBadges(view.secretsPresent, view.secretSources)
  renderKeyUsage(view)
  warning.hidden = view.keyringAvailable !== false
  const recoveryStatus = view.managedWorkspaces?.recoveryStatus ?? 'idle'
  const recoveryRequired = recoveryStatus !== 'idle'
  workspaceRetryRecovery.hidden = !recoveryRequired
  if (recoveryRequired && !workspaceBusy) {
    workspaceActionStatus.textContent = recoveryStatus === 'failed'
      ? WORKSPACE_STATUS_TEXT.recovery_failed
      : WORKSPACE_STATUS_TEXT.rollback_pending
  }
  settingsRestore.hidden = view.settingsRecoveryAvailable !== true
  if (view.settingsApplyStatus === 'recovery_pending' || view.settingsApplyStatus === 'recovery_failed') {
    updateRestartNotice(view.settingsApplyStatus)
  } else if (view.settingsApplyStatus === 'applied' && view.settingsRecoveryAvailable === false
    && (restartNotice.dataset.state === 'recovery_pending' || restartNotice.dataset.state === 'recovery_failed')) {
    updateRestartNotice('complete')
  }
  updateButtons()
}

function updateRestartNotice(phase) {
  restartNotice.hidden = false
  restartNotice.dataset.state = phase
  if (phase === 'restarting') {
    restartNotice.textContent = t("已保存，后台正在重启并重新连接")
    return
  }
  if (phase === 'failed') {
    restartNotice.textContent = t("未生效：请恢复上次可用设置，再检查未保存的草稿")
    return
  }
  if (phase === 'restart_failed') {
    restartNotice.textContent = t("后端未启动：上次设置已保留，请恢复后端")
    return
  }
  if (phase === 'recovery_pending') {
    restartNotice.textContent = t("上次设置已还原，请点击恢复以确认后端可用")
    return
  }
  if (phase === 'recovery_failed') {
    restartNotice.textContent = t("设置恢复未完成，恢复记录已保留；若重试仍失败，请修复配置目录中的 settings.json.recovery 或配置冲突后再恢复")
    return
  }
  restartNotice.textContent = t("设置已生效")
}

const controller = createSettingsController({
  api: {...api, set: patch => {
    const {capabilitiesDocument, capabilitiesBaseRevision, ...settingsPatch} = patch
    return api.set({settingsPatch, ...(capabilitiesDocument === undefined ? {} : {capabilitiesDocument, capabilitiesBaseRevision})})
  }}, render,
  status: note => { statusLabel.textContent = note },
  notice: updateRestartNotice,
})
api.onChanged(view => {
  if (isValidCategory(view?.focusCategory)) applyCategory(view.focusCategory)
  controller.syncView(view)
})

function bindStage(element, event, patch) {
  element.addEventListener(event, () => { controller.stage(patch()) })
}

for (const [key, input] of Object.entries(phoneFields)) bindStage(input, 'input', () => ({[key]: key === 'phoneServerPort' ? Number(input.value) : input.value}))

bindStage(document.getElementById('language'), 'change', () => ({language: document.getElementById('language').value}))
bindStage(wakeEnabled, 'change', () => ({wakeWordEnabled: wakeEnabled.checked}))
bindStage(autoHideSeconds, 'change', () => {
  const value = Number(autoHideSeconds.value)
  const valid = Number.isInteger(value) && (value === 0 || value >= 30 && value <= 3600)
  autoHideSeconds.setCustomValidity(valid ? '' : t("请输入 0 或 30–3600 的整数"))
  autoHideSeconds.reportValidity()
  return valid ? {autoHideSeconds: value} : {}
})
wakeRetry.addEventListener('click', () => { void window.novaAudioAgentDesktop.wakeWord.retry() })
for (const event of ['pointerdown', 'keydown']) {
  document.addEventListener(event, () => window.novaAudioAgentDesktop.wakeWord.activity())
}
bindStage(codingProgressNarrationInput, 'change', () => ({codingProgressNarration: codingProgressNarrationInput.value}))
for (const input of proactivityInputs) bindStage(input, 'change', () => ({proactivity: input.value}))
for (const input of pipelineModeInputs) bindStage(input, 'change', () => ({pipelineMode: input.value}))
for (const input of codexApprovalModeInputs) {
  bindStage(input, 'change', () => ({codexApprovalMode: input.value}))
}
bindStage(generatePlanInput, 'change', () => ({generatePlan: generatePlanInput.checked}))
for (const input of planReadbackInputs) bindStage(input, 'change', () => ({planReadback: input.value}))
for (const input of progressBubblesInputs) {
  bindStage(input, 'change', () => ({progressBubbles: input.value}))
}
bindStage(clarificationDepth, 'change', () => ({clarificationDepth: clarificationDepth.value}))
for (const input of capabilitySettings) bindStage(input, 'change', () => ({[input.id]: input.value}))
heartbeat.addEventListener('input', () => {
  heartbeatValue.textContent = t("{0} 秒", heartbeat.value)
  controller.stage({codexHeartbeatSeconds: Number(heartbeat.value)})
})
for (const input of codexModeInputs) bindStage(input, 'change', () => ({codexBinaryMode: input.value}))
bindStage(codexBinaryPath, 'input', () => ({codexBinaryPath: codexBinaryPath.value}))
bindStage(codexWorkspace, 'input', () => ({codexWorkspace: codexWorkspace.value}))
bindStage(codexManagedRoot, 'input', () => ({codexManagedRoot: codexManagedRoot.value}))
bindStage(integratedProvider, 'change', () => ({integratedProvider: integratedProvider.value}))
bindStage(integratedModel, 'change', () => ({
  integratedModel: integratedModel.value,
  ...(integratedModel.value.startsWith('qwen3.5-omni-') !== currentView?.integratedModel?.startsWith('qwen3.5-omni-')
    ? {integratedVoice: integratedModel.value.startsWith('qwen3.5-omni-') ? 'Ethan' : 'longanqian'} : {}),
}))
bindStage(cascadedAsrProvider, 'change', () => ({cascadedAsrProvider: cascadedAsrProvider.value}))
bindStage(cascadedLlmProvider, 'change', () => ({cascadedLlmProvider: cascadedLlmProvider.value}))
cascadedLlmModelPreset.addEventListener('change', () => {
  const custom = cascadedLlmModelPreset.value === CUSTOM_VOICE_VALUE
  cascadedLlmModel.hidden = !custom
  if (custom) { cascadedLlmModel.focus(); return }
  controller.stage({cascadedLlmModels: { [cascadedLlmProvider.value]: cascadedLlmModelPreset.value }})
})
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
for (const key of SECRET_KEYS) {
  secretClearButton(key).addEventListener('click', () => {
    const input = secretInput(key)
    input.value = ''
    input.hidden = false
    input.focus()
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
  renderBadges(currentView?.secretsPresent, currentView?.secretSources)
  if (result.rejectedSecrets && result.rejectedSecrets.length) {
    const labels = result.rejectedSecrets.map(key => SECRET_LABELS[key])
    statusLabel.textContent = t("部分密钥未保存(含非法字符): {0}", labels.join('、'))
  }
  updateButtons()
  return result
}

settingsSave.addEventListener('click', () => { void saveAll() })
settingsRestart.addEventListener('click', async () => {
  if (restarting) return
  restarting = true
  updateButtons()
  statusLabel.textContent = t("正在重启后台…")
  try {
    const view = await api.restart()
    controller.syncView(view, {trackRestart: false})
    statusLabel.textContent = view.operationStatus === 'applied' ? t("后台已重启") : view.operationStatus === 'busy' ? t("另一项操作进行中，请稍后重试") : t("重启失败，请检查配置")
  } catch { statusLabel.textContent = t("重启失败，请稍后重试") }
  finally { restarting = false; updateButtons() }
})

codexRescan.addEventListener('click', async () => {
  codexRescan.disabled = true
  codexRescan.setAttribute('aria-busy', 'true')
  statusLabel.textContent = t("正在刷新 Codex…")
  try {
    const view = await api.rescanCodex()
    controller.syncView(view, {trackRestart: false})
    statusLabel.textContent = view.operationStatus === 'recovery_pending'
      ? t("Codex 未刷新：请先恢复上次可用设置")
      : view.operationStatus === 'busy' ? t("另一项操作进行中，Codex 未刷新")
      : view.operationStatus == null ? t("Codex 刷新完成") : t("Codex 刷新未完成")
  } catch {
    statusLabel.textContent = t("Codex 刷新失败")
  } finally {
    codexRescan.disabled = false
    codexRescan.setAttribute('aria-busy', 'false')
  }
})
document.querySelector('#projects-repair').addEventListener('click', async () => {
  statusLabel.textContent = t("正在修复 Projects 目录权限…")
  try {
    const results = await Promise.all(['state', 'managed', 'workspace'].map(root => api.repairProjects(root)))
    statusLabel.textContent = results.every(result => result?.status === 'ok')
      ? t("Projects 目录权限已修复")
      : t("部分 Projects 目录无法修复，请检查路径是否存在")
  } catch {
    statusLabel.textContent = t("Projects 目录权限修复失败")
  }
})

async function runWorkspaceAction(action) {
  workspaceBusy = true
  workspaceActionStatus.textContent = t("正在处理…")
  updateButtons()
  try {
    const result = await action()
    workspaceActionStatus.textContent = WORKSPACE_STATUS_TEXT[result?.status] ?? t("操作未完成")
    if (result?.view) controller.syncView(result.view, {trackRestart: false})
  } catch {
    workspaceActionStatus.textContent = t("操作未完成")
  } finally {
    workspaceBusy = false
    updateButtons()
  }
}

settingsRestore.addEventListener('click', async () => {
  workspaceBusy = true
  updateButtons()
  try {
    const view = await api.retryBackend()
    controller.syncView(view, {trackRestart: false})
    statusLabel.textContent = view.settingsRecoveryAvailable === false && view.settingsApplyStatus === 'applied'
      ? t("上次设置已恢复并生效；草稿尚未保存") : t("恢复未完成，请重试")
  } catch { statusLabel.textContent = t("恢复未完成，请重试") }
  finally { workspaceBusy = false; updateButtons() }
})

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
      status: view?.managedWorkspaces?.recoveryStatus === 'idle'
        ? 'recovered'
        : 'recovery_failed',
      view,
    }
  })
})

// Inside a dedicated category a collapsed disclosure is only a second click,
// so both open on load. Set as a DOM property, never as a markup attribute:
// the panel contract requires these sections ship closed in the source.
for (const id of ['#secrets', '#codex-projects']) {
  const disclosure = document.querySelector(id)
  if (disclosure) disclosure.open = true
}
applyCategory(activeCategory)

void (async () => {
  try {
    const initial = await api.get()
    // A cold open carries its category here rather than on a push, which
    // would have been sent before this module subscribed.
    if (isValidCategory(initial?.focusCategory)) applyCategory(initial.focusCategory)
    controller.setView(initial)
  } catch {
    statusLabel.textContent = t("读取设置失败")
  }
})()
