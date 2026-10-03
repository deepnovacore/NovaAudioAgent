import {t} from './locale.mjs'
import {EXECUTOR_PROGRESS, EXECUTOR_RESULT} from './wire-frame-types.mjs'
const DETAIL_MS = 6_000
const MILESTONE_MS = 12_000
const MAX_BUBBLES = 3
const PROGRESS_PHASES = new Set(['started', 'working', 'completed', 'failed', 'refused', 'unknown', 'cancelled', 'alert'])
const RESULT_OUTCOMES = new Set(['ok', 'failed', 'refused', 'unknown', 'cancelled'])

// Captions are cumulative user-visible replies, including streaming text before TTS ends.
export function parseConversationBubble(frame, mode) {
  if (mode !== 'all' || frame?.type !== 'caption' || frame.role !== 'assistant'
    || typeof frame.final !== 'boolean' || typeof frame.text !== 'string' || !frame.text.trim()) return null
  return {kind: 'conversation', delegateId: `reply-${frame.message_id ?? frame.sequence ?? ''}`,
    summary: frame.text.slice(0, 4000), level: 'milestone', ...workIdentity(frame)}
}

export function parseProgressFrame(frame) {
  if (!frame || typeof frame !== 'object'
    || frame.type !== EXECUTOR_PROGRESS
    || !validText(frame.delegate_id, 128)
    || !validText(frame.executor, 128)
    || !PROGRESS_PHASES.has(frame.phase)
    || !validSummary(frame.summary)
    || !['detail', 'milestone'].includes(frame.level)
    || !validTimestamp(frame.ts)) return null
  return Object.freeze({
    delegateId: frame.delegate_id,
    summary: frame.summary,
    level: frame.level,
    ts: frame.ts,
    ...workIdentity(frame),
  })
}

/** `null` clears only frame.work_id; `undefined` is a malformed frame. */
export function parseLastResultFrame(frame) {
  if (!frame || typeof frame !== 'object' || frame.type !== EXECUTOR_RESULT
    || !validText(frame.work_id, 128)
    || new TextEncoder().encode(JSON.stringify(frame)).length > 16 * 1024) return undefined
  if (frame.result === null) return null
  const result = frame.result
  if (!result || typeof result !== 'object'
    || result.delegate_id !== frame.work_id
    || !validText(result.delegate_id, 128)
    || (result.project !== undefined && !validProjectLabel(result.project))
    || (result.title !== undefined && !validProjectLabel(result.title))
    || !validText(result.executor, 128)
    || !RESULT_OUTCOMES.has(result.outcome)
    || !validSummary(result.summary)
    || (result.diagnostic !== undefined && !validDiagnostic(result.diagnostic))
    || !validTimestamp(result.started_at)
    || !validTimestamp(result.ended_at)
    || result.ended_at < result.started_at
    || !(result.changed_files === null
      || (Number.isSafeInteger(result.changed_files) && result.changed_files >= 0))) return undefined
  return Object.freeze({
    delegateId: result.delegate_id,
    ...(result.project === undefined ? {} : {project: result.project}),
    ...(result.title === undefined ? {} : {title: result.title}),
    executor: result.executor,
    outcome: result.outcome,
    summary: result.summary,
    ...(result.diagnostic === undefined ? {} : {diagnostic: result.diagnostic}),
    startedAt: result.started_at,
    endedAt: result.ended_at,
    changedFiles: result.changed_files,
  })
}

export function validProjectLabel(value) {
  return validText(value, 240) && [...value].length <= 120
}

// Both labels must come from the host frame; never infer an origin from spoken text.
function workIdentity(frame) {
  return validProjectLabel(frame.project) && validProjectLabel(frame.title)
    ? {project: frame.project, title: frame.title} : {}
}

/** Same bounded public roster is checked before renderer display and native menu IPC. */
export function parseProjectRoster(value) {
  if (!Array.isArray(value) || value.length > 10 || !value.every(entry =>
    entry && validProjectLabel(entry.name) && validTimestamp(entry.last_used_at)
    && Array.isArray(entry.running) && entry.running.length <= 64
    && entry.running.every(work => work && validText(work.work_id, 128) && validProjectLabel(work.title)))) return null
  return value.map(entry => ({name: entry.name, last_used_at: entry.last_used_at,
    running: entry.running.map(work => ({work_id: work.work_id, title: work.title}))}))
}

export function createProgressBubbleController({
  reserveBubbleArea,
  render,
  schedule = setTimeout,
  cancel = clearTimeout,
  now = Date.now,
  onLayout = () => {},
}) {
  let items = []
  let generation = 0
  let conversationGeneration = 0
  let latestConversationId = null
  const interruptedConversations = new Set()
  let queue = Promise.resolve()
  const timers = new Map()

  function enqueue(operation) {
    const run = queue.then(operation, operation)
    queue = run.catch(() => undefined)
    return run.catch(() => false)
  }

  function stop(item) {
    const timer = timers.get(item.key)
    if (timer !== undefined) cancel(timer)
    timers.delete(item.key)
  }

  function arm(item) {
    if (item.paused) return
    stop(item)
    timers.set(item.key, schedule(() => { void dismiss(item.key) }, Math.max(0, item.expiresAt - now())))
  }

  function clearVisible() {
    for (const item of items) stop(item)
    items = []
    render(items)
  }

  async function reserve(rows) {
    try {
      return await reserveBubbleArea(rows)
    } catch {
      return null
    }
  }

  async function update(next, version, conversationVersion = conversationGeneration) {
    const layout = await reserve(next.reduce((rows, item) => rows + (item.expanded ? 3 : 1), 0))
    if (layout === null || version !== generation) return false
    if (layout?.suppressed) {
      clearVisible()
      onLayout(layout)
      return false
    }
    if (conversationVersion !== conversationGeneration) next = next.filter(item => item.kind !== 'conversation')
    onLayout(layout)
    for (const item of items) {
      if (!next.some(nextItem => nextItem.key === item.key)) stop(item)
    }
    items = next
    render(items)
    return true
  }

  async function push(value) {
    if (!value || !(value.kind === 'conversation'
      ? typeof value.summary === 'string' && value.summary.length > 0 && value.summary.length <= 4000
      : validSummary(value.summary)) || !['detail', 'milestone'].includes(value.level)
      || (value.ts !== undefined && !validTimestamp(value.ts))) {
      return false
    }
    const version = generation
    const conversationVersion = conversationGeneration
    if (value.kind === 'conversation') {
      if (interruptedConversations.has(value.delegateId)) return false
      latestConversationId = value.delegateId
    }
    return enqueue(async () => {
      if (version !== generation || (value.kind === 'conversation'
        && conversationVersion !== conversationGeneration)) return false
      const lifetime = value.level === 'milestone' ? MILESTONE_MS : DETAIL_MS
      const delegateId = value.delegateId || value.delegate_id || ''
      const existing = value.kind === 'conversation'
        ? items.find(item => item.kind === 'conversation' && item.delegateId === delegateId) : undefined
      const item = {
        key: `${delegateId}:${value.ts ?? now()}:${value.summary}`,
        delegateId,
        kind: value.kind === 'conversation' ? 'conversation' : 'progress',
        summary: value.summary,
        ...workIdentity(value),
        level: value.level,
        ts: Number.isFinite(value.ts) ? value.ts : 0,
        paused: false,
        expanded: false,
        expiresAt: now() + lifetime,
      }
      if (existing) {
        // A streaming revision belongs to the same bubble: retain expansion and hover state.
        item.key = existing.key
        item.expanded = existing.expanded
        item.paused = existing.paused
        if (existing.paused) item.remainingMs = lifetime
      } else if (items.some(current => current.key === item.key)) return false
      const previous = items.filter(current => item.kind === 'conversation'
        ? current.kind !== 'conversation'
        : !item.delegateId || current.kind !== 'progress' || current.delegateId !== item.delegateId)
      const next = [item, ...previous].slice(0, MAX_BUBBLES)
      if (!await update(next, version, conversationVersion)) return false
      if (!items.includes(item)) return false
      arm(item)
      return true
    })
  }

  async function dismiss(key) {
    const version = generation
    return enqueue(async () => {
      if (version !== generation) return false
      const next = items.filter(item => item.key !== key && item.summary !== key)
      if (next.length === items.length) return false
      return update(next, version)
    })
  }

  function pause(key) {
    const item = items.find(candidate => candidate.key === key || candidate.summary === key)
    if (!item || item.paused) return
    item.paused = true
    item.expiresAt = Math.max(now(), item.expiresAt)
    item.remainingMs = item.expiresAt - now()
    stop(item)
  }

  function resume(key) {
    const item = items.find(candidate => candidate.key === key || candidate.summary === key)
    if (!item || !item.paused) return
    item.paused = false
    item.expiresAt = now() + item.remainingMs
    delete item.remainingMs
    arm(item)
  }

  async function toggleExpanded(key) {
    const version = generation
    return enqueue(async () => {
      const item = items.find(item => item.key === key)
      if (!item) return false
      const next = items.map(current => ({...current, expanded: current.key === key ? !item.expanded : false}))
      return update(next, version)
    })
  }

  function clearConversation() {
    conversationGeneration += 1
    if (latestConversationId !== null) {
      interruptedConversations.add(latestConversationId)
      if (interruptedConversations.size > 64) interruptedConversations.delete(interruptedConversations.values().next().value)
    }
    for (const item of items) if (item.kind === 'conversation') stop(item)
    items = items.filter(item => item.kind !== 'conversation')
    // Hide immediately, even while native bounds are still being reserved.
    render(items)
    return enqueue(() => update(items, generation))
  }

  function clear() {
    latestConversationId = null
    interruptedConversations.clear()
    generation += 1
    clearVisible()
    return enqueue(async () => {
      const layout = await reserve(0)
      if (layout === null) return false
      onLayout(layout)
      return true
    })
  }

  function applyLayout(layout) {
    onLayout(layout)
    if (!layout?.suppressed) return false
    generation += 1
    clearVisible()
    return true
  }

  return Object.freeze({
    push,
    dismiss,
    toggleExpanded,
    clearConversation,
    pause,
    resume,
    clear,
    applyLayout,
    get items() { return items },
  })
}

/** Attach the intentionally small DOM adapter; state/timers stay testable above. */
export function mountProgressBubbles({container, reserveBubbleArea, document = window.document}) {
  if (!container || typeof container.replaceChildren !== 'function') {
    throw new TypeError('bubble container is invalid')
  }
  const bubbles = createProgressBubbleController({
    reserveBubbleArea,
    render: items => {
      const focusedKey = document.activeElement?.closest('.progress-bubble')?.dataset.key
      container.replaceChildren(...items.map(item => {
        const bubble = document.createElement('div')
        bubble.className = 'progress-bubble'
        bubble.dataset.key = item.key
        bubble.dataset.level = item.level
        bubble.dataset.kind = item.kind
        bubble.dataset.expanded = String(item.expanded)
        const text = document.createElement('span')
        text.className = 'progress-bubble-text'
        if (item.project && item.title) {
          const origin = document.createElement('strong')
          origin.className = 'progress-bubble-origin'
          origin.textContent = `${item.project} · ${item.title}`
          origin.title = origin.textContent
          text.append(origin, document.createTextNode(item.summary))
        } else text.textContent = item.summary
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = 'progress-bubble-toggle'
        toggle.textContent = item.expanded ? t("收起") : t("展开")
        toggle.setAttribute('aria-expanded', String(item.expanded))
        toggle.addEventListener('click', () => { void bubbles.toggleExpanded(item.key) })
        bubble.append(text, toggle)
        bubble.addEventListener('pointerenter', () => bubbles.pause(item.key))
        bubble.addEventListener('pointerleave', () => bubbles.resume(item.key))
        bubble.addEventListener('focusin', () => bubbles.pause(item.key))
        bubble.addEventListener('focusout', event => {
          if (!bubble.contains(event.relatedTarget)) bubbles.resume(item.key)
        })
        return bubble
      }))
      // Native bounds have already been reserved, so overflow is measured at the final width.
      for (const bubble of container.children) {
        const text = bubble.querySelector('.progress-bubble-text')
        const toggle = bubble.querySelector('.progress-bubble-toggle')
        toggle.hidden = bubble.dataset.expanded !== 'true' && text.scrollHeight <= text.clientHeight + 1
        if (bubble.dataset.key === focusedKey) toggle.focus()
      }
    },
    onLayout: layout => {
      if (!layout) return
      container.dataset.placement = layout.bubblePlacement || 'above'
      container.dataset.alignment = layout.bubbleAlignment || 'center'
      container.style.setProperty('--bubble-orb-offset-x', `${layout.orbOffsetCssX || 0}px`)
      if (layout.suppressed) container.replaceChildren()
    },
  })
  return bubbles
}

function validText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function validSummary(value) {
  return validText(value, 180)
    && !/(^|\s)\/(?:Users|home|private|tmp|var|etc)(?:\/|\b)/u.test(value)
    && !/\b[A-Za-z]:[\\/]/u.test(value)
}

function validTimestamp(value) {
  return Number.isFinite(value) && value >= 0
}

export function validDiagnostic(value) {
  return value !== null && typeof value === "object" && validText(value.method, 128)
    && Number.isSafeInteger(value.server_code) && typeof value.message === "string" && value.message.length <= 4000
}
