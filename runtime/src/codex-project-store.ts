import {randomUUID} from 'node:crypto'
import {constants, lstatSync, realpathSync, type Stats} from 'node:fs'
import {
  open,
  type FileHandle,
} from 'node:fs/promises'
import {basename, dirname, isAbsolute, join, resolve} from 'node:path'
import {TextDecoder} from 'node:util'

import {
  canonicalJsonWithNumberFormatter,
  compareCodePoints,
  type CanonicalJsonPath,
} from './canonical-json.js'
import {RealClock, type Clock} from './clock.js'
import {
  hostCodexHomeValue,
  hostPersistentCodexHomeFromConfig,
  hostWorkspacePath,
  type HostCodexHome,
  type HostWorkspace,
} from './codex-process-owner.js'
import type {NativeFileLockAuthority, NativeFileLockResult} from './native-file-lock.js'
import {isPythonSpace, isWellFormed, stripLikePython} from './python-text.js'
import {casefoldLikePython} from './unicode-casefold.js'
import {isLetterCategory, isNumberCategory, isOtherCategory} from './unicode-tables.js'
import {normalizeNfkcPinned} from './unicode-normalize.js'
import {pythonFloat} from './python-number.js'
import {
  unsupportedProjectRootFiles,
  type ProjectFileIdentity,
  type ProjectRootFileAuthority,
  type ProjectRootFileCreateResult,
  type ProjectRootFileLookupResult,
  type ProjectRootFileResult,
} from './project-root-file.js'

export const PROJECT_STATE_VERSION = 1
export const PROJECT_STATE_FILE = 'codex-projects-v1.json'
export const PROJECT_TRANSACTION_LOCK_FILE = 'codex-projects-v1.lock'
export const PROJECT_OWNER_LOCK_FILE = 'codex-projects-v1.owner.lock'
export const PROJECT_MAINTENANCE_JOURNAL_FILE = 'managed-workspace-maintenance-v1.json'
const PROJECT_CODEX_HOMES_DIRECTORY = 'codex-homes'
const LEGACY_PROJECT_CODEX_HOMES_DIRECTORY = 'codex-workspaces'
export const MAX_PROJECT_STATE_BYTES = 1024 * 1024
export const MAX_PROJECT_WORKSPACES = 100
export const MAX_PROJECT_SESSIONS_PER_WORKSPACE = 200
export const MAX_PROJECT_SESSIONS_TOTAL = 1000
export const MAX_PROJECT_WORKSPACE_NAME = 80
export const MAX_PROJECT_SESSION_TITLE = 120
const MAX_PROJECT_THREAD_ID = 256
const PROJECT_LOCK_WAIT_SECONDS = 2
const PROJECT_LOCK_RETRY_SECONDS = 0.025
const DEFAULT_SESSION_PREFIX = '任务 '
const MAX_DEFAULT_SESSION_DIGITS = MAX_PROJECT_SESSION_TITLE - [...DEFAULT_SESSION_PREFIX].length
const STORED_ID = /^[A-Za-z0-9_-]{8,80}$/u
const DEFAULT_SESSION_TITLE = /^任务 ([1-9][0-9]*)$/u
const MAX_ID_FACTORY_ATTEMPTS = 32
const MAX_MAINTENANCE_JOURNAL_BYTES = 64 * 1024
const MAINTENANCE_TOMBSTONE = /^\.nova-maintenance-([A-Za-z0-9_-]{8,80})-([0-9]{1,3})$/u
const MAINTENANCE_REPLACEMENT = /^\.nova-replacement-([A-Za-z0-9_-]{8,80})-([0-9]{1,3})$/u

export type ProjectStateCode =
  | 'workspace_name_invalid'
  | 'session_title_invalid'
  | 'state_lock_failed'
  | 'state_busy'
  | 'state_permissions'
  | 'state_corrupt'
  | 'state_too_large'
  | 'state_version_unsupported'
  | 'state_write_failed'
  | 'context_delivery_failed'
  | 'managed_root_unsafe'
  | 'workspace_invalid'
  | 'workspace_not_found'
  | 'workspace_name_conflict'
  | 'workspace_path_conflict'
  | 'workspace_limit'
  | 'workspace_create_failed'
  | 'workspace_boundary_changed'
  | 'session_not_found'
  | 'session_unavailable'
  | 'session_workspace_mismatch'
  | 'session_state_conflict'
  | 'session_limit'
  | 'thread_id_invalid'
  | 'id_factory_invalid'
  | 'clock_invalid'

export class ProjectStateError extends Error {
  constructor(readonly code: ProjectStateCode) {
    super(code)
    this.name = 'ProjectStateError'
  }
}

class TransactionProjectStateError extends ProjectStateError {
  constructor(code: ProjectStateCode, readonly committed: boolean) {
    super(code)
  }
}

type MaintenanceFaultStep =
  | 'replacement_created'
  | 'replacement_identity_persisted'
  | 'replacement_placed'
  | 'cleanup_entry_deleted'

class MaintenanceFaultError extends Error {
  constructor(step: MaintenanceFaultStep) {
    super(`maintenance fault: ${step}`)
    this.name = 'MaintenanceFaultError'
  }
}

export interface NormalizedProjectText {
  readonly display: string
  readonly normalized: string
}

const hostProjectRootBrand: unique symbol = Symbol('HostProjectRoot')
export interface HostProjectRoot { readonly [hostProjectRootBrand]: true }
const rootValues = new WeakMap<HostProjectRoot, string>()
const hostManagedProjectRootBrand: unique symbol = Symbol('HostManagedProjectRoot')
export interface HostManagedProjectRoot { readonly [hostManagedProjectRootBrand]: true }
const managedRootValues = new WeakMap<HostManagedProjectRoot, string>()

export interface WorkspaceRecord {
  readonly workspace_id: string
  readonly display_name: string
  readonly normalized_name: string
  readonly canonical_path: string
  readonly origin: 'managed' | 'registered'
  readonly codex_home_key: string
  readonly active_session_id: string | null
  readonly created_at: number
  readonly last_used_at: number
}

export interface ProjectSessionRecord {
  readonly session_id: string
  readonly workspace_id: string
  readonly display_title: string
  readonly normalized_title: string
  readonly codex_thread_id: string | null
  readonly state: 'starting' | 'ready' | 'unavailable'
  readonly created_at: number
  readonly last_used_at: number
}

export interface SessionStartRollback {
  readonly activationRevision: number
  readonly previousActiveWorkspaceId: string | null
  readonly workspaceId: string
  readonly previousActiveSessionId: string | null
  readonly startedSessionId: string
}

export interface BegunSession {
  readonly session: ProjectSessionRecord
  readonly rollback: SessionStartRollback
}

export interface ProjectSnapshot {
  readonly version: 1
  readonly state_revision: number
  readonly active_binding_revision: number
  readonly active_workspace_id: string | null
  readonly workspaces: readonly WorkspaceRecord[]
  readonly sessions: readonly ProjectSessionRecord[]
}

export interface ProjectMaintenanceTargetSnapshot {
  readonly workspace: WorkspaceRecord
  readonly identity: ProjectFileIdentity
}

export interface ProjectMaintenanceSnapshot {
  readonly state_revision: number
  readonly active_workspace_id: string | null
  readonly managed_targets: readonly ProjectMaintenanceTargetSnapshot[]
}

export interface ManagedMaintenanceJournalEntry {
  readonly workspace_id: string
  readonly original_name: string
  readonly tombstone_name: string
  readonly replacement_name: string
  readonly identity: ProjectFileIdentity
  readonly replacement_identity: ProjectFileIdentity | null
}

export interface ManagedMaintenanceJournal {
  readonly version: 1 | 2
  readonly operation_id: string
  readonly phase: 'prepared' | 'committed'
  readonly entries: readonly ManagedMaintenanceJournalEntry[]
}

export interface ManagedReplacementInput {
  readonly expected_state_revision: number
  readonly targets: readonly {
    readonly workspace_id: string
    readonly canonical_path: string
    readonly identity: ProjectFileIdentity
    readonly tombstone_name: string
  }[]
}

export interface PublicProjectView {
  readonly workspace_display_name: string | null
  readonly session_title: string | null
  readonly pending_confirmation: boolean
  readonly pending_confirmation_busy: boolean
  readonly pending_confirmation_id?: string
  /** Optional at the internal boundary so legacy store-only callers remain source compatible. */
  readonly pending_action?:
    | 'create_workspace'
    | 'reuse_workspace'
    | 'select_workspace'
    | 'resume_session'
    | null
  readonly pending_workspace_display_name?: string | null
  readonly pending_session_title?: string | null
  readonly pending_expires_in_seconds?: number | null
}

export interface PublicProjectContext {
  readonly workspace_id: string | null
  readonly view: PublicProjectView
}

export interface SessionResumeRollback {
  readonly activationRevision: number
  readonly previousActiveWorkspaceId: string | null
  readonly workspaceId: string
  readonly previousActiveSessionId: string | null
  readonly resumedSessionId: string
}

export interface PreparedSessionResume {
  readonly workspace: HostWorkspace
  readonly rollback: SessionResumeRollback
}

interface MutableProjectState {
  stateRevision: number
  activeBindingRevision: number
  activeWorkspaceId: string | null
  workspaces: Map<string, WorkspaceRecord>
  sessions: Map<string, ProjectSessionRecord>
}

type DurabilityStep =
  | 'temp_open'
  | 'file_fsync'
  | 'atomic_replace'
  | 'dir_fsync'
  | 'windows_metadata_commit'

export interface CodexProjectStoreOptions {
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

interface HeldLock {
  readonly file: FileHandle
  readonly release: () => void | Promise<void>
}

type FileIdentity = ProjectFileIdentity

interface DirectoryBinding {
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

export class CodexProjectStore {
  readonly #stateRoot: string
  readonly #managedRoot: string
  readonly #nativeLocks: NativeFileLockAuthority
  readonly #rootFiles: ProjectRootFileAuthority
  readonly #now: () => number
  readonly #idFactory: () => string
  readonly #recoverStarting: boolean
  readonly #lockClock: Clock
  readonly #onDurabilityStep: ((step: DurabilityStep) => void) | undefined
  readonly #maintenanceFault: ((step: MaintenanceFaultStep) => boolean) | undefined
  readonly #platform: NodeJS.Platform
  readonly #activeTransactions = new Set<Promise<void>>()
  readonly #workspaceIdentities = new Map<string, FileIdentity>()
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

  private constructor(options: CodexProjectStoreOptions) {
    this.#stateRoot = projectRootPath(options.stateRoot)
    this.#managedRoot = managedProjectRootPath(options.managedRoot)
    this.#nativeLocks = options.nativeLocks
    this.#rootFiles = options.rootFiles ?? unsupportedProjectRootFiles
    this.#now = options.now ?? (() => Date.now() / 1000)
    this.#idFactory = options.idFactory ?? (() => randomUUID().replaceAll('-', ''))
    this.#recoverStarting = options.live === true
    this.#lockClock = options.lockClock ?? new RealClock()
    this.#onDurabilityStep = options.onDurabilityStep
    this.#maintenanceFault = options.maintenanceFault
    this.#platform = options.platform ?? process.platform
  }

  static async open(options: CodexProjectStoreOptions): Promise<CodexProjectStore> {
    const store = new CodexProjectStore(options)
    try {
      await store.#retainStateRoot()
      await store.#retainManagedRoot()
      store.#probeRootFileAuthority()
      if (store.#recoverStarting) {
        store.#ownerLock = await store.#openAndAcquireLock(PROJECT_OWNER_LOCK_FILE)
        await store.#revalidateStateRoot()
        await store.#migrateLegacyCodexHomes(store.#requireStateRootHandle())
      }
      return store
    } catch (error) {
      const owner = store.#ownerLock
      store.#ownerLock = null
      if (owner !== null) {
        await Promise.resolve(owner.release()).catch(() => undefined)
        await owner.file.close().catch(() => undefined)
      }
      await store.#stateRootHandle?.close().catch(() => undefined)
      await store.#managedRootHandle?.close().catch(() => undefined)
      store.#stateRootHandle = null
      store.#stateRootIdentity = null
      store.#managedRootHandle = null
      store.#managedRootIdentity = null
      throw error
    }
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
    await root?.close().catch(() => { failed = true })
    await managedRoot?.close().catch(() => { failed = true })
    if (failed) throw new ProjectStateError('state_lock_failed')
  }

  async snapshot(): Promise<ProjectSnapshot> {
    return await this.#transaction(state => [snapshotState(state), false], {wait: true})
  }

  async maintenanceSnapshot(): Promise<ProjectMaintenanceSnapshot> {
    return await this.#transaction<ProjectMaintenanceSnapshot>(async state => {
      await this.#validateManagedRoot()
      const targets: ProjectMaintenanceTargetSnapshot[] = []
      for (const workspace of [...state.workspaces.values()].sort(compareCreated)) {
        if (workspace.origin !== 'managed') continue
        const binding = await this.#validateManagedWorkspaceBinding(workspace.canonical_path)
        this.#pinWorkspaceIdentity(workspace.workspace_id, binding.identity)
        targets.push(Object.freeze({
          workspace: Object.freeze({...workspace}),
          identity: Object.freeze({...binding.identity}),
        }))
      }
      return [Object.freeze({
        state_revision: state.stateRevision,
        active_workspace_id: state.activeWorkspaceId,
        managed_targets: Object.freeze(targets),
      }), false]
    }, {wait: true})
  }

  async currentMaintenanceSnapshot(): Promise<ProjectMaintenanceSnapshot> {
    return await this.#transaction<ProjectMaintenanceSnapshot>(async state => {
      await this.#validateManagedRoot()
      const workspace = state.activeWorkspaceId === null
        ? undefined
        : state.workspaces.get(state.activeWorkspaceId)
      const targets: ProjectMaintenanceTargetSnapshot[] = []
      if (workspace?.origin === 'managed') {
        const binding = await this.#validateManagedWorkspaceBinding(workspace.canonical_path)
        this.#pinWorkspaceIdentity(workspace.workspace_id, binding.identity)
        targets.push(Object.freeze({
          workspace: Object.freeze({...workspace}),
          identity: Object.freeze({...binding.identity}),
        }))
      }
      return [Object.freeze({
        state_revision: state.stateRevision,
        active_workspace_id: state.activeWorkspaceId,
        managed_targets: Object.freeze(targets),
      }), false]
    }, {wait: true})
  }

  async withCurrentManagedWorkspacePath(
    callback: (path: string) => void,
  ): Promise<boolean> {
    return await this.#transaction<boolean>(async state => {
      await this.#validateManagedRoot()
      const workspace = state.activeWorkspaceId === null
        ? undefined
        : state.workspaces.get(state.activeWorkspaceId)
      if (workspace?.origin !== 'managed') return [false, false]
      const before = await this.#validateManagedWorkspaceBinding(workspace.canonical_path)
      this.#pinWorkspaceIdentity(workspace.workspace_id, before.identity)
      callback(workspace.canonical_path)
      await this.#validateManagedRoot()
      const after = await this.#validateManagedWorkspaceBinding(workspace.canonical_path)
      if (!sameFileIdentity(before.identity, after.identity)) {
        throw new ProjectStateError('workspace_boundary_changed')
      }
      return [true, false]
    }, {wait: true})
  }

  async executeManagedReplacement(input: ManagedReplacementInput): Promise<{
    readonly status: 'stale' | 'rolled_back' | 'committed'
    readonly committed: boolean
    readonly tombstones: readonly {readonly name: string; readonly identity: ProjectFileIdentity}[]
  }> {
    return await this.#transaction<{
      readonly status: 'stale' | 'rolled_back' | 'committed'
      readonly committed: boolean
      readonly tombstones: readonly {readonly name: string; readonly identity: ProjectFileIdentity}[]
    }>(async state => {
      if (state.stateRevision !== input.expected_state_revision || input.targets.length === 0) {
        return [{status: 'stale', committed: false, tombstones: []}, false]
      }
      const managed = await this.#validateManagedRoot()
      const root = this.#requireManagedRootHandle()
      const prepared: {
        readonly workspace: WorkspaceRecord
        readonly originalName: string
        readonly tombstoneName: string
        readonly replacementName: string
        readonly identity: FileIdentity
      }[] = []
      const operationIds = new Set<string>()
      const seenWorkspaces = new Set<string>()
      const seenTombstones = new Set<string>()
      for (const target of input.targets) {
        const workspace = state.workspaces.get(target.workspace_id)
        const match = MAINTENANCE_TOMBSTONE.exec(target.tombstone_name)
        if (
          workspace?.origin !== 'managed'
          || workspace.canonical_path !== target.canonical_path
          || !isDirectChild(managed, target.canonical_path)
          || match === null
          || seenWorkspaces.has(target.workspace_id)
          || seenTombstones.has(target.tombstone_name)
        ) return [{status: 'stale', committed: false, tombstones: []}, false]
        const binding = await this.#validateManagedWorkspaceBinding(target.canonical_path)
        if (!sameFileIdentity(binding.identity, target.identity)) {
          return [{status: 'stale', committed: false, tombstones: []}, false]
        }
        this.#pinWorkspaceIdentity(workspace.workspace_id, binding.identity)
        operationIds.add(match[1] ?? '')
        seenWorkspaces.add(target.workspace_id)
        seenTombstones.add(target.tombstone_name)
        prepared.push({
          workspace,
          originalName: basename(target.canonical_path),
          tombstoneName: target.tombstone_name,
          replacementName: target.tombstone_name.replace(
            '.nova-maintenance-',
            '.nova-replacement-',
          ),
          identity: binding.identity,
        })
      }
      if (operationIds.size !== 1) {
        return [{status: 'stale', committed: false, tombstones: []}, false]
      }
      const operationId = [...operationIds][0]
      if (operationId === undefined || !STORED_ID.test(operationId)) {
        return [{status: 'stale', committed: false, tombstones: []}, false]
      }
      let journal: ManagedMaintenanceJournal = Object.freeze({
        version: 2,
        operation_id: operationId,
        phase: 'prepared',
        entries: Object.freeze(prepared.map(target => Object.freeze({
          workspace_id: target.workspace.workspace_id,
          original_name: target.originalName,
          tombstone_name: target.tombstoneName,
          replacement_name: target.replacementName,
          identity: Object.freeze({...target.identity}),
          replacement_identity: null,
        }))),
      })
      if (await this.#loadMaintenanceJournal() !== null) {
        throw new ProjectStateError('state_busy')
      }
      await this.#writeMaintenanceJournal(journal)
      const replaced: {
        readonly target: typeof prepared[number]
        replacementIdentity: FileIdentity | null
        renamed: boolean
      }[] = prepared.map(target => ({target, replacementIdentity: null, renamed: false}))
      try {
        for (const item of replaced) {
          const target = item.target
          const tombstoneBefore = this.#lookupAt(root, target.tombstoneName, 'workspace_boundary_changed')
          const replacementBefore = this.#lookupAt(
            root, target.replacementName, 'workspace_boundary_changed',
          )
          if (tombstoneBefore.status !== 'missing' || replacementBefore.status !== 'missing') {
            throw new ProjectStateError('workspace_boundary_changed')
          }
          const renamed = this.#renameManagedNoReplace(
            root, target.originalName, target.tombstoneName, target.identity,
          )
          if (renamed.status !== 'ok') throw new ProjectStateError('workspace_boundary_changed')
          item.renamed = true
          const tombstone = this.#lookupAt(root, target.tombstoneName, 'workspace_boundary_changed')
          if (tombstone.status !== 'ok' || !sameFileIdentity(tombstone.identity, target.identity)) {
            throw new ProjectStateError('workspace_boundary_changed')
          }
        }
        for (const [index, item] of replaced.entries()) {
          const target = item.target
          const replacement = await this.#ensurePrivateDirectoryAt(
            root, managed, target.replacementName, true,
          )
          item.replacementIdentity = replacement.binding.identity
          await replacement.file.close()
          this.#maintenanceCheckpoint('replacement_created')
          journal = Object.freeze({
            ...journal,
            entries: Object.freeze(journal.entries.map((entry, entryIndex) => entryIndex === index
              ? Object.freeze({
                ...entry,
                replacement_identity: Object.freeze({...replacement.binding.identity}),
              })
              : entry)),
          })
          await this.#writeMaintenanceJournal(journal)
          this.#maintenanceCheckpoint('replacement_identity_persisted')
          const placed = this.#renameManagedNoReplace(
            root,
            target.replacementName,
            target.originalName,
            replacement.binding.identity,
          )
          if (placed.status !== 'ok') throw new ProjectStateError('workspace_boundary_changed')
          const placedIdentity = this.#lookupAt(
            root, target.originalName, 'workspace_boundary_changed',
          )
          if (
            placedIdentity.status !== 'ok'
            || !sameFileIdentity(placedIdentity.identity, replacement.binding.identity)
          ) throw new ProjectStateError('workspace_boundary_changed')
          this.#maintenanceCheckpoint('replacement_placed')
          this.#advanceWorkspaceIdentity(
            target.workspace.workspace_id,
            target.identity,
            replacement.binding.identity,
          )
        }
        await this.#syncManagedRoot()
        await this.#writeMaintenanceJournal(Object.freeze({...journal, phase: 'committed'}))
      } catch (error) {
        if (error instanceof MaintenanceFaultError) throw error
        let rollbackComplete = true
        for (const item of [...replaced].reverse()) {
          const replacementNames = item.replacementIdentity === null
            ? [item.target.replacementName]
            : [item.target.originalName, item.target.replacementName]
          for (const name of replacementNames) {
            try {
              const present = this.#lookupAt(root, name, 'workspace_boundary_changed')
              if (present.status === 'missing') continue
              if (present.status !== 'ok') {
                rollbackComplete = false
                continue
              }
              const removable = item.replacementIdentity === null
                ? name === item.target.replacementName
                : sameFileIdentity(present.identity, item.replacementIdentity)
              if (!removable) {
                rollbackComplete = false
                continue
              }
              const removed = this.#unlinkAt(
                root, name, present.identity, 'directory', 'workspace_boundary_changed',
              )
              if (removed.status !== 'ok' && removed.status !== 'missing') rollbackComplete = false
            } catch { rollbackComplete = false }
          }
          if (item.renamed) {
            const restored = this.#renameManagedNoReplace(
              root,
              item.target.tombstoneName,
              item.target.originalName,
              item.target.identity,
            )
            if (restored.status === 'ok') {
              try {
                this.#restoreWorkspaceIdentity(
                  item.target.workspace.workspace_id,
                  item.replacementIdentity,
                  item.target.identity,
                )
              } catch { rollbackComplete = false }
            } else rollbackComplete = false
          }
        }
        if (rollbackComplete) {
          try {
            await this.#syncManagedRoot()
            await this.#clearMaintenanceJournal(operationId)
          } catch { rollbackComplete = false }
        }
        if (!rollbackComplete) throw new ProjectStateError('workspace_boundary_changed')
        return [{status: 'rolled_back', committed: false, tombstones: []}, false]
      }
      return [Object.freeze({
        status: 'committed',
        committed: true,
        tombstones: Object.freeze(prepared.map(target => Object.freeze({
          name: target.tombstoneName,
          identity: Object.freeze({...target.identity}),
        }))),
      }), false]
    }, {wait: true})
  }

  async loadManagedMaintenanceJournal(): Promise<ManagedMaintenanceJournal | null> {
    return await this.#transaction(async () => [await this.#loadMaintenanceJournal(), false], {wait: true})
  }

  async clearManagedMaintenanceJournal(expectedOperationId: string): Promise<void> {
    await this.#transaction(async () => {
      await this.#clearMaintenanceJournal(expectedOperationId)
      return [undefined, false]
    }, {wait: true})
  }

  async cleanupManagedMaintenanceJournal(): Promise<{
    readonly status: 'clean' | 'cleanup_pending' | 'rollback_pending'
  }> {
    return await this.#transaction<{
      readonly status: 'clean' | 'cleanup_pending' | 'rollback_pending'
    }>(async () => {
      const journal = await this.#loadMaintenanceJournal()
      if (journal === null) return [{status: 'clean'}, false]
      await this.#validateManagedRoot()
      const root = this.#requireManagedRootHandle()
      if (journal.phase === 'prepared') {
        const remaining: ManagedMaintenanceJournalEntry[] = []
        for (const entry of [...journal.entries].reverse()) {
          const tombstone = this.#lookupAt(root, entry.tombstone_name, 'workspace_boundary_changed')
          const original = this.#lookupAt(root, entry.original_name, 'workspace_boundary_changed')
          const temporary = entry.replacement_name === entry.original_name
            ? {status: 'missing'} as const
            : this.#lookupAt(root, entry.replacement_name, 'workspace_boundary_changed')
          if (tombstone.status === 'missing') {
            if (
              original.status !== 'ok'
              || !sameFileIdentity(original.identity, entry.identity)
              || temporary.status !== 'missing'
            ) {
              remaining.push(entry)
            } else {
              this.#restoreWorkspaceIdentity(entry.workspace_id, null, entry.identity)
            }
            continue
          }
          if (tombstone.status !== 'ok' || !sameFileIdentity(tombstone.identity, entry.identity)) {
            remaining.push(entry)
            continue
          }
          let replacementSafe = true
          const candidates = entry.replacement_name === entry.original_name
            ? [{name: entry.original_name, result: original}]
            : [
                {name: entry.original_name, result: original},
                {name: entry.replacement_name, result: temporary},
              ]
          for (const candidate of candidates) {
            if (candidate.result.status === 'missing') continue
            if (candidate.result.status !== 'ok') {
              replacementSafe = false
              continue
            }
            const bound = entry.replacement_identity !== null
              && sameFileIdentity(candidate.result.identity, entry.replacement_identity)
            const reservedUnboundTemporary = entry.replacement_identity === null
              && entry.replacement_name !== entry.original_name
              && candidate.name === entry.replacement_name
            if (!bound && !reservedUnboundTemporary) {
              replacementSafe = false
              continue
            }
            try {
              const removed = this.#unlinkAt(
                root,
                candidate.name,
                candidate.result.identity,
                'directory',
                'workspace_boundary_changed',
              )
              if (removed.status !== 'ok' && removed.status !== 'missing') replacementSafe = false
            } catch { replacementSafe = false }
          }
          if (!replacementSafe) {
            remaining.push(entry)
            continue
          }
          const originalAfter = this.#lookupAt(
            root, entry.original_name, 'workspace_boundary_changed',
          )
          if (originalAfter.status !== 'missing') {
            remaining.push(entry)
            continue
          }
          const restored = this.#renameManagedNoReplace(
            root, entry.tombstone_name, entry.original_name, entry.identity,
          )
          const restoredIdentity = this.#lookupAt(
            root, entry.original_name, 'workspace_boundary_changed',
          )
          if (
            restored.status !== 'ok'
            || restoredIdentity.status !== 'ok'
            || !sameFileIdentity(restoredIdentity.identity, entry.identity)
          ) {
            remaining.push(entry)
            continue
          }
          this.#restoreWorkspaceIdentity(
            entry.workspace_id,
            entry.replacement_identity,
            entry.identity,
          )
        }
        if (remaining.length === 0) {
          await this.#syncManagedRoot()
          await this.#clearMaintenanceJournal(journal.operation_id)
          return [{status: 'clean'}, false]
        }
        if (remaining.length !== journal.entries.length) {
          await this.#syncManagedRoot()
          await this.#writeMaintenanceJournal(Object.freeze({
            version: journal.version,
            operation_id: journal.operation_id,
            phase: 'prepared',
            entries: Object.freeze(remaining.reverse()),
          }))
        }
        return [{status: 'rollback_pending'}, false]
      }
      const remaining: ManagedMaintenanceJournalEntry[] = []
      for (const entry of journal.entries) {
        const result = this.#callRootFile(() => this.#rootFiles.removeTreeAt(
          root.fd, entry.tombstone_name, entry.identity,
        ))
        if (result.status !== 'ok' && result.status !== 'missing') remaining.push(entry)
        else if (result.status === 'ok') this.#maintenanceCheckpoint('cleanup_entry_deleted')
      }
      if (remaining.length === 0) {
        await this.#syncManagedRoot()
        await this.#clearMaintenanceJournal(journal.operation_id)
        return [{status: 'clean'}, false]
      }
      if (remaining.length !== journal.entries.length) {
        await this.#syncManagedRoot()
        await this.#writeMaintenanceJournal(Object.freeze({
          version: journal.version,
          operation_id: journal.operation_id,
          phase: 'committed',
          entries: Object.freeze(remaining),
        }))
      }
      return [{status: 'cleanup_pending'}, false]
    }, {wait: true})
  }

  async listWorkspaces(): Promise<readonly WorkspaceRecord[]> {
    return (await this.snapshot()).workspaces
  }

  async listSessions(workspace: string | WorkspaceRecord): Promise<readonly ProjectSessionRecord[]> {
    const workspaceId = typeof workspace === 'string' ? workspace : workspace.workspace_id
    return (await this.snapshot()).sessions.filter(session => session.workspace_id === workspaceId)
  }

  async ensureImported(displayName: string, workspace: HostWorkspace): Promise<WorkspaceRecord> {
    const requested = normalizeProjectWorkspaceName(displayName)
    const createdPin: {workspaceId: string; identity: FileIdentity}[] = []
    try {
      return await this.#transaction(async state => {
        const binding = await validateRegisteredWorkspace(hostWorkspacePath(workspace))
        const existing = [...state.workspaces.values()].find(
          record => record.canonical_path === binding.canonical,
        )
        if (existing !== undefined) {
          const approved = existing.origin === 'managed'
            ? await this.#validateManagedWorkspaceBinding(existing.canonical_path)
            : binding
          this.#pinWorkspaceIdentity(existing.workspace_id, approved.identity)
          if (state.activeWorkspaceId === null) {
            state.activeWorkspaceId = existing.workspace_id
            bumpActiveBindingRevision(state)
            return [existing, true]
          }
          return [existing, false]
        }
        requireWorkspaceCapacity(state)
        const unique = uniqueWorkspaceName(state, requested.display)
        const normalized = normalizeProjectWorkspaceName(unique)
        const record = this.#newWorkspace(state, normalized, binding.canonical, 'registered')
        this.#pinWorkspaceIdentity(record.workspace_id, binding.identity)
        createdPin.push({workspaceId: record.workspace_id, identity: binding.identity})
        state.workspaces.set(record.workspace_id, record)
        if (state.activeWorkspaceId === null) {
          state.activeWorkspaceId = record.workspace_id
          bumpActiveBindingRevision(state)
        }
        return [record, true]
      })
    } catch (error) {
      const created = createdPin[0]
      if (created !== undefined && !isCommittedTransactionFailure(error)) {
        this.#deleteWorkspaceIdentityIfExact(created.workspaceId, created.identity)
      }
      throw error
    }
  }

  async registerWorkspace(displayName: string, workspace: HostWorkspace): Promise<WorkspaceRecord> {
    const name = normalizeProjectWorkspaceName(displayName)
    const createdPin: {workspaceId: string; identity: FileIdentity}[] = []
    try {
      return await this.#transaction(async state => {
        const binding = await validateRegisteredWorkspace(hostWorkspacePath(workspace))
        requireWorkspaceCapacity(state)
        requireUniqueWorkspaceName(state, name.normalized)
        if ([...state.workspaces.values()].some(
          record => record.canonical_path === binding.canonical,
        )) {
          throw new ProjectStateError('workspace_path_conflict')
        }
        const record = this.#newWorkspace(state, name, binding.canonical, 'registered')
        this.#pinWorkspaceIdentity(record.workspace_id, binding.identity)
        createdPin.push({workspaceId: record.workspace_id, identity: binding.identity})
        state.workspaces.set(record.workspace_id, record)
        if (state.activeWorkspaceId === null) {
          state.activeWorkspaceId = record.workspace_id
          bumpActiveBindingRevision(state)
        }
        return [record, true]
      })
    } catch (error) {
      const created = createdPin[0]
      if (created !== undefined && !isCommittedTransactionFailure(error)) {
        this.#deleteWorkspaceIdentityIfExact(created.workspaceId, created.identity)
      }
      throw error
    }
  }

  async validateManagedCreate(displayName: string): Promise<string> {
    const name = normalizeProjectWorkspaceName(displayName)
    return await this.#transaction(state => {
      requireWorkspaceCapacity(state)
      requireUniqueWorkspaceName(state, name.normalized)
      return [name.display, false]
    })
  }

  async createManaged(displayName: string): Promise<WorkspaceRecord> {
    const name = normalizeProjectWorkspaceName(displayName)
    const rollback: {created: {
      readonly path: string
      readonly identity: FileIdentity | null
      readonly workspaceId: string
    } | null} = {created: null}
    try {
      return await this.#transaction(async state => {
        const managed = await this.#validateManagedRoot()
        const managedHandle = this.#requireManagedRootHandle()
        requireWorkspaceCapacity(state)
        requireUniqueWorkspaceName(state, name.normalized)
        const workspaceId = this.#newUniqueId(state)
        const candidate = join(managed, `${slugPrefix(name.display)}-${[...workspaceId].slice(-12).join('')}`)
        if (!isDirectChild(managed, candidate)) throw new ProjectStateError('workspace_boundary_changed')
        const candidateName = basename(candidate)
        let candidateFile: FileHandle | null = null
        try {
          const created = this.#mkdirPrivateAt(
            managedHandle,
            candidateName,
            'workspace_create_failed',
          )
          if (created.status === 'exists') throw new ProjectStateError('workspace_path_conflict')
          if (created.status !== 'ok') throw new ProjectStateError('workspace_create_failed')
          const initialIdentity = created.identity
          rollback.created = {path: candidate, identity: initialIdentity, workspaceId}
          candidateFile = await open(
            candidate,
            constants.O_RDONLY | directoryFlag() | noFollowFlag(),
          )
          this.#requireMatchesAt(
            managedHandle,
            candidateName,
            candidateFile,
            'workspace_boundary_changed',
          )
          const initialInfo = await candidateFile.stat({bigint: true})
          if (
            !initialInfo.isDirectory()
            || !sameFileIdentity(initialIdentity, fileIdentity(initialInfo))
          ) throw new ProjectStateError('workspace_boundary_changed')
          this.#protectAt(
            managedHandle,
            candidateName,
            candidateFile,
            'workspace_boundary_changed',
          )
          if (this.#platform !== 'win32') await candidateFile.chmod(0o700)
          const verified = await candidateFile.stat({bigint: true})
          const canonical = realpathSync(candidate)
          this.#requireMatchesAt(
            managedHandle,
            candidateName,
            candidateFile,
            'workspace_boundary_changed',
          )
          await this.#validateManagedRoot()
          if (
            !verified.isDirectory()
            || !privateDirectoryMetadata(verified, this.#platform)
            || canonical !== candidate
            || !isDirectChild(managed, canonical)
            || !sameFileIdentity(initialIdentity, fileIdentity(verified))
          ) {
            throw new ProjectStateError('workspace_boundary_changed')
          }
        } catch (error) {
          if (error instanceof ProjectStateError) throw error
          if (isNodeError(error, 'EEXIST')) throw new ProjectStateError('workspace_path_conflict')
          throw new ProjectStateError('workspace_create_failed')
        } finally {
          await candidateFile?.close().catch(() => undefined)
        }
        const stamp = this.#stamp()
        const record: WorkspaceRecord = Object.freeze({
          workspace_id: workspaceId,
          display_name: name.display,
          normalized_name: name.normalized,
          canonical_path: candidate,
          origin: 'managed',
          codex_home_key: `home-${workspaceId}`,
          active_session_id: null,
          created_at: stamp,
          last_used_at: stamp,
        })
        const created = rollback.created
        const createdIdentity = created?.identity
        if (createdIdentity === undefined || createdIdentity === null) {
          throw new ProjectStateError('workspace_create_failed')
        }
        this.#pinWorkspaceIdentity(workspaceId, createdIdentity)
        state.workspaces.set(workspaceId, record)
        state.activeWorkspaceId = workspaceId
        bumpActiveBindingRevision(state)
        return [record, true]
      })
    } catch (error) {
      const created = rollback.created
      if (created !== null && !isCommittedTransactionFailure(error)) {
        if (await this.#rollbackCreatedDirectory(created)) {
          const identity = created.identity
          if (identity !== null) {
            this.#deleteWorkspaceIdentityIfExact(created.workspaceId, identity)
          }
        }
      }
      throw error
    }
  }

  async rollbackManagedCreate(
    workspaceId: string,
    options?: ProjectTransactionWaitOptions,
  ): Promise<boolean> {
    const rollback: {removed: {
      readonly name: string
      readonly path: string
      readonly identity: FileIdentity
    } | null} = {removed: null}
    try {
      const result = await this.#transaction(async state => {
        const workspace = state.workspaces.get(workspaceId)
        if (workspace?.origin !== 'managed') return [false, false]
        if ([...state.sessions.values()].some(session => session.workspace_id === workspaceId)) {
          return [false, false]
        }
        const managed = await this.#validateManagedRoot()
        if (!isDirectChild(managed, workspace.canonical_path)) return [false, false]
        try {
          const binding = await this.#validateManagedWorkspaceBinding(workspace.canonical_path)
          const pinned = this.#workspaceIdentities.get(workspaceId)
          if (pinned !== undefined && !sameFileIdentity(pinned, binding.identity)) {
            return [false, false]
          }
          this.#pinWorkspaceIdentity(workspaceId, binding.identity)
          const name = basename(binding.canonical)
          const unlinked = this.#unlinkAt(
            this.#requireManagedRootHandle(),
            name,
            binding.identity,
            'directory',
            'workspace_boundary_changed',
          )
          if (unlinked.status !== 'ok') return [false, false]
          rollback.removed = {name, path: binding.canonical, identity: binding.identity}
        } catch {
          return [false, false]
        }
        state.workspaces.delete(workspaceId)
        if (state.activeWorkspaceId === workspaceId) {
          state.activeWorkspaceId = mostRecentlyUsed(state.workspaces.values())?.workspace_id ?? null
          bumpActiveBindingRevision(state)
        }
        return [true, true]
      }, options)
      const deleted = rollback.removed
      if (result && deleted !== null) {
        this.#deleteWorkspaceIdentityIfExact(workspaceId, deleted.identity)
      }
      return result
    } catch (error) {
      const deleted = rollback.removed
      if (deleted !== null) {
        if (isCommittedTransactionFailure(error)) {
          this.#deleteWorkspaceIdentityIfExact(workspaceId, deleted.identity)
        } else {
          await this.#restoreManagedDirectory(workspaceId, deleted)
        }
      }
      throw error
    }
  }

  async resolveWorkspace(displayName: string | null): Promise<WorkspaceRecord> {
    const normalized = displayName === null ? null : normalizeProjectWorkspaceName(displayName)
    return await this.#transaction(state => {
      const record = normalized === null
        ? (state.activeWorkspaceId === null ? undefined : state.workspaces.get(state.activeWorkspaceId))
        : [...state.workspaces.values()].find(item => item.normalized_name === normalized.normalized)
      if (record === undefined) throw new ProjectStateError('workspace_not_found')
      return [record, false]
    })
  }

  async selectWorkspace(displayName: string): Promise<WorkspaceRecord> {
    const name = normalizeProjectWorkspaceName(displayName)
    return await this.#transaction(state => {
      const found = [...state.workspaces.values()].find(
        record => record.normalized_name === name.normalized,
      )
      if (found === undefined) throw new ProjectStateError('workspace_not_found')
      const record = Object.freeze({...found, last_used_at: this.#stamp()})
      state.workspaces.set(record.workspace_id, record)
      state.activeWorkspaceId = record.workspace_id
      bumpActiveBindingRevision(state)
      return [record, true]
    })
  }

  /** Select the exact workspace that a user confirmed, with validation and mutation under one lock. */
  async selectWorkspaceExact(
    displayName: string,
    workspaceId: string,
  ): Promise<WorkspaceRecord> {
    const name = normalizeProjectWorkspaceName(displayName)
    return await this.#transaction(async state => {
      const found = state.workspaces.get(workspaceId)
      if (found?.normalized_name !== name.normalized) {
        throw new ProjectStateError('workspace_boundary_changed')
      }
      const binding = found.origin === 'managed'
        ? await this.#validateManagedWorkspaceBinding(found.canonical_path)
        : await validateRegisteredWorkspace(found.canonical_path, 'workspace_boundary_changed')
      this.#pinWorkspaceIdentity(found.workspace_id, binding.identity)
      const record = Object.freeze({...found, last_used_at: this.#stamp()})
      state.workspaces.set(record.workspace_id, record)
      state.activeWorkspaceId = record.workspace_id
      bumpActiveBindingRevision(state)
      return [record, true]
    })
  }

  async revalidateWorkspace(workspaceId: string): Promise<HostWorkspace> {
    return await this.#transaction(async state => {
      const workspace = state.workspaces.get(workspaceId)
      if (workspace === undefined) throw new ProjectStateError('workspace_not_found')
      let binding: DirectoryBinding
      if (workspace.origin === 'managed') {
        binding = await this.#validateManagedWorkspaceBinding(workspace.canonical_path)
      } else {
        binding = await validateRegisteredWorkspace(
          workspace.canonical_path,
          'workspace_boundary_changed',
        )
      }
      this.#pinWorkspaceIdentity(workspaceId, binding.identity)
      const {hostWorkspaceFromConfig} = await import('./codex-process-owner.js')
      return [hostWorkspaceFromConfig(binding.canonical, [binding.canonical]), false]
    })
  }

  /** Revalidate and activate the exact persisted resume target immediately before process setup. */
  async prepareSessionResume(
    workspaceId: string,
    sessionId: string,
    threadId: string,
  ): Promise<HostWorkspace> {
    return (await this.prepareSessionResumeForRun(workspaceId, sessionId, threadId)).workspace
  }

  /** Atomically activate a resume target and capture the exact state needed to undo it. */
  async prepareSessionResumeForRun(
    workspaceId: string,
    sessionId: string,
    threadId: string,
  ): Promise<PreparedSessionResume> {
    const expectedThread = validateThreadId(threadId)
    return await this.#transaction(async state => {
      const workspace = state.workspaces.get(workspaceId)
      const session = state.sessions.get(sessionId)
      if (workspace === undefined || session?.workspace_id !== workspaceId) {
        throw new ProjectStateError('session_workspace_mismatch')
      }
      if (
        session.state !== 'ready'
        || session.codex_thread_id !== expectedThread
      ) throw new ProjectStateError('session_unavailable')
      const previousActiveWorkspaceId = state.activeWorkspaceId
      const previousActiveSessionId = workspace.active_session_id
      const binding = workspace.origin === 'managed'
        ? await this.#validateManagedWorkspaceBinding(workspace.canonical_path)
        : await validateRegisteredWorkspace(workspace.canonical_path, 'workspace_boundary_changed')
      this.#pinWorkspaceIdentity(workspaceId, binding.identity)
      const stamp = this.#stamp()
      state.sessions.set(sessionId, Object.freeze({...session, last_used_at: stamp}))
      state.workspaces.set(workspaceId, Object.freeze({
        ...workspace,
        active_session_id: sessionId,
        last_used_at: stamp,
      }))
      state.activeWorkspaceId = workspaceId
      const activationRevision = bumpActiveBindingRevision(state)
      const rollback: SessionResumeRollback = Object.freeze({
        activationRevision,
        previousActiveWorkspaceId,
        workspaceId,
        previousActiveSessionId,
        resumedSessionId: sessionId,
      })
      const {hostWorkspaceFromConfig} = await import('./codex-process-owner.js')
      return [Object.freeze({
        workspace: hostWorkspaceFromConfig(binding.canonical, [binding.canonical]),
        rollback,
      }), true]
    })
  }

  /** Undo only the exact resume activation represented by the token. */
  async rollbackSessionResume(
    rollback: SessionResumeRollback,
    options?: ProjectTransactionWaitOptions,
  ): Promise<boolean> {
    return await this.#transaction(state => {
      const workspace = state.workspaces.get(rollback.workspaceId)
      if (
        workspace === undefined
        || state.activeBindingRevision !== rollback.activationRevision
        || state.activeWorkspaceId !== rollback.workspaceId
        || workspace.active_session_id !== rollback.resumedSessionId
      ) return [false, false]
      if (
        rollback.previousActiveWorkspaceId !== null
        && !state.workspaces.has(rollback.previousActiveWorkspaceId)
      ) return [false, false]
      if (rollback.previousActiveSessionId !== null) {
        const previousSession = state.sessions.get(rollback.previousActiveSessionId)
        if (previousSession?.workspace_id !== rollback.workspaceId) return [false, false]
      }
      state.workspaces.set(rollback.workspaceId, Object.freeze({
        ...workspace,
        active_session_id: rollback.previousActiveSessionId,
      }))
      state.activeWorkspaceId = rollback.previousActiveWorkspaceId
      bumpActiveBindingRevision(state)
      return [true, true]
    }, options)
  }

  async resolveSession(workspaceId: string, displayTitle: string | null): Promise<ProjectSessionRecord> {
    const title = displayTitle === null ? null : normalizeProjectSessionTitle(displayTitle)
    return await this.#transaction(state => {
      const workspace = state.workspaces.get(workspaceId)
      if (workspace === undefined) throw new ProjectStateError('workspace_not_found')
      const record = title === null
        ? (workspace.active_session_id === null ? undefined : state.sessions.get(workspace.active_session_id))
        : [...state.sessions.values()].find(
          session => session.workspace_id === workspaceId
            && session.normalized_title === title.normalized,
        )
      if (record === undefined) throw new ProjectStateError('session_not_found')
      return [record, false]
    })
  }

  async beginSession(workspaceId: string, displayTitle: string | null): Promise<ProjectSessionRecord> {
    return (await this.beginSessionForRun(workspaceId, displayTitle)).session
  }

  async beginSessionForRun(workspaceId: string, displayTitle: string | null): Promise<BegunSession> {
    const supplied = displayTitle === null ? null : normalizeProjectSessionTitle(displayTitle)
    return await this.#transaction(state => {
      const workspace = state.workspaces.get(workspaceId)
      if (workspace === undefined) throw new ProjectStateError('workspace_not_found')
      const previousActiveWorkspaceId = state.activeWorkspaceId
      const previousActiveSessionId = workspace.active_session_id
      pruneForSessionInsert(state, workspaceId)
      const base = supplied?.display ?? nextDefaultSessionTitle(state, workspaceId)
      const title = uniqueSessionTitle(state, workspaceId, base)
      const normalized = normalizeProjectSessionTitle(title)
      const stamp = this.#stamp()
      const sessionId = this.#newUniqueId(state)
      const session: ProjectSessionRecord = Object.freeze({
        session_id: sessionId,
        workspace_id: workspaceId,
        display_title: normalized.display,
        normalized_title: normalized.normalized,
        codex_thread_id: null,
        state: 'starting',
        created_at: stamp,
        last_used_at: stamp,
      })
      state.sessions.set(sessionId, session)
      state.workspaces.set(workspaceId, Object.freeze({
        ...workspace,
        active_session_id: sessionId,
        last_used_at: stamp,
      }))
      state.activeWorkspaceId = workspaceId
      const activationRevision = bumpActiveBindingRevision(state)
      const rollback: SessionStartRollback = Object.freeze({
        activationRevision,
        previousActiveWorkspaceId,
        workspaceId,
        previousActiveSessionId,
        startedSessionId: sessionId,
      })
      return [Object.freeze({session, rollback}), true]
    })
  }

  async rollbackSessionStart(
    sessionId: string,
    options?: ProjectTransactionWaitOptions,
  ): Promise<boolean> {
    return await this.#transaction(state => {
      const session = state.sessions.get(sessionId)
      if (session?.state !== 'starting' || session.codex_thread_id !== null) {
        return [false, false]
      }
      state.sessions.delete(sessionId)
      const workspace = state.workspaces.get(session.workspace_id)
      if (workspace?.active_session_id === sessionId) {
        const replacement = newestReadySession(state, workspace.workspace_id)
        state.workspaces.set(workspace.workspace_id, Object.freeze({
          ...workspace,
          active_session_id: replacement?.session_id ?? null,
        }))
        bumpActiveBindingRevision(state)
      }
      return [true, true]
    }, options)
  }

  async rollbackSessionStartForRun(
    rollback: SessionStartRollback,
    options?: ProjectTransactionWaitOptions,
  ): Promise<boolean> {
    return await this.#transaction(state => {
      const session = state.sessions.get(rollback.startedSessionId)
      if (
        session?.workspace_id !== rollback.workspaceId
        || session.state !== 'starting'
        || session.codex_thread_id !== null
      ) {
        return [false, false]
      }
      const workspace = state.workspaces.get(rollback.workspaceId)
      const exactActivation = workspace !== undefined
        && state.activeBindingRevision === rollback.activationRevision
        && state.activeWorkspaceId === rollback.workspaceId
        && workspace.active_session_id === rollback.startedSessionId
      state.sessions.delete(rollback.startedSessionId)
      let bindingChanged = false
      if (workspace?.active_session_id === rollback.startedSessionId) {
        const previousSession = rollback.previousActiveSessionId === null
          ? undefined
          : state.sessions.get(rollback.previousActiveSessionId)
        const restoredSession = previousSession?.workspace_id === rollback.workspaceId
          && previousSession.state === 'ready'
          ? previousSession
          : newestReadySession(state, rollback.workspaceId)
        state.workspaces.set(rollback.workspaceId, Object.freeze({
          ...workspace,
          active_session_id: restoredSession?.session_id ?? null,
        }))
        bindingChanged = true
      }
      if (
        exactActivation
        && (
          rollback.previousActiveWorkspaceId === null
          || state.workspaces.has(rollback.previousActiveWorkspaceId)
        )
      ) {
        state.activeWorkspaceId = rollback.previousActiveWorkspaceId
        bindingChanged = true
      }
      if (bindingChanged) bumpActiveBindingRevision(state)
      return [true, true]
    }, options)
  }

  async markSessionReady(
    sessionId: string,
    threadId: string,
    options?: ProjectTransactionWaitOptions,
  ): Promise<ProjectSessionRecord> {
    const cleanThreadId = validateThreadId(threadId)
    return await this.#transaction(state => {
      const session = state.sessions.get(sessionId)
      if (session === undefined) throw new ProjectStateError('session_not_found')
      if (session.state !== 'starting' || session.codex_thread_id !== null) {
        throw new ProjectStateError('session_state_conflict')
      }
      const ready: ProjectSessionRecord = Object.freeze({
        ...session,
        codex_thread_id: cleanThreadId,
        state: 'ready',
        last_used_at: this.#stamp(),
      })
      state.sessions.set(sessionId, ready)
      return [ready, true]
    }, options)
  }

  async markSessionUnavailable(
    sessionId: string,
    options?: ProjectTransactionWaitOptions,
  ): Promise<ProjectSessionRecord> {
    return await this.#transaction(state => {
      const session = state.sessions.get(sessionId)
      if (session === undefined) throw new ProjectStateError('session_not_found')
      const unavailable: ProjectSessionRecord = Object.freeze({
        ...session,
        state: 'unavailable',
        last_used_at: this.#stamp(),
      })
      state.sessions.set(sessionId, unavailable)
      const workspace = state.workspaces.get(session.workspace_id)
      if (workspace?.active_session_id === sessionId) {
        state.workspaces.set(workspace.workspace_id, Object.freeze({
          ...workspace,
          active_session_id: newestReadySession(state, workspace.workspace_id)?.session_id ?? null,
        }))
        bumpActiveBindingRevision(state)
      }
      return [unavailable, true]
    }, options)
  }

  async activateSession(workspaceId: string, sessionId: string): Promise<ProjectSessionRecord> {
    return await this.#transaction(state => {
      const workspace = state.workspaces.get(workspaceId)
      const session = state.sessions.get(sessionId)
      if (workspace === undefined) throw new ProjectStateError('workspace_not_found')
      if (session?.workspace_id !== workspaceId) {
        throw new ProjectStateError('session_workspace_mismatch')
      }
      if (session.state !== 'ready' || session.codex_thread_id === null) {
        throw new ProjectStateError('session_unavailable')
      }
      const stamp = this.#stamp()
      const activated = Object.freeze({...session, last_used_at: stamp})
      state.sessions.set(sessionId, activated)
      state.workspaces.set(workspaceId, Object.freeze({
        ...workspace,
        active_session_id: sessionId,
        last_used_at: stamp,
      }))
      state.activeWorkspaceId = workspaceId
      bumpActiveBindingRevision(state)
      return [activated, true]
    })
  }

  async persistentHome(workspaceId: string): Promise<HostCodexHome> {
    return await this.#transaction(async state => {
      const workspace = state.workspaces.get(workspaceId)
      if (workspace === undefined) throw new ProjectStateError('workspace_not_found')
      await this.#revalidateStateRoot()
      const stateRoot = this.#requireStateRootHandle()
      await this.#migrateLegacyCodexHomes(stateRoot)
      const homesRoot = join(this.#stateRoot, PROJECT_CODEX_HOMES_DIRECTORY)
      const home = join(homesRoot, workspace.codex_home_key)
      if (!isDirectChild(homesRoot, home)) throw new ProjectStateError('workspace_boundary_changed')
      let homes: {readonly file: FileHandle; readonly binding: DirectoryBinding} | null = null
      let workspaceHome: {readonly file: FileHandle; readonly binding: DirectoryBinding} | null = null
      try {
        homes = await this.#ensurePrivateDirectoryAt(
          stateRoot,
          this.#stateRoot,
          PROJECT_CODEX_HOMES_DIRECTORY,
        )
        workspaceHome = await this.#ensurePrivateDirectoryAt(
          homes.file,
          homes.binding.canonical,
          workspace.codex_home_key,
        )
        const canonical = workspaceHome.binding.canonical
        if (canonical !== home || !isDirectChild(homesRoot, canonical)) {
          throw new ProjectStateError('state_permissions')
        }
        await this.#revalidateStateRoot()
        this.#requireMatchesAt(
          stateRoot,
          PROJECT_CODEX_HOMES_DIRECTORY,
          homes.file,
          'state_permissions',
        )
        this.#requireMatchesAt(
          homes.file,
          workspace.codex_home_key,
          workspaceHome.file,
          'state_permissions',
        )
        const branded = hostPersistentCodexHomeFromConfig(canonical, [canonical])
        if (hostCodexHomeValue(branded).path !== canonical) {
          throw new ProjectStateError('state_permissions')
        }
        this.#requireMatchesAt(
          homes.file,
          workspace.codex_home_key,
          workspaceHome.file,
          'state_permissions',
        )
        return [branded, false]
      } finally {
        await workspaceHome?.file.close().catch(() => undefined)
        await homes?.file.close().catch(() => undefined)
      }
    })
  }

  async publicView(pendingConfirmation: boolean): Promise<PublicProjectView> {
    return (await this.publicContext(pendingConfirmation)).view
  }

  async publicContext(pendingConfirmation: boolean): Promise<PublicProjectContext> {
    const state = await this.snapshot()
    const workspace = state.workspaces.find(
      record => record.workspace_id === state.active_workspace_id,
    )
    const session = workspace?.active_session_id === null || workspace === undefined
      ? undefined
      : state.sessions.find(record => record.session_id === workspace.active_session_id)
    return Object.freeze({
      workspace_id: workspace?.workspace_id ?? null,
      view: Object.freeze({
        workspace_display_name: workspace?.display_name ?? null,
        session_title: session?.display_title ?? null,
        pending_confirmation: pendingConfirmation,
        pending_confirmation_busy: false,
      }),
    })
  }

  #newWorkspace(
    state: MutableProjectState,
    name: NormalizedProjectText,
    canonicalPath: string,
    origin: WorkspaceRecord['origin'],
  ): WorkspaceRecord {
    const workspaceId = this.#newUniqueId(state)
    const stamp = this.#stamp()
    return Object.freeze({
      workspace_id: workspaceId,
      display_name: name.display,
      normalized_name: name.normalized,
      canonical_path: canonicalPath,
      origin,
      codex_home_key: `home-${workspaceId}`,
      active_session_id: null,
      created_at: stamp,
      last_used_at: stamp,
    })
  }

  #newUniqueId(state: MutableProjectState): string {
    for (let attempt = 0; attempt < MAX_ID_FACTORY_ATTEMPTS; attempt += 1) {
      let value: unknown
      try {
        value = this.#idFactory()
      } catch {
        throw new ProjectStateError('id_factory_invalid')
      }
      if (typeof value !== 'string' || !STORED_ID.test(value)) {
        throw new ProjectStateError('id_factory_invalid')
      }
      if (
        !state.workspaces.has(value)
        && !state.sessions.has(value)
        && !this.#workspaceIdentities.has(value)
      ) return value
    }
    throw new ProjectStateError('id_factory_invalid')
  }

  #pinWorkspaceIdentity(workspaceId: string, identity: FileIdentity): void {
    const expected = this.#workspaceIdentities.get(workspaceId)
    if (expected !== undefined && !sameFileIdentity(expected, identity)) {
      throw new ProjectStateError('workspace_boundary_changed')
    }
    this.#workspaceIdentities.set(workspaceId, identity)
  }

  #advanceWorkspaceIdentity(
    workspaceId: string,
    expected: FileIdentity,
    replacement: FileIdentity,
  ): void {
    const current = this.#workspaceIdentities.get(workspaceId)
    if (current === undefined || !sameFileIdentity(current, expected)) {
      throw new ProjectStateError('workspace_boundary_changed')
    }
    this.#workspaceIdentities.set(workspaceId, replacement)
  }

  #restoreWorkspaceIdentity(
    workspaceId: string,
    replacement: FileIdentity | null,
    original: FileIdentity,
  ): void {
    const current = this.#workspaceIdentities.get(workspaceId)
    if (current === undefined || sameFileIdentity(current, original)) {
      this.#workspaceIdentities.set(workspaceId, original)
      return
    }
    if (replacement !== null && sameFileIdentity(current, replacement)) {
      this.#workspaceIdentities.set(workspaceId, original)
      return
    }
    throw new ProjectStateError('workspace_boundary_changed')
  }

  #deleteWorkspaceIdentityIfExact(workspaceId: string, identity: FileIdentity): void {
    const current = this.#workspaceIdentities.get(workspaceId)
    if (current !== undefined && sameFileIdentity(current, identity)) {
      this.#workspaceIdentities.delete(workspaceId)
    }
  }

  async #validateManagedWorkspaceBinding(path: string): Promise<DirectoryBinding> {
    const managed = await this.#validateManagedRoot()
    if (!isDirectChild(managed, path)) {
      throw new ProjectStateError('workspace_boundary_changed')
    }
    const root = this.#requireManagedRootHandle()
    let file: FileHandle | null = null
    try {
      file = await open(path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
      this.#requireMatchesAt(root, basename(path), file, 'workspace_boundary_changed')
      const info = await file.stat({bigint: true})
      const canonical = realpathSync(path)
      if (
        !info.isDirectory()
        || canonical !== path
        || !privateDirectoryMetadata(info, this.#platform)
        || !isDirectChild(managed, canonical)
      ) throw new Error('unsafe')
      await this.#validateManagedRoot()
      this.#requireMatchesAt(root, basename(path), file, 'workspace_boundary_changed')
      return {canonical, identity: fileIdentity(info)}
    } catch {
      throw new ProjectStateError('workspace_boundary_changed')
    } finally {
      await file?.close().catch(() => undefined)
    }
  }

  #stamp(): number {
    const value = this.#now()
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ProjectStateError('clock_invalid')
    }
    return value
  }

  async #transaction<T>(
    operation: (
      state: MutableProjectState,
    ) => TransactionResult<T> | Promise<TransactionResult<T>>,
    options?: ProjectTransactionWaitOptions,
  ): Promise<T> {
    if (this.#closed) throw new ProjectStateError('state_lock_failed')
    let complete!: () => void
    const ownership = new Promise<void>(resolveOwnership => { complete = resolveOwnership })
    this.#activeTransactions.add(ownership)
    try {
      await this.#revalidateStateRoot()
      const mayRecover = this.#recoverStarting && !this.#startupLoaded
      const held = await this.#openAndAcquireLock(
        PROJECT_TRANSACTION_LOCK_FILE,
        options?.wait === true || mayRecover,
        options?.signal,
      )
      let releaseFailure = false
      let committed = false
      try {
        await this.#revalidateStateRoot()
        const shouldRecover = this.#recoverStarting && !this.#startupLoaded
        const [state, recovered] = await this.#loadState(shouldRecover)
        const [value, changed] = await operation(state)
        if (recovered || changed) bumpStateRevision(state)
        validateState(state)
        if (recovered || changed) {
          await this.#saveState(state, () => { committed = true })
        }
        await this.#revalidateStateRoot()
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
  }

  async #retainManagedRoot(): Promise<void> {
    const retained = await openManagedRoot(this.#managedRoot, this.#platform)
    this.#managedRootHandle = retained.file
    this.#managedRootIdentity = retained.identity
  }

  #probeRootFileAuthority(): void {
    const stateRoot = this.#requireStateRootHandle()
    const managedRoot = this.#requireManagedRootHandle()
    if (
      this.#callRootFile(() => this.#rootFiles.probe(stateRoot.fd)).status !== 'ok'
      || this.#callRootFile(() => this.#rootFiles.probe(managedRoot.fd)).status !== 'ok'
    ) throw new ProjectStateError('state_permissions')
  }

  async #revalidateStateRoot(): Promise<void> {
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

  async #validateManagedRoot(): Promise<string> {
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

  #requireStateRootHandle(): FileHandle {
    if (this.#stateRootHandle === null) throw new ProjectStateError('state_permissions')
    return this.#stateRootHandle
  }

  #requireManagedRootHandle(): FileHandle {
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

  #requireMatchesAt(
    root: FileHandle,
    name: string,
    child: FileHandle,
    code: ProjectStateCode,
  ): void {
    requireProjectBasename(name, code)
    const result = this.#callRootFile(() => this.#rootFiles.matchesAt(root.fd, name, child.fd))
    if (result.status !== 'ok') throw new ProjectStateError(code)
  }

  #lookupAt(
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

  #mkdirAt(root: FileHandle, name: string, code: ProjectStateCode): ProjectRootFileCreateResult {
    requireProjectBasename(name, code)
    const result = this.#callRootFileCreate(() => this.#rootFiles.mkdirAt(root.fd, name))
    if (result.status === 'unsupported' || result.status === 'failed') {
      throw new ProjectStateError(code)
    }
    return result
  }

  #mkdirPrivateAt(
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

  #protectAt(root: FileHandle, name: string, child: FileHandle, code: ProjectStateCode): void {
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

  #renameManagedNoReplace(
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

  async #syncManagedRoot(): Promise<void> {
    await this.#validateManagedRoot()
    const root = this.#requireManagedRootHandle()
    const result = this.#callRootFile(
      () => this.#rootFiles.syncDirectory?.(root.fd) ?? {status: 'unsupported'},
    )
    if (result.status !== 'ok') throw new ProjectStateError('workspace_boundary_changed')
    await this.#validateManagedRoot()
  }

  #maintenanceCheckpoint(step: MaintenanceFaultStep): void {
    if (this.#maintenanceFault?.(step) === true) throw new MaintenanceFaultError(step)
  }

  async #migrateLegacyCodexHomes(root: FileHandle): Promise<void> {
    const current = this.#lookupAt(root, PROJECT_CODEX_HOMES_DIRECTORY, 'state_permissions')
    if (current.status === 'ok') return
    if (current.status !== 'missing') throw new ProjectStateError('state_permissions')
    const legacy = this.#lookupAt(
      root,
      LEGACY_PROJECT_CODEX_HOMES_DIRECTORY,
      'state_permissions',
    )
    if (legacy.status === 'missing') return
    if (legacy.status !== 'ok') throw new ProjectStateError('state_permissions')

    let legacyDirectory: {readonly file: FileHandle; readonly binding: DirectoryBinding} | null = null
    try {
      legacyDirectory = await this.#ensurePrivateDirectoryAt(
        root,
        this.#stateRoot,
        LEGACY_PROJECT_CODEX_HOMES_DIRECTORY,
      )
      if (!sameFileIdentity(legacy.identity, legacyDirectory.binding.identity)) {
        throw new ProjectStateError('state_permissions')
      }
      const currentAgain = this.#lookupAt(
        root,
        PROJECT_CODEX_HOMES_DIRECTORY,
        'state_permissions',
      )
      if (currentAgain.status === 'ok') return
      if (currentAgain.status !== 'missing') throw new ProjectStateError('state_permissions')
      await this.#revalidateStateRoot()
      this.#requireMatchesAt(
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
      this.#requireMatchesAt(
        root,
        PROJECT_CODEX_HOMES_DIRECTORY,
        legacyDirectory.file,
        'state_permissions',
      )
      const legacyAfter = this.#lookupAt(
        root,
        LEGACY_PROJECT_CODEX_HOMES_DIRECTORY,
        'state_permissions',
      )
      if (legacyAfter.status !== 'missing') throw new ProjectStateError('state_permissions')
      await this.#revalidateStateRoot()
    } finally {
      await legacyDirectory?.file.close().catch(() => undefined)
    }
  }

  #unlinkAt(
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

  async #ensurePrivateDirectoryAt(
    root: FileHandle,
    rootPath: string,
    name: string,
    exclusive = false,
  ): Promise<{readonly file: FileHandle; readonly binding: DirectoryBinding}> {
    requireProjectBasename(name, 'state_permissions')
    const created = this.#mkdirPrivateAt(root, name, 'state_permissions')
    if (created.status !== 'ok' && (!exclusive && created.status !== 'exists')) {
      throw new ProjectStateError('state_permissions')
    }
    const createdIdentity = created.status === 'ok' ? created.identity : null
    const path = join(rootPath, name)
    let file: FileHandle | null = null
    try {
      file = await open(path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
      this.#requireMatchesAt(root, name, file, 'state_permissions')
      const initialInfo = await file.stat({bigint: true})
      const initialIdentity = fileIdentity(initialInfo)
      if (createdIdentity !== null && !sameFileIdentity(createdIdentity, initialIdentity)) {
        throw new ProjectStateError('state_permissions')
      }
      this.#protectAt(root, name, file, 'state_permissions')
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
      this.#requireMatchesAt(root, name, file, 'state_permissions')
      return {file, binding: {canonical, identity}}
    } catch (error) {
      await file?.close().catch(() => undefined)
      if (createdIdentity !== null) {
        try {
          this.#unlinkAt(root, name, createdIdentity, 'directory', 'state_permissions')
        } catch {
          // A newly-created directory is removed only through an exact descriptor-relative match.
        }
      }
      if (error instanceof ProjectStateError) throw error
      throw new ProjectStateError('state_permissions')
    }
  }

  async #openAndAcquireLock(
    fileName: string,
    wait = false,
    signal?: AbortSignal,
  ): Promise<HeldLock> {
    const root = this.#requireStateRootHandle()
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
      this.#requireMatchesAt(root, fileName, file, 'state_permissions')
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
              await this.#revalidateStateRoot()
              this.#requireMatchesAt(root, fileName, file, 'state_permissions')
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
    await this.#revalidateStateRoot()
    const root = this.#requireStateRootHandle()
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
        await this.#revalidateStateRoot()
        if (this.#lookupAt(root, PROJECT_STATE_FILE, 'state_permissions').status !== 'missing') {
          throw new ProjectStateError('state_permissions')
        }
        return [emptyState(), false]
      }
      throw error
    }
    try {
      await this.#revalidateStateRoot()
      this.#requireMatchesAt(root, PROJECT_STATE_FILE, file, 'state_permissions')
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
      let recovered = false
      if (recoverStarting) {
        for (const [sessionId, session] of state.sessions) {
          if (session.state === 'starting' && session.codex_thread_id === null) {
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
    const root = this.#requireStateRootHandle()
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
        if (this.#lookupAt(
          root, PROJECT_MAINTENANCE_JOURNAL_FILE, 'state_permissions',
        ).status === 'missing') return null
      }
      throw new ProjectStateError('state_permissions')
    }
    try {
      await this.#revalidateStateRoot()
      this.#requireMatchesAt(root, PROJECT_MAINTENANCE_JOURNAL_FILE, file, 'state_permissions')
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

  async #loadMaintenanceJournal(): Promise<ManagedMaintenanceJournal | null> {
    return (await this.#readMaintenanceJournal())?.journal ?? null
  }

  async #writeMaintenanceJournal(journal: ManagedMaintenanceJournal): Promise<void> {
    const raw = Buffer.from(canonicalJsonWithNumberFormatter(
      encodeMaintenanceJournal(journal),
      () => undefined,
    ), 'utf8')
    if (raw.byteLength > MAX_MAINTENANCE_JOURNAL_BYTES) {
      throw new ProjectStateError('state_too_large')
    }
    const root = this.#requireStateRootHandle()
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
      this.#requireMatchesAt(root, tempName, file, 'state_permissions')
      await file.writeFile(raw)
      await file.sync()
      await file.close()
      file = null
      const before = this.#lookupAt(root, tempName, 'state_permissions')
      if (before.status !== 'ok' || !sameFileIdentity(before.identity, created.identity)) {
        throw new ProjectStateError('state_permissions')
      }
      this.#renameAt(root, tempName, PROJECT_MAINTENANCE_JOURNAL_FILE)
      const after = this.#lookupAt(root, PROJECT_MAINTENANCE_JOURNAL_FILE, 'state_permissions')
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

  async #clearMaintenanceJournal(expectedOperationId: string): Promise<void> {
    const loaded = await this.#readMaintenanceJournal()
    if (loaded === null) return
    if (loaded.journal.operation_id !== expectedOperationId) {
      throw new ProjectStateError('state_busy')
    }
    const result = this.#unlinkAt(
      this.#requireStateRootHandle(),
      PROJECT_MAINTENANCE_JOURNAL_FILE,
      loaded.identity,
      'file',
      'state_write_failed',
    )
    if (result.status !== 'ok') throw new ProjectStateError('state_write_failed')
    if (this.#platform !== 'win32') await this.#requireStateRootHandle().sync()
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
    const root = this.#requireStateRootHandle()
    const tempName = `.${PROJECT_STATE_FILE}.${randomUUID()}.tmp`
    requireProjectBasename(tempName, 'state_write_failed')
    const temp = join(this.#stateRoot, tempName)
    let file: FileHandle | null = null
    let tempIdentity: FileIdentity | null = null
    try {
      await this.#revalidateStateRoot()
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
      await this.#revalidateStateRoot()
      this.#requireMatchesAt(root, tempName, file, 'state_permissions')
      this.#publishDurability('temp_open')
      await file.writeFile(raw)
      await file.sync()
      this.#publishDurability('file_fsync')
      await file.close()
      file = null
      await this.#revalidateStateRoot()
      const beforeRename = this.#lookupAt(root, tempName, 'state_permissions')
      if (
        beforeRename.status !== 'ok'
        || tempIdentity === null
        || !sameFileIdentity(beforeRename.identity, tempIdentity)
      ) throw new ProjectStateError('state_permissions')
      this.#renameAt(root, tempName, PROJECT_STATE_FILE)
      markCommitted()
      this.#publishDurability('atomic_replace')
      await this.#revalidateStateRoot()
      const replaced = this.#lookupAt(root, PROJECT_STATE_FILE, 'state_permissions')
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
      await this.#revalidateStateRoot()
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
      const root = this.#requireStateRootHandle()
      const result = this.#unlinkAt(root, name, expected, 'file', 'state_write_failed')
      if (result.status === 'ok' || result.status === 'missing' || result.status === 'mismatch') return
    } catch {
      // Exact descriptor-relative cleanup is best effort and never falls back to a path delete.
    }
  }

  async #rollbackCreatedDirectory(candidate: {
    readonly path: string
    readonly identity: FileIdentity | null
    readonly workspaceId: string
  }): Promise<boolean> {
    if (candidate.identity === null) return false
    let file: FileHandle | null = null
    try {
      const managed = await this.#validateManagedRoot()
      if (!isDirectChild(managed, candidate.path)) return false
      const root = this.#requireManagedRootHandle()
      const name = basename(candidate.path)
      file = await open(candidate.path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
      this.#requireMatchesAt(root, name, file, 'workspace_boundary_changed')
      const info = await file.stat({bigint: true})
      const canonical = realpathSync(candidate.path)
      if (
        !info.isDirectory()
        || !privateDirectoryMetadata(info, this.#platform)
        || !sameFileIdentity(candidate.identity, fileIdentity(info))
        || canonical !== candidate.path
      ) return false
      this.#requireMatchesAt(root, name, file, 'workspace_boundary_changed')
      const removed = this.#unlinkAt(
        root,
        name,
        candidate.identity,
        'directory',
        'workspace_boundary_changed',
      )
      if (removed.status !== 'ok') return false
      await this.#validateManagedRoot()
      return true
    } catch {
      // Rollback is best effort and never removes an unproven replacement or non-empty directory.
      return false
    } finally {
      await file?.close().catch(() => undefined)
    }
  }

  async #restoreManagedDirectory(
    workspaceId: string,
    removed: {readonly name: string; readonly path: string; readonly identity: FileIdentity},
  ): Promise<void> {
    let file: FileHandle | null = null
    let createdRoot: FileHandle | null = null
    let createdIdentity: FileIdentity | null = null
    let adopted = false
    try {
      const managed = await this.#validateManagedRoot()
      if (!isDirectChild(managed, removed.path)) return
      const root = this.#requireManagedRootHandle()
      const created = this.#mkdirPrivateAt(root, removed.name, 'workspace_boundary_changed')
      if (created.status !== 'ok') return
      createdRoot = root
      createdIdentity = created.identity
      file = await open(removed.path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
      this.#requireMatchesAt(root, removed.name, file, 'workspace_boundary_changed')
      const initialInfo = await file.stat({bigint: true})
      if (!sameFileIdentity(created.identity, fileIdentity(initialInfo))) return
      this.#protectAt(root, removed.name, file, 'workspace_boundary_changed')
      if (this.#platform !== 'win32') await file.chmod(0o700)
      const info = await file.stat({bigint: true})
      const canonical = realpathSync(removed.path)
      if (
        !info.isDirectory()
        || !privateDirectoryMetadata(info, this.#platform)
        || canonical !== removed.path
      ) return
      this.#requireMatchesAt(root, removed.name, file, 'workspace_boundary_changed')
      const current = this.#workspaceIdentities.get(workspaceId)
      if (current !== undefined && sameFileIdentity(current, removed.identity)) {
        this.#workspaceIdentities.set(workspaceId, fileIdentity(info))
        adopted = true
      }
    } catch {
      // A failed transaction leaves the original pin in place unless an exact safe restore succeeds.
    } finally {
      await file?.close().catch(() => undefined)
      if (!adopted && createdRoot !== null && createdIdentity !== null) {
        try {
          this.#unlinkAt(
            createdRoot,
            removed.name,
            createdIdentity,
            'directory',
            'workspace_boundary_changed',
          )
        } catch {
          // A restore failure never removes an unproven same-name replacement.
        }
      }
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

function requireProjectBasename(name: string, code: ProjectStateCode): void {
  if (
    typeof name !== 'string'
    || name === ''
    || !isWellFormed(name)
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes('\0')
    || name.includes('://')
    || /^[A-Za-z]:/u.test(name)
    || basename(name) !== name
  ) throw new ProjectStateError(code)
}

function isCommittedTransactionFailure(error: unknown): boolean {
  return error instanceof TransactionProjectStateError && error.committed
}

export function normalizeProjectWorkspaceName(value: unknown): NormalizedProjectText {
  const result = normalizePublicText(value, MAX_PROJECT_WORKSPACE_NAME, 'workspace_name_invalid')
  if (
    result.display.includes('/')
    || result.display.includes('\\')
    || result.display.includes('://')
    || /^[A-Za-z]:/u.test(result.display)
    || result.display === '.'
    || result.display === '..'
  ) throw new ProjectStateError('workspace_name_invalid')
  return result
}

export function normalizeProjectSessionTitle(value: unknown): NormalizedProjectText {
  return normalizePublicText(value, MAX_PROJECT_SESSION_TITLE, 'session_title_invalid')
}

function normalizePublicText(
  value: unknown,
  limit: number,
  code: 'workspace_name_invalid' | 'session_title_invalid',
): NormalizedProjectText {
  if (typeof value !== 'string' || !isWellFormed(value)) throw new ProjectStateError(code)
  const stripped = stripLikePython(normalizeNfkcPinned(value))
  const pieces: string[] = []
  let current = ''
  for (const character of stripped) {
    if (isPythonSpace(character)) {
      if (current !== '') {
        pieces.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (current !== '') pieces.push(current)
  const display = pieces.join(' ')
  if (
    display === ''
    || [...display].length > limit
    || [...display].some(character => {
      const codePoint = character.codePointAt(0)
      return codePoint === undefined || isOtherCategory(codePoint)
    })
  ) throw new ProjectStateError(code)
  return Object.freeze({display, normalized: casefoldLikePython(display)})
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

async function validateRegisteredWorkspace(
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

function privateDirectoryMetadata(
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

function fileIdentity(info: {readonly dev: bigint; readonly ino: bigint}): FileIdentity {
  return Object.freeze({device: info.dev, inode: info.ino})
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
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

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError'
}

function projectAbortError(): Error {
  const error = new Error('project state operation aborted')
  error.name = 'AbortError'
  return error
}

function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0
}

function directoryFlag(): number {
  return constants.O_DIRECTORY ?? 0
}

function nonblockFlag(): number {
  return constants.O_NONBLOCK ?? 0
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

function isDirectChild(parent: string, child: string): boolean {
  return child !== parent && dirname(child) === parent
}

function emptyState(): MutableProjectState {
  return {
    stateRevision: 0,
    activeBindingRevision: 0,
    activeWorkspaceId: null,
    workspaces: new Map(),
    sessions: new Map(),
  }
}

function snapshotState(state: MutableProjectState): ProjectSnapshot {
  return Object.freeze({
    version: PROJECT_STATE_VERSION,
    state_revision: state.stateRevision,
    active_binding_revision: state.activeBindingRevision,
    active_workspace_id: state.activeWorkspaceId,
    workspaces: Object.freeze([...state.workspaces.values()].sort(compareCreated)),
    sessions: Object.freeze([...state.sessions.values()].sort(compareCreated)),
  })
}

function compareCreated(
  left: {readonly created_at: number; readonly workspace_id?: string; readonly session_id?: string},
  right: {readonly created_at: number; readonly workspace_id?: string; readonly session_id?: string},
): number {
  return left.created_at - right.created_at
    || compareCodePoints(left.workspace_id ?? left.session_id ?? '', right.workspace_id ?? right.session_id ?? '')
}

function mostRecentlyUsed<T extends {
  readonly last_used_at: number
  readonly created_at: number
  readonly workspace_id: string
}>(
  values: Iterable<T>,
): T | undefined {
  return [...values].sort((left, right) =>
    right.last_used_at - left.last_used_at
    || right.created_at - left.created_at
    || compareCodePoints(right.workspace_id, left.workspace_id),
  )[0]
}

function requireWorkspaceCapacity(state: MutableProjectState): void {
  if (state.workspaces.size >= MAX_PROJECT_WORKSPACES) throw new ProjectStateError('workspace_limit')
}

function requireUniqueWorkspaceName(state: MutableProjectState, normalized: string): void {
  if ([...state.workspaces.values()].some(record => record.normalized_name === normalized)) {
    throw new ProjectStateError('workspace_name_conflict')
  }
}

function uniqueWorkspaceName(state: MutableProjectState, base: string): string {
  if (![...state.workspaces.values()].some(
    record => record.normalized_name === normalizeProjectWorkspaceName(base).normalized,
  )) return base
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const ending = ` (${suffix})`
    const clipped = stripLikePython([...base].slice(0, Math.max(1, MAX_PROJECT_WORKSPACE_NAME - [...ending].length)).join(''))
    const candidate = `${clipped}${ending}`
    if (![...state.workspaces.values()].some(
      record => record.normalized_name === normalizeProjectWorkspaceName(candidate).normalized,
    )) return candidate
  }
  throw new ProjectStateError('workspace_limit')
}

function nextDefaultSessionTitle(state: MutableProjectState, workspaceId: string): string {
  let largest = 0n
  for (const session of state.sessions.values()) {
    if (session.workspace_id !== workspaceId) continue
    const match = DEFAULT_SESSION_TITLE.exec(session.display_title)
    const digits = match?.[1]
    if (digits !== undefined && digits.length <= MAX_DEFAULT_SESSION_DIGITS) {
      const value = BigInt(digits)
      if (value > largest) largest = value
    }
  }
  const generated = `${DEFAULT_SESSION_PREFIX}${largest + 1n}`
  normalizeProjectSessionTitle(generated)
  return generated
}

function uniqueSessionTitle(state: MutableProjectState, workspaceId: string, base: string): string {
  const exists = (candidate: string): boolean => {
    const normalized = normalizeProjectSessionTitle(candidate).normalized
    return [...state.sessions.values()].some(
      session => session.workspace_id === workspaceId && session.normalized_title === normalized,
    )
  }
  if (!exists(base)) return base
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const ending = ` (${suffix})`
    const clipped = stripLikePython([...base].slice(0, Math.max(1, MAX_PROJECT_SESSION_TITLE - [...ending].length)).join(''))
    const candidate = `${clipped}${ending}`
    if (!exists(candidate)) return candidate
  }
  throw new ProjectStateError('session_limit')
}

function pruneForSessionInsert(state: MutableProjectState, workspaceId: string): void {
  const workspaceCount = (): number => [...state.sessions.values()].filter(
    session => session.workspace_id === workspaceId,
  ).length
  while (
    workspaceCount() >= MAX_PROJECT_SESSIONS_PER_WORKSPACE
    || state.sessions.size >= MAX_PROJECT_SESSIONS_TOTAL
  ) {
    const activeIds = new Set([...state.workspaces.values()].flatMap(
      workspace => workspace.active_session_id === null ? [] : [workspace.active_session_id],
    ))
    const targetOnly = workspaceCount() >= MAX_PROJECT_SESSIONS_PER_WORKSPACE
    const candidates = [...state.sessions.values()].filter(session =>
      session.state !== 'starting'
      && !activeIds.has(session.session_id)
      && (!targetOnly || session.workspace_id === workspaceId),
    ).sort((left, right) =>
      (left.state === 'unavailable' ? 0 : 1) - (right.state === 'unavailable' ? 0 : 1)
      || left.last_used_at - right.last_used_at
      || left.created_at - right.created_at
      || compareCodePoints(left.session_id, right.session_id),
    )
    const candidate = candidates[0]
    if (candidate === undefined) throw new ProjectStateError('session_limit')
    state.sessions.delete(candidate.session_id)
  }
}

function newestReadySession(
  state: MutableProjectState,
  workspaceId: string,
): ProjectSessionRecord | undefined {
  return [...state.sessions.values()].filter(
    session => session.workspace_id === workspaceId && session.state === 'ready',
  ).sort((left, right) =>
    right.last_used_at - left.last_used_at
    || right.created_at - left.created_at
    || compareCodePoints(right.session_id, left.session_id),
  )[0]
}

function slugPrefix(display: string): string {
  const pieces: string[] = []
  for (const character of casefoldLikePython(display)) {
    const codePoint = character.codePointAt(0)
    const alphanumeric = codePoint !== undefined
      && (isLetterCategory(codePoint) || isNumberCategory(codePoint))
    if (alphanumeric) pieces.push(character)
    else if ((isPythonSpace(character) || character === '-' || character === '_') && pieces.at(-1) !== '-') {
      if (pieces.length > 0) pieces.push('-')
    }
  }
  const prefix = [...stripLikePython(pieces.join('').replace(/^-+|-+$/gu, ''))].slice(0, 32).join('').replace(/-+$/gu, '')
  return prefix === '' ? 'workspace' : prefix
}

function validateThreadId(value: unknown): string {
  if (
    typeof value !== 'string'
    || !isWellFormed(value)
    || [...value].length < 1
    || [...value].length > MAX_PROJECT_THREAD_ID
    || [...value].some(character => {
      const codePoint = character.codePointAt(0)
      return codePoint === undefined || isOtherCategory(codePoint)
    })
  ) throw new ProjectStateError('thread_id_invalid')
  return value
}

function encodeState(state: MutableProjectState): Readonly<Record<string, unknown>> {
  return {
    version: PROJECT_STATE_VERSION,
    state_revision: state.stateRevision,
    active_binding_revision: state.activeBindingRevision,
    active_workspace_id: state.activeWorkspaceId,
    workspaces: Object.fromEntries([...state.workspaces].map(([key, value]) => [key, {...value}])),
    sessions: Object.fromEntries([...state.sessions].map(([key, value]) => [key, {...value}])),
  }
}

function encodeMaintenanceJournal(journal: ManagedMaintenanceJournal): Readonly<Record<string, unknown>> {
  return {
    entries: journal.entries.map(entry => {
      const encoded = {
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
      }
      return journal.version === 1
        ? encoded
        : {...encoded, replacement_name: entry.replacement_name}
    }),
    operation_id: journal.operation_id,
    phase: journal.phase,
    version: journal.version,
  }
}

function decodeMaintenanceJournal(value: unknown): ManagedMaintenanceJournal {
  const root = exactRecord(value, ['entries', 'operation_id', 'phase', 'version'])
  if (
    (root.version !== 1 && root.version !== 2)
    || !Array.isArray(root.entries)
    || root.entries.length > MAX_PROJECT_WORKSPACES
  ) {
    throw new ProjectStateError('state_corrupt')
  }
  const operationId = storedId(root.operation_id)
  if (root.phase !== 'prepared' && root.phase !== 'committed') {
    throw new ProjectStateError('state_corrupt')
  }
  const entries = root.entries.map(raw => {
    const entry = exactRecord(raw, root.version === 1
      ? ['identity', 'original_name', 'replacement_identity', 'tombstone_name', 'workspace_id']
      : [
          'identity', 'original_name', 'replacement_identity', 'replacement_name',
          'tombstone_name', 'workspace_id',
        ])
    const identity = exactRecord(entry.identity, ['device', 'inode'])
    const replacementIdentity = entry.replacement_identity === null
      ? null
      : exactRecord(entry.replacement_identity, ['device', 'inode'])
    if (typeof entry.original_name !== 'string') throw new ProjectStateError('state_corrupt')
    requireProjectBasename(entry.original_name, 'state_corrupt')
    if (
      typeof entry.tombstone_name !== 'string'
      || MAINTENANCE_TOMBSTONE.exec(entry.tombstone_name)?.[1] !== operationId
    ) throw new ProjectStateError('state_corrupt')
    const replacementName = root.version === 1 ? entry.original_name : entry.replacement_name
    if (
      typeof replacementName !== 'string'
      || (root.version === 2
        && (
          MAINTENANCE_REPLACEMENT.exec(replacementName)?.[1] !== operationId
          || replacementName !== entry.tombstone_name.replace(
            '.nova-maintenance-',
            '.nova-replacement-',
          )
        ))
    ) throw new ProjectStateError('state_corrupt')
    return Object.freeze({
      workspace_id: storedId(entry.workspace_id),
      original_name: entry.original_name,
      tombstone_name: entry.tombstone_name,
      replacement_name: replacementName,
      identity: Object.freeze({
        device: decimalIdentity(identity.device),
        inode: decimalIdentity(identity.inode),
      }),
      replacement_identity: replacementIdentity === null ? null : Object.freeze({
        device: decimalIdentity(replacementIdentity.device),
        inode: decimalIdentity(replacementIdentity.inode),
      }),
    })
  })
  if (
    entries.length === 0
    || new Set(entries.map(entry => entry.workspace_id)).size !== entries.length
    || new Set(entries.map(entry => entry.original_name)).size !== entries.length
    || new Set(entries.map(entry => entry.tombstone_name)).size !== entries.length
    || new Set(entries.map(entry => entry.replacement_name)).size !== entries.length
  ) {
    throw new ProjectStateError('state_corrupt')
  }
  if (root.phase === 'committed' && entries.some(entry => entry.replacement_identity === null)) {
    throw new ProjectStateError('state_corrupt')
  }
  return Object.freeze({
    version: root.version,
    operation_id: operationId,
    phase: root.phase,
    entries: Object.freeze(entries),
  })
}

function decimalIdentity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,39})$/u.test(value)) {
    throw new ProjectStateError('state_corrupt')
  }
  const parsed = BigInt(value)
  if (parsed > 18_446_744_073_709_551_615n) throw new ProjectStateError('state_corrupt')
  return parsed
}

function projectTimestampNumber(value: number, path: CanonicalJsonPath): string | undefined {
  if (path.length !== 3) return undefined
  const [collection, recordId, field] = path
  if (
    (collection !== 'workspaces' && collection !== 'sessions')
    || typeof recordId !== 'string'
    || (field !== 'created_at' && field !== 'last_used_at')
  ) return undefined
  return pythonFloat(value)
}

function decodeState(value: unknown): MutableProjectState {
  const candidate = recordValue(value)
  const rootKeys = ['version', 'active_workspace_id', 'workspaces', 'sessions']
  if (Object.hasOwn(candidate, 'state_revision')) rootKeys.push('state_revision')
  if (Object.hasOwn(candidate, 'active_binding_revision')) rootKeys.push('active_binding_revision')
  const root = exactRecord(candidate, rootKeys)
  if (root.version !== PROJECT_STATE_VERSION) throw new ProjectStateError('state_version_unsupported')
  const rawWorkspaces = recordValue(root.workspaces)
  const rawSessions = recordValue(root.sessions)
  if (Object.keys(rawWorkspaces).length > MAX_PROJECT_WORKSPACES) throw new ProjectStateError('state_corrupt')
  if (Object.keys(rawSessions).length > MAX_PROJECT_SESSIONS_TOTAL) throw new ProjectStateError('state_corrupt')
  const state = emptyState()
  state.stateRevision = Object.hasOwn(root, 'state_revision')
    ? stateRevision(root.state_revision)
    : 0
  state.activeBindingRevision = Object.hasOwn(root, 'active_binding_revision')
    ? activeBindingRevision(root.active_binding_revision)
    : 0
  for (const [key, raw] of Object.entries(rawWorkspaces)) {
    const workspace = decodeWorkspace(raw)
    if (key !== workspace.workspace_id || state.workspaces.has(key)) throw new ProjectStateError('state_corrupt')
    state.workspaces.set(key, workspace)
  }
  for (const [key, raw] of Object.entries(rawSessions)) {
    const session = decodeSession(raw)
    if (
      key !== session.session_id
      || state.sessions.has(key)
      || !state.workspaces.has(session.workspace_id)
    ) throw new ProjectStateError('state_corrupt')
    state.sessions.set(key, session)
  }
  const active = root.active_workspace_id
  if (active !== null && (typeof active !== 'string' || !state.workspaces.has(active))) {
    throw new ProjectStateError('state_corrupt')
  }
  state.activeWorkspaceId = active
  validateState(state)
  return state
}

function decodeWorkspace(value: unknown): WorkspaceRecord {
  const raw = exactRecord(value, [
    'workspace_id', 'display_name', 'normalized_name', 'canonical_path', 'origin',
    'codex_home_key', 'active_session_id', 'created_at', 'last_used_at',
  ])
  const workspaceId = storedId(raw.workspace_id)
  const name = normalizeProjectWorkspaceName(raw.display_name)
  if (raw.normalized_name !== name.normalized) throw new ProjectStateError('state_corrupt')
  if (
    typeof raw.canonical_path !== 'string'
    || !isWellFormed(raw.canonical_path)
    || !isAbsolute(raw.canonical_path)
  ) throw new ProjectStateError('state_corrupt')
  if (raw.origin !== 'managed' && raw.origin !== 'registered') throw new ProjectStateError('state_corrupt')
  if (raw.codex_home_key !== `home-${workspaceId}`) throw new ProjectStateError('state_corrupt')
  const activeSessionId = raw.active_session_id === null ? null : storedId(raw.active_session_id)
  return Object.freeze({
    workspace_id: workspaceId,
    display_name: name.display,
    normalized_name: name.normalized,
    canonical_path: raw.canonical_path,
    origin: raw.origin,
    codex_home_key: raw.codex_home_key,
    active_session_id: activeSessionId,
    created_at: timestamp(raw.created_at),
    last_used_at: timestamp(raw.last_used_at),
  })
}

function decodeSession(value: unknown): ProjectSessionRecord {
  const raw = exactRecord(value, [
    'session_id', 'workspace_id', 'display_title', 'normalized_title', 'codex_thread_id',
    'state', 'created_at', 'last_used_at',
  ])
  const title = normalizeProjectSessionTitle(raw.display_title)
  if (raw.normalized_title !== title.normalized) throw new ProjectStateError('state_corrupt')
  if (raw.state !== 'starting' && raw.state !== 'ready' && raw.state !== 'unavailable') {
    throw new ProjectStateError('state_corrupt')
  }
  const threadId = raw.codex_thread_id === null ? null : validateThreadId(raw.codex_thread_id)
  if ((raw.state === 'ready' && threadId === null) || (raw.state === 'starting' && threadId !== null)) {
    throw new ProjectStateError('state_corrupt')
  }
  return Object.freeze({
    session_id: storedId(raw.session_id),
    workspace_id: storedId(raw.workspace_id),
    display_title: title.display,
    normalized_title: title.normalized,
    codex_thread_id: threadId,
    state: raw.state,
    created_at: timestamp(raw.created_at),
    last_used_at: timestamp(raw.last_used_at),
  })
}

function validateState(state: MutableProjectState): void {
  stateRevision(state.stateRevision)
  activeBindingRevision(state.activeBindingRevision)
  if (state.workspaces.size > MAX_PROJECT_WORKSPACES || state.sessions.size > MAX_PROJECT_SESSIONS_TOTAL) {
    throw new ProjectStateError('state_corrupt')
  }
  if (state.activeWorkspaceId !== null && !state.workspaces.has(state.activeWorkspaceId)) {
    throw new ProjectStateError('state_corrupt')
  }
  const workspaceNames = new Set<string>()
  const sessionTitles = new Set<string>()
  for (const workspace of state.workspaces.values()) {
    if (workspaceNames.has(workspace.normalized_name)) throw new ProjectStateError('state_corrupt')
    workspaceNames.add(workspace.normalized_name)
    if (workspace.active_session_id !== null) {
      const session = state.sessions.get(workspace.active_session_id)
      if (session?.workspace_id !== workspace.workspace_id) throw new ProjectStateError('state_corrupt')
    }
    if ([...state.sessions.values()].filter(
      session => session.workspace_id === workspace.workspace_id,
    ).length > MAX_PROJECT_SESSIONS_PER_WORKSPACE) throw new ProjectStateError('state_corrupt')
  }
  for (const session of state.sessions.values()) {
    if (!state.workspaces.has(session.workspace_id)) throw new ProjectStateError('state_corrupt')
    const key = `${session.workspace_id}\u0000${session.normalized_title}`
    if (sessionTitles.has(key)) throw new ProjectStateError('state_corrupt')
    sessionTitles.add(key)
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectStateError('state_corrupt')
  }
  const record = value as Readonly<Record<string, unknown>>
  const actual = Object.keys(record)
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    throw new ProjectStateError('state_corrupt')
  }
  return record
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectStateError('state_corrupt')
  }
  return value as Readonly<Record<string, unknown>>
}

function storedId(value: unknown): string {
  if (typeof value !== 'string' || !STORED_ID.test(value)) throw new ProjectStateError('state_corrupt')
  return value
}

function activeBindingRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProjectStateError('state_corrupt')
  }
  return value
}

function stateRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProjectStateError('state_corrupt')
  }
  return value
}

function bumpStateRevision(state: MutableProjectState): number {
  if (!Number.isSafeInteger(state.stateRevision) || state.stateRevision < 0
    || state.stateRevision >= Number.MAX_SAFE_INTEGER) {
    throw new ProjectStateError('state_corrupt')
  }
  state.stateRevision += 1
  return state.stateRevision
}

function bumpActiveBindingRevision(state: MutableProjectState): number {
  if (!Number.isSafeInteger(state.activeBindingRevision) || state.activeBindingRevision < 0
    || state.activeBindingRevision >= Number.MAX_SAFE_INTEGER) {
    throw new ProjectStateError('state_corrupt')
  }
  state.activeBindingRevision += 1
  return state.activeBindingRevision
}

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ProjectStateError('state_corrupt')
  return value
}
