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

async function waitForBarrier(barrier: Int32Array, expected: number): Promise<void> {
  const deadline = Date.now() + 1_000
  while (Atomics.load(barrier, 0) !== expected) {
    if (Date.now() >= deadline) throw new Error('workspace graph test barrier timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
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

async function createProtocolFixtureClient(
  t: TestContext,
  mode:
    | 'invalid_result'
    | 'invalid_snapshot_schema'
    | 'invalid_snapshot_status'
    | 'stale_snapshot'
    | 'extra_response_field',
): Promise<WorkspaceGraphStoreClient> {
  const directory = await mkdtemp(join(tmpdir(), 'nova-workspace-graph-protocol-'))
  const workerFactory = (): WorkspaceGraphWorker => new Worker(fixtureWorkerUrl, {
    workerData: {mode},
  })
  const client = new WorkspaceGraphStoreClient(join(directory, 'graph.sqlite'), {workerFactory})
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  return client
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
    schema_version: 2,
    journal_mode: 'wal',
    foreign_keys: true,
    observations: 1,
    logical_workspaces: 0,
    workspace_instances: 0,
    relation_cards: 0,
    relation_evidence: 0,
    operation_receipts: 2,
  })
})

test('two real clients concurrently replay one observation idempotently', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-workspace-graph-concurrent-append-'))
  const path = join(directory, 'graph.sqlite')
  const first = new WorkspaceGraphStoreClient(path)
  const second = new WorkspaceGraphStoreClient(path)
  t.after(async () => {
    await Promise.all([first.close(), second.close()])
    await rm(directory, {recursive: true, force: true})
  })
  await Promise.all([first.open(), second.open()])
  const lock = await holdWriteLock(path)
  const observation = workspaceOpened('concurrent-replay')
  const firstAppend = first.appendObservation(observation)
  const secondAppend = second.appendObservation(observation)
  await new Promise(resolve => setTimeout(resolve, 25))
  await lock.release()

  const [firstEvidence, secondEvidence] = await Promise.all([firstAppend, secondAppend])

  assert.deepEqual(secondEvidence, firstEvidence)
  assert.deepEqual(await first.listObservations(), [observation])
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

test('a real post-relation-statement fault rolls back relation, evidence, and receipt rows', async t => {
  const workerFactory = (url: URL, options: WorkerOptions): WorkspaceGraphWorker => {
    const configured = options.workerData as Record<string, unknown>
    return new Worker(url, {
      ...options,
      workerData: {...configured, testHooks: {failAfterFirstRelationStatement: true}},
    })
  }
  const {client, path} = await createStore(t, {workerFactory})
  const beforeFailure = client.publishedSnapshot

  await assert.rejects(
    client.upsertRelation(relation()),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'STORE_WRITE_FAILED',
  )

  assert.equal(client.publishedSnapshot, beforeFailure)
  assert.deepEqual(await client.listRelations(), [])
  assert.deepEqual(await client.listRelationEvidence('lw-a', 'lw-b', 'depends_on'), [])
  const counts = await querySqlite(path, `
    SELECT
      (SELECT COUNT(*) FROM relation_cards) AS relation_cards,
      (SELECT COUNT(*) FROM relation_evidence) AS relation_evidence,
      (SELECT COUNT(*) FROM operation_receipts) AS operation_receipts
  `)
  assert.deepEqual(counts, [{relation_cards: 0, relation_evidence: 0, operation_receipts: 0}])
})

test('an existing relation cannot be updated without its expected revision', async t => {
  const {client} = await createStore(t)
  await client.upsertRelation(relation())

  await assert.rejects(
    client.upsertRelation(relation(1)),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'STORE_STALE_REVISION',
  )

  assert.equal((await client.getRelation('lw-a', 'lw-b', 'depends_on'))?.revision, 0)
})

test('two real clients updating one relation revision have exactly one winner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-workspace-graph-concurrent-relation-'))
  const path = join(directory, 'graph.sqlite')
  const first = new WorkspaceGraphStoreClient(path)
  const second = new WorkspaceGraphStoreClient(path)
  t.after(async () => {
    await Promise.all([first.close(), second.close()])
    await rm(directory, {recursive: true, force: true})
  })
  await Promise.all([first.open(), second.open()])
  await first.upsertRelation(relation())

  const attempts = await Promise.allSettled([
    first.upsertRelation(relation(1), 0),
    second.upsertRelation(relation(1), 0),
  ])

  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = attempts.find(result => result.status === 'rejected')
  assert.ok(rejected?.status === 'rejected')
  assert.ok(rejected.reason instanceof WorkspaceGraphStoreClientError)
  assert.equal(rejected.reason.code, 'STORE_STALE_REVISION')
  assert.equal((await first.getRelation('lw-a', 'lw-b', 'depends_on'))?.revision, 1)
})

test('every observation string is gated before canonical persistence', async t => {
  const {client, path} = await createStore(t, {deniedRoots: ['/private']})
  const deniedName = 'hidden-workspace-marker'
  await client.appendObservation(
    workspaceOpened('redacted-path', `opened /private/${deniedName}/notes.txt successfully`),
  )
  const artifactName = 'artifact-path-marker'
  await client.appendObservation({
    ...workspaceOpened('redacted-artifact', `referenced /private/${artifactName}.json during build`),
    observation_type: 'task_artifact_reference',
  })

  const identitySecret = 'sk_identitySecret123456789'
  await assert.rejects(
    client.appendObservation({
      ...workspaceOpened('secret-identity'),
      logical_workspace_id: identitySecret,
    }),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'STORE_SENSITIVE_CONTENT_REJECTED'
      && !error.message.includes(identitySecret),
  )
  const referenceSecret = 'sk_referenceSecret123456789'
  await assert.rejects(
    client.appendObservation({
      ...workspaceOpened('secret-reference'),
      evidence_refs: [{source: 'runtime', ref: referenceSecret, observed_at: 1}],
    }),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'STORE_SENSITIVE_CONTENT_REJECTED'
      && !error.message.includes(referenceSecret),
  )
  const identityPathMarker = 'identity-path-marker'
  await assert.rejects(
    client.appendObservation({
      ...workspaceOpened('path-identity'),
      workspace_instance_id: `wi-/private/${identityPathMarker}`,
    }),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'STORE_SENSITIVE_PATH_DENIED'
      && !error.message.includes(identityPathMarker),
  )

  const secret = 'sk_storeRegressionSecret123456789'
  await client.appendObservation(workspaceOpened('redacted', `deployed safely with ${secret}`))
  const stored = await client.listObservations()
  assert.equal(stored.length, 3)
  const summaryById = new Map(stored.map(observation => [observation.observation_id, observation.summary]))
  assert.equal(summaryById.get('redacted-path'), 'opened [redacted] successfully')
  assert.equal(summaryById.get('redacted-artifact'), 'referenced [redacted] during build')
  assert.equal(summaryById.get('redacted'), 'deployed safely with [redacted]')

  await closeStore(client)
  assert.equal(await fileContains(path, deniedName), false)
  assert.equal(await fileContains(path, artifactName), false)
  assert.equal(await fileContains(path, secret), false)
  assert.equal(await fileContains(path, identitySecret), false)
  assert.equal(await fileContains(path, referenceSecret), false)
  assert.equal(await fileContains(path, identityPathMarker), false)
  assert.equal(await fileContains(`${path}-wal`, secret), false)
  assert.equal(await fileContains(`${path}-wal`, identitySecret), false)
  assert.equal(await fileContains(`${path}-wal`, referenceSecret), false)
})

test('a configured denied-root span with spaces is fully removed before persistence', async t => {
  const deniedRoot = '/private/My Folder'
  const marker = 'space-root-raw-marker.txt'
  const {client, path} = await createStore(t, {deniedRoots: [deniedRoot]})

  await client.appendObservation(workspaceOpened(
    'space-bearing-denied-root',
    `opened ${deniedRoot}/Nested Space/${marker} successfully`,
  ))

  const [stored] = await client.listObservations()
  assert.ok(stored !== undefined)
  assert.equal(stored.summary?.includes(deniedRoot) ?? false, false)
  assert.equal(stored.summary?.includes(marker) ?? false, false)
  await closeStore(client)
  assert.equal(await fileContains(path, deniedRoot), false)
  assert.equal(await fileContains(path, marker), false)
  assert.equal(await fileContains(`${path}-wal`, deniedRoot), false)
  assert.equal(await fileContains(`${path}-wal`, marker), false)
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

test('compaction preserves suppression tombstones and their complete evidence history', async t => {
  const {client} = await createStore(t)
  await client.upsertRelation(relation())
  await client.suppressRelation('lw-a', 'lw-b', 'depends_on', userEvidence())
  for (let index = 0; index < 130; index += 1) {
    await client.upsertRelation({
      ...relation(0, 'stale', [runtimeEvidence(`filler-${index}`, index + 10)]),
      target_logical_id: `lw-filler-${index}`,
      first_seen_at: index + 10,
      last_seen_at: index + 10,
    })
  }

  await client.compact()

  assert.equal((await client.getRelation('lw-a', 'lw-b', 'depends_on'))?.status, 'suppressed')
  assert.deepEqual(
    (await client.listRelationEvidence('lw-a', 'lw-b', 'depends_on')).map(item => item.ref),
    ['observation-a', 'user-suppression'],
  )
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

test('a held multi-row relation transaction exposes neither partial reads nor snapshots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-workspace-graph-transaction-barrier-'))
  const path = join(directory, 'graph.sqlite')
  const barrierBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const barrier = new Int32Array(barrierBuffer)
  const writerFactory = (url: URL, options: WorkerOptions): WorkspaceGraphWorker => {
    const configured = options.workerData as Record<string, unknown>
    return new Worker(url, {
      ...options,
      workerData: {
        ...configured,
        testHooks: {holdAfterFirstRelationStatement: barrierBuffer},
      },
    })
  }
  const writer = new WorkspaceGraphStoreClient(path, {workerFactory: writerFactory})
  const reader = new WorkspaceGraphStoreClient(path)
  t.after(async () => {
    Atomics.store(barrier, 0, 2)
    Atomics.notify(barrier, 0)
    await Promise.all([writer.close(), reader.close()])
    await rm(directory, {recursive: true, force: true})
  })
  await Promise.all([writer.open(), reader.open()])
  await reader.upsertRelation(relation())
  await writer.refreshSnapshot()
  const writerBefore = writer.publishedSnapshot
  const readerBefore = reader.publishedSnapshot

  const updated = relation(1, 'active', [runtimeEvidence(), runtimeEvidence('revision-one', 2)])
  const write = writer.upsertRelation(updated, 0)
  await waitForBarrier(barrier, 1)

  await reader.refreshSnapshot()
  assert.equal(writer.publishedSnapshot, writerBefore)
  assert.notEqual(reader.publishedSnapshot, readerBefore)
  assert.equal(reader.publishedSnapshot.relations[0]?.revision, 0)
  assert.equal(reader.publishedSnapshot.relations[0]?.evidence_refs.length, 1)
  assert.equal((await reader.listRelations())[0]?.revision, 0)
  assert.equal((await reader.listRelationEvidence('lw-a', 'lw-b', 'depends_on')).length, 1)

  Atomics.store(barrier, 0, 2)
  Atomics.notify(barrier, 0)
  await write
  await reader.refreshSnapshot()
  assert.equal(writer.publishedSnapshot.relations[0]?.revision, 1)
  assert.equal(reader.publishedSnapshot.relations[0]?.revision, 1)
  assert.equal(reader.publishedSnapshot.relations[0]?.evidence_refs.length, 2)
  assert.equal((await reader.listRelationEvidence('lw-a', 'lw-b', 'depends_on')).length, 2)
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

test('commit-then-exit reconciles a durable receipt without double-applying on restart', async t => {
  let workerGenerations = 0
  const operationId = '11111111-1111-4111-8111-111111111111'
  const workerFactory = (url: URL, options: WorkerOptions): WorkspaceGraphWorker => {
    const generation = workerGenerations
    workerGenerations += 1
    const configured = options.workerData as Record<string, unknown>
    return new Worker(url, {
      ...options,
      workerData: {
        ...configured,
        ...(generation === 0
          ? {testHooks: {exitAfterCommitBeforeResponse: 'append_observation'}}
          : {}),
      },
    })
  }
  const {client, path} = await createStore(t, {workerFactory})
  const appendWithOperation = client.appendObservation.bind(client) as unknown as (
    observation: Observation,
    stableOperationId: string,
  ) => Promise<EvidenceRef>
  const observation = workspaceOpened('commit-exit-observation')

  const evidence = await appendWithOperation(observation, operationId)

  assert.equal(workerGenerations, 2)
  assert.equal(evidence.ref, 'commit-exit-observation')
  assert.deepEqual(await appendWithOperation(observation, operationId), evidence)
  assert.deepEqual(await client.listObservations(), [observation])
  await client.close()

  const restarted = new WorkspaceGraphStoreClient(path)
  t.after(() => restarted.close())
  await restarted.open()
  const getReceipt = restarted as unknown as {
    getOperationReceipt(id: string): Promise<{
      readonly operation_id: string
      readonly operation_type: string
      readonly result: unknown
    } | undefined>
  }
  const receipt = await getReceipt.getOperationReceipt(operationId)
  assert.deepEqual(receipt, {
    operation_id: operationId,
    operation_type: 'append_observation',
    result: {
      kind: 'observation',
      evidence: {source: 'runtime', ref: 'commit-exit-observation', observed_at: 1},
    },
  })
})

test('relation receipt replay returns its exact committed result after derived state advances', async t => {
  const {client} = await createStore(t)
  const originalOperationId = '22222222-2222-4222-8222-222222222222'
  const advancingOperationId = '33333333-3333-4333-8333-333333333333'
  const original = relation()

  assert.deepEqual(
    await client.upsertRelation(original, undefined, originalOperationId),
    original,
  )
  await client.upsertRelation(relation(1), 0, advancingOperationId)

  assert.deepEqual(
    await client.upsertRelation(original, undefined, originalOperationId),
    original,
  )
  assert.equal((await client.getRelation('lw-a', 'lw-b', 'depends_on'))?.revision, 1)
  assert.deepEqual(await client.getOperationReceipt(originalOperationId), {
    operation_id: originalOperationId,
    operation_type: 'upsert_relation',
    result: {kind: 'relation', relation: original},
  })
})

test('receipt compaction prunes only count-overflow receipts older than the safe age window', async t => {
  const {client, path} = await createStore(t)
  const dayInMilliseconds = 24 * 60 * 60 * 1_000
  const recent = Date.now() - dayInMilliseconds + 60_000
  await execSqlite(path, `
    WITH RECURSIVE receipt(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM receipt WHERE value < 4097
    )
    INSERT INTO operation_receipts(
      operation_id, operation_type, input_digest, committed_at, result_json
    )
    SELECT
      printf('%08x-0000-4000-8000-%012x', value, value),
      'replace_card',
      '${'0'.repeat(64)}',
      ${recent},
      '{"kind":"none"}'
    FROM receipt
  `)

  await client.compact('44444444-4444-4444-8444-444444444444')

  assert.deepEqual(
    await querySqlite(path, 'SELECT COUNT(*) AS count FROM operation_receipts'),
    [{count: 4098}],
  )
  assert.equal((await querySqlite(
    path,
    "SELECT COUNT(*) AS count FROM operation_receipts WHERE operation_id = '00000001-0000-4000-8000-000000000001'",
  ))[0]?.count, 1)

  const old = Date.now() - dayInMilliseconds - 60_000
  await execSqlite(path, `
    UPDATE operation_receipts SET committed_at = ${old}
    WHERE receipt_sequence IN (1, 2, 3)
  `)
  await client.compact('55555555-5555-4555-8555-555555555555')

  assert.deepEqual(
    await querySqlite(path, 'SELECT COUNT(*) AS count FROM operation_receipts'),
    [{count: 4096}],
  )
  assert.deepEqual(
    await querySqlite(path, 'SELECT receipt_sequence FROM operation_receipts WHERE receipt_sequence <= 4'),
    [{receipt_sequence: 4}],
  )
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

test('operation-specific RPC result validation rejects an invalid open result without swapping', async t => {
  const client = await createProtocolFixtureClient(t, 'invalid_result')
  const initial = client.publishedSnapshot

  await assert.rejects(
    client.open(),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'WORKER_PROTOCOL_FAILURE',
  )
  assert.deepEqual(client.publishedSnapshot.logical_workspaces, initial.logical_workspaces)
  assert.equal(client.publishedSnapshot.degraded, true)
})

test('strict RPC response validation rejects unexpected response fields without swapping', async t => {
  const client = await createProtocolFixtureClient(t, 'extra_response_field')
  const before = client.publishedSnapshot

  await assert.rejects(
    client.open(),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'WORKER_PROTOCOL_FAILURE'
      && !error.message.includes('unexpected_payload'),
  )
  assert.equal(client.publishedSnapshot.logical_workspaces, before.logical_workspaces)
  assert.equal(client.publishedSnapshot.degraded, true)
})

for (const fixture of ['invalid_snapshot_schema', 'invalid_snapshot_status'] as const) {
  test(`snapshot semantics reject ${fixture} without swapping`, async t => {
    const client = await createProtocolFixtureClient(t, fixture)
    const initial = client.publishedSnapshot

    await assert.rejects(
      client.open(),
      (error: unknown) => error instanceof WorkspaceGraphStoreClientError
        && error.code === 'WORKER_PROTOCOL_FAILURE',
    )
    assert.deepEqual(client.publishedSnapshot.logical_workspaces, initial.logical_workspaces)
    assert.equal(client.publishedSnapshot.publication_revision, initial.publication_revision)
    assert.equal(client.publishedSnapshot.degraded, true)
  })
}

test('publication revisions must increase monotonically before a snapshot swap', async t => {
  const client = await createProtocolFixtureClient(t, 'stale_snapshot')
  await client.open()
  const lastGood = client.publishedSnapshot

  await assert.rejects(
    client.replaceCard(logicalWorkspace('lw-a')),
    (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'WORKER_PROTOCOL_FAILURE',
  )
  assert.deepEqual(client.publishedSnapshot.logical_workspaces, lastGood.logical_workspaces)
  assert.equal(client.publishedSnapshot.publication_revision, lastGood.publication_revision)
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
