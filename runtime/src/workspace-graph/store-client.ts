import { Worker, type WorkerOptions } from 'node:worker_threads'

import type {
  EvidenceRef,
  LogicalWorkspace,
  Observation,
  RelationCard,
  WorkspaceInstance,
} from './models.js'
import {
  PublishedGraphSnapshotSchema,
  WORKSPACE_GRAPH_SCHEMA_VERSION,
  type PublishedGraphSnapshot,
  type WorkspaceCard,
  type WorkspaceGraphCompactionResult,
  type WorkspaceGraphStoreDiagnostics,
  type WorkspaceGraphStoreErrorCode,
} from './store.js'

export interface WorkspaceGraphWorker {
  postMessage(value: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
}

export interface WorkspaceGraphStoreClientOptions {
  readonly deniedRoots?: readonly string[]
  readonly workerFactory?: (url: URL, options: WorkerOptions) => WorkspaceGraphWorker
}

export type WorkspaceGraphStoreClientErrorCode =
  | WorkspaceGraphStoreErrorCode
  | 'CLIENT_CLOSED'
  | 'WORKER_ERROR'
  | 'WORKER_EXITED'
  | 'WORKER_PROTOCOL_FAILURE'

const clientErrorMessages: Readonly<Record<WorkspaceGraphStoreClientErrorCode, string>> = {
  CLIENT_CLOSED: 'workspace graph store client is closed',
  WORKER_ERROR: 'workspace graph worker failed',
  WORKER_EXITED: 'workspace graph worker exited',
  WORKER_PROTOCOL_FAILURE: 'workspace graph worker protocol failure',
  STORE_ALREADY_OPEN: 'workspace graph store is already open',
  STORE_CLOSED: 'workspace graph store is closed',
  STORE_IDEMPOTENCY_CONFLICT: 'workspace graph observation replay conflict',
  STORE_INVALID_CARD: 'invalid workspace graph card',
  STORE_INVALID_OBSERVATION: 'invalid workspace graph observation',
  STORE_INVALID_RELATION: 'invalid workspace graph relation',
  STORE_MIGRATION_FAILED: 'workspace graph schema migration failed',
  STORE_NOT_FOUND: 'workspace graph record was not found',
  STORE_READ_FAILED: 'workspace graph read failed',
  STORE_SCHEMA_UNSUPPORTED: 'workspace graph schema version is unsupported',
  STORE_SENSITIVE_CONTENT_REJECTED: 'workspace graph sensitive content was rejected',
  STORE_SENSITIVE_PATH_DENIED: 'workspace graph sensitive path was denied',
  STORE_STALE_REVISION: 'workspace graph revision is stale',
  STORE_WRITE_FAILED: 'workspace graph write failed',
}

export class WorkspaceGraphStoreClientError extends Error {
  readonly code: WorkspaceGraphStoreClientErrorCode

  constructor(code: WorkspaceGraphStoreClientErrorCode) {
    super(clientErrorMessages[code])
    this.name = 'WorkspaceGraphStoreClientError'
    this.code = code
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: WorkspaceGraphStoreClientError) => void
  readonly expectsPublication: boolean
}

interface WorkerSuccess {
  readonly kind: 'response'
  readonly request_id: number
  readonly ok: true
  readonly result: unknown
  readonly snapshot?: unknown
  readonly publication_failed?: true
}

interface WorkerFailure {
  readonly kind: 'response'
  readonly request_id: number
  readonly ok: false
  readonly error_code: WorkspaceGraphStoreErrorCode
}

type WorkerResponse = WorkerSuccess | WorkerFailure

const initialSnapshot = (): PublishedGraphSnapshot => deepFreeze({
  schema_version: WORKSPACE_GRAPH_SCHEMA_VERSION,
  publication_revision: 0,
  degraded: true,
  logical_workspaces: [],
  workspace_instances: [],
  relations: [],
  aliases: [],
})

const publishingOperations = new Set([
  'open',
  'append_observation',
  'replace_card',
  'upsert_relation',
  'suppress_relation',
  'compact',
])

export class WorkspaceGraphStoreClient {
  readonly #worker: WorkspaceGraphWorker
  readonly #pending = new Map<number, PendingRequest>()
  #nextRequestId = 1
  #publishedSnapshot = initialSnapshot()
  #failed = false
  #closed = false
  #expectedExit = false

  constructor(path: string, options: WorkspaceGraphStoreClientOptions = {}) {
    const workerOptions: WorkerOptions = {
      workerData: {
        path,
        deniedRoots: options.deniedRoots === undefined ? [] : [...options.deniedRoots],
      },
    }
    const workerFactory = options.workerFactory
      ?? ((url: URL, configured: WorkerOptions) => new Worker(url, configured))
    this.#worker = workerFactory(new URL('./store-worker.js', import.meta.url), workerOptions)
    this.#worker.on('message', message => this.#handleMessage(message))
    this.#worker.on('error', () => this.#fail('WORKER_ERROR'))
    this.#worker.on('exit', () => {
      if (!this.#expectedExit) this.#fail('WORKER_EXITED')
    })
  }

  get publishedSnapshot(): PublishedGraphSnapshot {
    return this.#publishedSnapshot
  }

  async open(): Promise<void> {
    await this.#request('open', {})
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (!this.#failed) {
      try {
        await this.#requestWhileClosing('close', {})
      } catch {
        // Closing is idempotent and does not replace the already reported worker failure.
      }
    }
    this.#expectedExit = true
    try {
      await this.#worker.terminate()
    } catch {
      // A worker that already exited is closed for client lifecycle purposes.
    }
  }

  appendObservation(observation: Observation): Promise<EvidenceRef> {
    return this.#request('append_observation', {observation})
  }

  async replaceCard(card: WorkspaceCard): Promise<void> {
    await this.#request('replace_card', {card})
  }

  upsertRelation(card: RelationCard, expectedRevision?: number): Promise<RelationCard> {
    return expectedRevision === undefined
      ? this.#request('upsert_relation', {card})
      : this.#request('upsert_relation', {card, expectedRevision})
  }

  suppressRelation(
    sourceId: string,
    targetId: string,
    relationType: RelationCard['relation_type'],
    evidence: EvidenceRef,
  ): Promise<RelationCard> {
    return this.#request('suppress_relation', {
      sourceId,
      targetId,
      relationType,
      evidence,
    })
  }

  compact(): Promise<WorkspaceGraphCompactionResult> {
    return this.#request('compact', {})
  }

  listObservations(): Promise<readonly Observation[]> {
    return this.#request('list_observations', {})
  }

  getObservation(source: Observation['source'], ref: string): Promise<Observation | undefined> {
    return this.#request('get_observation', {source, ref})
  }

  listLogicalWorkspaces(): Promise<readonly LogicalWorkspace[]> {
    return this.#request('list_logical_workspaces', {})
  }

  getLogicalWorkspace(logicalWorkspaceId: string): Promise<LogicalWorkspace | undefined> {
    return this.#request('get_logical_workspace', {logicalWorkspaceId})
  }

  listWorkspaceInstances(logicalWorkspaceId?: string): Promise<readonly WorkspaceInstance[]> {
    return logicalWorkspaceId === undefined
      ? this.#request('list_workspace_instances', {})
      : this.#request('list_workspace_instances', {logicalWorkspaceId})
  }

  getWorkspaceInstance(instanceId: string): Promise<WorkspaceInstance | undefined> {
    return this.#request('get_workspace_instance', {instanceId})
  }

  listRelations(): Promise<readonly RelationCard[]> {
    return this.#request('list_relations', {})
  }

  getRelation(
    sourceId: string,
    targetId: string,
    relationType: RelationCard['relation_type'],
  ): Promise<RelationCard | undefined> {
    return this.#request('get_relation', {sourceId, targetId, relationType})
  }

  listRelationEvidence(
    sourceId: string,
    targetId: string,
    relationType: RelationCard['relation_type'],
  ): Promise<readonly EvidenceRef[]> {
    return this.#request('list_relation_evidence', {sourceId, targetId, relationType})
  }

  diagnostics(): Promise<WorkspaceGraphStoreDiagnostics> {
    return this.#request('diagnostics', {})
  }

  #request<Result>(operation: string, payload: Readonly<Record<string, unknown>>): Promise<Result> {
    if (this.#closed || this.#failed) {
      return Promise.reject(new WorkspaceGraphStoreClientError('CLIENT_CLOSED'))
    }
    return this.#send<Result>(operation, payload)
  }

  #requestWhileClosing<Result>(
    operation: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<Result> {
    if (this.#failed) return Promise.reject(new WorkspaceGraphStoreClientError('CLIENT_CLOSED'))
    return this.#send<Result>(operation, payload)
  }

  #send<Result>(operation: string, payload: Readonly<Record<string, unknown>>): Promise<Result> {
    const requestId = this.#nextRequestId
    this.#nextRequestId += 1
    return new Promise<Result>((resolve, reject) => {
      this.#pending.set(requestId, {
        resolve: value => resolve(value as Result),
        reject,
        expectsPublication: publishingOperations.has(operation),
      })
      try {
        this.#worker.postMessage({kind: 'request', request_id: requestId, operation, ...payload})
      } catch {
        this.#pending.delete(requestId)
        reject(new WorkspaceGraphStoreClientError('WORKER_PROTOCOL_FAILURE'))
      }
    })
  }

  #handleMessage(message: unknown): void {
    const response = parseWorkerResponse(message)
    if (response === undefined) {
      this.#fail('WORKER_PROTOCOL_FAILURE')
      return
    }
    const pending = this.#pending.get(response.request_id)
    if (pending === undefined) {
      this.#fail('WORKER_PROTOCOL_FAILURE')
      return
    }
    if (!response.ok) {
      this.#pending.delete(response.request_id)
      pending.reject(new WorkspaceGraphStoreClientError(response.error_code))
      return
    }
    const hasPublicationOutcome = response.snapshot !== undefined
      || response.publication_failed === true
    if (pending.expectsPublication !== hasPublicationOutcome) {
      this.#fail('WORKER_PROTOCOL_FAILURE')
      return
    }
    if (response.snapshot !== undefined) {
      const parsed = PublishedGraphSnapshotSchema.safeParse(response.snapshot)
      if (!parsed.success) {
        this.#fail('WORKER_PROTOCOL_FAILURE')
        return
      }
      this.#publishedSnapshot = deepFreeze(parsed.data)
    } else if (response.publication_failed === true) {
      this.#publishedSnapshot = deepFreeze({...this.#publishedSnapshot, degraded: true})
    }
    this.#pending.delete(response.request_id)
    pending.resolve(response.result)
  }

  #fail(code: Extract<WorkspaceGraphStoreClientErrorCode, `WORKER_${string}`>): void {
    if (this.#failed || this.#expectedExit) return
    this.#failed = true
    this.#publishedSnapshot = deepFreeze({...this.#publishedSnapshot, degraded: true})
    const error = new WorkspaceGraphStoreClientError(code)
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

function parseWorkerResponse(message: unknown): WorkerResponse | undefined {
  if (
    !isRecord(message)
    || message.kind !== 'response'
    || !Number.isSafeInteger(message.request_id)
    || (message.request_id as number) <= 0
  ) {
    return undefined
  }
  if (message.ok === true && 'result' in message) {
    const hasSnapshot = 'snapshot' in message
    const publicationFailed = message.publication_failed === true
    if (hasSnapshot && publicationFailed) return undefined
    if ('publication_failed' in message && !publicationFailed) return undefined
    return {
      kind: 'response',
      request_id: message.request_id as number,
      ok: true,
      result: message.result,
      ...(hasSnapshot ? {snapshot: message.snapshot} : {}),
      ...(publicationFailed ? {publication_failed: true as const} : {}),
    }
  }
  if (message.ok === false && isStoreErrorCode(message.error_code)) {
    return {
      kind: 'response',
      request_id: message.request_id as number,
      ok: false,
      error_code: message.error_code,
    }
  }
  return undefined
}

function isStoreErrorCode(value: unknown): value is WorkspaceGraphStoreErrorCode {
  return typeof value === 'string' && value in clientErrorMessages && value.startsWith('STORE_')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
