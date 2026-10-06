import assert from 'node:assert/strict'
import {fstatSync, lstatSync, mkdirSync, realpathSync, renameSync, symlinkSync} from 'node:fs'
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join, relative} from 'node:path'
import {test} from 'node:test'

import {VirtualClock} from '../src/core/clock.js'
import {
  ProjectStore,
  MAX_PROJECT_WORKSPACES,
  PROJECT_MAINTENANCE_JOURNAL_FILE,
  ProjectStateError,
  hostManagedProjectRootForTest,
  hostProjectRootForTest,
  normalizeProjectSessionTitle,
  normalizeProjectWorkspaceName,
} from '../src/projects/project-store.js'
import {
  hostCodexHomeValue,
  hostWorkspaceForTest,
  hostWorkspacePath,
} from '../src/executors/codex/process-owner.js'
import {ManagedWorkspaceMaintenanceService} from '../src/projects/managed-workspace-maintenance.js'
import {unsupportedNativeFileLocks, type NativeFileLockAuthority, type NativeFileLockResult} from '../src/storage/native-file-lock.js'
import type {ProjectRootFileAuthority, ProjectRootFileCreateResult, ProjectRootFileResult} from '../src/projects/project-root-file.js'

import {projectStoreFixture, within, DescriptorLockAuthority, DescriptorRelativeRootFileAuthority, ToggleRemoveTreeRootFileAuthority, MaintenanceOrderRootFileAuthority, MaintenanceCollisionRootFileAuthority, MaintenanceDurabilityRootFileAuthority, FailNthMaintenanceMkdirAuthority, ReplaceCreatedLockRootFileAuthority, ReplaceHomeAfterMkdirRootFileAuthority, RecordingRootFileAuthority, FailTempCreateRootFileAuthority, ToggleTempCreateRootFileAuthority, ReplaceManagedRestoreAfterMkdirRootFileAuthority, FailManagedLookupRootFileAuthority, ExternalCleanupMkdirCollisionAuthority, PermissiveManagedMkdirRootFileAuthority, RejectLockMatchRootFileAuthority, SwapAroundDescriptorOperationsAuthority, isErrno, rootFilesForTest, CountingProtectRootFileAuthority, DeferredReleaseLockAuthority, BusyThenDescriptorLockAuthority, FailNextReleaseLockAuthority, AdvancingClock} from './project-store-fixture.js'


test('project names use Python NFKC, whitespace collapse, and full casefold', () => {
  assert.deepEqual(normalizeProjectWorkspaceName('\u001c Ｓtraße\u0085看板 '), {
    display: 'Straße 看板',
    normalized: 'strasse 看板',
  })
  assert.deepEqual(normalizeProjectSessionTitle(' ΟΣ  修复 '), {
    display: 'ΟΣ 修复',
    normalized: 'οσ 修复',
  })
})

test('managed workspace slug classification never consults ambient ICU Unicode categories', async () => {
  const source = await readFile(
    join(import.meta.dirname, '../../src/projects/project-state.ts'),
    'utf8',
  )
  assert.equal(source.includes('/[\\p{L}\\p{N}]/u'), false)
})

test('durability and native locking source retain the audited no-fallback primitives', async () => {
  const storeSource = await readFile(
    join(import.meta.dirname, '../../src/projects/project-store-files.ts'),
    'utf8',
  )
  const nativeSource = await readFile(
    join(import.meta.dirname, '../../src/storage/native-file-lock.ts'),
    'utf8',
  )
  const ordered = [
    'this.#createFileAt(root, tempName, true',
    'await file.sync()',
    'this.#renameAt(root, tempName, name)',
    'await directory.sync()',
  ].map(fragment => storeSource.indexOf(fragment))
  assert.equal(ordered.every(index => index >= 0), true)
  assert.deepEqual([...ordered].sort((left, right) => left - right), ordered)
  assert.match(storeSource, /constants\.O_RDONLY \| nonblockFlag\(\) \| noFollowFlag\(\)/u)
  assert.doesNotMatch(storeSource, /\.trim\(/u)
  assert.match(storeSource, /privateDirectoryMetadata/u)
  assert.match(storeSource, /privateRegularFileMetadata/u)
  assert.match(storeSource, /if \(platform === 'win32'\) return true/u)
  assert.match(storeSource, /return \(mode & 0o7022\) !== 0/u)
  assert.match(nativeSource, /acquire\(descriptor: number\)/u)
  assert.doesNotMatch(nativeSource, /acquire\(descriptor: number\).*Promise/u)
  assert.doesNotMatch(storeSource, /await this\.#nativeLocks\.acquire/u)
  assert.doesNotMatch(storeSource, /constants\.O_(?:CREAT|EXCL)/u)
  assert.match(storeSource, /const directory = this\.#stateRootHandle/u)
  assert.doesNotMatch(storeSource, /open\(this\.#stateRoot, constants\.O_RDONLY\)/u)
  assert.doesNotMatch(nativeSource, /process\.pid|mkdir|stale|lockfile|path:/iu)
})

test('native lock unsupported and busy results fail closed without a PID or path lock fallback', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-lock-')

  const roots = await storeFixture.options()
  let store: ProjectStore | null = null
  try {
    store = await ProjectStore.open({...roots, nativeLocks: unsupportedNativeFileLocks})
    await assert.rejects(
      store.snapshot(),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_lock_failed',
    )
    await assert.rejects(
      ProjectStore.open({...roots, nativeLocks: unsupportedNativeFileLocks, live: true}),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_lock_failed',
    )
    const busy: NativeFileLockAuthority = {acquire: () => ({status: 'busy'})}
    const busyClock = new AdvancingClock()
    const contended = await ProjectStore.open({...roots, nativeLocks: busy, lockClock: busyClock})
    await assert.rejects(
      contended.snapshot(),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_busy',
    )
    assert.ok(busyClock.sleeps.length > 0, 'ordinary readers use the bounded lock wait')
    await contended.close()

    const transientLocks = new BusyThenDescriptorLockAuthority()
    transientLocks.busyAttempts = 2
    const transientClock = new AdvancingClock()
    const transient = await ProjectStore.open({
      ...roots, nativeLocks: transientLocks, lockClock: transientClock,
    })
    await transient.snapshot()
    assert.equal(transientClock.sleeps.length, 2)
    await transient.close()
    for (const nativeLocks of [
      {acquire: (): NativeFileLockResult => ({status: 'failed'})},
      {acquire: (): NativeFileLockResult => { throw new Error('native sentinel') }},
      {acquire: (): NativeFileLockResult => null as unknown as NativeFileLockResult},
    ]) {
      const failed = await ProjectStore.open({...roots, nativeLocks})
      await assert.rejects(
        failed.snapshot(),
        (error: unknown) => error instanceof ProjectStateError
          && error.code === 'state_lock_failed'
          && !String(error).includes('sentinel'),
      )
      await failed.close()
    }
  } finally {
    await storeFixture.close(store)
  }
})

test('native lock results require exact plain data without invoking getters', async () => {
  let getterReads = 0
  class BusyResult {
    readonly status = 'busy'
  }
  const factories: readonly (() => unknown)[] = [
    () => new BusyResult(),
    () => ({status: 'busy', detail: 'host-private'}),
    () => Object.defineProperty({}, 'status', {
      enumerable: true,
      get: () => {
        getterReads += 1
        return 'busy'
      },
    }),
    () => Object.defineProperties({}, {
      status: {enumerable: true, value: 'acquired'},
      release: {
        enumerable: true,
        get: () => {
          getterReads += 1
          return () => undefined
        },
      },
    }),
    () => ({status: 'busy', then: () => undefined}),
    () => new Proxy({status: 'busy'}, {
      ownKeys: () => { throw new Error('proxy sentinel') },
    }),
  ]
  for (const [index, factory] of factories.entries()) {
    const storeFixture = await projectStoreFixture(`nova-codex-project-lock-result-${index}-`)

    const store = await storeFixture.open({
      nativeLocks: {acquire: () => factory() as NativeFileLockResult},
    })
    try {
      await assert.rejects(
        within('malformed native result', store.snapshot(), 200),
        (error: unknown) => error instanceof ProjectStateError
          && error.code === 'state_lock_failed'
          && !String(error).includes('sentinel'),
      )
    } finally {
      await storeFixture.close(store)
    }
  }
  assert.equal(getterReads, 0)
})

test('missing, unsupported, asynchronous, and malformed root-file authority fails at open', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-root-files-')
  const {stateRoot, managedRoot} = storeFixture
  // This fixture deliberately omits rootFiles to exercise the missing-authority boundary.
  const roots = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
  }
  const authorities: readonly (ProjectRootFileAuthority | undefined)[] = [
    undefined,
    {
      probe: () => ({status: 'unsupported'}),
      matchesAt: () => ({status: 'unsupported'}),
      lookupAt: () => ({status: 'unsupported'}),
      createFileAt: () => ({status: 'unsupported'}),
      mkdirAt: () => ({status: 'unsupported'}),
      renameAt: () => ({status: 'unsupported'}),
      unlinkAt: () => ({status: 'unsupported'}),
      removeTreeAt: () => ({status: 'unsupported'}),
    },
    {
      probe: () => new Promise<ProjectRootFileResult>(() => undefined),
      matchesAt: () => ({status: 'ok'}),
      lookupAt: () => ({status: 'missing'}),
      createFileAt: () => ({status: 'ok'}),
      mkdirAt: () => ({status: 'ok'}),
      renameAt: () => ({status: 'ok'}),
      unlinkAt: () => ({status: 'ok'}),
    } as unknown as ProjectRootFileAuthority,
    {
      probe: () => ({status: 'ok', then: () => undefined}),
      matchesAt: () => ({status: 'ok'}),
      lookupAt: () => ({status: 'missing'}),
      createFileAt: () => ({status: 'ok'}),
      mkdirAt: () => ({status: 'ok'}),
      renameAt: () => ({status: 'ok'}),
      unlinkAt: () => ({status: 'ok'}),
    } as unknown as ProjectRootFileAuthority,
  ]
  try {
    for (const rootFiles of authorities) {
      let unexpected: ProjectStore | null = null
      try {
        const options = rootFiles === undefined ? roots : {...roots, rootFiles}
        unexpected = await within(
          'root-file authority open failure',
          ProjectStore.open(options),
          200,
        )
        assert.fail('root-file authority unexpectedly opened')
      } catch (error) {
        assert.equal(error instanceof ProjectStateError && error.code === 'state_permissions', true)
      } finally {
        await unexpected?.close()
      }
    }
  } finally {
    await storeFixture.close()
  }
})

test('state lock and temp creation use only descriptor-relative fixed basenames', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-root-create-')
  const {root, stateRoot, managedRoot} = storeFixture
  const workspace = join(root, 'workspace')
  await mkdir(workspace, {mode: 0o700})
  const rootFiles = new RecordingRootFileAuthority([stateRoot, managedRoot])
  const store = await storeFixture.open({
    rootFiles,
    idFactory: () => 'workspace-0001',
  })
  try {
    await store.ensureImported('alpha', hostWorkspaceForTest(await realpath(workspace)))
    assert.equal(
      rootFiles.createdFiles.some(item =>
        item.name === 'codex-projects-v1.lock' && item.exclusive === false),
      true,
    )
    assert.equal(
      rootFiles.createdFiles.some(item =>
        item.name.startsWith('.codex-projects-v1.json.')
          && item.name.endsWith('.tmp')
          && item.exclusive),
      true,
    )
    for (const item of rootFiles.createdFiles) {
      assert.equal(/[\\/\0]/u.test(item.name), false)
      assert.notEqual(item.name, '.')
      assert.notEqual(item.name, '..')
      assert.equal(item.name.includes('://'), false)
      assert.equal(/^[A-Za-z]:/u.test(item.name), false)
    }
  } finally {
    await storeFixture.close(store)
  }
})

test('malformed descriptor creation fails before native acquire without awaiting host values', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-root-create-malformed-')
  const {stateRoot, managedRoot} = storeFixture
  const delegate = new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot])
  const never = new Promise<ProjectRootFileCreateResult>(() => undefined)
  const rootFiles = {
    probe: descriptor => delegate.probe(descriptor),
    matchesAt: (descriptor, name, child) => delegate.matchesAt(descriptor, name, child),
    lookupAt: (descriptor, name) => delegate.lookupAt(descriptor, name),
    createFileAt: (() => never) as unknown as ProjectRootFileAuthority['createFileAt'],
    mkdirAt: (descriptor, name) => delegate.mkdirAt(descriptor, name),
    renameAt: (descriptor, from, to) => delegate.renameAt(descriptor, from, to),
    unlinkAt: (descriptor, name, expected, kind) =>
      delegate.unlinkAt(descriptor, name, expected, kind),
    removeTreeAt: (descriptor, name, expected) =>
      delegate.removeTreeAt(descriptor, name, expected),
  } satisfies ProjectRootFileAuthority
  let acquireCalls = 0
  const store = await storeFixture.open({
    nativeLocks: {acquire: () => {
      acquireCalls += 1
      return {status: 'acquired', release: () => undefined}
    }},
    rootFiles,
  })
  try {
    await assert.rejects(
      within('malformed descriptor create', store.snapshot(), 200),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
    assert.equal(acquireCalls, 0)
  } finally {
    await storeFixture.close(store)
  }
})

test('a descriptor child mismatch fails before native lock acquisition', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-root-match-')
  const {stateRoot, managedRoot} = storeFixture
  let acquireCalls = 0
  const rootFiles = new RejectLockMatchRootFileAuthority([stateRoot, managedRoot])
  const store = await storeFixture.open({
    nativeLocks: {acquire: () => {
      acquireCalls += 1
      return {status: 'acquired', release: () => undefined}
    }},
    rootFiles,
  })
  try {
    await assert.rejects(
      store.snapshot(),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
    assert.equal(acquireCalls, 0)
    assert.notEqual(rootFiles.rejectedDescriptor, null)
    assert.throws(
      () => fstatSync(rootFiles.rejectedDescriptor!),
      (error: unknown) => isErrno(error, 'EBADF'),
    )
  } finally {
    await storeFixture.close(store)
  }
})

test('a newly-created lock must retain its exact descriptor identity before native acquire', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-lock-create-race-')
  const {stateRoot, managedRoot} = storeFixture
  let acquireCalls = 0
  const rootFiles = new ReplaceCreatedLockRootFileAuthority([stateRoot, managedRoot])
  const store = await storeFixture.open({
    nativeLocks: {acquire: () => {
      acquireCalls += 1
      return {status: 'acquired', release: () => undefined}
    }},
    rootFiles,
  })
  try {
    await assert.rejects(
      store.snapshot(),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
    assert.equal(rootFiles.replaced, true)
    assert.equal(acquireCalls, 0)
  } finally {
    await storeFixture.close(store)
  }
})

test('swap-away-and-back descriptor operations never write or delete replacement roots', {
  skip: process.platform === 'win32' && 'Windows denies renaming a retained open directory',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-root-swap-back-'))
  const stateRoot = join(root, 'state')
  const stateAway = join(root, 'state-away')
  const externalState = join(root, 'external-state')
  const managedRoot = join(root, 'managed')
  const managedAway = join(root, 'managed-away')
  const externalManaged = join(root, 'external-managed')
  const workspace = join(root, 'workspace')
  for (const path of [stateRoot, externalState, managedRoot, externalManaged, workspace]) {
    await mkdir(path, {mode: 0o700})
  }
  await writeFile(join(externalState, 'sentinel.txt'), 'state sentinel')
  await writeFile(join(externalManaged, 'sentinel.txt'), 'managed sentinel')
  const rootFiles = new SwapAroundDescriptorOperationsAuthority({
    state: {live: stateRoot, away: stateAway, replacement: externalState},
    managed: {live: managedRoot, away: managedAway, replacement: externalManaged},
  })
  const ids = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await ProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles,
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    await store.ensureImported('registered', hostWorkspaceForTest(await realpath(workspace)))
    const managed = await store.createManaged('managed')
    assert.equal(rootFiles.stateRenameSwapped, true)
    assert.equal(rootFiles.managedMkdirSwapped, true)
    assert.equal((await lstat(managed.canonical_path)).isDirectory(), true)
    assert.deepEqual(await readdir(externalState), ['sentinel.txt'])
    assert.deepEqual(await readdir(externalManaged), ['sentinel.txt'])
    assert.equal(await readFile(join(externalState, 'sentinel.txt'), 'utf8'), 'state sentinel')
    assert.equal(await readFile(join(externalManaged, 'sentinel.txt'), 'utf8'), 'managed sentinel')
  } finally {
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('state-root replacement during descriptor acquire cannot redirect state writes', {
  skip: process.platform === 'win32' && 'requires POSIX open-directory rename and symlink semantics',
}, async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-root-acquire-swap-')
  const {root, stateRoot} = storeFixture
  const retainedRoot = join(root, 'state-retained')
  const replacementRoot = join(root, 'replacement')
  const workspacePath = join(root, 'workspace')
  await mkdir(replacementRoot, {mode: 0o700})
  await mkdir(workspacePath, {mode: 0o700})
  let swapped = false
  const nativeLocks: NativeFileLockAuthority = {
    acquire: () => {
      if (!swapped) {
        renameSync(stateRoot, retainedRoot)
        symlinkSync(replacementRoot, stateRoot, 'dir')
        swapped = true
      }
      return {status: 'acquired', release: () => undefined}
    },
  }
  const store = await storeFixture.open({
    nativeLocks,
    idFactory: () => 'workspace-0001',
  })
  try {
    await assert.rejects(
      within(
        'state-root acquire replacement',
        store.ensureImported('alpha', hostWorkspaceForTest(await realpath(workspacePath))),
        200,
      ),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
    await assert.rejects(lstat(join(replacementRoot, 'codex-projects-v1.json')), {code: 'ENOENT'})
    await rm(stateRoot)
    await rename(retainedRoot, stateRoot)
    await assert.rejects(
      store.snapshot(),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
  } finally {
    await storeFixture.close(store)
  }
})

test('live owner acquisition validates the retained state-root identity before open returns', {
  skip: process.platform === 'win32' && 'requires POSIX open-directory rename and symlink semantics',
}, async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-owner-root-swap-')
  const {root, stateRoot} = storeFixture
  const retainedRoot = join(root, 'state-retained')
  const replacementRoot = join(root, 'replacement')
  await mkdir(replacementRoot, {mode: 0o700})
  let swapped = false
  const nativeLocks: NativeFileLockAuthority = {
    acquire: () => {
      if (!swapped) {
        renameSync(stateRoot, retainedRoot)
        symlinkSync(replacementRoot, stateRoot, 'dir')
        swapped = true
      }
      return {status: 'acquired', release: () => undefined}
    },
  }
  try {
    await assert.rejects(
      storeFixture.open({
        nativeLocks,
        live: true,
      }),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
    await assert.rejects(lstat(join(replacementRoot, 'codex-projects-v1.json')), {code: 'ENOENT'})
  } finally {
    await storeFixture.close()
  }
})

test('state-root replacement after atomic replace is detected and permanently poisons the store', {
  skip: process.platform === 'win32' && 'requires POSIX open-directory rename and symlink semantics',
}, async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-root-commit-swap-')
  const {root, stateRoot} = storeFixture
  const retainedRoot = join(root, 'state-retained')
  const replacementRoot = join(root, 'replacement')
  const workspacePath = join(root, 'workspace')
  await mkdir(replacementRoot, {mode: 0o700})
  await mkdir(workspacePath, {mode: 0o700})
  let swapped = false
  const durability: string[] = []
  const store = await storeFixture.open({
    idFactory: () => 'workspace-0001',
    onDurabilityStep: step => {
      durability.push(step)
      if (step === 'atomic_replace' && !swapped) {
        renameSync(stateRoot, retainedRoot)
        symlinkSync(replacementRoot, stateRoot, 'dir')
        swapped = true
      }
    },
  })
  try {
    await assert.rejects(
      store.ensureImported('alpha', hostWorkspaceForTest(await realpath(workspacePath))),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
    assert.equal(durability.includes('dir_fsync'), false)
    await assert.rejects(
      store.snapshot(),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
    assert.deepEqual(await readdir(replacementRoot), [])
  } finally {
    await storeFixture.close(store)
  }
})

test('an asynchronous or never-settling native acquire is malformed and fails immediately', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-async-lock-')

  const never = new Promise<NativeFileLockResult>(() => undefined)
  const nativeLocks = {
    acquire: () => never,
  } as unknown as NativeFileLockAuthority
  const store = await storeFixture.open({
    nativeLocks,
  })
  let closeSettled = false
  try {
    await assert.rejects(
      within('malformed asynchronous native acquire', store.snapshot(), 200),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_lock_failed',
    )
    await within('close after malformed asynchronous native acquire', store.close(), 200)
    closeSettled = true
  } finally {
    if (closeSettled) await store.close()
    else void store.close()
    const thenableLocks = {
      acquire: () => ({status: 'busy', then: () => undefined}),
    } as unknown as NativeFileLockAuthority
    const thenableStore = await storeFixture.open({
      nativeLocks: thenableLocks,
    })
    let thenableClosed = false
    try {
      await assert.rejects(
        within('malformed synchronous thenable acquire', thenableStore.snapshot(), 200),
        (error: unknown) => error instanceof ProjectStateError
          && error.code === 'state_lock_failed',
      )
      await within('close after malformed synchronous thenable acquire', thenableStore.close(), 200)
      thenableClosed = true
    } finally {
      if (thenableClosed) await thenableStore.close()
      else void thenableStore.close()
    }
    await storeFixture.close()
  }
})

test('a transaction joins asynchronous native unlock before its promise settles', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-lock-join-')

  const nativeLocks = new DeferredReleaseLockAuthority()
  const releaseStarted = nativeLocks.deferNextRelease()
  const store = await storeFixture.open({
    nativeLocks,
  })
  try {
    let settled = false
    const snapshot = store.snapshot().finally(() => { settled = true })
    await within('native release start', releaseStarted)
    assert.equal(settled, false, 'snapshot must remain owned until descriptor unlock finishes')
    let closeSettled = false
    const closing = store.close().finally(() => { closeSettled = true })
    await Promise.resolve()
    assert.equal(closeSettled, false, 'close must join the transaction before releasing ownership')
    nativeLocks.releaseNow?.()
    await within('snapshot after native release', snapshot)
    await within('store close after transaction', closing)
    assert.equal(settled, true)
  } finally {
    nativeLocks.releaseNow?.()
    await storeFixture.close(store)
  }
})

test('same-instance default transactions wait behind an active transaction before native lock acquisition', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-instance-queue-')
  const {root} = storeFixture
  const firstPath = join(root, 'background')
  const secondPath = join(root, 'foreground')
  await mkdir(firstPath, {mode: 0o700})
  await mkdir(secondPath, {mode: 0o700})
  const nativeLocks = new DeferredReleaseLockAuthority()
  const ids = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await storeFixture.open({
    nativeLocks,
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    const releaseStarted = nativeLocks.deferNextRelease()
    const first = store.ensureImported('background', hostWorkspaceForTest(await realpath(firstPath)))
    await within('background transaction release start', releaseStarted)
    const callsBeforeSecond = nativeLocks.acquireCalls
    let secondSettled = false
    const second = store
      .ensureImported('foreground', hostWorkspaceForTest(await realpath(secondPath)))
      .finally(() => { secondSettled = true })
    void second.catch(() => undefined)
    await new Promise<void>(resolveTurn => { setImmediate(resolveTurn) })
    assert.equal(secondSettled, false, 'foreground transaction must wait for predecessor ownership')
    assert.equal(
      nativeLocks.acquireCalls,
      callsBeforeSecond,
      'queued same-instance transaction must not collide with the held native lock',
    )
    nativeLocks.releaseNow?.()
    assert.equal((await within('background transaction', first)).workspace_id, 'workspace-0001')
    assert.equal((await within('foreground transaction', second)).workspace_id, 'workspace-0002')
  } finally {
    nativeLocks.releaseNow?.()
    await storeFixture.close(store)
  }
})

test('a caller signal aborts a queued same-instance transaction before native lock acquisition', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-instance-queue-abort-')
  const {root} = storeFixture
  const workspacePath = join(root, 'workspace')
  const holderPath = join(root, 'holder')
  await mkdir(workspacePath, {mode: 0o700})
  await mkdir(holderPath, {mode: 0o700})
  const nativeLocks = new DeferredReleaseLockAuthority()
  const ids = ['workspace-0001', 'session-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await storeFixture.open({
    nativeLocks,
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    const workspace = await store.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const starting = await store.beginSession(workspace.workspace_id, '任务')
    const releaseStarted = nativeLocks.deferNextRelease()
    const holder = store.ensureImported('holder', hostWorkspaceForTest(await realpath(holderPath)))
    await within('holder transaction release start', releaseStarted)
    const callsBeforeQueued = nativeLocks.acquireCalls
    const abort = new AbortController()
    const rollback = (store.rollbackSessionStart as unknown as (
      sessionId: string,
      options: {readonly wait: boolean; readonly signal: AbortSignal},
    ) => Promise<boolean>).call(store, starting.session_id, {wait: true, signal: abort.signal})
    void rollback.catch(() => undefined)
    await new Promise<void>(resolveTurn => { setImmediate(resolveTurn) })
    assert.equal(nativeLocks.acquireCalls, callsBeforeQueued)
    abort.abort()
    await assert.rejects(
      within('caller-aborted same-instance predecessor wait', rollback, 100),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )
    nativeLocks.releaseNow?.()
    await within('holder transaction', holder)
    assert.equal((await store.resolveSession(workspace.workspace_id, null)).state, 'starting')
  } finally {
    nativeLocks.releaseNow?.()
    await storeFixture.close(store)
  }
})

test('store close aborts a queued same-instance transaction before native lock acquisition', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-instance-queue-close-')
  const {root} = storeFixture
  const firstPath = join(root, 'background')
  const secondPath = join(root, 'foreground')
  await mkdir(firstPath, {mode: 0o700})
  await mkdir(secondPath, {mode: 0o700})
  const nativeLocks = new DeferredReleaseLockAuthority()
  const ids = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await storeFixture.open({
    nativeLocks,
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    const releaseStarted = nativeLocks.deferNextRelease()
    const first = store.ensureImported('background', hostWorkspaceForTest(await realpath(firstPath)))
    await within('background transaction release start', releaseStarted)
    const second = store.ensureImported('foreground', hostWorkspaceForTest(await realpath(secondPath)))
    void second.catch(() => undefined)
    let closeSettled = false
    const closing = store.close().finally(() => { closeSettled = true })
    await assert.rejects(
      within('close-aborted same-instance predecessor wait', second, 100),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_lock_failed',
    )
    assert.equal(closeSettled, false, 'close must still join the active predecessor transaction')
    nativeLocks.releaseNow?.()
    await within('background transaction', first)
    await within('store close after queued transaction abort', closing)
  } finally {
    nativeLocks.releaseNow?.()
    await storeFixture.close(store)
  }
})

test('rollback and first-live recovery use one bounded abort-aware descriptor-lock wait', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-lock-wait-')
  const {root} = storeFixture
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, {mode: 0o700})
  const nativeLocks = new BusyThenDescriptorLockAuthority()
  const clock = new AdvancingClock()
  const ids = ['workspace-0001', 'session-0001', 'session-0002'][Symbol.iterator]()
  const options = await storeFixture.options({
    nativeLocks,
    idFactory: () => ids.next().value ?? 'unused-id',
    lockClock: clock,
  })
  let ordinary: ProjectStore | null = null
  let live: ProjectStore | null = null
  try {
    ordinary = await ProjectStore.open(options)
    const workspace = await ordinary.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const rolledBack = await ordinary.beginSession(workspace.workspace_id, 'rolled back')
    nativeLocks.busyAttempts = 2
    assert.equal(
      await (ordinary.rollbackSessionStart as unknown as (
        sessionId: string,
        options: {readonly wait: boolean},
      ) => Promise<boolean>).call(ordinary, rolledBack.session_id, {wait: true}),
      true,
    )
    assert.deepEqual(clock.sleeps, [0.025, 0.025])

    const crashed = await ordinary.beginSession(workspace.workspace_id, 'crashed')
    await ordinary.close()
    ordinary = null
    live = await ProjectStore.open({...options, live: true})
    nativeLocks.busyAttempts = 2
    assert.equal((await live.resolveSession(workspace.workspace_id, crashed.display_title)).state, 'unavailable')
    assert.deepEqual(clock.sleeps, [0.025, 0.025, 0.025, 0.025])
  } finally {
    await storeFixture.close(ordinary, live)
  }
})

test('managed-create rollback opts into the same bounded descriptor-lock wait', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-managed-lock-wait-')

  const nativeLocks = new BusyThenDescriptorLockAuthority()
  const clock = new AdvancingClock()
  const store = await storeFixture.open({
    nativeLocks,
    idFactory: () => 'workspace-0001',
    lockClock: clock,
  })
  try {
    const created = await store.createManaged('alpha')
    nativeLocks.busyAttempts = 2
    assert.equal(
      await store.rollbackManagedCreate(created.workspace_id, {wait: true}),
      true,
    )
    assert.deepEqual(clock.sleeps, [0.025, 0.025])
    await assert.rejects(lstat(created.canonical_path), {code: 'ENOENT'})
  } finally {
    await storeFixture.close(store)
  }
})

test('ready and unavailable finalization opt into the same bounded descriptor-lock wait', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-finalize-lock-wait-')
  const {root} = storeFixture
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, {mode: 0o700})
  const nativeLocks = new BusyThenDescriptorLockAuthority()
  const clock = new AdvancingClock()
  const ids = ['workspace-0001', 'session-0001'][Symbol.iterator]()
  const store = await storeFixture.open({
    nativeLocks,
    idFactory: () => ids.next().value ?? 'unused-id',
    lockClock: clock,
  })
  try {
    const workspace = await store.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const starting = await store.beginSession(workspace.workspace_id, '任务')
    nativeLocks.busyAttempts = 2
    const ready = await store.markSessionReady(
      starting.session_id,
      'thread-ready',
      {wait: true},
    )
    assert.equal(ready.state, 'ready')
    nativeLocks.busyAttempts = 2
    const unavailable = await store.markSessionUnavailable(starting.session_id, {wait: true})
    assert.equal(unavailable.state, 'unavailable')
    assert.deepEqual(clock.sleeps, [0.025, 0.025, 0.025, 0.025])
  } finally {
    await storeFixture.close(store)
  }
})

test('an aborted bounded lock wait settles and is joined before store close returns', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-lock-abort-')
  const {root} = storeFixture
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, {mode: 0o700})
  const nativeLocks = new BusyThenDescriptorLockAuthority()
  const clock = new VirtualClock()
  const ids = ['workspace-0001', 'session-0001'][Symbol.iterator]()
  const options = await storeFixture.options({
    nativeLocks,
    idFactory: () => ids.next().value ?? 'unused-id',
    lockClock: clock,
  })
  const store = await ProjectStore.open(options)
  try {
    const workspace = await store.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const starting = await store.beginSession(workspace.workspace_id, '任务')
    nativeLocks.busyAttempts = Number.MAX_SAFE_INTEGER
    const abort = new AbortController()
    const rollback = (store.rollbackSessionStart as unknown as (
      sessionId: string,
      options: {readonly wait: boolean; readonly signal: AbortSignal},
    ) => Promise<boolean>).call(store, starting.session_id, {wait: true, signal: abort.signal})
    void rollback.catch(() => undefined)
    for (let attempt = 0; attempt < 1_000 && clock.waiterCount() === 0; attempt += 1) {
        await new Promise<void>(resolveTurn => { setImmediate(resolveTurn) })
    }
    assert.equal(clock.waiterCount(), 1, 'bounded lock wait must register one abort-aware sleep')
    abort.abort()
    await assert.rejects(
      within('caller-aborted lock wait', rollback, 100),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )
    await within('store close after aborted lock wait', store.close())
    assert.equal(clock.waiterCount(), 0)
  } finally {
    await storeFixture.close(store)
  }
})

test('a bounded lock wait exhausts one fixed deadline and returns stable state_busy', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-lock-deadline-')
  const {root} = storeFixture
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, {mode: 0o700})
  const nativeLocks = new BusyThenDescriptorLockAuthority()
  const clock = new AdvancingClock()
  const ids = ['workspace-0001', 'session-0001'][Symbol.iterator]()
  const store = await storeFixture.open({
    nativeLocks,
    idFactory: () => ids.next().value ?? 'unused-id',
    lockClock: clock,
  })
  try {
    const workspace = await store.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const starting = await store.beginSession(workspace.workspace_id, '任务')
    nativeLocks.busyAttempts = Number.MAX_SAFE_INTEGER
    const callsBeforeWait = nativeLocks.acquireCalls
    await assert.rejects(
      within(
        'bounded lock deadline',
        store.rollbackSessionStart(starting.session_id, {wait: true}),
      ),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_busy',
    )
    const waited = clock.sleeps.reduce((total, duration) => total + duration, 0)
    assert.equal(Math.abs(waited - 2) < 1e-9, true)
    assert.equal(clock.sleeps.every(duration => duration > 0 && duration <= 0.025), true)
    assert.equal(nativeLocks.acquireCalls - callsBeforeWait < 100, true)
    nativeLocks.busyAttempts = 0
    assert.equal((await store.resolveSession(workspace.workspace_id, null)).state, 'starting')
  } finally {
    nativeLocks.busyAttempts = 0
    await storeFixture.close(store)
  }
})

test('live owner exclusion and first-transaction recovery are crash-safe and ordinary readers do not recover', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-owner-')
  const {root} = storeFixture
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, {mode: 0o700})
  const nativeLocks = new DescriptorLockAuthority()
  const ids = ['workspace-0001', 'session-0001'][Symbol.iterator]()
  const options = await storeFixture.options({
    nativeLocks,
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  let first: ProjectStore | null = null
  let ordinary: ProjectStore | null = null
  let restarted: ProjectStore | null = null
  try {
    first = await ProjectStore.open({...options, live: true})
    const workspace = await first.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const starting = await first.beginSession(workspace.workspace_id, 'Task 1')
    await assert.rejects(
      ProjectStore.open({...options, live: true}),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_busy',
    )
    ordinary = await ProjectStore.open(options)
    assert.equal((await ordinary.resolveSession(workspace.workspace_id, 'Task 1')).state, 'starting')
    await ordinary.close()
    ordinary = null
    await first.close()
    first = null
    restarted = await ProjectStore.open({...options, live: true})
    const recovered = await restarted.resolveSession(workspace.workspace_id, starting.display_title)
    assert.equal(recovered.state, 'unavailable')
  } finally {
    await storeFixture.close(first, ordinary, restarted)
  }
})

test('registry no-follow, owner mode, byte cap, strict decode, and corrupt-byte preservation fail closed', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-state-security-')
  const {root, stateRoot} = storeFixture
  const statePath = join(stateRoot, 'codex-projects-v1.json')
  const options = await storeFixture.options()
  const expectCode = async (code: string): Promise<void> => {
    const store = await ProjectStore.open(options)
    try {
      await assert.rejects(
        store.snapshot(),
        (error: unknown) => error instanceof ProjectStateError && error.code === code,
      )
    } finally {
      await store.close()
    }
  }
  try {
    const corrupt = Buffer.from('{"version":1,"active_workspace_id":null,"workspaces":{},"sessions":{},"extra":true}')
    await writeFile(statePath, corrupt, {mode: 0o600})
    await chmod(statePath, 0o600)
    await expectCode('state_corrupt')
    assert.deepEqual(await readFile(statePath), corrupt)

    await writeFile(statePath, JSON.stringify({
      version: 99, active_workspace_id: null, workspaces: {}, sessions: {},
    }), {mode: 0o600})
    await chmod(statePath, 0o600)
    await expectCode('state_version_unsupported')

    const emptyState = Buffer.from('{"version":1,"active_workspace_id":null,"workspaces":{},"sessions":{}}')
    await writeFile(statePath, Buffer.concat([
      emptyState,
      Buffer.alloc(1024 * 1024 - emptyState.byteLength, 0x20),
    ]), {mode: 0o600})
    const exactLimit = await ProjectStore.open(options)
    try {
      assert.deepEqual(await exactLimit.snapshot(), {
        version: 2, state_revision: 0, active_binding_revision: 0,
        active_workspace_id: null, workspaces: [], sessions: [],
      })
      await exactLimit.createManaged('migrated')
      const migrated = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
      assert.equal(migrated.active_binding_revision, 1)
      assert.equal(migrated.state_revision, 2)
      assert.deepEqual(Object.keys(migrated).sort(), [
        'active_binding_revision', 'active_workspace_id', 'sessions', 'state_revision',
        'version', 'workspaces',
      ])
    } finally {
      await exactLimit.close()
    }

    await writeFile(statePath, Buffer.alloc(1024 * 1024 + 1, 0x20), {mode: 0o600})
    await chmod(statePath, 0o600)
    await expectCode('state_too_large')

    if (process.platform !== 'win32') {
      await writeFile(statePath, '{}', {mode: 0o600})
      await chmod(statePath, 0o644)
      await expectCode('state_permissions')
    }

    await rm(statePath)
    const invalidUtf8State = Buffer.concat([
      Buffer.from('{"version":1,"active_workspace_id":"workspace-0001","workspaces":{"workspace-0001":{"workspace_id":"workspace-0001","display_name":"'),
      Buffer.from([0xff]),
      Buffer.from('","normalized_name":"'),
      Buffer.from([0xff]),
      Buffer.from('","canonical_path":"/tmp/workspace","origin":"registered","codex_home_key":"home-workspace-0001","active_session_id":null,"created_at":1,"last_used_at":1}},"sessions":{}}'),
    ])
    await writeFile(statePath, invalidUtf8State, {mode: 0o600})
    await expectCode('state_corrupt')

    if (process.platform !== 'win32') {
      await rm(statePath)
      const outside = join(root, 'outside')
      await writeFile(outside, '{}', {mode: 0o600})
      await symlink(outside, statePath)
      await expectCode('state_permissions')
    }
  } finally {
    await storeFixture.close()
  }
})

test('state revision increments once per mutation and maintenance snapshots pin managed identities', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-revision-')
  const {stateRoot, managedRoot} = storeFixture
  const identifiers = ['workspace-0001', 'session-0001'][Symbol.iterator]()
  const rootFiles = new ToggleRemoveTreeRootFileAuthority([stateRoot, managedRoot])
  const storeOptions = await storeFixture.options({
    rootFiles,
    now: () => 100,
    idFactory: () => identifiers.next().value ?? 'unused-id',
  })
  let store = await ProjectStore.open(storeOptions)
  try {
    assert.equal((await store.snapshot()).state_revision, 0)
    const workspace = await store.createManaged('Alpha')
    assert.equal((await store.snapshot()).state_revision, 1)

    const maintenance = await store.maintenanceSnapshot()
    assert.equal(maintenance.state_revision, 1)
    assert.equal(maintenance.active_workspace_id, workspace.workspace_id)
    assert.equal(maintenance.managed_targets.length, 1)
    assert.equal(maintenance.managed_targets[0]?.workspace.workspace_id, workspace.workspace_id)
    assert.equal(typeof maintenance.managed_targets[0]?.identity.device, 'bigint')
    assert.equal(Object.isFrozen(maintenance.managed_targets[0]?.workspace), true)
    assert.equal((await store.snapshot()).state_revision, 1)

    await store.beginSessionForRun(workspace.workspace_id, 'Task')
    assert.equal((await store.snapshot()).state_revision, 2)

    await mkdir(join(workspace.canonical_path, 'nested'))
    await writeFile(join(workspace.canonical_path, 'nested', 'data.txt'), 'delete me')
    const beforeReplacement = await store.snapshot()
    const replacementSnapshot = await store.maintenanceSnapshot()
    const target = replacementSnapshot.managed_targets[0]
    assert.ok(target)
    const stale = await store.executeManagedReplacement({
      expected_state_revision: replacementSnapshot.state_revision - 1,
      targets: [{
        workspace_id: workspace.workspace_id,
        canonical_path: workspace.canonical_path,
        identity: target.identity,
        tombstone_name: '.nova-maintenance-operation-0001-1',
      }],
    })
    assert.equal(stale.committed, false)
    assert.equal(stale.status, 'stale')
    const replaced = await store.executeManagedReplacement({
      expected_state_revision: replacementSnapshot.state_revision,
      targets: [{
        workspace_id: workspace.workspace_id,
        canonical_path: workspace.canonical_path,
        identity: target.identity,
        tombstone_name: '.nova-maintenance-operation-0001-1',
      }],
    })
    assert.equal(replaced.committed, true)
    assert.equal(replaced.status, 'committed')
    assert.deepEqual(await readdir(workspace.canonical_path), [])
    const afterReplacement = await store.snapshot()
    assert.equal(afterReplacement.state_revision, beforeReplacement.state_revision)
    assert.deepEqual(afterReplacement.workspaces, beforeReplacement.workspaces)
    assert.deepEqual(afterReplacement.sessions, beforeReplacement.sessions)
    assert.equal((await store.loadManagedMaintenanceJournal())?.operation_id, 'operation-0001')
    rootFiles.failRemoveTree = true
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'cleanup_pending'})
    assert.equal((await store.loadManagedMaintenanceJournal())?.operation_id, 'operation-0001')
    await store.close()
    store = await ProjectStore.open(storeOptions)
    assert.equal((await store.loadManagedMaintenanceJournal())?.operation_id, 'operation-0001')
    rootFiles.failRemoveTree = false
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'clean'})
    assert.equal(await store.loadManagedMaintenanceJournal(), null)
  } finally {
    await storeFixture.close(store)
  }
})

test('all managed originals are detached before any replacement is created', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-maintenance-order-')
  const {stateRoot, managedRoot} = storeFixture
  const identifiers = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const rootFiles = new MaintenanceOrderRootFileAuthority([stateRoot, managedRoot])
  const store = await storeFixture.open({
    rootFiles,
    idFactory: () => identifiers.next().value ?? 'unused-id',
  })
  try {
    await store.createManaged('Alpha')
    await store.createManaged('Beta')
    const snapshot = await store.maintenanceSnapshot()
    rootFiles.recording = true
    const result = await store.executeManagedReplacement({
      expected_state_revision: snapshot.state_revision,
      targets: snapshot.managed_targets.map((target, index) => ({
        workspace_id: target.workspace.workspace_id,
        canonical_path: target.workspace.canonical_path,
        identity: target.identity,
        tombstone_name: `.nova-maintenance-operation-0001-${index + 1}`,
      })),
    })
    assert.equal(result.committed, true)
    assert.equal(result.status, 'committed')
    const firstMkdir = rootFiles.events.findIndex(event => event.startsWith('mkdir:'))
    assert.equal(
      rootFiles.events.slice(0, firstMkdir).filter(event => event.startsWith('rename:')).length,
      2,
      JSON.stringify(rootFiles.events),
    )
    assert.equal(firstMkdir, 2)
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'clean'})
  } finally {
    await storeFixture.close(store)
  }
})

test('maintenance rename never overwrites a destination raced into the managed root', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-maintenance-collision-')
  const {stateRoot, managedRoot} = storeFixture
  const rootFiles = new MaintenanceCollisionRootFileAuthority([stateRoot, managedRoot])
  const store = await storeFixture.open({
    rootFiles,
    idFactory: () => 'workspace-0001',
  })
  try {
    const workspace = await store.createManaged('Alpha')
    await writeFile(join(workspace.canonical_path, 'original.txt'), 'preserve me')
    const snapshot = await store.maintenanceSnapshot()
    const target = snapshot.managed_targets[0]
    assert.ok(target)
    const tombstoneName = '.nova-maintenance-operation-0001-1'

    const result = await store.executeManagedReplacement({
      expected_state_revision: snapshot.state_revision,
      targets: [{
        workspace_id: workspace.workspace_id,
        canonical_path: workspace.canonical_path,
        identity: target.identity,
        tombstone_name: tombstoneName,
      }],
    })

    assert.deepEqual(result, {status: 'rolled_back', committed: false, tombstones: []})
    assert.notEqual(rootFiles.collisionIdentity, null)
    const collision = await lstat(join(managedRoot, tombstoneName), {bigint: true})
    assert.equal(collision.dev, rootFiles.collisionIdentity?.device)
    assert.equal(collision.ino, rootFiles.collisionIdentity?.inode)
    assert.equal(await readFile(join(workspace.canonical_path, 'original.txt'), 'utf8'), 'preserve me')
  } finally {
    await storeFixture.close(store)
  }
})

test('managed-root metadata is durable before commit and cleanup journal advancement', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-maintenance-durability-')
  const {stateRoot, managedRoot} = storeFixture
  const identifiers = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const rootFiles = new MaintenanceDurabilityRootFileAuthority([stateRoot, managedRoot])
  const store = await storeFixture.open({
    rootFiles,
    idFactory: () => identifiers.next().value ?? 'unused-id',
  })
  try {
    await store.createManaged('Alpha')
    await store.createManaged('Beta')
    const snapshot = await store.maintenanceSnapshot()
    rootFiles.recording = true
    const result = await store.executeManagedReplacement({
      expected_state_revision: snapshot.state_revision,
      targets: snapshot.managed_targets.map((target, index) => ({
        workspace_id: target.workspace.workspace_id,
        canonical_path: target.workspace.canonical_path,
        identity: target.identity,
        tombstone_name: `.nova-maintenance-operation-0001-${index + 1}`,
      })),
    })
    assert.equal(result.status, 'committed')
    const commitJournal = rootFiles.events.lastIndexOf('journal:write')
    const commitBarrier = rootFiles.events.lastIndexOf('managed:sync', commitJournal)
    assert.notEqual(commitJournal, -1, JSON.stringify(rootFiles.events))
    assert.notEqual(commitBarrier, -1, JSON.stringify(rootFiles.events))
    assert.equal(commitBarrier < commitJournal, true, JSON.stringify(rootFiles.events))

    rootFiles.events.length = 0
    rootFiles.failCleanupName = '.nova-maintenance-operation-0001-2'
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'cleanup_pending'})
    const shrinkJournal = rootFiles.events.lastIndexOf('journal:write')
    const shrinkBarrier = rootFiles.events.lastIndexOf('managed:sync', shrinkJournal)
    assert.notEqual(shrinkJournal, -1, JSON.stringify(rootFiles.events))
    assert.notEqual(shrinkBarrier, -1, JSON.stringify(rootFiles.events))
    assert.equal(shrinkBarrier < shrinkJournal, true, JSON.stringify(rootFiles.events))

    rootFiles.events.length = 0
    rootFiles.failCleanupName = null
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'clean'})
    const clearJournal = rootFiles.events.lastIndexOf('journal:clear')
    const clearBarrier = rootFiles.events.lastIndexOf('managed:sync', clearJournal)
    assert.notEqual(clearJournal, -1, JSON.stringify(rootFiles.events))
    assert.notEqual(clearBarrier, -1, JSON.stringify(rootFiles.events))
    assert.equal(clearBarrier < clearJournal, true, JSON.stringify(rootFiles.events))
  } finally {
    await storeFixture.close(store)
  }
})

test('managed-root rollback is durable before its journal is cleared', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-maintenance-rollback-durability-')
  const {stateRoot, managedRoot} = storeFixture
  const identifiers = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const rootFiles = new MaintenanceDurabilityRootFileAuthority([stateRoot, managedRoot])
  const store = await storeFixture.open({
    rootFiles,
    idFactory: () => identifiers.next().value ?? 'unused-id',
  })
  try {
    const alpha = await store.createManaged('Alpha')
    const beta = await store.createManaged('Beta')
    await writeFile(join(alpha.canonical_path, 'alpha.txt'), 'alpha')
    await writeFile(join(beta.canonical_path, 'beta.txt'), 'beta')
    const snapshot = await store.maintenanceSnapshot()
    rootFiles.recording = true
    rootFiles.failReplacementNumber = 2
    const result = await store.executeManagedReplacement({
      expected_state_revision: snapshot.state_revision,
      targets: snapshot.managed_targets.map((target, index) => ({
        workspace_id: target.workspace.workspace_id,
        canonical_path: target.workspace.canonical_path,
        identity: target.identity,
        tombstone_name: `.nova-maintenance-operation-0001-${index + 1}`,
      })),
    })
    assert.equal(result.status, 'rolled_back')
    const clearJournal = rootFiles.events.lastIndexOf('journal:clear')
    const rollbackBarrier = rootFiles.events.lastIndexOf('managed:sync', clearJournal)
    assert.notEqual(clearJournal, -1, JSON.stringify(rootFiles.events))
    assert.notEqual(rollbackBarrier, -1, JSON.stringify(rootFiles.events))
    assert.equal(rollbackBarrier < clearJournal, true, JSON.stringify(rootFiles.events))
    assert.equal(await readFile(join(alpha.canonical_path, 'alpha.txt'), 'utf8'), 'alpha')
    assert.equal(await readFile(join(beta.canonical_path, 'beta.txt'), 'utf8'), 'beta')
  } finally {
    await storeFixture.close(store)
  }
})

test('a later replacement failure restores every original in the prepared set', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-maintenance-rollback-')
  const {stateRoot, managedRoot} = storeFixture
  const identifiers = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const rootFiles = new FailNthMaintenanceMkdirAuthority([stateRoot, managedRoot])
  const store = await storeFixture.open({
    rootFiles,
    idFactory: () => identifiers.next().value ?? 'unused-id',
  })
  try {
    const alpha = await store.createManaged('Alpha')
    const beta = await store.createManaged('Beta')
    await writeFile(join(alpha.canonical_path, 'alpha.txt'), 'alpha')
    await writeFile(join(beta.canonical_path, 'beta.txt'), 'beta')
    const snapshot = await store.maintenanceSnapshot()
    rootFiles.enabled = true
    const result = await store.executeManagedReplacement({
      expected_state_revision: snapshot.state_revision,
      targets: snapshot.managed_targets.map((target, index) => ({
        workspace_id: target.workspace.workspace_id,
        canonical_path: target.workspace.canonical_path,
        identity: target.identity,
        tombstone_name: `.nova-maintenance-operation-0001-${index + 1}`,
      })),
    })
    assert.equal(result.committed, false)
    assert.equal(result.status, 'rolled_back')
    assert.equal(await readFile(join(alpha.canonical_path, 'alpha.txt'), 'utf8'), 'alpha')
    assert.equal(await readFile(join(beta.canonical_path, 'beta.txt'), 'utf8'), 'beta')
    assert.equal(await store.loadManagedMaintenanceJournal(), null)
  } finally {
    await storeFixture.close(store)
  }
})

test('desktop journal recovery waits for the live owner before changing managed files', async t => {
  for (const phase of ['prepared', 'committed'] as const) {
    await t.test(phase, async () => {
      const root = await mkdtemp(join(tmpdir(), 'nova-maintenance-live-owner-'))
      const stateRoot = join(root, 'state'), managedRoot = join(root, 'managed')
      await mkdir(stateRoot, {mode: 0o700})
      await mkdir(managedRoot, {mode: 0o700})
      const nativeLocks = new DescriptorLockAuthority()
      const rootFiles = new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot])
      const options = {
        stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
        managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
        nativeLocks, rootFiles, live: true, idFactory: () => 'workspace-0001',
        maintenanceFault: (step: string) => phase === 'prepared' && step === 'replacement_placed',
      }
      const store = await ProjectStore.open(options)
      let maintenance: ManagedWorkspaceMaintenanceService | undefined
      try {
        const workspace = await store.createManaged('Alpha')
        await writeFile(join(workspace.canonical_path, 'original.txt'), 'preserve until recovery')
        const snapshot = await store.maintenanceSnapshot()
        const target = snapshot.managed_targets[0]!
        const replacing = store.executeManagedReplacement({
          expected_state_revision: snapshot.state_revision,
          targets: [{workspace_id: workspace.workspace_id, canonical_path: workspace.canonical_path,
            identity: target.identity, tombstone_name: '.nova-maintenance-operation-0001-1'}],
        })
        if (phase === 'prepared') await assert.rejects(replacing, /maintenance fault/u)
        else assert.equal((await replacing).status, 'committed')
        const journalPath = join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE)
        const before = await readFile(journalPath)
        maintenance = await ManagedWorkspaceMaintenanceService.openFromDesktop({
          stateRoot: await realpath(stateRoot), managedRoot: await realpath(managedRoot),
          nativeHost: {nativeLocks, rootFiles} as unknown as Parameters<typeof ManagedWorkspaceMaintenanceService.openFromDesktop>[0]['nativeHost'],
        })
        assert.equal((await maintenance.capabilities()).health,
          phase === 'prepared' ? 'rollback_pending' : 'cleanup_pending')
        assert.deepEqual(await readFile(journalPath), before, 'observer cannot replay under a live owner')
        assert.equal(await readFile(join(managedRoot, '.nova-maintenance-operation-0001-1', 'original.txt'), 'utf8'), 'preserve until recovery')
        await store.close()
        assert.equal((await maintenance.capabilities()).health, 'ready')
        await assert.rejects(readFile(journalPath), /ENOENT/u)
        if (phase === 'prepared') {
          assert.equal(await readFile(join(workspace.canonical_path, 'original.txt'), 'utf8'), 'preserve until recovery')
        } else assert.deepEqual(await readdir(workspace.canonical_path), [])
      } finally {
        await maintenance?.close()
        await store.close().catch(() => undefined)
        await rm(root, {recursive: true, force: true})
      }
    })
  }
})

test('a prepared journal rolls back after restart without deleting a populated replacement', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-maintenance-recovery-')
  const {stateRoot, managedRoot} = storeFixture
  const options = await storeFixture.options({
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => 'workspace-0001',
  })
  let store = await ProjectStore.open(options)
  try {
    const workspace = await store.createManaged('Alpha')
    await writeFile(join(workspace.canonical_path, 'original.txt'), 'preserve me')
    const target = (await store.maintenanceSnapshot()).managed_targets[0]
    assert.ok(target)
    await store.close()
    const originalName = basename(workspace.canonical_path)
    const tombstoneName = '.nova-maintenance-operation-0001-1'
    await rename(workspace.canonical_path, join(managedRoot, tombstoneName))
    await mkdir(workspace.canonical_path, {mode: 0o700})
    const replacement = await lstat(workspace.canonical_path, {bigint: true})
    await writeFile(join(workspace.canonical_path, 'unknown.txt'), 'do not delete')
    await writeFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE), JSON.stringify({
      entries: [{
        identity: {
          device: target.identity.device.toString(10),
          inode: target.identity.inode.toString(10),
        },
        original_name: originalName,
        replacement_identity: {
          device: replacement.dev.toString(10),
          inode: replacement.ino.toString(10),
        },
        tombstone_name: tombstoneName,
        workspace_id: workspace.workspace_id,
      }],
      operation_id: 'operation-0001',
      phase: 'prepared',
      version: 1,
    }), {mode: 0o600})
    store = await ProjectStore.open(options)
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'rollback_pending'})
    assert.equal(await readFile(join(workspace.canonical_path, 'unknown.txt'), 'utf8'), 'do not delete')
    assert.equal(await readFile(join(managedRoot, tombstoneName, 'original.txt'), 'utf8'), 'preserve me')
    await rm(join(workspace.canonical_path, 'unknown.txt'))
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'clean'})
    assert.equal(await readFile(join(workspace.canonical_path, 'original.txt'), 'utf8'), 'preserve me')
    await assert.rejects(readFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE)), /ENOENT/u)
  } finally {
    await store.close().catch(() => undefined)
    await storeFixture.close()
  }
})

test('prepared recovery never deletes an empty replacement with an unbound identity', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-maintenance-substitution-')
  const {stateRoot, managedRoot} = storeFixture
  const options = await storeFixture.options({
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => 'workspace-0001',
  })
  let store = await ProjectStore.open(options)
  try {
    const workspace = await store.createManaged('Alpha')
    await writeFile(join(workspace.canonical_path, 'original.txt'), 'preserve me')
    const target = (await store.maintenanceSnapshot()).managed_targets[0]
    assert.ok(target)
    await store.close()
    const tombstoneName = '.nova-maintenance-operation-0001-1'
    await rename(workspace.canonical_path, join(managedRoot, tombstoneName))
    await mkdir(workspace.canonical_path, {mode: 0o700})
    const bound = await lstat(workspace.canonical_path, {bigint: true})
    await writeFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE), JSON.stringify({
      entries: [{
        identity: {device: target.identity.device.toString(10), inode: target.identity.inode.toString(10)},
        original_name: basename(workspace.canonical_path),
        replacement_identity: {device: bound.dev.toString(10), inode: bound.ino.toString(10)},
        tombstone_name: tombstoneName,
        workspace_id: workspace.workspace_id,
      }],
      operation_id: 'operation-0001',
      phase: 'prepared',
      version: 1,
    }), {mode: 0o600})
    await rename(workspace.canonical_path, join(managedRoot, 'substituted-away'))
    await mkdir(workspace.canonical_path, {mode: 0o700})
    const substitute = await lstat(workspace.canonical_path, {bigint: true})
    store = await ProjectStore.open(options)
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'rollback_pending'})
    const stillPresent = await lstat(workspace.canonical_path, {bigint: true})
    assert.equal(stillPresent.ino, substitute.ino)
    assert.equal(await readFile(join(managedRoot, tombstoneName, 'original.txt'), 'utf8'), 'preserve me')
  } finally {
    await store.close().catch(() => undefined)
    await storeFixture.close()
  }
})

test('a partially recovered prepared v1 maintenance journal remains decodable', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-v1-prepared-shrink-')
  const {stateRoot, managedRoot} = storeFixture
  const identifiers = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const options = await storeFixture.options({
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => identifiers.next().value ?? 'unused-id',
  })
  let store = await ProjectStore.open(options)
  try {
    const alpha = await store.createManaged('Alpha')
    const beta = await store.createManaged('Beta')
    const targets = (await store.maintenanceSnapshot()).managed_targets
    const alphaTarget = targets.find(target => target.workspace.workspace_id === alpha.workspace_id)
    const betaTarget = targets.find(target => target.workspace.workspace_id === beta.workspace_id)
    assert.ok(alphaTarget)
    assert.ok(betaTarget)
    await store.close()

    const alphaTombstone = '.nova-maintenance-operation-0001-1'
    const betaTombstone = '.nova-maintenance-operation-0001-2'
    await rename(alpha.canonical_path, join(managedRoot, alphaTombstone))
    await rename(beta.canonical_path, join(managedRoot, betaTombstone))
    await mkdir(beta.canonical_path, {mode: 0o700})
    const betaReplacement = await lstat(beta.canonical_path, {bigint: true})
    await writeFile(join(beta.canonical_path, 'busy.txt'), 'keep pending')
    await writeFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE), JSON.stringify({
      entries: [
        {
          identity: {
            device: alphaTarget.identity.device.toString(10),
            inode: alphaTarget.identity.inode.toString(10),
          },
          original_name: basename(alpha.canonical_path),
          replacement_identity: null,
          tombstone_name: alphaTombstone,
          workspace_id: alpha.workspace_id,
        },
        {
          identity: {
            device: betaTarget.identity.device.toString(10),
            inode: betaTarget.identity.inode.toString(10),
          },
          original_name: basename(beta.canonical_path),
          replacement_identity: {
            device: betaReplacement.dev.toString(10),
            inode: betaReplacement.ino.toString(10),
          },
          tombstone_name: betaTombstone,
          workspace_id: beta.workspace_id,
        },
      ],
      operation_id: 'operation-0001',
      phase: 'prepared',
      version: 1,
    }), {mode: 0o600})

    store = await ProjectStore.open(options)
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'rollback_pending'})
    const persisted = JSON.parse(await readFile(
      join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE), 'utf8',
    )) as {version?: unknown}
    assert.equal(persisted.version, 1)
    await store.close()

    store = await ProjectStore.open(options)
    assert.equal((await store.loadManagedMaintenanceJournal())?.phase, 'prepared')
    await rm(join(beta.canonical_path, 'busy.txt'))
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'clean'})
  } finally {
    await store.close().catch(() => undefined)
    await storeFixture.close()
  }
})

test('a partially cleaned committed v1 maintenance journal remains decodable', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-v1-committed-shrink-')
  const {stateRoot, managedRoot} = storeFixture
  const identifiers = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const rootFiles = new MaintenanceDurabilityRootFileAuthority([stateRoot, managedRoot])
  const options = await storeFixture.options({
    rootFiles,
    idFactory: () => identifiers.next().value ?? 'unused-id',
  })
  let store = await ProjectStore.open(options)
  try {
    await store.createManaged('Alpha')
    await store.createManaged('Beta')
    const snapshot = await store.maintenanceSnapshot()
    const tombstones = [
      '.nova-maintenance-operation-0001-1',
      '.nova-maintenance-operation-0001-2',
    ]
    const executed = await store.executeManagedReplacement({
      expected_state_revision: snapshot.state_revision,
      targets: snapshot.managed_targets.map((target, index) => ({
        workspace_id: target.workspace.workspace_id,
        canonical_path: target.workspace.canonical_path,
        identity: target.identity,
        tombstone_name: tombstones[index]!,
      })),
    })
    assert.equal(executed.status, 'committed')
    const journal = await store.loadManagedMaintenanceJournal()
    assert.ok(journal)
    await writeFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE), JSON.stringify({
      entries: journal.entries.map(entry => ({
        identity: {
          device: entry.identity.device.toString(10),
          inode: entry.identity.inode.toString(10),
        },
        original_name: entry.original_name,
        replacement_identity: entry.replacement_identity === null ? null : {
          device: entry.replacement_identity.device.toString(10),
          inode: entry.replacement_identity.inode.toString(10),
        },
        tombstone_name: entry.tombstone_name,
        workspace_id: entry.workspace_id,
      })),
      operation_id: journal.operation_id,
      phase: 'committed',
      version: 1,
    }), {mode: 0o600})

    rootFiles.failCleanupName = tombstones[1]!
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'cleanup_pending'})
    const persisted = JSON.parse(await readFile(
      join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE), 'utf8',
    )) as {version?: unknown}
    assert.equal(persisted.version, 1)
    await store.close()

    rootFiles.failCleanupName = null
    store = await ProjectStore.open({...options, live: true})
    assert.equal(await store.loadManagedMaintenanceJournal(), null, 'live open replays legacy committed journals')
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'clean'})
  } finally {
    await store.close().catch(() => undefined)
    await storeFixture.close()
  }
})

test('replacement crash boundaries recover the operation-owned temporary in either legal position', async t => {
  for (const crashPoint of [
    'replacement_created',
    'replacement_identity_persisted',
    'replacement_placed',
  ] as const) {
    await t.test(crashPoint, async () => {
      const storeFixture = await projectStoreFixture(`nova-codex-project-maintenance-${crashPoint}-`)
      const {stateRoot, managedRoot} = storeFixture
      const rootFiles = new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot])
      const baseOptions = await storeFixture.options({
        rootFiles,
        idFactory: () => 'workspace-0001',
      })
      const crashOptions = {
        ...baseOptions,
        maintenanceFault: (step: string) => step === crashPoint,
      } as typeof baseOptions & {readonly maintenanceFault: (step: string) => boolean}
      let store = await ProjectStore.open(crashOptions)
      try {
        const workspace = await store.createManaged('Alpha')
        await writeFile(join(workspace.canonical_path, 'original.txt'), 'preserve me')
        const snapshot = await store.maintenanceSnapshot()
        const target = snapshot.managed_targets[0]
        assert.ok(target)
        await assert.rejects(store.executeManagedReplacement({
          expected_state_revision: snapshot.state_revision,
          targets: [{
            workspace_id: workspace.workspace_id,
            canonical_path: workspace.canonical_path,
            identity: target.identity,
            tombstone_name: '.nova-maintenance-operation-0001-1',
          }],
        }), /maintenance fault/u)
        assert.equal((await store.loadManagedMaintenanceJournal())?.phase, 'prepared')
        await store.close()

        store = await ProjectStore.open(baseOptions)
        assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'clean'})
        assert.equal(await readFile(join(workspace.canonical_path, 'original.txt'), 'utf8'), 'preserve me')
        assert.equal(
          (await readdir(managedRoot)).some(name => name.startsWith('.nova-replacement-')),
          false,
        )
        assert.equal(await store.loadManagedMaintenanceJournal(), null)
      } finally {
        await store.close().catch(() => undefined)
        await storeFixture.close()
      }
    })
  }
})

test('crash after tombstone deletion is idempotently completed from the committed journal', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-maintenance-delete-crash-')
  const {stateRoot, managedRoot} = storeFixture
  const rootFiles = new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot])
  const baseOptions = await storeFixture.options({
    rootFiles,
    idFactory: () => 'workspace-0001',
  })
  const crashOptions = {
    ...baseOptions,
    maintenanceFault: (step: string) => step === 'cleanup_entry_deleted',
  } as typeof baseOptions & {readonly maintenanceFault: (step: string) => boolean}
  let store = await ProjectStore.open(crashOptions)
  try {
    const workspace = await store.createManaged('Alpha')
    await writeFile(join(workspace.canonical_path, 'original.txt'), 'delete me')
    const snapshot = await store.maintenanceSnapshot()
    const target = snapshot.managed_targets[0]
    assert.ok(target)
    const replaced = await store.executeManagedReplacement({
      expected_state_revision: snapshot.state_revision,
      targets: [{
        workspace_id: workspace.workspace_id,
        canonical_path: workspace.canonical_path,
        identity: target.identity,
        tombstone_name: '.nova-maintenance-operation-0001-1',
      }],
    })
    assert.equal(replaced.status, 'committed')
    await assert.rejects(store.cleanupManagedMaintenanceJournal(), /maintenance fault/u)
    assert.equal((await store.loadManagedMaintenanceJournal())?.phase, 'committed')
    await store.close()

    const journalBytes = await readFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE))
    const busyLocks = new BusyThenDescriptorLockAuthority()
    busyLocks.busyAttempts = Number.MAX_SAFE_INTEGER
    const observer = await ProjectStore.open({...baseOptions, nativeLocks: busyLocks})
    assert.equal(busyLocks.acquireCalls, 0, 'a desktop observer must not replay during open')
    assert.deepEqual(await readFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE)), journalBytes)
    await observer.close()

    const contended = await ManagedWorkspaceMaintenanceService.openFromDesktop({
      stateRoot: await realpath(stateRoot), managedRoot: await realpath(managedRoot),
      nativeHost: {nativeLocks: busyLocks, rootFiles} as unknown as Parameters<typeof ManagedWorkspaceMaintenanceService.openFromDesktop>[0]['nativeHost'],
    })
    try {
      assert.deepEqual(await contended.capabilities(), {
        health: 'degraded', lifecycleBusy: true,
        current: {available: false, display_name: null}, all: {available: false, count: 0},
      }, 'a real maintenance observer reports contention without declaring corruption')
      assert.deepEqual(await readFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE)), journalBytes)
      busyLocks.busyAttempts = 0
      assert.equal((await contended.capabilities()).health, 'ready')
      await assert.rejects(readFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE)), /ENOENT/u)
    } finally { await contended.close() }

    await writeFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE), '{broken', {mode: 0o600})
    const maintenance = await ManagedWorkspaceMaintenanceService.openFromDesktop({
      stateRoot: await realpath(stateRoot), managedRoot: await realpath(managedRoot),
      nativeHost: {nativeLocks: baseOptions.nativeLocks, rootFiles} as unknown as Parameters<typeof ManagedWorkspaceMaintenanceService.openFromDesktop>[0]['nativeHost'],
    })
    assert.equal((await maintenance.capabilities()).health, 'unavailable')
    await maintenance.close()
    await assert.rejects(ProjectStore.open({...baseOptions, live: true}))
    await writeFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE), journalBytes, {mode: 0o600})
    store = await ProjectStore.open({...baseOptions, live: true})
    assert.equal(await store.loadManagedMaintenanceJournal(), null, 'failed live replay releases its owner lock for retry')
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'clean'})
    assert.equal(await store.loadManagedMaintenanceJournal(), null)
    assert.deepEqual(await readdir(workspace.canonical_path), [])
  } finally {
    await store.close().catch(() => undefined)
    await storeFixture.close()
  }
})

test('committed cleanup treats an already missing tombstone as completed', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-maintenance-missing-cleanup-')
  const {stateRoot, managedRoot} = storeFixture
  const store = await storeFixture.open({
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => 'workspace-0001',
  })
  try {
    const workspace = await store.createManaged('Alpha')
    const snapshot = await store.maintenanceSnapshot()
    const target = snapshot.managed_targets[0]
    assert.ok(target)
    const replaced = await store.executeManagedReplacement({
      expected_state_revision: snapshot.state_revision,
      targets: [{
        workspace_id: workspace.workspace_id,
        canonical_path: workspace.canonical_path,
        identity: target.identity,
        tombstone_name: '.nova-maintenance-operation-0001-1',
      }],
    })
    assert.equal(replaced.status, 'committed')
    await rm(join(managedRoot, '.nova-maintenance-operation-0001-1'), {recursive: true})

    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'clean'})
    assert.equal(await store.loadManagedMaintenanceJournal(), null)
  } finally {
    await storeFixture.close(store)
  }
})

test('current managed open detects a same-path substitution around the host callback', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-open-substitution-')
  const {stateRoot, managedRoot} = storeFixture
  const store = await storeFixture.open({
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => 'workspace-0001',
  })
  try {
    const workspace = await store.createManaged('Alpha')
    await assert.rejects(store.withCurrentManagedWorkspacePath(path => {
      assert.equal(path, workspace.canonical_path)
      renameSync(path, join(managedRoot, 'moved-during-open'))
      mkdirSync(path, {mode: 0o700})
    }), (error: unknown) => (
      error instanceof ProjectStateError && error.code === 'workspace_boundary_changed'
    ))
  } finally {
    await storeFixture.close(store)
  }
})

test('current maintenance snapshot ignores invalid detached managed records', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-current-maintenance-')
  const {stateRoot, managedRoot} = storeFixture
  const identifiers = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await storeFixture.open({
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => identifiers.next().value ?? 'unused-id',
  })
  try {
    const detached = await store.createManaged('Alpha')
    const current = await store.createManaged('Beta')
    await rename(detached.canonical_path, join(managedRoot, 'detached-alpha'))
    const snapshot = await store.currentMaintenanceSnapshot()
    assert.equal(snapshot.active_workspace_id, current.workspace_id)
    assert.deepEqual(
      snapshot.managed_targets.map(target => target.workspace.workspace_id),
      [current.workspace_id],
    )
    await assert.rejects(store.maintenanceSnapshot(), (error: unknown) => (
      error instanceof ProjectStateError && error.code === 'workspace_boundary_changed'
    ))
  } finally {
    await storeFixture.close(store)
  }
})

test('external managed cleanup recreates empty roots and clears the active selection', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-external-cleanup-')
  const {stateRoot, managedRoot} = storeFixture
  const identifiers = [
    'workspace-0001', 'session-000001',
    'workspace-0002', 'session-000002',
  ][Symbol.iterator]()
  const store = await storeFixture.open({
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => identifiers.next().value ?? 'unused-id',
  })
  try {
    const first = await store.createManaged('Alpha')
    const firstSession = await store.beginSession(first.workspace_id, 'First session')
    await store.markSessionReady(firstSession.session_id, 'thread-alpha')
    const second = await store.createManaged('Beta')
    const secondSession = await store.beginSession(second.workspace_id, 'Second session')
    await store.markSessionReady(secondSession.session_id, 'thread-beta')

    await rm(first.canonical_path, {recursive: true, force: true})
    await rm(second.canonical_path, {recursive: true, force: true})

    assert.deepEqual(await store.reconcileExternallyRemovedManagedWorkspaces(), {
      status: 'reconciled',
      recreated_count: 2,
      active_workspace_reset: true,
    })
    const snapshot = await store.snapshot()
    assert.equal(snapshot.active_workspace_id, null)
    assert.equal(snapshot.workspaces.length, 2)
    assert.equal(snapshot.sessions.length, 2)
    assert.equal((await lstat(first.canonical_path)).isDirectory(), true)
    assert.equal((await lstat(second.canonical_path)).isDirectory(), true)
    assert.deepEqual(await store.currentMaintenanceSnapshot(), {
      state_revision: snapshot.state_revision,
      active_workspace_id: null,
      managed_targets: [],
    })
    assert.equal((await store.maintenanceSnapshot()).managed_targets.length, 2)
  } finally {
    await storeFixture.close(store)
  }
})

test('complete external managed cleanup keeps an existing imported workspace unselected', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-external-empty-')
  const {root, stateRoot, managedRoot} = storeFixture
  const importedRoot = join(root, 'imported')
  await mkdir(importedRoot, {mode: 0o700})
  const identifiers = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await storeFixture.open({
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => identifiers.next().value ?? 'unused-id',
  })
  try {
    const imported = await store.ensureImported(
      'Imported',
      hostWorkspaceForTest(await realpath(importedRoot)),
    )
    const managed = await store.createManaged('Managed')
    await store.selectWorkspace(imported.display_name)
    await rm(managed.canonical_path, {recursive: true, force: true})

    assert.deepEqual(await store.reconcileExternallyRemovedManagedWorkspaces(), {
      status: 'reconciled',
      recreated_count: 1,
      active_workspace_reset: true,
    })
    assert.equal((await store.snapshot()).active_workspace_id, null)
    assert.equal(
      (await store.ensureImported(
        imported.display_name,
        hostWorkspaceForTest(await realpath(importedRoot)),
      )).workspace_id,
      imported.workspace_id,
    )
    assert.equal((await store.snapshot()).active_workspace_id, null)
  } finally {
    await storeFixture.close(store)
  }
})

test('external cleanup reconciliation refuses a same-name replacement', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-external-replacement-')
  const {stateRoot, managedRoot} = storeFixture
  const store = await storeFixture.open({
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => 'workspace-0001',
  })
  try {
    const workspace = await store.createManaged('Alpha')
    await rename(workspace.canonical_path, `${workspace.canonical_path}-moved`)
    await mkdir(workspace.canonical_path, {mode: 0o700})

    await assert.rejects(
      store.reconcileExternallyRemovedManagedWorkspaces(),
      (error: unknown) => (
        error instanceof ProjectStateError && error.code === 'workspace_boundary_changed'
      ),
    )
    assert.equal((await store.snapshot()).active_workspace_id, workspace.workspace_id)
  } finally {
    await storeFixture.close(store)
  }
})

test('external cleanup reconciliation refuses a replacement racing directory recreation', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-external-race-')
  const {stateRoot, managedRoot} = storeFixture
  const rootFiles = new ExternalCleanupMkdirCollisionAuthority([stateRoot, managedRoot])
  const store = await storeFixture.open({
    rootFiles,
    idFactory: () => 'workspace-0001',
  })
  try {
    const workspace = await store.createManaged('Alpha')
    await rm(workspace.canonical_path, {recursive: true, force: true})
    rootFiles.targetName = basename(workspace.canonical_path)

    await assert.rejects(
      store.reconcileExternallyRemovedManagedWorkspaces(),
      (error: unknown) => error instanceof ProjectStateError,
    )
    const collision = rootFiles.collisionIdentity
    assert.notEqual(collision, null)
    const info = await lstat(workspace.canonical_path, {bigint: true})
    assert.equal(info.dev, collision?.device)
    assert.equal(info.ino, collision?.inode)
    assert.equal((await store.snapshot()).active_workspace_id, workspace.workspace_id)
  } finally {
    await storeFixture.close(store)
  }
})

test('current managed open releases the store transaction before awaiting host completion', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-open-lock-')
  const {stateRoot, managedRoot} = storeFixture
  const store = await storeFixture.open({
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => 'workspace-0001',
  })
  let finishHost!: () => void
  let service: ManagedWorkspaceMaintenanceService | null = null
  try {
    await store.createManaged('Alpha')
    service = await ManagedWorkspaceMaintenanceService.open({store})
    let callbackStarted!: () => void
    const started = new Promise<void>(resolve => { callbackStarted = resolve })
    const hostCompletion = new Promise<void>(resolve => { finishHost = resolve })
    const opened = service.withCurrentManagedPath(() => {
      callbackStarted()
      return hostCompletion
    })
    await started
    const snapshot = await within('snapshot while host completion is pending', store.snapshot(), 250)
    assert.equal(snapshot.workspaces.length, 1)
    finishHost()
    assert.deepEqual(await opened, {status: 'opened'})
  } finally {
    finishHost?.()
    await storeFixture.close(service, store)
  }
})

test('a committed journal cannot omit its replacement identity', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-journal-phase-')
  const {stateRoot, managedRoot} = storeFixture
  const store = await storeFixture.open({
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
  })
  try {
    await writeFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE), JSON.stringify({
      entries: [{
        identity: {device: '1', inode: '2'},
        original_name: 'workspace-0001',
        replacement_identity: null,
        tombstone_name: '.nova-maintenance-operation-0001-1',
        workspace_id: 'workspace-0001',
      }],
      operation_id: 'operation-0001',
      phase: 'committed',
      version: 1,
    }), {mode: 0o600})
    await assert.rejects(store.loadManagedMaintenanceJournal(), (error: unknown) => (
      error instanceof ProjectStateError && error.code === 'state_corrupt'
    ))
  } finally {
    await storeFixture.close(store)
  }
})

test('a v2 journal binds each replacement temporary to its exact tombstone entry', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-journal-replacement-name-')
  const {stateRoot, managedRoot} = storeFixture
  const store = await storeFixture.open({
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
  })
  try {
    await writeFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE), JSON.stringify({
      entries: [{
        identity: {device: '1', inode: '2'},
        original_name: 'workspace-0001',
        replacement_identity: null,
        replacement_name: '.nova-replacement-operation-0001-2',
        tombstone_name: '.nova-maintenance-operation-0001-1',
        workspace_id: 'workspace-0001',
      }],
      operation_id: 'operation-0001',
      phase: 'prepared',
      version: 2,
    }), {mode: 0o600})
    await assert.rejects(store.loadManagedMaintenanceJournal(), (error: unknown) => (
      error instanceof ProjectStateError && error.code === 'state_corrupt'
    ))
  } finally {
    await storeFixture.close(store)
  }
})

test('state roots and files reject special permission bits rather than masking them away', {
  skip: process.platform === 'win32' && 'Windows security is represented by ACLs, not POSIX mode bits',
}, async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-special-mode-')
  const {stateRoot, managedRoot} = storeFixture
  try {
    await chmod(stateRoot, 0o1700)
    assert.throws(
      () => hostProjectRootForTest(realpathSync(stateRoot)),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
    await chmod(stateRoot, 0o700)
    const statePath = join(stateRoot, 'codex-projects-v1.json')
    await writeFile(statePath, '{"active_workspace_id":null,"sessions":{},"version":1,"workspaces":{}}', {mode: 0o600})
    await chmod(statePath, 0o1600)
    const store = await ProjectStore.open({
      stateRoot: hostProjectRootForTest(realpathSync(stateRoot)),
      managedRoot: hostManagedProjectRootForTest(realpathSync(managedRoot)),
      nativeLocks: new DescriptorLockAuthority(),
      rootFiles: rootFilesForTest(stateRoot, managedRoot),
    })
    try {
      await assert.rejects(
        store.snapshot(),
        (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
      )
    } finally {
      await store.close()
    }
  } finally {
    await chmod(stateRoot, 0o700).catch(() => undefined)
    await storeFixture.close()
  }
})

test('an owner-controlled 0750 managed root is accepted while group-writable roots are refused', {
  skip: process.platform === 'win32' && 'Windows security is represented by ACLs, not POSIX mode bits',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-managed-mode-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o750})
  await chmod(managedRoot, 0o750)
  try {
    const accepted = await ProjectStore.open({
      stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
      managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
      nativeLocks: new DescriptorLockAuthority(),
      rootFiles: rootFilesForTest(stateRoot, managedRoot),
      idFactory: () => 'workspace-0001',
    })
    try {
      assert.equal((await accepted.createManaged('alpha')).origin, 'managed')
    } finally {
      await accepted.close()
    }

    for (const unsafeMode of [0o770, 0o1750]) {
      await chmod(managedRoot, unsafeMode)
      assert.throws(
        () => hostManagedProjectRootForTest(realpathSync(managedRoot)),
        (error: unknown) => error instanceof ProjectStateError && error.code === 'managed_root_unsafe',
      )
    }
  } finally {
    await chmod(managedRoot, 0o700).catch(() => undefined)
    await rm(root, {recursive: true, force: true})
  }
})

test('strict v1 decode rejects key, type, cap, reference, and normalized-identity mutations', async () => {
  const fixture = JSON.parse(await readFile(
    join(import.meta.dirname, '../../../tests/fixtures/runtime/codex-project-state-v1.json'),
    'utf8',
  )) as {readonly input_utf8_base64: string}
  const valid = JSON.parse(Buffer.from(fixture.input_utf8_base64, 'base64').toString('utf8')) as {
    version: number
    active_workspace_id: string | null
    workspaces: Record<string, Record<string, unknown>>
    sessions: Record<string, Record<string, unknown>>
  }
  const clone = (): typeof valid => structuredClone(valid)
  const mutations: {readonly name: string; readonly value: unknown; readonly code?: string}[] = []
  const missing = clone()
  delete missing.workspaces['workspace-0001']!.origin
  mutations.push({name: 'missing record key', value: missing})
  const extra = clone()
  extra.sessions['session-0001']!.extra = true
  mutations.push({name: 'extra record key', value: extra})
  const booleanTimestamp = clone()
  booleanTimestamp.sessions['session-0001']!.created_at = true
  mutations.push({name: 'boolean timestamp', value: booleanTimestamp})
  const relativePath = clone()
  relativePath.workspaces['workspace-0001']!.canonical_path = 'relative'
  mutations.push({name: 'relative path', value: relativePath})
  const missingWorkspace = clone()
  missingWorkspace.sessions['session-0001']!.workspace_id = 'workspace-9999'
  mutations.push({name: 'missing workspace reference', value: missingWorkspace})
  const missingActive = clone()
  missingActive.active_workspace_id = 'workspace-9999'
  mutations.push({name: 'missing active workspace', value: missingActive})
  const readyWithoutThread = clone()
  readyWithoutThread.sessions['session-0001']!.state = 'ready'
  mutations.push({name: 'ready without thread', value: readyWithoutThread})
  const normalizedMismatch = clone()
  normalizedMismatch.workspaces['workspace-0001']!.normalized_name = 'not-the-casefold'
  mutations.push({name: 'normalized mismatch', value: normalizedMismatch})

  const tooManyWorkspaces = clone()
  tooManyWorkspaces.active_workspace_id = null
  tooManyWorkspaces.sessions = {}
  tooManyWorkspaces.workspaces = Object.fromEntries(Array.from({length: MAX_PROJECT_WORKSPACES + 1}, (_unused, index) => {
    const id = `workspace-${String(index).padStart(4, '0')}`
    return [id, {
      ...valid.workspaces['workspace-0001'],
      workspace_id: id,
      display_name: `workspace ${index}`,
      normalized_name: `workspace ${index}`,
      codex_home_key: `home-${id}`,
      active_session_id: null,
    }]
  }))
  mutations.push({name: 'workspace cap', value: tooManyWorkspaces})

  const workspaceTemplate = valid.workspaces['workspace-0001']!
  const sessionTemplate = valid.sessions['session-0001']!
  const cappedState = (workspaceCount: number, sessionCount: number): typeof valid => {
    const value = clone()
    value.active_workspace_id = null
    value.workspaces = Object.fromEntries(Array.from({length: workspaceCount}, (_unused, index) => {
      const id = `workspace-${String(index).padStart(4, '0')}`
      return [id, {
        ...workspaceTemplate,
        workspace_id: id,
        display_name: `workspace ${index}`,
        normalized_name: `workspace ${index}`,
        codex_home_key: `home-${id}`,
        active_session_id: null,
      }]
    }))
    value.sessions = Object.fromEntries(Array.from({length: sessionCount}, (_unused, index) => {
      const id = `session-${String(index).padStart(4, '0')}`
      const workspaceId = `workspace-${String(Math.floor(index / 200)).padStart(4, '0')}`
      return [id, {
        ...sessionTemplate,
        session_id: id,
        workspace_id: workspaceId,
        display_title: `session ${index}`,
        normalized_title: `session ${index}`,
        codex_thread_id: `thread-${index}`,
        state: 'ready',
      }]
    }))
    return value
  }
  const tooManySessionsInWorkspace = cappedState(2, 201)
  for (const session of Object.values(tooManySessionsInWorkspace.sessions)) {
    session.workspace_id = 'workspace-0000'
  }
  mutations.push({name: 'per-workspace session cap', value: tooManySessionsInWorkspace})
  mutations.push({name: 'total session cap', value: cappedState(6, 1001)})

  const duplicateWorkspaceName = cappedState(2, 0)
  duplicateWorkspaceName.workspaces['workspace-0001']!.normalized_name = 'workspace 0'
  mutations.push({name: 'duplicate normalized workspace', value: duplicateWorkspaceName})

  const duplicateSessionTitle = cappedState(1, 2)
  duplicateSessionTitle.sessions['session-0001']!.display_title = 'session 0'
  duplicateSessionTitle.sessions['session-0001']!.normalized_title = 'session 0'
  mutations.push({name: 'duplicate normalized session', value: duplicateSessionTitle})

  const storeFixture = await projectStoreFixture('nova-codex-project-strict-state-')
  const {stateRoot} = storeFixture
  const statePath = join(stateRoot, 'codex-projects-v1.json')
  const options = await storeFixture.options()
  try {
    for (const mutation of mutations) {
      await writeFile(statePath, JSON.stringify(mutation.value), {mode: 0o600})
      await chmod(statePath, 0o600)
      const store = await ProjectStore.open(options)
      try {
        await assert.rejects(
          store.snapshot(),
          (error: unknown) => error instanceof ProjectStateError
            && error.code === (mutation.code ?? 'state_corrupt'),
          mutation.name,
        )
      } finally {
        await store.close()
      }
    }
    const compatible = clone()
    compatible.active_workspace_id = '__proto__'
    compatible.workspaces = Object.fromEntries([['__proto__', {
      ...workspaceTemplate, workspace_id: '__proto__', codex_home_key: 'home-__proto__',
      created_at: -1.25,
    }]])
    for (const session of Object.values(compatible.sessions)) session.workspace_id = '__proto__'
    await writeFile(statePath, JSON.stringify(compatible), {mode: 0o600})
    const compatibleStore = await ProjectStore.open(options)
    try {
      const snapshot = await compatibleStore.snapshot()
      assert.equal(snapshot.workspaces[0]?.workspace_id, '__proto__')
      assert.equal(snapshot.workspaces[0]?.created_at, -1.25)
    } finally { await compatibleStore.close() }
  } finally {
    await storeFixture.close()
  }
})

test('managed and registered workspace bindings reject symlink replacement at transport time', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-boundary-')
  const {root, managedRoot} = storeFixture
  const registered = join(root, 'registered')
  const replacement = join(root, 'replacement')
  await mkdir(registered, {mode: 0o700})
  await mkdir(replacement, {mode: 0o700})
  const ids = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await storeFixture.open({
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    const imported = await store.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(registered)),
    )
    await rename(registered, join(root, 'registered-original'))
    await symlink(replacement, registered, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(
      store.revalidateWorkspace(imported.workspace_id),
      (error: unknown) => error instanceof ProjectStateError
        && error.code === 'workspace_boundary_changed',
    )

    const managed = await store.createManaged('天气 看板')
    assert.equal(relative(await realpath(managedRoot), managed.canonical_path).includes('/'), false)
    await store.revalidateWorkspace(managed.workspace_id)
  } finally {
    await storeFixture.close(store)
  }
})

test('workspace bindings pin inode identity and managed workspaces retain owner-only mode', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-inode-binding-')
  const {root} = storeFixture
  const registered = join(root, 'registered')
  await mkdir(registered, {mode: 0o700})
  const ids = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await storeFixture.open({
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    const imported = await store.ensureImported(
      'registered',
      hostWorkspaceForTest(await realpath(registered)),
    )
    await rename(registered, join(root, 'registered-original'))
    await mkdir(registered, {mode: 0o700})
    await assert.rejects(
      store.revalidateWorkspace(imported.workspace_id),
      (error: unknown) => error instanceof ProjectStateError
        && error.code === 'workspace_boundary_changed',
    )

    const managed = await store.createManaged('managed')
    if (process.platform !== 'win32') {
      await chmod(managed.canonical_path, 0o755)
      await assert.rejects(
        store.revalidateWorkspace(managed.workspace_id),
        (error: unknown) => error instanceof ProjectStateError
          && error.code === 'workspace_boundary_changed',
      )
      await chmod(managed.canonical_path, 0o700)
    }
    await rename(managed.canonical_path, `${managed.canonical_path}-original`)
    await mkdir(managed.canonical_path, {mode: 0o700})
    await assert.rejects(
      store.revalidateWorkspace(managed.workspace_id),
      (error: unknown) => error instanceof ProjectStateError
        && error.code === 'workspace_boundary_changed',
    )
  } finally {
    await storeFixture.close(store)
  }
})

test('Windows run revalidation reapplies the managed workspace ACL before admission', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-acl-refresh-')
  const {stateRoot, managedRoot} = storeFixture
  const rootFiles = new CountingProtectRootFileAuthority([stateRoot, managedRoot])
  const store = await storeFixture.open({
    rootFiles,
    idFactory: () => 'workspace-0001',
    platform: 'win32',
  })
  try {
    const managed = await store.createManaged('managed')
    const beforeAdmission = rootFiles.protectCalls

    await store.revalidateWorkspace(managed.workspace_id)

    assert.equal(rootFiles.protectCalls, beforeAdmission + 1)
  } finally {
    await storeFixture.close(store)
  }
})

test('Windows session resume reapplies the managed workspace ACL before admission', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-resume-acl-refresh-')
  const {stateRoot, managedRoot} = storeFixture
  const rootFiles = new CountingProtectRootFileAuthority([stateRoot, managedRoot])
  const ids = ['workspace-0001', 'session-0001'][Symbol.iterator]()
  const store = await storeFixture.open({
    rootFiles,
    idFactory: () => ids.next().value ?? 'unused-id',
    platform: 'win32',
  })
  try {
    const managed = await store.createManaged('managed')
    const session = await store.beginSession(managed.workspace_id, 'resume target')
    await store.markSessionReady(session.session_id, 'thread-resume')
    const beforeAdmission = rootFiles.protectCalls

    await store.prepareSessionResume(
      managed.workspace_id,
      session.session_id,
      'thread-resume',
    )

    assert.equal(rootFiles.protectCalls, beforeAdmission + 1)
  } finally {
    await storeFixture.close(store)
  }
})

test('workspace inode pins are process-local and a restart establishes a fresh portable baseline', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-inode-restart-')
  const {root} = storeFixture
  const registered = join(root, 'registered')
  await mkdir(registered, {mode: 0o700})
  const options = await storeFixture.options({
    idFactory: () => 'workspace-0001',
  })
  let first: ProjectStore | null = null
  let restarted: ProjectStore | null = null
  try {
    first = await ProjectStore.open(options)
    const imported = await first.ensureImported(
      'registered',
      hostWorkspaceForTest(await realpath(registered)),
    )
    await first.close()
    first = null
    await rename(registered, join(root, 'registered-original'))
    await mkdir(registered, {mode: 0o700})

    restarted = await ProjectStore.open(options)
    assert.equal(
      hostWorkspacePath(await restarted.revalidateWorkspace(imported.workspace_id)),
      await realpath(registered),
    )
    await rename(registered, join(root, 'registered-second'))
    await mkdir(registered, {mode: 0o700})
    await assert.rejects(
      restarted.revalidateWorkspace(imported.workspace_id),
      (error: unknown) => error instanceof ProjectStateError
        && error.code === 'workspace_boundary_changed',
    )
  } finally {
    await storeFixture.close(first, restarted)
  }
})

test('ensureImported preserves the stronger managed workspace binding for an existing record', {
  skip: process.platform === 'win32' && 'this test mutates POSIX mode bits; Windows ACLs are native-tested',
}, async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-managed-import-')

  const store = await storeFixture.open({
    idFactory: () => 'workspace-0001',
  })
  try {
    const managed = await store.createManaged('managed')
    await chmod(managed.canonical_path, 0o755)
    await assert.rejects(
      store.ensureImported(
        'managed again',
        hostWorkspaceForTest(await realpath(managed.canonical_path)),
      ),
      (error: unknown) => error instanceof ProjectStateError
        && error.code === 'workspace_boundary_changed',
    )
  } finally {
    await storeFixture.close(store)
  }
})

test('a managed record must remain a direct child even when its replacement path is canonical', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-direct-parent-')
  const {root, stateRoot} = storeFixture
  const outside = join(root, 'outside')
  await mkdir(outside, {mode: 0o700})
  const options = await storeFixture.options({
    idFactory: () => 'workspace-0001',
  })
  let store: ProjectStore | null = null
  try {
    store = await ProjectStore.open(options)
    const workspace = await store.createManaged('alpha')
    await store.close()
    store = null
    const statePath = join(stateRoot, 'codex-projects-v1.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      workspaces: Record<string, {canonical_path: string}>
    }
    state.workspaces[workspace.workspace_id]!.canonical_path = await realpath(outside)
    await writeFile(statePath, JSON.stringify(state), {mode: 0o600})
    store = await ProjectStore.open(options)
    await assert.rejects(
      store.revalidateWorkspace(workspace.workspace_id),
      (error: unknown) => error instanceof ProjectStateError
        && error.code === 'workspace_boundary_changed',
    )
  } finally {
    await storeFixture.close(store)
  }
})

test('managed creation uses only a pinned safe slug and rollback never deletes user data', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-managed-safety-')

  const ids = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await storeFixture.open({
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    const workspace = await store.createManaged('😀')
    assert.equal(
      basename(workspace.canonical_path),
      `workspace-${[...workspace.workspace_id].slice(-12).join('')}`,
    )
    if (process.platform !== 'win32') {
      assert.equal((await lstat(workspace.canonical_path)).mode & 0o777, 0o700)
    }
    await writeFile(join(workspace.canonical_path, 'keep.txt'), 'user data')
    assert.equal(await store.rollbackManagedCreate(workspace.workspace_id), false)
    assert.equal((await store.resolveWorkspace('😀')).workspace_id, workspace.workspace_id)

    await assert.rejects(
      store.createManaged('😀'),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'workspace_name_conflict',
    )
  } finally {
    await storeFixture.close(store)
  }
})

test('managed mkdir returns the rollback identity without a second path lookup', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-managed-create-identity-')
  const {stateRoot, managedRoot} = storeFixture
  const store = await storeFixture.open({
    rootFiles: new FailManagedLookupRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => 'workspace-0001',
  })
  try {
    const created = await store.createManaged('managed')
    assert.equal((await lstat(created.canonical_path)).isDirectory(), true)
    assert.equal(await store.rollbackManagedCreate(created.workspace_id), true)
  } finally {
    await storeFixture.close(store)
  }
})

test('managed rollback refuses an empty same-path inode replacement and retains state', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-rollback-inode-')

  const store = await storeFixture.open({
    idFactory: () => 'workspace-0001',
  })
  try {
    const managed = await store.createManaged('managed')
    await rename(managed.canonical_path, `${managed.canonical_path}-original`)
    await mkdir(managed.canonical_path, {mode: 0o700})
    assert.equal(await store.rollbackManagedCreate(managed.workspace_id), false)
    assert.equal((await lstat(managed.canonical_path)).isDirectory(), true)
    assert.equal((await store.resolveWorkspace('managed')).workspace_id, managed.workspace_id)
  } finally {
    await storeFixture.close(store)
  }
})

test('a committed create keeps its inode pin when only native release fails', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-commit-release-')

  const nativeLocks = new FailNextReleaseLockAuthority()
  const store = await storeFixture.open({
    nativeLocks,
    idFactory: () => 'workspace-0001',
  })
  try {
    nativeLocks.failNextRelease = true
    await assert.rejects(
      store.createManaged('managed'),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_lock_failed',
    )
    const managed = (await store.listWorkspaces())[0]
    assert.ok(managed)
    await rename(managed.canonical_path, `${managed.canonical_path}-original`)
    await mkdir(managed.canonical_path, {mode: 0o700})
    await assert.rejects(
      store.revalidateWorkspace(managed.workspace_id),
      (error: unknown) => error instanceof ProjectStateError
        && error.code === 'workspace_boundary_changed',
    )
  } finally {
    await storeFixture.close(store)
  }
})

test('successful managed rollback clears the exact pin so an absent ID can be reused', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-rollback-pin-')

  const store = await storeFixture.open({
    idFactory: () => 'workspace-0001',
  })
  try {
    const first = await store.createManaged('first')
    assert.equal(await store.rollbackManagedCreate(first.workspace_id), true)
    const second = await store.createManaged('second')
    assert.equal(second.workspace_id, first.workspace_id)
  } finally {
    await storeFixture.close(store)
  }
})

test('a pre-commit rollback failure restores a safe managed child and advances its pin', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-rollback-restore-')
  const {stateRoot, managedRoot} = storeFixture
  const rootFiles = new ToggleTempCreateRootFileAuthority([stateRoot, managedRoot])
  const store = await storeFixture.open({
    rootFiles,
    idFactory: () => 'workspace-0001',
  })
  try {
    const managed = await store.createManaged('managed')
    const managedName = basename(managed.canonical_path)
    const originalAuthority = rootFiles.managedAuthorityForTest(managedName)
    if (originalAuthority === null) assert.fail('managed child authority was not captured')
    assert.equal(typeof originalAuthority.generation, 'symbol')
    rootFiles.failTempCreate = true
    await assert.rejects(
      store.rollbackManagedCreate(managed.workspace_id),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_write_failed',
    )
    const after = lstatSync(managed.canonical_path, {bigint: true})
    if (process.platform !== 'win32') assert.equal((after.mode & 0o7777n), 0o700n)
    const currentAuthority = rootFiles.managedAuthorityForTest(managedName)
    if (currentAuthority === null) assert.fail('restored managed child authority was not captured')
    assert.equal(typeof currentAuthority.generation, 'symbol')
    assert.notEqual(currentAuthority.generation, originalAuthority.generation)
    assert.deepEqual(
      rootFiles.matchesAt(
        originalAuthority.rootDescriptor,
        managedName,
        originalAuthority.childDescriptor,
      ),
      {status: 'mismatch'},
    )
    assert.deepEqual(
      rootFiles.matchesAt(
        currentAuthority.rootDescriptor,
        managedName,
        currentAuthority.childDescriptor,
      ),
      {status: 'ok'},
    )
    assert.equal(
      hostWorkspacePath(await store.revalidateWorkspace(managed.workspace_id)),
      managed.canonical_path,
    )
    rootFiles.failTempCreate = false
    assert.equal(await store.rollbackManagedCreate(managed.workspace_id), true)
  } finally {
    await storeFixture.close(store)
  }
})

test('rollback restore rejects an immediate mkdir replacement before chmod or pin advance', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-rollback-restore-race-')
  const {stateRoot, managedRoot} = storeFixture
  const rootFiles = new ReplaceManagedRestoreAfterMkdirRootFileAuthority([
    stateRoot,
    managedRoot,
  ])
  const store = await storeFixture.open({
    rootFiles,
    idFactory: () => 'workspace-0001',
  })
  try {
    const managed = await store.createManaged('managed')
    rootFiles.failTempCreate = true
    await assert.rejects(
      store.rollbackManagedCreate(managed.workspace_id),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_write_failed',
    )
    assert.notEqual(rootFiles.replacementPath, null)
    if (process.platform !== 'win32') {
      assert.equal(lstatSync(rootFiles.replacementPath!).mode & 0o7777, 0o755)
    }
    await assert.rejects(
      store.revalidateWorkspace(managed.workspace_id),
      (error: unknown) => error instanceof ProjectStateError
        && error.code === 'workspace_boundary_changed',
    )
  } finally {
    await storeFixture.close(store)
  }
})

test('a managed slug and ID collision is a stable path conflict without overwriting', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-path-conflict-')

  const ids = ['prefix-one-123456789012', 'prefix-two-123456789012'][Symbol.iterator]()
  const store = await storeFixture.open({
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    const first = await store.createManaged('alpha')
    await assert.rejects(
      store.createManaged('alpha!'),
      (error: unknown) => error instanceof ProjectStateError
        && error.code === 'workspace_path_conflict',
    )
    assert.equal((await store.listWorkspaces()).length, 1)
    assert.equal((await realpath(first.canonical_path)), first.canonical_path)
  } finally {
    await storeFixture.close(store)
  }
})

test('ID allocation never overwrites either namespace and has a fixed collision bound', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-id-collision-')
  const {managedRoot} = storeFixture
  let calls = 0
  const store = await storeFixture.open({
    idFactory: () => {
      calls += 1
      return 'workspace-0001'
    },
  })
  try {
    const first = await store.createManaged('alpha')
    const callsAfterFirst = calls
    await assert.rejects(
      store.createManaged('beta'),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'id_factory_invalid',
    )
    assert.equal(calls - callsAfterFirst, 32)
    assert.deepEqual((await store.listWorkspaces()).map(item => item.workspace_id), [first.workspace_id])
    assert.deepEqual(await readdir(managedRoot), [basename(first.canonical_path)])
    await assert.rejects(
      store.beginSession(first.workspace_id, '任务'),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'id_factory_invalid',
    )
    assert.equal(calls - callsAfterFirst, 64)
    assert.deepEqual(await store.listSessions(first.workspace_id), [])
  } finally {
    await storeFixture.close(store)
  }
})

test('failed registered creation clears only its new pin so the exact ID can be reused', async () => {
  for (const method of ['ensureImported', 'registerWorkspace'] as const) {
    const storeFixture = await projectStoreFixture(`nova-codex-project-${method}-pin-`)
    const {root, stateRoot, managedRoot} = storeFixture
    const workspace = join(root, 'workspace')
    await mkdir(workspace, {mode: 0o700})
    const rootFiles = new ToggleTempCreateRootFileAuthority([stateRoot, managedRoot])
    const store = await storeFixture.open({
      rootFiles,
      idFactory: () => 'workspace-0001',
    })
    try {
      rootFiles.failTempCreate = true
      await assert.rejects(
        store[method]('first', hostWorkspaceForTest(await realpath(workspace))),
        (error: unknown) => error instanceof ProjectStateError && error.code === 'state_write_failed',
      )
      rootFiles.failTempCreate = false
      const created = await store[method]('second', hostWorkspaceForTest(await realpath(workspace)))
      assert.equal(created.workspace_id, 'workspace-0001')
    } finally {
      await storeFixture.close(store)
    }
  }
})

test('a committed registered workspace keeps its exact pin when release fails', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-register-commit-pin-')
  const {root} = storeFixture
  const workspace = join(root, 'workspace')
  const original = join(root, 'workspace-original')
  await mkdir(workspace, {mode: 0o700})
  const nativeLocks = new FailNextReleaseLockAuthority()
  const store = await storeFixture.open({
    nativeLocks,
    idFactory: () => 'workspace-0001',
  })
  try {
    nativeLocks.failNextRelease = true
    await assert.rejects(
      store.registerWorkspace('registered', hostWorkspaceForTest(await realpath(workspace))),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_lock_failed',
    )
    const committed = (await store.listWorkspaces())[0]
    assert.ok(committed)
    await rename(workspace, original)
    await mkdir(workspace, {mode: 0o700})
    await assert.rejects(
      store.revalidateWorkspace(committed.workspace_id),
      (error: unknown) => error instanceof ProjectStateError
        && error.code === 'workspace_boundary_changed',
    )
  } finally {
    await storeFixture.close(store)
  }
})

test('managed creation repairs a restrictive umask and leaves no rollback residue', {
  concurrency: false,
  skip: process.platform === 'win32' && 'Windows directory privacy is ACL-based, not umask-based',
}, async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-umask-')
  const {stateRoot, managedRoot} = storeFixture
  const store = await storeFixture.open({
    idFactory: () => 'workspace-0001',
  })
  await store.snapshot()
  const previousUmask = process.umask(0o100)
  try {
    const created = await store.createManaged('restricted')
    assert.equal((await lstat(created.canonical_path)).mode & 0o7777, 0o700)
    assert.equal(await store.rollbackManagedCreate(created.workspace_id), true)
    assert.deepEqual(await readdir(managedRoot), [])
    assert.equal((await readdir(stateRoot)).some(name => name.endsWith('.tmp')), false)
  } finally {
    process.umask(previousUmask)
    await storeFixture.close(store)
  }
})

test('managed creation repairs a permissive native mkdir before it can become public', {
  skip: process.platform === 'win32' && 'Windows directory privacy is ACL-based, not mode-based',
}, async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-mkdir-mode-')
  const {stateRoot, managedRoot} = storeFixture
  const store = await storeFixture.open({
    rootFiles: new PermissiveManagedMkdirRootFileAuthority(stateRoot, managedRoot),
    idFactory: () => 'workspace-0001',
  })
  try {
    const created = await store.createManaged('managed')
    assert.equal((await lstat(created.canonical_path)).mode & 0o7777, 0o700)
  } finally {
    await storeFixture.close(store)
  }
})

test('managed creation rolls back an empty child when the subsequent state save fails', {concurrency: false}, async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-save-rollback-')
  const {stateRoot, managedRoot} = storeFixture
  const store = await storeFixture.open({
    rootFiles: new FailTempCreateRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => 'workspace-0001',
  })
  await store.snapshot()
  const previousUmask = process.umask(0o777)
  try {
    await assert.rejects(
      store.createManaged('save failure'),
      (error: unknown) => error instanceof ProjectStateError
        && error.code === 'state_write_failed',
    )
    assert.deepEqual(await readdir(managedRoot), [])
    assert.equal((await readdir(stateRoot)).some(name => name.endsWith('.tmp')), false)
  } finally {
    process.umask(previousUmask)
    await storeFixture.close(store)
  }
})

test('an uncommitted poisoned state root cannot strand an empty managed child', {
  skip: process.platform === 'win32' && 'requires POSIX open-directory rename and symlink semantics',
}, async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-poison-rollback-')
  const {root, stateRoot, managedRoot} = storeFixture
  const retainedState = join(root, 'state-retained')
  const replacementState = join(root, 'state-replacement')
  await mkdir(replacementState, {mode: 0o700})
  let swapped = false
  const store = await storeFixture.open({
    idFactory: () => 'workspace-0001',
    onDurabilityStep: step => {
      if (step === 'temp_open' && !swapped) {
        renameSync(stateRoot, retainedState)
        symlinkSync(replacementState, stateRoot, 'dir')
        swapped = true
      }
    },
  })
  try {
    await assert.rejects(
      store.createManaged('managed'),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
    assert.deepEqual(await readdir(managedRoot), [])
    assert.deepEqual(await readdir(replacementState), [])
    assert.equal((await readdir(retainedState)).some(name => name.endsWith('.tmp')), false)
  } finally {
    await storeFixture.close(store)
  }
})

test('project public text enforces Python code points, category C, and path-name boundaries', () => {
  assert.equal(normalizeProjectWorkspaceName('😀'.repeat(80)).display, '😀'.repeat(80))
  assert.throws(
    () => normalizeProjectWorkspaceName('😀'.repeat(81)),
    (error: unknown) => error instanceof ProjectStateError && error.code === 'workspace_name_invalid',
  )
  for (const value of ['', '\ufeff', 'a\u0000b', '../escape', 'a/b', 'a\\b', 'file://x', 'C:\\x']) {
    assert.throws(
      () => normalizeProjectWorkspaceName(value),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'workspace_name_invalid',
    )
  }
})

test('Windows first save completes without POSIX directory fsync', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-windows-save-')
  const {root} = storeFixture
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, {mode: 0o700})
  const durability: string[] = []
  const store = await storeFixture.open({
    platform: 'win32',
    idFactory: () => 'workspace-0001',
    onDurabilityStep: step => { durability.push(step) },
  })
  try {
    const workspace = await store.ensureImported(
      'Windows workspace',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    assert.equal(workspace.workspace_id, 'workspace-0001')
    assert.deepEqual(durability, [
      'temp_open', 'file_fsync', 'atomic_replace', 'windows_metadata_commit',
    ])
    assert.equal(durability.includes('dir_fsync'), false)
  } finally {
    await storeFixture.close(store)
  }
})

test('project state reloads under a descriptor lock and persists ready sessions atomically', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-store-')
  const {root, stateRoot, managedRoot} = storeFixture
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, {mode: 0o700})
  await chmod(stateRoot, 0o700)
  await chmod(managedRoot, 0o700)
  const durability: string[] = []
  const identifiers = ['workspace-0001', 'session-0001'][Symbol.iterator]()
  const options = await storeFixture.options({
    now: () => 100,
    idFactory: () => identifiers.next().value ?? 'unused-id',
    onDurabilityStep: (step: 'temp_open' | 'file_fsync' | 'atomic_replace' | 'dir_fsync' | 'windows_metadata_commit') => {
      durability.push(step)
    },
  })
  let first: ProjectStore | null = null
  let second: ProjectStore | null = null
  try {
    first = await ProjectStore.open(options)
    const workspace = await first.ensureImported(
      'Ａlpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const session = await first.beginSession(workspace.workspace_id, '登录修复')
    await first.markSessionReady(session.session_id, 'thread-exact-1')
    const home = await first.persistentHome(workspace.workspace_id)
    assert.ok(home)
    assert.deepEqual(durability.slice(-4), [
      'temp_open', 'file_fsync', 'atomic_replace',
      process.platform === 'win32' ? 'windows_metadata_commit' : 'dir_fsync',
    ])
    assert.deepEqual(await first.publicView(true), {
      workspace_display_name: 'Alpha',
      session_title: '登录修复',
      roster: [{name: 'Alpha', last_used_at: 100, running: []}],
      pending_confirmation: true,
      pending_confirmation_busy: false,
    })
    await first.close()
    first = null

    second = await ProjectStore.open(options)
    const snapshot = await second.snapshot()
    assert.ok(Number(
      (snapshot as unknown as {active_binding_revision?: unknown}).active_binding_revision,
    ) > 0)
    assert.equal(snapshot.active_workspace_id, workspace.workspace_id)
    assert.equal(snapshot.sessions[0]?.codex_thread_id, 'thread-exact-1')
    assert.equal(snapshot.workspaces[0]?.canonical_path, await realpath(workspacePath))
    const publicJson = JSON.stringify(await second.publicView(false))
    assert.equal(publicJson.includes(workspacePath), false)
    assert.equal(publicJson.includes('thread-exact-1'), false)
    const state = JSON.parse(await readFile(join(stateRoot, 'codex-projects-v1.json'), 'utf8')) as {
      version: number
      active_binding_revision?: number
    }
    assert.equal(state.version, 2)
    assert.equal(
      state.active_binding_revision,
      (snapshot as unknown as {active_binding_revision: number}).active_binding_revision,
    )
  } finally {
    await storeFixture.close(first, second)
  }
})

test('persistent homes are private, stable per workspace, and distinct across workspaces', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-homes-')

  const ids = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await storeFixture.open({
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    const first = await store.createManaged('first')
    const second = await store.createManaged('second')
    const firstHome = await store.persistentHome(first.workspace_id)
    const firstAgain = await store.persistentHome(first.workspace_id)
    const secondHome = await store.persistentHome(second.workspace_id)
    assert.equal(hostCodexHomeValue(firstHome).path, hostCodexHomeValue(firstAgain).path)
    assert.notEqual(hostCodexHomeValue(firstHome).path, hostCodexHomeValue(secondHome).path)
  } finally {
    await storeFixture.close(store)
  }
})

test('opening the live project store migrates legacy codex-workspaces to codex-homes', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-home-migration-')
  const {stateRoot, managedRoot} = storeFixture
  const canonicalStateRoot = await realpath(stateRoot)
  const legacyRoot = join(canonicalStateRoot, 'codex-workspaces')
  const legacyHome = join(legacyRoot, 'home-workspace-0001')
  await mkdir(legacyRoot, {mode: 0o700})
  await mkdir(legacyHome, {mode: 0o700})
  await writeFile(join(legacyHome, 'migration-marker'), 'preserved', {mode: 0o600})
  const store = await ProjectStore.open({
    stateRoot: hostProjectRootForTest(canonicalStateRoot),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
    idFactory: () => 'workspace-0001',
    live: true,
  })
  try {
    const migratedRoot = join(canonicalStateRoot, 'codex-homes')
    assert.equal(await readFile(join(migratedRoot, 'home-workspace-0001', 'migration-marker'), 'utf8'), 'preserved')
    await assert.rejects(lstat(legacyRoot), (error: unknown) => isErrno(error, 'ENOENT'))
  } finally {
    await storeFixture.close(store)
  }
})

test('a rejected legacy home migration releases the live owner lock for retry', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-home-migration-retry-')
  const {stateRoot} = storeFixture
  const legacyRoot = join(stateRoot, 'codex-workspaces')
  await mkdir(legacyRoot, {mode: 0o755})
  await chmod(legacyRoot, 0o755)
  const nativeLocks = new DescriptorLockAuthority()
  const options = await storeFixture.options({
    nativeLocks,
    live: true,
  })
  try {
    await assert.rejects(
      ProjectStore.open(options),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
    await chmod(legacyRoot, 0o700)
    const retried = await ProjectStore.open(options)
    await retried.close()
    assert.equal((await lstat(join(stateRoot, 'codex-homes'))).isDirectory(), true)
  } finally {
    await storeFixture.close()
  }
})

test('persistent home rejects an immediate mkdir replacement before chmod or adoption', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-home-race-')
  const {stateRoot, managedRoot} = storeFixture
  const rootFiles = new ReplaceHomeAfterMkdirRootFileAuthority([stateRoot, managedRoot])
  const store = await storeFixture.open({
    rootFiles,
    idFactory: () => 'workspace-0001',
  })
  try {
    const workspace = await store.createManaged('managed')
    await assert.rejects(
      store.persistentHome(workspace.workspace_id),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
    assert.notEqual(rootFiles.replacedPath, null)
    if (process.platform !== 'win32') {
      assert.equal(lstatSync(rootFiles.replacedPath!).mode & 0o7777, 0o755)
    }
  } finally {
    await storeFixture.close(store)
  }
})

test('managed rollback restores the deterministic most-recent survivor on timestamp ties', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-rollback-order-')

  const ids = ['workspace-0001', 'workspace-0002', 'workspace-0003'][Symbol.iterator]()
  const store = await storeFixture.open({
    idFactory: () => ids.next().value ?? 'unused-id',
    now: () => 100,
  })
  try {
    await store.createManaged('first')
    const second = await store.createManaged('second')
    const provisional = await store.createManaged('provisional')
    assert.equal(await store.rollbackManagedCreate(provisional.workspace_id), true)
    assert.equal((await store.resolveWorkspace(null)).workspace_id, second.workspace_id)
  } finally {
    await storeFixture.close(store)
  }
})

test('session retention prunes unavailable before inactive ready and never prunes active', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-session-retention-')
  const {root, stateRoot} = storeFixture
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, {mode: 0o700})
  const workspaceId = 'workspace-0001'
  const activeSessionId = 'session-0199'
  const sessions = Object.fromEntries(Array.from({length: 200}, (_unused, index) => {
    const sessionId = `session-${String(index).padStart(4, '0')}`
    return [sessionId, {
      session_id: sessionId,
      workspace_id: workspaceId,
      display_title: `Task ${index}`,
      normalized_title: `task ${index}`,
      codex_thread_id: `thread-${index}`,
      state: index === 0 ? 'unavailable' : 'ready',
      created_at: index,
      last_used_at: index,
    }]
  }))
  await writeFile(join(stateRoot, 'codex-projects-v1.json'), JSON.stringify({
    version: 1,
    active_workspace_id: workspaceId,
    workspaces: {
      [workspaceId]: {
        workspace_id: workspaceId,
        display_name: 'alpha',
        normalized_name: 'alpha',
        canonical_path: await realpath(workspacePath),
        origin: 'registered',
        codex_home_key: `home-${workspaceId}`,
        active_session_id: activeSessionId,
        created_at: 0,
        last_used_at: 199,
      },
    },
    sessions,
  }), {mode: 0o600})
  const store = await storeFixture.open({
    idFactory: () => 'session-new1',
    now: () => 1000,
  })
  try {
    const provisional = await store.beginSession(workspaceId, '新任务')
    assert.equal(provisional.display_title, '新任务')
    const retained = await store.listSessions(workspaceId)
    assert.equal(retained.length, 200)
    assert.equal(retained.some(session => session.session_id === 'session-0000'), false)
    assert.equal(retained.some(session => session.session_id === activeSessionId), true)
    assert.equal(retained.some(session => session.session_id === provisional.session_id), true)
  } finally {
    await storeFixture.close(store)
  }
})

test('a discovered session imported into a full workspace evicts like every other insert', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-import-retention-')
  const {root, stateRoot} = storeFixture
  const workspacePath = join(root, 'workspace')
  const sharedHome = join(root, 'codex-home')
  await mkdir(workspacePath, {mode: 0o700})
  await mkdir(sharedHome, {mode: 0o700})
  const workspaceId = 'workspace-0001'
  const activeSessionId = 'session-0199'
  const sessions = Object.fromEntries(Array.from({length: 200}, (_unused, index) => {
    const sessionId = `session-${String(index).padStart(4, '0')}`
    return [sessionId, {
      session_id: sessionId,
      workspace_id: workspaceId,
      display_title: `Task ${index}`,
      normalized_title: `task ${index}`,
      codex_thread_id: `thread-${index}`,
      state: index === 0 ? 'unavailable' : 'ready',
      created_at: index,
      last_used_at: index,
    }]
  }))
  await writeFile(join(stateRoot, 'codex-projects-v1.json'), JSON.stringify({
    version: 1,
    active_workspace_id: workspaceId,
    workspaces: {
      [workspaceId]: {
        workspace_id: workspaceId,
        display_name: 'alpha',
        normalized_name: 'alpha',
        canonical_path: await realpath(workspacePath),
        origin: 'registered',
        codex_home_key: `home-${workspaceId}`,
        active_session_id: activeSessionId,
        created_at: 0,
        last_used_at: 199,
      },
    },
    sessions,
  }), {mode: 0o600})
  const store = await storeFixture.open({
    idFactory: () => 'session-new1',
    now: () => 1000,
  })
  try {
    // A full workspace must not permanently freeze out newly discovered CLI sessions.
    const imported = await store.importSession(workspaceId, {
      threadId: 'thread-newly-discovered',
      title: '最新会话',
      home: await realpath(sharedHome),
      updatedAt: 5000,
    })
    const retained = await store.listSessions(workspaceId)
    assert.equal(retained.length, 200)
    assert.equal(retained.some(session => session.session_id === imported.session_id), true)
    assert.equal(retained.some(session => session.session_id === 'session-0000'), false)
    assert.equal(retained.some(session => session.session_id === activeSessionId), true)
  } finally {
    await storeFixture.close(store)
  }
})

test('setSessionTitle clips to 120 code points, keeps per-workspace uniqueness, and rejects unknown or empty', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-session-title-')
  const {root} = storeFixture
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, {mode: 0o700})
  const ids = ['workspace-0001', 'session-0001', 'session-0002'][Symbol.iterator]()
  const store = await storeFixture.open({
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    const workspace = await store.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const first = await store.beginSession(workspace.workspace_id, '博客')
    const second = await store.beginSession(workspace.workspace_id, '草稿')
    assert.equal(await store.setSessionTitle(second.session_id, '博客'), true)
    const renamed = await store.resolveSession(workspace.workspace_id, null)
    assert.equal(renamed.session_id, second.session_id)
    assert.notEqual(renamed.display_title, '博客', 'a Codex-owned name must not collide with a sibling')
    assert.equal(renamed.display_title.startsWith('博客'), true)
    assert.equal(await store.setSessionTitle(first.session_id, '甲'.repeat(150)), true)
    const clipped = (await store.listSessions(workspace.workspace_id)).find(s => s.session_id === first.session_id)
    assert.equal([...clipped!.display_title].length, 120)
    assert.equal(await store.setSessionTitle(first.session_id, '   '), false)
    assert.equal(await store.setSessionTitle('session-missing', '博客'), false)
  } finally {
    await storeFixture.close(store)
  }
})

test('rollback and unavailable transitions repair the active Session deterministically', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-session-repair-')
  const {root} = storeFixture
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, {mode: 0o700})
  const ids = ['workspace-0001', 'session-0001', 'session-0002', 'session-0003'][Symbol.iterator]()
  let now = 0
  const store = await storeFixture.open({
    idFactory: () => ids.next().value ?? 'unused-id',
    now: () => { now += 1; return now },
  })
  try {
    const workspace = await store.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const older = await store.beginSession(workspace.workspace_id, 'older')
    await store.markSessionReady(older.session_id, 'thread-older')
    const newer = await store.beginSession(workspace.workspace_id, 'newer')
    await store.markSessionReady(newer.session_id, 'thread-newer')
    const provisional = await store.beginSession(workspace.workspace_id, 'provisional')
    assert.equal(await store.rollbackSessionStart(provisional.session_id), true)
    assert.equal((await store.resolveSession(workspace.workspace_id, null)).session_id, newer.session_id)
    await assert.rejects(
      store.resolveSession(workspace.workspace_id, provisional.display_title),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'session_not_found',
    )
    assert.equal(
      (await store.listSessions(workspace.workspace_id))
        .some(session => session.session_id === provisional.session_id),
      false,
    )
    await store.markSessionUnavailable(newer.session_id)
    assert.equal((await store.resolveSession(workspace.workspace_id, null)).session_id, older.session_id)
    await store.markSessionUnavailable(older.session_id)
    await assert.rejects(
      store.resolveSession(workspace.workspace_id, null),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'session_not_found',
    )
  } finally {
    await storeFixture.close(store)
  }
})

test('thread identity uses Python code-point bounds and exact returned text', async () => {
  const storeFixture = await projectStoreFixture('nova-codex-project-thread-id-')
  const {root} = storeFixture
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, {mode: 0o700})
  const ids = ['workspace-0001', 'session-0001', 'session-0002'][Symbol.iterator]()
  const store = await storeFixture.open({
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    const workspace = await store.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const first = await store.beginSession(workspace.workspace_id, 'first')
    const exact = '😀'.repeat(256)
    assert.equal((await store.markSessionReady(first.session_id, exact)).codex_thread_id, exact)
    const second = await store.beginSession(workspace.workspace_id, 'second')
    for (const invalid of ['😀'.repeat(257), 'thread\u0000id', '']) {
      await assert.rejects(
        store.markSessionReady(second.session_id, invalid),
        (error: unknown) => error instanceof ProjectStateError && error.code === 'thread_id_invalid',
      )
    }
    assert.equal((await store.resolveSession(workspace.workspace_id, 'second')).state, 'starting')
  } finally {
    await storeFixture.close(store)
  }
})

test('live recovery preserves Python v1 bytes and migrates recovered session identity', async () => {
  const fixture = JSON.parse(await readFile(
    join(import.meta.dirname, '../../../tests/fixtures/runtime/codex-project-state-v1.json'),
    'utf8',
  )) as {readonly input_utf8_base64: string; readonly recovered_utf8_base64: string}
  const storeFixture = await projectStoreFixture('nova-codex-project-python-bytes-')
  const {stateRoot} = storeFixture
  const statePath = join(stateRoot, 'codex-projects-v1.json')
  await writeFile(statePath, Buffer.from(fixture.input_utf8_base64, 'base64'), {mode: 0o600})
  let store: ProjectStore | null = null
  try {
    store = await storeFixture.open({
      live: true,
    })
    const snapshot = await store.snapshot()
    assert.equal(snapshot.sessions[0]?.state, 'unavailable')
    assert.equal(snapshot.version, 2)
    assert.equal(snapshot.sessions[0]?.backend_id, 'codex')
    // The recovered v1 shape survives exactly; v2 only adds the Codex backend binding.
    const recovered = JSON.parse(Buffer.from(fixture.recovered_utf8_base64, 'base64').toString('utf8')) as {sessions: Record<string, unknown>}
    const migrated = JSON.parse(await readFile(statePath, 'utf8')) as {sessions: Record<string, Record<string, unknown>>}
    for (const [id, row] of Object.entries(migrated.sessions)) {
      assert.equal(row.backend_session_id, row.codex_thread_id)
      const legacy = {...row}
      delete legacy.backend_id
      delete legacy.backend_profile_id
      delete legacy.backend_session_id
      assert.deepEqual(legacy, recovered.sessions[id])
    }
    assert.deepEqual(
      await readFile(join(stateRoot, 'codex-projects-v1.pre-acp.json')),
      Buffer.from(fixture.input_utf8_base64, 'base64'),
    )
  } finally {
    await storeFixture.close(store)
  }
})
