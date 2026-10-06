import {localizeDocument, t} from './locale.mjs'
localizeDocument(document)

// First run asks only for the chosen pipeline's keys; everything else stays in Settings.
const api = window.novaAudioAgentDesktop.setup
const LLM_KEYS = Object.freeze({qwen: 'dashscopeApiKey', deepseek: 'deepseekApiKey', ark: 'arkApiKey'})
const PROBE_TEXT = Object.freeze({
  ok: () => t("密钥有效"),
  rejected: () => t("密钥被拒绝，请检查是否复制完整"),
  network: () => t("暂时无法连接服务，请检查网络后重试"),
  missing: () => t("请先填写密钥"),
  deferred: () => t("首次连接时验证"),
  unsupported: () => '',
})

const statusLine = document.querySelector('#status')
const startButton = document.querySelector('#start')
const llmSelect = document.querySelector('#llm-provider')
let view = null
let starting = false
// A push can still carry the previous launch's failure; judge only after the restart is seen.
let restartSeen = false
let closeTimer = null

function pipeline() {
  return document.querySelector('input[name="pipeline"]:checked').value
}

function activeRows() {
  if (pipeline() === 'integrated') return [...document.querySelectorAll('#integrated-fields .key-row')]
  return [...document.querySelectorAll('#cascaded-fields .key-row')]
    .filter(row => row.dataset.llm === undefined || row.dataset.llm === llmSelect.value)
}

function setStatus(text, tone = '') {
  statusLine.textContent = text
  statusLine.dataset.tone = tone
}

function render() {
  const cascaded = pipeline() === 'cascaded'
  document.querySelector('#integrated-fields').hidden = cascaded
  document.querySelector('#cascaded-fields').hidden = !cascaded
  for (const row of document.querySelectorAll('#cascaded-fields .key-row[data-llm]')) row.hidden = row.dataset.llm !== llmSelect.value
  for (const row of document.querySelectorAll('.key-row')) {
    const input = row.querySelector('input')
    input.placeholder = view?.secretsPresent?.[row.dataset.key] ? t("已保存，留空则继续使用") : input.getAttribute('data-placeholder') ?? ''
  }
  startButton.disabled = starting
}

async function testRow(row) {
  const result = row.querySelector('.key-result')
  const button = row.querySelector('.test')
  button.disabled = true
  result.dataset.status = ''
  result.textContent = t("测试中…")
  try {
    const probe = await api.testKey(row.dataset.key, row.querySelector('input').value)
    result.dataset.status = probe.status
    result.textContent = (PROBE_TEXT[probe.status] ?? PROBE_TEXT.network)()
    return probe.status
  } catch {
    result.dataset.status = 'network'
    result.textContent = PROBE_TEXT.network()
    return 'network'
  } finally {
    button.disabled = false
  }
}

async function start() {
  const rows = activeRows()
  const secrets = {}
  for (const row of rows) {
    const value = row.querySelector('input').value.trim()
    if (value !== '') secrets[row.dataset.key] = value
    else if (!view?.secretsPresent?.[row.dataset.key]) {
      setStatus(t("请填写 {0}", row.querySelector('label').textContent), 'warn')
      row.querySelector('input').focus()
      return
    }
  }
  starting = true
  restartSeen = false
  clearTimeout(closeTimer)
  closeTimer = null
  render()
  setStatus(t("正在保存并启动…"))
  try {
    const choice = pipeline() === 'integrated'
      ? {pipelineMode: 'integrated', secrets}
      : {pipelineMode: 'cascaded', cascadedLlmProvider: llmSelect.value, secrets}
    const result = await api.save(choice)
    if (!result.saved || result.rejectedSecrets.length > 0) {
      stopStarting()
      setStatus(t("密钥未能保存，请检查后重试"), 'warn')
    }
  } catch {
    stopStarting()
    setStatus(t("保存失败，请重试"), 'warn')
  }
  render()
}

function stopStarting() {
  starting = false
  clearTimeout(closeTimer)
  closeTimer = null
}

function update(next) {
  view = next
  if (starting && view.backendStatus === 'starting') restartSeen = true
  // An already connected backend reports connected until the save restarts it.
  if (starting && restartSeen && view.backendStatus === 'connected') {
    setStatus(t("已就绪，可以开始对话了"), 'ok')
    closeTimer ??= setTimeout(() => window.close(), 1200)
  } else if (starting && restartSeen && view.backendStatus === 'configuration_required' && view.missing.length > 0) {
    stopStarting()
    setStatus(t("仍缺少 {0}", view.missing.join(', ')), 'warn')
  } else if (starting && restartSeen && ['configuration_required', 'authentication_failed', 'unavailable'].includes(view.backendStatus)) {
    stopStarting()
    setStatus(t("启动失败，请检查密钥后重试"), 'warn')
  }
  render()
}

for (const input of document.querySelectorAll('.key-row input')) input.setAttribute('data-placeholder', input.placeholder)
for (const radio of document.querySelectorAll('input[name="pipeline"]')) radio.addEventListener('change', render)
llmSelect.addEventListener('change', render)
for (const row of document.querySelectorAll('.key-row')) row.querySelector('.test')?.addEventListener('click', () => void testRow(row))
startButton.addEventListener('click', () => void start())
api.onChanged(update)

const initial = await api.status()
view = initial
document.querySelector(`input[name="pipeline"][value="${initial.pipelineMode === 'cascaded' ? 'cascaded' : 'integrated'}"]`).checked = true
if (Object.hasOwn(LLM_KEYS, initial.cascadedLlmProvider)) llmSelect.value = initial.cascadedLlmProvider
render()
