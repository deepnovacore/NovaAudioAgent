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
    executeManagedReplacement: (input: unknown) => {
      calls.push(input)
      return Promise.resolve({committed: true, tombstones: []})
    },
  }
  const service = await ManagedWorkspaceMaintenanceService.open({
    store,
    now: () => 100,
    idFactory: () => 'operation-0001',
  })
  const prepared = await service.prepare('current_managed')
  assert.deepEqual(await service.capabilities(), {
    lifecycleBusy: false,
    current: {available: true, display_name: 'workspace-0001'},
    all: {available: true, count: 1},
  })
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
