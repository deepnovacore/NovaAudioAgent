import {EXECUTOR_TASKS, EXECUTOR_TASK_ACTION_RESULT} from './wire-frame-types.mjs'
import {parseProgressFrame, validProjectLabel} from './bubbles.mjs'

const RUNNING = new Set(['started', 'working'])
const AUTO_HIDE = new Set(['completed', 'cancelled'])
const PHASES = new Set([...RUNNING, ...AUTO_HIDE, 'failed', 'refused', 'unknown'])
const STATUS = {started: '已开始', working: '进行中', completed: '已完成', cancelled: '已停止', failed: '执行失败', refused: '请求被拒绝', unknown: '结果待确认'}

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
  let hidden = false, connected = false, paused = false, sequence = 0
  let terminalTimer = null, terminalId = null, terminalDue = 0, remaining = 8000
  const expired = new Set(), pending = new Map(), cancelling = new Set(), errors = new Map()
  const selected = () => tasks.find(task => task.work_id === selectedId) ?? null
  function stopTerminal() { if (terminalTimer !== null) cancel(terminalTimer); terminalTimer = null }
  function armTerminal() {
    stopTerminal()
    const item = selected()
    if (!item || !AUTO_HIDE.has(item.phase)) { terminalId = null; return }
    if (terminalId !== item.work_id) { terminalId = item.work_id; remaining = 8000 }
    if (paused || hidden || !connected) return
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
  function state() {
    const item = selected()
    return {tasks: tasks.map(task => ({...task})), selected: item ? {...item} : null,
      visible: !hidden && item !== null, connected, runningCount: tasks.filter(task => RUNNING.has(task.phase)).length,
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
  function action(action) {
    const item = selected()
    if (!connected || !item || !['open', 'cancel'].includes(action)
      || (action === 'cancel' && (!RUNNING.has(item.phase) || cancelling.has(item.work_id)))
      || [...pending.values()].some(p => p.work_id === item.work_id && p.action === action)) return false
    const request_id = `banner-${++sequence}-${now()}`
    const request = {type: 'executor.task_action', request_id, work_id: item.work_id, executor: item.executor, action}
    errors.delete(item.work_id)
    if (action === 'cancel') cancelling.add(item.work_id)
    const timer = schedule(() => {
      pending.delete(request_id); cancelling.delete(item.work_id)
      errors.set(item.work_id, '操作响应超时，请核对任务状态后重试。'); emit()
    }, 10000)
    pending.set(request_id, {...request, timer})
    if (!send(request)) {
      cancel(timer); pending.delete(request_id); cancelling.delete(item.work_id)
      errors.set(item.work_id, '连接不可用，请稍后重试。')
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
    const error = {not_running: '任务已结束，无法继续停止。', unavailable: '此任务的项目目录暂不可用。', failed: '操作未成功，请稍后重试。'}[result.status]
    if (error) errors.set(result.work_id, error)
    emit(); return true
  }
  return Object.freeze({state, receive, select, action, receiveActionResult,
    connect() { revision = -1; connected = false; clearPending(); emit() },
    disconnect() { connected = false; clearPending(); stopTerminal(); emit() },
    dismiss() { hidden = true; stopTerminal(); emit() },
    restore() { if (!tasks.length) return false; hidden = false; expired.clear(); choose(); armTerminal(); emit(); return true },
    pause() { if (paused) return; paused = true; if (terminalTimer !== null) remaining = Math.max(0, terminalDue - now()); stopTerminal() },
    resume() { if (!paused) return; paused = false; armTerminal() },
    dispose() { clearPending(); stopTerminal() },
  })
}

/** Stable DOM nodes preserve focus while progress text streams. */
export function mountTaskBanner({container, send, reserveArea, onChange = () => {}}) {
  const query = selector => container.querySelector(selector)
  const title = query('[data-task-title]'), summary = query('[data-task-summary]')
  const project = query('[data-task-project]'), status = query('[data-task-status]')
  const picker = query('[data-task-picker]'), error = query('[data-task-error]')
  const open = query('[data-task-open]'), stop = query('[data-task-stop]')
  let layout = null, reserved = false, hovered = false, focused = false
  function applyLayout(value) {
    layout = value
    container.dataset.placement = value?.bubblePlacement ?? 'above'
    container.style.setProperty('--task-banner-offset', `${(value?.bannerOffsetRows ?? 0) * 56}px`)
    container.hidden = !controller.state().visible || (value?.suppressed === true || value?.bannerSuppressed === true)
  }
  const controller = createTaskBannerController({send, onChange: view => {
    container.hidden = !view.visible || (layout?.suppressed === true || layout?.bannerSuppressed === true)
    const task = view.selected
    if (task) {
      container.dataset.phase = task.phase
      project.textContent = task.project
      title.textContent = task.title; title.title = task.title
      summary.textContent = task.summary; summary.title = task.summary
      status.textContent = !view.connected ? '连接已断开 · 状态待同步' : view.cancelling ? '正在停止' : STATUS[task.phase]
      open.disabled = !view.connected || view.opening
      stop.disabled = !view.connected || view.cancelling || !RUNNING.has(task.phase)
      error.textContent = view.error; error.hidden = !view.error
    }
    const optionsKey = JSON.stringify(view.tasks.map(t => [t.work_id, t.project, t.title, t.phase]))
    if (picker.dataset.options !== optionsKey) {
      picker.replaceChildren(...view.tasks.map((task, index) => {
        const option = container.ownerDocument.createElement('option')
        option.value = task.work_id; option.textContent = `${index + 1} / ${view.tasks.length} · ${task.project} · ${task.title} · ${STATUS[task.phase]}`
        return option
      }))
      picker.dataset.options = optionsKey
    }
    picker.value = task?.work_id ?? ''
    picker.closest('.task-banner-switch').hidden = view.tasks.length < 2
    query('[data-task-count]').textContent = `${Math.max(0, view.tasks.findIndex(t => t.work_id === task?.work_id)) + 1} / ${view.tasks.length}`
    picker.setAttribute('aria-label', `切换任务，共 ${view.tasks.length} 个`)
    if (reserved !== view.visible) {
      reserved = view.visible
      void reserveArea(reserved).then(applyLayout).catch(() => { container.hidden = true })
    }
    onChange(view)
  }})
  picker.addEventListener('change', () => controller.select(picker.value))
  open.addEventListener('click', () => controller.action('open'))
  stop.addEventListener('click', () => controller.action('cancel'))
  query('[data-task-hide]').addEventListener('click', () => controller.dismiss())
  const syncPause = () => hovered || focused ? controller.pause() : controller.resume()
  container.addEventListener('pointerenter', () => { hovered = true; syncPause() })
  container.addEventListener('pointerleave', () => { hovered = false; syncPause() })
  container.addEventListener('focusin', () => { focused = true; syncPause() })
  container.addEventListener('focusout', event => { focused = container.contains(event.relatedTarget); syncPause() })
  return Object.freeze({...controller, applyLayout, setPlatform(platform) {
    const label = platform === 'darwin' ? '在 Finder 中打开项目' : '在文件管理器中打开项目'
    open.title = label; open.setAttribute('aria-label', label)
  }})
}
