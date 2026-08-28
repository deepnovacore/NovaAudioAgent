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

export function codexModeVisibility(mode) {
  const manual = mode === 'manual'
  return Object.freeze({
    manualConfigurationHidden: !manual,
    rescanHidden: manual,
  })
}

// Direct secret fields and the root `secrets` map are never public state. The
// same names are legitimate boolean fields inside `secretsPresent`, so that
// presence-only shape is sanitized separately instead of recursively denied.
const SECRET_KEY_NAMES = [
  'dashscopeApiKey',
  'tavilyApiKey',
  'modelApiKey',
  'codexApiKey',
  'arkApiKey',
  'doubaoBigmodelApiKey',
  'doubaoAsrApiKey',
]
const SECRET_KEYS = new Set(SECRET_KEY_NAMES)
const MAIN_LIVE_VIEW_FIELDS = [
  'codexStatus',
  'backendStatus',
  'backendDiagnostic',
  'backendRetryInMs',
  'settingsApplyStatus',
  'microphoneStatus',
  'effectivePaths',
]

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function publicValue(value) {
  if (Array.isArray(value)) {
    const safe = []
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) continue
      safe[key] = publicValue(descriptor.value)
    }
    return safe
  }
  if (!isRecord(value)) return value
  const safe = {}
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) continue
    safe[key] = publicValue(descriptor.value)
  }
  return safe
}

function presenceMap(value) {
  const safe = {}
  if (!isRecord(value)) return safe
  for (const key of SECRET_KEY_NAMES) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue
    if (typeof descriptor.value === 'boolean') safe[key] = descriptor.value
  }
  return safe
}

function publicPatch(value) {
  if (!isRecord(value)) return publicValue(value)
  const safe = {}
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) continue
    if (key === 'secrets' || SECRET_KEYS.has(key)) continue
    safe[key] = key === 'secretsPresent'
      ? presenceMap(descriptor.value)
      : publicValue(descriptor.value)
  }
  return safe
}

function writePatch(value) {
  if (!isRecord(value)) return {}
  const safe = {}
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) continue
    if (SECRET_KEYS.has(key)) continue
    // The direct write-only map must reach Main unchanged; it is never merged
    // into public state or a render snapshot.
    safe[key] = key === 'secrets'
      ? descriptor.value
      : key === 'secretsPresent'
        ? presenceMap(descriptor.value)
        : publicValue(descriptor.value)
  }
  return safe
}

function mainLiveViewPatch(value) {
  const safe = {}
  if (!isRecord(value)) return safe
  for (const field of MAIN_LIVE_VIEW_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) continue
    safe[field] = publicValue(descriptor.value)
  }
  return safe
}

export function createSettingsController({ api, render, status, notice = () => {} }) {
  let view = null
  let inFlight = null
  let pending = null
  let hasConfirmedSaveResponse = false
  let confirmedView = null
  let mainSyncRevision = 0
  let restartPending = false
  let restartTransitionSeen = false
  const drafts = new Map()

  function draftSnapshot() {
    const snapshot = {}
    for (const [field, value] of drafts) {
      if (field === 'secrets' || SECRET_KEYS.has(field)) continue
      snapshot[field] = field === 'secretsPresent' ? presenceMap(value) : publicValue(value)
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

  function publicRejections(patch, remote, prefix = '') {
    const rejected = []
    for (const [field, submitted] of Object.entries(publicPatch(patch))) {
      const path = prefix === '' ? field : `${prefix}.${field}`
      const received = isRecord(remote) ? remote[field] : undefined
      if (isRecord(submitted)) rejected.push(...publicRejections(submitted, received, path))
      else if (!Object.is(received, submitted)) rejected.push(path)
    }
    return rejected
  }

  function resolveBatch(batch, bridgeSaved, remoteView) {
    for (const waiter of batch.waiters) {
      const rejectedPublicFields = bridgeSaved
        ? publicRejections(waiter.publicPatch, remoteView)
        : []
      waiter.resolve({
        saved: bridgeSaved && rejectedPublicFields.length === 0,
        view: bridgeSaved ? remoteView : confirmedView,
        rejectedPublicFields,
      })
    }
  }

  function composeView(base) {
    return mergePatch(base, publicPatch(pending?.patch))
  }

  function announce(phase) {
    try { notice(phase) } catch { /* a UI observer cannot undo a committed settings write */ }
  }

  function applyFailurePhase() {
    if (confirmedView?.settingsApplyStatus === 'failed') return 'failed'
    if (confirmedView?.settingsApplyStatus === 'restart_failed') return 'restart_failed'
    return null
  }

  async function flush() {
    if (inFlight || !pending) return
    const batch = pending
    pending = null
    inFlight = batch
    const syncRevisionAtStart = mainSyncRevision
    status('保存中…')
    try {
      const remoteView = publicPatch(await api.set(batch.patch))
      const bridgeSaved = remoteView?.saved !== false
      const rejectedPublicFields = bridgeSaved
        ? publicRejections(batch.patch, remoteView)
        : []
      if (bridgeSaved) {
        hasConfirmedSaveResponse = true
        const liveMainState = mainSyncRevision === syncRevisionAtStart
          ? {}
          : mainLiveViewPatch(confirmedView)
        confirmedView = mergePatch(remoteView, liveMainState)
        syncTopLevelDrafts(batch.patch, remoteView)
        // The bridge response is authoritative for the completed batch. Public
        // edits still waiting behind it are reapplied before render, so an
        // older response cannot roll a local mode/provider selection back.
        view = composeView(confirmedView)
      } else {
        view = composeView(confirmedView ?? view)
      }
      renderCurrent()
      status(!bridgeSaved ? '保存失败'
        : rejectedPublicFields.length > 0 ? '部分设置未保存' : batch.note)
      if (
        bridgeSaved
        && rejectedPublicFields.length === 0
        && (remoteView?.rejectedSecrets?.length ?? 0) === 0
      ) {
        restartPending = true
        restartTransitionSeen = batch.restartTransitionSeen === true
          || (typeof confirmedView?.backendStatus === 'string'
            && confirmedView.backendStatus !== 'connected')
        announce('restarting')
        const failurePhase = applyFailurePhase()
        if (failurePhase !== null) {
          restartPending = false
          restartTransitionSeen = false
          announce(failurePhase)
        } else if (
          confirmedView?.settingsApplyStatus === 'applied'
          && restartTransitionSeen
          && confirmedView?.backendStatus === 'connected'
        ) {
          restartPending = false
          announce('complete')
        }
      }
      resolveBatch(batch, bridgeSaved, remoteView)
    } catch {
      view = composeView(confirmedView ?? view)
      renderCurrent()
      status('保存失败')
      resolveBatch(batch, false, null)
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
        pending.waiters.push({ resolve, publicPatch: publicPatch(patch) })
      } else {
        pending = {
          patch: writePatch(patch), note,
          restartTransitionSeen: false,
          waiters: [{ resolve, publicPatch: publicPatch(patch) }],
        }
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

  /** Apply a newer Main push while preserving edits that have not reached Main yet. */
  function syncView(nextView, {trackRestart = true} = {}) {
    // Any Main push is newer than an initial get still in flight, so that get may no longer replace it.
    hasConfirmedSaveResponse = true
    mainSyncRevision += 1
    if (
      trackRestart
      && inFlight !== null
      && typeof nextView?.backendStatus === 'string'
      && nextView.backendStatus !== 'connected'
    ) inFlight.restartTransitionSeen = true
    confirmedView = publicPatch(nextView)
    view = mergePatch(confirmedView, publicPatch(inFlight?.patch))
    view = composeView(view)
    renderCurrent()
    if (!restartPending) return
    const failurePhase = applyFailurePhase()
    if (failurePhase !== null) {
      restartPending = false
      restartTransitionSeen = false
      announce(failurePhase)
      return
    }
    if (!trackRestart || typeof confirmedView?.backendStatus !== 'string') return
    if (confirmedView.backendStatus !== 'connected') {
      restartTransitionSeen = true
    } else if (
      confirmedView.settingsApplyStatus === 'applied'
      && restartTransitionSeen
    ) {
      restartPending = false
      announce('complete')
    }
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
    syncView,
  }
}
