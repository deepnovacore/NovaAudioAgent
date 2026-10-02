import {randomUUID} from 'node:crypto'
import {addAbortListener} from 'node:events'
import {constants, lstatSync, realpathSync, type Stats} from 'node:fs'
import {open, type FileHandle} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import {TextDecoder} from 'node:util'
import {RealClock, type Clock} from '../core/clock.js'
import {type NativeFileLockAuthority, type NativeFileLockResult} from '../storage/native-file-lock.js'
import {canonicalJsonWithNumberFormatter} from '../text/canonical-json.js'
import {isWellFormed} from '../text/python-text.js'
import {
  unsupportedProjectRootFiles,
  type ProjectFileIdentity,
  type ProjectRootFileAuthority,
  type ProjectRootFileCreateResult,
  type ProjectRootFileLookupResult,
  type ProjectRootFileResult,
} from './project-root-file.js'
import {
  bumpStateRevision,
  decodeMaintenanceJournal,
  decodeState,
  emptyState,
  encodeMaintenanceJournal,
  encodeState,
  ProjectStateError,
  projectTimestampNumber,
  requireProjectBasename,
  validateState,
  type ManagedMaintenanceJournal,
  type MutableProjectState,
  type ProjectStateCode,
} from './project-state.js'

export const PROJECT_STATE_FILE = 'codex-projects-v1.json'
export const PROJECT_PRE_ACP_BACKUP_FILE = 'codex-projects-v1.pre-acp.json'
export const PROJECT_TRANSACTION_LOCK_FILE = 'codex-projects-v1.lock'
export const PROJECT_OWNER_LOCK_FILE = 'codex-projects-v1.owner.lock'
export const PROJECT_MAINTENANCE_JOURNAL_FILE = 'managed-workspace-maintenance-v1.json'
export const PROJECT_CODEX_HOMES_DIRECTORY = 'codex-homes'
export const LEGACY_PROJECT_CODEX_HOMES_DIRECTORY = 'codex-workspaces'
export const MAX_PROJECT_STATE_BYTES = 1024 * 1024
const PROJECT_LOCK_WAIT_SECONDS = 2
const PROJECT_LOCK_RETRY_SECONDS = 0.025
const MAX_MAINTENANCE_JOURNAL_BYTES = 64 * 1024

class TransactionProjectStateError extends ProjectStateError {
  constructor(code: ProjectStateCode, readonly committed: boolean) {
    super(code)
  }
}

export type MaintenanceFaultStep =
  | 'replacement_created'
  | 'replacement_identity_persisted'
  | 'replacement_placed'
  | 'cleanup_entry_deleted'

const hostProjectRootBrand: unique symbol = Symbol('HostProjectRoot')

export interface HostProjectRoot { readonly [hostProjectRootBrand]: true }

const rootValues = new WeakMap<HostProjectRoot, string>()
const hostManagedProjectRootBrand: unique symbol = Symbol('HostManagedProjectRoot')

export interface HostManagedProjectRoot { readonly [hostManagedProjectRootBrand]: true }

const managedRootValues = new WeakMap<HostManagedProjectRoot, string>()

type DurabilityStep =
  | 'temp_open'
  | 'file_fsync'
  | 'atomic_replace'
  | 'dir_fsync'
  | 'windows_metadata_commit'

export interface ProjectStoreOptions {
  readonly stateRoot: HostProjectRoot
  readonly managedRoot: HostManagedProjectRoot
  readonly nativeLocks: NativeFileLockAuthority
  readonly rootFiles?: ProjectRootFileAuthority
  readonly now?: () => number
  readonly idFactory?: () => string
  readonly live?: boolean
  readonly lockClock?: Clock
  readonly onDurabilityStep?: (step: DurabilityStep) => void
  /** Deterministic crash-transition seam used only by transaction tests. */
  readonly maintenanceFault?: (step: MaintenanceFaultStep) => boolean
  /** Host-only seam: Windows security is enforced by the native handle authority. */
  readonly platform?: NodeJS.Platform
}

export interface ProjectTransactionWaitOptions {
  readonly wait: true
  readonly signal?: AbortSignal
}

export interface HeldLock {
  readonly file: FileHandle
  readonly release: () => void | Promise<void>
}

export type FileIdentity = ProjectFileIdentity

export interface DirectoryBinding {
  readonly canonical: string
  readonly identity: FileIdentity
}

interface StateRootIdentity extends FileIdentity {
  readonly canonical: string
  readonly owner: bigint
  readonly mode: bigint
}

type TransactionResult<T> = readonly [value: T, changed: boolean]

export function hostProjectRootFromConfig(configured: string): HostProjectRoot {
  return brandProjectRoot(requireProjectRoot(configured, 'state_permissions', process.platform))
}

/** Test-only constructor; it enforces the same canonical owner-only directory contract. */
export function hostProjectRootForTest(
  configured: string,
  platform: NodeJS.Platform = process.platform,
): HostProjectRoot {
  return brandProjectRoot(requireProjectRoot(configured, 'state_permissions', platform))
}

export function hostManagedProjectRootFromConfig(configured: string): HostManagedProjectRoot {
  return brandManagedProjectRoot(requireManagedProjectRoot(configured, process.platform))
}

/** Test-only constructor; it enforces the same canonical owner-controlled directory contract. */
export function hostManagedProjectRootForTest(
  configured: string,
  platform: NodeJS.Platform = process.platform,
): HostManagedProjectRoot {
  return brandManagedProjectRoot(requireManagedProjectRoot(configured, platform))
}

/** Owns retained root handles, locks, transactions and durable state/journal writes. */
export class ProjectStoreFiles {
  readonly #stateRoot: string
  readonly #managedRoot: string
  readonly #nativeLocks: NativeFileLockAuthority
  readonly #rootFiles: ProjectRootFileAuthority
  readonly #recoverStarting: boolean
  readonly #lockClock: Clock
  readonly #onDurabilityStep: ((step: DurabilityStep) => void) | undefined
  readonly #platform: NodeJS.Platform
  readonly #activeTransactions = new Set<Promise<void>>()
  readonly #closeAbort = new AbortController()
  #stateRootHandle: FileHandle | null = null
  #stateRootIdentity: StateRootIdentity | null = null
  #managedRootHandle: FileHandle | null = null
  #managedRootIdentity: FileIdentity | null = null
  #managedRootPoisoned = false
  #stateRootPoisoned = false
  #startupLoaded = false
  #closed = false
  #ownerLock: HeldLock | null = null
  #closePromise: Promise<void> | null = null

  constructor(options: ProjectStoreOptions) {
    this.#stateRoot = projectRootPath(options.stateRoot)
    this.#managedRoot = managedProjectRootPath(options.managedRoot)
    this.#nativeLocks = options.nativeLocks
    this.#rootFiles = options.rootFiles ?? unsupportedProjectRootFiles
    this.#recoverStarting = options.live === true
    this.#lockClock = options.lockClock ?? new RealClock()
    this.#onDurabilityStep = options.onDurabilityStep
    this.#platform = options.platform ?? process.platform
  }

  async open(): Promise<void> {
    await this.#retainStateRoot()
    await this.#retainManagedRoot()
    this.#probeRootFileAuthority()
    if (this.#recoverStarting) {
      this.#ownerLock = await this.openAndAcquireLock(PROJECT_OWNER_LOCK_FILE)
      await this.revalidateStateRoot()
      await this.migrateLegacyHomes(this.requireStateRootHandle())
    }
  }

  async disposeFailedOpen(): Promise<void> {
    const owner = this.#ownerLock
    this.#ownerLock = null
    if (owner !== null) {
      await Promise.resolve(owner.release()).catch(() => undefined)
      await owner.file.close().catch(() => undefined)
    }
    if (this.#stateRootHandle) this.#rootFiles.unbindDirectory?.(this.#stateRootHandle.fd)
    await this.#stateRootHandle?.close().catch(() => undefined)
    if (this.#managedRootHandle) this.#rootFiles.unbindDirectory?.(this.#managedRootHandle.fd)
    await this.#managedRootHandle?.close().catch(() => undefined)
    this.#stateRootHandle = null
    this.#stateRootIdentity = null
    this.#managedRootHandle = null
    this.#managedRootIdentity = null
  }

  get stateRoot(): string { return this.#stateRoot }

  get platform(): NodeJS.Platform { return this.#platform }

  get hasOwnerLock(): boolean { return this.#ownerLock !== null }

  removeManagedTree(root: FileHandle, name: string, identity: FileIdentity): ProjectRootFileResult {
    return this.#callRootFile(() => this.#rootFiles.removeTreeAt(root.fd, name, identity))
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    this.#closed = true
    this.#closeAbort.abort()
    const active = [...this.#activeTransactions]
    this.#closePromise = this.#finishClose(active)
    return this.#closePromise
  }

  async #finishClose(active: readonly Promise<void>[]): Promise<void> {
    await Promise.all(active)
    const owner = this.#ownerLock
    this.#ownerLock = null
    let failed = false
    if (owner !== null) {
      try {
        await owner.release()
      } catch {
        failed = true
      }
      await owner.file.close().catch(() => { failed = true })
    }
    const root = this.#stateRootHandle
    const managedRoot = this.#managedRootHandle
    this.#stateRootHandle = null
    this.#stateRootIdentity = null
    this.#managedRootHandle = null
    this.#managedRootIdentity = null
    if (root) this.#rootFiles.unbindDirectory?.(root.fd)
    await root?.close().catch(() => { failed = true })
    if (managedRoot) this.#rootFiles.unbindDirectory?.(managedRoot.fd)
    await managedRoot?.close().catch(() => { failed = true })
    if (failed) throw new ProjectStateError('state_lock_failed')
  }

  async validateManagedWorkspaceBinding(
    path: string,
    refreshAcl = false,
  ): Promise<DirectoryBinding> {
    const managed = await this.validateManagedRoot()
    if (!isDirectChild(managed, path)) {
      throw new ProjectStateError('workspace_boundary_changed')
    }
    const root = this.requireManagedRootHandle()
    let file: FileHandle | null = null
    try {
      file = await open(path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
      this.#requireWorkspaceMatchesAt(root, basename(path), file, 'workspace_boundary_changed')
      if (refreshAcl) {
        this.protectAt(root, basename(path), file, 'workspace_boundary_changed')
        this.#requireWorkspaceMatchesAt(root, basename(path), file, 'workspace_boundary_changed')
      }
      const info = await file.stat({bigint: true})
      const canonical = realpathSync(path)
      if (
        !info.isDirectory()
        || canonical !== path
        || !privateDirectoryMetadata(info, this.#platform)
        || !isDirectChild(managed, canonical)
      ) throw new Error('unsafe')
      await this.validateManagedRoot()
      this.#requireWorkspaceMatchesAt(root, basename(path), file, 'workspace_boundary_changed')
      return {canonical, identity: fileIdentity(info)}
    } catch {
      throw new ProjectStateError('workspace_boundary_changed')
    } finally {
      await file?.close().catch(() => undefined)
    }
  }

  async transaction<T>(
    operation: (
      state: MutableProjectState,
    ) => TransactionResult<T> | Promise<TransactionResult<T>>,
    options?: ProjectTransactionWaitOptions,
  ): Promise<T> {
    if (this.#closed) throw new ProjectStateError('state_lock_failed')
    const predecessors = [...this.#activeTransactions]
    let complete!: () => void
    const ownership = new Promise<void>(resolveOwnership => { complete = resolveOwnership })
    this.#activeTransactions.add(ownership)
    try {
      await waitForTransactions(predecessors, options?.signal, this.#closeAbort.signal)
      if (this.#closed) throw new ProjectStateError('state_lock_failed')
      await this.revalidateStateRoot()
      const mayRecover = this.#recoverStarting && !this.#startupLoaded
      const held = await this.openAndAcquireLock(
        PROJECT_TRANSACTION_LOCK_FILE,
        options?.wait === true || mayRecover,
        options?.signal,
      )
      let releaseFailure = false
      let committed = false
      try {
        await this.revalidateStateRoot()
        const shouldRecover = this.#recoverStarting && !this.#startupLoaded
        const [state, recovered] = await this.#loadState(shouldRecover)
        const [value, changed] = await operation(state)
        if (recovered || changed) bumpStateRevision(state)
        validateState(state)
        if (recovered || changed) {
          await this.#saveState(state, () => { committed = true })
        }
        await this.revalidateStateRoot()
        this.#startupLoaded = true
        return value
      } catch (error) {
        if (committed && error instanceof ProjectStateError) {
          throw new TransactionProjectStateError(error.code, true)
        }
        throw error
      } finally {
        try {
          await held.release()
        } catch {
          releaseFailure = true
        }
        await held.file.close().catch(() => { releaseFailure = true })
        if (releaseFailure) {
          throw new TransactionProjectStateError('state_lock_failed', committed)
        }
      }
    } finally {
      this.#activeTransactions.delete(ownership)
      complete()
    }
  }

  async #retainStateRoot(): Promise<void> {
    const retained = await openStateRoot(this.#stateRoot, this.#platform)
    this.#stateRootHandle = retained.file
    this.#stateRootIdentity = retained.identity
    this.#rootFiles.bindDirectory?.(retained.file.fd, this.#stateRoot)
  }

  async #retainManagedRoot(): Promise<void> {
    const retained = await openManagedRoot(this.#managedRoot, this.#platform)
    this.#managedRootHandle = retained.file
    this.#managedRootIdentity = retained.identity
    this.#rootFiles.bindDirectory?.(retained.file.fd, this.#managedRoot)
  }

  #probeRootFileAuthority(): void {
    const stateRoot = this.requireStateRootHandle()
    const managedRoot = this.requireManagedRootHandle()
    if (
      this.#callRootFile(() => this.#rootFiles.probe(stateRoot.fd)).status !== 'ok'
      || this.#callRootFile(() => this.#rootFiles.probe(managedRoot.fd)).status !== 'ok'
    ) throw new ProjectStateError('state_permissions')
  }

  async revalidateStateRoot(): Promise<void> {
    if (this.#stateRootPoisoned) throw new ProjectStateError('state_permissions')
    const retained = this.#stateRootHandle
    const expected = this.#stateRootIdentity
    if (retained === null || expected === null) {
      this.#stateRootPoisoned = true
      throw new ProjectStateError('state_permissions')
    }
    let current: FileHandle | null = null
    try {
      const retainedInfo = await retained.stat({bigint: true})
      if (!stateRootMatches(retainedInfo, expected, this.#platform)) throw new Error('retained root changed')
      current = await open(
        this.#stateRoot,
        constants.O_RDONLY | directoryFlag() | noFollowFlag(),
      )
      const currentInfo = await current.stat({bigint: true})
      const canonical = realpathSync(this.#stateRoot)
      if (!stateRootMatches(currentInfo, expected, this.#platform) || canonical !== expected.canonical) {
        throw new Error('state root identity changed')
      }
    } catch {
      this.#stateRootPoisoned = true
      throw new ProjectStateError('state_permissions')
    } finally {
      await current?.close().catch(() => undefined)
    }
  }

  async validateManagedRoot(): Promise<string> {
    if (this.#managedRootPoisoned) throw new ProjectStateError('managed_root_unsafe')
    const retained = this.#managedRootHandle
    const expected = this.#managedRootIdentity
    if (retained === null || expected === null) {
      this.#managedRootPoisoned = true
      throw new ProjectStateError('managed_root_unsafe')
    }
    let current: FileHandle | null = null
    try {
      const retainedInfo = await retained.stat({bigint: true})
      if (
        !retainedInfo.isDirectory()
        || !managedDirectoryMetadata(retainedInfo, this.#platform)
        || !sameFileIdentity(expected, fileIdentity(retainedInfo))
      ) throw new Error('retained managed root changed')
      current = await open(
        this.#managedRoot,
        constants.O_RDONLY | directoryFlag() | noFollowFlag(),
      )
      const currentInfo = await current.stat({bigint: true})
      const canonical = realpathSync(this.#managedRoot)
      if (
        canonical !== this.#managedRoot
        || !currentInfo.isDirectory()
        || !managedDirectoryMetadata(currentInfo, this.#platform)
        || !sameFileIdentity(expected, fileIdentity(currentInfo))
      ) throw new Error('managed root identity changed')
      return canonical
    } catch {
      this.#managedRootPoisoned = true
      throw new ProjectStateError('managed_root_unsafe')
    } finally {
      await current?.close().catch(() => undefined)
    }
  }

  requireStateRootHandle(): FileHandle {
    if (this.#stateRootHandle === null) throw new ProjectStateError('state_permissions')
    return this.#stateRootHandle
  }

  requireManagedRootHandle(): FileHandle {
    if (this.#managedRootHandle === null) throw new ProjectStateError('managed_root_unsafe')
    return this.#managedRootHandle
  }

  #callRootFile(operation: () => unknown): ProjectRootFileResult {
    try {
      const result = operation()
      return validProjectRootFileResult(result) ? result : {status: 'failed'}
    } catch {
      return {status: 'failed'}
    }
  }

  #callRootFileLookup(operation: () => unknown): ProjectRootFileLookupResult {
    try {
      const result = operation()
      return validProjectRootFileLookupResult(result) ? result : {status: 'failed'}
    } catch {
      return {status: 'failed'}
    }
  }

  #callRootFileCreate(operation: () => unknown): ProjectRootFileCreateResult {
    try {
      const result = operation()
      return validProjectRootFileCreateResult(result) ? result : {status: 'failed'}
    } catch {
      return {status: 'failed'}
    }
  }

  requireMatchesAt(
    root: FileHandle,
    name: string,
    child: FileHandle,
    code: ProjectStateCode,
  ): void {
    requireProjectBasename(name, code)
    const result = this.#callRootFile(() => this.#rootFiles.matchesAt(root.fd, name, child.fd))
    if (result.status !== 'ok') throw new ProjectStateError(code)
  }

  #requireWorkspaceMatchesAt(
    root: FileHandle,
    name: string,
    child: FileHandle,
    code: ProjectStateCode,
  ): void {
    requireProjectBasename(name, code)
    const result = this.#callRootFile(() => (
      this.#rootFiles.matchesWorkspaceAt?.(root.fd, name, child.fd)
      ?? this.#rootFiles.matchesAt(root.fd, name, child.fd)
    ))
    if (result.status !== 'ok') throw new ProjectStateError(code)
  }

  lookupAt(
    root: FileHandle,
    name: string,
    code: ProjectStateCode,
  ): ProjectRootFileLookupResult {
    requireProjectBasename(name, code)
    const result = this.#callRootFileLookup(() => this.#rootFiles.lookupAt(root.fd, name))
    if (result.status === 'unsupported' || result.status === 'failed') {
      throw new ProjectStateError(code)
    }
    return result
  }

  lookupWorkspaceAt(
    root: FileHandle,
    name: string,
    code: ProjectStateCode,
  ): ProjectRootFileLookupResult {
    requireProjectBasename(name, code)
    const result = this.#callRootFileLookup(() => (
      this.#rootFiles.lookupWorkspaceAt?.(root.fd, name)
      ?? this.#rootFiles.lookupAt(root.fd, name)
    ))
    if (result.status === 'unsupported' || result.status === 'failed') {
      throw new ProjectStateError(code)
    }
    return result
  }

  #mkdirAt(root: FileHandle, name: string, code: ProjectStateCode): ProjectRootFileCreateResult {
    requireProjectBasename(name, code)
    const result = this.#callRootFileCreate(() => this.#rootFiles.mkdirAt(root.fd, name))
    if (result.status === 'unsupported' || result.status === 'failed') {
      throw new ProjectStateError(code)
    }
    return result
  }

  mkdirPrivateAt(
    root: FileHandle,
    name: string,
    code: ProjectStateCode,
  ): ProjectRootFileCreateResult {
    if (this.#platform !== 'win32') return this.#mkdirAt(root, name, code)
    requireProjectBasename(name, code)
    const result = this.#callRootFileCreate(
      () => this.#rootFiles.mkdirPrivateAt?.(root.fd, name) ?? {status: 'unsupported'},
    )
    if (result.status === 'unsupported' || result.status === 'failed') {
      throw new ProjectStateError(code)
    }
    return result
  }

  protectAt(root: FileHandle, name: string, child: FileHandle, code: ProjectStateCode): void {
    if (this.#platform !== 'win32') return
    requireProjectBasename(name, code)
    const result = this.#callRootFile(
      () => this.#rootFiles.protectAt?.(root.fd, name, child.fd) ?? {status: 'unsupported'},
    )
    if (result.status !== 'ok') throw new ProjectStateError(code)
  }

  #createFileAt(
    root: FileHandle,
    name: string,
    exclusive: boolean,
    code: ProjectStateCode,
  ): ProjectRootFileCreateResult {
    requireProjectBasename(name, code)
    const result = this.#callRootFileCreate(
      () => this.#rootFiles.createFileAt(root.fd, name, exclusive),
    )
    if (
      result.status === 'unsupported'
      || result.status === 'failed'
    ) throw new ProjectStateError(code)
    if (exclusive && result.status !== 'ok') throw new ProjectStateError(code)
    if (!exclusive && result.status !== 'ok' && result.status !== 'exists') {
      throw new ProjectStateError(code)
    }
    return result
  }

  #renameAt(root: FileHandle, from: string, to: string): void {
    requireProjectBasename(from, 'state_write_failed')
    requireProjectBasename(to, 'state_write_failed')
    const result = this.#callRootFile(() => this.#rootFiles.renameAt(root.fd, from, to))
    if (result.status !== 'ok') throw new ProjectStateError('state_write_failed')
  }

  renameManagedNoReplace(
    root: FileHandle,
    from: string,
    to: string,
    expected: FileIdentity,
  ): ProjectRootFileResult {
    requireProjectBasename(from, 'workspace_boundary_changed')
    requireProjectBasename(to, 'workspace_boundary_changed')
    const result = this.#callRootFile(
      () => this.#rootFiles.renameNoReplaceAt?.(root.fd, from, to, expected)
        ?? {status: 'unsupported'},
    )
    if (result.status === 'unsupported' || result.status === 'failed') {
      throw new ProjectStateError('workspace_boundary_changed')
    }
    return result
  }

  async syncManagedRoot(): Promise<void> {
    await this.validateManagedRoot()
    const root = this.requireManagedRootHandle()
    const result = this.#callRootFile(
      () => this.#rootFiles.syncDirectory?.(root.fd) ?? {status: 'unsupported'},
    )
    if (result.status !== 'ok') throw new ProjectStateError('workspace_boundary_changed')
    await this.validateManagedRoot()
  }

  async migrateLegacyHomes(root: FileHandle): Promise<void> {
    const current = this.lookupAt(root, PROJECT_CODEX_HOMES_DIRECTORY, 'state_permissions')
    if (current.status === 'ok') return
    if (current.status !== 'missing') throw new ProjectStateError('state_permissions')
    const legacy = this.lookupAt(
      root,
      LEGACY_PROJECT_CODEX_HOMES_DIRECTORY,
      'state_permissions',
    )
    if (legacy.status === 'missing') return
    if (legacy.status !== 'ok') throw new ProjectStateError('state_permissions')

    let legacyDirectory: {readonly file: FileHandle; readonly binding: DirectoryBinding} | null = null
    try {
      legacyDirectory = await this.ensurePrivateDirectoryAt(
        root,
        this.#stateRoot,
        LEGACY_PROJECT_CODEX_HOMES_DIRECTORY,
      )
      if (!sameFileIdentity(legacy.identity, legacyDirectory.binding.identity)) {
        throw new ProjectStateError('state_permissions')
      }
      const currentAgain = this.lookupAt(
        root,
        PROJECT_CODEX_HOMES_DIRECTORY,
        'state_permissions',
      )
      if (currentAgain.status === 'ok') return
      if (currentAgain.status !== 'missing') throw new ProjectStateError('state_permissions')
      await this.revalidateStateRoot()
      this.requireMatchesAt(
        root,
        LEGACY_PROJECT_CODEX_HOMES_DIRECTORY,
        legacyDirectory.file,
        'state_permissions',
      )
      const renamed = this.#callRootFile(() => this.#rootFiles.renameAt(
        root.fd,
        LEGACY_PROJECT_CODEX_HOMES_DIRECTORY,
        PROJECT_CODEX_HOMES_DIRECTORY,
      ))
      if (renamed.status !== 'ok') throw new ProjectStateError('state_permissions')
      this.requireMatchesAt(
        root,
        PROJECT_CODEX_HOMES_DIRECTORY,
        legacyDirectory.file,
        'state_permissions',
      )
      const legacyAfter = this.lookupAt(
        root,
        LEGACY_PROJECT_CODEX_HOMES_DIRECTORY,
        'state_permissions',
      )
      if (legacyAfter.status !== 'missing') throw new ProjectStateError('state_permissions')
      await this.revalidateStateRoot()
    } finally {
      await legacyDirectory?.file.close().catch(() => undefined)
    }
  }

  unlinkAt(
    root: FileHandle,
    name: string,
    expected: FileIdentity,
    kind: 'file' | 'directory',
    code: ProjectStateCode,
  ): ProjectRootFileResult {
    requireProjectBasename(name, code)
    const result = this.#callRootFile(
      () => this.#rootFiles.unlinkAt(root.fd, name, expected, kind),
    )
    if (result.status === 'unsupported' || result.status === 'failed') {
      throw new ProjectStateError(code)
    }
    return result
  }

  async ensurePrivateDirectoryAt(
    root: FileHandle,
    rootPath: string,
    name: string,
    exclusive = false,
    create = true,
  ): Promise<{readonly file: FileHandle; readonly binding: DirectoryBinding}> {
    requireProjectBasename(name, 'state_permissions')
    const created = create ? this.mkdirPrivateAt(root, name, 'state_permissions') : {status: 'exists'} as const
    if (created.status !== 'ok' && (exclusive || created.status !== 'exists')) {
      throw new ProjectStateError('state_permissions')
    }
    const createdIdentity = created.status === 'ok' ? created.identity : null
    const path = join(rootPath, name)
    let file: FileHandle | null = null
    try {
      file = await open(path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
      this.requireMatchesAt(root, name, file, 'state_permissions')
      const initialInfo = await file.stat({bigint: true})
      const initialIdentity = fileIdentity(initialInfo)
      if (createdIdentity !== null && !sameFileIdentity(createdIdentity, initialIdentity)) {
        throw new ProjectStateError('state_permissions')
      }
      this.protectAt(root, name, file, 'state_permissions')
      if (created.status === 'ok' && this.#platform !== 'win32') await file.chmod(0o700)
      const info = await file.stat({bigint: true})
      const identity = fileIdentity(info)
      const canonical = realpathSync(path)
      if (
        !info.isDirectory()
        || !privateDirectoryMetadata(info, this.#platform)
        || canonical !== path
        || !isDirectChild(rootPath, canonical)
      ) throw new ProjectStateError('state_permissions')
      this.requireMatchesAt(root, name, file, 'state_permissions')
      return {file, binding: {canonical, identity}}
    } catch (error) {
      await file?.close().catch(() => undefined)
      if (createdIdentity !== null) {
        try {
          this.unlinkAt(root, name, createdIdentity, 'directory', 'state_permissions')
        } catch {
          // A newly-created directory is removed only through an exact descriptor-relative match.
        }
      }
      if (error instanceof ProjectStateError) throw error
      throw new ProjectStateError('state_permissions')
    }
  }

  async openAndAcquireLock(
    fileName: string,
    wait = false,
    signal?: AbortSignal,
  ): Promise<HeldLock> {
    const root = this.requireStateRootHandle()
    requireProjectBasename(fileName, 'state_permissions')
    const created = this.#createFileAt(root, fileName, false, 'state_permissions')
    const createdIdentity = created.status === 'ok' ? created.identity : null
    const file = await openValidatedRegularFile(
      join(this.#stateRoot, fileName),
      constants.O_RDWR | noFollowFlag(),
      null,
      this.#platform,
    )
    const waitSignal = signal === undefined
      ? this.#closeAbort.signal
      : AbortSignal.any([signal, this.#closeAbort.signal])
    let deadline = 0
    try {
      this.requireMatchesAt(root, fileName, file, 'state_permissions')
      if (createdIdentity !== null) {
        const opened = await file.stat({bigint: true})
        if (!sameFileIdentity(createdIdentity, fileIdentity(opened))) {
          throw new ProjectStateError('state_permissions')
        }
      }
      deadline = readClock(this.#lockClock) + PROJECT_LOCK_WAIT_SECONDS
      while (true) {
        if (waitSignal.aborted) throw projectAbortError()
        const result: unknown = this.#nativeLocks.acquire(file.fd)
        if (!validNativeLockResult(result)) throw new ProjectStateError('state_lock_failed')
        if (result.status === 'acquired') {
          if (!waitSignal.aborted) {
            try {
              await this.revalidateStateRoot()
              this.requireMatchesAt(root, fileName, file, 'state_permissions')
              return {file, release: result.release}
            } catch (error) {
              try { await result.release() } catch { /* preserve the root failure */ }
              throw error
            }
          }
          try {
            await result.release()
          } catch {
            throw new ProjectStateError('state_lock_failed')
          }
          throw projectAbortError()
        }
        if (result.status !== 'busy') throw new ProjectStateError('state_lock_failed')
        if (!wait) throw new ProjectStateError('state_busy')
        const remaining = deadline - readClock(this.#lockClock)
        if (remaining <= 0) throw new ProjectStateError('state_busy')
        await this.#lockClock.sleep(Math.min(PROJECT_LOCK_RETRY_SECONDS, remaining), waitSignal)
      }
    } catch (error) {
      await file.close().catch(() => undefined)
      if (error instanceof ProjectStateError || isAbortError(error)) throw error
      throw new ProjectStateError('state_lock_failed')
    }
  }

  async #loadState(recoverStarting: boolean): Promise<readonly [MutableProjectState, boolean]> {
    await this.revalidateStateRoot()
    const root = this.requireStateRootHandle()
    const path = join(this.#stateRoot, PROJECT_STATE_FILE)
    let file: FileHandle
    try {
      file = await openValidatedRegularFile(
        path,
        constants.O_RDONLY | nonblockFlag() | noFollowFlag(),
        null,
        this.#platform,
      )
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        await this.revalidateStateRoot()
        if (this.lookupAt(root, PROJECT_STATE_FILE, 'state_permissions').status !== 'missing') {
          throw new ProjectStateError('state_permissions')
        }
        return [emptyState(), false]
      }
      throw error
    }
    try {
      await this.revalidateStateRoot()
      this.requireMatchesAt(root, PROJECT_STATE_FILE, file, 'state_permissions')
      const info = await file.stat()
      if (info.size > MAX_PROJECT_STATE_BYTES) throw new ProjectStateError('state_too_large')
      const buffer = Buffer.alloc(MAX_PROJECT_STATE_BYTES + 1)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        if (read.bytesRead === 0) break
        bytesRead += read.bytesRead
      }
      if (bytesRead > MAX_PROJECT_STATE_BYTES) throw new ProjectStateError('state_too_large')
      let parsed: unknown
      try {
        const text = new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, bytesRead))
        parsed = JSON.parse(text) as unknown
      } catch {
        throw new ProjectStateError('state_corrupt')
      }
      const state = decodeState(parsed)
      const legacy = (parsed as {version: number}).version === 1
      if (legacy) await this.#backupLegacyState(buffer.subarray(0, bytesRead))
      let recovered = legacy
      if (recoverStarting) {
        for (const [sessionId, session] of state.sessions) {
          if (session.state === 'starting' && session.backend_session_id === null) {
            state.sessions.set(sessionId, Object.freeze({...session, state: 'unavailable'}))
            recovered = true
          }
        }
      }
      return [state, recovered]
    } catch (error) {
      if (error instanceof ProjectStateError) throw error
      throw new ProjectStateError('state_corrupt')
    } finally {
      let closeFailed = false
      await file.close().catch(() => { closeFailed = true })
      if (closeFailed) throw new ProjectStateError('state_corrupt')
    }
  }

  async #readMaintenanceJournal(): Promise<{
    readonly journal: ManagedMaintenanceJournal
    readonly identity: FileIdentity
  } | null> {
    const root = this.requireStateRootHandle()
    const path = join(this.#stateRoot, PROJECT_MAINTENANCE_JOURNAL_FILE)
    let file: FileHandle
    try {
      file = await openValidatedRegularFile(
        path,
        constants.O_RDONLY | nonblockFlag() | noFollowFlag(),
        null,
        this.#platform,
      )
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        if (this.lookupAt(
          root, PROJECT_MAINTENANCE_JOURNAL_FILE, 'state_permissions',
        ).status === 'missing') return null
      }
      throw new ProjectStateError('state_permissions')
    }
    try {
      await this.revalidateStateRoot()
      this.requireMatchesAt(root, PROJECT_MAINTENANCE_JOURNAL_FILE, file, 'state_permissions')
      const info = await file.stat({bigint: true})
      if (Number(info.size) > MAX_MAINTENANCE_JOURNAL_BYTES) {
        throw new ProjectStateError('state_corrupt')
      }
      const raw = await file.readFile()
      if (raw.byteLength > MAX_MAINTENANCE_JOURNAL_BYTES) {
        throw new ProjectStateError('state_corrupt')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw)) as unknown
      } catch {
        throw new ProjectStateError('state_corrupt')
      }
      return {journal: decodeMaintenanceJournal(parsed), identity: fileIdentity(info)}
    } finally {
      await file.close().catch(() => undefined)
    }
  }

  async loadMaintenanceJournal(): Promise<ManagedMaintenanceJournal | null> {
    return (await this.#readMaintenanceJournal())?.journal ?? null
  }

  async writeMaintenanceJournal(journal: ManagedMaintenanceJournal): Promise<void> {
    const raw = Buffer.from(canonicalJsonWithNumberFormatter(
      encodeMaintenanceJournal(journal),
      () => undefined,
    ), 'utf8')
    if (raw.byteLength > MAX_MAINTENANCE_JOURNAL_BYTES) {
      throw new ProjectStateError('state_too_large')
    }
    const root = this.requireStateRootHandle()
    const tempName = `.${PROJECT_MAINTENANCE_JOURNAL_FILE}.${randomUUID()}.tmp`
    const tempPath = join(this.#stateRoot, tempName)
    let file: FileHandle | null = null
    let tempIdentity: FileIdentity | null = null
    try {
      const created = this.#createFileAt(root, tempName, true, 'state_write_failed')
      if (created.status !== 'ok') throw new ProjectStateError('state_write_failed')
      tempIdentity = created.identity
      file = await open(tempPath, constants.O_WRONLY | noFollowFlag())
      const info = await file.stat({bigint: true})
      if (!info.isFile() || !privateRegularFileMetadata(info, this.#platform)
        || !sameFileIdentity(created.identity, fileIdentity(info))) {
        throw new ProjectStateError('state_permissions')
      }
      this.requireMatchesAt(root, tempName, file, 'state_permissions')
      await file.writeFile(raw)
      await file.sync()
      await file.close()
      file = null
      const before = this.lookupAt(root, tempName, 'state_permissions')
      if (before.status !== 'ok' || !sameFileIdentity(before.identity, created.identity)) {
        throw new ProjectStateError('state_permissions')
      }
      this.#renameAt(root, tempName, PROJECT_MAINTENANCE_JOURNAL_FILE)
      const after = this.lookupAt(root, PROJECT_MAINTENANCE_JOURNAL_FILE, 'state_permissions')
      if (after.status !== 'ok' || !sameFileIdentity(after.identity, created.identity)) {
        throw new ProjectStateError('state_permissions')
      }
      if (this.#platform !== 'win32') await root.sync()
    } catch (error) {
      if (error instanceof ProjectStateError) throw error
      throw new ProjectStateError('state_write_failed')
    } finally {
      await file?.close().catch(() => undefined)
      this.#removeOwnedTemp(tempName, tempIdentity)
    }
  }

  async clearMaintenanceJournal(expectedOperationId: string): Promise<void> {
    const loaded = await this.#readMaintenanceJournal()
    if (loaded === null) return
    if (loaded.journal.operation_id !== expectedOperationId) {
      throw new ProjectStateError('state_busy')
    }
    const result = this.unlinkAt(
      this.requireStateRootHandle(),
      PROJECT_MAINTENANCE_JOURNAL_FILE,
      loaded.identity,
      'file',
      'state_write_failed',
    )
    if (result.status !== 'ok') throw new ProjectStateError('state_write_failed')
    if (this.#platform !== 'win32') await this.requireStateRootHandle().sync()
  }

  async #saveState(state: MutableProjectState, markCommitted: () => void): Promise<void> {
    let raw: Buffer
    try {
      raw = Buffer.from(canonicalJsonWithNumberFormatter(
        encodeState(state),
        projectTimestampNumber,
      ), 'utf8')
    } catch {
      throw new ProjectStateError('state_corrupt')
    }
    if (raw.byteLength > MAX_PROJECT_STATE_BYTES) throw new ProjectStateError('state_too_large')
    await this.#writeStateBytes(raw, PROJECT_STATE_FILE, markCommitted)
  }

  /** Keep the old filename so older clients refuse version 2 rather than create a split store. */
  async #backupLegacyState(raw: Buffer): Promise<void> {
    const root = this.requireStateRootHandle()
    const entry = this.lookupAt(root, PROJECT_PRE_ACP_BACKUP_FILE, 'state_permissions')
    if (entry.status === 'missing') {
      await this.#writeStateBytes(raw, PROJECT_PRE_ACP_BACKUP_FILE, () => undefined)
    } else if (entry.status !== 'ok') throw new ProjectStateError('state_permissions')
    const backup = await openValidatedRegularFile(
      join(this.#stateRoot, PROJECT_PRE_ACP_BACKUP_FILE),
      (this.#platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY)
        | nonblockFlag() | noFollowFlag(), null, this.#platform,
    )
    try {
      await this.revalidateStateRoot()
      this.requireMatchesAt(root, PROJECT_PRE_ACP_BACKUP_FILE, backup, 'state_permissions')
      if ((await backup.stat()).size !== raw.length) throw new ProjectStateError('state_corrupt')
      const copy = Buffer.alloc(raw.length)
      let offset = 0
      while (offset < copy.length) {
        const read = await backup.read(copy, offset, copy.length - offset, offset)
        if (read.bytesRead === 0) throw new ProjectStateError('state_corrupt')
        offset += read.bytesRead
      }
      if (!copy.equals(raw)) throw new ProjectStateError('state_corrupt')
      this.requireMatchesAt(root, PROJECT_PRE_ACP_BACKUP_FILE, backup, 'state_permissions')
      // A previous attempt may have stopped after rename but before directory fsync.
      await backup.sync()
      if (this.#platform !== 'win32') await root.sync()
      this.#publishDurability(this.#platform === 'win32' ? 'windows_metadata_commit' : 'dir_fsync')
    } finally { await backup.close() }
  }

  async #writeStateBytes(raw: Buffer, name: string, markCommitted: () => void): Promise<void> {
    const root = this.requireStateRootHandle()
    const tempName = `.${name}.${randomUUID()}.tmp`
    requireProjectBasename(tempName, 'state_write_failed')
    const temp = join(this.#stateRoot, tempName)
    let file: FileHandle | null = null
    let tempIdentity: FileIdentity | null = null
    try {
      await this.revalidateStateRoot()
      const created = this.#createFileAt(root, tempName, true, 'state_write_failed')
      if (created.status !== 'ok') throw new ProjectStateError('state_write_failed')
      tempIdentity = created.identity
      file = await open(
        temp,
        constants.O_WRONLY | noFollowFlag(),
      )
      const info = await file.stat({bigint: true})
      if (
        !info.isFile()
        || !privateRegularFileMetadata(info, this.#platform)
        || !sameFileIdentity(tempIdentity, fileIdentity(info))
      ) throw new ProjectStateError('state_permissions')
      await this.revalidateStateRoot()
      this.requireMatchesAt(root, tempName, file, 'state_permissions')
      this.#publishDurability('temp_open')
      await file.writeFile(raw)
      await file.sync()
      this.#publishDurability('file_fsync')
      await file.close()
      file = null
      await this.revalidateStateRoot()
      const beforeRename = this.lookupAt(root, tempName, 'state_permissions')
      if (
        beforeRename.status !== 'ok'
        || tempIdentity === null
        || !sameFileIdentity(beforeRename.identity, tempIdentity)
      ) throw new ProjectStateError('state_permissions')
      this.#renameAt(root, tempName, name)
      markCommitted()
      this.#publishDurability('atomic_replace')
      await this.revalidateStateRoot()
      const replaced = this.lookupAt(root, name, 'state_permissions')
      if (
        replaced.status !== 'ok'
        || tempIdentity === null
        || !sameFileIdentity(replaced.identity, tempIdentity)
      ) throw new ProjectStateError('state_permissions')
      const directory = this.#stateRootHandle
      if (directory === null) throw new ProjectStateError('state_permissions')
      if (this.#platform === 'win32') {
        // Node maps FileHandle.sync() to FlushFileBuffers(), which rejects
        // directory handles with EPERM on Windows. The replace is already
        // committed by the native descriptor-relative rename above; the
        // retained-root and replacement identity checks are the Windows
        // metadata commit boundary.
        this.#publishDurability('windows_metadata_commit')
      } else {
        await directory.sync()
        this.#publishDurability('dir_fsync')
      }
      await this.revalidateStateRoot()
    } catch (error) {
      if (error instanceof ProjectStateError) throw error
      throw new ProjectStateError('state_write_failed')
    } finally {
      await file?.close().catch(() => undefined)
      this.#removeOwnedTemp(tempName, tempIdentity)
    }
  }

  #removeOwnedTemp(name: string, expected: FileIdentity | null): void {
    if (expected === null) return
    try {
      const root = this.requireStateRootHandle()
      const result = this.unlinkAt(root, name, expected, 'file', 'state_write_failed')
      if (result.status === 'ok' || result.status === 'missing' || result.status === 'mismatch') return
    } catch {
      // Exact descriptor-relative cleanup is best effort and never falls back to a path delete.
    }
  }

  async rollbackCreatedDirectory(candidate: {
    readonly path: string
    readonly identity: FileIdentity | null
    readonly workspaceId: string
  }): Promise<boolean> {
    if (candidate.identity === null) return false
    let file: FileHandle | null = null
    try {
      const managed = await this.validateManagedRoot()
      if (!isDirectChild(managed, candidate.path)) return false
      const root = this.requireManagedRootHandle()
      const name = basename(candidate.path)
      file = await open(candidate.path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
      this.requireMatchesAt(root, name, file, 'workspace_boundary_changed')
      const info = await file.stat({bigint: true})
      const canonical = realpathSync(candidate.path)
      if (
        !info.isDirectory()
        || !privateDirectoryMetadata(info, this.#platform)
        || !sameFileIdentity(candidate.identity, fileIdentity(info))
        || canonical !== candidate.path
      ) return false
      this.requireMatchesAt(root, name, file, 'workspace_boundary_changed')
      const removed = this.unlinkAt(
        root,
        name,
        candidate.identity,
        'directory',
        'workspace_boundary_changed',
      )
      if (removed.status !== 'ok') return false
      await this.validateManagedRoot()
      return true
    } catch {
      // Rollback is best effort and never removes an unproven replacement or non-empty directory.
      return false
    } finally {
      await file?.close().catch(() => undefined)
    }
  }

  #publishDurability(step: DurabilityStep): void {
    try { this.#onDurabilityStep?.(step) } catch { /* an audit sink never owns state */ }
  }
}

function validNativeLockResult(value: unknown): value is NativeFileLockResult {
  const record = ownDataRecord(value)
  if (record === null) return false
  const status = record.status
  if (status === 'acquired') {
    return exactKeys(record, ['status', 'release']) && typeof record.release === 'function'
  }
  return exactKeys(record, ['status'])
    && (status === 'busy' || status === 'unsupported' || status === 'failed')
}

function validProjectRootFileResult(value: unknown): value is ProjectRootFileResult {
  const record = ownDataRecord(value)
  if (record === null || !exactKeys(record, ['status'])) return false
  const status = record.status
  return status === 'ok'
    || status === 'mismatch'
    || status === 'exists'
    || status === 'missing'
    || status === 'unsupported'
    || status === 'failed'
}

function validProjectRootFileLookupResult(value: unknown): value is ProjectRootFileLookupResult {
  const record = ownDataRecord(value)
  if (record === null) return false
  if (record.status === 'ok') {
    if (!exactKeys(record, ['status', 'identity'])) return false
    const identity = ownDataRecord(record.identity)
    return identity !== null
      && exactKeys(identity, ['device', 'inode'])
      && typeof identity.device === 'bigint'
      && typeof identity.inode === 'bigint'
      && identity.device >= 0n
      && identity.inode >= 0n
  }
  return exactKeys(record, ['status'])
    && (record.status === 'missing'
      || record.status === 'unsupported'
      || record.status === 'failed')
}

function validProjectRootFileCreateResult(value: unknown): value is ProjectRootFileCreateResult {
  const record = ownDataRecord(value)
  if (record === null) return false
  if (record.status === 'ok') {
    if (!exactKeys(record, ['status', 'identity'])) return false
    return validFileIdentity(record.identity)
  }
  return exactKeys(record, ['status'])
    && (record.status === 'exists'
      || record.status === 'unsupported'
      || record.status === 'failed')
}

function validFileIdentity(value: unknown): value is FileIdentity {
  const identity = ownDataRecord(value)
  return identity !== null
    && exactKeys(identity, ['device', 'inode'])
    && typeof identity.device === 'bigint'
    && typeof identity.inode === 'bigint'
    && identity.device >= 0n
    && identity.inode >= 0n
}

function ownDataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const descriptor of Object.values(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')) return null
  }
  return value as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record)
  return keys.length === expected.length
    && expected.every(key => Object.hasOwn(record, key))
}

export function isCommittedTransactionFailure(error: unknown): boolean {
  return error instanceof TransactionProjectStateError && error.committed
}

function brandProjectRoot(path: string): HostProjectRoot {
  const value = Object.freeze({[hostProjectRootBrand]: true as const})
  rootValues.set(value, path)
  return value
}

function brandManagedProjectRoot(path: string): HostManagedProjectRoot {
  const value = Object.freeze({[hostManagedProjectRootBrand]: true as const})
  managedRootValues.set(value, path)
  return value
}

function projectRootPath(value: HostProjectRoot): string {
  const path = rootValues.get(value)
  if (path === undefined) throw new ProjectStateError('state_permissions')
  return path
}

function managedProjectRootPath(value: HostManagedProjectRoot): string {
  const path = managedRootValues.get(value)
  if (path === undefined) throw new ProjectStateError('managed_root_unsafe')
  return path
}

function requireProjectRoot(
  configured: string,
  code: ProjectStateCode,
  platform: NodeJS.Platform,
): string {
  try {
    if (typeof configured !== 'string' || !isAbsolute(configured) || !isWellFormed(configured)) {
      throw new Error('invalid')
    }
    const info = lstatSync(configured)
    const canonical = realpathSync(configured)
    if (
      info.isSymbolicLink()
      || !info.isDirectory()
      || canonical !== resolve(configured)
      || !privateDirectoryMetadata(info, platform)
    ) throw new Error('unsafe')
    return canonical
  } catch {
    throw new ProjectStateError(code)
  }
}

function requireManagedProjectRoot(configured: string, platform: NodeJS.Platform): string {
  try {
    if (typeof configured !== 'string' || !isAbsolute(configured) || !isWellFormed(configured)) {
      throw new Error('invalid')
    }
    const info = lstatSync(configured)
    const canonical = realpathSync(configured)
    if (
      info.isSymbolicLink()
      || !info.isDirectory()
      || canonical !== resolve(configured)
      || !managedDirectoryMetadata(info, platform)
    ) throw new Error('unsafe')
    return canonical
  } catch {
    throw new ProjectStateError('managed_root_unsafe')
  }
}

export async function validateRegisteredWorkspace(
  path: string,
  failure: 'workspace_invalid' | 'workspace_boundary_changed' = 'workspace_invalid',
): Promise<DirectoryBinding> {
  try {
    const file = await open(path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
    try {
      const info = await file.stat({bigint: true})
      const canonical = realpathSync(path)
      if (!info.isDirectory() || canonical !== path) throw new Error('unsafe')
      return {canonical, identity: fileIdentity(info)}
    } finally {
      await file.close()
    }
  } catch {
    throw new ProjectStateError(failure)
  }
}

async function openValidatedRegularFile(
  path: string,
  flags: number,
  createMode: number | null,
  platform: NodeJS.Platform,
): Promise<FileHandle> {
  let file: FileHandle | null = null
  try {
    file = createMode === null ? await open(path, flags) : await open(path, flags, createMode)
    const info = await file.stat()
    if (
      !info.isFile()
      || !privateRegularFileMetadata(info, platform)
    ) throw new ProjectStateError('state_permissions')
    return file
  } catch (error) {
    await file?.close().catch(() => undefined)
    if (isNodeError(error, 'ENOENT')) throw error
    if (error instanceof ProjectStateError) throw error
    throw new ProjectStateError('state_permissions')
  }
}

export function privateDirectoryMetadata(
  info: Pick<Stats, 'uid' | 'mode'> | {readonly uid: bigint; readonly mode: bigint},
  platform: NodeJS.Platform,
): boolean {
  if (platform === 'win32') return true
  return ownedByCurrentUserValue(info.uid) && (BigInt(info.mode) & 0o7777n) === 0o700n
}

function privateRegularFileMetadata(
  info: Pick<Stats, 'uid' | 'mode'> | {readonly uid: bigint; readonly mode: bigint},
  platform: NodeJS.Platform,
): boolean {
  if (platform === 'win32') return true
  return ownedByCurrentUserValue(info.uid) && (BigInt(info.mode) & 0o7777n) === 0o600n
}

function managedDirectoryMetadata(
  info: Pick<Stats, 'uid' | 'mode'> | {readonly uid: bigint; readonly mode: bigint},
  platform: NodeJS.Platform,
): boolean {
  if (platform === 'win32') return true
  return ownedByCurrentUserValue(info.uid) && !unsafeManagedMode(Number(info.mode))
}

function ownedByCurrentUserValue(uid: number | bigint): boolean {
  return typeof process.getuid === 'function' && BigInt(uid) === BigInt(process.getuid())
}

export function fileIdentity(info: {readonly dev: bigint; readonly ino: bigint}): FileIdentity {
  return Object.freeze({device: info.dev, inode: info.ino})
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

async function openStateRoot(
  path: string,
  platform: NodeJS.Platform,
): Promise<{readonly file: FileHandle; readonly identity: StateRootIdentity}> {
  let file: FileHandle | null = null
  try {
    file = await open(path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
    const info = await file.stat({bigint: true})
    const canonical = realpathSync(path)
    if (
      !info.isDirectory()
      || canonical !== path
      || !privateDirectoryMetadata(info, platform)
    ) throw new Error('unsafe')
    return {
      file,
      identity: Object.freeze({
        ...fileIdentity(info),
        canonical,
        owner: info.uid,
        mode: info.mode & 0o7777n,
      }),
    }
  } catch {
    await file?.close().catch(() => undefined)
    throw new ProjectStateError('state_permissions')
  }
}

async function openManagedRoot(
  path: string,
  platform: NodeJS.Platform,
): Promise<{readonly file: FileHandle; readonly identity: FileIdentity}> {
  let file: FileHandle | null = null
  try {
    file = await open(path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
    const info = await file.stat({bigint: true})
    const canonical = realpathSync(path)
    if (
      !info.isDirectory()
      || canonical !== path
      || !managedDirectoryMetadata(info, platform)
    ) throw new Error('unsafe')
    return {file, identity: fileIdentity(info)}
  } catch {
    await file?.close().catch(() => undefined)
    throw new ProjectStateError('managed_root_unsafe')
  }
}

function stateRootMatches(
  info: {readonly dev: bigint; readonly ino: bigint; readonly uid: bigint; readonly mode: bigint; isDirectory(): boolean},
  expected: StateRootIdentity,
  platform: NodeJS.Platform,
): boolean {
  return info.isDirectory()
    && info.dev === expected.device
    && info.ino === expected.inode
    && (platform === 'win32' || (
      info.uid === expected.owner
      && (info.mode & 0o7777n) === expected.mode
      && privateDirectoryMetadata(info, platform)
    ))
}

function unsafeManagedMode(mode: number): boolean {
  return (mode & 0o7022) !== 0
}

function readClock(clock: Clock): number {
  const value = clock.now()
  if (!Number.isFinite(value)) throw new ProjectStateError('state_lock_failed')
  return value
}

async function waitForTransactions(
  transactions: readonly Promise<void>[],
  signal: AbortSignal | undefined,
  closeSignal: AbortSignal,
): Promise<void> {
  if (transactions.length === 0) return
  if (signal?.aborted === true) throw projectAbortError()
  if (closeSignal.aborted) throw new ProjectStateError('state_lock_failed')
  const combined = signal === undefined ? closeSignal : AbortSignal.any([signal, closeSignal])
  let subscription: ReturnType<typeof addAbortListener> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      subscription = addAbortListener(combined, () => {
        reject(closeSignal.aborted ? new ProjectStateError('state_lock_failed') : projectAbortError())
      })
      void Promise.all(transactions).then(() => { resolve() }, reject)
    })
  } finally {
    subscription?.[Symbol.dispose]()
  }
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError'
}

function projectAbortError(): Error {
  const error = new Error('project state operation aborted')
  error.name = 'AbortError'
  return error
}

export function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0
}

export function directoryFlag(): number {
  return constants.O_DIRECTORY ?? 0
}

function nonblockFlag(): number {
  return constants.O_NONBLOCK ?? 0
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

export function isDirectChild(parent: string, child: string): boolean {
  return child !== parent && dirname(child) === parent
}
