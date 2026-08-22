// The settings panel talks to nothing but main: no websocket, no backend, no
// relay through the orb renderer. Every value it shows came from
// `nova:settings:get`, and every change it makes goes out through
// `nova:settings:set`, which answers with the stored state to render back.
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
// The panel's own labels for each key, reused for the rejected-secret error
// line so it names fields the way the user sees them, not their JS key.
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
const saveSecretsButton = document.querySelector('#save-secrets')

let saving = false
// The newest patch waiting behind the save in flight, and the note to show once
// it lands. Latest-wins per field is exactly right for radios and a slider: the
// value on screen is the value the user last chose.
let pendingPatch = null
let pendingNote = null

function secretInput(key) {
  return document.querySelector(`#${key}`)
}

// Presence booleans only: main never sends a key value, so there is nothing
// here to put back into a password field.
function renderBadges(present) {
  for (const key of SECRET_KEYS) {
    const badge = document.querySelector(`#badge-${key}`)
    const stored = present?.[key] === true
    badge.textContent = stored ? '已设置' : '未设置'
    badge.dataset.present = stored ? '1' : '0'
  }
}

// These labels reflect only the selected public pipeline. They deliberately do
// not infer anything from whether a write-only password field happens to hold
// a value, or from any stored secret material.
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

function render(view) {
  if (!view) return
  for (const input of paletteInputs) input.checked = input.value === view.palette
  for (const input of proactivityInputs) input.checked = input.value === view.proactivity
  for (const input of pipelineModeInputs) input.checked = input.value === view.pipelineMode
  heartbeat.value = String(view.codexHeartbeatSeconds)
  heartbeatValue.textContent = `${view.codexHeartbeatSeconds} 秒`
  integratedSection.hidden = view.pipelineMode !== 'integrated'
  cascadedSection.hidden = view.pipelineMode !== 'cascaded'
  integratedProvider.value = view.integratedProvider
  integratedModel.value = view.integratedModel
  integratedVoice.value = view.integratedVoice
  cascadedEndpointingProvider.value = view.cascadedEndpointingProvider
  cascadedAsrProvider.value = view.cascadedAsrProvider
  cascadedLlmProvider.value = view.cascadedLlmProvider
  cascadedLlmModel.value = view.cascadedLlmModels?.[view.cascadedLlmProvider] ?? ''
  cascadedTtsProvider.value = view.cascadedTtsProvider
  cascadedTtsVoice.value = view.cascadedTtsVoice
  renderBadges(view.secretsPresent)
  renderKeyUsage(view)
  // No keyring on this machine: the file is plaintext-equivalent and says so.
  warning.hidden = view.keyringAvailable !== false
}

// Field-wise, and one level deeper wherever a field carries an object, so two
// patches queued behind the same save cannot erase each other's fields. The
// panel needs no knowledge of which field that is: the newest value wins per
// leaf, which is what the radios, the slider, and the key form all want.
function mergePatch(base, next) {
  const merged = { ...base }
  for (const [field, value] of Object.entries(next)) {
    const existing = merged[field]
    const bothObjects = value && typeof value === 'object'
      && existing && typeof existing === 'object'
    merged[field] = bothObjects ? { ...existing, ...value } : value
  }
  return merged
}

async function push(patch, note) {
  // A change made mid-save is coalesced rather than dropped: it waits for the
  // in-flight save and is pushed the moment that one answers, so a quickly
  // nudged slider still ends up stored at the value the user left it on.
  if (saving) {
    pendingPatch = mergePatch(pendingPatch, patch)
    pendingNote = note
    statusLabel.textContent = '保存中…'
    return { saved: false, view: null }
  }
  saving = true
  saveSecretsButton.disabled = true
  statusLabel.textContent = '保存中…'
  let saved = false
  let view = null
  try {
    view = await api.set(patch)
    render(view)
    saved = view?.saved !== false
    statusLabel.textContent = saved ? note : '保存失败'
  } catch {
    statusLabel.textContent = '保存失败'
  } finally {
    saving = false
    saveSecretsButton.disabled = false
  }
  if (pendingPatch) {
    const nextPatch = pendingPatch
    const nextNote = pendingNote
    pendingPatch = null
    pendingNote = null
    void push(nextPatch, nextNote)
  }
  return { saved, view }
}

async function saveSecrets() {
  const secrets = {}
  for (const key of SECRET_KEYS) {
    const value = secretInput(key).value
    // Left blank means "keep whatever is stored", so it is simply not sent.
    if (value) secrets[key] = value
  }
  if (!Object.keys(secrets).length) {
    statusLabel.textContent = '没有要保存的密钥'
    return
  }
  const { saved, view } = await push({ secrets }, '密钥已保存')
  if (!saved) return
  const rejected = new Set(view?.rejectedSecrets ?? [])
  for (const key of Object.keys(secrets)) {
    const input = secretInput(key)
    // Only what this call actually accepted is cleared: a rejected paste
    // stays put so the user can see and fix it, instead of the field going
    // blank while the badge still reads 未设置.
    if (!rejected.has(key)) input.value = ''
  }
  if (rejected.size) {
    const labels = SECRET_KEYS.filter(key => rejected.has(key)).map(key => SECRET_LABELS[key])
    statusLabel.textContent = `部分密钥未保存(含非法字符): ${labels.join('、')}`
  }
}

for (const input of paletteInputs) {
  input.addEventListener('change', () => {
    void push({ palette: input.value }, '配色已更新')
  })
}
for (const input of proactivityInputs) {
  input.addEventListener('change', () => {
    void push({ proactivity: input.value }, '已保存')
  })
}
for (const input of pipelineModeInputs) {
  input.addEventListener('change', () => {
    void push({ pipelineMode: input.value }, '语音管线已保存')
  })
}
heartbeat.addEventListener('input', () => {
  heartbeatValue.textContent = `${heartbeat.value} 秒`
})
heartbeat.addEventListener('change', () => {
  void push({ codexHeartbeatSeconds: Number(heartbeat.value) }, '已保存')
})
integratedProvider.addEventListener('change', () => {
  void push({ integratedProvider: integratedProvider.value }, '已保存')
})
integratedModel.addEventListener('change', () => {
  void push({ integratedModel: integratedModel.value }, '已保存')
})
integratedVoice.addEventListener('change', () => {
  void push({ integratedVoice: integratedVoice.value }, '已保存')
})
cascadedEndpointingProvider.addEventListener('change', () => {
  void push({ cascadedEndpointingProvider: cascadedEndpointingProvider.value }, '已保存')
})
cascadedAsrProvider.addEventListener('change', () => {
  void push({ cascadedAsrProvider: cascadedAsrProvider.value }, '已保存')
})
cascadedLlmProvider.addEventListener('change', () => {
  void push({ cascadedLlmProvider: cascadedLlmProvider.value }, '已保存')
})
cascadedLlmModel.addEventListener('change', () => {
  void push({
    cascadedLlmModels: { [cascadedLlmProvider.value]: cascadedLlmModel.value },
  }, '已保存')
})
cascadedTtsProvider.addEventListener('change', () => {
  void push({ cascadedTtsProvider: cascadedTtsProvider.value }, '已保存')
})
cascadedTtsVoice.addEventListener('change', () => {
  void push({ cascadedTtsVoice: cascadedTtsVoice.value }, '已保存')
})
saveSecretsButton.addEventListener('click', () => { void saveSecrets() })
for (const button of document.querySelectorAll('button.clear')) {
  button.addEventListener('click', () => {
    const input = secretInput(button.dataset.key)
    input.value = ''
    void push({ secrets: { [button.dataset.key]: '' } }, '密钥已清除')
  })
}

void (async () => {
  try {
    render(await api.get())
  } catch {
    statusLabel.textContent = '读取设置失败'
  }
})()
