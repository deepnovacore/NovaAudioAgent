import assert from 'node:assert/strict'
import {test} from 'node:test'

import {ManagedWorkspaceMaintenanceService} from '../src/managed-workspace-maintenance.js'

function record(id: string, origin: 'managed' | 'registered' = 'managed') {
  return Object.freeze({
    workspace_id: id,
    display_name: id,
    normalized_name: id,
    canonical_path: `/managed/${id}`,
    origin,
    codex_home_key: `home-${id}`,
    active_session_id: null,
    created_at: 1,
    last_used_at: 1,
  })
}

test('preparation and authorization are opaque, paired, and consumed exactly once', async () => {
  const workspace = record('workspace-0001')
  const calls: unknown[] = []
  const store = {
    cleanupManagedMaintenanceJournal: () => Promise.resolve({status: 'clean' as const}),
    loadManagedMaintenanceJournal: () => Promise.resolve(null),
    maintenanceSnapshot: () => Promise.resolve({
      state_revision: 7,
      active_workspace_id: workspace.workspace_id,
      managed_targets: [{workspace, identity: {device: 1n, inode: 2n}}],
    }),
    currentMaintenanceSnapshot: () => Promise.resolve({
      state_revision: 7,
      active_workspace_id: workspace.workspace_id,
      managed_targets: [{workspace, identity: {device: 1n, inode: 2n}}],
    }),
    withCurrentManagedWorkspacePath: async (callback: (path: string) => void | Promise<void>) => {
      await callback(workspace.canonical_path)
      return true
    },
    executeManagedReplacement: (input: unknown) => {
      calls.push(input)
      return Promise.resolve({status: 'committed' as const, committed: true, tombstones: []})
    },
  }
  const service = await ManagedWorkspaceMaintenanceService.open({
    store,
    now: () => 100,
    idFactory: () => 'operation-0001',
  })
  const prepared = await service.prepare('current_managed')
  assert.deepEqual(await service.capabilities(), {
    health: 'ready',
    lifecycleBusy: false,
    current: {available: true, display_name: 'workspace-0001'},
    all: {available: true, count: 1},
  })
  let openedPath = ''
  assert.deepEqual(await service.withCurrentManagedPath(path => { openedPath = path }), {status: 'opened'})
  assert.equal(openedPath, workspace.canonical_path)
  assert.equal(prepared.status, 'ready')
  if (prepared.status !== 'ready') return
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.preparation)), {})
  assert.deepEqual(prepared.preview, {
    scope: 'current_managed', display_name: 'workspace-0001', count: 1,
  })
  const authorization = service.authorize(prepared.preparation)
  assert.deepEqual(JSON.parse(JSON.stringify(authorization)), {})
  assert.deepEqual(await service.execute(prepared.preparation, authorization), {
    status: 'cleared', committed: true, cleanup_pending: false,
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(await service.execute(prepared.preparation, authorization), {
    status: 'stale', committed: false, cleanup_pending: false,
  })
  await service.close()
})

test('registered current workspaces and expired preparations cannot authorize clearing', async () => {
  const workspace = record('workspace-0001', 'registered')
  let now = 100
  const store = {
    cleanupManagedMaintenanceJournal: () => Promise.resolve({status: 'clean' as const}),
    loadManagedMaintenanceJournal: () => Promise.resolve(null),
    maintenanceSnapshot: () => Promise.resolve({
      state_revision: 1,
      active_workspace_id: workspace.workspace_id,
      managed_targets: [],
    }),
    currentMaintenanceSnapshot: () => Promise.resolve({
      state_revision: 1,
      active_workspace_id: workspace.workspace_id,
      managed_targets: [],
    }),
    withCurrentManagedWorkspacePath: () => Promise.resolve(false),
    executeManagedReplacement: () => Promise.reject(new Error('must not execute')),
  }
  const service = await ManagedWorkspaceMaintenanceService.open({store, now: () => now})
  assert.deepEqual(await service.prepare('current_managed'), {status: 'not_managed'})
  const all = await service.prepare('all_managed')
  assert.deepEqual(all, {status: 'empty'})
  now += 61_000
  await service.close()
})

test('expiry, cancellation, duplicate authorization, and cross-pair replay fail closed', async () => {
  const workspace = record('workspace-0001')
  let now = 100
  const store = {
    cleanupManagedMaintenanceJournal: () => Promise.resolve({status: 'clean' as const}),
    loadManagedMaintenanceJournal: () => Promise.resolve(null),
    maintenanceSnapshot: () => Promise.resolve({
      state_revision: 1,
      active_workspace_id: workspace.workspace_id,
      managed_targets: [{workspace, identity: {device: 1n, inode: 2n}}],
    }),
    currentMaintenanceSnapshot: () => Promise.resolve({
      state_revision: 1,
      active_workspace_id: workspace.workspace_id,
      managed_targets: [{workspace, identity: {device: 1n, inode: 2n}}],
    }),
    withCurrentManagedWorkspacePath: async (callback: (path: string) => void | Promise<void>) => {
      await callback(workspace.canonical_path)
      return true
    },
    executeManagedReplacement: () => Promise.reject(new Error('must not execute')),
  }
  const service = await ManagedWorkspaceMaintenanceService.open({store, now: () => now})
  const expired = await service.prepare('current_managed')
  assert.equal(expired.status, 'ready')
  if (expired.status !== 'ready') return
  now += 60_001
  assert.throws(() => service.authorize(expired.preparation), /stale/u)

  now = 100
  const first = await service.prepare('current_managed')
  const second = await service.prepare('current_managed')
  if (first.status !== 'ready' || second.status !== 'ready') assert.fail('expected ready')
  const firstAuthorization = service.authorize(first.preparation)
  assert.throws(() => service.authorize(first.preparation), /stale/u)
  assert.deepEqual(await service.execute(second.preparation, firstAuthorization), {
    status: 'stale', committed: false, cleanup_pending: false,
  })
  assert.equal(service.cancel(first.preparation), false, 'wrong-pair execution consumed the authorization only')
  assert.equal(service.cancel(second.preparation), false, 'wrong-pair execution consumed both presented tokens')

  const cancelled = await service.prepare('current_managed')
  if (cancelled.status !== 'ready') assert.fail('expected ready')
  assert.equal(service.cancel(cancelled.preparation), true)
  assert.throws(() => service.authorize(cancelled.preparation), /stale/u)
  await service.close()
})

test('a persistent cleanup journal is a maintenance failure, never an empty target set', async () => {
  let snapshotCalls = 0
  const store = {
    cleanupManagedMaintenanceJournal: () => Promise.resolve({status: 'cleanup_pending' as const}),
    loadManagedMaintenanceJournal: () => Promise.resolve(null),
    maintenanceSnapshot: () => {
      snapshotCalls += 1
      return Promise.reject(new Error('must not resolve new targets'))
    },
    currentMaintenanceSnapshot: () => {
      snapshotCalls += 1
      return Promise.reject(new Error('must not resolve current target'))
    },
    withCurrentManagedWorkspacePath: () => Promise.resolve(false),
    executeManagedReplacement: () => Promise.reject(new Error('must not execute')),
  }
  const service = await ManagedWorkspaceMaintenanceService.open({store})
  assert.deepEqual(await service.prepare('all_managed'), {status: 'cleanup_pending'})
  assert.equal(snapshotCalls, 0)
  await service.close()
})

test('a committed journal remains committed when execution loses its reply', async () => {
  const workspace = record('workspace-0001')
  let executing = false
  const store = {
    cleanupManagedMaintenanceJournal: () => Promise.resolve({status: 'clean' as const}),
    loadManagedMaintenanceJournal: () => Promise.resolve(executing ? {
      operation_id: 'operation-0001',
      phase: 'committed' as const,
      entries: [{
        workspace_id: workspace.workspace_id,
        original_name: 'workspace-0001',
        replacement_identity: {device: 3n, inode: 4n},
        tombstone_name: '.nova-maintenance-operation-0001-1',
        identity: {device: 1n, inode: 2n},
      }],
    } : null),
    maintenanceSnapshot: () => Promise.resolve({
      state_revision: 1,
      active_workspace_id: workspace.workspace_id,
      managed_targets: [{workspace, identity: {device: 1n, inode: 2n}}],
    }),
    currentMaintenanceSnapshot: () => Promise.resolve({
      state_revision: 1,
      active_workspace_id: workspace.workspace_id,
      managed_targets: [{workspace, identity: {device: 1n, inode: 2n}}],
    }),
    withCurrentManagedWorkspacePath: () => Promise.resolve(false),
    executeManagedReplacement: () => {
      executing = true
      return Promise.reject(new Error('reply lost after commit'))
    },
  }
  const service = await ManagedWorkspaceMaintenanceService.open({
    store,
    now: () => 100,
    idFactory: () => 'operation-0001',
  })
  const prepared = await service.prepare('current_managed')
  if (prepared.status !== 'ready') assert.fail('expected ready')
  const authorization = service.authorize(prepared.preparation)
  assert.deepEqual(await service.execute(prepared.preparation, authorization), {
    status: 'clear_failed', committed: true, cleanup_pending: true,
  })
  await service.close()
})

test('a foreign prepared journal preserves rollback health after replacement is refused', async () => {
  const workspace = record('workspace-0001')
  let cleanupCalls = 0
  let targetInspections = 0
  const snapshot = {
    state_revision: 1,
    active_workspace_id: workspace.workspace_id,
    managed_targets: [{workspace, identity: {device: 1n, inode: 2n}}],
  }
  const store = {
    cleanupManagedMaintenanceJournal: () => Promise.resolve({
      status: cleanupCalls++ === 0 ? 'clean' as const : 'rollback_pending' as const,
    }),
    loadManagedMaintenanceJournal: () => Promise.resolve({
      operation_id: 'foreign-operation-0002',
      phase: 'prepared' as const,
      entries: [{
        workspace_id: workspace.workspace_id,
        original_name: 'workspace-0001',
        replacement_identity: null,
        tombstone_name: '.nova-maintenance-foreign-operation-0002-1',
        identity: {device: 3n, inode: 4n},
      }],
    }),
    currentMaintenanceSnapshot: () => {
      targetInspections += 1
      return Promise.resolve(snapshot)
    },
    maintenanceSnapshot: () => {
      targetInspections += 1
      return Promise.resolve(snapshot)
    },
    withCurrentManagedWorkspacePath: () => {
      targetInspections += 1
      return Promise.resolve(false)
    },
    executeManagedReplacement: () => Promise.reject(new Error('state_busy')),
  }
  const service = await ManagedWorkspaceMaintenanceService.open({
    store,
    now: () => 100,
    idFactory: () => 'current-operation-0001',
  })
  const prepared = await service.prepare('current_managed')
  if (prepared.status !== 'ready') assert.fail('expected ready')
  const authorization = service.authorize(prepared.preparation)
  assert.deepEqual(await service.execute(prepared.preparation, authorization), {
    status: 'rollback_pending', committed: false, cleanup_pending: true,
  })
  assert.deepEqual(await service.prepare('current_managed'), {status: 'rollback_pending'})
  assert.deepEqual(await service.withCurrentManagedPath(() => undefined), {status: 'rollback_pending'})
  assert.equal(targetInspections, 1)
  assert.equal(cleanupCalls, 2)
  await service.close()
})

test('service startup preserves unresolved rollback health and remains closable', async () => {
  let snapshotCalls = 0
  const store = {
    cleanupManagedMaintenanceJournal: () => Promise.resolve({status: 'rollback_pending' as const}),
    loadManagedMaintenanceJournal: () => Promise.resolve(null),
    maintenanceSnapshot: () => {
      snapshotCalls += 1
      return Promise.reject(new Error('must not inspect detached workspaces'))
    },
    currentMaintenanceSnapshot: () => {
      snapshotCalls += 1
      return Promise.reject(new Error('must not inspect the active workspace'))
    },
    withCurrentManagedWorkspacePath: () => Promise.resolve(false),
    executeManagedReplacement: () => Promise.reject(new Error('must not execute')),
  }
  const service = await ManagedWorkspaceMaintenanceService.open({store})
  assert.deepEqual(await service.capabilities(), {
    health: 'rollback_pending',
    lifecycleBusy: false,
    current: {available: false, display_name: null},
    all: {available: false, count: 0},
  })
  assert.equal(snapshotCalls, 0)
  await service.close()
  assert.deepEqual(await service.capabilities(), {
    health: 'unavailable',
    lifecycleBusy: false,
    current: {available: false, display_name: null},
    all: {available: false, count: 0},
  })
})

test('a completed filesystem rollback is reported as clear_failed rather than stale', async () => {
  const workspace = record('workspace-0001')
  const store = {
    cleanupManagedMaintenanceJournal: () => Promise.resolve({status: 'clean' as const}),
    loadManagedMaintenanceJournal: () => Promise.resolve(null),
    maintenanceSnapshot: () => Promise.resolve({
      state_revision: 1,
      active_workspace_id: workspace.workspace_id,
      managed_targets: [{workspace, identity: {device: 1n, inode: 2n}}],
    }),
    currentMaintenanceSnapshot: () => Promise.resolve({
      state_revision: 1,
      active_workspace_id: workspace.workspace_id,
      managed_targets: [{workspace, identity: {device: 1n, inode: 2n}}],
    }),
    withCurrentManagedWorkspacePath: () => Promise.resolve(false),
    executeManagedReplacement: () => Promise.resolve({
      status: 'rolled_back' as const, committed: false, tombstones: [],
    }),
  }
  const service = await ManagedWorkspaceMaintenanceService.open({
    store,
    now: () => 100,
    idFactory: () => 'operation-0001',
  })
  const prepared = await service.prepare('current_managed')
  if (prepared.status !== 'ready') assert.fail('expected ready')
  const authorization = service.authorize(prepared.preparation)
  assert.deepEqual(await service.execute(prepared.preparation, authorization), {
    status: 'clear_failed', committed: false, cleanup_pending: false,
  })
  await service.close()
})

test('capabilities keep a valid current target available when complete-set validation fails', async () => {
  const workspace = record('workspace-0001')
  let currentSnapshotCalls = 0
  let completeSnapshotCalls = 0
  const store = {
    cleanupManagedMaintenanceJournal: () => Promise.resolve({status: 'clean' as const}),
    loadManagedMaintenanceJournal: () => Promise.resolve(null),
    currentMaintenanceSnapshot: () => {
      currentSnapshotCalls += 1
      return Promise.resolve({
        state_revision: 1,
        active_workspace_id: workspace.workspace_id,
        managed_targets: [{workspace, identity: {device: 1n, inode: 2n}}],
      })
    },
    maintenanceSnapshot: () => {
      completeSnapshotCalls += 1
      return Promise.reject(new Error('detached managed workspace'))
    },
    withCurrentManagedWorkspacePath: () => Promise.resolve(false),
    executeManagedReplacement: () => Promise.reject(new Error('must not execute')),
  }
  const service = await ManagedWorkspaceMaintenanceService.open({store})
  assert.deepEqual(await service.capabilities(), {
    health: 'degraded',
    lifecycleBusy: false,
    current: {available: true, display_name: 'workspace-0001'},
    all: {available: false, count: 0},
  })
  const current = await service.prepare('current_managed')
  assert.equal(current.status, 'ready')
  assert.deepEqual(await service.prepare('all_managed'), {status: 'unavailable'})
  assert.equal(currentSnapshotCalls, 2)
  assert.equal(completeSnapshotCalls, 2)
  await service.close()
})

test('capabilities bound complete snapshot failures as unavailable', async () => {
  const store = {
    cleanupManagedMaintenanceJournal: () => Promise.resolve({status: 'clean' as const}),
    loadManagedMaintenanceJournal: () => Promise.resolve(null),
    currentMaintenanceSnapshot: () => Promise.reject(new Error('current unavailable')),
    maintenanceSnapshot: () => Promise.reject(new Error('all unavailable')),
    withCurrentManagedWorkspacePath: () => Promise.resolve(false),
    executeManagedReplacement: () => Promise.reject(new Error('must not execute')),
  }
  const service = await ManagedWorkspaceMaintenanceService.open({store})
  assert.deepEqual(await service.capabilities(), {
    health: 'unavailable',
    lifecycleBusy: false,
    current: {available: false, display_name: null},
    all: {available: false, count: 0},
  })
  await service.close()
})

test('capability refresh retries pending journal recovery before inspecting targets', async () => {
  const workspace = record('workspace-0001')
  const cleanupStatuses = ['cleanup_pending', 'cleanup_pending', 'clean'] as const
  let cleanupCalls = 0
  let snapshotCalls = 0
  const snapshot = {
    state_revision: 1,
    active_workspace_id: workspace.workspace_id,
    managed_targets: [{workspace, identity: {device: 1n, inode: 2n}}],
  }
  const store = {
    cleanupManagedMaintenanceJournal: () => Promise.resolve({
      status: cleanupStatuses[cleanupCalls++] ?? 'clean',
    }),
    loadManagedMaintenanceJournal: () => Promise.resolve(null),
    currentMaintenanceSnapshot: () => {
      snapshotCalls += 1
      return Promise.resolve(snapshot)
    },
    maintenanceSnapshot: () => {
      snapshotCalls += 1
      return Promise.resolve(snapshot)
    },
    withCurrentManagedWorkspacePath: () => {
      snapshotCalls += 1
      return Promise.resolve(false)
    },
    executeManagedReplacement: () => Promise.reject(new Error('must not execute')),
  }
  const service = await ManagedWorkspaceMaintenanceService.open({store})
  assert.deepEqual(await service.prepare('current_managed'), {status: 'cleanup_pending'})
  assert.deepEqual(await service.withCurrentManagedPath(() => undefined), {status: 'cleanup_pending'})
  assert.equal(snapshotCalls, 0)
  assert.deepEqual(await service.capabilities(), {
    health: 'cleanup_pending',
    lifecycleBusy: false,
    current: {available: false, display_name: null},
    all: {available: false, count: 0},
  })
  assert.equal(snapshotCalls, 0)
  assert.deepEqual(await service.capabilities(), {
    health: 'ready',
    lifecycleBusy: false,
    current: {available: true, display_name: 'workspace-0001'},
    all: {available: true, count: 1},
  })
  assert.equal(snapshotCalls, 2)
  await service.close()
})

test('current open awaits OS completion after store validation and reports callback failure', async () => {
  const workspace = record('workspace-0001')
  let transactionReleased = false
  let finishOpen!: (error?: Error) => void
  const store = {
    cleanupManagedMaintenanceJournal: () => Promise.resolve({status: 'clean' as const}),
    loadManagedMaintenanceJournal: () => Promise.resolve(null),
    currentMaintenanceSnapshot: () => Promise.reject(new Error('must not snapshot')),
    maintenanceSnapshot: () => Promise.reject(new Error('must not snapshot')),
    withCurrentManagedWorkspacePath: (callback: (path: string) => void) => {
      callback(workspace.canonical_path)
      assert.equal(transactionReleased, false)
      transactionReleased = true
      return Promise.resolve(true)
    },
    executeManagedReplacement: () => Promise.reject(new Error('must not execute')),
  }
  const service = await ManagedWorkspaceMaintenanceService.open({store})
  let settled = false
  const opened = service.withCurrentManagedPath(() => new Promise<void>((resolve, reject) => {
    finishOpen = error => { if (error === undefined) resolve(); else reject(error) }
  })).then(result => {
    settled = true
    return result
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(transactionReleased, true)
  assert.equal(settled, false)
  finishOpen()
  assert.deepEqual(await opened, {status: 'opened'})

  assert.deepEqual(await service.withCurrentManagedPath(() => Promise.reject(new Error('OS failed'))), {
    status: 'open_failed',
  })
  await service.close()
})
