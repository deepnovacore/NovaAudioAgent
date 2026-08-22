// The renderer's state machine is deliberately independent of the DOM so a
// deferred settings bridge can be exercised deterministically. Secret patches
// are write-only: they never enter `view`, drafts, or rendered state.
export function mergePatch(base, next) {
  const merged = { ...(base ?? {}) }
  for (const [field, value] of Object.entries(next ?? {})) {
    const existing = merged[field]
    const bothObjects = value && typeof value === 'object'
      && existing && typeof existing === 'object'
    merged[field] = bothObjects ? { ...existing, ...value } : value
  }
  return merged
}

// This is the single boundary denylist for Settings secrets. Public renderer
// state may not carry these keys at any depth; only a direct `secrets` write
// payload is allowed to cross the bridge.
const SECRET_KEYS = new Set([
  'dashscopeApiKey',
  'tavilyApiKey',
  'modelApiKey',
  'codexApiKey',
  'arkApiKey',
  'doubaoBigmodelApiKey',
  'doubaoAsrApiKey',
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function publicPatch(value) {
  if (Array.isArray(value)) return value.map(publicPatch)
  if (!isRecord(value)) return value
  const safe = {}
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'secrets' || SECRET_KEYS.has(key)) continue
    safe[key] = publicPatch(nested)
  }
  return safe
}

function writePatch(value) {
  if (!isRecord(value)) return {}
  const safe = {}
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) continue
    // The direct write-only map must reach Main unchanged; it is never merged
    // into public state or a render snapshot.
    safe[key] = key === 'secrets' ? nested : publicPatch(nested)
  }
  return safe
}

export function createSettingsController({ api, render, status }) {
  let view = null
  let inFlight = null
  let pending = null
  let hasConfirmedSaveResponse = false
  let confirmedView = null
  const drafts = new Map()

  function draftSnapshot() {
    const snapshot = {}
    for (const [field, value] of drafts) {
      if (field === 'secrets' || SECRET_KEYS.has(field)) continue
      snapshot[field] = publicPatch(value)
    }
    return snapshot
  }

  function renderCurrent() {
    if (view) render(view, draftSnapshot())
  }

  function syncTopLevelDrafts(patch, remoteView) {
    for (const [field, submitted] of Object.entries(publicPatch(patch))) {
      if (submitted && typeof submitted === 'object') continue
      if (drafts.get(field) === submitted && remoteView?.[field] === submitted) {
        drafts.delete(field)
      }
    }
  }

  function resolveBatch(batch, result) {
    for (const waiter of batch.waiters) waiter.resolve(result)
  }

  function composeView(base) {
    return mergePatch(base, publicPatch(pending?.patch))
  }

  async function flush() {
    if (inFlight || !pending) return
    const batch = pending
    pending = null
    inFlight = batch
    status('保存中…')
    try {
      const remoteView = publicPatch(await api.set(batch.patch))
      const saved = remoteView?.saved !== false
      if (saved) {
        hasConfirmedSaveResponse = true
        confirmedView = remoteView
        syncTopLevelDrafts(batch.patch, remoteView)
        // The bridge response is authoritative for the completed batch. Public
        // edits still waiting behind it are reapplied before render, so an
        // older response cannot roll a local mode/provider selection back.
        view = composeView(confirmedView)
      } else {
        view = composeView(confirmedView ?? view)
      }
      renderCurrent()
      status(saved ? batch.note : '保存失败')
      resolveBatch(batch, { saved, view: saved ? remoteView : confirmedView })
    } catch {
      view = composeView(confirmedView ?? view)
      renderCurrent()
      status('保存失败')
      resolveBatch(batch, { saved: false, view: null })
    } finally {
      // A secret payload must not live past the single bridge invocation.
      batch.patch = null
      inFlight = null
      void flush()
    }
  }

  function push(patch, note) {
    return new Promise(resolve => {
      if (pending) {
        pending.patch = mergePatch(pending.patch, writePatch(patch))
        pending.note = note
        pending.waiters.push({ resolve })
      } else {
        pending = { patch: writePatch(patch), note, waiters: [{ resolve }] }
      }
      void flush()
    })
  }

  function setView(nextView) {
    // An initial get that races behind a completed set is older state and must
    // not roll the panel back. Before any set response, retain selections
    // already queued behind that initial get.
    if (hasConfirmedSaveResponse) return
    confirmedView = publicPatch(nextView)
    view = mergePatch(confirmedView, publicPatch(inFlight?.patch))
    view = composeView(view)
    renderCurrent()
  }

  function applyLocal(patch) {
    view = mergePatch(view, publicPatch(patch))
    renderCurrent()
  }

  function setDraft(field, value) {
    // Password values stay only in their DOM inputs and the short-lived write
    // payload. They are never a controller draft or a render callback value.
    if (field === 'secrets' || SECRET_KEYS.has(field)) return
    drafts.set(field, value)
  }

  function getDraft(field) {
    return drafts.get(field)
  }

  function clearDraftIfEqual(field, submitted) {
    if (field === 'secrets' || SECRET_KEYS.has(field)) return false
    if (drafts.get(field) !== submitted) return false
    drafts.delete(field)
    return true
  }

  async function saveSecrets(secrets) {
    const result = await push({ secrets }, '密钥已保存')
    const rejected = result.saved
      ? Object.keys(secrets).filter(key => result.view?.rejectedSecrets?.includes(key))
      : []
    const accepted = result.saved
      ? Object.keys(secrets).filter(key => !rejected.includes(key))
      : []
    return { ...result, rejected, accepted }
  }

  return {
    applyLocal,
    clearDraftIfEqual,
    getDraft,
    push,
    saveSecrets,
    setDraft,
    setView,
  }
}
