const CANCEL_RESPONSE = 1
const MANAGED_WORKSPACE_HEALTH = new Set([
  'ready',
  'degraded',
  'cleanup_pending',
  'rollback_pending',
  'unavailable',
])

function bounded(status) {
  return Object.freeze({status})
}

export function publicManagedWorkspaceCapabilities(capabilities) {
  const health = MANAGED_WORKSPACE_HEALTH.has(capabilities?.health)
    ? capabilities.health
    : 'unavailable'
  return Object.freeze({
    health,
    current: Object.freeze({
      available: capabilities?.current?.available === true,
      displayName: typeof capabilities?.current?.display_name === 'string'
        ? capabilities.current.display_name
        : null,
    }),
    all: Object.freeze({
      available: capabilities?.all?.available === true,
      count: Number.isSafeInteger(capabilities?.all?.count) && capabilities.all.count >= 0
        ? capabilities.all.count
        : 0,
    }),
  })
}

export function createManagedWorkspaceBackendRecovery({
  getCapabilities,
  refreshCapabilities,
  startBackend,
  restartBackend,
  retryBackend,
  stopBackend,
}) {
  let recoveryStatus = 'idle'

  const observe = async capabilities => {
    if (capabilities?.health !== 'rollback_pending') return bounded(recoveryStatus)
    const alreadyFailed = recoveryStatus === 'failed'
    recoveryStatus = alreadyFailed ? 'failed' : 'required'
    let stopped = false
    try {
      stopped = await stopBackend() === true
    } catch {
      stopped = false
    }
    if (!stopped) recoveryStatus = 'failed'
    return bounded(recoveryStatus)
  }

  const activate = async (action, status) => {
    const capabilities = getCapabilities()
    if (capabilities?.health === 'rollback_pending') await observe(capabilities)
    if (recoveryStatus !== 'idle') return bounded('rollback_pending')
    await action()
    return bounded(status)
  }
  return Object.freeze({
    observe,
    status: () => recoveryStatus,
    start: () => activate(startBackend, 'started'),
    restart: () => activate(restartBackend, 'restarted'),
    retry: async () => {
      const current = getCapabilities()
      if (current?.health === 'rollback_pending' && recoveryStatus === 'idle') {
        await observe(current)
      }
      const recoveryRequired = recoveryStatus !== 'idle'
      let capabilities
      try {
        capabilities = await refreshCapabilities()
      } catch {
        if (recoveryRequired) recoveryStatus = 'failed'
        return bounded('recovery_failed')
      }
      if (capabilities?.health === 'rollback_pending') await observe(capabilities)
      if (recoveryRequired || recoveryStatus !== 'idle') {
        const safe = capabilities?.health === 'ready' || capabilities?.health === 'degraded'
        if (!safe) {
          recoveryStatus = 'failed'
          return bounded('recovery_failed')
        }
        let activated = false
        try {
          activated = await retryBackend() === true
        } catch {
          activated = false
        }
        if (!activated) {
          recoveryStatus = 'failed'
          try {
            await stopBackend()
          } catch {
            // The failed recovery remains latched even if quiescing also fails.
          }
          return bounded('recovery_failed')
        }
        recoveryStatus = 'idle'
        return bounded('retried')
      }
      await retryBackend()
      return bounded('retried')
    },
  })
}

function firstDialog(preview) {
  const target = preview.scope === 'current_managed'
    ? `“${preview.display_name}”`
    : `${preview.count} 个 Nova 托管 workspaces`
  return Object.freeze({
    type: 'question',
    title: '确认清空 workspace',
    message: `将清空 ${target}`,
    detail: '此操作需要先停止当前后台任务，完成后会自动尝试恢复连接。',
    buttons: Object.freeze(['继续', '取消']),
    defaultId: CANCEL_RESPONSE,
    cancelId: CANCEL_RESPONSE,
    noLink: true,
  })
}

function destructiveDialog(scope) {
  const label = scope === 'current_managed'
    ? '永久清空当前 workspace'
    : '永久清空全部托管 workspaces'
  return Object.freeze({
    type: 'warning',
    title: '此操作不可撤销',
    message: 'workspace 内的所有内容将被永久删除。',
    detail: '项目记录、显示名称、Codex 历史和会话元数据会保留。',
    buttons: Object.freeze([label, '取消']),
    defaultId: CANCEL_RESPONSE,
    cancelId: CANCEL_RESPONSE,
    noLink: true,
  })
}

export function createWorkspaceActions({
  coordinator,
  getMaintenance,
  getWindow,
  showMessageBox,
  openPath,
  stopBackendCleanly,
  restartBackendBounded,
}) {
  async function openCurrent() {
    const maintenance = getMaintenance()
    if (maintenance === null || maintenance === undefined) return bounded('not_managed')
    let openFailed = false
    try {
      const result = await maintenance.withCurrentManagedPath(async path => {
        const error = await openPath(path)
        if (typeof error === 'string' && error !== '') {
          openFailed = true
          throw new Error('workspace open failed')
        }
      })
      return openFailed ? bounded('open_failed') : result
    } catch {
      return bounded(openFailed ? 'open_failed' : 'unavailable')
    }
  }

  async function clear(scope) {
    const maintenance = getMaintenance()
    if (maintenance === null || maintenance === undefined) {
      return bounded(scope === 'current_managed' ? 'not_managed' : 'empty')
    }
    let prepared
    try {
      prepared = await maintenance.prepare(scope)
    } catch {
      return bounded('clear_failed')
    }
    if (prepared.status !== 'ready') return bounded(prepared.status)
    const preparation = prepared.preparation
    let owned = false
    try {
      const first = await showMessageBox(getWindow(), firstDialog(prepared.preview))
      if (first?.response !== 0) {
        maintenance.cancel(preparation)
        return bounded('cancelled')
      }
      const second = await showMessageBox(getWindow(), destructiveDialog(scope))
      if (second?.response !== 0) {
        maintenance.cancel(preparation)
        return bounded('cancelled')
      }
      const operationKind = scope === 'current_managed' ? 'clear_current' : 'clear_all'
      const coordinated = await coordinator.run(operationKind, async () => {
        let authorization
        try {
          authorization = maintenance.authorize(preparation)
          owned = true
        } catch {
          maintenance.cancel(preparation)
          return bounded('clear_failed')
        }
        let stopped = false
        try {
          stopped = await stopBackendCleanly()
        } catch {
          stopped = false
        }
        if (!stopped) return bounded('stop_failed')

        let clearStatus = 'clear_failed'
        let recovered = false
        let rollbackPending = false
        try {
          const cleared = await maintenance.execute(preparation, authorization)
          rollbackPending = cleared?.status === 'rollback_pending'
          clearStatus = cleared?.status === 'cleared' ? 'cleared' : 'clear_failed'
        } catch {
          clearStatus = 'clear_failed'
        } finally {
          if (!rollbackPending) {
            try {
              recovered = await restartBackendBounded()
            } catch {
              recovered = false
            }
          }
        }
        if (rollbackPending) return bounded('rollback_pending')
        if (recovered) return bounded(clearStatus)
        return bounded(clearStatus === 'cleared' ? 'restart_failed' : 'clear_and_restart_failed')
      })
      if (coordinated.status === 'busy') {
        maintenance.cancel(preparation)
        return bounded('busy')
      }
      return coordinated.value
    } catch {
      if (!owned) maintenance.cancel(preparation)
      return bounded('clear_failed')
    }
  }

  return Object.freeze({
    openCurrent,
    clearCurrent: () => clear('current_managed'),
    clearAll: () => clear('all_managed'),
  })
}
