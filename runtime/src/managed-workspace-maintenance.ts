import {randomUUID} from 'node:crypto'

import type {
  ManagedMaintenanceJournal,
  ManagedReplacementInput,
  ProjectMaintenanceSnapshot,
} from './codex-project-store.js'

export type ManagedWorkspaceScope = 'current_managed' | 'all_managed'
declare const preparationBrand: unique symbol
declare const authorizationBrand: unique symbol
export interface ManagedWorkspacePreparation { readonly [preparationBrand]: never }
export interface ManagedWorkspaceAuthorization { readonly [authorizationBrand]: never }

interface MaintenanceStore {
  maintenanceSnapshot(): Promise<ProjectMaintenanceSnapshot>
  executeManagedReplacement(input: ManagedReplacementInput): Promise<{
    readonly committed: boolean
    readonly tombstones: readonly {readonly name: string; readonly identity: {readonly device: bigint; readonly inode: bigint}}[]
  }>
  cleanupManagedMaintenanceJournal(): Promise<{readonly status: 'clean' | 'cleanup_pending'}>
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
  | Readonly<{status: 'not_managed' | 'empty'}>

export type ManagedWorkspaceExecuteResult = Readonly<{
  status: 'cleared' | 'stale' | 'clear_failed'
  committed: boolean
  cleanup_pending: boolean
}>

export class ManagedWorkspaceMaintenanceService {
  readonly #store: MaintenanceStore
  readonly #now: () => number
  readonly #idFactory: () => string
  readonly #ttlMs: number
  #closed = false
  #cleanupPending = false

  private constructor(options: {
    readonly store: MaintenanceStore
    readonly now: () => number
    readonly idFactory: () => string
    readonly ttlMs: number
  }) {
    this.#store = options.store
    this.#now = options.now
    this.#idFactory = options.idFactory
    this.#ttlMs = options.ttlMs
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
    })
    const cleanup = await options.store.cleanupManagedMaintenanceJournal()
    service.#cleanupPending = cleanup.status === 'cleanup_pending'
    return service
  }

  async capabilities(): Promise<Readonly<{
    lifecycleBusy: boolean
    current: Readonly<{available: boolean}>
    all: Readonly<{available: boolean; count: number}>
  }>> {
    if (this.#closed) return Object.freeze({
      lifecycleBusy: false,
      current: Object.freeze({available: false}),
      all: Object.freeze({available: false, count: 0}),
    })
    const snapshot = await this.#store.maintenanceSnapshot()
    const current = snapshot.managed_targets.some(
      target => target.workspace.workspace_id === snapshot.active_workspace_id,
    )
    return Object.freeze({
      lifecycleBusy: false,
      current: Object.freeze({available: current}),
      all: Object.freeze({available: snapshot.managed_targets.length > 0, count: snapshot.managed_targets.length}),
    })
  }

  async prepare(scope: ManagedWorkspaceScope): Promise<ManagedWorkspacePrepareResult> {
    if (this.#closed) return Object.freeze({status: 'empty'})
    if (this.#cleanupPending) {
      const cleanup = await this.#store.cleanupManagedMaintenanceJournal()
      this.#cleanupPending = cleanup.status === 'cleanup_pending'
      if (this.#cleanupPending) return Object.freeze({status: 'empty'})
    }
    const snapshot = await this.#store.maintenanceSnapshot()
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
      || this.#closed || this.#now() > state.expiresAt
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
      if (!replaced.committed) {
        const journal = await this.#store.loadManagedMaintenanceJournal()
        return journal?.operation_id === operationId
          ? Object.freeze({status: 'clear_failed', committed: false, cleanup_pending: true})
          : staleResult()
      }
      const cleanup = await this.#store.cleanupManagedMaintenanceJournal()
      this.#cleanupPending = cleanup.status === 'cleanup_pending'
      return this.#cleanupPending
        ? Object.freeze({status: 'clear_failed', committed: true, cleanup_pending: true})
        : Object.freeze({status: 'cleared', committed: true, cleanup_pending: false})
    } catch {
      let cleanupPending = false
      try {
        cleanupPending = (await this.#store.loadManagedMaintenanceJournal())?.operation_id === operationId
      } catch { /* the bounded result does not expose a state-root error */ }
      return Object.freeze({
        status: 'clear_failed', committed: false, cleanup_pending: cleanupPending,
      })
    }
  }

  async withCurrentManagedPath(
    callback: (path: string) => void | Promise<void>,
  ): Promise<Readonly<{status: 'opened' | 'not_managed'}>> {
    if (this.#closed) return Object.freeze({status: 'not_managed'})
    const snapshot = await this.#store.maintenanceSnapshot()
    const current = snapshot.managed_targets.find(
      target => target.workspace.workspace_id === snapshot.active_workspace_id,
    )
    if (current === undefined) return Object.freeze({status: 'not_managed'})
    await callback(current.workspace.canonical_path)
    return Object.freeze({status: 'opened'})
  }

  close(): void {
    this.#closed = true
  }

  #operationId(): string {
    const value = this.#idFactory()
    if (!/^[A-Za-z0-9_-]{8,80}$/u.test(value)) throw new Error('invalid maintenance operation id')
    return value
  }
}

function staleResult(): ManagedWorkspaceExecuteResult {
  return Object.freeze({status: 'stale', committed: false, cleanup_pending: false})
}
