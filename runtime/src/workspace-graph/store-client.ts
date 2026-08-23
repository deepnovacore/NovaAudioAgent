import { randomUUID } from 'node:crypto'
import { Worker, type WorkerOptions } from 'node:worker_threads'

import { z } from 'zod'

import {
  EvidenceRefSchema,
  LogicalWorkspaceSchema,
  ObservationSchema,
  RelationCardSchema,
  WorkspaceInstanceSchema,
  type EvidenceRef,
  type LogicalWorkspace,
  type Observation,
  type RelationCard,
  type WorkspaceInstance,
} from './models.js'
import {
  PublishedGraphSnapshotSchema,
  OperationReceiptSchema,
  WorkspaceGraphBatchResultSchema,
  WorkspaceGraphPrivateStateSchema,
  WORKSPACE_GRAPH_SCHEMA_VERSION,
  type OperationReceipt,
  type PublishedGraphSnapshot,
  type WorkspaceCard,
  type WorkspaceGraphCompactionResult,
  type WorkspaceGraphBatchInput,
  type WorkspaceGraphBatchResult,
  type WorkspaceGraphPrivateState,
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
  STORE_INVALID_OPERATION: 'workspace graph operation is invalid',
  STORE_OPERATION_CONFLICT: 'workspace graph operation replay conflict',
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
  readonly validateResult: RpcResultValidator<unknown>
  readonly request: StoreRequest
  readonly recoverable: boolean
}

interface StoreRequest extends Readonly<Record<string, unknown>> {
  readonly kind: 'request'
  readonly request_id: number
  readonly operation: string
}

type RpcResultValidator<Result> = (value: unknown) => Result

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
const WORKER_CLOSE_GRACE_MS = 250

const publishingOperations = new Set([
  'open',
  'append_observation',
  'replace_card',
  'upsert_relation',
  'suppress_relation',
  'compact',
  'publish_snapshot',
  'graph_batch',
])

const recoverableOperations = new Set([
  'append_observation',
  'replace_card',
  'upsert_relation',
  'suppress_relation',
  'compact',
  'graph_batch',
])

const nullResult: RpcResultValidator<void> = value => {
  if (value !== null) throw new TypeError('invalid null RPC result')
}

const compactionResultSchema = z.object({
  derived_rows_before: z.number().int().nonnegative(),
  derived_rows_after: z.number().int().nonnegative(),
}).strict()

const diagnosticsSchema = z.object({
  schema_version: z.literal(WORKSPACE_GRAPH_SCHEMA_VERSION),
  journal_mode: z.string(),
  foreign_keys: z.boolean(),
  observations: z.number().int().nonnegative(),
  logical_workspaces: z.number().int().nonnegative(),
  workspace_instances: z.number().int().nonnegative(),
  relation_cards: z.number().int().nonnegative(),
  relation_evidence: z.number().int().nonnegative(),
  operation_receipts: z.number().int().nonnegative(),
}).strict()

function schemaResult<Schema extends z.ZodType>(schema: Schema): RpcResultValidator<z.output<Schema>> {
  return value => schema.parse(value)
}

export class WorkspaceGraphStoreClient {
  readonly #workerFactory: (url: URL, options: WorkerOptions) => WorkspaceGraphWorker
  readonly #workerUrl = new URL('./store-worker.js', import.meta.url)
  readonly #workerData: {
    readonly path: string
    readonly deniedRoots: readonly string[]
  }
  #worker: WorkspaceGraphWorker
  readonly #pending = new Map<number, PendingRequest>()
  #nextRequestId = 1
  #publishedSnapshot = initialSnapshot()
  #failed = false
  #closed = false
  #expectedExit = false
  #recovering = false
  #closing: Promise<void> | null = null

  constructor(path: string, options: WorkspaceGraphStoreClientOptions = {}) {
    this.#workerData = {
      path,
      deniedRoots: options.deniedRoots === undefined ? [] : [...options.deniedRoots],
    }
    this.#workerFactory = options.workerFactory
      ?? ((url: URL, configured: WorkerOptions) => new Worker(url, configured))
    this.#worker = this.#spawnWorker()
  }

  get publishedSnapshot(): PublishedGraphSnapshot {
    return this.#publishedSnapshot
  }

  async open(): Promise<void> {
    await this.#request('open', {}, nullResult)
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing
    if (this.#closed) return Promise.resolve()
    const operation = this.#closeFresh()
    this.#closing = operation
    return operation
  }

  async #closeFresh(): Promise<void> {
    this.#closed = true
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!this.#failed) {
      const graceful = this.#requestWhileClosing('close', {}, nullResult).catch(() => undefined)
      await Promise.race([
        graceful,
        new Promise<void>(resolve => { timer = setTimeout(resolve, WORKER_CLOSE_GRACE_MS) }),
      ])
    }
    if (timer !== undefined) clearTimeout(timer)
    this.#expectedExit = true
    try {
      await this.#worker.terminate()
    } catch {
      // A worker that already exited is closed for client lifecycle purposes.
    }
    const error = new WorkspaceGraphStoreClientError('CLIENT_CLOSED')
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }

  appendObservation(observation: Observation, operationId = randomUUID()): Promise<EvidenceRef> {
    return this.#request(
      'append_observation',
      {observation, operationId},
      schemaResult(EvidenceRefSchema),
    )
  }

  async replaceCard(card: WorkspaceCard, operationId = randomUUID()): Promise<void> {
    await this.#request('replace_card', {card, operationId}, nullResult)
  }

  upsertRelation(
    card: RelationCard,
    expectedRevision?: number,
    operationId = randomUUID(),
  ): Promise<RelationCard> {
    return expectedRevision === undefined
      ? this.#request('upsert_relation', {card, operationId}, schemaResult(RelationCardSchema))
      : this.#request(
        'upsert_relation',
        {card, expectedRevision, operationId},
        schemaResult(RelationCardSchema),
      )
  }

  suppressRelation(
    sourceId: string,
    targetId: string,
    relationType: RelationCard['relation_type'],
    evidence: EvidenceRef,
    operationId = randomUUID(),
  ): Promise<RelationCard> {
    return this.#request('suppress_relation', {
      sourceId,
      targetId,
      relationType,
      evidence,
      operationId,
    }, schemaResult(RelationCardSchema))
  }

  compact(operationId = randomUUID()): Promise<WorkspaceGraphCompactionResult> {
    return this.#request('compact', {operationId}, schemaResult(compactionResultSchema))
  }

  async applyGraphBatch(
    batch: WorkspaceGraphBatchInput,
    operationId = randomUUID(),
  ): Promise<WorkspaceGraphBatchResult> {
    return deepFreeze(await this.#request(
      'graph_batch',
      {batch, operationId},
      schemaResult(WorkspaceGraphBatchResultSchema),
    ))
  }

  async loadGraphState(): Promise<WorkspaceGraphPrivateState> {
    return deepFreeze(await this.#request(
      'load_graph_state',
      {},
      schemaResult(WorkspaceGraphPrivateStateSchema),
    ))
  }

  getOperationReceipt(operationId: string): Promise<OperationReceipt | undefined> {
    return this.#request(
      'get_operation_receipt',
      {operationId},
      schemaResult(OperationReceiptSchema.optional()),
    )
  }

  async refreshSnapshot(): Promise<void> {
    await this.#request('publish_snapshot', {}, nullResult)
  }

  listObservations(): Promise<readonly Observation[]> {
    return this.#request('list_observations', {}, schemaResult(z.array(ObservationSchema)))
  }

  getObservation(source: Observation['source'], ref: string): Promise<Observation | undefined> {
    return this.#request('get_observation', {source, ref}, schemaResult(ObservationSchema.optional()))
  }

  listLogicalWorkspaces(): Promise<readonly LogicalWorkspace[]> {
    return this.#request('list_logical_workspaces', {}, schemaResult(z.array(LogicalWorkspaceSchema)))
  }

  getLogicalWorkspace(logicalWorkspaceId: string): Promise<LogicalWorkspace | undefined> {
    return this.#request(
      'get_logical_workspace',
      {logicalWorkspaceId},
      schemaResult(LogicalWorkspaceSchema.optional()),
    )
  }

  listWorkspaceInstances(logicalWorkspaceId?: string): Promise<readonly WorkspaceInstance[]> {
    return logicalWorkspaceId === undefined
      ? this.#request('list_workspace_instances', {}, schemaResult(z.array(WorkspaceInstanceSchema)))
      : this.#request(
        'list_workspace_instances',
        {logicalWorkspaceId},
        schemaResult(z.array(WorkspaceInstanceSchema)),
      )
  }

  getWorkspaceInstance(instanceId: string): Promise<WorkspaceInstance | undefined> {
    return this.#request(
      'get_workspace_instance',
      {instanceId},
      schemaResult(WorkspaceInstanceSchema.optional()),
    )
  }

  listRelations(): Promise<readonly RelationCard[]> {
    return this.#request('list_relations', {}, schemaResult(z.array(RelationCardSchema)))
  }

  getRelation(
    sourceId: string,
    targetId: string,
    relationType: RelationCard['relation_type'],
  ): Promise<RelationCard | undefined> {
    return this.#request(
      'get_relation',
      {sourceId, targetId, relationType},
      schemaResult(RelationCardSchema.optional()),
    )
  }

  listRelationEvidence(
    sourceId: string,
    targetId: string,
    relationType: RelationCard['relation_type'],
  ): Promise<readonly EvidenceRef[]> {
    return this.#request(
      'list_relation_evidence',
      {sourceId, targetId, relationType},
      schemaResult(z.array(EvidenceRefSchema)),
    )
  }

  diagnostics(): Promise<WorkspaceGraphStoreDiagnostics> {
    return this.#request('diagnostics', {}, schemaResult(diagnosticsSchema))
  }

  #request<Result>(
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    validateResult: RpcResultValidator<Result>,
  ): Promise<Result> {
    if (this.#closed || this.#failed) {
      return Promise.reject(new WorkspaceGraphStoreClientError('CLIENT_CLOSED'))
    }
    return this.#send(operation, payload, validateResult)
  }

  #requestWhileClosing<Result>(
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    validateResult: RpcResultValidator<Result>,
  ): Promise<Result> {
    if (this.#failed) return Promise.reject(new WorkspaceGraphStoreClientError('CLIENT_CLOSED'))
    return this.#send(operation, payload, validateResult)
  }

  #send<Result>(
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    validateResult: RpcResultValidator<Result>,
  ): Promise<Result> {
    const requestId = this.#nextRequestId
    this.#nextRequestId += 1
    const request = {kind: 'request', request_id: requestId, operation, ...payload} as const
    return new Promise<Result>((resolve, reject) => {
      this.#pending.set(requestId, {
        resolve: value => resolve(value as Result),
        reject,
        expectsPublication: publishingOperations.has(operation),
        validateResult,
        request,
        recoverable: recoverableOperations.has(operation) && typeof payload.operationId === 'string',
      })
      try {
        this.#worker.postMessage(request)
      } catch {
        this.#pending.delete(requestId)
        reject(new WorkspaceGraphStoreClientError('WORKER_PROTOCOL_FAILURE'))
      }
    })
  }

  #handleMessage(worker: WorkspaceGraphWorker, message: unknown): void {
    if (worker !== this.#worker) return
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
    let result: unknown
    try {
      result = pending.validateResult(response.result)
    } catch {
      this.#fail('WORKER_PROTOCOL_FAILURE')
      return
    }
    if (response.snapshot !== undefined) {
      const parsed = PublishedGraphSnapshotSchema.safeParse(response.snapshot)
      if (
        !parsed.success
        || parsed.data.degraded
        || parsed.data.publication_revision <= this.#publishedSnapshot.publication_revision
      ) {
        this.#fail('WORKER_PROTOCOL_FAILURE')
        return
      }
      this.#publishedSnapshot = deepFreeze(parsed.data)
    } else if (response.publication_failed === true) {
      this.#publishedSnapshot = deepFreeze({...this.#publishedSnapshot, degraded: true})
    }
    this.#pending.delete(response.request_id)
    pending.resolve(result)
  }

  #fail(code: Extract<WorkspaceGraphStoreClientErrorCode, `WORKER_${string}`>): void {
    if (this.#failed || this.#expectedExit) return
    this.#failed = true
    this.#publishedSnapshot = deepFreeze({...this.#publishedSnapshot, degraded: true})
    const error = new WorkspaceGraphStoreClientError(code)
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }

  #spawnWorker(publicationRevisionFloor?: number): WorkspaceGraphWorker {
    const workerData = {
      ...this.#workerData,
      ...(publicationRevisionFloor === undefined ? {} : {publicationRevisionFloor}),
    }
    const worker = this.#workerFactory(this.#workerUrl, {workerData})
    worker.on('message', message => this.#handleMessage(worker, message))
    worker.on('error', () => this.#handleWorkerFailure(worker, 'WORKER_ERROR'))
    worker.on('exit', () => {
      if (!this.#expectedExit) this.#handleWorkerFailure(worker, 'WORKER_EXITED')
    })
    return worker
  }

  #handleWorkerFailure(
    worker: WorkspaceGraphWorker,
    code: 'WORKER_ERROR' | 'WORKER_EXITED',
  ): void {
    if (worker !== this.#worker || this.#failed || this.#expectedExit) return
    if (this.#recovering) {
      this.#fail(code)
      return
    }
    if (![...this.#pending.values()].some(pending => pending.recoverable)) {
      this.#fail(code)
      return
    }
    void this.#recover(code)
  }

  async #recover(code: 'WORKER_ERROR' | 'WORKER_EXITED'): Promise<void> {
    this.#recovering = true
    this.#publishedSnapshot = deepFreeze({...this.#publishedSnapshot, degraded: true})
    const stableError = new WorkspaceGraphStoreClientError(code)
    const recoverable = [...this.#pending.entries()].filter(([, pending]) => pending.recoverable)
    for (const [requestId, pending] of this.#pending.entries()) {
      if (pending.recoverable) continue
      this.#pending.delete(requestId)
      pending.reject(stableError)
    }
    try {
      this.#worker = this.#spawnWorker(this.#publishedSnapshot.publication_revision)
      await this.#send('open', {}, nullResult)
      this.#recovering = false
      for (const [requestId, pending] of recoverable) {
        if (this.#pending.get(requestId) !== pending) continue
        this.#worker.postMessage(pending.request)
      }
    } catch {
      this.#recovering = false
      this.#fail(code)
    }
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
    if (!hasOnlyKeys(message, [
      'kind',
      'request_id',
      'ok',
      'result',
      'snapshot',
      'publication_failed',
    ])) return undefined
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
    if (!hasOnlyKeys(message, ['kind', 'request_id', 'ok', 'error_code'])) return undefined
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every(key => allowedKeys.has(key))
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
