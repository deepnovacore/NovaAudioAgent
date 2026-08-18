// The settings panel talks to nothing but main: no websocket, no backend, no
// relay through the orb renderer. Every value it shows came from
// `nova:settings:get`, and every change it makes goes out through
// `nova:settings:set`, which answers with the stored state to render back.
const api = window.novaAudioAgentDesktop.settings

const SECRET_KEYS = ['dashscopeApiKey', 'tavilyApiKey', 'modelApiKey', 'codexApiKey']

const statusLabel = document.querySelector('#status')
const warning = document.querySelector('#keyring-warning')
const paletteInputs = [...document.querySelectorAll('input[name="palette"]')]
const proactivityInputs = [...document.querySelectorAll('input[name="proactivity"]')]
const heartbeat = document.querySelector('#heartbeat')
const heartbeatValue = document.querySelector('#heartbeat-value')
const voice = document.querySelector('#voice')
const saveSecretsButton = document.querySelector('#save-secrets')

let saving = false
let latestView = null

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

function render(view) {
  if (!view) return
  latestView = view
  for (const input of paletteInputs) input.checked = input.value === view.palette
  for (const input of proactivityInputs) input.checked = input.value === view.proactivity
  heartbeat.value = String(view.codexHeartbeatSeconds)
  heartbeatValue.textContent = `${view.codexHeartbeatSeconds} 秒`
  voice.value = view.voice
  renderBadges(view.secretsPresent)
  // No keyring on this machine: the file is plaintext-equivalent and says so.
  warning.hidden = view.keyringAvailable !== false
}

async function push(patch, note) {
  // A second change mid-save is refused rather than queued, and the panel is
  // re-rendered from the last stored answer so it never shows an unsaved state.
  if (saving) {
    render(latestView)
    statusLabel.textContent = '请稍候…'
    return false
  }
  saving = true
  saveSecretsButton.disabled = true
  statusLabel.textContent = '保存中…'
  try {
    const view = await api.set(patch)
    render(view)
    const saved = view?.saved !== false
    statusLabel.textContent = saved ? note : '保存失败'
    return saved
  } catch {
    statusLabel.textContent = '保存失败'
    return false
  } finally {
    saving = false
    saveSecretsButton.disabled = false
  }
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
  if (!await push({ secrets }, '密钥已保存')) return
  for (const key of SECRET_KEYS) {
    const input = secretInput(key)
    input.value = ''
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
heartbeat.addEventListener('input', () => {
  heartbeatValue.textContent = `${heartbeat.value} 秒`
})
heartbeat.addEventListener('change', () => {
  void push({ codexHeartbeatSeconds: Number(heartbeat.value) }, '已保存')
})
voice.addEventListener('change', () => {
  void push({ voice: voice.value }, '已保存')
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
