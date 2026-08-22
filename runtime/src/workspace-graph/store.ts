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
import { SensitiveContentPolicy, SensitivePathPolicy } from './sensitivity.js'

export const WORKSPACE_GRAPH_SCHEMA_VERSION = 2
const DERIVED_TABLE_ROW_CAP = 128
const OPERATION_RECEIPT_CAP = 4096
const OPERATION_RECEIPT_MIN_AGE_MS = 24 * 60 * 60 * 1_000

type GraphSqlInput = null | number | bigint | string | NodeJS.ArrayBufferView
type GraphSqlOutput = null | number | bigint | string | NodeJS.NonSharedUint8Array

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

const operationTypeSchema = z.enum([
  'append_observation',
  'replace_card',
  'upsert_relation',
  'suppress_relation',
  'compact',
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
      for (const evidence of relation.evidence_refs) {
        this.#writeRelationEvidence(database, relation, evidence)
      }
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
        evidence_refs: hasEvidence ? current.evidence_refs : [...current.evidence_refs, evidence],
        last_seen_at: Math.max(current.last_seen_at, evidence.observed_at),
        status: 'suppressed',
        revision: current.revision + 1,
      })
      this.#writeRelation(database, suppressed)
      this.#writeRelationEvidence(database, suppressed, evidence)
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
        CREATE TABLE IF NOT EXISTS operation_receipts(
          receipt_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          operation_id TEXT NOT NULL UNIQUE,
          operation_type TEXT NOT NULL,
          input_digest TEXT NOT NULL,
          committed_at INTEGER NOT NULL,
          result_json TEXT NOT NULL
        ) STRICT;
      `)
      const version = this.#schemaVersion(database)
      if (version > WORKSPACE_GRAPH_SCHEMA_VERSION) {
        throw new WorkspaceGraphStoreError('STORE_SCHEMA_UNSUPPORTED')
      }
      if (version < WORKSPACE_GRAPH_SCHEMA_VERSION) {
        database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(WORKSPACE_GRAPH_SCHEMA_VERSION, Date.now())
      }
      database.exec('COMMIT')
    } catch (error) {
      rollback(database)
      if (error instanceof WorkspaceGraphStoreError) throw error
      throw new WorkspaceGraphStoreError('STORE_MIGRATION_FAILED')
    }
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
    return ObservationSchema.parse({
      ...observation,
      summary: path.kind === 'rejected'
        ? null
        : path.kind === 'redacted'
          ? path.value
          : contentSafe,
    })
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
    const content = this.#contentPolicy.scrub('reason', parsed.data.reason)
    if (content.kind === 'rejected') {
      throw new WorkspaceGraphStoreError('STORE_SENSITIVE_CONTENT_REJECTED')
    }
    const contentSafe = content.kind === 'redacted' ? content.value : parsed.data.reason
    const path = this.#pathPolicy.scrubText('reason', contentSafe)
    if (content.kind === 'clean' && path.kind === 'clean') return parsed.data
    const redacted = RelationCardSchema.safeParse({
      ...parsed.data,
      reason: path.kind === 'rejected'
        ? '[redacted]'
        : path.kind === 'redacted'
          ? path.value
          : contentSafe,
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
