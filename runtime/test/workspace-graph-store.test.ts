import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, {type TestContext} from 'node:test'
import { Worker, type WorkerOptions } from 'node:worker_threads'

import type {
  EvidenceRef,
  LogicalWorkspace,
  Observation,
  RelationCard,
  WorkspaceInstance,
} from '../src/workspace-graph/models.js'
import {
  WorkspaceGraphStoreClient,
  WorkspaceGraphStoreClientError,
  type WorkspaceGraphWorker,
} from '../src/workspace-graph/store-client.js'

const fixtureWorkerUrl = new URL('./fixtures/workspace-graph-sqlite-worker.js', import.meta.url)

function workspaceOpened(
  observationId: string,
  summary = '/safe/a',
): Observation {
  return {
    observation_id: observationId,
    observation_type: 'workspace_opened',
    occurred_at: 1,
    source: 'runtime',
    trust: 'trusted_system',
    logical_workspace_id: 'lw-a',
    workspace_instance_id: 'wi-a',
    related_logical_workspace_id: null,
    summary,
    outcome: 'ok',
    evidence_refs: [],
  }
}

function logicalWorkspace(
  id: string,
  revision = 0,
  displayName = id,
): LogicalWorkspace {
  return {
    logical_workspace_id: id,
    display_name: displayName,
    aliases: [`${id}-alias`],
    canonical_remote: null,
    created_at: 1,
    updated_at: revision + 1,
    revision,
  }
}

function workspaceInstance(id: string, revision = 0): WorkspaceInstance {
  return {
    instance_id: id,
    logical_workspace_id: 'lw-a',
    display_name: id,
    path_label: id,
    branch: null,
    repository_fingerprint: null,
    status: 'inactive',
    first_seen_at: 1,
    last_seen_at: revision + 1,
    revision,
  }
}

function runtimeEvidence(ref = 'observation-a', observedAt = 1): EvidenceRef {
  return {source: 'runtime', ref, observed_at: observedAt}
}

function userEvidence(ref = 'user-suppression', observedAt = 2): EvidenceRef {
  return {source: 'user', ref, observed_at: observedAt}
}

function relation(
  revision = 0,
  status: RelationCard['status'] = 'active',
  evidenceRefs: readonly EvidenceRef[] = [runtimeEvidence()],
): RelationCard {
  return {
    source_logical_id: 'lw-a',
    target_logical_id: 'lw-b',
    relation_type: 'depends_on',
    confidence: 0.8,
    reason: 'shared runtime',
    evidence_refs: [...evidenceRefs],
    first_seen_at: 1,
    last_seen_at: revision + 1,
    status,
    revision,
  }
}

async function createStore(
  t: TestContext,
  options: ConstructorParameters<typeof WorkspaceGraphStoreClient>[1] = {},
): Promise<{readonly client: WorkspaceGraphStoreClient; readonly path: string}> {
  const directory = await mkdtemp(join(tmpdir(), 'nova-workspace-graph-'))
  const path = join(directory, 'graph.sqlite')
  const client = new WorkspaceGraphStoreClient(path, options)
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  await client.open()
  return {client, path}
}

async function closeStore(client: WorkspaceGraphStoreClient): Promise<void> {
  await client.close()
}

function workerRequest(
  data: Record<string, unknown>,
): Promise<{readonly worker: Worker; readonly message: unknown}> {
  const worker = new Worker(fixtureWorkerUrl, {workerData: data})
  return new Promise((resolve, reject) => {
    worker.once('error', reject)
    worker.once('message', message => resolve({worker, message}))
  })
}

async function execSqlite(path: string, sql: string): Promise<void> {
  const {worker, message} = await workerRequest({mode: 'exec', path, sql})
  assert.deepEqual(message, {kind: 'done'})
  await worker.terminate()
}

async function querySqlite(path: string, sql: string): Promise<readonly Record<string, unknown>[]> {
  const {worker, message} = await workerRequest({mode: 'query', path, sql})
  assert.ok(typeof message === 'object' && message !== null && 'rows' in message)
  const rows = (message as {readonly rows: readonly Record<string, unknown>[]}).rows
  await worker.terminate()
  return rows
}

async function holdWriteLock(path: string): Promise<{readonly release: () => Promise<void>}> {
  const {worker, message} = await workerRequest({mode: 'lock', path})
  assert.deepEqual(message, {kind: 'locked'})
  return {
    release: () => new Promise((resolve, reject) => {
      worker.once('error', reject)
      worker.once('message', released => {
        assert.deepEqual(released, {kind: 'released'})
        void worker.terminate().then(() => resolve(), reject)
      })
      worker.postMessage('release')
    }),
  }
}

async function fileContains(path: string, needle: string): Promise<boolean> {
  try {
    const bytes = await readFile(path)
    return bytes.includes(Buffer.from(needle))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

test('observation append is immutable and suppression preserves evidence history', async t => {
  const {client} = await createStore(t)
  const observation = workspaceOpened('observation-a')
  const evidence = await client.appendObservation(observation)
  await client.upsertRelation(relation(0, 'active', [evidence]))
  await client.suppressRelation('lw-a', 'lw-b', 'depends_on', userEvidence())

  assert.deepEqual(await client.listObservations(), [observation])
  assert.equal((await client.getRelation('lw-a', 'lw-b', 'depends_on'))?.status, 'suppressed')
  assert.deepEqual(
    (await client.listRelationEvidence('lw-a', 'lw-b', 'depends_on')).map(item => item.ref),
    ['observation-a', 'user-suppression'],
  )
})

test('reopen and replay retain one canonical observation and the configured schema', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-workspace-graph-reopen-'))
  const path = join(directory, 'graph.sqlite')
  t.after(() => rm(directory, {recursive: true, force: true}))

  const first = new WorkspaceGraphStoreClient(path)
  await first.open()
  const evidence = await first.appendObservation(workspaceOpened('replayed'))
  await first.close()

  const reopened = new WorkspaceGraphStoreClient(path)
  t.after(() => reopened.close())
  await reopened.open()
  assert.deepEqual(await reopened.appendObservation(workspaceOpened('replayed')), evidence)
  assert.equal((await reopened.listObservations()).length, 1)
  assert.deepEqual(await reopened.diagnostics(), {
    schema_version: 1,
    journal_mode: 'wal',
    foreign_keys: true,
    observations: 1,
    logical_workspaces: 0,
    workspace_instances: 0,
    relation_cards: 0,
    relation_evidence: 0,
  })
})

test('malformed and stale relation writes roll back without replacing the last snapshot', async t => {
  const {client} = await createStore(t)
  await client.upsertRelation(relation())
  const lastGood = client.publishedSnapshot
  const malformed = {...relation(1), confidence: 2} as RelationCard

  await assert.rejects(
    client.upsertRelation(malformed, 0),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'STORE_INVALID_RELATION',
  )
  assert.equal(client.publishedSnapshot, lastGood)
  assert.equal((await client.listRelationEvidence('lw-a', 'lw-b', 'depends_on')).length, 1)

  await assert.rejects(
    client.upsertRelation(relation(1), 9),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'STORE_STALE_REVISION',
  )
  assert.equal((await client.getRelation('lw-a', 'lw-b', 'depends_on'))?.revision, 0)

  await client.upsertRelation(relation(1), 0)
  await client.upsertRelation(relation(2, 'stale'), 1)
  assert.equal((await client.getRelation('lw-a', 'lw-b', 'depends_on'))?.status, 'stale')
  assert.equal(client.publishedSnapshot.relations.length, 0)
})

test('denied paths never reach SQLite and free-text secrets persist only as redactions', async t => {
  const {client, path} = await createStore(t, {deniedRoots: ['/private']})
  const deniedName = 'hidden-workspace-marker'
  await assert.rejects(
    client.appendObservation(workspaceOpened('denied', `/private/${deniedName}`)),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'STORE_SENSITIVE_PATH_DENIED'
      && !error.message.includes(deniedName),
  )
  const artifactName = 'artifact-path-marker'
  await assert.rejects(
    client.appendObservation({
      ...workspaceOpened('denied-artifact', `/private/${artifactName}`),
      observation_type: 'task_artifact_reference',
    }),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'STORE_SENSITIVE_PATH_DENIED'
      && !error.message.includes(artifactName),
  )

  const secret = 'sk_storeRegressionSecret123456789'
  await client.appendObservation(workspaceOpened('redacted', `deployed safely with ${secret}`))
  const stored = await client.listObservations()
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.summary, 'deployed safely with [redacted]')

  await closeStore(client)
  assert.equal(await fileContains(path, deniedName), false)
  assert.equal(await fileContains(path, artifactName), false)
  assert.equal(await fileContains(path, secret), false)
  assert.equal(await fileContains(`${path}-wal`, secret), false)
})

test('compaction bounds derived rows without deleting observations or locking later writes', async t => {
  const {client} = await createStore(t)
  for (let index = 0; index < 4; index += 1) {
    await client.appendObservation(workspaceOpened(`observation-${index}`))
  }
  for (let index = 0; index < 140; index += 1) {
    await client.replaceCard(workspaceInstance(`instance-${index}`, index))
  }

  const compacted = await client.compact()
  assert.ok(compacted.derived_rows_after < compacted.derived_rows_before)
  assert.equal((await client.listObservations()).length, 4)
  await client.replaceCard(workspaceInstance('instance-after-compaction', 141))
  assert.equal((await client.getWorkspaceInstance('instance-after-compaction'))?.revision, 141)
})

test('published snapshots are deeply immutable and never expose a failed partial write', async t => {
  const {client} = await createStore(t)
  await client.replaceCard(logicalWorkspace('lw-a', 0, 'first name'))
  const first = client.publishedSnapshot
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.logical_workspaces), true)
  assert.throws(() => {
    ;(first.logical_workspaces as LogicalWorkspace[]).push(logicalWorkspace('lw-extra'))
  }, TypeError)

  await client.replaceCard(logicalWorkspace('lw-a', 1, 'second name'))
  assert.equal(first.logical_workspaces[0]?.display_name, 'first name')
  assert.equal(client.publishedSnapshot.logical_workspaces[0]?.display_name, 'second name')

  const beforeFailure = client.publishedSnapshot
  const duplicateEvidence = [runtimeEvidence('same'), runtimeEvidence('same')]
  await assert.rejects(client.upsertRelation(relation(0, 'active', duplicateEvidence)))
  assert.equal(client.publishedSnapshot, beforeFailure)
  assert.equal(client.publishedSnapshot.relations.length, 0)
})

test('a locked SQLite worker does not block a scheduled main-thread timer', async t => {
  const {client, path} = await createStore(t)
  const lock = await holdWriteLock(path)
  let timerFired = false
  const timer = new Promise<'timer'>(resolve => {
    setTimeout(() => {
      timerFired = true
      resolve('timer')
    }, 25)
  })
  const append = client.appendObservation(workspaceOpened('blocked-write')).then(() => 'append' as const)

  assert.equal(await Promise.race([timer, append]), 'timer')
  assert.equal(timerFired, true)
  await lock.release()
  assert.equal(await append, 'append')
})

test('worker exit rejects pending calls safely and preserves a degraded last-good snapshot', async t => {
  let storeWorker: Worker | undefined
  const workerFactory = (url: URL, options: WorkerOptions): WorkspaceGraphWorker => {
    storeWorker = new Worker(url, options)
    return storeWorker
  }
  const {client, path} = await createStore(t, {workerFactory})
  await client.replaceCard(logicalWorkspace('lw-a'))
  const lastGood = client.publishedSnapshot
  const lock = await holdWriteLock(path)
  const pending = client.appendObservation(workspaceOpened('will-not-commit'))
  await new Promise(resolve => setTimeout(resolve, 25))
  await storeWorker!.terminate()

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'WORKER_EXITED'
      && !error.message.includes('will-not-commit'),
  )
  assert.deepEqual(client.publishedSnapshot.logical_workspaces, lastGood.logical_workspaces)
  assert.equal(client.publishedSnapshot.degraded, true)
  await lock.release()
})

test('publication failure retains committed data and marks the previous snapshot degraded', async t => {
  const {client, path} = await createStore(t)
  await client.replaceCard(logicalWorkspace('lw-a'))
  const lastGood = client.publishedSnapshot
  await execSqlite(path, "UPDATE logical_workspaces SET payload_json = '{}'")

  const evidence = await client.appendObservation(workspaceOpened('committed-before-publication-failure'))

  assert.equal(evidence.ref, 'committed-before-publication-failure')
  assert.equal((await client.listObservations()).length, 1)
  assert.deepEqual(client.publishedSnapshot.logical_workspaces, lastGood.logical_workspaces)
  assert.equal(client.publishedSnapshot.degraded, true)
})

test('invalid worker messages reject pending calls without exposing protocol payloads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-workspace-graph-invalid-worker-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const workerFactory = (): WorkspaceGraphWorker => new Worker(fixtureWorkerUrl, {
    workerData: {mode: 'malformed'},
  })
  const client = new WorkspaceGraphStoreClient(join(directory, 'graph.sqlite'), {workerFactory})
  t.after(() => client.close())

  await assert.rejects(
    client.open(),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'WORKER_PROTOCOL_FAILURE'
      && error.message === 'workspace graph worker protocol failure',
  )
  assert.equal(client.publishedSnapshot.degraded, true)
})

test('a mutating success response without a publication outcome fails the worker protocol', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-workspace-graph-invalid-success-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const workerFactory = (): WorkspaceGraphWorker => new Worker(fixtureWorkerUrl, {
    workerData: {mode: 'invalid_success'},
  })
  const client = new WorkspaceGraphStoreClient(join(directory, 'graph.sqlite'), {workerFactory})
  t.after(() => client.close())

  await assert.rejects(
    client.open(),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'WORKER_PROTOCOL_FAILURE',
  )
  assert.equal(client.publishedSnapshot.degraded, true)
})

test('a failed migration rolls back every schema object created in its transaction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-workspace-graph-migration-'))
  const path = join(directory, 'graph.sqlite')
  t.after(() => rm(directory, {recursive: true, force: true}))
  await execSqlite(path, `
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE observations(broken INTEGER NOT NULL);
  `)

  const client = new WorkspaceGraphStoreClient(path)
  t.after(() => client.close())
  await assert.rejects(
    client.open(),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'STORE_MIGRATION_FAILED',
  )

  const objects = await querySqlite(
    path,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  assert.deepEqual(objects.map(row => row.name), ['observations', 'schema_migrations'])
  assert.deepEqual(await querySqlite(path, 'SELECT version FROM schema_migrations'), [])
})

test('only the runtime store worker owns the node:sqlite import', async () => {
  const runtimeDirectory = new URL('../../src/workspace-graph/', import.meta.url)
  const clientSource = await readFile(new URL('store-client.ts', runtimeDirectory), 'utf8')
  const storeSource = await readFile(new URL('store.ts', runtimeDirectory), 'utf8')
  const workerSource = await readFile(new URL('store-worker.ts', runtimeDirectory), 'utf8')

  assert.equal(clientSource.includes('node:sqlite'), false)
  assert.equal(storeSource.includes('node:sqlite'), false)
  assert.equal(workerSource.includes("from 'node:sqlite'"), true)
  await access(new URL('store-worker.ts', runtimeDirectory))
})
