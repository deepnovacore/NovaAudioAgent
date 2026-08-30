import {randomUUID} from 'node:crypto'

import type {
  ManagedMaintenanceJournal,
  ManagedReplacementInput,
  ProjectMaintenanceSnapshot,
} from './codex-project-store.js'
import {
  CodexProjectStore,
  hostManagedProjectRootFromConfig,
  hostProjectRootFromConfig,
} from './codex-project-store.js'
import type {ProjectNativeHost} from './project-native-resource.js'

export type ManagedWorkspaceScope = 'current_managed' | 'all_managed'
export type ManagedWorkspaceMaintenanceHealth =
  | 'ready'
  | 'degraded'
  | 'cleanup_pending'
  | 'rollback_pending'
  | 'unavailable'
declare const preparationBrand: unique symbol
declare const authorizationBrand: unique symbol
export interface ManagedWorkspacePreparation { readonly [preparationBrand]: never }
export interface ManagedWorkspaceAuthorization { readonly [authorizationBrand]: never }

interface MaintenanceStore {
  maintenanceSnapshot(): Promise<ProjectMaintenanceSnapshot>
  currentMaintenanceSnapshot(): Promise<ProjectMaintenanceSnapshot>
  withCurrentManagedWorkspacePath(callback: (path: string) => void): Promise<boolean>
  executeManagedReplacement(input: ManagedReplacementInput): Promise<{
    readonly status: 'stale' | 'rolled_back' | 'committed'
    readonly committed: boolean
    readonly tombstones: readonly {readonly name: string; readonly identity: {readonly device: bigint; readonly inode: bigint}}[]
  }>
  cleanupManagedMaintenanceJournal(): Promise<{
    readonly status: 'clean' | 'cleanup_pending' | 'rollback_pending'
  }>
  loadManagedMaintenanceJournal(): Promise<ManagedMaintenanceJournal | null>
}

interface PreparedTarget {
  readonly workspace_id: string
  readonly canonical_path: string
  readonly identity: {readonly device: bigint; readonly inode: bigint}
  readonly display_name: string
}

interface PreparedState {
  readonly service: ManagedWorkspaceMaintenanceService
  readonly scope: ManagedWorkspaceScope
  readonly stateRevision: number
  readonly expiresAt: number
  readonly targets: readonly PreparedTarget[]
  authorized: boolean
  consumed: boolean
}

interface AuthorizationState {
  readonly service: ManagedWorkspaceMaintenanceService
  readonly preparation: ManagedWorkspacePreparation
  consumed: boolean
}

const preparationState = new WeakMap<ManagedWorkspacePreparation, PreparedState>()
const authorizationState = new WeakMap<ManagedWorkspaceAuthorization, AuthorizationState>()

export type ManagedWorkspacePrepareResult =
  | Readonly<{
    status: 'ready'
    preparation: ManagedWorkspacePreparation
    preview: Readonly<{
      scope: ManagedWorkspaceScope
      display_name: string | null
      count: number
    }>
  }>
  | Readonly<{
    status: 'not_managed' | 'empty' | 'cleanup_pending' | 'rollback_pending' | 'unavailable'
  }>

export type ManagedWorkspaceCapabilities = Readonly<{
  health: ManagedWorkspaceMaintenanceHealth
  lifecycleBusy: boolean
  current: Readonly<{available: boolean; display_name: string | null}>
  all: Readonly<{available: boolean; count: number}>
}>

export type ManagedWorkspaceOpenResult = Readonly<{
  status:
    | 'opened'
    | 'not_managed'
    | 'open_failed'
    | 'cleanup_pending'
    | 'rollback_pending'
    | 'unavailable'
}>

export type ManagedWorkspaceExecuteResult = Readonly<{
  status: 'cleared' | 'stale' | 'clear_failed' | 'rollback_pending'
  committed: boolean
  cleanup_pending: boolean
}>

export class ManagedWorkspaceMaintenanceService {
  readonly #store: MaintenanceStore
  readonly #now: () => number
  readonly #idFactory: () => string
  readonly #ttlMs: number
  readonly #closeStore: (() => Promise<void>) | null
  #closed = false
  #journalHealth: 'ready' | 'cleanup_pending' | 'rollback_pending' | 'unavailable' = 'ready'
  #closePromise: Promise<void> | null = null

  private constructor(options: {
    readonly store: MaintenanceStore
    readonly now: () => number
    readonly idFactory: () => string
    readonly ttlMs: number
    readonly closeStore: (() => Promise<void>) | null
  }) {
    this.#store = options.store
    this.#now = options.now
    this.#idFactory = options.idFactory
    this.#ttlMs = options.ttlMs
    this.#closeStore = options.closeStore
  }

  static async open(options: {
    readonly store: MaintenanceStore
    readonly now?: () => number
    readonly idFactory?: () => string
    readonly ttlMs?: number
  }): Promise<ManagedWorkspaceMaintenanceService> {
    const service = new ManagedWorkspaceMaintenanceService({
      store: options.store,
      now: options.now ?? (() => Date.now()),
      idFactory: options.idFactory ?? randomUUID,
      ttlMs: options.ttlMs ?? 60_000,
      closeStore: null,
    })
    await service.#refreshJournalHealth()
    return service
  }

  static async openFromDesktop(options: {
    readonly stateRoot: string
    readonly managedRoot: string
    readonly nativeHost: ProjectNativeHost
  }): Promise<ManagedWorkspaceMaintenanceService> {
    const store = await CodexProjectStore.open({
      stateRoot: hostProjectRootFromConfig(options.stateRoot),
      managedRoot: hostManagedProjectRootFromConfig(options.managedRoot),
      nativeLocks: options.nativeHost.nativeLocks,
      rootFiles: options.nativeHost.rootFiles,
    })
    try {
      const service = new ManagedWorkspaceMaintenanceService({
        store,
        now: () => Date.now(),
        idFactory: randomUUID,
        ttlMs: 60_000,
        closeStore: () => store.close(),
      })
      await service.#refreshJournalHealth()
      return service
    } catch (error) {
      await store.close().catch(() => undefined)
      throw error
    }
  }

  async capabilities(): Promise<ManagedWorkspaceCapabilities> {
    if (this.#closed) return unavailableCapabilities('unavailable')
    if (this.#journalHealth !== 'ready') {
      const refreshed = await this.#refreshJournalHealth()
      if (refreshed !== 'ready') {
        return unavailableCapabilities(refreshed)
      }
    }

    let currentSnapshot: ProjectMaintenanceSnapshot | null = null
    let completeSnapshot: ProjectMaintenanceSnapshot | null = null
    try { currentSnapshot = await this.#store.currentMaintenanceSnapshot() } catch { /* bounded below */ }
    try { completeSnapshot = await this.#store.maintenanceSnapshot() } catch { /* bounded below */ }
    const current = currentSnapshot?.managed_targets.find(
      target => target.workspace.workspace_id === currentSnapshot?.active_workspace_id,
    )
    return Object.freeze({
      health: currentSnapshot !== null && completeSnapshot !== null
        ? 'ready'
        : currentSnapshot !== null || completeSnapshot !== null ? 'degraded' : 'unavailable',
      lifecycleBusy: false,
      current: Object.freeze({
        available: current !== undefined,
        display_name: current?.workspace.display_name ?? null,
      }),
      all: Object.freeze({
        available: (completeSnapshot?.managed_targets.length ?? 0) > 0,
        count: completeSnapshot?.managed_targets.length ?? 0,
      }),
    })
  }

  async prepare(scope: ManagedWorkspaceScope): Promise<ManagedWorkspacePrepareResult> {
    if (this.#closed) return Object.freeze({status: 'unavailable'})
    if (this.#journalHealth !== 'ready') return Object.freeze({status: this.#journalHealth})
    let snapshot: ProjectMaintenanceSnapshot
    try {
      snapshot = scope === 'all_managed'
        ? await this.#store.maintenanceSnapshot()
        : await this.#store.currentMaintenanceSnapshot()
    } catch {
      return Object.freeze({status: 'unavailable'})
    }
    const selected = scope === 'all_managed'
      ? snapshot.managed_targets
      : snapshot.managed_targets.filter(
          target => target.workspace.workspace_id === snapshot.active_workspace_id,
        )
    if (selected.length === 0) {
      return Object.freeze({status: scope === 'current_managed' ? 'not_managed' : 'empty'})
    }
    const preparation = Object.freeze(Object.create(null)) as ManagedWorkspacePreparation
    preparationState.set(preparation, {
      service: this,
      scope,
      stateRevision: snapshot.state_revision,
      expiresAt: this.#now() + this.#ttlMs,
      targets: Object.freeze(selected.map(target => Object.freeze({
        workspace_id: target.workspace.workspace_id,
        canonical_path: target.workspace.canonical_path,
        identity: Object.freeze({...target.identity}),
        display_name: target.workspace.display_name,
      }))),
      authorized: false,
      consumed: false,
    })
    return Object.freeze({
      status: 'ready',
      preparation,
      preview: Object.freeze({
        scope,
        display_name: scope === 'current_managed' ? selected[0]?.workspace.display_name ?? null : null,
        count: selected.length,
      }),
    })
  }

  cancel(preparation: ManagedWorkspacePreparation): boolean {
    const state = preparationState.get(preparation)
    if (state?.service !== this || state.consumed) return false
    state.consumed = true
    return true
  }

  authorize(preparation: ManagedWorkspacePreparation): ManagedWorkspaceAuthorization {
    const state = preparationState.get(preparation)
    if (
      state?.service !== this || state.consumed || state.authorized
      || this.#closed || this.#journalHealth !== 'ready' || this.#now() > state.expiresAt
    ) throw new Error('managed_workspace_preparation_stale')
    state.authorized = true
    const authorization = Object.freeze(Object.create(null)) as ManagedWorkspaceAuthorization
    authorizationState.set(authorization, {service: this, preparation, consumed: false})
    return authorization
  }

  async execute(
    preparation: ManagedWorkspacePreparation,
    authorization: ManagedWorkspaceAuthorization,
  ): Promise<ManagedWorkspaceExecuteResult> {
    const prepared = preparationState.get(preparation)
    const authorized = authorizationState.get(authorization)
    const authorizationPreparation = authorized === undefined
      ? undefined
      : preparationState.get(authorized.preparation)
    const preparedUsable = prepared?.service === this && !prepared.consumed
    const authorizationUsable = authorized?.service === this && !authorized.consumed
    if (prepared?.service === this && !prepared.consumed) prepared.consumed = true
    if (authorized?.service === this && !authorized.consumed) authorized.consumed = true
    if (authorizationPreparation?.service === this && !authorizationPreparation.consumed) {
      authorizationPreparation.consumed = true
    }
    if (
      this.#closed
      || this.#journalHealth !== 'ready'
      || !preparedUsable
      || !authorizationUsable
      || prepared?.service !== this
      || authorized?.service !== this
      || authorized.preparation !== preparation
      || !prepared.authorized
      || this.#now() > prepared.expiresAt
    ) return staleResult()
    const operationId = this.#operationId()
    const targets = prepared.targets.map((target, index) => Object.freeze({
      workspace_id: target.workspace_id,
      canonical_path: target.canonical_path,
      identity: target.identity,
      tombstone_name: `.nova-maintenance-${operationId}-${index + 1}`,
    }))
    try {
      const replaced = await this.#store.executeManagedReplacement({
        expected_state_revision: prepared.stateRevision,
        targets,
      })
      if (replaced.status === 'stale') return staleResult()
      if (replaced.status === 'rolled_back') {
        return Object.freeze({status: 'clear_failed', committed: false, cleanup_pending: false})
      }
      const cleanup = await this.#store.cleanupManagedMaintenanceJournal()
      this.#journalHealth = cleanup.status === 'clean' ? 'ready' : cleanup.status
      return this.#journalHealth !== 'ready'
        ? Object.freeze({status: 'clear_failed', committed: true, cleanup_pending: true})
        : Object.freeze({status: 'cleared', committed: true, cleanup_pending: false})
    } catch {
      let loadedJournal: ManagedMaintenanceJournal | null = null
      let currentJournal: ManagedMaintenanceJournal | null = null
      let journalReadFailed = false
      try {
        loadedJournal = await this.#store.loadManagedMaintenanceJournal()
        if (loadedJournal?.operation_id === operationId) currentJournal = loadedJournal
      } catch { journalReadFailed = true }
      if (journalReadFailed) {
        this.#journalHealth = 'rollback_pending'
        return Object.freeze({status: 'rollback_pending', committed: false, cleanup_pending: true})
      }
      if (loadedJournal?.phase === 'prepared') {
        try {
          const recovery = await this.#store.cleanupManagedMaintenanceJournal()
          this.#journalHealth = recovery.status === 'clean' ? 'ready' : recovery.status
          return recovery.status === 'rollback_pending'
            ? Object.freeze({status: 'rollback_pending', committed: false, cleanup_pending: true})
            : Object.freeze({status: 'clear_failed', committed: false, cleanup_pending: false})
        } catch {
          this.#journalHealth = 'rollback_pending'
          return Object.freeze({status: 'rollback_pending', committed: false, cleanup_pending: true})
        }
      }
      this.#journalHealth = loadedJournal === null ? 'ready' : 'cleanup_pending'
      return Object.freeze({
        status: 'clear_failed',
        committed: currentJournal?.phase === 'committed',
        cleanup_pending: loadedJournal !== null,
      })
    }
  }

  async withCurrentManagedPath(
    callback: (path: string) => void | Promise<void>,
  ): Promise<ManagedWorkspaceOpenResult> {
    if (this.#closed) return Object.freeze({status: 'unavailable'})
    if (this.#journalHealth !== 'ready') return Object.freeze({status: this.#journalHealth})
    let callbackInvoked = false
    let completion = Promise.resolve()
    let opened: boolean
    try {
      opened = await this.#store.withCurrentManagedWorkspacePath(path => {
        callbackInvoked = true
        try {
          completion = Promise.resolve(callback(path))
        } catch (error) {
          completion = Promise.reject(
            error instanceof Error ? error : new Error('managed workspace open failed'),
          )
        }
        void completion.catch(() => undefined)
      })
    } catch {
      return Object.freeze({status: callbackInvoked ? 'open_failed' : 'unavailable'})
    }
    if (!opened) return Object.freeze({status: 'not_managed'})
    if (!callbackInvoked) return Object.freeze({status: 'unavailable'})
    try {
      await completion
      return Object.freeze({status: 'opened'})
    } catch {
      return Object.freeze({status: 'open_failed'})
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    this.#closed = true
    this.#closePromise = this.#closeStore?.() ?? Promise.resolve()
    return this.#closePromise
  }

  #operationId(): string {
    const value = this.#idFactory()
    if (!/^[A-Za-z0-9_-]{8,80}$/u.test(value)) throw new Error('invalid maintenance operation id')
    return value
  }

  async #refreshJournalHealth(): Promise<
    'ready' | 'cleanup_pending' | 'rollback_pending' | 'unavailable'
  > {
    try {
      const cleanup = await this.#store.cleanupManagedMaintenanceJournal()
      this.#journalHealth = cleanup.status === 'clean' ? 'ready' : cleanup.status
    } catch {
      this.#journalHealth = 'unavailable'
    }
    return this.#journalHealth
  }
}

function staleResult(): ManagedWorkspaceExecuteResult {
  return Object.freeze({status: 'stale', committed: false, cleanup_pending: false})
}

function unavailableCapabilities(
  health: 'cleanup_pending' | 'rollback_pending' | 'unavailable',
): ManagedWorkspaceCapabilities {
  return Object.freeze({
    health,
    lifecycleBusy: false,
    current: Object.freeze({available: false, display_name: null}),
    all: Object.freeze({available: false, count: 0}),
  })
}
