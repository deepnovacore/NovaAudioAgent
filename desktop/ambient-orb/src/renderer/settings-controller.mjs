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

function publicPatch(patch) {
  const { secrets: _writeOnlySecrets, ...publicFields } = patch ?? {}
  return publicFields
}

export function createSettingsController({ api, render, status }) {
  let view = null
  let inFlight = null
  let pending = null
  let hasSaveResponse = false
  const drafts = new Map()

  function draftSnapshot() {
    return Object.fromEntries(drafts)
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

  async function flush() {
    if (inFlight || !pending) return
    const batch = pending
    pending = null
    inFlight = batch
    status('保存中…')
    try {
      const remoteView = await api.set(batch.patch)
      const saved = remoteView?.saved !== false
      hasSaveResponse = true
      syncTopLevelDrafts(batch.patch, remoteView)
      // The bridge response is authoritative for the completed batch. Public
      // edits still waiting behind it are reapplied before render, so an older
      // response cannot roll a local mode/provider selection backwards.
      view = mergePatch(remoteView, publicPatch(pending?.patch))
      renderCurrent()
      status(saved ? batch.note : '保存失败')
      resolveBatch(batch, { saved, view: remoteView })
    } catch {
      status('保存失败')
      resolveBatch(batch, { saved: false, view: null })
    } finally {
      inFlight = null
      void flush()
    }
  }

  function push(patch, note) {
    return new Promise(resolve => {
      if (pending) {
        pending.patch = mergePatch(pending.patch, patch)
        pending.note = note
        pending.waiters.push({ resolve })
      } else {
        pending = { patch, note, waiters: [{ resolve }] }
      }
      void flush()
    })
  }

  function setView(nextView) {
    // An initial get that races behind a completed set is older state and must
    // not roll the panel back. Before any set response, retain selections
    // already queued behind that initial get.
    if (hasSaveResponse) return
    view = mergePatch(nextView, publicPatch(inFlight?.patch))
    view = mergePatch(view, publicPatch(pending?.patch))
    renderCurrent()
  }

  function applyLocal(patch) {
    view = mergePatch(view, publicPatch(patch))
    renderCurrent()
  }

  function setDraft(field, value) {
    drafts.set(field, value)
  }

  function getDraft(field) {
    return drafts.get(field)
  }

  function clearDraftIfEqual(field, submitted) {
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
    const cleared = accepted.filter(key => clearDraftIfEqual(key, secrets[key]))
    return { ...result, rejected, accepted, cleared }
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
