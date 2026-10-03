import {t} from './locale.mjs'
import {EXECUTOR_TASKS, EXECUTOR_TASK_ACTION_RESULT} from './wire-frame-types.mjs'
import {parseProgressFrame, validProjectLabel} from './bubbles.mjs'

const RUNNING = new Set(['started', 'working'])
const AUTO_HIDE = new Set(['completed', 'cancelled'])
const PHASES = new Set([...RUNNING, ...AUTO_HIDE, 'failed', 'refused', 'unknown'])
const STATUS = {started: t("已开始"), working: t("进行中"), completed: t("已完成"), cancelled: t("已停止"), failed: t("执行失败"), refused: t("未执行"), unknown: t("结果待确认")}

export function parseTaskSnapshot(frame) {
  if (!frame || frame.type !== EXECUTOR_TASKS || !Number.isSafeInteger(frame.revision) || frame.revision < 0
    || !(frame.active_project === null || validProjectLabel(frame.active_project))
    || !Array.isArray(frame.tasks) || frame.tasks.length > 16
    || new TextEncoder().encode(JSON.stringify(frame)).length > 16384) return null
  const ids = new Set()
  for (const task of frame.tasks) {
    if (!task || !validProjectLabel(task.project) || !validProjectLabel(task.title) || !PHASES.has(task.phase)
      || !parseProgressFrame({type: 'executor.progress', delegate_id: task.work_id, executor: task.executor,
        phase: task.phase, summary: task.summary, ts: task.ts, level: 'detail'}) || ids.has(task.work_id)) return null
    ids.add(task.work_id)
  }
  return {revision: frame.revision, active_project: frame.active_project, tasks: frame.tasks.map(task => ({...task}))}
}

/** View-local selection and pending clicks; task truth always comes from a host snapshot. */
export function createTaskBannerController({send, onChange = () => {}, now = Date.now, schedule = setTimeout, cancel = clearTimeout}) {
  let tasks = [], selectedId = null, revision = -1, activeProject = null
  let suspended = false, hidden = false, connected = false, paused = false, sequence = 0
  let terminalTimer = null, terminalId = null, terminalDue = 0, remaining = 8000
  const expired = new Set(), pending = new Map(), cancelling = new Set(), errors = new Map()
  const selected = () => tasks.find(task => task.work_id === selectedId) ?? null
  function stopTerminal() { if (terminalTimer !== null) cancel(terminalTimer); terminalTimer = null }
  function armTerminal() {
    stopTerminal()
    const item = selected()
    if (!item || !AUTO_HIDE.has(item.phase)) { terminalId = null; return }
    if (terminalId !== item.work_id) { terminalId = item.work_id; remaining = 8000 }
    if (paused || hidden || suspended || !connected) return
    terminalDue = now() + remaining
    terminalTimer = schedule(() => {
      expired.add(item.work_id)
      selectedId = null
      terminalId = null
      choose()
      armTerminal()
      emit()
    }, remaining)
  }
  function choose() {
    if (selected() && !expired.has(selectedId)) return
    const visible = tasks.filter(task => !expired.has(task.work_id))
    selectedId = (visible.find(task => RUNNING.has(task.phase) && task.project === activeProject)
      ?? visible.find(task => RUNNING.has(task.phase)) ?? visible[0])?.work_id ?? null
  }
  function state({includeExpired = false} = {}) {
    const item = selected()
    return {tasks: tasks.filter(task => includeExpired || !expired.has(task.work_id)).map(task => ({...task, cancelling: cancelling.has(task.work_id), opening: [...pending.values()].some(p => p.work_id === task.work_id && p.action === 'open'), error: errors.get(task.work_id) ?? ''})), selected: item ? {...item} : null,
      visible: !suspended && !hidden && item !== null, connected, runningCount: tasks.filter(task => RUNNING.has(task.phase)).length,
      cancelling: cancelling.has(selectedId), opening: [...pending.values()].some(p => p.work_id === selectedId && p.action === 'open'),
      error: errors.get(selectedId) ?? ''}
  }
  function emit() { onChange(state()) }
  function clearPending() {
    for (const request of pending.values()) cancel(request.timer)
    pending.clear(); cancelling.clear()
  }
  function receive(raw) {
    const frame = parseTaskSnapshot(raw)
    if (!frame || frame.revision <= revision) return false
    const wasConnected = connected
    const known = new Set(tasks.map(task => task.work_id))
    revision = frame.revision; activeProject = frame.active_project; connected = true
    if (frame.tasks.some(task => RUNNING.has(task.phase) && !known.has(task.work_id))) hidden = false
    tasks = frame.tasks
    const present = new Set(tasks.map(task => task.work_id))
    for (const map of [expired, cancelling, errors]) for (const id of map.keys()) if (!present.has(id)) map.delete(id)
    for (const task of tasks) if (!RUNNING.has(task.phase)) cancelling.delete(task.work_id)
    const oldSelected = selectedId
    choose()
    const nextTerminal = selected() && AUTO_HIDE.has(selected().phase) ? selectedId : null
    if (!wasConnected || oldSelected !== selectedId || terminalId !== nextTerminal) armTerminal()
    emit()
    return true
  }
  function select(id) {
    if (!tasks.some(task => task.work_id === id)) return false
    expired.delete(id); selectedId = id; hidden = false
    armTerminal(); emit(); return true
  }
  function action(action, id = selectedId) {
    const item = tasks.find(task => task.work_id === id)
    if (!connected || !item || !['open', 'cancel'].includes(action)
      || (action === 'cancel' && (!RUNNING.has(item.phase) || cancelling.has(item.work_id)))
      || [...pending.values()].some(p => p.work_id === item.work_id && p.action === action)) return false
    const request_id = `banner-${++sequence}-${now()}`
    const request = {type: 'executor.task_action', request_id, work_id: item.work_id, executor: item.executor, action}
    errors.delete(item.work_id)
    if (action === 'cancel') cancelling.add(item.work_id)
    const timer = schedule(() => {
      pending.delete(request_id); cancelling.delete(item.work_id)
      errors.set(item.work_id, t("操作响应超时，请核对任务状态后重试。")); emit()
    }, 10000)
    pending.set(request_id, {...request, timer})
    if (!send(request)) {
      cancel(timer); pending.delete(request_id); cancelling.delete(item.work_id)
      errors.set(item.work_id, t("连接不可用，请稍后重试。"))
    }
    emit(); return true
  }
  function receiveActionResult(result) {
    if (result?.type !== EXECUTOR_TASK_ACTION_RESULT) return false
    const request = pending.get(result.request_id)
    if (!request || request.work_id !== result.work_id || request.action !== result.action
      || !['opened', 'cancelling', 'not_running', 'unavailable', 'failed'].includes(result.status)) return false
    cancel(request.timer); pending.delete(result.request_id)
    if (result.status !== 'cancelling') cancelling.delete(result.work_id)
    const error = {not_running: t("任务已结束，无法继续停止。"), unavailable: t("此任务的项目目录暂不可用。"), failed: t("操作未成功，请稍后重试。")}[result.status]
    if (error) errors.set(result.work_id, error)
    emit(); return true
  }
  return Object.freeze({state, receive, select, action, receiveActionResult,
    connect() { revision = -1; connected = false; clearPending(); emit() },
    disconnect() { connected = false; clearPending(); stopTerminal(); emit() },
    setSuspended(value) {
      if (suspended === value) return
      if (terminalTimer !== null) remaining = Math.max(0, terminalDue - now())
      suspended = value; armTerminal(); emit()
    },
    dismiss() { hidden = true; stopTerminal(); emit() },
    restore() { if (!tasks.length) return false; hidden = false; expired.clear(); choose(); armTerminal(); emit(); return true },
    pause() { if (paused) return; paused = true; if (terminalTimer !== null) remaining = Math.max(0, terminalDue - now()); stopTerminal() },
    resume() { if (!paused) return; paused = false; armTerminal() },
    dispose() { clearPending(); stopTerminal() },
  })
}

/** Keep each card and its action buttons stable while progress updates. */
export function mountTaskBanner({container, send, reserveArea, onChange = () => {}}) {
  const list = container.querySelector('[data-task-list]'), expand = container.querySelector('[data-task-expand]')
  const cards = new Map()
  let layout = null, reserved = 0, expanded = false, hovered = false, focused = false, platform = ''
  function applyLayout(value) {
    layout = value
    container.style.setProperty('--task-height', `${value?.taskHeightCss ?? 0}px`)
    container.hidden = !controller.state().visible || !(value?.taskHeightCss > 0) || value?.suppressed === true
  }
  function render(view) {
    container.dataset.working = String(view.connected && view.tasks.some(task => RUNNING.has(task.phase)))
    container.hidden = !view.visible || !(layout?.taskHeightCss > 0) || layout?.suppressed === true
    const shown = expanded ? view.tasks : view.tasks.slice(0, 3)
    for (const [id, card] of cards) if (!view.tasks.some(task => task.work_id === id)) {card.remove(); cards.delete(id)}
    for (const task of view.tasks) {
      let card = cards.get(task.work_id)
      if (!card) {
        card = container.ownerDocument.createElement('article')
        card.className = 'task-card'
        card.innerHTML = t("<div class=\"task-card-heading\"><span data-project></span><span aria-hidden=\"true\"> · </span><strong data-title></strong></div><p data-summary></p><p data-error role=\"alert\" hidden></p><span data-status></span><div class=\"task-card-footer\"><button data-open type=\"button\" aria-label=\"打开项目\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M14 3h7v7M21 3l-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5\"/></svg></button><button data-stop type=\"button\" aria-label=\"停止任务\" title=\"停止任务\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\"/></svg></button></div>")
        for (const [selector, action] of [['[data-open]', 'open'], ['[data-stop]', 'cancel']]) card.querySelector(selector).addEventListener('click', () => {controller.select(task.work_id); controller.action(action)})
        cards.set(task.work_id, card); list.append(card)
      }
      card.hidden = !shown.includes(task)
      card.dataset.phase = task.phase
      const set = (selector, text) => { const node = card.querySelector(selector); node.textContent = text; node.title = text }
      set('[data-title]', task.title)
      set('[data-project]', task.project)
      set('[data-summary]', task.summary)
      set('[data-status]', !view.connected ? t("连接已断开") : task.cancelling ? t("正在停止") : STATUS[task.phase])
      set('[data-error]', task.error)
      card.querySelector('[data-summary]').hidden = !!task.error
      card.title = `${task.project} · ${task.title}`
      card.querySelector('[data-error]').hidden = !task.error
      card.querySelector('[data-open]').disabled = !view.connected || task.opening
      card.querySelector('[data-open]').title = platform === 'darwin' ? t("在 Finder 中打开项目") : t("在文件管理器中打开项目")
      card.querySelector('[data-stop]').disabled = !view.connected || task.cancelling || !RUNNING.has(task.phase)
    }
    container.querySelector('[data-task-count]').textContent = t("任务 · {0}", view.tasks.length)
    expand.hidden = view.tasks.length <= 3
    expand.textContent = expanded ? t("收起") : t("展开其余 {0} 个任务", Math.max(0, view.tasks.length - 3))
    expand.setAttribute('aria-expanded', String(expanded))
    const rows = view.visible ? Math.min(shown.length, 5) : 0
    if (reserved !== rows) {reserved = rows; void reserveArea(rows).then(applyLayout).catch(() => {container.hidden = true})}
    onChange(view)
  }
  const controller = createTaskBannerController({send, onChange: render})
  expand.addEventListener('click', () => {expanded = !expanded; render(controller.state())})
  container.querySelector('[data-task-hide]').addEventListener('click', () => controller.dismiss())
  const syncPause = () => hovered || focused ? controller.pause() : controller.resume()
  container.addEventListener('pointerenter', () => {hovered = true; syncPause()})
  container.addEventListener('pointerleave', () => {hovered = false; syncPause()})
  container.addEventListener('focusin', () => {focused = true; syncPause()})
  container.addEventListener('focusout', event => {focused = container.contains(event.relatedTarget); syncPause()})
  return Object.freeze({...controller, applyLayout, setPlatform(value) {platform = value; render(controller.state())}})
}

/** Durable task progress; decisions and unviewed results outrank tool activity. */
export function summarizeTasks(tasks,viewedResults=[]){
 const active=tasks.filter(task=>!['completed','cancelled'].includes(task.phase)),decisions=tasks.filter(task=>task.phase==='waiting'),results=tasks.filter(task=>task.phase==='completed'&&!viewedResults.includes(task.id))
 return {active:active.length,decisions:decisions.length,results:results.length,task_id:(decisions[0]??results[0]??active[0])?.id??null}
}
