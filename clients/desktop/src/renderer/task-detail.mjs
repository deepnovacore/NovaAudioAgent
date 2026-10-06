import { t } from './locale.mjs'
import { TASK_PHASE_LABEL, taskWaitingLabel } from './tasks-page.mjs'
export const taskDraftKey = (clientId, taskId, sessionId) => `nova:task-draft:${JSON.stringify([clientId, taskId, sessionId])}`
const el = (tag, text) => {
  const n = document.createElement(tag)
  if (text !== undefined)
    n.textContent = text
  return n
}
const TASK_ERROR = {
  stale_task: '任务已在别处更新，已刷新，请重试', not_controller: '该任务正由另一客户端控制', task_terminal: '任务已结束', task_effect_unknown: '上一步执行结果待核对', task_input_reconciliation_required: '有尚未处理的回复，请稍后重试', task_recovery_in_progress: '任务正在恢复，请稍后重试', task_control_unavailable: '此客户端不能接管任务', nothing_to_reconcile: '没有需要核对的执行', todo_not_in_conflict: 'Todo 已处理', todo_not_found: 'Todo 已删除或取消', todo_changed: 'Todo 刚被修改，请重新核对后再标记', execution_in_flight: '执行仍在进行，请等待结果后再核对', session_not_found: '该会话已不可用', task_input_unavailable: '执行器暂不接受输入', task_execution_unavailable: '执行器暂不可用', request_conflict: '请求冲突，请刷新后重试', task_retired: '该任务已归档', session_active: '该会话正被另一个未完成的任务使用', unavailable: 'Nova 暂不可用，请稍后重试'
};
/** Host failures arrive as codes; show a readable sentence and never the raw code. */
export const taskErrorText = message => t(Object.hasOwn(TASK_ERROR, message) ? TASK_ERROR[message] : /^[a-z0-9_]+$/.test(message ?? '') ? '操作未完成，请刷新后重试' : message);
/** Sessions are shown by position until executors report titles; the raw id stays in the tooltip. */
const EXECUTOR_NAME = { codex: 'Codex', 'claude-code': 'Claude Code', claude: 'Claude Code', midscene: 'Midscene' };
/** Sessions by position, prefixed with their executor and marked when they are where the task continues by default. */
const sessionLabel = (ids, id, detail) => {
  const index = (ids ?? []).indexOf(id)
  if (index < 0)
    return t('尚无会话')
  const executor = detail?.works?.find(work => work.session_id === id)?.executor
  const name = executor ? EXECUTOR_NAME[executor] ?? executor : ''
  const label = name ? t('{0} 会话 {1}', name, index + 1) : t('会话 {0}', index + 1)
  return detail?.primary_session_id === id && ids.length > 1 ? t('{0}（默认）', label) : label
}
const EVIDENCE_KIND = { 'task-work': '执行结果', 'task-delivery': 'Nova 交付', 'task-attested': '你已核对', 'task-input': '你的回复' }
const evidenceLabel = ref => {
  const kind = String(ref).split(':')[0]
  return t(Object.hasOwn(EVIDENCE_KIND, kind) ? EVIDENCE_KIND[kind] : '依据')
};
/** A criterion with the evidence Nova cited for it once the task is verified. */
function criterionItem(text, refs) {
  const item = el('li', text)
  if (refs?.length) {
    const proof = el('small', ' · ' + t('依据：{0}', [...new Set(refs.map(evidenceLabel))].join('、')))
    proof.title = refs.join('\n')
    item.append(proof)
  }
  return item
}
const artifactLabel = ref => String(ref).split(/[\\/]/).filter(Boolean).at(-1) ?? String(ref)
function publicEventSummary(event) {
  if (event.kind === 'status')
    return taskWaitingLabel(event.text)
  if (!['verification', 'control'].includes(event.kind))
    return null
  try {
    const value = JSON.parse(event.text)
    if (event.kind === 'verification') {
      if (value.kind === 'complete' && Array.isArray(value.evidence_refs))
        return t('验收通过')
      if (value.kind === 'correct' && typeof value.instruction === 'string')
        return t('需要修正：{0}', value.instruction)
      if (value.kind === 'wait' && typeof value.reason === 'string')
        return t('等待处理：{0}', taskWaitingLabel(value.reason))
    }
    const label = {
      takeover: '已接管任务', return: '已交还 Nova', continue: '已继续任务', cancel: '任务已停止', reconcile: '已核对执行结果', input_before_handback: '交还前已发送的消息已送达执行器', goal_revised: '任务目标已更新', controller_changed: '任务控制已更新'
    }[value.operation]
    return label ? t(label) : null
  }
  catch {
    return null
  }
}
/** A persistent inspector. Only receipted host control opens the separate executor composer. */
export function mountTaskDetail(root, { command, onClose, onViewed = () => { }, after = 0, history = { items: new Map(), cursor: 0, incomplete: false, truncated: false }, storage = globalThis.localStorage }) {
  let cursor = history.cursor, viewedCursor = after, visible = true, incomplete = history.incomplete, truncated = history.truncated
  const publicEvents = history.items
  let detail = null, session = '', draftState = {}, busy = false, disposed = false, eventKey = '', approvalKey = '', refreshing = null, refreshAgain = false
  const changes = el('p'), title = el('h2', t('任务详情')), goal = el('p'), criteriaTitle = el('h3', t('验收条件')), status = el('p'), summary = el('ul'), recipient = el('p'), notice = el('p'), error = el('p'), activity = el('section'), activityMore = el('div'), artifacts = el('section'), approvals = el('section'), controls = el('div'), composer = el('div')
  root.className = 'task-detail'
  goal.className = 'task-goal'
  summary.className = 'task-criteria'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  error.setAttribute('role', 'alert')
  activity.setAttribute('aria-label', t('公开活动'))
  approvals.setAttribute('aria-label', t('任务审批'))
  const button = (label, action, parent = controls) => {
    const b = el('button', t(label))
    b.type = 'button'
    b.addEventListener('click', action)
    parent.append(b)
    return b
  }
  const back = button('返回任务卡片', () => onClose(), root)
  const select = el('select')
  select.setAttribute('aria-label', t('执行器会话'))
  select.addEventListener('change', () => { save(); session = select.value; load(); render(); })
  const draft = el('textarea')
  draft.maxLength = 16000
  draft.setAttribute('aria-label', t('回复执行器'))
  draft.addEventListener('input', () => {
    draftState.text = draft.value
    draftState.control_revision = detail?.control_revision
    save()
    render()
  })
  const fence = () => ({ task_id: detail.id, control_revision: detail.control_revision, goal_revision: detail.goal_revision })
  const owned = () => detail?.controller.kind === 'user' && detail.controller.client_id === detail.viewer?.client_id
  const key = () => detail?.viewer?.client_id && session ? taskDraftKey(detail.viewer.client_id, detail.id, session) : null
  function save() {
    const k = key()
    if (k)
      try {
        storage?.setItem(k, JSON.stringify(draftState))
      }
      catch {
        error.textContent = t('无法保存本地草稿，请保留此窗口。')
      }
  }
  function load() {
    draftState = {}
    const k = key()
    if (k)
      try {
        draftState = JSON.parse(storage?.getItem(k) || '{}')
      }
      catch { }
    draft.value = draftState.text ?? ''
  }
  async function refresh() {
    if (disposed || !detail)
      return
    if (refreshing) {
      refreshAgain = true
      return refreshing
    }
    refreshing = (async () => {
      do {
        refreshAgain = false
        const result = await command('tasks.get', {
          task_id: detail.id, after: cursor, ...(draftState.pending ? { input_request_id: draftState.pending.request_id } : {})
        })
        if (!disposed)
          update(result)
      } while (refreshAgain && !disposed)
    })()
    try {
      await refreshing
    }
    finally {
      refreshing = null
      render()
    }
  }
  async function act(method, params) {
    if (busy)
      return
    busy = true
    error.textContent = ''
    render()
    try {
      const result = await command(method, params)
      if (result?.id)
        update({ ...detail, ...result })
      await refresh()
    }
    catch (e) {
      error.textContent = taskErrorText(e.message)
      await refresh().catch(() => { })
    }
    finally {
      busy = false
      render()
    }
  }
  const take = button('接管并回复', () => act('tasks.control', { ...fence(), action: 'takeover' }))
  const takeHint = el('p', t('接管后由你直接给执行器发消息，Nova 暂停自动修正；交还后 Nova 继续推进。'))
  takeHint.className = 'task-take-hint'
  controls.append(takeHint)
  const handback = button('交还 Nova', () => act('tasks.control', { ...fence(), action: 'return' }))
  const stop = button('停止任务', () => act('tasks.cancel', fence()))
  const resume = button('继续任务', () => act('tasks.continue', fence()))
  const markDone = button('已核对：已执行', () => act('tasks.reconcile', { ...fence(), resolution: 'done' })), markNotRun = button('已核对：未执行', () => act('tasks.reconcile', { ...fence(), resolution: 'not_run' }))
  const closeTodo = button('标记 Todo 完成', () => act('tasks.complete_todo', { ...fence(), todo_version: detail.capabilities?.todo?.version }))
  markDone.title = markNotRun.title = t('Nova 无法确认上一步是否已执行；请在项目中核对后选择')
  const more = button('加载更多活动', () => refresh().catch(e => { error.textContent = taskErrorText(e.message); }), activityMore)
  more.hidden = true
  const reconcile = button('刷新发送状态', () => refresh().catch(e => { error.textContent = taskErrorText(e.message); }))
  const submit = button('发送给执行器', async () => {
    if (draft.disabled || !draft.value.trim())
      return
    const sentSession = session, sentKey = key(), state = draftState, params = { ...fence(), session_id: session, text: draft.value }, request_id = crypto.randomUUID()
    state.pending = { request_id, params }
    save()
    busy = true
    render()
    try {
      const receipt = await command('tasks.input', params, { request_id })
      if (receipt?.status === 'accepted') {
        state.text = ''
        delete state.pending
        if (session === sentSession)
          draft.value = ''
      }
      else
        error.textContent = t('发送状态待确认，草稿已保留。')
    }
    catch (e) {
      error.textContent = taskErrorText(e.message)
      if (e.input_status === 'failed')
        delete state.pending
    }
    finally {
      if (sentKey)
        try {
          storage?.setItem(sentKey, JSON.stringify(state))
        }
        catch { }
      busy = false
      render()
      await refresh().catch(() => { })
    }
  }, composer)
  composer.append(recipient, draft)
  root.append(title, goal, status, changes, criteriaTitle, summary, select, notice, controls, approvals, activity, activityMore, artifacts, composer, error)
  function render() {
    if (!detail)
      return
    const caps = detail.capabilities ?? {}, terminal = ['completed', 'cancelled'].includes(detail.phase)
    goal.textContent = detail.goal
    summary.replaceChildren(...(detail.acceptance ?? []).map((text, index) => criterionItem(text, detail.criteria_evidence?.find(item => item.index === index)?.evidence_refs)))
    summary.hidden = criteriaTitle.hidden = !(detail.acceptance ?? []).length
    status.setAttribute('aria-busy', String(busy))
    const statusText = `${busy ? t('正在处理…') + ' · ' : ''}${t(TASK_PHASE_LABEL[detail.phase] ?? detail.phase)} · ${owned() ? t('由你控制') : detail.controller.kind === 'nova' ? t('Nova 控制') : t('由另一客户端控制')}${detail.waiting_reason ? ` · ${taskWaitingLabel(detail.waiting_reason)}` : ''}${detail.todo_sync === 'conflict' ? t(' · Todo 已变更，未自动完成') : ''}`
    if (status.textContent !== statusText)
      status.textContent = statusText
    const noSession = !(detail.session_ids ?? []).length
    select.hidden = noSession
    composer.hidden = noSession
    take.textContent = t(noSession ? '接管任务' : '接管并回复')
    notice.textContent = noSession && detail.execution_route === 'nova' ? t('此任务由 Nova 直接交付，无执行器会话。') : caps.detail === 'summary-only' ? t('此执行器仅提供任务摘要。') : caps.input === false ? t('执行器输入暂不可用，请先确认恢复状态。') : ''
    recipient.textContent = t('发送至执行器会话：{0}{1}', session ? sessionLabel(detail.session_ids, session, detail) : t('尚无会话'), draftState.text && draftState.control_revision !== detail.control_revision ? t(' · 上一控制期间的草稿（不会自动发送）') : '')
    draft.disabled = busy || !owned() || !detail.viewer?.client_id || !session || !caps.input || terminal || Boolean(draftState.pending)
    submit.disabled = draft.disabled || !draft.value?.trim()
    takeHint.hidden = owned() || terminal
    take.hidden = owned() || terminal
    take.disabled = busy || !detail.viewer?.can_takeover
    handback.hidden = !owned()
    handback.disabled = busy;
    // While Nova holds control, the user may still stop the task or decide how a waiting task moves on.
    const decide = owned() || detail.controller.kind === 'nova'
    stop.hidden = terminal
    stop.disabled = busy || !decide
    resume.hidden = !(detail.phase === 'waiting' || (detail.phase === 'completed' && caps.todo_retry))
    resume.disabled = busy || Boolean(caps.reconcile) || (!decide && !caps.todo_retry)
    closeTodo.hidden = !(detail.phase === 'completed' && caps.todo_conflict && caps.todo)
    closeTodo.disabled = busy
    if (caps.todo)
      closeTodo.title = t('将 Todo「{0}」标记为完成', caps.todo.title)
    markDone.hidden = markNotRun.hidden = !(detail.phase === 'waiting' && caps.reconcile)
    markDone.disabled = markNotRun.disabled = busy || !decide
    more.disabled = Boolean(refreshing)
    reconcile.hidden = !draftState.pending
    select.disabled = busy || !(detail.session_ids ?? []).length
  }
  function update(next) {
    if (disposed || !next)
      return
    const oldKey = key(), prior = detail
    detail = next
    if (!next.session_ids?.includes(session))
      session = next.session_ids?.includes(next.primary_session_id) ? next.primary_session_id : next.session_ids?.[0] ?? ''
    if (JSON.stringify([prior?.session_ids, prior?.works, prior?.primary_session_id]) !== JSON.stringify([next.session_ids, next.works, next.primary_session_id])) {
      select.replaceChildren()
      for (const id of next.session_ids ?? []) {
        const opt = el('option', sessionLabel(next.session_ids, id, next))
        opt.value = id
        opt.title = id
        select.append(opt)
      }
    }
    select.value = session
    if (oldKey !== key())
      load()
    if (draftState.pending && next.input_receipt?.request_id === draftState.pending.request_id) {
      if (next.input_receipt.status === 'accepted') {
        draft.value = ''
        draftState.text = ''
        delete draftState.pending
        save()
      }
      else if (next.input_receipt.status === 'failed') {
        delete draftState.pending
        save()
      }
    }
    const events = next.events ?? { items: [] }
    more.hidden = (events.items ?? []).length < 100
    incomplete ||= Boolean(events.incomplete)
    truncated ||= Boolean(events.truncated)
    for (const event of events.items ?? [])
      if (Number.isSafeInteger(event.seq))
        publicEvents.set(event.seq, event)
    if (Number.isSafeInteger(events.next))
      cursor = Math.max(cursor, events.next)
    changes.textContent = t('自上次查看后有 {0} 条新活动', [...publicEvents.keys()].filter(seq => seq > viewedCursor).length)
    history.cursor = cursor
    history.incomplete = incomplete
    history.truncated = truncated
    if (visible)
      onViewed(detail.id, cursor, detail.phase)
    const newKey = JSON.stringify([[...publicEvents.values()], incomplete, truncated, next.artifact_refs])
    if (newKey !== eventKey) {
      eventKey = newKey
      activity.replaceChildren()
      if (incomplete)
        activity.append(el('p', t('部分公开活动缺失，请核对执行器与任务结果。')))
      if (truncated)
        activity.append(el('p', t('较早活动已截断；任务与发送回执仍保留。')))
      for (const event of publicEvents.values()) {
        const row = el('article')
        const readable = publicEventSummary(event)
        row.append(el('small', `${t(({
          nova: 'Nova', 'user-to-executor': '你 → 执行器', executor: '执行器', verification: '验证', control: '控制', status: '状态', tool: '工具', artifact: '产物'
        })[event.sender ?? event.kind] ?? event.kind ?? '活动')}${event.session_id ? ` · ${sessionLabel(next.session_ids, event.session_id)}` : ''}`), el('p', readable ?? event.text))
        if (readable !== null || event.refs?.length) {
          const receipt = el('details')
          receipt.append(el('summary', t('公开回执与依据')), el('pre', [event.text, ...event.refs ?? []].join('\n')))
          row.append(receipt)
        }
        activity.append(row)
      }
      artifacts.replaceChildren()
      if (next.artifact_refs?.length)
        artifacts.append(el('h3', t('产物引用')))
      for (const ref of next.artifact_refs ?? []) {
        const item = el('p', artifactLabel(ref))
        item.title = String(ref)
        artifacts.append(item)
      }
    }
    const approvalJSON = JSON.stringify(next.approvals)
    if (approvalJSON !== approvalKey) {
      approvalKey = approvalJSON
      approvals.replaceChildren()
      for (const approval of next.approvals ?? []) {
        const row = el('article')
        row.append(el('p', approval.operation_summary ?? t('等待审批')))
        if (approval.local_detail)
          row.append(el('pre', JSON.stringify(approval.local_detail, null, 2)))
        for (const [decision, label] of [['accept', '允许一次'], ['decline', '拒绝']]) {
          if (approval.allowed_decisions && !approval.allowed_decisions.includes(decision))
            continue
          const b = button(label, () => act('conversations.approve', { id: next.conversation_id, approval_id: approval.pending_approval_id, approved: decision === 'accept' }), row)
          b.disabled = approval.pending_approval_busy
        }
        approvals.append(row)
      }
    }
    render()
  }
  const escape = e => { if (e.key === 'Escape') {
    e.preventDefault()
    onClose()
  } }
  root.addEventListener('keydown', escape)
  return {
    update, setVisible(value) {
      if (visible === value)
        return
      if (!value)
        viewedCursor = cursor
      visible = value
      if (value) {
        onViewed(detail?.id, cursor, detail?.phase)
        void refresh().catch(e => { error.textContent = taskErrorText(e.message); })
      }
    }, focus() { back.focus(); }, receive: frame => {
      if (frame.type === 'personal.state' && detail && visible) {
        const latest = frame.tasks?.find(t => t.id === detail.id)
        if (latest)
          update({ ...detail, ...latest })
        void refresh().catch(e => { error.textContent = taskErrorText(e.message); })
      }
    }, dispose() { save(); disposed = true; root.removeEventListener?.('keydown', escape); }, focusApproval() { (approvals.querySelector?.('button') ?? back).focus(); }
  }
}
