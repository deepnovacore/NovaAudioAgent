import {completePurgeIndex,purgeEntry,purgeStatus,recoverMemoryPurges} from '../memory-substrate/purge.js'
import {enableMemoryFiles,flushMemoryFiles,hasMemoryFileAuthority,memoryFilesEnabled} from '../memory-substrate/file-authority.js'
import {MarkdownRepository} from '../memory-substrate/markdown-repository.js'
import {reconcileMemoryFiles} from '../memory-substrate/store.js'
import {recordWorkspaceRevision} from '../memory-substrate/workspace.js'
import {migrateLegacyMemory} from '../memory-substrate/migration.js'
import {initializeMemory, memoryOperation, type MemoryOperation} from '../memory-substrate/store.js'
import {initializeSourceState,assertSourceStateSchema} from '../memory-substrate/source-state.js'

import { z } from 'zod'

import { canonicalJson } from '../text/canonical-json.js'
import {
  EvidenceRefSchema,
  LogicalWorkspaceSchema,
  RelationCardSchema,
  WorkspaceInstanceSchema,
  relationTypeSchema,
  type EvidenceRef,
  type LogicalWorkspace,
  type RelationCard,
  type WorkspaceInstance,
} from './models.js'

export const MEMORY_LEDGER_SCHEMA_VERSION = 4
const MEMORY_LOCK_WAIT_MS = 10_000

type LedgerSqlInput = null | number | bigint | string | NodeJS.ArrayBufferView
type LedgerSqlOutput = null | number | bigint | string | NodeJS.NonSharedUint8Array

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

export interface LedgerStatement {
  all(...parameters: LedgerSqlInput[]): Record<string, LedgerSqlOutput>[]
  get(...parameters: LedgerSqlInput[]): Record<string, LedgerSqlOutput> | undefined
  run(...parameters: LedgerSqlInput[]): {readonly changes: number | bigint}
}

export interface LedgerDatabase {
  exec(sql: string): void
  prepare(sql: string): LedgerStatement
  close(): void
}

export type LedgerDatabaseFactory = (path: string) => LedgerDatabase
export type WorkspaceCard = LogicalWorkspace | WorkspaceInstance

export interface MemoryLedgerStoreOptions {
  readonly memoryLockWaitMs?: number
}

export type MemoryLedgerStoreErrorCode =
  | 'STORE_ALREADY_OPEN'
  | 'STORE_CLOSED'
  | 'STORE_IDEMPOTENCY_CONFLICT'
  | 'STORE_INVALID_CARD'
  | 'STORE_INVALID_OBSERVATION'
  | 'STORE_INVALID_RELATION'
  | 'STORE_MIGRATION_FAILED'
  | 'STORE_NOT_FOUND'
  | 'STORE_INVALID_OPERATION'
  | 'STORE_PURGED_ID'
  | 'STORE_STATED_EVIDENCE_REQUIRED'
  | 'STORE_OPERATION_CONFLICT'
  | 'STORE_READ_FAILED'
  | 'STORE_SCHEMA_UNSUPPORTED'
  | 'STORE_SENSITIVE_CONTENT_REJECTED'
  | 'STORE_SENSITIVE_PATH_DENIED'
  | 'STORE_STALE_REVISION'
  | 'STORE_MEMORY_CONFLICT'
  | 'STORE_WRITE_FAILED'

const storeErrorMessages: Readonly<Record<MemoryLedgerStoreErrorCode, string>> = {
  STORE_ALREADY_OPEN: 'memory ledger store is already open',
  STORE_CLOSED: 'memory ledger store is closed',
  STORE_IDEMPOTENCY_CONFLICT: 'memory ledger observation replay conflict',
  STORE_INVALID_CARD: 'invalid memory ledger card',
  STORE_INVALID_OBSERVATION: 'invalid memory ledger observation',
  STORE_INVALID_RELATION: 'invalid memory ledger relation',
  STORE_MIGRATION_FAILED: 'memory ledger schema migration failed',
  STORE_NOT_FOUND: 'memory ledger record was not found',
  STORE_INVALID_OPERATION: 'memory ledger operation is invalid',
  STORE_PURGED_ID: 'memory identifier was permanently purged',
  STORE_STATED_EVIDENCE_REQUIRED: 'stated memory requires trusted user evidence',
  STORE_OPERATION_CONFLICT: 'memory ledger operation replay conflict',
  STORE_READ_FAILED: 'memory ledger read failed',
  STORE_SCHEMA_UNSUPPORTED: 'memory ledger schema version is unsupported',
  STORE_SENSITIVE_CONTENT_REJECTED: 'memory ledger sensitive content was rejected',
  STORE_SENSITIVE_PATH_DENIED: 'memory ledger sensitive path was denied',
  STORE_STALE_REVISION: 'memory ledger revision is stale',
  STORE_MEMORY_CONFLICT: 'memory documents conflict; user edits were preserved',
  STORE_WRITE_FAILED: 'memory ledger write failed',
}

export class MemoryLedgerStoreError extends Error {
  readonly code: MemoryLedgerStoreErrorCode

  constructor(code: MemoryLedgerStoreErrorCode) {
    super(storeErrorMessages[code])
    this.name = 'MemoryLedgerStoreError'
    this.code = code
  }
}

export class MemoryLedgerStore {
  readonly #path: string
  readonly #databaseFactory: LedgerDatabaseFactory
  #database: LedgerDatabase | undefined
  #memoryLockHeld = false
  readonly #fileRepository: MarkdownRepository

  constructor(
    path: string,
    databaseFactory: LedgerDatabaseFactory,
    options: MemoryLedgerStoreOptions = {},
  ) {
    this.#path = path
    this.#fileRepository = new MarkdownRepository(path+'.memory',{lockWaitMs:options.memoryLockWaitMs??MEMORY_LOCK_WAIT_MS})
    this.#databaseFactory = databaseFactory
  }

  open(): void {this.withMemoryFilesLock(()=>this.#openLocked())}

  #openLocked(): void {
    if (this.#database !== undefined) throw new MemoryLedgerStoreError('STORE_ALREADY_OPEN')
    let database: LedgerDatabase | undefined
    try {
      database = this.#databaseFactory(this.#path)
      database.exec('PRAGMA busy_timeout=1000')
      database.exec('PRAGMA foreign_keys=ON')
      this.#migrate(database)
      initializeMemory(database)
      recoverMemoryPurges(database,this.#path)
      const authoritative=hasMemoryFileAuthority(database,this.#path+'.memory')
      if(authoritative){enableMemoryFiles(database,this.#path+'.memory',{alreadyLocked:true});reconcileMemoryFiles(database)}
      else {
      database.exec('BEGIN IMMEDIATE')
      try {
        for (const [table, kind] of [['logical_workspaces','LogicalWorkspace'],['workspace_instances','WorkspaceInstance'],['relation_cards','RelationCard']] as const) {
          for (const row of database.prepare(`SELECT payload_json FROM ${table}`).all()) {
            recordWorkspaceRevision(database, kind, JSON.parse(String(row.payload_json)) as WorkspaceCard | RelationCard)
          }
        }
        database.exec('COMMIT')
      } catch (error) { database.exec('ROLLBACK'); throw error }
      }
      // A fresh database must finish its serialized schema transaction before
      // concurrent clients negotiate WAL. On Windows, racing journal_mode with
      // another connection's first migration fails immediately despite the busy
      // timeout, while BEGIN IMMEDIATE itself waits correctly.
      database.exec('PRAGMA journal_mode=WAL')
      this.#database = database
    } catch (error) {
      try {
        database?.close()
      } catch {
        // The stable migration error below is the only failure exposed across RPC.
      }
      if (error instanceof MemoryLedgerStoreError) throw error
      if(error instanceof Error&&error.message.startsWith('MEMORY_MARKDOWN_'))throw new MemoryLedgerStoreError('STORE_MEMORY_CONFLICT')
      throw new MemoryLedgerStoreError('STORE_MIGRATION_FAILED')
    }
  }

  memory(operation: MemoryOperation, input: unknown, openLegacy?: LedgerDatabaseFactory): unknown {
    return this.withMemoryFilesLock(()=>{
      if(operation==='enable_files'){
        enableMemoryFiles(this.#requireDatabase(),this.#path+'.memory',{alreadyLocked:true})
        reconcileMemoryFiles(this.#requireDatabase());return {enabled:true}
      }
      try {
      if(operation==='purge')return purgeEntry(this.#requireDatabase(),this.#path,input)
      if(operation==='purge_index_complete')return completePurgeIndex(this.#requireDatabase(),this.#path,input)
      if(operation==='purge_status')return purgeStatus(this.#requireDatabase(),z.object({entry_prefix:z.string().min(1)}).strict().parse(input).entry_prefix)
      this.#joinMemoryFileAuthority()
      return operation === 'migrate_legacy' ? migrateLegacyMemory(this.#requireDatabase(), input, openLegacy ?? (() => {throw new Error('STORE_INVALID_OPERATION')})) : memoryOperation(this.#requireDatabase(), operation, input) }
      catch (error) {
        const message = error instanceof Error ? error.message : ''
        const code=({version_conflict:'STORE_STALE_REVISION',request_id_conflict:'STORE_IDEMPOTENCY_CONFLICT',item_not_found:'STORE_NOT_FOUND'} as Record<string,string>)[message]??message
        if(message.startsWith('MEMORY_MARKDOWN_'))throw new MemoryLedgerStoreError('STORE_MEMORY_CONFLICT')
        if (['STORE_STALE_REVISION','STORE_NOT_FOUND','STORE_INVALID_OPERATION','STORE_PURGED_ID','STORE_STATED_EVIDENCE_REQUIRED','STORE_IDEMPOTENCY_CONFLICT'].includes(code)) throw new MemoryLedgerStoreError(code as MemoryLedgerStoreErrorCode)
        throw new MemoryLedgerStoreError('STORE_WRITE_FAILED')
      }
    })
  }

  /** Process and worker independent path lock; only this store's synchronous nested calls may reuse it. */
  withMemoryFilesLock<T>(fn:()=>T):T {
    if(this.#memoryLockHeld||this.#path===':memory:')return fn()
    return this.#fileRepository.withLock(()=>{this.#memoryLockHeld=true;try{return fn()}finally{this.#memoryLockHeld=false}})
  }
  #joinMemoryFileAuthority():void {
    const db=this.#database
    if(db)recoverMemoryPurges(db,this.#path)
    if(db&&!memoryFilesEnabled(db)&&hasMemoryFileAuthority(db,this.#path+'.memory'))enableMemoryFiles(db,this.#path+'.memory',{alreadyLocked:true})
  }
  syncMemoryFiles():void {if(this.#database){this.#joinMemoryFileAuthority();reconcileMemoryFiles(this.#database)}}
  flushMemoryFiles():void {if(this.#database)flushMemoryFiles(this.#database)}

  close(): void {
    if (this.#database === undefined) return
    const database = this.#database
    this.#database = undefined
    try {
      database.close()
    } catch {
      throw new MemoryLedgerStoreError('STORE_WRITE_FAILED')
    }
  }

  listLogicalWorkspaces(): readonly LogicalWorkspace[] {
    const database = this.#requireDatabase()
    return this.#read(() => this.#parseRows(
      database.prepare('SELECT payload_json FROM logical_workspaces ORDER BY logical_workspace_id').all(),
      LogicalWorkspaceSchema,
    ))
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

  listRelationEvidence(
    sourceId: string,
    targetId: string,
    relationType: RelationCard['relation_type'],
  ): readonly EvidenceRef[] {
    const parsedType = relationTypeSchema.safeParse(relationType)
    if (!parsedType.success) throw new MemoryLedgerStoreError('STORE_INVALID_RELATION')
    const database = this.#requireDatabase()
    return this.#read(() => database.prepare(`
      SELECT evidence_json FROM relation_evidence
      WHERE source_logical_id = ? AND target_logical_id = ? AND relation_type = ?
      ORDER BY observed_at, evidence_source, evidence_ref
    `).all(sourceId, targetId, parsedType.data).map(row => (
      EvidenceRefSchema.parse(JSON.parse(stringColumn(row, 'evidence_json')))
    )))
  }

  #migrate(database: LedgerDatabase): void {
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
      if (version > MEMORY_LEDGER_SCHEMA_VERSION) {
        throw new MemoryLedgerStoreError('STORE_SCHEMA_UNSUPPORTED')
      }
      if (version === 0) {
        if (Object.keys(V3_TABLE_SHAPES).some(table => this.#tableExists(database, table))) {
          throw new Error('unversioned memory ledger tables')
        }
        this.#createV1Schema(database)
        this.#createV2Schema(database)
        this.#createV3Schema(database)
        this.#recordMigration(database, 3)
        version = 3
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
      if (version === 3) {
        initializeSourceState(database)
        this.#recordMigration(database, 4)
        version = 4
      }
      if (version !== MEMORY_LEDGER_SCHEMA_VERSION) throw new Error('schema version gap')
      assertSourceStateSchema(database)
      this.#assertSchemaShape(database, V3_TABLE_SHAPES)
      this.#createIndexes(database)
      database.exec('COMMIT')
    } catch (error) {
      rollback(database)
      if (error instanceof MemoryLedgerStoreError) throw error
      throw new MemoryLedgerStoreError('STORE_MIGRATION_FAILED')
    }
  }

  #createV1Schema(database: LedgerDatabase): void {
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

  #createV2Schema(database: LedgerDatabase): void {
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

  #createV3Schema(database: LedgerDatabase): void {
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

  #createIndexes(database: LedgerDatabase): void {
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

  #recordMigration(database: LedgerDatabase, version: number): void {
    database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(version, Date.now())
  }

  #assertSchemaShape(
    database: LedgerDatabase,
    shapes: Readonly<Record<string, readonly SchemaColumn[]>>,
  ): void {
    for (const [table, columns] of Object.entries(shapes)) {
      this.#assertTableShape(database, table, columns)
    }
  }

  #assertTableShape(
    database: LedgerDatabase,
    table: string,
    expected: readonly SchemaColumn[],
  ): void {
    const rawColumns = database.prepare(`PRAGMA table_xinfo("${table}")`).all()
    if (rawColumns.some(row => numberColumn(row, 'hidden') !== 0)) {
      throw new Error(`invalid memory ledger hidden column: ${table}`)
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
    ) throw new Error(`invalid memory ledger table shape: ${table}`)
    this.#assertTableConstraints(database, table)
  }

  #assertTableConstraints(database: LedgerDatabase, table: string): void {
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
      throw new Error(`invalid memory ledger unique constraints: ${table}`)
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
      throw new Error(`invalid memory ledger foreign keys: ${table}`)
    }

    const createRow = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table)
    const hasAutoincrement = createRow !== undefined
      && /\bAUTOINCREMENT\b/iu.test(stringColumn(createRow, 'sql'))
    if (hasAutoincrement !== (table === 'operation_receipts')) {
      throw new Error(`invalid memory ledger autoincrement: ${table}`)
    }
  }

  #tableExists(database: LedgerDatabase, table: string): boolean {
    return database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) !== undefined
  }

  #schemaVersion(database: LedgerDatabase): number {
    const row = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()
    if (row === undefined || row.version === null) return 0
    return numberColumn(row, 'version')
  }

  #parseRows<Schema extends z.ZodType>(
    rows: readonly Record<string, LedgerSqlOutput>[],
    schema: Schema,
  ): readonly z.infer<Schema>[] {
    return rows.map(row => schema.parse(JSON.parse(stringColumn(row, 'payload_json'))))
  }

  #read<Value>(operation: () => Value): Value {
    try {
      return operation()
    } catch (error) {
      if (error instanceof MemoryLedgerStoreError) throw error
      throw new MemoryLedgerStoreError('STORE_READ_FAILED')
    }
  }

  #requireDatabase(): LedgerDatabase {
    if (this.#database === undefined) throw new MemoryLedgerStoreError('STORE_CLOSED')
    return this.#database
  }
}

function rollback(database: LedgerDatabase): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the safe primary store error.
  }
}

function stringColumn(
  row: Record<string, LedgerSqlOutput> | undefined,
  key: string,
): string {
  const value = row?.[key]
  if (typeof value !== 'string') throw new MemoryLedgerStoreError('STORE_READ_FAILED')
  return value
}

function numberColumn(
  row: Record<string, LedgerSqlOutput> | undefined,
  key: string,
): number {
  const value = row?.[key]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new MemoryLedgerStoreError('STORE_READ_FAILED')
}
