const CANCEL_RESPONSE = 1

function bounded(status) {
  return Object.freeze({status})
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
    try {
      return await maintenance.withCurrentManagedPath(async path => {
        const error = await openPath(path)
        if (typeof error === 'string' && error !== '') throw new Error('workspace open failed')
      })
    } catch {
      return bounded('not_managed')
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
        try {
          const cleared = await maintenance.execute(preparation, authorization)
          clearStatus = cleared?.status === 'cleared' ? 'cleared' : 'clear_failed'
        } catch {
          clearStatus = 'clear_failed'
        } finally {
          try {
            recovered = await restartBackendBounded()
          } catch {
            recovered = false
          }
        }
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
