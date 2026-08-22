import {randomUUID} from 'node:crypto'
import {z} from 'zod'

import {
  codePointLengthLikePython,
  isWellFormed,
  stripLikePython,
} from '../python-text.js'
import {normalizeNfkcPinned} from '../unicode-normalize.js'
import {isOtherCategory} from '../unicode-tables.js'
import {
  WorkspaceIdentityResolver,
  applyWorkspaceIdentityDeltas,
  emptyWorkspaceIdentityState,
  type WorkspaceIdentityState,
  type WorkspaceResolutionDecision,
} from './identity.js'
import {
  relationTypeSchema,
  type EvidenceRef,
  type Observation,
  type RelationCard,
} from './models.js'
import {
  GraphProjector,
  applyWorkspaceGraphProjectionDeltas,
  type WorkspaceGraphProjectionState,
} from './projector.js'
import {GraphRecall, type GraphRecallResult} from './recall.js'
import {ContextBudgeter, type GraphContext} from './context.js'
import type {
  PersonalContextProvider,
  ProviderEnrichmentResult,
} from './provider.js'
import {SensitiveContentPolicy, SensitivePathPolicy} from './sensitivity.js'
import {
  WorkspaceGraphStoreClient,
  WorkspaceGraphStoreClientError,
} from './store-client.js'

const STALE_RETRY_LIMIT = 2
export const MAX_WORKSPACE_GRAPH_PENDING_OPERATIONS = 64
const WORKSPACE_GRAPH_SERVICE_DRAIN_GRACE_MS = 250
const EXPLANATION_EVIDENCE_LIMIT = 8
const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1_000
const PROVIDER_SCOPE_MAX_CODE_POINTS = 239
const PROVIDER_SCOPE_MAX_BYTES = 956
const PROVIDER_QUERY_MAX_CODE_POINTS = 4_096
const PROVIDER_QUERY_MAX_BYTES = 8_192

export type WorkspaceGraphServiceDiagnostic =
  | 'workspace_graph_open_failed'
  | 'workspace_graph_write_failed'
  | 'workspace_graph_publication_degraded'
  | 'workspace_graph_close_failed'
  | 'workspace_graph_explain_failed'
  | 'workspace_graph_queue_full'

export type WorkspaceGraphServiceErrorCode =
  | 'GRAPH_SERVICE_CLOSED'
  | 'GRAPH_SERVICE_NOT_OPEN'
  | 'GRAPH_SERVICE_INVALID_INPUT'
  | 'GRAPH_SERVICE_QUEUE_FULL'

const serviceErrorMessages: Readonly<Record<WorkspaceGraphServiceErrorCode, string>> = {
  GRAPH_SERVICE_CLOSED: 'workspace graph service is closed',
  GRAPH_SERVICE_NOT_OPEN: 'workspace graph service is not open',
  GRAPH_SERVICE_INVALID_INPUT: 'workspace graph service input is invalid',
  GRAPH_SERVICE_QUEUE_FULL: 'workspace graph service queue is full',
}

export class WorkspaceGraphServiceError extends Error {
  constructor(readonly code: WorkspaceGraphServiceErrorCode) {
    super(serviceErrorMessages[code])
    this.name = 'WorkspaceGraphServiceError'
  }
}

export interface WorkspaceGraphServiceOptions {
  readonly path: string
  readonly denied_roots?: readonly string[]
  readonly id_factory?: () => string
  readonly operation_id_factory?: () => ReturnType<typeof randomUUID>
  readonly on_diagnostic?: (code: WorkspaceGraphServiceDiagnostic) => void
  readonly store_client?: WorkspaceGraphStoreClient
  readonly personal_context_provider?: PersonalContextProvider
}

export interface OpenWorkspaceInput {
  readonly path: string
  readonly repository_fingerprint: string
  readonly git_remote?: string | null
  readonly branch?: string | null
  readonly now: number
}

export interface TurnContextInput {
  readonly session_epoch: number
  readonly workspace_instance_id: string
  readonly utterance: string
  readonly preferences: readonly string[]
}

export interface ExplicitRecallEnrichmentInput {
  readonly workspace_instance_id: string
  readonly query: string
  readonly limit: number
}

export interface TaskCompletionRelationCue {
  readonly target_logical_id: string
  readonly relation_type: RelationCard['relation_type']
  readonly reason: string
}

export interface TaskCompletionInput {
  readonly workspace_instance_id: string
  readonly summary: string
  readonly outcome: 'ok' | 'unknown' | 'failed'
  readonly now: number
  readonly relation_cue?: TaskCompletionRelationCue | null
}

const taskCompletionInputSchema = z.object({
  workspace_instance_id: z.string().min(1).regex(/\S/u),
  summary: z.string().max(239),
  outcome: z.enum(['ok', 'unknown', 'failed']),
  now: z.number().finite().nonnegative(),
  relation_cue: z.object({
    target_logical_id: z.string().min(1).regex(/\S/u),
    relation_type: relationTypeSchema,
    reason: z.string().min(1).max(239).regex(/\S/u),
  }).strict().nullable().optional(),
}).strict()

const openWorkspaceInputSchema = z.object({
  path: z.string().min(1).max(4_096),
  repository_fingerprint: z.string().min(1).max(239).regex(/\S/u),
  git_remote: z.string().min(1).max(2_048).regex(/\S/u).nullable().optional(),
  branch: z.string().min(1).max(239).regex(/\S/u).nullable().optional(),
  now: z.number().finite().nonnegative(),
}).strict()

const explicitRecallEnrichmentInputSchema = z.object({
  workspace_instance_id: z.string().min(1).max(239).regex(/\S/u),
  query: z.string().min(1).max(4_096).regex(/\S/u),
  limit: z.number().int().positive(),
}).strict()

const unavailableProviderResult: ProviderEnrichmentResult = Object.freeze({
  evidence: Object.freeze([]),
  omitted_evidence: 0,
  degraded: true,
  diagnostic: 'unavailable',
})

const rejectedProviderResult: ProviderEnrichmentResult = Object.freeze({
  evidence: Object.freeze([]),
  omitted_evidence: 0,
  degraded: true,
  diagnostic: 'protocol',
})

interface HintLocation {
  readonly source_logical_id: string
  readonly target_logical_id: string
  readonly relation_type: RelationCard['relation_type']
}

type ServiceState = 'new' | 'open' | 'closing' | 'closed' | 'failed'

export class WorkspaceGraphService {
  readonly #client: WorkspaceGraphStoreClient
  readonly #idFactory: () => string
  readonly #operationIdFactory: () => ReturnType<typeof randomUUID>
  readonly #diagnostic: (code: WorkspaceGraphServiceDiagnostic) => void
  readonly #pathPolicy: SensitivePathPolicy
  readonly #personalContextProvider: PersonalContextProvider | undefined
  readonly #contentPolicy = new SensitiveContentPolicy()
  readonly #budgeter = new ContextBudgeter()
  #identityState: WorkspaceIdentityState = emptyWorkspaceIdentityState()
  #projectionState: WorkspaceGraphProjectionState = Object.freeze({
    logical_workspaces: Object.freeze([]),
    workspace_instances: Object.freeze([]),
    relations: Object.freeze([]),
    projection_records: Object.freeze([]),
  })
  #publishedIdentityState: WorkspaceIdentityState = emptyWorkspaceIdentityState()
  #publishedProjectionState: WorkspaceGraphProjectionState = Object.freeze({
    logical_workspaces: Object.freeze([]),
    workspace_instances: Object.freeze([]),
    relations: Object.freeze([]),
    projection_records: Object.freeze([]),
  })
  #recall = new GraphRecall(null)
  #hintLocations = new Map<string, HintLocation>()
  #tail: Promise<void> = Promise.resolve()
  #pendingOperations = 0
  #state: ServiceState = 'new'
  #closeOperation: Promise<void> | null = null
  #currentWorkspaceInstanceId: string | null = null
  #workspaceScopeGeneration = 0

  constructor(options: WorkspaceGraphServiceOptions) {
    if (typeof options.path !== 'string' || options.path.length === 0) {
      throw new WorkspaceGraphServiceError('GRAPH_SERVICE_INVALID_INPUT')
    }
    this.#client = options.store_client ?? new WorkspaceGraphStoreClient(
      options.path,
      options.denied_roots === undefined ? {} : {deniedRoots: options.denied_roots},
    )
    this.#idFactory = options.id_factory ?? (() => randomUUID())
    this.#operationIdFactory = options.operation_id_factory ?? (() => randomUUID())
    this.#diagnostic = options.on_diagnostic ?? (() => undefined)
    this.#personalContextProvider = options.personal_context_provider
    this.#pathPolicy = new SensitivePathPolicy(
      options.denied_roots === undefined ? {} : {deniedRoots: options.denied_roots},
    )
  }

  get degraded(): boolean {
    return this.#state !== 'open' || this.#client.publishedSnapshot.degraded
  }

  get publishedSnapshot() {
    return this.#client.publishedSnapshot
  }

  async open(): Promise<void> {
    if (this.#state !== 'new') {
      if (this.#state === 'open') return
      throw new WorkspaceGraphServiceError('GRAPH_SERVICE_CLOSED')
    }
    try {
      await this.#client.open()
      await this.#reloadState()
      this.#state = 'open'
    } catch (error) {
      if (this.#state === 'new') this.#state = 'failed'
      this.#emitDiagnostic('workspace_graph_open_failed')
      throw error
    }
  }

  openWorkspace(input: OpenWorkspaceInput): Promise<WorkspaceResolutionDecision> {
    const admitted = parseOpenWorkspaceInput(input)
    // A confirmed host switch revokes the previous provider scope before any queued store work.
    // Until the new instance is committed and published, explicit provider recall is unavailable.
    this.#currentWorkspaceInstanceId = null
    const scopeGeneration = ++this.#workspaceScopeGeneration
    return this.#enqueue(async () => this.#withStaleRetries(async () => {
      const decision = new WorkspaceIdentityResolver(this.#identityState, {
        pathPolicy: this.#pathPolicy,
        contentPolicy: this.#contentPolicy,
      }).resolve({
        path: admitted.path,
        git_remote: admitted.git_remote ?? null,
        repository_fingerprint: admitted.repository_fingerprint,
        ...(admitted.branch === undefined ? {} : {branch: admitted.branch}),
        now: admitted.now,
      })
      if (decision.kind !== 'resolved') {
        this.#currentWorkspaceInstanceId = null
        return decision
      }
      const observation: Observation = {
        observation_id: this.#idFactory(),
        observation_type: 'workspace_opened',
        occurred_at: admitted.now,
        source: 'runtime',
        trust: 'trusted_system',
        logical_workspace_id: decision.logical_workspace.logical_workspace_id,
        workspace_instance_id: decision.instance.instance_id,
        related_logical_workspace_id: null,
        summary: 'confirmed workspace lifecycle',
        outcome: 'ok',
        evidence_refs: [],
      }
      await this.#client.applyGraphBatch({
        observation,
        identity_deltas: decision.deltas,
        projection_deltas: [],
      }, this.#operationIdFactory())
      await this.#reloadState()
      if (scopeGeneration === this.#workspaceScopeGeneration) {
        this.#currentWorkspaceInstanceId = this.#publishedIdentityState.workspace_instances.some(
          candidate => candidate.instance_id === decision.instance.instance_id
            && candidate.status === 'active',
        ) ? decision.instance.instance_id : null
      }
      return decision
    }))
  }

  recordTaskCompletion(input: TaskCompletionInput): Promise<void> {
    const admitted = parseTaskCompletionInput(input)
    return this.#enqueue(async () => this.#withStaleRetries(async () => {
      const workspaceInstanceId = requireSafeIdentity(
        'workspace_instance_id',
        admitted.workspace_instance_id,
        this.#pathPolicy,
        this.#contentPolicy,
      )
      const summary = scrubFreeText('summary', admitted.summary, this.#pathPolicy, this.#contentPolicy)
      const admittedCue = admitted.relation_cue === undefined || admitted.relation_cue === null
        ? null
        : {
          target_logical_id: requireSafeIdentity(
            'target_logical_id',
            admitted.relation_cue.target_logical_id,
            this.#pathPolicy,
            this.#contentPolicy,
          ),
          relation_type: admitted.relation_cue.relation_type,
          reason: scrubFreeText(
            'reason',
            admitted.relation_cue.reason,
            this.#pathPolicy,
            this.#contentPolicy,
          ),
        }
      const instance = this.#identityState.workspace_instances.find(candidate => (
        candidate.instance_id === workspaceInstanceId && candidate.status === 'active'
      ))
      if (instance === undefined) throw new WorkspaceGraphServiceError('GRAPH_SERVICE_INVALID_INPUT')
      const observationId = this.#idFactory()
      const evidence = Object.freeze({
        source: 'executor' as const,
        ref: observationId,
        observed_at: admitted.now,
      })
      const observation: Observation = {
        observation_id: observationId,
        observation_type: 'task_completed',
        occurred_at: admitted.now,
        source: 'executor',
        trust: 'trusted_system',
        logical_workspace_id: instance.logical_workspace_id,
        workspace_instance_id: instance.instance_id,
        related_logical_workspace_id: admittedCue?.reason === null
          ? null
          : admittedCue?.target_logical_id ?? null,
        summary,
        outcome: admitted.outcome,
        evidence_refs: [evidence],
      }
      const projector = new GraphProjector(this.#projectionState, {
        stale_after_ms: STALE_AFTER_MS,
        proactive_confidence_threshold: 0.65,
        path_policy: this.#pathPolicy,
        content_policy: this.#contentPolicy,
      })
      const projected = projector.apply({
        origin: 'trusted_runtime',
        observation,
        relation_cue: admittedCue?.reason === null || admittedCue?.reason === undefined
          ? null
          : {
            kind: 'task_completion',
            stance: 'supplement',
            source_logical_id: instance.logical_workspace_id,
            target_logical_id: admittedCue.target_logical_id,
            relation_type: admittedCue.relation_type,
            reason: admittedCue.reason,
            evidence_refs: [evidence],
          },
      })
      const persistedObservation = projected.deltas.some(delta => delta.kind === 'record_projection')
        ? observation
        : {...observation, related_logical_workspace_id: null}
      await this.#client.applyGraphBatch({
        observation: persistedObservation,
        identity_deltas: [],
        projection_deltas: projected.deltas,
      }, this.#operationIdFactory())
      await this.#reloadState()
    }))
  }

  contextForTurn(input: TurnContextInput): GraphContext | null {
    if (this.#state !== 'open') return null
    const instance = this.#publishedIdentityState.workspace_instances.find(candidate => (
      candidate.instance_id === input.workspace_instance_id && candidate.status === 'active'
    ))
    if (instance === undefined) return null
    const workspace = this.#publishedIdentityState.logical_workspaces.find(candidate => (
      candidate.logical_workspace_id === instance.logical_workspace_id
    ))
    if (workspace === undefined) return null
    const recall = this.#recall.suggest(instance.instance_id, input.utterance)
    this.#rememberHints(instance.logical_workspace_id, recall)
    return this.#budgeter.compose({
      session_epoch: input.session_epoch,
      revision: this.#client.publishedSnapshot.publication_revision,
      logical_workspace: workspace,
      workspace_instance: instance,
    }, recall, input.preferences)
  }

  async enrichAfterExplicitRecall(
    input: ExplicitRecallEnrichmentInput,
  ): Promise<ProviderEnrichmentResult> {
    if (this.#state !== 'open' || this.#personalContextProvider === undefined) {
      return unavailableProviderResult
    }
    const admitted = parseExplicitRecallEnrichmentInput(input)
    if (admitted === null) return rejectedProviderResult
    const workspaceInstanceId = safeProviderInput(
      'workspace_instance_id', admitted.workspace_instance_id,
      PROVIDER_SCOPE_MAX_CODE_POINTS, PROVIDER_SCOPE_MAX_BYTES,
      this.#pathPolicy, this.#contentPolicy,
    )
    const query = safeProviderInput(
      'query', admitted.query,
      PROVIDER_QUERY_MAX_CODE_POINTS, PROVIDER_QUERY_MAX_BYTES,
      this.#pathPolicy, this.#contentPolicy,
    )
    if (
      workspaceInstanceId === null
      || query === null
      || this.#currentWorkspaceInstanceId !== workspaceInstanceId
    ) return rejectedProviderResult
    const instance = this.#publishedIdentityState.workspace_instances.find(candidate => (
      candidate.instance_id === workspaceInstanceId && candidate.status === 'active'
    ))
    if (instance === undefined) return rejectedProviderResult
    const workspace = this.#publishedIdentityState.logical_workspaces.find(candidate => (
      candidate.logical_workspace_id === instance.logical_workspace_id
    ))
    if (workspace === undefined) return rejectedProviderResult
    const logicalWorkspaceId = safeProviderInput(
      'logical_workspace_id', workspace.logical_workspace_id,
      PROVIDER_SCOPE_MAX_CODE_POINTS, PROVIDER_SCOPE_MAX_BYTES,
      this.#pathPolicy, this.#contentPolicy,
    )
    const workspaceName = safeProviderInput(
      'workspace_name', workspace.display_name,
      PROVIDER_SCOPE_MAX_CODE_POINTS, PROVIDER_SCOPE_MAX_BYTES,
      this.#pathPolicy, this.#contentPolicy,
    )
    if (logicalWorkspaceId === null || workspaceName === null) return rejectedProviderResult
    const scopeGeneration = this.#workspaceScopeGeneration
    try {
      const result = await this.#personalContextProvider.lookupWorkspaceEvidence({
        logical_workspace_id: logicalWorkspaceId,
        workspace_name: workspaceName,
        query,
        limit: Math.min(admitted.limit, 8),
      })
      return this.#currentWorkspaceInstanceId === workspaceInstanceId
        && this.#workspaceScopeGeneration === scopeGeneration
        ? result
        : rejectedProviderResult
    } catch {
      return unavailableProviderResult
    }
  }

  explainHint(hintId: string): Promise<readonly EvidenceRef[]> {
    const admittedHintId = z.string().min(1).max(239).safeParse(hintId)
    if (!admittedHintId.success) {
      return Promise.reject(new WorkspaceGraphServiceError('GRAPH_SERVICE_INVALID_INPUT'))
    }
    return this.#enqueue(async () => {
      const location = this.#hintLocations.get(admittedHintId.data)
      if (location === undefined) return Object.freeze([])
      try {
        const evidence = await this.#client.listRelationEvidence(
          location.source_logical_id,
          location.target_logical_id,
          location.relation_type,
        )
        return Object.freeze(evidence.slice(0, EXPLANATION_EVIDENCE_LIMIT).map(item => Object.freeze({...item})))
      } catch {
        this.#emitDiagnostic('workspace_graph_explain_failed')
        return Object.freeze([])
      }
    })
  }

  close(): Promise<void> {
    if (this.#closeOperation !== null) return this.#closeOperation
    if (this.#state === 'closed') return Promise.resolve()
    this.#currentWorkspaceInstanceId = null
    this.#workspaceScopeGeneration += 1
    const operation = this.#closeFresh()
    this.#closeOperation = operation
    return operation
  }

  async #closeFresh(): Promise<void> {
    if (this.#state === 'new') {
      this.#state = 'closing'
      await this.#client.close()
      this.#state = 'closed'
      return
    }
    this.#state = 'closing'
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.#tail.catch(() => undefined),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, WORKSPACE_GRAPH_SERVICE_DRAIN_GRACE_MS)
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    try {
      await this.#client.close()
    } catch {
      this.#emitDiagnostic('workspace_graph_close_failed')
    }
    await this.#tail.catch(() => undefined)
    this.#state = 'closed'
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.#state === 'closing' || this.#state === 'closed' || this.#state === 'failed') {
      return Promise.reject(new WorkspaceGraphServiceError('GRAPH_SERVICE_CLOSED'))
    }
    if (this.#state !== 'open') {
      return Promise.reject(new WorkspaceGraphServiceError('GRAPH_SERVICE_NOT_OPEN'))
    }
    if (this.#pendingOperations >= MAX_WORKSPACE_GRAPH_PENDING_OPERATIONS) {
      this.#emitDiagnostic('workspace_graph_queue_full')
      return Promise.reject(new WorkspaceGraphServiceError('GRAPH_SERVICE_QUEUE_FULL'))
    }
    this.#pendingOperations += 1
    const pending = this.#tail.then(operation)
    const tracked = pending.finally(() => { this.#pendingOperations -= 1 })
    this.#tail = tracked.then(() => undefined, () => undefined)
    return tracked.catch(error => {
      this.#emitDiagnostic('workspace_graph_write_failed')
      throw error
    })
  }

  async #withStaleRetries<Result>(operation: () => Promise<Result>): Promise<Result> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        if (
          !(error instanceof WorkspaceGraphStoreClientError)
          || error.code !== 'STORE_STALE_REVISION'
          || attempt >= STALE_RETRY_LIMIT
        ) throw error
        await this.#reloadState()
      }
    }
  }

  async #reloadState(): Promise<void> {
    const loaded = await this.#client.loadGraphState()
    this.#identityState = applyWorkspaceIdentityDeltas(loaded.identity_state, [])
    this.#projectionState = applyWorkspaceGraphProjectionDeltas(loaded.projection_state, [])
    if (!this.#client.publishedSnapshot.degraded) {
      this.#publishedIdentityState = this.#identityState
      this.#publishedProjectionState = this.#projectionState
    }
    this.#recall = new GraphRecall(this.#client.publishedSnapshot)
    this.#hintLocations = new Map()
    if (this.#client.publishedSnapshot.degraded) {
      this.#emitDiagnostic('workspace_graph_publication_degraded')
    }
  }

  #rememberHints(currentLogicalId: string, recall: GraphRecallResult): void {
    for (const hint of recall.hints) {
      const relation = this.#publishedProjectionState.relations.find(candidate => (
        candidate.relation_type === hint.relation_type
        && candidate.revision === hint.revision
        && (
          (candidate.source_logical_id === currentLogicalId
            && candidate.target_logical_id === hint.logical_workspace_id)
          || (candidate.target_logical_id === currentLogicalId
            && candidate.source_logical_id === hint.logical_workspace_id)
        )
      ))
      if (relation === undefined) continue
      this.#hintLocations.set(hint.hint_id, Object.freeze({
        source_logical_id: relation.source_logical_id,
        target_logical_id: relation.target_logical_id,
        relation_type: relation.relation_type,
      }))
    }
  }

  #emitDiagnostic(code: WorkspaceGraphServiceDiagnostic): void {
    try { this.#diagnostic(code) } catch { /* advisory */ }
  }
}

function parseOpenWorkspaceInput(input: OpenWorkspaceInput): z.infer<typeof openWorkspaceInputSchema> {
  try {
    const parsed = openWorkspaceInputSchema.safeParse(input)
    if (parsed.success) return parsed.data
  } catch {
    // Hostile accessors and proxies collapse to the fixed public input error.
  }
  throw new WorkspaceGraphServiceError('GRAPH_SERVICE_INVALID_INPUT')
}

function parseTaskCompletionInput(input: TaskCompletionInput): z.infer<typeof taskCompletionInputSchema> {
  try {
    const parsed = taskCompletionInputSchema.safeParse(input)
    if (parsed.success) return parsed.data
  } catch {
    // Hostile accessors and proxies collapse to the fixed public input error.
  }
  throw new WorkspaceGraphServiceError('GRAPH_SERVICE_INVALID_INPUT')
}

function parseExplicitRecallEnrichmentInput(
  input: ExplicitRecallEnrichmentInput,
): z.infer<typeof explicitRecallEnrichmentInputSchema> | null {
  try {
    const parsed = explicitRecallEnrichmentInputSchema.safeParse(input)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function safeProviderInput(
  field: string,
  value: string,
  maxCodePoints: number,
  maxBytes: number,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): string | null {
  if (!isWellFormed(value)) return null
  const normalized = normalizeNfkcPinned(value)
  if (
    !isWellFormed(normalized)
    || value === ''
    || stripLikePython(value) !== value
    || stripLikePython(normalized) !== normalized
    || codePointLengthLikePython(value) > maxCodePoints
    || codePointLengthLikePython(normalized) > maxCodePoints
    || utf8Length(value) > maxBytes
    || utf8Length(normalized) > maxBytes
    || containsOtherCategory(value)
    || containsOtherCategory(normalized)
    || contentPolicy.scrub(field, value).kind !== 'clean'
    || contentPolicy.scrub(field, normalized).kind !== 'clean'
    || pathPolicy.scrubText(field, value).kind !== 'clean'
    || pathPolicy.scrubText(field, normalized).kind !== 'clean'
  ) return null
  return value
}

function containsOtherCategory(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && isOtherCategory(codePoint)) return true
  }
  return false
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function requireSafeIdentity(
  field: string,
  value: string,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): string {
  if (
    contentPolicy.scrub(field, value).kind !== 'clean'
    || pathPolicy.scrubText(field, value).kind !== 'clean'
  ) throw new WorkspaceGraphServiceError('GRAPH_SERVICE_INVALID_INPUT')
  return value
}

function scrubFreeText(
  field: string,
  value: string,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): string | null {
  const content = contentPolicy.scrub(field, value)
  if (content.kind === 'rejected') return null
  const afterContent = content.kind === 'redacted' ? content.value : value
  const path = pathPolicy.scrubText(field, afterContent)
  if (path.kind === 'rejected') return null
  return path.kind === 'redacted' ? path.value : afterContent
}
