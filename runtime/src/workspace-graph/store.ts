import { createHash } from 'node:crypto'

import { z } from 'zod'

import { canonicalJson, compareCodePoints } from '../canonical-json.js'
import {
  EvidenceRefSchema,
  LogicalWorkspaceSchema,
  ObservationSchema,
  RelationCardSchema,
  WorkspaceInstanceSchema,
  relationTypeSchema,
  type EvidenceRef,
  type LogicalWorkspace,
  type Observation,
  type RelationCard,
  type WorkspaceInstance,
} from './models.js'
import {
  SensitiveContentPolicy,
  SensitivePathPolicy,
  boundRedactedLabel,
} from './sensitivity.js'
import {
  applyWorkspaceIdentityDeltas,
  type WorkspaceAliasObservation,
  type WorkspaceIdentityBinding,
  type WorkspaceIdentityDelta,
  type WorkspaceIdentityState,
} from './identity.js'
import {
  GraphProjector,
  WORKSPACE_TRANSITION_REASON,
  applyWorkspaceGraphProjectionDeltas,
  relationDeltaDigest,
  retainRelationEvidence,
  type ProjectionRecord,
  type WorkspaceGraphProjectionDelta,
  type WorkspaceGraphProjectionState,
} from './projector.js'

export const WORKSPACE_GRAPH_SCHEMA_VERSION = 3
const DERIVED_TABLE_ROW_CAP = 128
const OBSERVATION_ROW_CAP_PER_WORKSPACE = 512
const OBSERVATION_ROW_CAP_GLOBAL = 4_096
const PROJECTION_RECORD_CAP = 512
const ALIAS_OBSERVATION_CAP = 512
const OPERATION_RECEIPT_CAP = 4096
const OPERATION_RECEIPT_MIN_AGE_MS = 24 * 60 * 60 * 1_000

type GraphSqlInput = null | number | bigint | string | NodeJS.ArrayBufferView
type GraphSqlOutput = null | number | bigint | string | NodeJS.NonSharedUint8Array

interface SchemaColumn {
  readonly name: string
  readonly type: 'INTEGER' | 'REAL' | 'TEXT'
  readonly notnull: 0 | 1
  readonly pk: number
}

const column = (
  name: string,
  type: SchemaColumn['type'],
  notnull: SchemaColumn['notnull'] = 1,
  pk = 0,
): SchemaColumn => ({name, type, notnull, pk})

const V1_TABLE_SHAPES = Object.freeze({
  observations: Object.freeze([
    column('observation_id', 'TEXT'), column('observation_type', 'TEXT'),
    column('occurred_at', 'REAL'), column('source', 'TEXT'), column('ref', 'TEXT'),
    column('trust', 'TEXT'), column('logical_workspace_id', 'TEXT', 0),
    column('workspace_instance_id', 'TEXT', 0),
    column('related_logical_workspace_id', 'TEXT', 0), column('summary', 'TEXT', 0),
    column('outcome', 'TEXT', 0), column('payload_json', 'TEXT'),
  ]),
  logical_workspaces: Object.freeze([
    column('logical_workspace_id', 'TEXT', 1, 1), column('display_name', 'TEXT'),
    column('canonical_remote', 'TEXT', 0), column('created_at', 'REAL'),
    column('updated_at', 'REAL'), column('revision', 'INTEGER'), column('payload_json', 'TEXT'),
  ]),
  workspace_instances: Object.freeze([
    column('instance_id', 'TEXT', 1, 1), column('logical_workspace_id', 'TEXT'),
    column('display_name', 'TEXT'), column('path_label', 'TEXT'), column('branch', 'TEXT', 0),
    column('repository_fingerprint', 'TEXT', 0), column('status', 'TEXT'),
    column('first_seen_at', 'REAL'), column('last_seen_at', 'REAL'),
    column('revision', 'INTEGER'), column('payload_json', 'TEXT'),
  ]),
  relation_cards: Object.freeze([
    column('source_logical_id', 'TEXT', 1, 1), column('target_logical_id', 'TEXT', 1, 2),
    column('relation_type', 'TEXT', 1, 3), column('confidence', 'REAL'),
    column('reason', 'TEXT'), column('first_seen_at', 'REAL'), column('last_seen_at', 'REAL'),
    column('status', 'TEXT'), column('revision', 'INTEGER'), column('payload_json', 'TEXT'),
  ]),
  relation_evidence: Object.freeze([
    column('source_logical_id', 'TEXT', 1, 1), column('target_logical_id', 'TEXT', 1, 2),
    column('relation_type', 'TEXT', 1, 3), column('evidence_source', 'TEXT', 1, 4),
    column('evidence_ref', 'TEXT', 1, 5), column('observed_at', 'REAL'),
    column('evidence_json', 'TEXT'),
  ]),
})

const V2_TABLE_SHAPES = Object.freeze({
  ...V1_TABLE_SHAPES,
  operation_receipts: Object.freeze([
    column('receipt_sequence', 'INTEGER', 0, 1), column('operation_id', 'TEXT'),
    column('operation_type', 'TEXT'), column('input_digest', 'TEXT'),
    column('committed_at', 'INTEGER'), column('result_json', 'TEXT'),
  ]),
})

const V3_TABLE_SHAPES = Object.freeze({
  ...V2_TABLE_SHAPES,
  identity_bindings: Object.freeze([
    column('binding_id', 'TEXT', 1, 1), column('instance_id', 'TEXT'),
    column('payload_json', 'TEXT'),
  ]),
  alias_observations: Object.freeze([
    column('observation_id', 'TEXT', 1, 1), column('logical_workspace_id', 'TEXT'),
    column('evidence_ref', 'TEXT'), column('payload_json', 'TEXT'),
  ]),
  projection_records: Object.freeze([
    column('record_id', 'TEXT', 1, 1), column('observation_source', 'TEXT'),
    column('observation_id', 'TEXT'), column('relation_delta_digest', 'TEXT'),
    column('payload_json', 'TEXT'),
  ]),
})

const TABLE_UNIQUE_KEYS: Readonly<Record<string, readonly (readonly string[])[]>> = Object.freeze({
  observations: Object.freeze([
    Object.freeze(['observation_id']),
    Object.freeze(['source', 'ref']),
  ]),
  operation_receipts: Object.freeze([Object.freeze(['operation_id'])]),
  alias_observations: Object.freeze([Object.freeze(['evidence_ref'])]),
  projection_records: Object.freeze([
    Object.freeze(['observation_source', 'observation_id']),
  ]),
})

const RELATION_EVIDENCE_FOREIGN_KEYS = Object.freeze([
  Object.freeze({
    id: 0, seq: 0, target_table: 'relation_cards', from_column: 'source_logical_id',
    to_column: 'source_logical_id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE',
  }),
  Object.freeze({
    id: 0, seq: 1, target_table: 'relation_cards', from_column: 'target_logical_id',
    to_column: 'target_logical_id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE',
  }),
  Object.freeze({
    id: 0, seq: 2, target_table: 'relation_cards', from_column: 'relation_type',
    to_column: 'relation_type', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE',
  }),
])

function compareSchemaKeys(left: readonly string[], right: readonly string[]): number {
  const leftKey = left.join('\u0000')
  const rightKey = right.join('\u0000')
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

export interface GraphStatement {
  all(...parameters: GraphSqlInput[]): Record<string, GraphSqlOutput>[]
  get(...parameters: GraphSqlInput[]): Record<string, GraphSqlOutput> | undefined
  run(...parameters: GraphSqlInput[]): {readonly changes: number | bigint}
}

export interface GraphDatabase {
  exec(sql: string): void
  prepare(sql: string): GraphStatement
  close(): void
}

export type GraphDatabaseFactory = (path: string) => GraphDatabase
export type WorkspaceCard = LogicalWorkspace | WorkspaceInstance

export interface PublishedGraphAlias {
  readonly alias: string
  readonly logical_workspace_id: string
}

export interface PublishedGraphSnapshot {
  readonly schema_version: number
  readonly publication_revision: number
  readonly degraded: boolean
  readonly logical_workspaces: readonly LogicalWorkspace[]
  readonly workspace_instances: readonly WorkspaceInstance[]
  readonly relations: readonly RelationCard[]
  readonly aliases: readonly PublishedGraphAlias[]
}

export const PublishedGraphSnapshotSchema = z.object({
  schema_version: z.literal(WORKSPACE_GRAPH_SCHEMA_VERSION),
  publication_revision: z.number().int().nonnegative(),
  degraded: z.boolean(),
  logical_workspaces: z.array(LogicalWorkspaceSchema),
  workspace_instances: z.array(WorkspaceInstanceSchema),
  relations: z.array(RelationCardSchema.refine(
    relation => relation.status === 'active' || relation.status === 'weak',
    {message: 'published relations must be active or weak'},
  )),
  aliases: z.array(z.object({
    alias: z.string().min(1),
    logical_workspace_id: z.string().min(1),
  }).strict()),
}).strict()

export interface WorkspaceGraphStoreOptions {
  readonly deniedRoots?: readonly string[]
  readonly publicationRevisionFloor?: number
  readonly afterRelationStatement?: () => void
}

export interface WorkspaceGraphStoreDiagnostics {
  readonly schema_version: number
  readonly journal_mode: string
  readonly foreign_keys: boolean
  readonly observations: number
  readonly logical_workspaces: number
  readonly workspace_instances: number
  readonly relation_cards: number
  readonly relation_evidence: number
  readonly operation_receipts: number
}

export interface WorkspaceGraphCompactionResult {
  readonly derived_rows_before: number
  readonly derived_rows_after: number
}

export interface WorkspaceGraphBatchInput {
  readonly observation: Observation
  readonly identity_deltas: readonly WorkspaceIdentityDelta[]
  readonly projection_deltas: readonly WorkspaceGraphProjectionDelta[]
}

export interface WorkspaceGraphBatchResult {
  readonly evidence: EvidenceRef
  readonly identity_delta_digest: string
  readonly projection_delta_digest: string
}

export interface WorkspaceGraphPrivateState {
  readonly identity_state: WorkspaceIdentityState
  readonly projection_state: WorkspaceGraphProjectionState
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

const workspaceIdentityBindingSchema: z.ZodType<WorkspaceIdentityBinding> = z.object({
  binding_id: z.string().min(1),
  logical_workspace_id: z.string().min(1),
  instance_id: z.string().min(1),
  path_key: z.string().min(1),
  remote_key: z.string().min(1).nullable(),
  repository_fingerprint: z.string().min(1).nullable(),
  status: z.enum(['active', 'inactive']),
  first_seen_at: z.number().finite().nonnegative(),
  last_seen_at: z.number().finite().nonnegative(),
}).strict()

const workspaceAliasObservationSchema: z.ZodType<WorkspaceAliasObservation> = z.object({
  observation_id: z.string().min(1),
  logical_workspace_id: z.string().min(1),
  spoken_alias: z.string().min(1),
  normalized_alias: z.string().min(1),
  status: z.enum(['candidate', 'confirmed', 'suppressed']),
  confidence: z.number().finite().min(0).max(1),
  evidence_ref: z.string().min(1),
  observed_at: z.number().finite().nonnegative(),
}).strict()

const projectionRecordSchema: z.ZodType<ProjectionRecord> = z.object({
  record_id: z.string().min(1),
  relation_delta_digest: sha256Schema,
  observation_source: z.enum(['runtime', 'filesystem', 'git', 'executor', 'user', 'provider']),
  observation_id: z.string().min(1),
  signal_digest: sha256Schema,
  source_logical_id: z.string().min(1),
  target_logical_id: z.string().min(1),
  relation_type: relationTypeSchema,
  cue_kind: z.enum([
    'artifact_reference', 'task_completion', 'work_order',
    'workspace_transition', 'user_statement', 'provider_evidence', 'suppression',
  ]),
  cue_reason: z.string().min(1).max(239).regex(/\S/u).optional(),
  stance: z.enum(['confirm', 'supplement', 'conflict', 'suppress']),
  authority: z.enum([
    'provider', 'runtime_inferred', 'user_transcript', 'trusted_system', 'user_confirmed',
  ]),
  occurred_at: z.number().finite().nonnegative(),
  evidence_refs: z.array(EvidenceRefSchema).min(1),
}).strict()

export const WorkspaceGraphPrivateStateSchema: z.ZodType<WorkspaceGraphPrivateState> = z.object({
  identity_state: z.object({
    logical_workspaces: z.array(LogicalWorkspaceSchema),
    workspace_instances: z.array(WorkspaceInstanceSchema),
    bindings: z.array(workspaceIdentityBindingSchema),
    alias_observations: z.array(workspaceAliasObservationSchema),
  }).strict(),
  projection_state: z.object({
    logical_workspaces: z.array(LogicalWorkspaceSchema),
    workspace_instances: z.array(WorkspaceInstanceSchema),
    relations: z.array(RelationCardSchema),
    projection_records: z.array(projectionRecordSchema),
  }).strict(),
}).strict()

const workspaceIdentityDeltaSchema: z.ZodType<WorkspaceIdentityDelta> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('upsert_logical_workspace'),
    workspace: LogicalWorkspaceSchema,
    expected_revision: z.number().int().nonnegative().nullable(),
  }).strict(),
  z.object({
    kind: z.literal('upsert_workspace_instance'),
    instance: WorkspaceInstanceSchema,
    expected_revision: z.number().int().nonnegative().nullable(),
  }).strict(),
  z.object({kind: z.literal('observe_identity_binding'), binding: workspaceIdentityBindingSchema}).strict(),
  z.object({kind: z.literal('record_alias_observation'), observation: workspaceAliasObservationSchema}).strict(),
  z.object({
    kind: z.literal('deactivate_instance_bindings'),
    instance_id: z.string().min(1),
    observed_at: z.number().finite().nonnegative(),
  }).strict(),
])

const workspaceGraphProjectionDeltaSchema: z.ZodType<WorkspaceGraphProjectionDelta> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('upsert_relation'),
    relation: RelationCardSchema,
    expected_revision: z.number().int().nonnegative().nullable(),
  }).strict(),
  z.object({kind: z.literal('record_projection'), record: projectionRecordSchema}).strict(),
])

const workspaceGraphBatchInputSchema: z.ZodType<WorkspaceGraphBatchInput> = z.object({
  observation: ObservationSchema,
  identity_deltas: z.array(workspaceIdentityDeltaSchema),
  projection_deltas: z.array(workspaceGraphProjectionDeltaSchema),
}).strict()

export const WorkspaceGraphBatchResultSchema: z.ZodType<WorkspaceGraphBatchResult> = z.object({
  evidence: EvidenceRefSchema,
  identity_delta_digest: sha256Schema,
  projection_delta_digest: sha256Schema,
}).strict()

const operationTypeSchema = z.enum([
  'append_observation',
  'replace_card',
  'upsert_relation',
  'suppress_relation',
  'compact',
  'graph_batch',
])

const receiptRelationResultSchema = z.object({
  kind: z.literal('relation'),
  relation: RelationCardSchema,
}).strict()

const legacyReceiptRelationResultSchema = z.object({
  kind: z.literal('relation'),
  source_logical_id: z.string().min(1),
  target_logical_id: z.string().min(1),
  relation_type: relationTypeSchema,
  revision: z.number().int().nonnegative(),
  status: z.enum(['active', 'weak', 'stale', 'suppressed']),
}).strict()

const legacyRelationOperationReceiptSchema = z.object({
  operation_id: z.string().uuid(),
  operation_type: z.enum(['upsert_relation', 'suppress_relation']),
  result: legacyReceiptRelationResultSchema,
}).strict()

export const OperationReceiptResultSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('none')}).strict(),
  z.object({kind: z.literal('observation'), evidence: EvidenceRefSchema}).strict(),
  receiptRelationResultSchema,
  z.object({
    kind: z.literal('compaction'),
    derived_rows_before: z.number().int().nonnegative(),
    derived_rows_after: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('graph_batch'),
    evidence: EvidenceRefSchema,
    identity_delta_digest: sha256Schema,
    projection_delta_digest: sha256Schema,
  }).strict(),
])

export const OperationReceiptSchema = z.object({
  operation_id: z.string().uuid(),
  operation_type: operationTypeSchema,
  result: OperationReceiptResultSchema,
}).strict()

export type OperationReceipt = z.infer<typeof OperationReceiptSchema>
type OperationReceiptResult = z.infer<typeof OperationReceiptResultSchema>
type OperationType = z.infer<typeof operationTypeSchema>

export type WorkspaceGraphStoreErrorCode =
  | 'STORE_ALREADY_OPEN'
  | 'STORE_CLOSED'
  | 'STORE_IDEMPOTENCY_CONFLICT'
  | 'STORE_INVALID_CARD'
  | 'STORE_INVALID_OBSERVATION'
  | 'STORE_INVALID_RELATION'
  | 'STORE_MIGRATION_FAILED'
  | 'STORE_NOT_FOUND'
  | 'STORE_INVALID_OPERATION'
  | 'STORE_OPERATION_CONFLICT'
  | 'STORE_READ_FAILED'
  | 'STORE_SCHEMA_UNSUPPORTED'
  | 'STORE_SENSITIVE_CONTENT_REJECTED'
  | 'STORE_SENSITIVE_PATH_DENIED'
  | 'STORE_STALE_REVISION'
  | 'STORE_WRITE_FAILED'

const storeErrorMessages: Readonly<Record<WorkspaceGraphStoreErrorCode, string>> = {
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

export class WorkspaceGraphStoreError extends Error {
  readonly code: WorkspaceGraphStoreErrorCode

  constructor(code: WorkspaceGraphStoreErrorCode) {
    super(storeErrorMessages[code])
    this.name = 'WorkspaceGraphStoreError'
    this.code = code
  }
}

export class WorkspaceGraphStore {
  readonly #path: string
  readonly #databaseFactory: GraphDatabaseFactory
  readonly #pathPolicy: SensitivePathPolicy
  readonly #contentPolicy = new SensitiveContentPolicy()
  readonly #afterRelationStatement: (() => void) | undefined
  #database: GraphDatabase | undefined
  #publicationRevision = 0

  constructor(
    path: string,
    databaseFactory: GraphDatabaseFactory,
    options: WorkspaceGraphStoreOptions = {},
  ) {
    this.#path = path
    this.#databaseFactory = databaseFactory
    this.#pathPolicy = new SensitivePathPolicy(
      options.deniedRoots === undefined ? {} : {deniedRoots: options.deniedRoots},
    )
    this.#publicationRevision = options.publicationRevisionFloor ?? 0
    this.#afterRelationStatement = options.afterRelationStatement
  }

  open(): void {
    if (this.#database !== undefined) throw new WorkspaceGraphStoreError('STORE_ALREADY_OPEN')
    let database: GraphDatabase | undefined
    try {
      database = this.#databaseFactory(this.#path)
      database.exec('PRAGMA busy_timeout=1000')
      database.exec('PRAGMA foreign_keys=ON')
      database.exec('PRAGMA journal_mode=WAL')
      this.#migrate(database)
      this.#database = database
      this.#publicationRevision = Math.max(
        this.#publicationRevision,
        this.#latestReceiptSequence(database),
      )
    } catch (error) {
      try {
        database?.close()
      } catch {
        // The stable migration error below is the only failure exposed across RPC.
      }
      if (error instanceof WorkspaceGraphStoreError) throw error
      throw new WorkspaceGraphStoreError('STORE_MIGRATION_FAILED')
    }
  }

  close(): void {
    if (this.#database === undefined) return
    const database = this.#database
    this.#database = undefined
    try {
      database.close()
    } catch {
      throw new WorkspaceGraphStoreError('STORE_WRITE_FAILED')
    }
  }

  appendObservation(input: Observation, operationId: string): EvidenceRef {
    const parsed = ObservationSchema.safeParse(input)
    if (!parsed.success) throw new WorkspaceGraphStoreError('STORE_INVALID_OBSERVATION')
    const observation = this.#sanitizeObservation(parsed.data)
    const payload = canonicalJson(observation)
    const database = this.#requireDatabase()
    const evidence = {
      source: observation.source,
      ref: observation.observation_id,
      observed_at: observation.occurred_at,
    } satisfies EvidenceRef

    return this.#writeWithReceipt(database, operationId, 'append_observation', observation, receipt => {
      if (receipt.kind !== 'observation') throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
      return receipt.evidence
    }, () => {
      const inserted = database.prepare(`
        INSERT INTO observations(
          observation_id, observation_type, occurred_at, source, ref, trust,
          logical_workspace_id, workspace_instance_id, related_logical_workspace_id,
          summary, outcome, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, ref) DO NOTHING
      `).run(
        observation.observation_id,
        observation.observation_type,
        observation.occurred_at,
        observation.source,
        evidence.ref,
        observation.trust,
        observation.logical_workspace_id,
        observation.workspace_instance_id,
        observation.related_logical_workspace_id,
        observation.summary,
        observation.outcome,
        payload,
      )
      if (inserted.changes === 0 || inserted.changes === 0n) {
        const existing = database.prepare(`
          SELECT payload_json FROM observations WHERE source = ? AND ref = ?
        `).get(evidence.source, evidence.ref)
        if (existing === undefined || stringColumn(existing, 'payload_json') !== payload) {
          throw new WorkspaceGraphStoreError('STORE_IDEMPOTENCY_CONFLICT')
        }
      }
      return {result: evidence, receipt: {kind: 'observation', evidence}}
    })
  }

  applyGraphBatch(input: WorkspaceGraphBatchInput, operationId: string): WorkspaceGraphBatchResult {
    const parsed = workspaceGraphBatchInputSchema.safeParse(input)
    if (!parsed.success) throw new WorkspaceGraphStoreError('STORE_INVALID_OPERATION')
    const observation = this.#sanitizeObservation(parsed.data.observation)
    const identityDeltas = parsed.data.identity_deltas
    const projectionDeltas = parsed.data.projection_deltas.map(delta => delta.kind === 'upsert_relation'
      ? {...delta, relation: this.#sanitizeRelation(delta.relation)}
      : delta)
    if (
      canonicalJson(observation) !== canonicalJson(parsed.data.observation)
      || canonicalJson(projectionDeltas) !== canonicalJson(parsed.data.projection_deltas)
    ) throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
    this.#assertProjectionProvenance(observation, projectionDeltas)
    this.#assertBatchStringsSafe(identityDeltas, projectionDeltas)
    const evidence = EvidenceRefSchema.parse({
      source: observation.source,
      ref: observation.observation_id,
      observed_at: observation.occurred_at,
    })
    const result = WorkspaceGraphBatchResultSchema.parse({
      evidence,
      identity_delta_digest: digest(identityDeltas),
      projection_delta_digest: digest(projectionDeltas),
    })
    const database = this.#requireDatabase()
    return this.#writeWithReceipt(
      database,
      operationId,
      'graph_batch',
      {observation, identity_deltas: identityDeltas, projection_deltas: projectionDeltas},
      receipt => {
        if (receipt.kind !== 'graph_batch') {
          throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
        }
        return WorkspaceGraphBatchResultSchema.parse({
          evidence: receipt.evidence,
          identity_delta_digest: receipt.identity_delta_digest,
          projection_delta_digest: receipt.projection_delta_digest,
        })
      },
      () => {
        this.#insertObservation(database, observation, evidence)
        const current = this.#loadGraphState(database)
        let identityState: WorkspaceIdentityState
        let projectionState: WorkspaceGraphProjectionState
        try {
          identityState = applyWorkspaceIdentityDeltas(current.identity_state, identityDeltas)
          this.#assertTransitionProjectionSemantics(observation, projectionDeltas, {
            ...current.projection_state,
            logical_workspaces: identityState.logical_workspaces,
            workspace_instances: identityState.workspace_instances,
          })
          projectionState = applyWorkspaceGraphProjectionDeltas({
            ...current.projection_state,
            logical_workspaces: identityState.logical_workspaces,
            workspace_instances: identityState.workspace_instances,
          }, projectionDeltas)
        } catch (error) {
          if (isRevisionConflict(error)) {
            throw new WorkspaceGraphStoreError('STORE_STALE_REVISION')
          }
          throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
        }
        this.#persistIdentityState(database, identityState)
        this.#persistProjectionState(database, projectionState)
        return {result, receipt: {kind: 'graph_batch', ...result}}
      },
    )
  }

  loadGraphState(): WorkspaceGraphPrivateState {
    const database = this.#requireDatabase()
    return this.#read(() => this.#loadGraphState(database))
  }

  replaceCard(input: WorkspaceCard, operationId: string): void {
    if (isLogicalWorkspaceInput(input)) {
      const parsed = LogicalWorkspaceSchema.safeParse(input)
      if (!parsed.success) throw new WorkspaceGraphStoreError('STORE_INVALID_CARD')
      const database = this.#requireDatabase()
      this.#writeWithReceipt(database, operationId, 'replace_card', parsed.data, receipt => {
        if (receipt.kind !== 'none') throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
      }, () => {
        this.#replaceLogicalWorkspace(database, parsed.data)
        return {result: undefined, receipt: {kind: 'none'}}
      })
      return
    }
    const parsed = WorkspaceInstanceSchema.safeParse(input)
    if (!parsed.success) throw new WorkspaceGraphStoreError('STORE_INVALID_CARD')
    const database = this.#requireDatabase()
    this.#writeWithReceipt(database, operationId, 'replace_card', parsed.data, receipt => {
      if (receipt.kind !== 'none') throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
    }, () => {
      this.#replaceWorkspaceInstance(database, parsed.data)
      return {result: undefined, receipt: {kind: 'none'}}
    })
  }

  upsertRelation(input: RelationCard, expectedRevision: number | undefined, operationId: string): RelationCard {
    const relation = this.#sanitizeRelation(input)
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
      throw new WorkspaceGraphStoreError('STORE_STALE_REVISION')
    }
    const database = this.#requireDatabase()
    return this.#writeWithReceipt(
      database,
      operationId,
      'upsert_relation',
      {relation, expected_revision: expectedRevision ?? null},
      receipt => this.#relationFromReceipt(receipt),
      () => {
      const existing = this.#relationRow(database, relation)
      if (existing !== undefined && expectedRevision === undefined) {
        throw new WorkspaceGraphStoreError('STORE_STALE_REVISION')
      }
      if (expectedRevision !== undefined) {
        if (existing === undefined || numberColumn(existing, 'revision') !== expectedRevision) {
          throw new WorkspaceGraphStoreError('STORE_STALE_REVISION')
        }
        if (relation.revision !== expectedRevision + 1) {
          throw new WorkspaceGraphStoreError('STORE_STALE_REVISION')
        }
      }
      this.#writeRelation(database, relation)
      this.#syncRelationEvidence(database, relation)
        return {result: relation, receipt: relationReceipt(relation)}
      },
    )
  }

  suppressRelation(
    sourceId: string,
    targetId: string,
    relationType: RelationCard['relation_type'],
    input: EvidenceRef,
    operationId: string,
  ): RelationCard {
    const parsedEvidence = EvidenceRefSchema.safeParse(input)
    const parsedType = relationTypeSchema.safeParse(relationType)
    if (!parsedEvidence.success || !parsedType.success) {
      throw new WorkspaceGraphStoreError('STORE_INVALID_RELATION')
    }
    this.#assertSafeIdentity('source_logical_id', sourceId)
    this.#assertSafeIdentity('target_logical_id', targetId)
    this.#assertSafeIdentity('evidence_source', parsedEvidence.data.source)
    this.#assertSafeIdentity('evidence_ref', parsedEvidence.data.ref)
    const database = this.#requireDatabase()
    return this.#writeWithReceipt(
      database,
      operationId,
      'suppress_relation',
      {sourceId, targetId, relationType: parsedType.data, evidence: parsedEvidence.data},
      receipt => this.#relationFromReceipt(receipt),
      () => {
      const row = database.prepare(`
        SELECT payload_json FROM relation_cards
        WHERE source_logical_id = ? AND target_logical_id = ? AND relation_type = ?
      `).get(sourceId, targetId, parsedType.data)
      if (row === undefined) throw new WorkspaceGraphStoreError('STORE_NOT_FOUND')
      const current = this.#parseRelationPayload(stringColumn(row, 'payload_json'))
      const evidence = parsedEvidence.data
      const hasEvidence = current.evidence_refs.some(item => (
        item.source === evidence.source && item.ref === evidence.ref
      ))
      const suppressed = RelationCardSchema.parse({
        ...current,
        evidence_refs: hasEvidence
          ? current.evidence_refs
          : retainRelationEvidence(current.evidence_refs, [evidence]),
        last_seen_at: Math.max(current.last_seen_at, evidence.observed_at),
        status: 'suppressed',
        revision: current.revision + 1,
      })
      this.#writeRelation(database, suppressed)
      this.#syncRelationEvidence(database, suppressed)
        return {result: suppressed, receipt: relationReceipt(suppressed)}
      },
    )
  }

  compact(operationId: string): WorkspaceGraphCompactionResult {
    const database = this.#requireDatabase()
    return this.#writeWithReceipt(database, operationId, 'compact', {}, receipt => {
      if (receipt.kind !== 'compaction') throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
      return {
        derived_rows_before: receipt.derived_rows_before,
        derived_rows_after: receipt.derived_rows_after,
      }
    }, () => {
      const before = this.#derivedRowCount(database)
      this.#compactTable(
        database,
        'workspace_instances',
        'instance_id',
        "status = 'inactive'",
        'last_seen_at ASC, instance_id ASC',
      )
      this.#compactRelations(database)
      this.#compactRelationEvidence(database)
      this.#compactObservations(database)
      this.#compactProjectionRecords(database)
      this.#compactAliasObservations(database)
      this.#compactOperationReceipts(database)
      const result = {derived_rows_before: before, derived_rows_after: this.#derivedRowCount(database)}
      return {result, receipt: {kind: 'compaction', ...result}}
    })
  }

  getOperationReceipt(operationId: string): OperationReceipt | undefined {
    const parsedId = z.string().uuid().safeParse(operationId)
    if (!parsedId.success) throw new WorkspaceGraphStoreError('STORE_INVALID_OPERATION')
    const database = this.#requireDatabase()
    return this.#read(() => this.#operationReceipt(database, parsedId.data)?.receipt)
  }

  publishSnapshot(): PublishedGraphSnapshot {
    const database = this.#requireDatabase()
    database.exec('BEGIN')
    try {
      const logicalWorkspaces = this.#parseRows(
        database.prepare('SELECT payload_json FROM logical_workspaces ORDER BY logical_workspace_id').all(),
        LogicalWorkspaceSchema,
      )
      const workspaceInstances = this.#parseRows(
        database.prepare('SELECT payload_json FROM workspace_instances ORDER BY instance_id').all(),
        WorkspaceInstanceSchema,
      )
      const relations = this.#parseRows(
        database.prepare(`
          SELECT payload_json FROM relation_cards
          WHERE status IN ('active', 'weak')
          ORDER BY source_logical_id, target_logical_id, relation_type
        `).all(),
        RelationCardSchema,
      )
      const aliases = logicalWorkspaces.flatMap(workspace => (
        workspace.aliases.map(alias => ({alias, logical_workspace_id: workspace.logical_workspace_id}))
      )).sort(compareAliases)
      database.exec('COMMIT')
      this.#publicationRevision += 1
      return PublishedGraphSnapshotSchema.parse({
        schema_version: WORKSPACE_GRAPH_SCHEMA_VERSION,
        publication_revision: this.#publicationRevision,
        degraded: false,
        logical_workspaces: logicalWorkspaces,
        workspace_instances: workspaceInstances,
        relations,
        aliases,
      })
    } catch {
      rollback(database)
      throw new WorkspaceGraphStoreError('STORE_READ_FAILED')
    }
  }

  listObservations(): readonly Observation[] {
    const database = this.#requireDatabase()
    return this.#read(() => this.#parseRows(
      database.prepare(`
        SELECT payload_json FROM observations ORDER BY occurred_at, observation_id
      `).all(),
      ObservationSchema,
    ))
  }

  getObservation(source: Observation['source'], ref: string): Observation | undefined {
    const database = this.#requireDatabase()
    return this.#read(() => {
      const row = database.prepare(`
        SELECT payload_json FROM observations WHERE source = ? AND ref = ?
      `).get(source, ref)
      return row === undefined ? undefined : this.#parseObservationPayload(stringColumn(row, 'payload_json'))
    })
  }

  listLogicalWorkspaces(): readonly LogicalWorkspace[] {
    const database = this.#requireDatabase()
    return this.#read(() => this.#parseRows(
      database.prepare('SELECT payload_json FROM logical_workspaces ORDER BY logical_workspace_id').all(),
      LogicalWorkspaceSchema,
    ))
  }

  getLogicalWorkspace(logicalWorkspaceId: string): LogicalWorkspace | undefined {
    const database = this.#requireDatabase()
    return this.#read(() => {
      const row = database.prepare(`
        SELECT payload_json FROM logical_workspaces WHERE logical_workspace_id = ?
      `).get(logicalWorkspaceId)
      return row === undefined ? undefined : LogicalWorkspaceSchema.parse(JSON.parse(stringColumn(row, 'payload_json')))
    })
  }

  listWorkspaceInstances(logicalWorkspaceId?: string): readonly WorkspaceInstance[] {
    const database = this.#requireDatabase()
    return this.#read(() => {
      const rows = logicalWorkspaceId === undefined
        ? database.prepare('SELECT payload_json FROM workspace_instances ORDER BY instance_id').all()
        : database.prepare(`
          SELECT payload_json FROM workspace_instances
          WHERE logical_workspace_id = ? ORDER BY instance_id
        `).all(logicalWorkspaceId)
      return this.#parseRows(rows, WorkspaceInstanceSchema)
    })
  }

  getWorkspaceInstance(instanceId: string): WorkspaceInstance | undefined {
    const database = this.#requireDatabase()
    return this.#read(() => {
      const row = database.prepare(`
        SELECT payload_json FROM workspace_instances WHERE instance_id = ?
      `).get(instanceId)
      return row === undefined ? undefined : WorkspaceInstanceSchema.parse(JSON.parse(stringColumn(row, 'payload_json')))
    })
  }

  listRelations(): readonly RelationCard[] {
    const database = this.#requireDatabase()
    return this.#read(() => this.#parseRows(
      database.prepare(`
        SELECT payload_json FROM relation_cards
        ORDER BY source_logical_id, target_logical_id, relation_type
      `).all(),
      RelationCardSchema,
    ))
  }

  getRelation(
    sourceId: string,
    targetId: string,
    relationType: RelationCard['relation_type'],
  ): RelationCard | undefined {
    const parsedType = relationTypeSchema.safeParse(relationType)
    if (!parsedType.success) throw new WorkspaceGraphStoreError('STORE_INVALID_RELATION')
    const database = this.#requireDatabase()
    return this.#read(() => {
      const row = database.prepare(`
        SELECT payload_json FROM relation_cards
        WHERE source_logical_id = ? AND target_logical_id = ? AND relation_type = ?
      `).get(sourceId, targetId, parsedType.data)
      return row === undefined ? undefined : this.#parseRelationPayload(stringColumn(row, 'payload_json'))
    })
  }

  listRelationEvidence(
    sourceId: string,
    targetId: string,
    relationType: RelationCard['relation_type'],
  ): readonly EvidenceRef[] {
    const parsedType = relationTypeSchema.safeParse(relationType)
    if (!parsedType.success) throw new WorkspaceGraphStoreError('STORE_INVALID_RELATION')
    const database = this.#requireDatabase()
    return this.#read(() => database.prepare(`
      SELECT evidence_json FROM relation_evidence
      WHERE source_logical_id = ? AND target_logical_id = ? AND relation_type = ?
      ORDER BY observed_at, evidence_source, evidence_ref
    `).all(sourceId, targetId, parsedType.data).map(row => (
      EvidenceRefSchema.parse(JSON.parse(stringColumn(row, 'evidence_json')))
    )))
  }

  diagnostics(): WorkspaceGraphStoreDiagnostics {
    const database = this.#requireDatabase()
    return this.#read(() => ({
      schema_version: this.#schemaVersion(database),
      journal_mode: stringColumn(database.prepare('PRAGMA journal_mode').get(), 'journal_mode'),
      foreign_keys: numberColumn(database.prepare('PRAGMA foreign_keys').get(), 'foreign_keys') === 1,
      observations: this.#tableCount(database, 'observations'),
      logical_workspaces: this.#tableCount(database, 'logical_workspaces'),
      workspace_instances: this.#tableCount(database, 'workspace_instances'),
      relation_cards: this.#tableCount(database, 'relation_cards'),
      relation_evidence: this.#tableCount(database, 'relation_evidence'),
      operation_receipts: this.#tableCount(database, 'operation_receipts'),
    }))
  }

  #migrate(database: GraphDatabase): void {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations(
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        ) STRICT;
      `)
      this.#assertTableShape(database, 'schema_migrations', [
        column('version', 'INTEGER', 0, 1),
        column('applied_at', 'INTEGER'),
      ])
      let version = this.#schemaVersion(database)
      if (version > WORKSPACE_GRAPH_SCHEMA_VERSION) {
        throw new WorkspaceGraphStoreError('STORE_SCHEMA_UNSUPPORTED')
      }
      if (version === 0) {
        if (Object.keys(V3_TABLE_SHAPES).some(table => this.#tableExists(database, table))) {
          throw new Error('unversioned workspace graph tables')
        }
        this.#createV1Schema(database)
        this.#createV2Schema(database)
        this.#createV3Schema(database)
        this.#recordMigration(database, WORKSPACE_GRAPH_SCHEMA_VERSION)
        version = WORKSPACE_GRAPH_SCHEMA_VERSION
      }
      if (version === 1) {
        this.#assertSchemaShape(database, V1_TABLE_SHAPES)
        this.#createV2Schema(database)
        this.#recordMigration(database, 2)
        version = 2
      }
      if (version === 2) {
        this.#assertSchemaShape(database, V2_TABLE_SHAPES)
        this.#createV3Schema(database)
        this.#recordMigration(database, 3)
        version = 3
      }
      if (version !== WORKSPACE_GRAPH_SCHEMA_VERSION) throw new Error('schema version gap')
      this.#assertSchemaShape(database, V3_TABLE_SHAPES)
      this.#createIndexes(database)
      database.exec('COMMIT')
    } catch (error) {
      rollback(database)
      if (error instanceof WorkspaceGraphStoreError) throw error
      throw new WorkspaceGraphStoreError('STORE_MIGRATION_FAILED')
    }
  }

  #createV1Schema(database: GraphDatabase): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS observations(
          observation_id TEXT NOT NULL UNIQUE,
          observation_type TEXT NOT NULL,
          occurred_at REAL NOT NULL,
          source TEXT NOT NULL,
          ref TEXT NOT NULL,
          trust TEXT NOT NULL,
          logical_workspace_id TEXT,
          workspace_instance_id TEXT,
          related_logical_workspace_id TEXT,
          summary TEXT,
          outcome TEXT,
          payload_json TEXT NOT NULL,
          UNIQUE(source, ref)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS observations_scope_time
          ON observations(logical_workspace_id, occurred_at);
        CREATE TABLE IF NOT EXISTS logical_workspaces(
          logical_workspace_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          canonical_remote TEXT,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS workspace_instances(
          instance_id TEXT PRIMARY KEY,
          logical_workspace_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          path_label TEXT NOT NULL,
          branch TEXT,
          repository_fingerprint TEXT,
          status TEXT NOT NULL,
          first_seen_at REAL NOT NULL,
          last_seen_at REAL NOT NULL,
          revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS workspace_instances_logical_status
          ON workspace_instances(logical_workspace_id, status);
        CREATE TABLE IF NOT EXISTS relation_cards(
          source_logical_id TEXT NOT NULL,
          target_logical_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          confidence REAL NOT NULL,
          reason TEXT NOT NULL,
          first_seen_at REAL NOT NULL,
          last_seen_at REAL NOT NULL,
          status TEXT NOT NULL,
          revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY(source_logical_id, target_logical_id, relation_type)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS relation_cards_source_status
          ON relation_cards(source_logical_id, status);
        CREATE TABLE IF NOT EXISTS relation_evidence(
          source_logical_id TEXT NOT NULL,
          target_logical_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          evidence_source TEXT NOT NULL,
          evidence_ref TEXT NOT NULL,
          observed_at REAL NOT NULL,
          evidence_json TEXT NOT NULL,
          PRIMARY KEY(
            source_logical_id, target_logical_id, relation_type,
            evidence_source, evidence_ref
          ),
          FOREIGN KEY(source_logical_id, target_logical_id, relation_type)
            REFERENCES relation_cards(source_logical_id, target_logical_id, relation_type)
            ON DELETE CASCADE
        ) STRICT;
    `)
  }

  #createV2Schema(database: GraphDatabase): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS operation_receipts(
          receipt_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          operation_id TEXT NOT NULL UNIQUE,
          operation_type TEXT NOT NULL,
          input_digest TEXT NOT NULL,
          committed_at INTEGER NOT NULL,
          result_json TEXT NOT NULL
        ) STRICT;
    `)
  }

  #createV3Schema(database: GraphDatabase): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS identity_bindings(
          binding_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          payload_json TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS identity_bindings_instance
          ON identity_bindings(instance_id);
        CREATE TABLE IF NOT EXISTS alias_observations(
          observation_id TEXT PRIMARY KEY,
          logical_workspace_id TEXT NOT NULL,
          evidence_ref TEXT NOT NULL UNIQUE,
          payload_json TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS alias_observations_logical
          ON alias_observations(logical_workspace_id);
        CREATE TABLE IF NOT EXISTS projection_records(
          record_id TEXT PRIMARY KEY,
          observation_source TEXT NOT NULL,
          observation_id TEXT NOT NULL,
          relation_delta_digest TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE(observation_source, observation_id)
        ) STRICT;
    `)
  }

  #createIndexes(database: GraphDatabase): void {
    database.exec(`
      CREATE INDEX IF NOT EXISTS observations_scope_time
        ON observations(logical_workspace_id, occurred_at);
      CREATE INDEX IF NOT EXISTS workspace_instances_logical_status
        ON workspace_instances(logical_workspace_id, status);
      CREATE INDEX IF NOT EXISTS relation_cards_source_status
        ON relation_cards(source_logical_id, status);
      CREATE INDEX IF NOT EXISTS identity_bindings_instance
        ON identity_bindings(instance_id);
      CREATE INDEX IF NOT EXISTS alias_observations_logical
        ON alias_observations(logical_workspace_id);
    `)
  }

  #recordMigration(database: GraphDatabase, version: number): void {
    database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(version, Date.now())
  }

  #assertSchemaShape(
    database: GraphDatabase,
    shapes: Readonly<Record<string, readonly SchemaColumn[]>>,
  ): void {
    for (const [table, columns] of Object.entries(shapes)) {
      this.#assertTableShape(database, table, columns)
    }
  }

  #assertTableShape(
    database: GraphDatabase,
    table: string,
    expected: readonly SchemaColumn[],
  ): void {
    const rawColumns = database.prepare(`PRAGMA table_xinfo("${table}")`).all()
    if (rawColumns.some(row => numberColumn(row, 'hidden') !== 0)) {
      throw new Error(`invalid workspace graph hidden column: ${table}`)
    }
    const actual = rawColumns.map(row => ({
      name: stringColumn(row, 'name'),
      type: stringColumn(row, 'type'),
      notnull: numberColumn(row, 'notnull'),
      pk: numberColumn(row, 'pk'),
    }))
    const tableInfo = database.prepare('PRAGMA table_list').all().find(row => (
      row.name === table && row.type === 'table'
    ))
    if (
      tableInfo === undefined
      || numberColumn(tableInfo, 'strict') !== 1
      || canonicalJson(actual) !== canonicalJson(expected)
    ) throw new Error(`invalid workspace graph table shape: ${table}`)
    this.#assertTableConstraints(database, table)
  }

  #assertTableConstraints(database: GraphDatabase, table: string): void {
    const uniqueKeys = database.prepare(`
      SELECT name FROM pragma_index_list(?)
      WHERE "unique" = 1 AND origin = 'u'
    `).all(table).map(row => database.prepare(`
      SELECT name FROM pragma_index_info(?) ORDER BY seqno
    `).all(stringColumn(row, 'name')).map(columnRow => stringColumn(columnRow, 'name')))
      .sort(compareSchemaKeys)
    const expectedUniqueKeys = [...(TABLE_UNIQUE_KEYS[table] ?? [])]
      .map(key => [...key])
      .sort(compareSchemaKeys)
    if (canonicalJson(uniqueKeys) !== canonicalJson(expectedUniqueKeys)) {
      throw new Error(`invalid workspace graph unique constraints: ${table}`)
    }

    const foreignKeys = database.prepare(`
      SELECT
        id, seq, "table" AS target_table, "from" AS from_column, "to" AS to_column,
        on_update, on_delete, match
      FROM pragma_foreign_key_list(?) ORDER BY id, seq
    `).all(table).map(row => ({
      id: numberColumn(row, 'id'),
      seq: numberColumn(row, 'seq'),
      target_table: stringColumn(row, 'target_table'),
      from_column: stringColumn(row, 'from_column'),
      to_column: stringColumn(row, 'to_column'),
      on_update: stringColumn(row, 'on_update'),
      on_delete: stringColumn(row, 'on_delete'),
      match: stringColumn(row, 'match'),
    }))
    const expectedForeignKeys = table === 'relation_evidence'
      ? RELATION_EVIDENCE_FOREIGN_KEYS
      : []
    if (canonicalJson(foreignKeys) !== canonicalJson(expectedForeignKeys)) {
      throw new Error(`invalid workspace graph foreign keys: ${table}`)
    }

    const createRow = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table)
    const hasAutoincrement = createRow !== undefined
      && /\bAUTOINCREMENT\b/iu.test(stringColumn(createRow, 'sql'))
    if (hasAutoincrement !== (table === 'operation_receipts')) {
      throw new Error(`invalid workspace graph autoincrement: ${table}`)
    }
  }

  #tableExists(database: GraphDatabase, table: string): boolean {
    return database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) !== undefined
  }

  #schemaVersion(database: GraphDatabase): number {
    const row = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()
    if (row === undefined || row.version === null) return 0
    return numberColumn(row, 'version')
  }

  #sanitizeObservation(observation: Observation): Observation {
    const identityFields: readonly (readonly [string, string | null])[] = [
      ['observation_id', observation.observation_id],
      ['observation_type', observation.observation_type],
      ['source', observation.source],
      ['trust', observation.trust],
      ['logical_workspace_id', observation.logical_workspace_id],
      ['workspace_instance_id', observation.workspace_instance_id],
      ['related_logical_workspace_id', observation.related_logical_workspace_id],
      ['outcome', observation.outcome],
    ]
    for (const [field, value] of identityFields) {
      if (value !== null) this.#assertSafeIdentity(field, value)
    }
    for (const evidence of observation.evidence_refs) {
      this.#assertSafeIdentity('evidence_source', evidence.source)
      this.#assertSafeIdentity('evidence_ref', evidence.ref)
    }
    if (observation.summary === null) return observation
    const content = this.#contentPolicy.scrub('summary', observation.summary)
    if (content.kind === 'rejected') return ObservationSchema.parse({...observation, summary: null})
    const contentSafe = content.kind === 'redacted' ? content.value : observation.summary
    const path = this.#pathPolicy.scrubText('summary', contentSafe)
    if (content.kind === 'clean' && path.kind === 'clean') return observation
    const scrubbed = path.kind === 'rejected'
      ? null
      : boundRedactedLabel(path.kind === 'redacted' ? path.value : contentSafe)
    return ObservationSchema.parse({
      ...observation,
      summary: scrubbed,
    })
  }

  #insertObservation(database: GraphDatabase, observation: Observation, evidence: EvidenceRef): void {
    const payload = canonicalJson(observation)
    const inserted = database.prepare(`
      INSERT INTO observations(
        observation_id, observation_type, occurred_at, source, ref, trust,
        logical_workspace_id, workspace_instance_id, related_logical_workspace_id,
        summary, outcome, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, ref) DO NOTHING
    `).run(
      observation.observation_id,
      observation.observation_type,
      observation.occurred_at,
      observation.source,
      evidence.ref,
      observation.trust,
      observation.logical_workspace_id,
      observation.workspace_instance_id,
      observation.related_logical_workspace_id,
      observation.summary,
      observation.outcome,
      payload,
    )
    if (inserted.changes === 0 || inserted.changes === 0n) {
      const existing = database.prepare(`
        SELECT payload_json FROM observations WHERE source = ? AND ref = ?
      `).get(evidence.source, evidence.ref)
      if (existing === undefined || stringColumn(existing, 'payload_json') !== payload) {
        throw new WorkspaceGraphStoreError('STORE_IDEMPOTENCY_CONFLICT')
      }
    }
  }

  #assertBatchStringsSafe(
    identityDeltas: readonly WorkspaceIdentityDelta[],
    projectionDeltas: readonly WorkspaceGraphProjectionDelta[],
  ): void {
    for (const delta of identityDeltas) {
      if (delta.kind === 'upsert_logical_workspace') {
        this.#assertSafeCard(delta.workspace)
      } else if (delta.kind === 'upsert_workspace_instance') {
        this.#assertSafeCard(delta.instance)
      } else if (delta.kind === 'observe_identity_binding') {
        for (const [field, value] of Object.entries(delta.binding)) {
          if (typeof value === 'string') this.#assertSafeIdentity(field, value)
        }
      } else if (delta.kind === 'record_alias_observation') {
        for (const [field, value] of Object.entries(delta.observation)) {
          if (typeof value === 'string') this.#assertSafeIdentity(field, value)
        }
      } else {
        this.#assertSafeIdentity('instance_id', delta.instance_id)
      }
    }
    for (const delta of projectionDeltas) {
      if (delta.kind === 'upsert_relation') continue
      for (const [field, value] of Object.entries(delta.record)) {
        if (typeof value === 'string') this.#assertSafeIdentity(field, value)
      }
      for (const evidence of delta.record.evidence_refs) {
        this.#assertSafeIdentity('evidence_source', evidence.source)
        this.#assertSafeIdentity('evidence_ref', evidence.ref)
      }
    }
  }

  #assertSafeCard(card: WorkspaceCard): void {
    for (const [field, value] of Object.entries(card)) {
      if (typeof value === 'string') this.#assertSafeIdentity(field, value)
      if (Array.isArray(value)) {
        for (const item of value) if (typeof item === 'string') this.#assertSafeIdentity(field, item)
      }
    }
  }

  #loadGraphState(database: GraphDatabase): WorkspaceGraphPrivateState {
    const logicalWorkspaces = this.#parseRows(
      database.prepare('SELECT payload_json FROM logical_workspaces ORDER BY logical_workspace_id').all(),
      LogicalWorkspaceSchema,
    )
    const workspaceInstances = this.#parseRows(
      database.prepare('SELECT payload_json FROM workspace_instances ORDER BY instance_id').all(),
      WorkspaceInstanceSchema,
    )
    const bindings = this.#parseRows(
      database.prepare('SELECT payload_json FROM identity_bindings ORDER BY binding_id').all(),
      workspaceIdentityBindingSchema,
    )
    const aliasObservations = this.#parseRows(
      database.prepare('SELECT payload_json FROM alias_observations ORDER BY observation_id').all(),
      workspaceAliasObservationSchema,
    )
    const relations = this.#parseRows(
      database.prepare(`SELECT payload_json FROM relation_cards
        ORDER BY source_logical_id, target_logical_id, relation_type`).all(),
      RelationCardSchema,
    )
    const projectionRecords = this.#parseRows(
      database.prepare('SELECT payload_json FROM projection_records ORDER BY record_id').all(),
      projectionRecordSchema,
    )
    return WorkspaceGraphPrivateStateSchema.parse({
      identity_state: {
        logical_workspaces: logicalWorkspaces,
        workspace_instances: workspaceInstances,
        bindings,
        alias_observations: aliasObservations,
      },
      projection_state: {
        logical_workspaces: logicalWorkspaces,
        workspace_instances: workspaceInstances,
        relations,
        projection_records: projectionRecords,
      },
    })
  }

  #persistIdentityState(database: GraphDatabase, state: WorkspaceIdentityState): void {
    for (const workspace of state.logical_workspaces) this.#replaceLogicalWorkspace(database, workspace)
    for (const instance of state.workspace_instances) this.#replaceWorkspaceInstance(database, instance)
    for (const binding of state.bindings) {
      database.prepare(`INSERT INTO identity_bindings(binding_id, instance_id, payload_json)
        VALUES (?, ?, ?) ON CONFLICT(binding_id) DO UPDATE SET
        instance_id = excluded.instance_id, payload_json = excluded.payload_json`).run(
        binding.binding_id, binding.instance_id, canonicalJson(binding),
      )
    }
    for (const observation of state.alias_observations) {
      database.prepare(`INSERT INTO alias_observations(
        observation_id, logical_workspace_id, evidence_ref, payload_json
      ) VALUES (?, ?, ?, ?) ON CONFLICT(observation_id) DO UPDATE SET
        logical_workspace_id = excluded.logical_workspace_id,
        evidence_ref = excluded.evidence_ref, payload_json = excluded.payload_json`).run(
        observation.observation_id,
        observation.logical_workspace_id,
        observation.evidence_ref,
        canonicalJson(observation),
      )
    }
  }

  #persistProjectionState(database: GraphDatabase, state: WorkspaceGraphProjectionState): void {
    for (const relation of state.relations) {
      this.#writeRelation(database, relation)
      this.#syncRelationEvidence(database, relation)
    }
    for (const record of state.projection_records) {
      database.prepare(`INSERT INTO projection_records(
        record_id, observation_source, observation_id, relation_delta_digest, payload_json
      ) VALUES (?, ?, ?, ?, ?) ON CONFLICT(record_id) DO UPDATE SET
        relation_delta_digest = excluded.relation_delta_digest,
        payload_json = excluded.payload_json`).run(
        record.record_id,
        record.observation_source,
        record.observation_id,
        record.relation_delta_digest,
        canonicalJson(record),
      )
    }
  }

  #assertProjectionProvenance(
    observation: Observation,
    deltas: readonly WorkspaceGraphProjectionDelta[],
  ): void {
    const relations = deltas.filter((delta): delta is Extract<
      WorkspaceGraphProjectionDelta,
      {kind: 'upsert_relation'}
    > => delta.kind === 'upsert_relation')
    const records = deltas.filter((delta): delta is Extract<
      WorkspaceGraphProjectionDelta,
      {kind: 'record_projection'}
    > => delta.kind === 'record_projection')
    const relationKeys = new Set(relations.map(delta => projectionRelationKey(delta.relation)))
    const recordKeys = new Set(records.map(delta => projectionRelationKey(delta.record)))
    if (
      relations.length !== records.length
      || relationKeys.size !== relations.length
      || recordKeys.size !== records.length
    ) throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
    for (const delta of records) {
      const record = delta.record
      const relation = relations.find(candidate => (
        candidate.relation.source_logical_id === record.source_logical_id
        && candidate.relation.target_logical_id === record.target_logical_id
        && candidate.relation.relation_type === record.relation_type
      ))
      const recordMatchesObservation = record.cue_kind === 'workspace_transition'
        ? record.source_logical_id === observation.related_logical_workspace_id
          && record.target_logical_id === observation.logical_workspace_id
        : record.source_logical_id === observation.logical_workspace_id
          && record.target_logical_id === observation.related_logical_workspace_id
      const transitionEvidence = observation.evidence_refs[0]
      const transitionProvenanceIsValid = record.cue_kind !== 'workspace_transition' || (
        observation.observation_type === 'workspace_opened'
        && observation.source === 'runtime'
        && observation.trust === 'trusted_system'
        && record.authority === 'runtime_inferred'
        && record.stance === 'supplement'
        && record.relation_type === 'discussed_with'
        && record.cue_reason === WORKSPACE_TRANSITION_REASON
        && observation.evidence_refs.length === 1
        && transitionEvidence?.source === 'runtime'
        && transitionEvidence.ref === observation.observation_id
        && transitionEvidence.observed_at === observation.occurred_at
      )
      if (
        relation === undefined
        || relationDeltaDigest(relation) !== record.relation_delta_digest
        || record.observation_source !== observation.source
        || record.observation_id !== observation.observation_id
        || record.occurred_at !== observation.occurred_at
        || !recordMatchesObservation
        || !transitionProvenanceIsValid
        || (record.cue_kind !== 'workspace_transition' && record.cue_reason !== undefined)
        || canonicalJson(record.evidence_refs) !== canonicalJson(observation.evidence_refs)
        || record.evidence_refs.some(evidence => !relation.relation.evidence_refs.some(candidate => (
          candidate.source === evidence.source
          && candidate.ref === evidence.ref
          && candidate.observed_at === evidence.observed_at
        )))
      ) throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
    }
  }

  #assertTransitionProjectionSemantics(
    observation: Observation,
    deltas: readonly WorkspaceGraphProjectionDelta[],
    state: WorkspaceGraphProjectionState,
  ): void {
    const transitionRecord = deltas.find(delta => (
      delta.kind === 'record_projection' && delta.record.cue_kind === 'workspace_transition'
    ))
    if (transitionRecord?.kind !== 'record_projection') return
    const record = transitionRecord.record
    try {
      const expected = new GraphProjector(state, {
        stale_after_ms: 90 * 24 * 60 * 60,
        proactive_confidence_threshold: 0.65,
        path_policy: this.#pathPolicy,
        content_policy: this.#contentPolicy,
      }).apply({
        origin: 'trusted_runtime',
        observation,
        relation_cue: {
          kind: 'workspace_transition',
          stance: 'supplement',
          source_logical_id: record.source_logical_id,
          target_logical_id: record.target_logical_id,
          relation_type: 'discussed_with',
          reason: record.cue_reason ?? '',
          evidence_refs: record.evidence_refs,
        },
      })
      if (canonicalJson(expected.deltas) !== canonicalJson(deltas)) {
        throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
      }
    } catch (error) {
      if (error instanceof WorkspaceGraphStoreError) throw error
      throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
    }
  }

  #assertSafeIdentity(field: string, value: string): void {
    if (this.#contentPolicy.scrub(field, value).kind !== 'clean') {
      throw new WorkspaceGraphStoreError('STORE_SENSITIVE_CONTENT_REJECTED')
    }
    if (this.#pathPolicy.scrubText(field, value).kind !== 'clean') {
      throw new WorkspaceGraphStoreError('STORE_SENSITIVE_PATH_DENIED')
    }
  }

  #sanitizeRelation(input: RelationCard): RelationCard {
    const parsed = RelationCardSchema.safeParse(input)
    if (!parsed.success) throw new WorkspaceGraphStoreError('STORE_INVALID_RELATION')
    this.#assertSafeIdentity('source_logical_id', parsed.data.source_logical_id)
    this.#assertSafeIdentity('target_logical_id', parsed.data.target_logical_id)
    for (const evidence of parsed.data.evidence_refs) {
      this.#assertSafeIdentity('evidence_source', evidence.source)
      this.#assertSafeIdentity('evidence_ref', evidence.ref)
    }
    const bounded = RelationCardSchema.parse({
      ...parsed.data,
      evidence_refs: retainRelationEvidence([], parsed.data.evidence_refs),
    })
    const content = this.#contentPolicy.scrub('reason', bounded.reason)
    if (content.kind === 'rejected') {
      throw new WorkspaceGraphStoreError('STORE_SENSITIVE_CONTENT_REJECTED')
    }
    const contentSafe = content.kind === 'redacted' ? content.value : bounded.reason
    const path = this.#pathPolicy.scrubText('reason', contentSafe)
    if (content.kind === 'clean' && path.kind === 'clean') return bounded
    const scrubbed = boundRedactedLabel(path.kind === 'redacted' ? path.value : contentSafe)
    const redacted = RelationCardSchema.safeParse({
      ...bounded,
      reason: path.kind === 'rejected'
        ? '[redacted]'
        : scrubbed ?? '[redacted]',
    })
    if (!redacted.success) throw new WorkspaceGraphStoreError('STORE_INVALID_RELATION')
    return redacted.data
  }

  #replaceLogicalWorkspace(database: GraphDatabase, workspace: LogicalWorkspace): void {
      database.prepare(`
        INSERT INTO logical_workspaces(
          logical_workspace_id, display_name, canonical_remote,
          created_at, updated_at, revision, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(logical_workspace_id) DO UPDATE SET
          display_name = excluded.display_name,
          canonical_remote = excluded.canonical_remote,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          revision = excluded.revision,
          payload_json = excluded.payload_json
      `).run(
        workspace.logical_workspace_id,
        workspace.display_name,
        workspace.canonical_remote,
        workspace.created_at,
        workspace.updated_at,
        workspace.revision,
        canonicalJson(workspace),
      )
  }

  #replaceWorkspaceInstance(database: GraphDatabase, instance: WorkspaceInstance): void {
      database.prepare(`
        INSERT INTO workspace_instances(
          instance_id, logical_workspace_id, display_name, path_label, branch,
          repository_fingerprint, status, first_seen_at, last_seen_at, revision, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_id) DO UPDATE SET
          logical_workspace_id = excluded.logical_workspace_id,
          display_name = excluded.display_name,
          path_label = excluded.path_label,
          branch = excluded.branch,
          repository_fingerprint = excluded.repository_fingerprint,
          status = excluded.status,
          first_seen_at = excluded.first_seen_at,
          last_seen_at = excluded.last_seen_at,
          revision = excluded.revision,
          payload_json = excluded.payload_json
      `).run(
        instance.instance_id,
        instance.logical_workspace_id,
        instance.display_name,
        instance.path_label,
        instance.branch,
        instance.repository_fingerprint,
        instance.status,
        instance.first_seen_at,
        instance.last_seen_at,
        instance.revision,
        canonicalJson(instance),
      )
  }

  #relationRow(database: GraphDatabase, relation: RelationCard): Record<string, GraphSqlOutput> | undefined {
    return database.prepare(`
      SELECT revision FROM relation_cards
      WHERE source_logical_id = ? AND target_logical_id = ? AND relation_type = ?
    `).get(relation.source_logical_id, relation.target_logical_id, relation.relation_type)
  }

  #writeRelation(database: GraphDatabase, relation: RelationCard): void {
    database.prepare(`
      INSERT INTO relation_cards(
        source_logical_id, target_logical_id, relation_type, confidence, reason,
        first_seen_at, last_seen_at, status, revision, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_logical_id, target_logical_id, relation_type) DO UPDATE SET
        confidence = excluded.confidence,
        reason = excluded.reason,
        first_seen_at = excluded.first_seen_at,
        last_seen_at = excluded.last_seen_at,
        status = excluded.status,
        revision = excluded.revision,
        payload_json = excluded.payload_json
    `).run(
      relation.source_logical_id,
      relation.target_logical_id,
      relation.relation_type,
      relation.confidence,
      relation.reason,
      relation.first_seen_at,
      relation.last_seen_at,
      relation.status,
      relation.revision,
      canonicalJson(relation),
    )
    this.#afterRelationStatement?.()
  }

  #writeRelationEvidence(database: GraphDatabase, relation: RelationCard, evidence: EvidenceRef): void {
    database.prepare(`
      INSERT OR IGNORE INTO relation_evidence(
        source_logical_id, target_logical_id, relation_type,
        evidence_source, evidence_ref, observed_at, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      relation.source_logical_id,
      relation.target_logical_id,
      relation.relation_type,
      evidence.source,
      evidence.ref,
      evidence.observed_at,
      canonicalJson(evidence),
    )
  }

  #syncRelationEvidence(database: GraphDatabase, relation: RelationCard): void {
    database.prepare(`
      DELETE FROM relation_evidence
      WHERE source_logical_id = ? AND target_logical_id = ? AND relation_type = ?
    `).run(relation.source_logical_id, relation.target_logical_id, relation.relation_type)
    for (const evidence of relation.evidence_refs) {
      this.#writeRelationEvidence(database, relation, evidence)
    }
  }

  #compactTable(
    database: GraphDatabase,
    table: 'workspace_instances',
    key: 'instance_id',
    predicate: string,
    order: string,
  ): void {
    const count = this.#tableCount(database, table)
    const remove = Math.max(0, count - DERIVED_TABLE_ROW_CAP)
    if (remove === 0) return
    database.prepare(`
      DELETE FROM ${table} WHERE ${key} IN (
        SELECT ${key} FROM ${table} WHERE ${predicate} ORDER BY ${order} LIMIT ?
      )
    `).run(remove)
  }

  #compactRelations(database: GraphDatabase): void {
    const count = this.#tableCount(database, 'relation_cards')
    const remove = Math.max(0, count - DERIVED_TABLE_ROW_CAP)
    if (remove === 0) return
    database.prepare(`
      DELETE FROM relation_cards
      WHERE (source_logical_id, target_logical_id, relation_type) IN (
        SELECT source_logical_id, target_logical_id, relation_type
        FROM relation_cards
        WHERE status = 'stale'
        ORDER BY last_seen_at, source_logical_id, target_logical_id, relation_type
        LIMIT ?
      )
    `).run(remove)
  }

  #compactRelationEvidence(database: GraphDatabase): void {
    const relations = this.#parseRows(
      database.prepare('SELECT payload_json FROM relation_cards').all(),
      RelationCardSchema,
    )
    for (const relation of relations) {
      const evidenceRefs = retainRelationEvidence([], relation.evidence_refs)
      const retained = evidenceRefs.length === relation.evidence_refs.length
        ? relation
        : RelationCardSchema.parse({...relation, evidence_refs: evidenceRefs})
      if (retained !== relation) this.#writeRelation(database, retained)
      this.#syncRelationEvidence(database, retained)
    }
  }

  #compactObservations(database: GraphDatabase): void {
    database.prepare(`
      DELETE FROM observations WHERE observation_id IN (
        SELECT observation_id FROM (
          SELECT
            observation_id,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(logical_workspace_id, '')
              ORDER BY occurred_at DESC, observation_id DESC
            ) AS workspace_rank
          FROM observations
        ) WHERE workspace_rank > ?
      )
    `).run(OBSERVATION_ROW_CAP_PER_WORKSPACE)
    const remove = Math.max(
      0,
      this.#tableCount(database, 'observations') - OBSERVATION_ROW_CAP_GLOBAL,
    )
    if (remove === 0) return
    database.prepare(`
      DELETE FROM observations WHERE observation_id IN (
        SELECT observation_id FROM observations
        ORDER BY occurred_at ASC, observation_id ASC
        LIMIT ?
      )
    `).run(remove)
  }

  #compactProjectionRecords(database: GraphDatabase): void {
    const records = this.#parseRows(
      database.prepare('SELECT payload_json FROM projection_records').all(),
      projectionRecordSchema,
    )
    if (records.length <= PROJECTION_RECORD_CAP) return
    const protectedByRelation = new Map<string, ProjectionRecord>()
    for (const record of records) {
      const category = projectionRetentionCategory(record)
      if (category === null) continue
      const key = `${projectionRelationKey(record)}\u0000${category}`
      const current = protectedByRelation.get(key)
      if (current === undefined || compareRecordRecency(record, current) > 0) {
        protectedByRelation.set(key, record)
      }
    }
    const protectedRecords = [...protectedByRelation.values()].sort((left, right) => (
      projectionRetentionPriority(left) - projectionRetentionPriority(right)
      || compareRecordRecency(right, left)
    ))
    const retained = new Set<string>()
    for (const record of protectedRecords) {
      if (retained.size >= PROJECTION_RECORD_CAP) break
      retained.add(record.record_id)
    }
    const newest = [...records].sort((left, right) => compareRecordRecency(right, left))
    for (const record of newest) {
      if (retained.size >= PROJECTION_RECORD_CAP) break
      retained.add(record.record_id)
    }
    const remove = database.prepare('DELETE FROM projection_records WHERE record_id = ?')
    for (const record of records) {
      if (!retained.has(record.record_id)) remove.run(record.record_id)
    }
  }

  #compactAliasObservations(database: GraphDatabase): void {
    const observations = this.#parseRows(
      database.prepare('SELECT payload_json FROM alias_observations').all(),
      workspaceAliasObservationSchema,
    )
    if (observations.length <= ALIAS_OBSERVATION_CAP) return
    const newest = [...observations].sort((left, right) => (
      right.observed_at - left.observed_at
      || compareCodePoints(right.observation_id, left.observation_id)
    ))
    const retained = new Set(newest.slice(0, ALIAS_OBSERVATION_CAP).map(item => item.observation_id))
    const remove = database.prepare('DELETE FROM alias_observations WHERE observation_id = ?')
    for (const observation of observations) {
      if (!retained.has(observation.observation_id)) remove.run(observation.observation_id)
    }
  }

  #compactOperationReceipts(database: GraphDatabase): void {
    const count = this.#tableCount(database, 'operation_receipts')
    const remove = Math.max(0, count - (OPERATION_RECEIPT_CAP - 1))
    if (remove === 0) return
    database.prepare(`
      DELETE FROM operation_receipts WHERE receipt_sequence IN (
        SELECT receipt_sequence FROM operation_receipts
        WHERE committed_at <= ?
        ORDER BY receipt_sequence ASC LIMIT ?
      )
    `).run(Date.now() - OPERATION_RECEIPT_MIN_AGE_MS, remove)
  }

  #derivedRowCount(database: GraphDatabase): number {
    return this.#tableCount(database, 'logical_workspaces')
      + this.#tableCount(database, 'workspace_instances')
      + this.#tableCount(database, 'relation_cards')
      + this.#tableCount(database, 'relation_evidence')
      + this.#tableCount(database, 'observations')
      + this.#tableCount(database, 'projection_records')
      + this.#tableCount(database, 'alias_observations')
  }

  #tableCount(database: GraphDatabase, table: string): number {
    return numberColumn(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), 'count')
  }

  #parseRows<Schema extends z.ZodType>(
    rows: readonly Record<string, GraphSqlOutput>[],
    schema: Schema,
  ): readonly z.infer<Schema>[] {
    return rows.map(row => schema.parse(JSON.parse(stringColumn(row, 'payload_json'))))
  }

  #parseObservationPayload(payload: string): Observation {
    return ObservationSchema.parse(JSON.parse(payload))
  }

  #parseRelationPayload(payload: string): RelationCard {
    return RelationCardSchema.parse(JSON.parse(payload))
  }

  #writeWithReceipt<Result>(
    database: GraphDatabase,
    operationId: string,
    operationType: OperationType,
    input: unknown,
    replay: (receipt: OperationReceiptResult) => Result,
    operation: () => {readonly result: Result; readonly receipt: OperationReceiptResult},
  ): Result {
    const parsedId = z.string().uuid().safeParse(operationId)
    if (!parsedId.success) throw new WorkspaceGraphStoreError('STORE_INVALID_OPERATION')
    const inputDigest = createHash('sha256').update(canonicalJson(input)).digest('hex')
    try {
      database.exec('BEGIN IMMEDIATE')
      const existing = this.#operationReceipt(database, parsedId.data)
      if (existing !== undefined) {
        if (existing.receipt.operation_type !== operationType || existing.inputDigest !== inputDigest) {
          throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
        }
        const result = replay(existing.receipt.result)
        database.exec('COMMIT')
        return result
      }
      const completed = operation()
      const receipt = OperationReceiptSchema.parse({
        operation_id: parsedId.data,
        operation_type: operationType,
        result: completed.receipt,
      })
      database.prepare(`
        INSERT INTO operation_receipts(
          operation_id, operation_type, input_digest, committed_at, result_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        receipt.operation_id,
        receipt.operation_type,
        inputDigest,
        Date.now(),
        canonicalJson(receipt.result),
      )
      database.exec('COMMIT')
      return completed.result
    } catch (error) {
      rollback(database)
      if (error instanceof WorkspaceGraphStoreError) throw error
      throw new WorkspaceGraphStoreError('STORE_WRITE_FAILED')
    }
  }

  #operationReceipt(
    database: GraphDatabase,
    operationId: string,
  ): {readonly receipt: OperationReceipt; readonly inputDigest: string} | undefined {
    const row = database.prepare(`
      SELECT operation_type, input_digest, result_json
      FROM operation_receipts WHERE operation_id = ?
    `).get(operationId)
    if (row === undefined) return undefined
    const result: unknown = JSON.parse(stringColumn(row, 'result_json')) as unknown
    const receiptInput = {
      operation_id: operationId,
      operation_type: stringColumn(row, 'operation_type'),
      result,
    }
    const currentReceipt = OperationReceiptSchema.safeParse(receiptInput)
    const receipt = currentReceipt.success
      ? currentReceipt.data
      : this.#hydrateLegacyRelationReceipt(
        database,
        legacyRelationOperationReceiptSchema.parse(receiptInput),
      )
    return {receipt, inputDigest: stringColumn(row, 'input_digest')}
  }

  #hydrateLegacyRelationReceipt(
    database: GraphDatabase,
    legacy: z.infer<typeof legacyRelationOperationReceiptSchema>,
  ): OperationReceipt {
    const result = legacy.result
    const row = database.prepare(`
      SELECT payload_json FROM relation_cards
      WHERE source_logical_id = ? AND target_logical_id = ? AND relation_type = ?
    `).get(result.source_logical_id, result.target_logical_id, result.relation_type)
    if (row === undefined) throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
    const relation = this.#parseRelationPayload(stringColumn(row, 'payload_json'))
    if (relation.revision !== result.revision || relation.status !== result.status) {
      throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
    }
    return OperationReceiptSchema.parse({
      operation_id: legacy.operation_id,
      operation_type: legacy.operation_type,
      result: {kind: 'relation', relation},
    })
  }

  #relationFromReceipt(receipt: OperationReceiptResult): RelationCard {
    if (receipt.kind !== 'relation') throw new WorkspaceGraphStoreError('STORE_OPERATION_CONFLICT')
    return receipt.relation
  }

  #latestReceiptSequence(database: GraphDatabase): number {
    const row = database.prepare('SELECT MAX(receipt_sequence) AS sequence FROM operation_receipts').get()
    if (row === undefined || row.sequence === null) return 0
    return numberColumn(row, 'sequence')
  }

  #read<Value>(operation: () => Value): Value {
    try {
      return operation()
    } catch (error) {
      if (error instanceof WorkspaceGraphStoreError) throw error
      throw new WorkspaceGraphStoreError('STORE_READ_FAILED')
    }
  }

  #requireDatabase(): GraphDatabase {
    if (this.#database === undefined) throw new WorkspaceGraphStoreError('STORE_CLOSED')
    return this.#database
  }
}

function rollback(database: GraphDatabase): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the safe primary store error.
  }
}

function projectionRelationKey(value: Pick<
  RelationCard,
  'source_logical_id' | 'target_logical_id' | 'relation_type'
>): string {
  return `${value.source_logical_id}\u0000${value.target_logical_id}\u0000${value.relation_type}`
}

function projectionRetentionCategory(
  record: ProjectionRecord,
): 'suppression' | 'user_confirmed' | 'trusted_system' | null {
  if (record.stance === 'suppress') return 'suppression'
  if (record.authority === 'user_confirmed') return 'user_confirmed'
  if (record.authority === 'trusted_system') return 'trusted_system'
  return null
}

function projectionRetentionPriority(record: ProjectionRecord): number {
  switch (projectionRetentionCategory(record)) {
    case 'suppression': return 0
    case 'user_confirmed': return 1
    case 'trusted_system': return 2
    case null: return 3
  }
}

function compareRecordRecency(left: ProjectionRecord, right: ProjectionRecord): number {
  return left.occurred_at - right.occurred_at
    || compareCodePoints(left.record_id, right.record_id)
}

function isLogicalWorkspaceInput(input: WorkspaceCard): input is LogicalWorkspace {
  return 'logical_workspace_id' in input && 'aliases' in input
}

function stringColumn(
  row: Record<string, GraphSqlOutput> | undefined,
  key: string,
): string {
  const value = row?.[key]
  if (typeof value !== 'string') throw new WorkspaceGraphStoreError('STORE_READ_FAILED')
  return value
}

function numberColumn(
  row: Record<string, GraphSqlOutput> | undefined,
  key: string,
): number {
  const value = row?.[key]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new WorkspaceGraphStoreError('STORE_READ_FAILED')
}

function compareAliases(left: PublishedGraphAlias, right: PublishedGraphAlias): number {
  const alias = compareCodePoints(left.alias, right.alias)
  return alias === 0
    ? compareCodePoints(left.logical_workspace_id, right.logical_workspace_id)
    : alias
}

function relationReceipt(relation: RelationCard): OperationReceiptResult {
  return {kind: 'relation', relation}
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function isRevisionConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === 'IDENTITY_REVISION_CONFLICT' || error.code === 'PROJECTOR_REVISION_CONFLICT'
}
