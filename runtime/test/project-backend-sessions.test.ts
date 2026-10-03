import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFile, readdir, writeFile, lstat, realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {projectStoreFixture, DescriptorRelativeRootFileAuthority} from './project-store-fixture.js'
import {decodeState} from '../src/projects/project-state.js'
import type {ProjectRootFileLookupResult} from '../src/projects/project-root-file.js'

test('backend identities survive reopen and isolate equal native session IDs', async () => {
  const fixture = await projectStoreFixture('nova-backend-sessions-')
  let store = await fixture.open()
  try {
    const workspace = await store.createManaged('backend test')
    const first = await store.beginSessionForRun(workspace.workspace_id, 'first', undefined,
      {backend_id: 'opencode', backend_profile_id: 'opencode:default'})
    const second = await store.beginSessionForRun(workspace.workspace_id, 'second', undefined,
      {backend_id: 'deepseek', backend_profile_id: 'deepseek:default'})
    await store.markSessionReady(first.session.session_id, 'same-native-id')
    await store.markSessionReady(second.session.session_id, 'same-native-id')
    await store.close()
    store = await fixture.open()
    const sessions = await store.listSessions(workspace)
    assert.deepEqual(sessions.map(session => [session.backend_id, session.backend_profile_id, session.backend_session_id]).sort(), [
      ['deepseek', 'deepseek:default', 'same-native-id'],
      ['opencode', 'opencode:default', 'same-native-id'],
    ])
    assert.ok(sessions.every(session => session.codex_thread_id === null))
    await store.prepareSessionResume(workspace.workspace_id, first.session.session_id, 'same-native-id')
    const home = await realpath(fixture.stateRoot)
    const custom = await store.beginSessionForRun(workspace.workspace_id, 'custom codex', home,
      {backend_id: 'codex', backend_profile_id: 'codex:custom'})
    await store.markSessionReady(custom.session.session_id, 'codex-native-id')
    const imported = await store.importSession(workspace.workspace_id,
      {threadId: 'codex-native-id', title: 'legacy import', home, updatedAt: Date.now() / 1000})
    assert.notEqual(imported.session_id, custom.session.session_id)
    assert.equal(imported.backend_profile_id, 'codex:legacy')
    const corrupt = JSON.parse(await readFile(join(fixture.stateRoot, 'codex-projects-v1.json'), 'utf8')) as {
      sessions: Record<string, Record<string, unknown>>
    }
    const bad = corrupt.sessions[first.session.session_id]!
    bad.executor_home = home
    delete bad.origin
    assert.throws(() => decodeState(corrupt))
  } finally { await fixture.close(store) }
})

test('migration retry makes the verified backup durable before replacing legacy state', async () => {
  const fixture = await projectStoreFixture('nova-backend-migration-retry-')
  const path = join(fixture.stateRoot, 'codex-projects-v1.json')
  const bytes = Buffer.from(JSON.stringify({version: 1, active_workspace_id: null, workspaces: {}, sessions: {}}))
  await writeFile(path, bytes, {mode: 0o600})
  class InterruptBackup extends DescriptorRelativeRootFileAuthority {
    interrupt = true
    failLookup = false
    override renameAt(root: number, from: string, to: string) {
      const result = super.renameAt(root, from, to)
      if (result.status === 'ok' && to === 'codex-projects-v1.pre-acp.json' && this.interrupt) {
        this.interrupt = false
        this.failLookup = true
      }
      return result
    }
    override lookupAt(root: number, name: string): ProjectRootFileLookupResult {
      if (this.failLookup && name === 'codex-projects-v1.pre-acp.json') {
        this.failLookup = false
        return {status: 'failed'}
      }
      return super.lookupAt(root, name)
    }
  }
  const events: string[] = []
  const store = await fixture.open({
    rootFiles: new InterruptBackup([fixture.stateRoot, fixture.managedRoot]),
    onDurabilityStep: step => { events.push(step) },
  })
  try {
    await assert.rejects(store.snapshot())
    assert.deepEqual(await readFile(path), bytes)
    events.length = 0
    await store.snapshot()
    assert.equal(events[0], process.platform === 'win32' ? 'windows_metadata_commit' : 'dir_fsync')
    assert.ok(events.indexOf('temp_open') > 0)
    assert.deepEqual(await readFile(join(fixture.stateRoot, 'codex-projects-v1.pre-acp.json')), bytes)
  } finally { await fixture.close(store) }
})

test('v1 Codex migration keeps identity and verifies a private byte-exact recovery copy', async () => {
  const fixture = await projectStoreFixture('nova-backend-migration-')
  let store = await fixture.open()
  try {
    const workspace = await store.createManaged('legacy')
    const session = await store.beginSession(workspace.workspace_id, 'legacy session')
    await store.markSessionReady(session.session_id, 'legacy-thread')
    await store.close()
    const path = join(fixture.stateRoot, 'codex-projects-v1.json')
    const legacy = JSON.parse(await readFile(path, 'utf8')) as {version: number; sessions: Record<string, Record<string, unknown>>}
    legacy.version = 1
    for (const row of Object.values(legacy.sessions)) {
      delete row.backend_id
      delete row.backend_profile_id
      delete row.backend_session_id
    }
    const bytes = Buffer.from(JSON.stringify(legacy))
    await writeFile(path, bytes, {mode: 0o600})
    store = await fixture.open()
    const migrated = (await store.snapshot()).sessions[0]!
    assert.equal(migrated.backend_id, 'codex')
    assert.equal(migrated.backend_session_id, 'legacy-thread')
    assert.equal(migrated.codex_thread_id, 'legacy-thread')
    const backup = join(fixture.stateRoot, 'codex-projects-v1.pre-acp.json')
    assert.deepEqual(await readFile(backup), bytes)
    assert.equal((await lstat(backup)).mode & 0o777, 0o600)
    assert.equal((JSON.parse(await readFile(path, 'utf8')) as {version: number}).version, 2)
  } finally { await fixture.close(store) }
})

test('re-upgrading after a downgrade keeps the first backup and adds a verified sibling', async () => {
  const fixture = await projectStoreFixture('nova-backend-reupgrade-')
  let store = await fixture.open()
  const path = join(fixture.stateRoot, 'codex-projects-v1.json')
  const asV1 = async () => {
    const value = JSON.parse(await readFile(path, 'utf8')) as {version: number; sessions: Record<string, Record<string, unknown>>}
    value.version = 1
    for (const row of Object.values(value.sessions)) {
      delete row.backend_id
      delete row.backend_profile_id
      delete row.backend_session_id
    }
    return Buffer.from(JSON.stringify(value))
  }
  try {
    const workspace = await store.createManaged('legacy')
    const first = await store.beginSession(workspace.workspace_id, 'first')
    await store.markSessionReady(first.session_id, 'thread-a')
    await store.close()
    const original = await asV1()
    await writeFile(path, original, {mode: 0o600})
    store = await fixture.open()
    const second = await store.beginSession(workspace.workspace_id, 'second')
    await store.markSessionReady(second.session_id, 'thread-b')
    await store.close()
    // An older client used the restored v1 file and changed it before the user upgraded again.
    const downgraded = await asV1()
    await writeFile(path, downgraded, {mode: 0o600})
    store = await fixture.open()
    assert.equal((await store.snapshot()).sessions.length, 2)
    const backup = join(fixture.stateRoot, 'codex-projects-v1.pre-acp.json')
    assert.deepEqual(await readFile(backup), original, 'the first backup is never overwritten')
    const siblings = (await readdir(fixture.stateRoot)).filter(name => /^codex-projects-v1\.pre-acp\.[0-9a-f]{16}\.json$/u.test(name))
    assert.equal(siblings.length, 1)
    assert.deepEqual(await readFile(join(fixture.stateRoot, siblings[0]!)), downgraded)
  } finally { await fixture.close(store) }
})
