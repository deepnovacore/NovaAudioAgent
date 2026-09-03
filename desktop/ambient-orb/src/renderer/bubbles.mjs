const DETAIL_MS = 6_000
const MILESTONE_MS = 12_000
const MAX_BUBBLES = 3
const PROGRESS_PHASES = new Set(['started', 'working', 'completed', 'failed', 'refused', 'unknown', 'cancelled', 'alert'])
const RESULT_OUTCOMES = new Set(['ok', 'failed', 'refused', 'unknown', 'cancelled'])

export function parseProgressFrame(frame) {
  if (!frame || typeof frame !== 'object'
    || frame.type !== 'executor.progress'
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
  })
}

/** `null` is the retained-result reset; `undefined` is a malformed frame. */
export function parseLastResultFrame(frame) {
  if (!frame || typeof frame !== 'object' || frame.type !== 'executor.result') return undefined
  if (frame.result === null) return null
  const result = frame.result
  if (!result || typeof result !== 'object'
    || !validText(result.delegate_id, 128)
    || !validText(result.executor, 128)
    || !RESULT_OUTCOMES.has(result.outcome)
    || !validSummary(result.summary)
    || !validTimestamp(result.started_at)
    || !validTimestamp(result.ended_at)
    || result.ended_at < result.started_at
    || !(result.changed_files === null
      || (Number.isSafeInteger(result.changed_files) && result.changed_files >= 0))) return undefined
  return Object.freeze({
    delegateId: result.delegate_id,
    executor: result.executor,
    outcome: result.outcome,
    summary: result.summary,
    startedAt: result.started_at,
    endedAt: result.ended_at,
    changedFiles: result.changed_files,
  })
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

  async function update(next, version) {
    const layout = await reserve(next.length)
    if (layout === null || version !== generation) return false
    if (layout?.suppressed) {
      clearVisible()
      onLayout(layout)
      return false
    }
    onLayout(layout)
    for (const item of items) {
      if (!next.some(nextItem => nextItem.key === item.key)) stop(item)
    }
    items = next
    render(items)
    return true
  }

  async function push(value) {
    if (!value || !validSummary(value.summary) || !['detail', 'milestone'].includes(value.level)
      || (value.ts !== undefined && !validTimestamp(value.ts))) {
      return false
    }
    const version = generation
    return enqueue(async () => {
      if (version !== generation) return false
      const lifetime = value.level === 'milestone' ? MILESTONE_MS : DETAIL_MS
      const delegateId = value.delegateId || value.delegate_id || ''
      const item = {
        key: `${delegateId}:${value.ts ?? now()}:${value.summary}`,
        delegateId,
        summary: value.summary,
        level: value.level,
        ts: Number.isFinite(value.ts) ? value.ts : 0,
        paused: false,
        expiresAt: now() + lifetime,
      }
      if (items.some(current => current.key === item.key)) return false
      const next = [item, ...items].slice(0, MAX_BUBBLES)
      if (!await update(next, version)) return false
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

  function clear() {
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
      container.replaceChildren(...items.map(item => {
        const bubble = document.createElement('button')
        bubble.type = 'button'
        bubble.className = 'progress-bubble'
        bubble.dataset.level = item.level
        bubble.textContent = item.summary
        bubble.addEventListener('click', () => { void bubbles.dismiss(item.key) })
        bubble.addEventListener('pointerenter', () => bubbles.pause(item.key))
        bubble.addEventListener('pointerleave', () => bubbles.resume(item.key))
        bubble.addEventListener('focus', () => bubbles.pause(item.key))
        bubble.addEventListener('blur', () => bubbles.resume(item.key))
        return bubble
      }))
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
