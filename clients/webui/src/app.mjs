import {createOrbVisualSafe} from '/shared/orb-visual.mjs'
import {createSession} from './session.mjs'

const $ = id => document.getElementById(id)
const read = (key, fallback) => { try { return localStorage.getItem(`nova.webui.${key}`) ?? fallback } catch { return fallback } }
const save = (key, value) => { try { localStorage.setItem(`nova.webui.${key}`, String(value)) } catch {} }
function setTheme(theme) {
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f5f3ef' : '#0b0c14'
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    const label = theme === 'light' ? '切换为深色主题' : '切换为浅色主题'
    button.setAttribute('aria-label', label); button.title = label
    button.firstElementChild.textContent = theme === 'light' ? '☾' : '☀'
  }
}
setTheme(read('theme', 'dark') === 'light' ? 'light' : 'dark')
for (const button of document.querySelectorAll('[data-theme-toggle]')) button.onclick = () => {
  const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  setTheme(theme); save('theme', theme)
}
const mobile = matchMedia('(max-width: 760px)')
const motion = matchMedia('(prefers-reduced-motion: reduce)')
let phase = 'idle', muted = false, speaking = false, working = false, focusBeforeSettings
// Output mute is local playback suppression, the same category as the desktop
// client's nativeAudio.setPlaybackMuted: the runtime keeps streaming and the
// transcript keeps advancing, only this browser goes quiet. Deliberately not
// persisted — a page that reloads into silence with no visible cause is worse
// than re-muting.
let speakerMuted = false
let collapsed = mobile.matches || read('collapsed', 'false') === 'true'
const proposals = new Map()
const savedMicrophone = read('microphone', '')
if (savedMicrophone) {
  $('microphone').add(new Option('上次使用的麦克风', savedMicrophone))
  $('microphone').value = savedMicrophone
}
const palette = read('palette', 'ember')
$('palette').value = ['ember', 'halpha', 'ion', 'violet', 'graphite'].includes(palette) ? palette : 'ember'
$('volume').value = String(Math.max(0, Math.min(100, Number(read('volume', '80')) || 0)))
$('reduced-motion').checked = read('reducedMotion', 'false') === 'true'
// The orb's backing store is fixed at construction time and orb-visual.mjs has
// no runtime resize API, so the CSS box it will actually occupy has to be
// measured up front. These three sizes mirror the #orb rules in styles.css.
const shortViewport = matchMedia('(max-height: 760px) and (min-width: 761px)')
const narrowViewport = matchMedia('(max-width: 1050px)')
const orbSize = shortViewport.matches ? 280 : narrowViewport.matches ? 290 : 320
const orb = createOrbVisualSafe($('orb'), {palette: $('palette').value, size: orbSize, freezeOnReducedMotion: true})
const session = createSession({onStatus, onCaption, onState, onLevel, onSettings})

function visualState() {
  orb.setState(phase === 'error' ? 'error' : phase === 'connecting' ? 'booting' : phase !== 'connected' ? 'idle' : speaking ? 'speaking' : muted ? 'muted' : 'listening', {codexWorking: working})
}
function onStatus({phase: next, message}) {
  phase = next
  $('connection-badge').dataset.phase = phase
  $('connection-badge').lastElementChild.textContent = ({idle: '未连接', connecting: '连接中', connected: '已连接', error: '连接异常'})[phase] || '未连接'
  $('connect-label').textContent = phase === 'connected' ? '结束对话' : phase === 'connecting' ? '取消连接' : '开始对话'
  $('mute').disabled = phase !== 'connected'
  $('stage-title').textContent = phase === 'connected' ? '我在，随时开口。' : phase === 'connecting' ? '正在与你的 Nova 连接…' : phase === 'error' ? '连接暂时遇到了一点问题。' : '想法落地，从开口开始。'
  $('status').textContent = message || (phase === 'connected' ? '说出你的想法，我们一起把它向前推进。' : phase === 'connecting' ? '正在准备麦克风与语音连接。' : '连接你的 Nova，把此刻的灵感变成下一步。')
  $('control-hint').textContent = phase === 'connected' ? '对话进行中 · 你可以随时静音或结束' : '点击开始 · 首次连接需要允许麦克风访问'
  if (phase !== 'connected') {
    proposals.clear(); renderDecisions()
  }
  if (phase === 'idle' || phase === 'error') {
    muted = false; speaking = false; working = false
    $('mute').setAttribute('aria-pressed', 'false')
    $('mute').setAttribute('aria-label', '静音麦克风')
    proposals.clear(); renderDecisions()
    $('context').hidden = true
    $('aec').textContent = '连接后检测'
  }
  visualState()
}
// Keep this copy byte-identical to the static empty state in index.html.
function buildEmptyState() {
  const empty = document.createElement('div'); empty.className = 'transcript-empty'; empty.id = 'transcript-empty'
  const icon = document.createElement('span'); icon.className = 'empty-lines'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '≋'
  const title = document.createElement('p'); title.textContent = '让想法，从一句话开始。'
  const hint = document.createElement('span'); hint.textContent = '连接后，对话会出现在这里。'
  empty.append(icon, title, hint)
  return empty
}
// id -> {article, content, text, final}. Rebuilding the whole list on every
// partial frame destroyed the user's text selection and broke scroll
// anchoring mid-utterance, so nodes are reused and only the changed text is
// written. Safe because Transcript ids only ever append at the tail: see the
// ordering guarantee in transcript.mjs (partials are patched in place via
// Object.assign, new utterances get a fresh id, and the only removals are
// shift() from the head at the 300 cap or the single non-final tail entry).
const renderedCaptions = new Map()
let transcriptEmpty = true
function onCaption(captions) {
  const container = $('transcript')
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 65
  const visible = captions.filter(caption => caption.text)
  if (!visible.length) {
    if (!transcriptEmpty) { container.replaceChildren(buildEmptyState()); renderedCaptions.clear(); transcriptEmpty = true }
    return
  }
  if (transcriptEmpty) { container.replaceChildren(); transcriptEmpty = false }
  const seen = new Set()
  for (const caption of visible) {
    seen.add(caption.id)
    let entry = renderedCaptions.get(caption.id)
    if (!entry) {
      const article = document.createElement('article')
      article.className = 'caption'; article.dataset.role = caption.role
      const label = document.createElement('strong'); label.textContent = caption.role === 'user' ? '你' : 'NOVA'
      const content = document.createElement('p')
      article.append(label, content); container.append(article)
      entry = {article, content, text: '', final: null}
      renderedCaptions.set(caption.id, entry)
    }
    if (entry.text !== caption.text) { entry.content.textContent = caption.text; entry.text = caption.text }
    if (entry.final !== caption.final) { entry.article.classList.toggle('is-partial', !caption.final); entry.final = caption.final }
  }
  for (const [id, entry] of renderedCaptions) if (!seen.has(id)) { entry.article.remove(); renderedCaptions.delete(id) }
  if (nearBottom) container.scrollTop = container.scrollHeight
}
function validId(value) { return typeof value === 'string' && [...value].length > 0 && [...value].length <= 128 }
function setProposal(key, message, id, busy, seconds, summary, choices) {
  if (!validId(id)) { proposals.delete(key); return }
  const prior = proposals.get(key)
  proposals.set(key, {message, id, busy: busy || (prior?.id === id && prior.sent), sent: prior?.id === id && prior.sent, deadline: Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Infinity, summary, choices})
}
function onState(message) {
  if (message.type === 'project.state') {
    $('context').textContent = [message.workspace_display_name, message.session_title].filter(Boolean).join(' / ')
    $('context').hidden = !$('context').textContent
    if (message.pending_confirmation === true) {
      const action = {create_workspace: '创建工作空间', reuse_workspace: '使用工作空间', select_workspace: '切换工作空间', resume_session: '继续会话'}[message.pending_action] || '确认工作空间操作'
      setProposal('project', message, message.pending_confirmation_id, message.pending_confirmation_busy, message.pending_expires_in_seconds, [action, message.pending_workspace_display_name, message.pending_session_title].filter(Boolean).join(' · '), ['decline', 'accept'])
    } else proposals.delete('project')
    renderDecisions()
  } else if (message.type === 'executor.approval' && !message.executor && !message.pending_approval_id) {
    for (const key of proposals.keys()) if (key.startsWith('executor:')) proposals.delete(key)
    renderDecisions()
  } else if (message.type === 'executor.approval' && typeof message.executor === 'string' && message.executor) {
    const key = `executor:${message.executor}`
    if (message.pending_approval === true) setProposal(key, message, message.pending_approval_id, message.pending_approval_busy, message.expires_in_seconds, message.operation_summary || '执行器请求操作权限', Array.isArray(message.allowed_decisions) ? message.allowed_decisions : ['accept', 'decline'])
    else proposals.delete(key)
    renderDecisions()
  } else if (message.type === 'executor.state') {
    working = message.state === 'running'; visualState()
  }
}
function renderDecisions() {
  const fragment = document.createDocumentFragment()
  for (const [key, item] of proposals) {
    const card = document.createElement('section'); card.className = 'decision'
    const title = document.createElement('strong'); title.textContent = item.deadline <= Date.now() ? '确认已过期，等待运行时更新' : item.busy ? '正在等待运行时确认…' : '需要你的确认'
    const summary = document.createElement('p'); summary.textContent = item.summary
    const actions = document.createElement('div'); actions.className = 'decision-actions'
    for (const [choice, label] of [['decline', '拒绝'], ['accept', '允许一次']]) {
      if (!item.choices.includes(choice)) continue
      const button = document.createElement('button'); button.textContent = key === 'project' && choice === 'accept' ? '确认' : label
      button.dataset.choice = choice
      button.disabled = item.busy || item.deadline <= Date.now() || phase !== 'connected'
      button.onclick = () => {
        if (proposals.get(key) !== item || item.busy || item.deadline <= Date.now() || phase !== 'connected') return
        const approved = choice !== 'decline'
        const control = key === 'project' ? {type: 'project.confirmation_decision', proposal_id: item.id, confirmed: approved} : {type: 'executor.approval_decision', executor: item.message.executor, approval_id: item.id, approved}
        try {
          if (session.decide(control) === false) return
          item.busy = true; item.sent = true; renderDecisions()
        } catch (error) { $('status').textContent = error.message || '操作未能发送，请重试。' }
      }
      actions.append(button)
    }
    card.append(title, summary, actions); fragment.append(card)
  }
  $('decisions').replaceChildren(fragment)
}
setInterval(() => {
  for (const item of proposals.values()) if (!item.expired && item.deadline <= Date.now()) { item.expired = true; renderDecisions(); break }
}, 1000)
// onLevel runs at 20Hz off audio.mjs's 50ms interval, and the playback meter
// reports an instantaneous RMS with no smoothing, so it legitimately dips to
// near zero between syllables. A single bare threshold therefore flipped
// speaking on almost every word gap, and speaking/listening drive opposite
// pulse directions in the orb renderer. Entering is instant so onset still
// registers immediately; leaving needs both a lower level and sustained quiet.
const SPEAK_ENTER = 0.003
const SPEAK_EXIT = 0.0012
const SPEAK_MIN_HOLD_MS = 400
let speakingSince = 0
function onLevel({input = 0, output = 0}) {
  const now = performance.now()
  if (!speaking && output > SPEAK_ENTER) { speaking = true; speakingSince = now; visualState() }
  else if (speaking && output < SPEAK_EXIT && now - speakingSince >= SPEAK_MIN_HOLD_MS) { speaking = false; visualState() }
  orb.setLevel(speaking ? output : muted ? 0 : input)
}
function onSettings({echoCancellation, devices}) {
  if (typeof echoCancellation === 'boolean') $('aec').textContent = echoCancellation ? '已启用' : '未启用'
  if (Array.isArray(devices)) {
    const selected = read('microphone', '')
    $('microphone').replaceChildren(new Option('系统默认麦克风', ''))
    for (const device of devices) if (device.kind === 'audioinput' && device.deviceId) $('microphone').add(new Option(device.label || '麦克风', device.deviceId))
    $('microphone').value = selected
    if ($('microphone').selectedIndex < 0) { $('microphone').value = ''; save('microphone', '') }
  }
}
// Every path that sets output gain goes through here, so muting survives a
// reconnect instead of being quietly undone by start()'s own setVolume.
function applyVolume() {
  session.setVolume(speakerMuted ? 0 : Number($('volume').value) / 100)
}
function setSpeakerMuted(next) {
  speakerMuted = next
  applyVolume()
  const label = speakerMuted ? '开启 Nova 声音' : '关闭 Nova 声音'
  $('speaker').setAttribute('aria-pressed', String(speakerMuted))
  $('speaker').setAttribute('aria-label', label)
  $('speaker').title = label
}
async function start() {
  try {
    await settingsReady
    if (hostMode === 'remote' && !authenticated) { openSettings('connection'); $('credential').focus(); return }
    await session.start({credential: $('credential').value, microphoneId: $('microphone').value})
    applyVolume()
  } catch (error) { onStatus({phase: 'error', message: error.message || '无法建立连接，请检查设置。'}) }
}
$('connect').onclick = () => phase === 'connected' || phase === 'connecting' ? session.stop() : start()
$('mute').onclick = () => {
  muted = !muted; session.setMuted(muted)
  $('mute').setAttribute('aria-pressed', String(muted)); $('mute').setAttribute('aria-label', muted ? '取消麦克风静音' : '静音麦克风')
  visualState()
}
function setSidebar(next, persist = true) {
  collapsed = next; $('workspace').classList.toggle('collapsed', collapsed)
  $('expand').setAttribute('aria-expanded', String(!collapsed))
  $('drawer-shade').hidden = collapsed || !mobile.matches
  document.querySelector('.main-stage').inert = mobile.matches && !collapsed
  if (mobile.matches && !collapsed) { $('sidebar').setAttribute('role', 'dialog'); $('sidebar').setAttribute('aria-modal', 'true') }
  else { $('sidebar').removeAttribute('role'); $('sidebar').removeAttribute('aria-modal') }
  if (persist && !mobile.matches) save('collapsed', collapsed)
}
$('collapse').onclick = () => { setSidebar(true); $('expand').focus() }
$('expand').onclick = () => { setSidebar(false); if (mobile.matches) $('collapse').focus() }
$('drawer-shade').onclick = () => { setSidebar(true); $('expand').focus() }
mobile.addEventListener('change', () => setSidebar(mobile.matches || read('collapsed', 'false') === 'true', false))
function selectTab(name) {
  for (const button of document.querySelectorAll('[data-tab]')) {
    const selected = button.dataset.tab === name; button.classList.toggle('selected', selected)
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current')
  }
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name
}
function openSettings(tab = hostMode === 'remote' && !settingsView ? 'connection' : 'models') {
  focusBeforeSettings = document.activeElement
  $('workspace').hidden = true; $('workspace').inert = true; $('settings').hidden = false
  selectTab(tab); $('settings-back').focus()
}
function closeSettings() {
  $('settings').hidden = true; $('workspace').hidden = false; $('workspace').inert = false
  focusBeforeSettings?.focus()
}
$('settings-open').onclick = () => openSettings()
$('speaker').onclick = () => setSpeakerMuted(!speakerMuted)
$('settings-back').onclick = closeSettings
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => selectTab(button.dataset.tab)
$('connection-form').onsubmit = async event => {
  event.preventDefault()
  const button = event.submitter; if (button) button.disabled = true
  try {
    const result = await settingsRequest('/api/session', 'POST', {credential: $('credential').value})
    hostMode = result.mode; authenticated = result.authenticated === true
    if (result.settings) { renderHostSettings(result.settings); settingsMessage('配置已就绪，可以编辑模型与服务。') }
    if (authenticated) $('credential').value = ''
    updateSettingsAccess()
    $('credential-hint').textContent = '访问凭据已接收。开始对话时连接运行时。'
    closeSettings()
  } catch (error) { $('credential-hint').textContent = error.message }
  finally { if (button) button.disabled = false }
}
$('microphone').onchange = () => save('microphone', $('microphone').value)
$('volume').oninput = () => { const value = Number($('volume').value); $('volume-value').textContent = `${value}%`; save('volume', value); applyVolume() }
$('palette').onchange = () => { save('palette', $('palette').value); orb.setPalette($('palette').value) }
function updateMotion() {
  const reduced = $('reduced-motion').checked || motion.matches
  document.documentElement.classList.toggle('reduced-motion', reduced)
  orb.setAccessibility({reducedMotion: reduced})
}
$('reduced-motion').onchange = () => { save('reducedMotion', $('reduced-motion').checked); updateMotion() }
motion.addEventListener('change', updateMotion)
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!$('settings').hidden) closeSettings()
    else if (mobile.matches && !collapsed) { setSidebar(true); $('expand').focus() }
  }
  if (event.key === 'Tab' && mobile.matches && !collapsed && $('settings').hidden) {
    const controls = [...$('sidebar').querySelectorAll('a,button,input,select,textarea,[tabindex]')].filter(element => !element.disabled)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
})
window.addEventListener('pagehide', () => { session.stop(); orb.destroy() }, {once: true})
$('volume-value').textContent = `${$('volume').value}%`
setSidebar(collapsed, false); updateMotion(); visualState()


// Host settings never enter browser storage; secret drafts only live in this form.
let hostMode = 'local', authenticated = false, settingsView
const secretNames = ['dashscopeApiKey', 'tavilyApiKey', 'modelApiKey', 'codexApiKey', 'arkApiKey', 'doubaoBigmodelApiKey', 'doubaoAsrApiKey']
const modelFields = ['pipelineMode', 'integratedModel', 'integratedVoice', 'cascadedLlmProvider', 'cascadedTtsVoice', 'modelBaseUrl', 'plannerModel']
const clearedSecrets = new Set()
function settingsMessage(message, error = false) {
  $('settings-message').textContent = message
  $('settings-message').dataset.error = String(error)
}
async function settingsRequest(path, method, body) {
  let response
  try {
    response = await fetch(path, {method, headers: {'Content-Type': 'application/json', 'X-Nova-WebUI': '1'}, credentials: 'same-origin', ...(body === undefined ? {} : {body: JSON.stringify(body)})})
  } catch { throw new Error('无法连接主机，请检查网络后重试；尚未确认保存。') }
  let data
  try { data = await response.json() } catch { throw new Error('主机返回异常，请刷新页面后重试。') }
  if (!response.ok) {
    const message = response.status === 503 && data.saved === true ? '配置已保存，但运行时重启失败。请检查模型与密钥后重试，或返回对话重新启动；输入内容已保留。'
      : response.status === 401 ? '访问验证失败，请重新输入远程访问凭据。'
      : response.status === 400 ? '配置格式不正确，请检查模型名称、服务地址和密钥。'
      : response.status === 409 ? '运行时正忙，请稍后重试。'
      : response.status === 403 ? '主机拒绝此请求，请从此主机的 WebUI 地址重新打开。'
      : '主机未能完成操作，请检查运行时状态后重试；输入内容已保留。'
    const error = new Error(message); error.mode = data.mode; error.status = response.status; throw error
  }
  return data
}
function updatePipelineFields() {
  $('integrated-fields').hidden = $('pipelineMode').value !== 'integrated'
  $('cascaded-fields').hidden = $('pipelineMode').value !== 'cascaded'
}
function updateSecretBadge(key) {
  const present = settingsView?.secretsPresent?.[key] === true
  const badge = $(`present-${key}`)
  badge.dataset.present = String(present && !clearedSecrets.has(key))
  badge.textContent = clearedSecrets.has(key) ? '待清除' : $(key).value ? '待保存' : present ? '已设置' : '未设置'
  document.querySelector(`[data-clear-secret="${key}"]`).textContent = clearedSecrets.has(key) ? '撤销' : '清除'
}
function renderHostSettings(view) {
  settingsView = view
  for (const key of modelFields) $(key).value = view[key] ?? ''
  for (const provider of ['qwen', 'ark']) $(`cascadedModel-${provider}`).value = view.cascadedLlmModels?.[provider] ?? ''
  for (const key of secretNames) { $(key).value = ''; updateSecretBadge(key) }
  $('model-fields').disabled = false
  updatePipelineFields()
}
async function loadHostSettings() {
  $('settings-retry').hidden = true
  settingsMessage('正在读取主机配置…')
  try {
    const result = await settingsRequest('/api/session', 'POST', {})
    hostMode = result.mode; authenticated = result.authenticated === true
    if (result.settings || hostMode === 'local') {
      renderHostSettings(result.settings || await settingsRequest('/api/settings', 'GET'))
      settingsMessage('配置已就绪。保存后应用，打开设置不会启动语音。')
    }
  } catch (error) {
    if (error.mode === 'remote' && error.status === 401) { hostMode = 'remote'; authenticated = false }
    else { settingsMessage(error.message, true); $('settings-retry').hidden = false }
  }
  updateSettingsAccess()
}
function updateSettingsAccess() {
  const externalProxy = hostMode === 'remote' && !settingsView
  document.querySelector('[data-tab="connection"]').hidden = hostMode !== 'remote'
  document.querySelector('[data-tab="models"]').hidden = externalProxy
  if (externalProxy) selectTab('connection')
  else if (document.querySelector('[data-tab="connection"]').classList.contains('selected')) selectTab('models')
  document.querySelector('[data-panel="connection"] .section-intro').textContent = settingsView
    ? '已连接托管运行时，模型与 API Key 可在「模型与服务」中配置。'
    : '此入口连接远程运行时，模型与 API Key 请在运行时主机配置。'
  $('credential-hint').textContent = authenticated ? '访问凭据已接收。开始对话时连接运行时。' : '使用远程主机或已配对设备的访问凭据'
}
$('pipelineMode').onchange = updatePipelineFields
for (const key of secretNames) {
  $(key).oninput = () => { clearedSecrets.delete(key); updateSecretBadge(key) }
  document.querySelector(`[data-clear-secret="${key}"]`).onclick = () => {
    if (clearedSecrets.has(key)) clearedSecrets.delete(key)
    else { clearedSecrets.add(key); $(key).value = '' }
    updateSecretBadge(key)
  }
}
$('model-form').onsubmit = async event => {
  event.preventDefault()
  const patch = Object.fromEntries(modelFields.map(key => [key, $(key).value]))
  patch.cascadedLlmModels = Object.fromEntries(['qwen', 'ark'].map(provider => [provider, $(`cascadedModel-${provider}`).value]))
  patch.secrets = Object.fromEntries(secretNames.filter(key => clearedSecrets.has(key) || $(key).value).map(key => [key, clearedSecrets.has(key) ? null : $(key).value]))
  $('model-fields').disabled = true
  settingsMessage('正在保存并应用…')
  try {
    const result = await settingsRequest('/api/settings', 'PUT', patch)
    clearedSecrets.clear(); renderHostSettings(result)
    settingsMessage(result.restarted ? '配置已保存，运行时已重新启动。' : result.runtimeStatus === 'ready' ? '配置已保存并应用。' : '配置已保存，将在下次启动对话时使用。')
  } catch (error) { settingsMessage(error.message, true) }
  finally { $('model-fields').disabled = false }
}
let settingsReady = loadHostSettings()
$('settings-retry').onclick = () => { settingsReady = loadHostSettings() }
