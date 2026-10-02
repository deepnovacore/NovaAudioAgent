
import {chmodSync, fstatSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs'
import {mkdir, mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {type Clock} from '../src/core/clock.js'
import {ProjectStore, PROJECT_MAINTENANCE_JOURNAL_FILE, hostManagedProjectRootForTest, hostProjectRootForTest} from '../src/projects/project-store.js'

import {type NativeFileLockAuthority, type NativeFileLockResult} from '../src/storage/native-file-lock.js'
import type {ProjectFileIdentity, ProjectRootFileAuthority, ProjectRootFileCreateResult, ProjectRootFileLookupResult, ProjectRootFileResult} from '../src/projects/project-root-file.js'

export async function projectStoreFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  const options = async (overrides: Partial<Parameters<typeof ProjectStore.open>[0]> = {}) => ({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    ...(Object.hasOwn(overrides, 'rootFiles') ? {} : {rootFiles: rootFilesForTest(stateRoot, managedRoot)}),
    ...overrides,
  })
  return {
    root, stateRoot, managedRoot, options,
    open: async (overrides?: Partial<Parameters<typeof ProjectStore.open>[0]>) =>
      await ProjectStore.open(await options(overrides)),
    async close(...stores: readonly ({close(): Promise<void>} | null | undefined)[]): Promise<void> {
      for (const store of stores) await store?.close()
      await rm(root, {recursive: true, force: true})
    },
  }
}

export async function within<T>(name: string, work: Promise<T>, milliseconds = 2_000): Promise<T> {
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

export class DescriptorLockAuthority implements NativeFileLockAuthority {
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
export class DescriptorRelativeRootFileAuthority implements ProjectRootFileAuthority {
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

export class ToggleRemoveTreeRootFileAuthority extends DescriptorRelativeRootFileAuthority {
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

export class MaintenanceOrderRootFileAuthority extends DescriptorRelativeRootFileAuthority {
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

export class MaintenanceCollisionRootFileAuthority extends DescriptorRelativeRootFileAuthority {
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

export class MaintenanceDurabilityRootFileAuthority extends DescriptorRelativeRootFileAuthority {
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

export class FailNthMaintenanceMkdirAuthority extends DescriptorRelativeRootFileAuthority {
  enabled = false
  calls = 0

  override mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    if (this.enabled && ++this.calls === 2) return {status: 'failed'}
    return super.mkdirAt(rootDescriptor, name)
  }
}

export class ReplaceCreatedLockRootFileAuthority extends DescriptorRelativeRootFileAuthority {
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

export class ReplaceHomeAfterMkdirRootFileAuthority extends DescriptorRelativeRootFileAuthority {
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

export class RecordingRootFileAuthority extends DescriptorRelativeRootFileAuthority {
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

export class FailTempCreateRootFileAuthority extends DescriptorRelativeRootFileAuthority {
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

export class ToggleTempCreateRootFileAuthority extends DescriptorRelativeRootFileAuthority {
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

export class ReplaceManagedRestoreAfterMkdirRootFileAuthority
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

export class FailManagedLookupRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  override lookupAt(rootDescriptor: number, name: string): ProjectRootFileLookupResult {
    if (name.startsWith('managed-') && name !== PROJECT_MAINTENANCE_JOURNAL_FILE) return {status: 'failed'}
    return super.lookupAt(rootDescriptor, name)
  }
}

export class ExternalCleanupMkdirCollisionAuthority extends DescriptorRelativeRootFileAuthority {
  targetName: string | null = null
  collisionIdentity: ProjectFileIdentity | null = null

  override mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    if (name === this.targetName) {
      const path = this.pathAt(rootDescriptor, name)
      mkdirSync(path, {mode: 0o700})
      const info = lstatSync(path, {bigint: true})
      this.collisionIdentity = {device: info.dev, inode: info.ino}
      this.targetName = null
    }
    return super.mkdirAt(rootDescriptor, name)
  }
}

export class PermissiveManagedMkdirRootFileAuthority extends DescriptorRelativeRootFileAuthority {
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

export class RejectLockMatchRootFileAuthority extends DescriptorRelativeRootFileAuthority {
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

export class SwapAroundDescriptorOperationsAuthority extends DescriptorRelativeRootFileAuthority {
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

export function samePathIdentity(path: string, device: bigint, inode: bigint): boolean {
  try {
    const info = lstatSync(path, {bigint: true})
    return !info.isSymbolicLink() && info.dev === device && info.ino === inode
  } catch {
    return false
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

export function rootFilesForTest(stateRoot: string, managedRoot: string): ProjectRootFileAuthority {
  return new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot])
}

export class CountingProtectRootFileAuthority extends DescriptorRelativeRootFileAuthority {
  protectCalls = 0

  override protectAt(
    rootDescriptor: number,
    name: string,
    childDescriptor: number,
  ): ProjectRootFileResult {
    this.protectCalls += 1
    return super.protectAt(rootDescriptor, name, childDescriptor)
  }
}

export class DeferredReleaseLockAuthority extends DescriptorLockAuthority {
  acquireCalls = 0
  releaseNow: (() => void) | null = null
  #deferNextRelease = false
  #releaseStarted: (() => void) | null = null

  deferNextRelease(): Promise<void> {
    this.#deferNextRelease = true
    return new Promise<void>(resolveStarted => { this.#releaseStarted = resolveStarted })
  }

  override acquire(descriptor: number): NativeFileLockResult {
    this.acquireCalls += 1
    const acquired = super.acquire(descriptor)
    if (acquired.status !== 'acquired') return acquired
    return {
      status: 'acquired',
      release: async () => {
        if (this.#deferNextRelease) {
          this.#deferNextRelease = false
          this.#releaseStarted?.()
          this.#releaseStarted = null
          await new Promise<void>(resolveRelease => { this.releaseNow = resolveRelease })
          this.releaseNow = null
        }
        await acquired.release()
      },
    }
  }
}

export class BusyThenDescriptorLockAuthority implements NativeFileLockAuthority {
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

export class FailNextReleaseLockAuthority extends DescriptorLockAuthority {
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

export class AdvancingClock implements Clock {
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

