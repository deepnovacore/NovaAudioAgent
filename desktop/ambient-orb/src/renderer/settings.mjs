// The panel talks only to the constrained settings bridge. The controller
// owns queued requests and drafts, which keeps an older bridge response from
// erasing text the user typed while it was in flight.
import { createSettingsController } from './settings-controller.mjs'

const api = window.novaAudioAgentDesktop.settings

const SECRET_KEYS = [
  'dashscopeApiKey',
  'tavilyApiKey',
  'modelApiKey',
  'codexApiKey',
  'arkApiKey',
  'doubaoBigmodelApiKey',
  'doubaoAsrApiKey',
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

const statusLabel = document.querySelector('#status')
const warning = document.querySelector('#keyring-warning')
const paletteInputs = [...document.querySelectorAll('input[name="palette"]')]
const proactivityInputs = [...document.querySelectorAll('input[name="proactivity"]')]
const pipelineModeInputs = [...document.querySelectorAll('input[name="pipelineMode"]')]
const heartbeat = document.querySelector('#heartbeat')
const heartbeatValue = document.querySelector('#heartbeat-value')
const integratedSection = document.querySelector('#integrated-pipeline')
const cascadedSection = document.querySelector('#cascaded-pipeline')
const integratedProvider = document.querySelector('#integratedProvider')
const integratedModel = document.querySelector('#integratedModel')
const integratedVoice = document.querySelector('#integratedVoice')
const cascadedEndpointingProvider = document.querySelector('#cascadedEndpointingProvider')
const cascadedAsrProvider = document.querySelector('#cascadedAsrProvider')
const cascadedLlmProvider = document.querySelector('#cascadedLlmProvider')
const cascadedLlmModel = document.querySelector('#cascadedLlmModel')
const cascadedTtsProvider = document.querySelector('#cascadedTtsProvider')
const cascadedTtsVoice = document.querySelector('#cascadedTtsVoice')

function secretInput(key) {
  return document.querySelector(`#${key}`)
}

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
    tavilyApiKey: '可选',
    modelApiKey: '可选',
    codexApiKey: '可选',
  }
}

function renderKeyUsage(view) {
  for (const [key, usage] of Object.entries(keyUsage(view))) {
    document.querySelector(`#usage-${key}`).textContent = usage
  }
}

function renderText(input, draftKey, value, drafts) {
  // A draft is a value typed locally after the response snapshot. Leave it on
  // screen until its own exact save has synchronized it.
  if (!Object.hasOwn(drafts, draftKey)) input.value = value ?? ''
}

function llmDraftKey(provider) {
  return `cascadedLlmModel:${provider}`
}

function render(view, drafts) {
  if (!view) return
  for (const input of paletteInputs) input.checked = input.value === view.palette
  for (const input of proactivityInputs) input.checked = input.value === view.proactivity
  for (const input of pipelineModeInputs) input.checked = input.value === view.pipelineMode
  heartbeat.value = String(view.codexHeartbeatSeconds)
  heartbeatValue.textContent = `${view.codexHeartbeatSeconds} 秒`
  integratedSection.hidden = view.pipelineMode !== 'integrated'
  cascadedSection.hidden = view.pipelineMode !== 'cascaded'
  integratedProvider.value = view.integratedProvider
  renderText(integratedModel, 'integratedModel', view.integratedModel, drafts)
  renderText(integratedVoice, 'integratedVoice', view.integratedVoice, drafts)
  cascadedEndpointingProvider.value = view.cascadedEndpointingProvider
  cascadedAsrProvider.value = view.cascadedAsrProvider
  cascadedLlmProvider.value = view.cascadedLlmProvider
  renderText(
    cascadedLlmModel,
    llmDraftKey(view.cascadedLlmProvider),
    view.cascadedLlmModels?.[view.cascadedLlmProvider],
    drafts,
  )
  cascadedTtsProvider.value = view.cascadedTtsProvider
  renderText(cascadedTtsVoice, 'cascadedTtsVoice', view.cascadedTtsVoice, drafts)
  renderBadges(view.secretsPresent)
  renderKeyUsage(view)
  warning.hidden = view.keyringAvailable !== false
}

const controller = createSettingsController({
  api,
  render,
  status: note => { statusLabel.textContent = note },
})

function push(patch, note) {
  return controller.push(patch, note)
}

function recordDraft(input, key = input.id) {
  controller.setDraft(key, input.value)
}

async function saveText(field, input) {
  const value = input.value
  recordDraft(input, field)
  controller.applyLocal({ [field]: value })
  const result = await push({ [field]: value }, '已保存')
  if (result.saved && result.view?.[field] === value) controller.clearDraftIfEqual(field, value)
}

async function saveCascadedLlmModel() {
  const provider = cascadedLlmProvider.value
  const draftKey = llmDraftKey(provider)
  const value = cascadedLlmModel.value
  recordDraft(cascadedLlmModel, draftKey)
  const patch = { cascadedLlmModels: { [provider]: value } }
  controller.applyLocal(patch)
  const result = await push(patch, '已保存')
  if (result.saved && result.view?.cascadedLlmModels?.[provider] === value) {
    controller.clearDraftIfEqual(draftKey, value)
  }
}

async function saveSecrets() {
  const secrets = {}
  for (const key of SECRET_KEYS) {
    const input = secretInput(key)
    const value = input.value
    if (!value) continue
    // Capture before awaiting: a later paste in this field is a newer draft.
    secrets[key] = value
    controller.setDraft(key, value)
  }
  if (!Object.keys(secrets).length) {
    statusLabel.textContent = '没有要保存的密钥'
    return
  }
  const result = await controller.saveSecrets(secrets)
  if (!result.saved) return
  for (const key of result.cleared) {
    const input = secretInput(key)
    if (input.value === secrets[key]) input.value = ''
  }
  if (result.rejected.length) {
    const labels = result.rejected.map(key => SECRET_LABELS[key])
    statusLabel.textContent = `部分密钥未保存(含非法字符): ${labels.join('、')}`
  }
}

for (const input of paletteInputs) {
  input.addEventListener('change', () => {
    controller.applyLocal({ palette: input.value })
    void push({ palette: input.value }, '配色已更新')
  })
}
for (const input of proactivityInputs) {
  input.addEventListener('change', () => {
    controller.applyLocal({ proactivity: input.value })
    void push({ proactivity: input.value }, '已保存')
  })
}
for (const input of pipelineModeInputs) {
  input.addEventListener('change', () => {
    controller.applyLocal({ pipelineMode: input.value })
    void push({ pipelineMode: input.value }, '语音管线已保存')
  })
}
heartbeat.addEventListener('input', () => {
  heartbeatValue.textContent = `${heartbeat.value} 秒`
})
heartbeat.addEventListener('change', () => {
  const value = Number(heartbeat.value)
  controller.applyLocal({ codexHeartbeatSeconds: value })
  void push({ codexHeartbeatSeconds: value }, '已保存')
})
integratedProvider.addEventListener('change', () => {
  controller.applyLocal({ integratedProvider: integratedProvider.value })
  void push({ integratedProvider: integratedProvider.value }, '已保存')
})
integratedModel.addEventListener('input', () => { recordDraft(integratedModel) })
integratedModel.addEventListener('change', () => { void saveText('integratedModel', integratedModel) })
integratedVoice.addEventListener('input', () => { recordDraft(integratedVoice) })
integratedVoice.addEventListener('change', () => { void saveText('integratedVoice', integratedVoice) })
cascadedEndpointingProvider.addEventListener('change', () => {
  controller.applyLocal({ cascadedEndpointingProvider: cascadedEndpointingProvider.value })
  void push({ cascadedEndpointingProvider: cascadedEndpointingProvider.value }, '已保存')
})
cascadedAsrProvider.addEventListener('change', () => {
  controller.applyLocal({ cascadedAsrProvider: cascadedAsrProvider.value })
  void push({ cascadedAsrProvider: cascadedAsrProvider.value }, '已保存')
})
cascadedLlmProvider.addEventListener('change', () => {
  controller.applyLocal({ cascadedLlmProvider: cascadedLlmProvider.value })
  void push({ cascadedLlmProvider: cascadedLlmProvider.value }, '已保存')
})
cascadedLlmModel.addEventListener('input', () => {
  recordDraft(cascadedLlmModel, llmDraftKey(cascadedLlmProvider.value))
})
cascadedLlmModel.addEventListener('change', () => { void saveCascadedLlmModel() })
cascadedTtsProvider.addEventListener('change', () => {
  controller.applyLocal({ cascadedTtsProvider: cascadedTtsProvider.value })
  void push({ cascadedTtsProvider: cascadedTtsProvider.value }, '已保存')
})
cascadedTtsVoice.addEventListener('input', () => { recordDraft(cascadedTtsVoice) })
cascadedTtsVoice.addEventListener('change', () => { void saveText('cascadedTtsVoice', cascadedTtsVoice) })
for (const key of SECRET_KEYS) {
  secretInput(key).addEventListener('input', () => { recordDraft(secretInput(key), key) })
}
document.querySelector('#save-secrets').addEventListener('click', () => { void saveSecrets() })
for (const button of document.querySelectorAll('button.clear')) {
  button.addEventListener('click', () => {
    const key = button.dataset.key
    const input = secretInput(key)
    input.value = ''
    controller.setDraft(key, '')
    void push({ secrets: { [key]: '' } }, '密钥已清除')
  })
}

void (async () => {
  try {
    controller.setView(await api.get())
  } catch {
    statusLabel.textContent = '读取设置失败'
  }
})()
