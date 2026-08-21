import assert from 'node:assert/strict'
import {fstatSync, realpathSync} from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join, relative} from 'node:path'
import {test} from 'node:test'

import {VirtualClock, type Clock} from '../src/clock.js'
import {
  CodexProjectStore,
  ProjectStateError,
  hostManagedProjectRootForTest,
  hostProjectRootForTest,
  normalizeProjectSessionTitle,
  normalizeProjectWorkspaceName,
} from '../src/codex-project-store.js'
import {hostCodexHomeValue, hostWorkspaceForTest} from '../src/codex-process-owner.js'
import {
  unsupportedNativeFileLocks,
  type NativeFileLockAuthority,
  type NativeFileLockResult,
} from '../src/native-file-lock.js'

async function within<T>(name: string, work: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`${name} did not settle`)) }, milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

class DescriptorLockAuthority implements NativeFileLockAuthority {
  readonly #held = new Set<string>()

  acquire(descriptor: number): NativeFileLockResult {
    const info = fstatSync(descriptor, {bigint: true})
    const key = `${info.dev}:${info.ino}`
    if (this.#held.has(key)) return {status: 'busy'}
    this.#held.add(key)
    let released = false
    return {
      status: 'acquired',
      release: () => {
        if (released) throw new Error('native lock released twice')
        released = true
        this.#held.delete(key)
      },
    }
  }
}

class DeferredReleaseLockAuthority implements NativeFileLockAuthority {
  releaseStarted: (() => void) | null = null
  releaseNow: (() => void) | null = null

  acquire(): NativeFileLockResult {
    return {
      status: 'acquired',
      release: async () => {
        this.releaseStarted?.()
        await new Promise<void>(resolveRelease => { this.releaseNow = resolveRelease })
      },
    }
  }
}

class BusyThenDescriptorLockAuthority implements NativeFileLockAuthority {
  readonly #delegate = new DescriptorLockAuthority()
  busyAttempts = 0
  acquireCalls = 0

  acquire(descriptor: number): NativeFileLockResult {
    this.acquireCalls += 1
    if (this.busyAttempts > 0) {
      this.busyAttempts -= 1
      return {status: 'busy'}
    }
    return this.#delegate.acquire(descriptor)
  }
}

class AdvancingClock implements Clock {
  readonly sleeps: number[] = []
  #now = 0

  now(): number { return this.#now }

  sleep(duration: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      const error = new Error('sleep aborted')
      error.name = 'AbortError'
      return Promise.reject(error)
    }
    this.sleeps.push(duration)
    this.#now += duration
    return Promise.resolve()
  }
}

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
    join(import.meta.dirname, '../../src/codex-project-store.ts'),
    'utf8',
  )
  assert.equal(source.includes('/[\\p{L}\\p{N}]/u'), false)
})

test('durability and native locking source retain the audited no-fallback primitives', async () => {
  const storeSource = await readFile(
    join(import.meta.dirname, '../../src/codex-project-store.ts'),
    'utf8',
  )
  const nativeSource = await readFile(
    join(import.meta.dirname, '../../src/native-file-lock.ts'),
    'utf8',
  )
  const ordered = [
    'constants.O_EXCL | noFollowFlag()',
    'await file.sync()',
    'await rename(temp, join(this.#stateRoot, PROJECT_STATE_FILE))',
    'await directory.sync()',
  ].map(fragment => storeSource.indexOf(fragment))
  assert.equal(ordered.every(index => index >= 0), true)
  assert.deepEqual([...ordered].sort((left, right) => left - right), ordered)
  assert.match(storeSource, /constants\.O_RDONLY \| nonblockFlag\(\) \| noFollowFlag\(\)/u)
  assert.doesNotMatch(storeSource, /\.trim\(/u)
  assert.match(storeSource, /\(info\.mode & 0o7777\) !== 0o700/u)
  assert.match(storeSource, /\(info\.mode & 0o7777\) !== 0o600/u)
  assert.match(storeSource, /return \(mode & 0o022\) !== 0/u)
  assert.match(nativeSource, /acquire\(descriptor: number\)/u)
  assert.doesNotMatch(nativeSource, /process\.pid|mkdir|stale|lockfile|path:/iu)
})

test('native lock unsupported and busy results fail closed without a PID or path lock fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-lock-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const roots = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
  }
  let store: CodexProjectStore | null = null
  try {
    store = await CodexProjectStore.open({...roots, nativeLocks: unsupportedNativeFileLocks})
    await assert.rejects(
      store.snapshot(),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_lock_failed',
    )
    await assert.rejects(
      CodexProjectStore.open({...roots, nativeLocks: unsupportedNativeFileLocks, live: true}),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_lock_failed',
    )
    const busy: NativeFileLockAuthority = {acquire: () => ({status: 'busy'})}
    const contended = await CodexProjectStore.open({...roots, nativeLocks: busy})
    await assert.rejects(
      contended.snapshot(),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_busy',
    )
    await contended.close()
    for (const nativeLocks of [
      {acquire: (): NativeFileLockResult => ({status: 'failed'})},
      {acquire: (): NativeFileLockResult => { throw new Error('native sentinel') }},
      {acquire: (): NativeFileLockResult => null as unknown as NativeFileLockResult},
    ]) {
      const failed = await CodexProjectStore.open({...roots, nativeLocks})
      await assert.rejects(
        failed.snapshot(),
        (error: unknown) => error instanceof ProjectStateError
          && error.code === 'state_lock_failed'
          && !String(error).includes('sentinel'),
      )
      await failed.close()
    }
  } finally {
    await store?.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('a transaction joins asynchronous native unlock before its promise settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-lock-join-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const nativeLocks = new DeferredReleaseLockAuthority()
  let releaseStartedResolve: (() => void) | null = null
  const releaseStarted = new Promise<void>(resolveStarted => { releaseStartedResolve = resolveStarted })
  nativeLocks.releaseStarted = () => { releaseStartedResolve?.() }
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('rollback and first-live recovery use one bounded abort-aware descriptor-lock wait', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-lock-wait-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspacePath = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspacePath, {mode: 0o700})
  const nativeLocks = new BusyThenDescriptorLockAuthority()
  const clock = new AdvancingClock()
  const ids = ['workspace-0001', 'session-0001', 'session-0002'][Symbol.iterator]()
  const options = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks,
    idFactory: () => ids.next().value ?? 'unused-id',
    lockClock: clock,
  } as Parameters<typeof CodexProjectStore.open>[0]
  let ordinary: CodexProjectStore | null = null
  let live: CodexProjectStore | null = null
  try {
    ordinary = await CodexProjectStore.open(options)
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
    live = await CodexProjectStore.open({...options, live: true})
    nativeLocks.busyAttempts = 2
    assert.equal((await live.resolveSession(workspace.workspace_id, crashed.display_title)).state, 'unavailable')
    assert.deepEqual(clock.sleeps, [0.025, 0.025, 0.025, 0.025])
  } finally {
    await ordinary?.close()
    await live?.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('managed-create rollback opts into the same bounded descriptor-lock wait', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-managed-lock-wait-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const nativeLocks = new BusyThenDescriptorLockAuthority()
  const clock = new AdvancingClock()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('ready and unavailable finalization opt into the same bounded descriptor-lock wait', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-finalize-lock-wait-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspacePath = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspacePath, {mode: 0o700})
  const nativeLocks = new BusyThenDescriptorLockAuthority()
  const clock = new AdvancingClock()
  const ids = ['workspace-0001', 'session-0001'][Symbol.iterator]()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks,
    idFactory: () => ids.next().value ?? 'unused-id',
    lockClock: clock,
  })
  try {
    const workspace = await store.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const starting = await store.beginSession(workspace.workspace_id, null)
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('an aborted bounded lock wait settles and is joined before store close returns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-lock-abort-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspacePath = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspacePath, {mode: 0o700})
  const nativeLocks = new BusyThenDescriptorLockAuthority()
  const clock = new VirtualClock()
  const ids = ['workspace-0001', 'session-0001'][Symbol.iterator]()
  const options = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks,
    idFactory: () => ids.next().value ?? 'unused-id',
    lockClock: clock,
  } as Parameters<typeof CodexProjectStore.open>[0]
  const store = await CodexProjectStore.open(options)
  try {
    const workspace = await store.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const starting = await store.beginSession(workspace.workspace_id, null)
    nativeLocks.busyAttempts = Number.MAX_SAFE_INTEGER
    const abort = new AbortController()
    const rollback = (store.rollbackSessionStart as unknown as (
      sessionId: string,
      options: {readonly wait: boolean; readonly signal: AbortSignal},
    ) => Promise<boolean>).call(store, starting.session_id, {wait: true, signal: abort.signal})
    void rollback.catch(() => undefined)
    for (let attempt = 0; attempt < 100 && clock.waiterCount() === 0; attempt += 1) {
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('a bounded lock wait exhausts one fixed deadline and returns stable state_busy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-lock-deadline-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspacePath = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspacePath, {mode: 0o700})
  const nativeLocks = new BusyThenDescriptorLockAuthority()
  const clock = new AdvancingClock()
  const ids = ['workspace-0001', 'session-0001'][Symbol.iterator]()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks,
    idFactory: () => ids.next().value ?? 'unused-id',
    lockClock: clock,
  })
  try {
    const workspace = await store.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const starting = await store.beginSession(workspace.workspace_id, null)
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('live owner exclusion and first-transaction recovery are crash-safe and ordinary readers do not recover', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-owner-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspacePath = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspacePath, {mode: 0o700})
  const nativeLocks = new DescriptorLockAuthority()
  const ids = ['workspace-0001', 'session-0001'][Symbol.iterator]()
  const options = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks,
    idFactory: () => ids.next().value ?? 'unused-id',
  }
  let first: CodexProjectStore | null = null
  let ordinary: CodexProjectStore | null = null
  let restarted: CodexProjectStore | null = null
  try {
    first = await CodexProjectStore.open({...options, live: true})
    const workspace = await first.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const starting = await first.beginSession(workspace.workspace_id, 'Task 1')
    await assert.rejects(
      CodexProjectStore.open({...options, live: true}),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_busy',
    )
    ordinary = await CodexProjectStore.open(options)
    assert.equal((await ordinary.resolveSession(workspace.workspace_id, 'Task 1')).state, 'starting')
    await ordinary.close()
    ordinary = null
    await first.close()
    first = null
    restarted = await CodexProjectStore.open({...options, live: true})
    const recovered = await restarted.resolveSession(workspace.workspace_id, starting.display_title)
    assert.equal(recovered.state, 'unavailable')
  } finally {
    await first?.close()
    await ordinary?.close()
    await restarted?.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('registry no-follow, owner mode, byte cap, strict decode, and corrupt-byte preservation fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-state-security-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const statePath = join(stateRoot, 'codex-projects-v1.json')
  const options = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
  }
  const expectCode = async (code: string): Promise<void> => {
    const store = await CodexProjectStore.open(options)
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
      version: 2, active_workspace_id: null, workspaces: {}, sessions: {},
    }), {mode: 0o600})
    await chmod(statePath, 0o600)
    await expectCode('state_version_unsupported')

    const emptyState = Buffer.from('{"version":1,"active_workspace_id":null,"workspaces":{},"sessions":{}}')
    await writeFile(statePath, Buffer.concat([
      emptyState,
      Buffer.alloc(1024 * 1024 - emptyState.byteLength, 0x20),
    ]), {mode: 0o600})
    const exactLimit = await CodexProjectStore.open(options)
    try {
      assert.deepEqual(await exactLimit.snapshot(), {
        version: 1, active_workspace_id: null, workspaces: [], sessions: [],
      })
    } finally {
      await exactLimit.close()
    }

    await writeFile(statePath, Buffer.alloc(1024 * 1024 + 1, 0x20), {mode: 0o600})
    await chmod(statePath, 0o600)
    await expectCode('state_too_large')

    await writeFile(statePath, '{}', {mode: 0o600})
    await chmod(statePath, 0o644)
    await expectCode('state_permissions')

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

    await rm(statePath)
    const outside = join(root, 'outside')
    await writeFile(outside, '{}', {mode: 0o600})
    await symlink(outside, statePath)
    await expectCode('state_permissions')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('state roots and files reject special permission bits rather than masking them away', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-special-mode-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
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
    const store = await CodexProjectStore.open({
      stateRoot: hostProjectRootForTest(realpathSync(stateRoot)),
      managedRoot: hostManagedProjectRootForTest(realpathSync(managedRoot)),
      nativeLocks: new DescriptorLockAuthority(),
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
    await rm(root, {recursive: true, force: true})
  }
})

test('an owner-controlled 0750 managed root is accepted while group-writable roots are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-managed-mode-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o750})
  await chmod(managedRoot, 0o750)
  try {
    const accepted = await CodexProjectStore.open({
      stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
      managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
      nativeLocks: new DescriptorLockAuthority(),
      idFactory: () => 'workspace-0001',
    })
    try {
      assert.equal((await accepted.createManaged('alpha')).origin, 'managed')
    } finally {
      await accepted.close()
    }

    for (const unsafeMode of [0o770]) {
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
    join(import.meta.dirname, '../../../fixtures/runtime/codex-project-state-v1.json'),
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
  tooManyWorkspaces.workspaces = Object.fromEntries(Array.from({length: 101}, (_unused, index) => {
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

  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-strict-state-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const statePath = join(stateRoot, 'codex-projects-v1.json')
  const options = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
  }
  try {
    for (const mutation of mutations) {
      await writeFile(statePath, JSON.stringify(mutation.value), {mode: 0o600})
      await chmod(statePath, 0o600)
      const store = await CodexProjectStore.open(options)
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
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('managed and registered workspace bindings reject symlink replacement at transport time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-boundary-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const registered = join(root, 'registered')
  const replacement = join(root, 'replacement')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(registered, {mode: 0o700})
  await mkdir(replacement, {mode: 0o700})
  const ids = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    const imported = await store.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(registered)),
    )
    await rename(registered, join(root, 'registered-original'))
    await symlink(replacement, registered, 'dir')
    await assert.rejects(
      store.revalidateWorkspace(imported.workspace_id),
      (error: unknown) => error instanceof ProjectStateError
        && error.code === 'workspace_boundary_changed',
    )

    const managed = await store.createManaged('天气 看板')
    assert.equal(relative(await realpath(managedRoot), managed.canonical_path).includes('/'), false)
    await store.revalidateWorkspace(managed.workspace_id)
  } finally {
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('a managed record must remain a direct child even when its replacement path is canonical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-direct-parent-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const outside = join(root, 'outside')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(outside, {mode: 0o700})
  const options = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    idFactory: () => 'workspace-0001',
  }
  let store: CodexProjectStore | null = null
  try {
    store = await CodexProjectStore.open(options)
    const workspace = await store.createManaged('alpha')
    await store.close()
    store = null
    const statePath = join(stateRoot, 'codex-projects-v1.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      workspaces: Record<string, {canonical_path: string}>
    }
    state.workspaces[workspace.workspace_id]!.canonical_path = await realpath(outside)
    await writeFile(statePath, JSON.stringify(state), {mode: 0o600})
    store = await CodexProjectStore.open(options)
    await assert.rejects(
      store.revalidateWorkspace(workspace.workspace_id),
      (error: unknown) => error instanceof ProjectStateError
        && error.code === 'workspace_boundary_changed',
    )
  } finally {
    await store?.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('managed creation uses only a pinned safe slug and rollback never deletes user data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-managed-safety-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const ids = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    const workspace = await store.createManaged('😀')
    assert.equal(
      basename(workspace.canonical_path),
      `workspace-${[...workspace.workspace_id].slice(-12).join('')}`,
    )
    assert.equal((await lstat(workspace.canonical_path)).mode & 0o777, 0o700)
    await writeFile(join(workspace.canonical_path, 'keep.txt'), 'user data')
    assert.equal(await store.rollbackManagedCreate(workspace.workspace_id), false)
    assert.equal((await store.resolveWorkspace('😀')).workspace_id, workspace.workspace_id)

    await assert.rejects(
      store.createManaged('😀'),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'workspace_name_conflict',
    )
  } finally {
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('a managed slug and ID collision is a stable path conflict without overwriting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-path-conflict-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    idFactory: () => 'workspace-0001',
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
    await store.close()
    await rm(root, {recursive: true, force: true})
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

test('project state reloads under a descriptor lock and persists ready sessions atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-store-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspacePath = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspacePath, {mode: 0o700})
  await chmod(stateRoot, 0o700)
  await chmod(managedRoot, 0o700)
  const durability: string[] = []
  const identifiers = ['workspace-0001', 'session-0001'][Symbol.iterator]()
  const options = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    now: () => 100,
    idFactory: () => identifiers.next().value ?? 'unused-id',
    onDurabilityStep: (step: 'temp_open' | 'file_fsync' | 'atomic_replace' | 'dir_fsync') => {
      durability.push(step)
    },
  }
  let first: CodexProjectStore | null = null
  let second: CodexProjectStore | null = null
  try {
    first = await CodexProjectStore.open(options)
    const workspace = await first.ensureImported(
      'Ａlpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    const session = await first.beginSession(workspace.workspace_id, '登录修复')
    await first.markSessionReady(session.session_id, 'thread-exact-1')
    const home = await first.persistentHome(workspace.workspace_id)
    assert.ok(home)
    assert.deepEqual(durability.slice(-4), [
      'temp_open', 'file_fsync', 'atomic_replace', 'dir_fsync',
    ])
    assert.deepEqual(await first.publicView(true), {
      workspace_display_name: 'Alpha',
      session_title: '登录修复',
      pending_confirmation: true,
    })
    await first.close()
    first = null

    second = await CodexProjectStore.open(options)
    const snapshot = await second.snapshot()
    assert.equal(snapshot.active_workspace_id, workspace.workspace_id)
    assert.equal(snapshot.sessions[0]?.codex_thread_id, 'thread-exact-1')
    assert.equal(JSON.stringify(snapshot).includes(workspacePath), true)
    const publicJson = JSON.stringify(await second.publicView(false))
    assert.equal(publicJson.includes(workspacePath), false)
    assert.equal(publicJson.includes('thread-exact-1'), false)
    const state = JSON.parse(await readFile(join(stateRoot, 'codex-projects-v1.json'), 'utf8')) as {
      version: number
    }
    assert.equal(state.version, 1)
  } finally {
    await first?.close()
    await second?.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('persistent homes are private, stable per workspace, and distinct across workspaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-homes-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const ids = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('managed rollback restores the deterministic most-recent survivor on timestamp ties', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-rollback-order-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const ids = ['workspace-0001', 'workspace-0002', 'workspace-0003'][Symbol.iterator]()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('session retention prunes unavailable before inactive ready and never prunes active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-session-retention-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspacePath = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
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
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    idFactory: () => 'session-new1',
    now: () => 1000,
  })
  try {
    const provisional = await store.beginSession(workspaceId, null)
    assert.equal(provisional.display_title, '任务 1')
    const retained = await store.listSessions(workspaceId)
    assert.equal(retained.length, 200)
    assert.equal(retained.some(session => session.session_id === 'session-0000'), false)
    assert.equal(retained.some(session => session.session_id === activeSessionId), true)
    assert.equal(retained.some(session => session.session_id === provisional.session_id), true)
  } finally {
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('default Session numbering increments Python integers beyond Number safe range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-session-bigint-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspacePath = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspacePath, {mode: 0o700})
  const ids = ['workspace-0001', 'session-0001', 'session-0002'][Symbol.iterator]()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    idFactory: () => ids.next().value ?? 'unused-id',
  })
  try {
    const workspace = await store.ensureImported(
      'alpha',
      hostWorkspaceForTest(await realpath(workspacePath)),
    )
    await store.beginSession(workspace.workspace_id, '任务 9007199254740993')
    const generated = await store.beginSession(workspace.workspace_id, null)
    assert.equal(generated.display_title, '任务 9007199254740994')
  } finally {
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('rollback and unavailable transitions repair the active Session deterministically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-session-repair-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspacePath = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspacePath, {mode: 0o700})
  const ids = ['workspace-0001', 'session-0001', 'session-0002', 'session-0003'][Symbol.iterator]()
  let now = 0
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('thread identity uses Python code-point bounds and exact returned text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-thread-id-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspacePath = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspacePath, {mode: 0o700})
  const ids = ['workspace-0001', 'session-0001', 'session-0002'][Symbol.iterator]()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('live recovery reads Python v1 bytes and writes byte-identical Python canonical JSON', async () => {
  const fixture = JSON.parse(await readFile(
    join(import.meta.dirname, '../../../fixtures/runtime/codex-project-state-v1.json'),
    'utf8',
  )) as {readonly input_utf8_base64: string; readonly recovered_utf8_base64: string}
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-python-bytes-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const statePath = join(stateRoot, 'codex-projects-v1.json')
  await writeFile(statePath, Buffer.from(fixture.input_utf8_base64, 'base64'), {mode: 0o600})
  let store: CodexProjectStore | null = null
  try {
    store = await CodexProjectStore.open({
      stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
      managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
      nativeLocks: new DescriptorLockAuthority(),
      live: true,
    })
    const snapshot = await store.snapshot()
    assert.equal(snapshot.sessions[0]?.state, 'unavailable')
    assert.deepEqual(
      await readFile(statePath),
      Buffer.from(fixture.recovered_utf8_base64, 'base64'),
    )
  } finally {
    await store?.close()
    await rm(root, {recursive: true, force: true})
  }
})
