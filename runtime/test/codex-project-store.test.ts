import assert from 'node:assert/strict'
import {
  chmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
  PROJECT_MAINTENANCE_JOURNAL_FILE,
  ProjectStateError,
  hostManagedProjectRootForTest,
  hostProjectRootForTest,
  normalizeProjectSessionTitle,
  normalizeProjectWorkspaceName,
} from '../src/codex-project-store.js'
import {
  hostCodexHomeValue,
  hostWorkspaceForTest,
  hostWorkspacePath,
} from '../src/codex-process-owner.js'
import {ManagedWorkspaceMaintenanceService} from '../src/managed-workspace-maintenance.js'
import {
  unsupportedNativeFileLocks,
  type NativeFileLockAuthority,
  type NativeFileLockResult,
} from '../src/native-file-lock.js'
import type {
  ProjectFileIdentity,
  ProjectRootFileAuthority,
  ProjectRootFileCreateResult,
  ProjectRootFileLookupResult,
  ProjectRootFileResult,
} from '../src/project-root-file.js'

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

/** Test-only inode resolver; it is not evidence for the deferred Task-8 native implementation. */
class DescriptorRelativeRootFileAuthority implements ProjectRootFileAuthority {
  readonly #roots = new Map<string, {path: string; readonly parent: string}>()

  constructor(paths: readonly string[]) {
    for (const path of paths) {
      const info = lstatSync(path, {bigint: true})
      this.#roots.set(`${info.dev}:${info.ino}`, {path, parent: join(path, '..')})
    }
  }

  probe(rootDescriptor: number): ProjectRootFileResult {
    try {
      this.#rootPath(rootDescriptor)
      return {status: 'ok'}
    } catch {
      return {status: 'failed'}
    }
  }

  matchesAt(rootDescriptor: number, name: string, childDescriptor: number): ProjectRootFileResult {
    try {
      const child = fstatSync(childDescriptor, {bigint: true})
      const root = this.#rootPath(rootDescriptor)
      const path = join(root, name)
      const current = lstatSync(path, {bigint: true})
      if (current.dev !== child.dev || current.ino !== child.ino) return {status: 'mismatch'}
      if (child.isDirectory()) {
        this.#roots.set(`${child.dev}:${child.ino}`, {path, parent: root})
      }
      return {status: 'ok'}
    } catch (error) {
      return isErrno(error, 'ENOENT') ? {status: 'missing'} : {status: 'failed'}
    }
  }

  lookupAt(rootDescriptor: number, name: string): ProjectRootFileLookupResult {
    try {
      const info = lstatSync(join(this.#rootPath(rootDescriptor), name), {bigint: true})
      return {status: 'ok', identity: {device: info.dev, inode: info.ino}}
    } catch (error) {
      return isErrno(error, 'ENOENT') ? {status: 'missing'} : {status: 'failed'}
    }
  }

  createFileAt(
    rootDescriptor: number,
    name: string,
    exclusive: boolean,
  ): ProjectRootFileCreateResult {
    try {
      void exclusive
      const path = join(this.#rootPath(rootDescriptor), name)
      writeFileSync(path, '', {flag: 'wx', mode: 0o600})
      chmodSync(path, 0o600)
      const info = lstatSync(path, {bigint: true})
      return {status: 'ok', identity: {device: info.dev, inode: info.ino}}
    } catch (error) {
      return isErrno(error, 'EEXIST') ? {status: 'exists'} : {status: 'failed'}
    }
  }

  mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    try {
      const path = join(this.#rootPath(rootDescriptor), name)
      mkdirSync(path, {mode: 0o700})
      chmodSync(path, 0o700)
      const info = lstatSync(path, {bigint: true})
      return {status: 'ok', identity: {device: info.dev, inode: info.ino}}
    } catch (error) {
      return isErrno(error, 'EEXIST') ? {status: 'exists'} : {status: 'failed'}
    }
  }

  mkdirPrivateAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    return this.mkdirAt(rootDescriptor, name)
  }

  protectAt(
    rootDescriptor: number,
    name: string,
    childDescriptor: number,
  ): ProjectRootFileResult {
    const matched = this.matchesAt(rootDescriptor, name, childDescriptor)
    if (matched.status !== 'ok') return matched
    try {
      chmodSync(this.pathAt(rootDescriptor, name), 0o700)
      return {status: 'ok'}
    } catch {
      return {status: 'failed'}
    }
  }

  renameAt(rootDescriptor: number, from: string, to: string): ProjectRootFileResult {
    try {
      const root = this.#rootPath(rootDescriptor)
      const destination = join(root, to)
      // The production Windows addon uses MoveFileExW(...,
      // MOVEFILE_REPLACE_EXISTING). Node's renameSync maps to a non-replacing
      // Windows operation, so this test authority must emulate the native
      // replace contract instead of accidentally testing Node's wrapper.
      if (process.platform === 'win32') {
        try { unlinkSync(destination) } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error
        }
      }
      renameSync(join(root, from), destination)
      return {status: 'ok'}
    } catch (error) {
      return isErrno(error, 'ENOENT') ? {status: 'missing'} : {status: 'failed'}
    }
  }

  renameNoReplaceAt(
    rootDescriptor: number,
    from: string,
    to: string,
    expected: ProjectFileIdentity,
  ): ProjectRootFileResult {
    try {
      const root = this.#rootPath(rootDescriptor)
      const source = lstatSync(join(root, from), {bigint: true})
      if (source.dev !== expected.device || source.ino !== expected.inode) {
        return {status: 'mismatch'}
      }
      try {
        lstatSync(join(root, to))
        return {status: 'exists'}
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) return {status: 'failed'}
      }
      renameSync(join(root, from), join(root, to))
      return {status: 'ok'}
    } catch (error) {
      return isErrno(error, 'ENOENT') ? {status: 'missing'} : {status: 'failed'}
    }
  }

  syncDirectory(rootDescriptor: number): ProjectRootFileResult {
    try {
      this.#rootPath(rootDescriptor)
      return {status: 'ok'}
    } catch {
      return {status: 'failed'}
    }
  }

  unlinkAt(
    rootDescriptor: number,
    name: string,
    expected: ProjectFileIdentity,
    kind: 'file' | 'directory',
  ): ProjectRootFileResult {
    try {
      const path = join(this.#rootPath(rootDescriptor), name)
      const current = lstatSync(path, {bigint: true})
      if (current.dev !== expected.device || current.ino !== expected.inode) {
        return {status: 'mismatch'}
      }
      if (kind === 'directory') rmdirSync(path)
      else unlinkSync(path)
      return {status: 'ok'}
    } catch (error) {
      return isErrno(error, 'ENOENT') ? {status: 'missing'} : {status: 'failed'}
    }
  }

  removeTreeAt(
    rootDescriptor: number,
    name: string,
    expected: ProjectFileIdentity,
  ): ProjectRootFileResult {
    try {
      const path = join(this.#rootPath(rootDescriptor), name)
      const current = lstatSync(path, {bigint: true})
      if (current.dev !== expected.device || current.ino !== expected.inode) {
        return {status: 'mismatch'}
      }
      rmSync(path, {recursive: true})
      return {status: 'ok'}
    } catch (error) {
      return isErrno(error, 'ENOENT') ? {status: 'missing'} : {status: 'failed'}
    }
  }

  protected pathAt(rootDescriptor: number, name: string): string {
    return join(this.#rootPath(rootDescriptor), name)
  }

  #rootPath(descriptor: number): string {
    const info = fstatSync(descriptor, {bigint: true})
    const key = `${info.dev}:${info.ino}`
    const root = this.#roots.get(key)
    if (root === undefined) throw new Error('unknown test root descriptor')
    if (samePathIdentity(root.path, info.dev, info.ino)) return root.path
    for (const entry of readdirSync(root.parent)) {
      const candidate = join(root.parent, entry)
      if (samePathIdentity(candidate, info.dev, info.ino)) {
        root.path = candidate
        return candidate
      }
    }
    throw new Error('test root descriptor has no path')
  }
}

class ToggleRemoveTreeRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  failRemoveTree = false

  override removeTreeAt(
    rootDescriptor: number,
    name: string,
    expected: ProjectFileIdentity,
  ): ProjectRootFileResult {
    return this.failRemoveTree
      ? {status: 'failed'}
      : super.removeTreeAt(rootDescriptor, name, expected)
  }
}

class MaintenanceOrderRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  recording = false
  readonly events: string[] = []

  override renameAt(rootDescriptor: number, from: string, to: string): ProjectRootFileResult {
    if (this.recording && (from.startsWith('.nova-maintenance-') || to.startsWith('.nova-maintenance-'))) {
      this.events.push(`rename:${from}:${to}`)
    }
    return super.renameAt(rootDescriptor, from, to)
  }

  override renameNoReplaceAt(
    rootDescriptor: number,
    from: string,
    to: string,
    expected: ProjectFileIdentity,
  ): ProjectRootFileResult {
    if (this.recording && (from.startsWith('.nova-') || to.startsWith('.nova-'))) {
      this.events.push(`rename:${from}:${to}`)
    }
    return super.renameNoReplaceAt(rootDescriptor, from, to, expected)
  }

  override mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    if (this.recording) this.events.push(`mkdir:${name}`)
    return super.mkdirAt(rootDescriptor, name)
  }
}

class MaintenanceCollisionRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  collisionIdentity: ProjectFileIdentity | null = null

  #installCollision(rootDescriptor: number, to: string): void {
    if (this.collisionIdentity !== null || !to.startsWith('.nova-maintenance-')) return
    const destination = this.pathAt(rootDescriptor, to)
    mkdirSync(destination, {mode: 0o700})
    const info = lstatSync(destination, {bigint: true})
    this.collisionIdentity = {device: info.dev, inode: info.ino}
  }

  override renameAt(rootDescriptor: number, from: string, to: string): ProjectRootFileResult {
    this.#installCollision(rootDescriptor, to)
    return super.renameAt(rootDescriptor, from, to)
  }

  override renameNoReplaceAt(
    rootDescriptor: number,
    from: string,
    to: string,
    expected: ProjectFileIdentity,
  ): ProjectRootFileResult {
    this.#installCollision(rootDescriptor, to)
    return super.renameNoReplaceAt(rootDescriptor, from, to, expected)
  }
}

class MaintenanceDurabilityRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  recording = false
  readonly events: string[] = []
  failReplacementNumber: number | null = null
  failCleanupName: string | null = null
  #replacementCreates = 0

  override mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    if (this.recording && name.startsWith('.nova-replacement-')) {
      this.#replacementCreates += 1
      this.events.push(`replacement:create:${name}`)
      if (this.#replacementCreates === this.failReplacementNumber) return {status: 'failed'}
    }
    return super.mkdirAt(rootDescriptor, name)
  }

  override renameAt(rootDescriptor: number, from: string, to: string): ProjectRootFileResult {
    if (this.recording && to === PROJECT_MAINTENANCE_JOURNAL_FILE) {
      this.events.push('journal:write')
    }
    return super.renameAt(rootDescriptor, from, to)
  }

  override renameNoReplaceAt(
    rootDescriptor: number,
    from: string,
    to: string,
    expected: ProjectFileIdentity,
  ): ProjectRootFileResult {
    if (this.recording) this.events.push(`maintenance:rename:${from}:${to}`)
    return super.renameNoReplaceAt(rootDescriptor, from, to, expected)
  }

  override syncDirectory(rootDescriptor: number): ProjectRootFileResult {
    if (this.recording) this.events.push('managed:sync')
    return super.syncDirectory(rootDescriptor)
  }

  override unlinkAt(
    rootDescriptor: number,
    name: string,
    expected: ProjectFileIdentity,
    kind: 'file' | 'directory',
  ): ProjectRootFileResult {
    if (this.recording && name === PROJECT_MAINTENANCE_JOURNAL_FILE) {
      this.events.push('journal:clear')
    }
    return super.unlinkAt(rootDescriptor, name, expected, kind)
  }

  override removeTreeAt(
    rootDescriptor: number,
    name: string,
    expected: ProjectFileIdentity,
  ): ProjectRootFileResult {
    if (this.recording) this.events.push(`cleanup:${name}`)
    if (name === this.failCleanupName) return {status: 'failed'}
    return super.removeTreeAt(rootDescriptor, name, expected)
  }
}

class FailNthMaintenanceMkdirAuthority extends DescriptorRelativeRootFileAuthority {
  enabled = false
  calls = 0

  override mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    if (this.enabled && ++this.calls === 2) return {status: 'failed'}
    return super.mkdirAt(rootDescriptor, name)
  }
}

class ReplaceCreatedLockRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  replaced = false

  override createFileAt(
    rootDescriptor: number,
    name: string,
    exclusive: boolean,
  ): ProjectRootFileCreateResult {
    const result = super.createFileAt(rootDescriptor, name, exclusive)
    if (!this.replaced && name === 'codex-projects-v1.lock' && result.status === 'ok') {
      this.replaced = true
      const path = this.pathAt(rootDescriptor, name)
      renameSync(path, `${path}.created-away`)
      writeFileSync(path, '', {flag: 'wx', mode: 0o600})
      chmodSync(path, 0o600)
    }
    return result
  }
}

class ReplaceHomeAfterMkdirRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  replacedPath: string | null = null

  override mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    const result = super.mkdirAt(rootDescriptor, name)
    if (this.replacedPath === null && name.startsWith('home-') && result.status === 'ok') {
      const path = this.pathAt(rootDescriptor, name)
      renameSync(path, `${path}.created-away`)
      mkdirSync(path, {mode: 0o755})
      chmodSync(path, 0o755)
      this.replacedPath = path
    }
    return result
  }
}

class RecordingRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  readonly createdFiles: {readonly name: string; readonly exclusive: boolean}[] = []

  override createFileAt(
    rootDescriptor: number,
    name: string,
    exclusive: boolean,
  ): ProjectRootFileCreateResult {
    this.createdFiles.push({name, exclusive})
    return super.createFileAt(rootDescriptor, name, exclusive)
  }
}

class FailTempCreateRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  override createFileAt(
    rootDescriptor: number,
    name: string,
    exclusive: boolean,
  ): ProjectRootFileCreateResult {
    if (exclusive && name.endsWith('.tmp')) return {status: 'failed'}
    return super.createFileAt(rootDescriptor, name, exclusive)
  }
}

type ManagedMatchAuthorityForTest = Readonly<{
  rootDescriptor: number
  name: string
  childDescriptor: number
  generation: symbol
}>

class ToggleTempCreateRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  failTempCreate = false
  readonly #managedAuthorities = new Map<string, ManagedMatchAuthorityForTest>()
  readonly #managedAuthorityTokens = new Map<number, ManagedMatchAuthorityForTest>()
  #nextManagedDescriptorToken = -1

  managedAuthorityForTest(name: string): ManagedMatchAuthorityForTest | null {
    return this.#managedAuthorities.get(name) ?? null
  }

  override createFileAt(
    rootDescriptor: number,
    name: string,
    exclusive: boolean,
  ): ProjectRootFileCreateResult {
    if (this.failTempCreate && exclusive && name.endsWith('.tmp')) return {status: 'failed'}
    return super.createFileAt(rootDescriptor, name, exclusive)
  }

  override mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    const result = super.mkdirAt(rootDescriptor, name)
    if (result.status === 'ok' && name.startsWith('managed-')) {
      const authority = Object.freeze({
        rootDescriptor,
        name,
        childDescriptor: this.#nextManagedDescriptorToken,
        generation: Symbol(name),
      })
      this.#managedAuthorities.set(name, authority)
      this.#managedAuthorityTokens.set(authority.childDescriptor, authority)
      this.#nextManagedDescriptorToken -= 1
    }
    return result
  }

  override matchesAt(
    rootDescriptor: number,
    name: string,
    childDescriptor: number,
  ): ProjectRootFileResult {
    const supplied = this.#managedAuthorityTokens.get(childDescriptor)
    if (supplied === undefined) {
      return childDescriptor < 0
        ? {status: 'failed'}
        : super.matchesAt(rootDescriptor, name, childDescriptor)
    }
    const current = this.#managedAuthorities.get(name)
    if (current === undefined) return {status: 'failed'}
    if (
      supplied.rootDescriptor !== rootDescriptor
      || supplied.name !== name
      || current.rootDescriptor !== rootDescriptor
    ) return {status: 'mismatch'}
    return current.generation === supplied.generation
      ? {status: 'ok'}
      : {status: 'mismatch'}
  }

  override unlinkAt(
    rootDescriptor: number,
    name: string,
    expected: ProjectFileIdentity,
    kind: 'file' | 'directory',
  ): ProjectRootFileResult {
    const result = super.unlinkAt(rootDescriptor, name, expected, kind)
    if (name.startsWith('managed-') && kind === 'directory' && result.status === 'ok') {
      this.#managedAuthorities.delete(name)
    }
    return result
  }
}

class ReplaceManagedRestoreAfterMkdirRootFileAuthority
  extends ToggleTempCreateRootFileAuthority {
  readonly #managedMkdirCounts = new Map<string, number>()
  replacementPath: string | null = null

  override mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    const result = super.mkdirAt(rootDescriptor, name)
    if (result.status !== 'ok' || !name.startsWith('managed-')) return result
    const count = (this.#managedMkdirCounts.get(name) ?? 0) + 1
    this.#managedMkdirCounts.set(name, count)
    if (count === 2) {
      const path = this.pathAt(rootDescriptor, name)
      renameSync(path, `${path}.created-away`)
      mkdirSync(path, {mode: 0o755})
      chmodSync(path, 0o755)
      this.replacementPath = path
    }
    return result
  }
}

class FailManagedLookupRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  override lookupAt(rootDescriptor: number, name: string): ProjectRootFileLookupResult {
    if (name.startsWith('managed-')) return {status: 'failed'}
    return super.lookupAt(rootDescriptor, name)
  }
}

class PermissiveManagedMkdirRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  readonly #managedRoot: string

  constructor(stateRoot: string, managedRoot: string) {
    super([stateRoot, managedRoot])
    this.#managedRoot = managedRoot
  }

  override mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    const result = super.mkdirAt(rootDescriptor, name)
    if (result.status === 'ok') chmodSync(join(this.#managedRoot, name), 0o755)
    return result
  }
}

class RejectLockMatchRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  rejectedDescriptor: number | null = null

  override matchesAt(
    rootDescriptor: number,
    name: string,
    childDescriptor: number,
  ): ProjectRootFileResult {
    if (name === 'codex-projects-v1.lock') {
      this.rejectedDescriptor = childDescriptor
      return {status: 'mismatch'}
    }
    return super.matchesAt(rootDescriptor, name, childDescriptor)
  }
}

class SwapAroundDescriptorOperationsAuthority extends DescriptorRelativeRootFileAuthority {
  stateRenameSwapped = false
  managedMkdirSwapped = false
  readonly #state: {readonly live: string; readonly away: string; readonly replacement: string}
  readonly #managed: {readonly live: string; readonly away: string; readonly replacement: string}
  readonly #managedIdentity: ProjectFileIdentity

  constructor(options: {
    readonly state: {readonly live: string; readonly away: string; readonly replacement: string}
    readonly managed: {readonly live: string; readonly away: string; readonly replacement: string}
  }) {
    super([options.state.live, options.managed.live])
    this.#state = options.state
    this.#managed = options.managed
    const managed = lstatSync(options.managed.live, {bigint: true})
    this.#managedIdentity = {device: managed.dev, inode: managed.ino}
  }

  override renameAt(rootDescriptor: number, from: string, to: string): ProjectRootFileResult {
    if (this.stateRenameSwapped) return super.renameAt(rootDescriptor, from, to)
    this.stateRenameSwapped = true
    return this.#around(this.#state, () => super.renameAt(rootDescriptor, from, to))
  }

  override mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    const root = fstatSync(rootDescriptor, {bigint: true})
    if (
      this.managedMkdirSwapped
      || root.dev !== this.#managedIdentity.device
      || root.ino !== this.#managedIdentity.inode
    ) return super.mkdirAt(rootDescriptor, name)
    this.managedMkdirSwapped = true
    return this.#around(this.#managed, () => super.mkdirAt(rootDescriptor, name))
  }

  #around<T>(
    paths: {readonly live: string; readonly away: string; readonly replacement: string},
    operation: () => T,
  ): T {
    renameSync(paths.live, paths.away)
    renameSync(paths.replacement, paths.live)
    try {
      return operation()
    } finally {
      renameSync(paths.live, paths.replacement)
      renameSync(paths.away, paths.live)
    }
  }
}

function samePathIdentity(path: string, device: bigint, inode: bigint): boolean {
  try {
    const info = lstatSync(path, {bigint: true})
    return !info.isSymbolicLink() && info.dev === device && info.ino === inode
  } catch {
    return false
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

function rootFilesForTest(stateRoot: string, managedRoot: string): ProjectRootFileAuthority {
  return new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot])
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

class FailNextReleaseLockAuthority extends DescriptorLockAuthority {
  failNextRelease = false

  override acquire(descriptor: number): NativeFileLockResult {
    const acquired = super.acquire(descriptor)
    if (acquired.status !== 'acquired') return acquired
    return {
      status: 'acquired',
      release: async () => {
        await acquired.release()
        if (this.failNextRelease) {
          this.failNextRelease = false
          throw new Error('release sentinel')
        }
      },
    }
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
    'this.#createFileAt(root, tempName, true',
    'await file.sync()',
    'this.#renameAt(root, tempName, PROJECT_STATE_FILE)',
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
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-lock-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const roots = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    const busyClock = new AdvancingClock()
    const contended = await CodexProjectStore.open({...roots, nativeLocks: busy, lockClock: busyClock})
    await assert.rejects(
      contended.snapshot(),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_busy',
    )
    assert.ok(busyClock.sleeps.length > 0, 'ordinary readers use the bounded lock wait')
    await contended.close()

    const transientLocks = new BusyThenDescriptorLockAuthority()
    transientLocks.busyAttempts = 2
    const transientClock = new AdvancingClock()
    const transient = await CodexProjectStore.open({
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
    const root = await mkdtemp(join(tmpdir(), `nova-codex-project-lock-result-${index}-`))
    const stateRoot = join(root, 'state')
    const managedRoot = join(root, 'managed')
    await mkdir(stateRoot, {mode: 0o700})
    await mkdir(managedRoot, {mode: 0o700})
    const store = await CodexProjectStore.open({
      stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
      managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
      nativeLocks: {acquire: () => factory() as NativeFileLockResult},
      rootFiles: rootFilesForTest(stateRoot, managedRoot),
    })
    try {
      await assert.rejects(
        within('malformed native result', store.snapshot(), 200),
        (error: unknown) => error instanceof ProjectStateError
          && error.code === 'state_lock_failed'
          && !String(error).includes('sentinel'),
      )
    } finally {
      await store.close()
      await rm(root, {recursive: true, force: true})
    }
  }
  assert.equal(getterReads, 0)
})

test('missing, unsupported, asynchronous, and malformed root-file authority fails at open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-root-files-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
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
      let unexpected: CodexProjectStore | null = null
      try {
        const options = rootFiles === undefined ? roots : {...roots, rootFiles}
        unexpected = await within(
          'root-file authority open failure',
          CodexProjectStore.open(options),
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
    await rm(root, {recursive: true, force: true})
  }
})

test('state lock and temp creation use only descriptor-relative fixed basenames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-root-create-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspace = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspace, {mode: 0o700})
  const rootFiles = new RecordingRootFileAuthority([stateRoot, managedRoot])
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('malformed descriptor creation fails before native acquire without awaiting host values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-root-create-malformed-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
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
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('a descriptor child mismatch fails before native lock acquisition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-root-match-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  let acquireCalls = 0
  const rootFiles = new RejectLockMatchRootFileAuthority([stateRoot, managedRoot])
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('a newly-created lock must retain its exact descriptor identity before native acquire', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-lock-create-race-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  let acquireCalls = 0
  const rootFiles = new ReplaceCreatedLockRootFileAuthority([stateRoot, managedRoot])
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
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
  const store = await CodexProjectStore.open({
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
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-root-acquire-swap-'))
  const stateRoot = join(root, 'state')
  const retainedRoot = join(root, 'state-retained')
  const replacementRoot = join(root, 'replacement')
  const managedRoot = join(root, 'managed')
  const workspacePath = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(replacementRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
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
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks,
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('live owner acquisition validates the retained state-root identity before open returns', {
  skip: process.platform === 'win32' && 'requires POSIX open-directory rename and symlink semantics',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-owner-root-swap-'))
  const stateRoot = join(root, 'state')
  const retainedRoot = join(root, 'state-retained')
  const replacementRoot = join(root, 'replacement')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(replacementRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
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
      CodexProjectStore.open({
        stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
        managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
        nativeLocks,
        rootFiles: rootFilesForTest(stateRoot, managedRoot),
        live: true,
      }),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
    await assert.rejects(lstat(join(replacementRoot, 'codex-projects-v1.json')), {code: 'ENOENT'})
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('state-root replacement after atomic replace is detected and permanently poisons the store', {
  skip: process.platform === 'win32' && 'requires POSIX open-directory rename and symlink semantics',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-root-commit-swap-'))
  const stateRoot = join(root, 'state')
  const retainedRoot = join(root, 'state-retained')
  const replacementRoot = join(root, 'replacement')
  const managedRoot = join(root, 'managed')
  const workspacePath = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(replacementRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspacePath, {mode: 0o700})
  let swapped = false
  const durability: string[] = []
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('an asynchronous or never-settling native acquire is malformed and fails immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-async-lock-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const never = new Promise<NativeFileLockResult>(() => undefined)
  const nativeLocks = {
    acquire: () => never,
  } as unknown as NativeFileLockAuthority
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks,
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    const thenableStore = await CodexProjectStore.open({
      stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
      managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
      nativeLocks: thenableLocks,
      rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
        version: 1, state_revision: 0, active_binding_revision: 0,
        active_workspace_id: null, workspaces: [], sessions: [],
      })
      await exactLimit.createManaged('migrated')
      const migrated = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
      assert.equal(migrated.active_binding_revision, 1)
      assert.equal(migrated.state_revision, 1)
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
    await rm(root, {recursive: true, force: true})
  }
})

test('state revision increments once per mutation and maintenance snapshots pin managed identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-revision-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const identifiers = ['workspace-0001', 'session-0001'][Symbol.iterator]()
  const rootFiles = new ToggleRemoveTreeRootFileAuthority([stateRoot, managedRoot])
  const storeOptions = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles,
    now: () => 100,
    idFactory: () => identifiers.next().value ?? 'unused-id',
  }
  let store = await CodexProjectStore.open(storeOptions)
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
    store = await CodexProjectStore.open(storeOptions)
    assert.equal((await store.loadManagedMaintenanceJournal())?.operation_id, 'operation-0001')
    rootFiles.failRemoveTree = false
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'clean'})
    assert.equal(await store.loadManagedMaintenanceJournal(), null)
  } finally {
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('all managed originals are detached before any replacement is created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-maintenance-order-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const identifiers = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const rootFiles = new MaintenanceOrderRootFileAuthority([stateRoot, managedRoot])
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('maintenance rename never overwrites a destination raced into the managed root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-maintenance-collision-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const rootFiles = new MaintenanceCollisionRootFileAuthority([stateRoot, managedRoot])
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('managed-root metadata is durable before commit and cleanup journal advancement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-maintenance-durability-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const identifiers = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const rootFiles = new MaintenanceDurabilityRootFileAuthority([stateRoot, managedRoot])
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('managed-root rollback is durable before its journal is cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-maintenance-rollback-durability-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const identifiers = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const rootFiles = new MaintenanceDurabilityRootFileAuthority([stateRoot, managedRoot])
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('a later replacement failure restores every original in the prepared set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-maintenance-rollback-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const identifiers = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const rootFiles = new FailNthMaintenanceMkdirAuthority([stateRoot, managedRoot])
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('a prepared journal rolls back after restart without deleting a populated replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-maintenance-recovery-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const options = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => 'workspace-0001',
  }
  let store = await CodexProjectStore.open(options)
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
    store = await CodexProjectStore.open(options)
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'rollback_pending'})
    assert.equal(await readFile(join(workspace.canonical_path, 'unknown.txt'), 'utf8'), 'do not delete')
    assert.equal(await readFile(join(managedRoot, tombstoneName, 'original.txt'), 'utf8'), 'preserve me')
    await rm(join(workspace.canonical_path, 'unknown.txt'))
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'clean'})
    assert.equal(await readFile(join(workspace.canonical_path, 'original.txt'), 'utf8'), 'preserve me')
    await assert.rejects(readFile(join(stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE)), /ENOENT/u)
  } finally {
    await store.close().catch(() => undefined)
    await rm(root, {recursive: true, force: true})
  }
})

test('prepared recovery never deletes an empty replacement with an unbound identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-maintenance-substitution-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const options = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => 'workspace-0001',
  }
  let store = await CodexProjectStore.open(options)
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
    store = await CodexProjectStore.open(options)
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'rollback_pending'})
    const stillPresent = await lstat(workspace.canonical_path, {bigint: true})
    assert.equal(stillPresent.ino, substitute.ino)
    assert.equal(await readFile(join(managedRoot, tombstoneName, 'original.txt'), 'utf8'), 'preserve me')
  } finally {
    await store.close().catch(() => undefined)
    await rm(root, {recursive: true, force: true})
  }
})

test('replacement crash boundaries recover the operation-owned temporary in either legal position', async t => {
  for (const crashPoint of [
    'replacement_created',
    'replacement_identity_persisted',
    'replacement_placed',
  ] as const) {
    await t.test(crashPoint, async () => {
      const root = await mkdtemp(join(tmpdir(), `nova-codex-project-maintenance-${crashPoint}-`))
      const stateRoot = join(root, 'state')
      const managedRoot = join(root, 'managed')
      await mkdir(stateRoot, {mode: 0o700})
      await mkdir(managedRoot, {mode: 0o700})
      const rootFiles = new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot])
      const baseOptions = {
        stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
        managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
        nativeLocks: new DescriptorLockAuthority(),
        rootFiles,
        idFactory: () => 'workspace-0001',
      }
      const crashOptions = {
        ...baseOptions,
        maintenanceFault: (step: string) => step === crashPoint,
      } as typeof baseOptions & {readonly maintenanceFault: (step: string) => boolean}
      let store = await CodexProjectStore.open(crashOptions)
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

        store = await CodexProjectStore.open(baseOptions)
        assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'clean'})
        assert.equal(await readFile(join(workspace.canonical_path, 'original.txt'), 'utf8'), 'preserve me')
        assert.equal(
          (await readdir(managedRoot)).some(name => name.startsWith('.nova-replacement-')),
          false,
        )
        assert.equal(await store.loadManagedMaintenanceJournal(), null)
      } finally {
        await store.close().catch(() => undefined)
        await rm(root, {recursive: true, force: true})
      }
    })
  }
})

test('crash after tombstone deletion is idempotently completed from the committed journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-maintenance-delete-crash-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const rootFiles = new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot])
  const baseOptions = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles,
    idFactory: () => 'workspace-0001',
  }
  const crashOptions = {
    ...baseOptions,
    maintenanceFault: (step: string) => step === 'cleanup_entry_deleted',
  } as typeof baseOptions & {readonly maintenanceFault: (step: string) => boolean}
  let store = await CodexProjectStore.open(crashOptions)
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

    store = await CodexProjectStore.open(baseOptions)
    assert.deepEqual(await store.cleanupManagedMaintenanceJournal(), {status: 'clean'})
    assert.equal(await store.loadManagedMaintenanceJournal(), null)
    assert.deepEqual(await readdir(workspace.canonical_path), [])
  } finally {
    await store.close().catch(() => undefined)
    await rm(root, {recursive: true, force: true})
  }
})

test('committed cleanup treats an already missing tombstone as completed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-maintenance-missing-cleanup-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('current managed open detects a same-path substitution around the host callback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-open-substitution-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('current maintenance snapshot ignores invalid detached managed records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-current-maintenance-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const identifiers = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('current managed open releases the store transaction before awaiting host completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-open-lock-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await service?.close()
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('a committed journal cannot omit its replacement identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-journal-phase-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('a v2 journal binds each replacement temporary to its exact tombstone entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-journal-replacement-name-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('state roots and files reject special permission bits rather than masking them away', {
  skip: process.platform === 'win32' && 'Windows security is represented by ACLs, not POSIX mode bits',
}, async () => {
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
    await rm(root, {recursive: true, force: true})
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
    const accepted = await CodexProjectStore.open({
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('workspace bindings pin inode identity and managed workspaces retain owner-only mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-inode-binding-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const registered = join(root, 'registered')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(registered, {mode: 0o700})
  const ids = ['workspace-0001', 'workspace-0002'][Symbol.iterator]()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('workspace inode pins are process-local and a restart establishes a fresh portable baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-inode-restart-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const registered = join(root, 'registered')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(registered, {mode: 0o700})
  const options = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
    idFactory: () => 'workspace-0001',
  }
  let first: CodexProjectStore | null = null
  let restarted: CodexProjectStore | null = null
  try {
    first = await CodexProjectStore.open(options)
    const imported = await first.ensureImported(
      'registered',
      hostWorkspaceForTest(await realpath(registered)),
    )
    await first.close()
    first = null
    await rename(registered, join(root, 'registered-original'))
    await mkdir(registered, {mode: 0o700})

    restarted = await CodexProjectStore.open(options)
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
    await first?.close()
    await restarted?.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('ensureImported preserves the stronger managed workspace binding for an existing record', {
  skip: process.platform === 'win32' && 'this test mutates POSIX mode bits; Windows ACLs are native-tested',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-managed-import-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('managed mkdir returns the rollback identity without a second path lookup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-managed-create-identity-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: new FailManagedLookupRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => 'workspace-0001',
  })
  try {
    const created = await store.createManaged('managed')
    assert.equal((await lstat(created.canonical_path)).isDirectory(), true)
    assert.equal(await store.rollbackManagedCreate(created.workspace_id), true)
  } finally {
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('managed rollback refuses an empty same-path inode replacement and retains state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-rollback-inode-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('a committed create keeps its inode pin when only native release fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-commit-release-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const nativeLocks = new FailNextReleaseLockAuthority()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks,
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('successful managed rollback clears the exact pin so an absent ID can be reused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-rollback-pin-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
    idFactory: () => 'workspace-0001',
  })
  try {
    const first = await store.createManaged('first')
    assert.equal(await store.rollbackManagedCreate(first.workspace_id), true)
    const second = await store.createManaged('second')
    assert.equal(second.workspace_id, first.workspace_id)
  } finally {
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('a pre-commit rollback failure restores a safe managed child and advances its pin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-rollback-restore-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const rootFiles = new ToggleTempCreateRootFileAuthority([stateRoot, managedRoot])
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('rollback restore rejects an immediate mkdir replacement before chmod or pin advance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-rollback-restore-race-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const rootFiles = new ReplaceManagedRestoreAfterMkdirRootFileAuthority([
    stateRoot,
    managedRoot,
  ])
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
  const ids = ['prefix-one-123456789012', 'prefix-two-123456789012'][Symbol.iterator]()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('ID allocation never overwrites either namespace and has a fixed collision bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-id-collision-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  let calls = 0
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
      store.beginSession(first.workspace_id, null),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'id_factory_invalid',
    )
    assert.equal(calls - callsAfterFirst, 64)
    assert.deepEqual(await store.listSessions(first.workspace_id), [])
  } finally {
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('failed registered creation clears only its new pin so the exact ID can be reused', async () => {
  for (const method of ['ensureImported', 'registerWorkspace'] as const) {
    const root = await mkdtemp(join(tmpdir(), `nova-codex-project-${method}-pin-`))
    const stateRoot = join(root, 'state')
    const managedRoot = join(root, 'managed')
    const workspace = join(root, 'workspace')
    await mkdir(stateRoot, {mode: 0o700})
    await mkdir(managedRoot, {mode: 0o700})
    await mkdir(workspace, {mode: 0o700})
    const rootFiles = new ToggleTempCreateRootFileAuthority([stateRoot, managedRoot])
    const store = await CodexProjectStore.open({
      stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
      managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
      nativeLocks: new DescriptorLockAuthority(),
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
      await store.close()
      await rm(root, {recursive: true, force: true})
    }
  }
})

test('a committed registered workspace keeps its exact pin when release fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-register-commit-pin-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspace = join(root, 'workspace')
  const original = join(root, 'workspace-original')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspace, {mode: 0o700})
  const nativeLocks = new FailNextReleaseLockAuthority()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks,
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('managed creation repairs a restrictive umask and leaves no rollback residue', {
  concurrency: false,
  skip: process.platform === 'win32' && 'Windows directory privacy is ACL-based, not umask-based',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-umask-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('managed creation repairs a permissive native mkdir before it can become public', {
  skip: process.platform === 'win32' && 'Windows directory privacy is ACL-based, not mode-based',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-mkdir-mode-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: new PermissiveManagedMkdirRootFileAuthority(stateRoot, managedRoot),
    idFactory: () => 'workspace-0001',
  })
  try {
    const created = await store.createManaged('managed')
    assert.equal((await lstat(created.canonical_path)).mode & 0o7777, 0o700)
  } finally {
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('managed creation rolls back an empty child when the subsequent state save fails', {concurrency: false}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-save-rollback-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('an uncommitted poisoned state root cannot strand an empty managed child', {
  skip: process.platform === 'win32' && 'requires POSIX open-directory rename and symlink semantics',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-poison-rollback-'))
  const stateRoot = join(root, 'state')
  const retainedState = join(root, 'state-retained')
  const replacementState = join(root, 'state-replacement')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(replacementState, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  let swapped = false
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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

test('Windows first save completes without POSIX directory fsync', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-windows-save-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspacePath = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspacePath, {mode: 0o700})
  const durability: string[] = []
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    await store.close()
    await rm(root, {recursive: true, force: true})
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
    now: () => 100,
    idFactory: () => identifiers.next().value ?? 'unused-id',
    onDurabilityStep: (step: 'temp_open' | 'file_fsync' | 'atomic_replace' | 'dir_fsync' | 'windows_metadata_commit') => {
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
      'temp_open', 'file_fsync', 'atomic_replace',
      process.platform === 'win32' ? 'windows_metadata_commit' : 'dir_fsync',
    ])
    assert.deepEqual(await first.publicView(true), {
      workspace_display_name: 'Alpha',
      session_title: '登录修复',
      pending_confirmation: true,
      pending_confirmation_busy: false,
    })
    await first.close()
    first = null

    second = await CodexProjectStore.open(options)
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
    assert.equal(state.version, 1)
    assert.equal(
      state.active_binding_revision,
      (snapshot as unknown as {active_binding_revision: number}).active_binding_revision,
    )
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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

test('opening the live project store migrates legacy codex-workspaces to codex-homes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-home-migration-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const canonicalStateRoot = await realpath(stateRoot)
  const legacyRoot = join(canonicalStateRoot, 'codex-workspaces')
  const legacyHome = join(legacyRoot, 'home-workspace-0001')
  await mkdir(legacyRoot, {mode: 0o700})
  await mkdir(legacyHome, {mode: 0o700})
  await writeFile(join(legacyHome, 'migration-marker'), 'preserved', {mode: 0o600})
  const store = await CodexProjectStore.open({
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
    await store.close()
    await rm(root, {recursive: true, force: true})
  }
})

test('a rejected legacy home migration releases the live owner lock for retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-home-migration-retry-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const legacyRoot = join(stateRoot, 'codex-workspaces')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(legacyRoot, {mode: 0o755})
  await chmod(legacyRoot, 0o755)
  const nativeLocks = new DescriptorLockAuthority()
  const options = {
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks,
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
    live: true,
  }
  try {
    await assert.rejects(
      CodexProjectStore.open(options),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
    await chmod(legacyRoot, 0o700)
    const retried = await CodexProjectStore.open(options)
    await retried.close()
    assert.equal((await lstat(join(stateRoot, 'codex-homes'))).isDirectory(), true)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('persistent home rejects an immediate mkdir replacement before chmod or adoption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-home-race-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const rootFiles = new ReplaceHomeAfterMkdirRootFileAuthority([stateRoot, managedRoot])
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
    rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
      rootFiles: rootFilesForTest(stateRoot, managedRoot),
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
