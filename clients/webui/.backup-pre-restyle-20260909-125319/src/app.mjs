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
const orb = createOrbVisualSafe($('orb'), {palette: $('palette').value, size: 320, freezeOnReducedMotion: true})
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
function onCaption(captions) {
  const container = $('transcript')
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 65
  const fragment = document.createDocumentFragment()
  for (const caption of captions) {
    if (!caption.text) continue
    const article = document.createElement('article')
    article.className = 'caption'; article.dataset.role = caption.role
    const label = document.createElement('strong'); label.textContent = caption.role === 'user' ? '你' : 'NOVA'
    const content = document.createElement('p'); content.textContent = caption.text
    article.append(label, content); fragment.append(article)
  }
  if (!fragment.childNodes.length) {
    const empty = document.createElement('div'); empty.className = 'transcript-empty'; empty.id = 'transcript-empty'
    const icon = document.createElement('span'); icon.className = 'empty-lines'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '≋'
    const title = document.createElement('p'); title.textContent = '让想法，从一句话开始。'
    const hint = document.createElement('span'); hint.textContent = '对话会出现在这里。'
    empty.append(icon, title, hint); fragment.append(empty)
  }
  container.replaceChildren(fragment)
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
function onLevel({input = 0, output = 0}) {
  const next = output > 0.003
  if (speaking !== next) { speaking = next; visualState() }
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
async function start() {
  try {
    await session.start({credential: $('credential').value, microphoneId: $('microphone').value})
    session.setVolume(Number($('volume').value) / 100)
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
function openSettings(tab = 'connection') {
  focusBeforeSettings = document.activeElement
  $('workspace').hidden = true; $('workspace').inert = true; $('settings').hidden = false
  selectTab(tab); $('settings-back').focus()
}
function closeSettings() {
  $('settings').hidden = true; $('workspace').hidden = false; $('workspace').inert = false
  focusBeforeSettings?.focus()
}
$('settings-open').onclick = () => openSettings()
$('audio-settings').onclick = () => openSettings('audio')
$('settings-back').onclick = closeSettings
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => selectTab(button.dataset.tab)
$('connection-form').onsubmit = event => { event.preventDefault(); closeSettings(); if (phase !== 'connected' && phase !== 'connecting') start() }
$('microphone').onchange = () => save('microphone', $('microphone').value)
$('volume').oninput = () => { const value = Number($('volume').value); $('volume-value').textContent = `${value}%`; save('volume', value); session.setVolume(value / 100) }
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
    const controls = [...$('sidebar').querySelectorAll('a,button')].filter(element => !element.disabled)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
})
window.addEventListener('pagehide', () => { session.stop(); orb.destroy() }, {once: true})
$('volume-value').textContent = `${$('volume').value}%`
setSidebar(collapsed, false); updateMotion(); visualState()
