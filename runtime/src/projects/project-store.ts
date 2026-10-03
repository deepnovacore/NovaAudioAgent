import {randomUUID} from 'node:crypto'
import {constants, realpathSync} from 'node:fs'
import {open, realpath, type FileHandle} from 'node:fs/promises'
import {basename, join} from 'node:path'
import {CODING_BACKEND_IDS} from '../config/coding-backends.js'
import {stripLikePython} from '../text/python-text.js'
import {
  hostHomeValue,
  hostPersistentHomeFromConfig,
  hostWorkspaceFromConfig,
  hostWorkspacePath,
  type HostStateHome,
  type HostWorkspace,
} from './host-paths.js'
import {type ProjectFileIdentity} from './project-root-file.js'
import {
  bumpActiveBindingRevision,
  compareCreated,
  MAINTENANCE_TOMBSTONE,
  MAX_PROJECT_SESSION_TITLE,
  mostRecentlyUsed,
  newestReadySession,
  normalizeProjectSessionTitle,
  normalizeProjectWorkspaceName,
  ProjectStateError,
  pruneForSessionInsert,
  recentWorkspaces,
  requireUniqueWorkspaceName,
  requireWorkspaceCapacity,
  slugPrefix,
  snapshotState,
  STORED_ID,
  uniqueSessionTitle,
  uniqueWorkspaceName,
  validateThreadId,
  type BegunSession,
  type ExternalManagedWorkspaceReconciliation,
  type ManagedMaintenanceJournal,
  type ManagedMaintenanceJournalEntry,
  type ManagedReplacementInput,
  type MutableProjectState,
  type NormalizedProjectText,
  type PreparedSessionResume,
  type ProjectMaintenanceSnapshot,
  type ProjectMaintenanceTargetSnapshot,
  type ProjectSessionRecord,
  type ProjectSnapshot,
  type PublicProjectContext,
  type PublicProjectView,
  type SessionBackendBinding,
  type SessionResumeRollback,
  type SessionStartRollback,
  type WorkspaceRecord,
} from './project-state.js'
import {
  directoryFlag,
  fileIdentity,
  isCommittedTransactionFailure,
  isDirectChild,
  isNodeError,
  LEGACY_PROJECT_CODEX_HOMES_DIRECTORY,
  noFollowFlag,
  privateDirectoryMetadata,
  PROJECT_CODEX_HOMES_DIRECTORY,
  PROJECT_OWNER_LOCK_FILE,
  ProjectStoreFiles,
  sameFileIdentity,
  validateRegisteredWorkspace,
  type DirectoryBinding,
  type FileIdentity,
  type HeldLock,
  type MaintenanceFaultStep,
  type ProjectStoreOptions,
  type ProjectTransactionWaitOptions,
} from './project-store-files.js'

export {
  MAX_PROJECT_SESSION_TITLE,
  MAX_PROJECT_SESSIONS_PER_WORKSPACE,
  MAX_PROJECT_SESSIONS_TOTAL,
  MAX_PROJECT_WORKSPACE_NAME,
  MAX_PROJECT_WORKSPACES,
  normalizeProjectSessionTitle,
  normalizeProjectWorkspaceName,
  PROJECT_STATE_VERSION,
  ProjectStateError,
  type BegunSession,
  type ExternalManagedWorkspaceReconciliation,
  type ManagedMaintenanceJournal,
  type ManagedMaintenanceJournalEntry,
  type ManagedReplacementInput,
  type NormalizedProjectText,
  type PreparedSessionResume,
  type ProjectMaintenanceSnapshot,
  type ProjectMaintenanceTargetSnapshot,
  type ProjectSessionRecord,
  type ProjectSnapshot,
  type ProjectStateCode,
  type PublicProjectContext,
  type PublicProjectView,
  type PublicRosterEntry,
  type SessionResumeRollback,
  type SessionStartRollback,
  type WorkspaceRecord,
} from './project-state.js'

export {
  hostManagedProjectRootForTest,
  hostManagedProjectRootFromConfig,
  hostProjectRootForTest,
  hostProjectRootFromConfig,
  MAX_PROJECT_STATE_BYTES,
  PROJECT_MAINTENANCE_JOURNAL_FILE,
  PROJECT_OWNER_LOCK_FILE,
  PROJECT_STATE_FILE,
  PROJECT_TRANSACTION_LOCK_FILE,
  type HostManagedProjectRoot,
  type HostProjectRoot,
  type ProjectStoreOptions,
  type ProjectTransactionWaitOptions,
} from './project-store-files.js'

const MAX_ID_FACTORY_ATTEMPTS = 32

class MaintenanceFaultError extends Error {
  constructor(step: MaintenanceFaultStep) {
    super(`maintenance fault: ${step}`)
    this.name = 'MaintenanceFaultError'
  }
}

/** Project/session operations and managed-workspace recovery, under one filesystem transaction owner. */
export class ProjectStore {
  readonly #now: () => number
  readonly #idFactory: () => string
  readonly #maintenanceFault: ((step: MaintenanceFaultStep) => boolean) | undefined
  readonly #workspaceIdentities = new Map<string, FileIdentity>()
  readonly #files: ProjectStoreFiles

  private constructor(options: ProjectStoreOptions) {
    this.#files = new ProjectStoreFiles(options)
    this.#now = options.now ?? (() => Date.now() / 1000)
    this.#idFactory = options.idFactory ?? (() => randomUUID().replaceAll('-', ''))
    this.#maintenanceFault = options.maintenanceFault
  }

  static async open(options: ProjectStoreOptions): Promise<ProjectStore> {
    const store = new ProjectStore(options)
    try {
      await store.#files.open()
      if (store.#files.hasOwnerLock && await store.#files.loadMaintenanceJournal() !== null) {
        await store.cleanupManagedMaintenanceJournal()
      }
      return store
    } catch (error) {
      await store.#files.disposeFailedOpen()
      throw error
    }
  }

  close(): Promise<void> {
    return this.#files.close()
  }

  async snapshot(): Promise<ProjectSnapshot> {
    return await this.#files.transaction(state => [snapshotState(state), false], {wait: true})
  }

  async reconcileExternallyRemovedManagedWorkspaces(): Promise<
    ExternalManagedWorkspaceReconciliation
  > {
    const created: {
      readonly path: string
      readonly identity: FileIdentity
      readonly workspaceId: string
      readonly previousIdentity: FileIdentity | undefined
    }[] = []
    try {
      return await this.#files.transaction<ExternalManagedWorkspaceReconciliation>(async state => {
        if (await this.#files.loadMaintenanceJournal() !== null) {
          throw new ProjectStateError('state_busy')
        }
        const managed = await this.#files.validateManagedRoot()
        const root = this.#files.requireManagedRootHandle()
        const missing: WorkspaceRecord[] = []
        let managedWorkspaceCount = 0
        for (const workspace of [...state.workspaces.values()].sort(compareCreated)) {
          if (workspace.origin !== 'managed') continue
          managedWorkspaceCount += 1
          if (!isDirectChild(managed, workspace.canonical_path)) {
            throw new ProjectStateError('workspace_boundary_changed')
          }
          const present = this.#files.lookupWorkspaceAt(
            root,
            basename(workspace.canonical_path),
            'workspace_boundary_changed',
          )
          if (present.status === 'missing') {
            missing.push(workspace)
            continue
          }
          const binding = await this.#files.validateManagedWorkspaceBinding(workspace.canonical_path)
          this.#pinWorkspaceIdentity(workspace.workspace_id, binding.identity)
        }
        if (missing.length === 0) {
          return [Object.freeze({
            status: 'unchanged',
            recreated_count: 0,
            active_workspace_reset: false,
          }), false]
        }

        for (const workspace of missing) {
          const recreated = await this.#files.ensurePrivateDirectoryAt(
            root,
            managed,
            basename(workspace.canonical_path),
            true,
          )
          try {
            const identity = recreated.binding.identity
            created.push({
              path: workspace.canonical_path,
              identity,
              workspaceId: workspace.workspace_id,
              previousIdentity: this.#workspaceIdentities.get(workspace.workspace_id),
            })
            this.#workspaceIdentities.set(workspace.workspace_id, identity)
          } finally {
            await recreated.file.close().catch(() => undefined)
          }
        }
        await this.#files.syncManagedRoot()
        const activeWorkspaceReset = state.activeWorkspaceId !== null
          && (
            missing.length === managedWorkspaceCount
            || missing.some(workspace => workspace.workspace_id === state.activeWorkspaceId)
          )
        if (activeWorkspaceReset) {
          state.activeWorkspaceId = null
          bumpActiveBindingRevision(state)
        }
        return [Object.freeze({
          status: 'reconciled',
          recreated_count: missing.length,
          active_workspace_reset: activeWorkspaceReset,
        }), activeWorkspaceReset]
      }, {wait: true})
    } catch (error) {
      if (!isCommittedTransactionFailure(error)) {
        for (const candidate of [...created].reverse()) {
          const removed = await this.#files.rollbackCreatedDirectory(candidate)
          if (!removed) continue
          const current = this.#workspaceIdentities.get(candidate.workspaceId)
          if (current === undefined || !sameFileIdentity(current, candidate.identity)) continue
          if (candidate.previousIdentity === undefined) {
            this.#workspaceIdentities.delete(candidate.workspaceId)
          } else {
            this.#workspaceIdentities.set(candidate.workspaceId, candidate.previousIdentity)
          }
        }
      }
      throw error
    }
  }

  async maintenanceSnapshot(): Promise<ProjectMaintenanceSnapshot> {
    return await this.#files.transaction<ProjectMaintenanceSnapshot>(async state => {
      await this.#files.validateManagedRoot()
      const targets: ProjectMaintenanceTargetSnapshot[] = []
      for (const workspace of [...state.workspaces.values()].sort(compareCreated)) {
        if (workspace.origin !== 'managed') continue
        const binding = await this.#files.validateManagedWorkspaceBinding(workspace.canonical_path)
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
    return await this.#files.transaction<ProjectMaintenanceSnapshot>(async state => {
      await this.#files.validateManagedRoot()
      const workspace = state.activeWorkspaceId === null
        ? undefined
        : state.workspaces.get(state.activeWorkspaceId)
      const targets: ProjectMaintenanceTargetSnapshot[] = []
      if (workspace?.origin === 'managed') {
        const binding = await this.#files.validateManagedWorkspaceBinding(workspace.canonical_path)
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
    return await this.#files.transaction<boolean>(async state => {
      await this.#files.validateManagedRoot()
      const workspace = state.activeWorkspaceId === null
        ? undefined
        : state.workspaces.get(state.activeWorkspaceId)
      if (workspace?.origin !== 'managed') return [false, false]
      const before = await this.#files.validateManagedWorkspaceBinding(workspace.canonical_path)
      this.#pinWorkspaceIdentity(workspace.workspace_id, before.identity)
      callback(workspace.canonical_path)
      await this.#files.validateManagedRoot()
      const after = await this.#files.validateManagedWorkspaceBinding(workspace.canonical_path)
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
    return await this.#files.transaction<{
      readonly status: 'stale' | 'rolled_back' | 'committed'
      readonly committed: boolean
      readonly tombstones: readonly {readonly name: string; readonly identity: ProjectFileIdentity}[]
    }>(async state => {
      if (state.stateRevision !== input.expected_state_revision || input.targets.length === 0) {
        return [{status: 'stale', committed: false, tombstones: []}, false]
      }
      const managed = await this.#files.validateManagedRoot()
      const root = this.#files.requireManagedRootHandle()
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
        const binding = await this.#files.validateManagedWorkspaceBinding(target.canonical_path)
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
      if (await this.#files.loadMaintenanceJournal() !== null) {
        throw new ProjectStateError('state_busy')
      }
      await this.#files.writeMaintenanceJournal(journal)
      const replaced: {
        readonly target: typeof prepared[number]
        replacementIdentity: FileIdentity | null
        renamed: boolean
      }[] = prepared.map(target => ({target, replacementIdentity: null, renamed: false}))
      try {
        for (const item of replaced) {
          const target = item.target
          const tombstoneBefore = this.#files.lookupAt(root, target.tombstoneName, 'workspace_boundary_changed')
          const replacementBefore = this.#files.lookupAt(
            root, target.replacementName, 'workspace_boundary_changed',
          )
          if (tombstoneBefore.status !== 'missing' || replacementBefore.status !== 'missing') {
            throw new ProjectStateError('workspace_boundary_changed')
          }
          const renamed = this.#files.renameManagedNoReplace(
            root, target.originalName, target.tombstoneName, target.identity,
          )
          if (renamed.status !== 'ok') throw new ProjectStateError('workspace_boundary_changed')
          item.renamed = true
          const tombstone = this.#files.lookupAt(root, target.tombstoneName, 'workspace_boundary_changed')
          if (tombstone.status !== 'ok' || !sameFileIdentity(tombstone.identity, target.identity)) {
            throw new ProjectStateError('workspace_boundary_changed')
          }
        }
        for (const [index, item] of replaced.entries()) {
          const target = item.target
          const replacement = await this.#files.ensurePrivateDirectoryAt(
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
          await this.#files.writeMaintenanceJournal(journal)
          this.#maintenanceCheckpoint('replacement_identity_persisted')
          const placed = this.#files.renameManagedNoReplace(
            root,
            target.replacementName,
            target.originalName,
            replacement.binding.identity,
          )
          if (placed.status !== 'ok') throw new ProjectStateError('workspace_boundary_changed')
          const placedIdentity = this.#files.lookupAt(
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
        await this.#files.syncManagedRoot()
        await this.#files.writeMaintenanceJournal(Object.freeze({...journal, phase: 'committed'}))
      } catch (error) {
        if (error instanceof MaintenanceFaultError) throw error
        let rollbackComplete = true
        for (const item of [...replaced].reverse()) {
          const replacementNames = item.replacementIdentity === null
            ? [item.target.replacementName]
            : [item.target.originalName, item.target.replacementName]
          for (const name of replacementNames) {
            try {
              const present = this.#files.lookupAt(root, name, 'workspace_boundary_changed')
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
              const removed = this.#files.unlinkAt(
                root, name, present.identity, 'directory', 'workspace_boundary_changed',
              )
              if (removed.status !== 'ok' && removed.status !== 'missing') rollbackComplete = false
            } catch { rollbackComplete = false }
          }
          if (item.renamed) {
            const restored = this.#files.renameManagedNoReplace(
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
            await this.#files.syncManagedRoot()
            await this.#files.clearMaintenanceJournal(operationId)
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
    return await this.#files.transaction(async () => [await this.#files.loadMaintenanceJournal(), false], {wait: true})
  }

  async clearManagedMaintenanceJournal(expectedOperationId: string): Promise<void> {
    await this.#files.transaction(async () => {
      await this.#files.clearMaintenanceJournal(expectedOperationId)
      return [undefined, false]
    }, {wait: true})
  }

  async cleanupManagedMaintenanceJournal(): Promise<{
    readonly status: 'clean' | 'cleanup_pending' | 'rollback_pending'
  }> {
    return await this.#files.transaction<{
      readonly status: 'clean' | 'cleanup_pending' | 'rollback_pending'
    }>(async () => {
      const journal = await this.#files.loadMaintenanceJournal()
      if (journal === null) return [{status: 'clean'}, false]
      // Inspection needs only the transaction lock. Replay also needs the live-owner lock;
      // a non-live desktop observer must not mutate a running backend's workspaces.
      let owner: HeldLock | null = null
      if (!this.#files.hasOwnerLock) {
        try {
          owner = await this.#files.openAndAcquireLock(PROJECT_OWNER_LOCK_FILE)
        } catch (error) {
          if (!(error instanceof ProjectStateError) || error.code !== 'state_busy') throw error
          return [{status: journal.phase === 'prepared' ? 'rollback_pending' : 'cleanup_pending'}, false]
        }
      }
      try {
        await this.#files.validateManagedRoot()
        const root = this.#files.requireManagedRootHandle()
        if (journal.phase === 'prepared') {
          const remaining: ManagedMaintenanceJournalEntry[] = []
          for (const entry of [...journal.entries].reverse()) {
            const tombstone = this.#files.lookupAt(root, entry.tombstone_name, 'workspace_boundary_changed')
            const original = this.#files.lookupAt(root, entry.original_name, 'workspace_boundary_changed')
            const temporary = entry.replacement_name === entry.original_name
              ? {status: 'missing'} as const
              : this.#files.lookupAt(root, entry.replacement_name, 'workspace_boundary_changed')
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
                const removed = this.#files.unlinkAt(
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
            const originalAfter = this.#files.lookupAt(
              root, entry.original_name, 'workspace_boundary_changed',
            )
            if (originalAfter.status !== 'missing') {
              remaining.push(entry)
              continue
            }
            const restored = this.#files.renameManagedNoReplace(
              root, entry.tombstone_name, entry.original_name, entry.identity,
            )
            const restoredIdentity = this.#files.lookupAt(
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
            await this.#files.syncManagedRoot()
            await this.#files.clearMaintenanceJournal(journal.operation_id)
            return [{status: 'clean'}, false]
          }
          if (remaining.length !== journal.entries.length) {
            await this.#files.syncManagedRoot()
            await this.#files.writeMaintenanceJournal(Object.freeze({
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
          const result = this.#files.removeManagedTree(root, entry.tombstone_name, entry.identity)
          if (result.status !== 'ok' && result.status !== 'missing') remaining.push(entry)
          else if (result.status === 'ok') this.#maintenanceCheckpoint('cleanup_entry_deleted')
        }
        if (remaining.length === 0) {
          await this.#files.syncManagedRoot()
          await this.#files.clearMaintenanceJournal(journal.operation_id)
          return [{status: 'clean'}, false]
        }
        if (remaining.length !== journal.entries.length) {
          await this.#files.syncManagedRoot()
          await this.#files.writeMaintenanceJournal(Object.freeze({
            version: journal.version,
            operation_id: journal.operation_id,
            phase: 'committed',
            entries: Object.freeze(remaining),
          }))
        }
        return [{status: 'cleanup_pending'}, false]
      } finally {
        if (owner !== null) {
          try { await owner.release() } finally { await owner.file.close() }
        }
      }
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
      return await this.#files.transaction(async state => {
        const binding = await validateRegisteredWorkspace(hostWorkspacePath(workspace))
        const existing = [...state.workspaces.values()].find(
          record => record.canonical_path === binding.canonical,
        )
        if (existing !== undefined) {
          const approved = existing.origin === 'managed'
            ? await this.#files.validateManagedWorkspaceBinding(existing.canonical_path)
            : binding
          this.#pinWorkspaceIdentity(existing.workspace_id, approved.identity)
          return [existing, false]
        }
        requireWorkspaceCapacity(state)
        const initialImport = state.workspaces.size === 0
        const unique = uniqueWorkspaceName(state, requested.display)
        const normalized = normalizeProjectWorkspaceName(unique)
        const record = this.#newWorkspace(state, normalized, binding.canonical, 'registered')
        this.#pinWorkspaceIdentity(record.workspace_id, binding.identity)
        createdPin.push({workspaceId: record.workspace_id, identity: binding.identity})
        state.workspaces.set(record.workspace_id, record)
        if (state.activeWorkspaceId === null && initialImport) {
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
      return await this.#files.transaction(async state => {
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
    return await this.#files.transaction(state => {
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
      return await this.#files.transaction(async state => {
        const managed = await this.#files.validateManagedRoot()
        const managedHandle = this.#files.requireManagedRootHandle()
        requireWorkspaceCapacity(state)
        requireUniqueWorkspaceName(state, name.normalized)
        const workspaceId = this.#newUniqueId(state)
        const candidate = join(managed, `${slugPrefix(name.display)}-${[...workspaceId].slice(-12).join('')}`)
        if (!isDirectChild(managed, candidate)) throw new ProjectStateError('workspace_boundary_changed')
        const candidateName = basename(candidate)
        let candidateFile: FileHandle | null = null
        try {
          const created = this.#files.mkdirPrivateAt(
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
          this.#files.requireMatchesAt(
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
          this.#files.protectAt(
            managedHandle,
            candidateName,
            candidateFile,
            'workspace_boundary_changed',
          )
          if (this.#files.platform !== 'win32') await candidateFile.chmod(0o700)
          const verified = await candidateFile.stat({bigint: true})
          const canonical = realpathSync(candidate)
          this.#files.requireMatchesAt(
            managedHandle,
            candidateName,
            candidateFile,
            'workspace_boundary_changed',
          )
          await this.#files.validateManagedRoot()
          if (
            !verified.isDirectory()
            || !privateDirectoryMetadata(verified, this.#files.platform)
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
        if (await this.#files.rollbackCreatedDirectory(created)) {
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
    options?: ProjectTransactionWaitOptions & {readonly previousWorkspaceId?: string | null},
  ): Promise<boolean> {
    const rollback: {removed: {
      readonly name: string
      readonly path: string
      readonly identity: FileIdentity
    } | null} = {removed: null}
    try {
      const result = await this.#files.transaction(async state => {
        const workspace = state.workspaces.get(workspaceId)
        if (workspace?.origin !== 'managed') return [false, false]
        if ([...state.sessions.values()].some(session => session.workspace_id === workspaceId)) {
          return [false, false]
        }
        const managed = await this.#files.validateManagedRoot()
        if (!isDirectChild(managed, workspace.canonical_path)) return [false, false]
        try {
          const binding = await this.#files.validateManagedWorkspaceBinding(workspace.canonical_path)
          const pinned = this.#workspaceIdentities.get(workspaceId)
          if (pinned !== undefined && !sameFileIdentity(pinned, binding.identity)) {
            return [false, false]
          }
          this.#pinWorkspaceIdentity(workspaceId, binding.identity)
          const name = basename(binding.canonical)
          const unlinked = this.#files.unlinkAt(
            this.#files.requireManagedRootHandle(),
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
          // Restore only while deleting the active binding, under the same transaction. A later
          // selection owns its binding even when this old create still needs resource cleanup.
          const previous = options?.previousWorkspaceId
          state.activeWorkspaceId = previous != null && state.workspaces.has(previous)
            ? previous
            : mostRecentlyUsed(state.workspaces.values())?.workspace_id ?? null
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
    return await this.#files.transaction(state => {
      const record = normalized === null
        ? (state.activeWorkspaceId === null ? undefined : state.workspaces.get(state.activeWorkspaceId))
        : [...state.workspaces.values()].find(item => item.normalized_name === normalized.normalized)
      if (record === undefined) throw new ProjectStateError('workspace_not_found')
      return [record, false]
    })
  }

  async selectWorkspace(displayName: string): Promise<WorkspaceRecord> {
    const name = normalizeProjectWorkspaceName(displayName)
    return await this.#files.transaction(state => {
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
    return await this.#files.transaction(async state => {
      const found = state.workspaces.get(workspaceId)
      if (found?.normalized_name !== name.normalized) {
        throw new ProjectStateError('workspace_boundary_changed')
      }
      const binding = found.origin === 'managed'
        ? await this.#files.validateManagedWorkspaceBinding(found.canonical_path)
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
    return await this.#files.transaction(async state => {
      const workspace = state.workspaces.get(workspaceId)
      if (workspace === undefined) throw new ProjectStateError('workspace_not_found')
      let binding: DirectoryBinding
      if (workspace.origin === 'managed') {
        binding = await this.#files.validateManagedWorkspaceBinding(workspace.canonical_path, true)
      } else {
        binding = await validateRegisteredWorkspace(
          workspace.canonical_path,
          'workspace_boundary_changed',
        )
      }
      this.#pinWorkspaceIdentity(workspaceId, binding.identity)
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
    return await this.#files.transaction(async state => {
      const workspace = state.workspaces.get(workspaceId)
      const session = state.sessions.get(sessionId)
      if (workspace === undefined || session?.workspace_id !== workspaceId) {
        throw new ProjectStateError('session_workspace_mismatch')
      }
      if (
        session.state !== 'ready'
        || session.backend_session_id !== expectedThread
      ) throw new ProjectStateError('session_unavailable')
      const previousActiveWorkspaceId = state.activeWorkspaceId
      const previousActiveSessionId = workspace.active_session_id
      const binding = workspace.origin === 'managed'
        ? await this.#files.validateManagedWorkspaceBinding(workspace.canonical_path, true)
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
    return await this.#files.transaction(state => {
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
    return await this.#files.transaction(state => {
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

  async importSession(workspaceId: string, input: {
    readonly threadId: string; readonly title: string; readonly home: string; readonly updatedAt: number
  }): Promise<ProjectSessionRecord> {
    const threadId = validateThreadId(input.threadId)
    // Use native canonicalization, including Windows short-name aliases, like the catalog scanner.
    const home = await realpath(input.home)
    const title = normalizeProjectSessionTitle([...input.title].slice(0, MAX_PROJECT_SESSION_TITLE).join(''))
    return await this.#files.transaction(state => {
      if (!state.workspaces.has(workspaceId)) throw new ProjectStateError('workspace_not_found')
      const existing = [...state.sessions.values()].find(session => session.backend_id === 'codex'
        && session.backend_profile_id === 'codex:legacy'
        && session.backend_session_id === threadId && session.executor_home === home)
      if (existing && existing.workspace_id !== workspaceId) throw new ProjectStateError('session_state_conflict')
      if (existing?.origin === 'nova') return [existing, false]
      // Evict like every other insert path: a full workspace must not freeze out newer discoveries.
      if (!existing) pruneForSessionInsert(state, workspaceId)
      const normalized = normalizeProjectSessionTitle(uniqueSessionTitle(
        {...state, sessions: new Map([...state.sessions].filter(([id]) => id !== existing?.session_id))}, workspaceId, title.display,
      ))
      const session: ProjectSessionRecord = Object.freeze({
        session_id: existing?.session_id ?? this.#newUniqueId(state), workspace_id: workspaceId,
        executor_home: home, origin: 'external', codex_thread_id: threadId, state: 'ready',
        backend_id: 'codex', backend_profile_id: 'codex:legacy', backend_session_id: threadId,
        display_title: normalized.display, normalized_title: normalized.normalized,
        created_at: existing?.created_at ?? input.updatedAt,
        last_used_at: Math.max(existing?.last_used_at ?? 0, input.updatedAt),
      })
      state.sessions.set(session.session_id, session)
      const workspace = state.workspaces.get(workspaceId)!
      state.workspaces.set(workspaceId, Object.freeze({...workspace, last_used_at: Math.max(workspace.last_used_at, input.updatedAt)}))
      return [session, JSON.stringify(existing) !== JSON.stringify(session)]
    })
  }

  async beginSession(workspaceId: string, displayTitle: string): Promise<ProjectSessionRecord> {
    return (await this.beginSessionForRun(workspaceId, displayTitle)).session
  }

  /** The host derives `displayTitle` from the work order (spec 08 Titles); there is no default title. */
  async beginSessionForRun(
    workspaceId: string, displayTitle: string, executorHome?: string,
    binding: Omit<SessionBackendBinding, 'backend_session_id'> = {backend_id: 'codex', backend_profile_id: 'codex:legacy'},
  ): Promise<BegunSession> {
    const {backend_id: backendId, backend_profile_id: profileId} = binding
    if (!CODING_BACKEND_IDS.includes(backendId) || typeof profileId !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9:_./-]{0,255}$/u.test(profileId)) {
      throw new ProjectStateError('state_corrupt')
    }
    const home = executorHome === undefined ? undefined : hostHomeValue(hostPersistentHomeFromConfig(executorHome, [executorHome])).path
    const supplied = normalizeProjectSessionTitle(displayTitle)
    return await this.#files.transaction(state => {
      const workspace = state.workspaces.get(workspaceId)
      if (workspace === undefined) throw new ProjectStateError('workspace_not_found')
      const previousActiveWorkspaceId = state.activeWorkspaceId
      const previousActiveSessionId = workspace.active_session_id
      pruneForSessionInsert(state, workspaceId)
      const title = uniqueSessionTitle(state, workspaceId, supplied.display)
      const normalized = normalizeProjectSessionTitle(title)
      const stamp = this.#stamp()
      const sessionId = this.#newUniqueId(state)
      const session: ProjectSessionRecord = Object.freeze({
        session_id: sessionId,
        workspace_id: workspaceId,
        origin: 'nova',
        ...(home === undefined ? {} : {executor_home: home}),
        display_title: normalized.display,
        normalized_title: normalized.normalized,
        codex_thread_id: null,
        backend_id: backendId,
        backend_profile_id: profileId,
        backend_session_id: null,
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

  /** Mirror of Codex `thread/name/updated` (spec 08): Codex owns the name once one exists; clipped to the title limit. */
  async setSessionTitle(sessionId: string, title: string): Promise<boolean> {
    const clipped = stripLikePython([...title].slice(0, MAX_PROJECT_SESSION_TITLE).join(''))
    if (clipped === '') return false
    return await this.#files.transaction(state => {
      const session = state.sessions.get(sessionId)
      if (session === undefined) return [false, false]
      const normalized = normalizeProjectSessionTitle(uniqueSessionTitle(
        {...state, sessions: new Map([...state.sessions].filter(([id]) => id !== sessionId))},
        session.workspace_id,
        clipped,
      ))
      if (normalized.display === session.display_title) return [true, false]
      state.sessions.set(sessionId, Object.freeze({
        ...session, display_title: normalized.display, normalized_title: normalized.normalized,
      }))
      return [true, true]
    })
  }

  async rollbackSessionStart(
    sessionId: string,
    options?: ProjectTransactionWaitOptions,
  ): Promise<boolean> {
    return await this.#files.transaction(state => {
      const session = state.sessions.get(sessionId)
      if (session?.state !== 'starting' || session.backend_session_id !== null) {
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
    return await this.#files.transaction(state => {
      const session = state.sessions.get(rollback.startedSessionId)
      if (
        session?.workspace_id !== rollback.workspaceId
        || session.state !== 'starting'
        || session.backend_session_id !== null
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
    return await this.#files.transaction(state => {
      const session = state.sessions.get(sessionId)
      if (session === undefined) throw new ProjectStateError('session_not_found')
      if (session.state !== 'starting' || session.backend_session_id !== null) {
        throw new ProjectStateError('session_state_conflict')
      }
      if (session.origin === 'nova') {
        const duplicates = [...state.sessions.values()].filter(other => other.session_id !== sessionId
          && other.backend_id === session.backend_id && other.backend_profile_id === session.backend_profile_id
          && other.executor_home === session.executor_home && other.backend_session_id === cleanThreadId)
        if (duplicates.some(other => other.workspace_id !== session.workspace_id || other.origin === 'nova')) {
          throw new ProjectStateError('session_state_conflict')
        }
        for (const duplicate of duplicates) {
          state.sessions.delete(duplicate.session_id)
          const workspace = state.workspaces.get(duplicate.workspace_id)!
          if (workspace.active_session_id === duplicate.session_id) {
            state.workspaces.set(workspace.workspace_id, Object.freeze({...workspace, active_session_id: sessionId}))
            bumpActiveBindingRevision(state)
          }
        }
      }
      const ready: ProjectSessionRecord = Object.freeze({
        ...session,
        codex_thread_id: session.backend_id === 'codex' ? cleanThreadId : null,
        backend_session_id: cleanThreadId,
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
    return await this.#files.transaction(state => {
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
    return await this.#files.transaction(state => {
      const workspace = state.workspaces.get(workspaceId)
      const session = state.sessions.get(sessionId)
      if (workspace === undefined) throw new ProjectStateError('workspace_not_found')
      if (session?.workspace_id !== workspaceId) {
        throw new ProjectStateError('session_workspace_mismatch')
      }
      if (session.state !== 'ready' || session.backend_session_id === null) {
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

  async persistentHome(workspaceId: string, {create = true}: {readonly create?: boolean} = {}): Promise<HostStateHome> {
    return await this.#files.transaction(async state => {
      const workspace = state.workspaces.get(workspaceId)
      if (workspace === undefined) throw new ProjectStateError('workspace_not_found')
      await this.#files.revalidateStateRoot()
      const stateRoot = this.#files.requireStateRootHandle()
      if (create) await this.#files.migrateLegacyHomes(stateRoot)
      const directory = !create && this.#files.lookupAt(stateRoot, PROJECT_CODEX_HOMES_DIRECTORY, 'state_permissions').status === 'missing'
        ? LEGACY_PROJECT_CODEX_HOMES_DIRECTORY : PROJECT_CODEX_HOMES_DIRECTORY
      const homesRoot = join(this.#files.stateRoot, directory)
      const home = join(homesRoot, workspace.codex_home_key)
      if (!isDirectChild(homesRoot, home)) throw new ProjectStateError('workspace_boundary_changed')
      let homes: {readonly file: FileHandle; readonly binding: DirectoryBinding} | null = null
      let workspaceHome: {readonly file: FileHandle; readonly binding: DirectoryBinding} | null = null
      try {
        homes = await this.#files.ensurePrivateDirectoryAt(
          stateRoot,
          this.#files.stateRoot,
          directory, false, create,
        )
        workspaceHome = await this.#files.ensurePrivateDirectoryAt(
          homes.file,
          homes.binding.canonical,
          workspace.codex_home_key, false, create,
        )
        const canonical = workspaceHome.binding.canonical
        if (canonical !== home || !isDirectChild(homesRoot, canonical)) {
          throw new ProjectStateError('state_permissions')
        }
        await this.#files.revalidateStateRoot()
        this.#files.requireMatchesAt(
          stateRoot,
          directory,
          homes.file,
          'state_permissions',
        )
        this.#files.requireMatchesAt(
          homes.file,
          workspace.codex_home_key,
          workspaceHome.file,
          'state_permissions',
        )
        const branded = hostPersistentHomeFromConfig(canonical, [canonical])
        if (hostHomeValue(branded).path !== canonical) {
          throw new ProjectStateError('state_permissions')
        }
        this.#files.requireMatchesAt(
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
        // Running works are adapter-owned; the project adapter merges them into this store roster.
        roster: recentWorkspaces(state.workspaces).map(record => Object.freeze({
          name: record.display_name, last_used_at: record.last_used_at, running: [],
        })),
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

  #stamp(): number {
    const value = this.#now()
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ProjectStateError('clock_invalid')
    }
    return value
  }

  #maintenanceCheckpoint(step: MaintenanceFaultStep): void {
    if (this.#maintenanceFault?.(step) === true) throw new MaintenanceFaultError(step)
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
      const managed = await this.#files.validateManagedRoot()
      if (!isDirectChild(managed, removed.path)) return
      const root = this.#files.requireManagedRootHandle()
      const created = this.#files.mkdirPrivateAt(root, removed.name, 'workspace_boundary_changed')
      if (created.status !== 'ok') return
      createdRoot = root
      createdIdentity = created.identity
      file = await open(removed.path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
      this.#files.requireMatchesAt(root, removed.name, file, 'workspace_boundary_changed')
      const initialInfo = await file.stat({bigint: true})
      if (!sameFileIdentity(created.identity, fileIdentity(initialInfo))) return
      this.#files.protectAt(root, removed.name, file, 'workspace_boundary_changed')
      if (this.#files.platform !== 'win32') await file.chmod(0o700)
      const info = await file.stat({bigint: true})
      const canonical = realpathSync(removed.path)
      if (
        !info.isDirectory()
        || !privateDirectoryMetadata(info, this.#files.platform)
        || canonical !== removed.path
      ) return
      this.#files.requireMatchesAt(root, removed.name, file, 'workspace_boundary_changed')
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
          this.#files.unlinkAt(
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
}
