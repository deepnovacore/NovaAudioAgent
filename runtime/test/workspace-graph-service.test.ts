import assert from 'node:assert/strict'
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {Worker} from 'node:worker_threads'

import {
  applyWorkspaceIdentityDeltas,
  emptyWorkspaceIdentityState,
} from '../src/workspace-graph/identity.js'
import type {WorkspaceGraphProjectionState} from '../src/workspace-graph/projector.js'
import type {
  PersonalContextProvider,
  ProviderEnrichmentResult,
  WorkspaceEvidenceLookupInput,
} from '../src/workspace-graph/provider.js'
import {WorkspaceGraphService} from '../src/workspace-graph/service.js'
import {
  WorkspaceGraphStoreClient,
  WorkspaceGraphStoreClientError,
} from '../src/workspace-graph/store-client.js'

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>(accept => { resolve = accept })
  return {promise, resolve: (value: T) => resolve?.(value)}
}

const emptyProjectionState: WorkspaceGraphProjectionState = Object.freeze({
  logical_workspaces: Object.freeze([]),
  workspace_instances: Object.freeze([]),
  relations: Object.freeze([]),
  projection_records: Object.freeze([]),
})

function blockingClient(gate: Promise<void>) {
  return {
    publishedSnapshot: Object.freeze({
      schema_version: 3,
      publication_revision: 1,
      degraded: false,
      logical_workspaces: Object.freeze([]),
      workspace_instances: Object.freeze([]),
      relations: Object.freeze([]),
      aliases: Object.freeze([]),
    }),
    open: () => Promise.resolve(),
    compact: () => Promise.resolve({derived_rows_before: 0, derived_rows_after: 0}),
    loadGraphState: () => Promise.resolve({
      identity_state: emptyWorkspaceIdentityState(),
      projection_state: emptyProjectionState,
    }),
    applyGraphBatch: async (batch: {readonly observation: {readonly source: string; readonly observation_id: string; readonly occurred_at: number}}) => {
      await gate
      return {
        evidence: {
          source: batch.observation.source,
          ref: batch.observation.observation_id,
          observed_at: batch.observation.occurred_at,
        },
        identity_delta_digest: '0'.repeat(64),
        projection_delta_digest: '0'.repeat(64),
      }
    },
    close: () => Promise.resolve(),
  } as unknown as WorkspaceGraphStoreClient
}

async function holdWriteLock(path: string) {
  const worker = new Worker(new URL('./fixtures/workspace-graph-sqlite-worker.js', import.meta.url), {
    workerData: {mode: 'lock', path},
  })
  await new Promise<void>((resolve, reject) => {
    worker.once('message', message => {
      if ((message as {readonly kind?: unknown}).kind === 'locked') resolve()
      else reject(new Error('lock fixture failed'))
    })
    worker.once('error', reject)
  })
  return async () => {
    worker.postMessage('release')
    await new Promise<void>((resolve, reject) => {
      worker.once('message', message => {
        if ((message as {readonly kind?: unknown}).kind === 'released') resolve()
        else reject(new Error('lock release failed'))
      })
      worker.once('error', reject)
    })
    await worker.terminate()
  }
}

test('service rejects an empty database path before constructing the worker client', () => {
  assert.throws(() => new WorkspaceGraphService({path: ''}), {code: 'GRAPH_SERVICE_INVALID_INPUT'})
})

test('service open schedules compaction before rebuilding its in-memory state', async () => {
  const calls: string[] = []
  const client = {
    publishedSnapshot: Object.freeze({
      schema_version: 3,
      publication_revision: 1,
      degraded: false,
      logical_workspaces: Object.freeze([]),
      workspace_instances: Object.freeze([]),
      relations: Object.freeze([]),
      aliases: Object.freeze([]),
    }),
    open: () => { calls.push('open'); return Promise.resolve() },
    compact: () => {
      calls.push('compact')
      return Promise.resolve({derived_rows_before: 0, derived_rows_after: 0})
    },
    loadGraphState: () => {
      calls.push('load')
      return Promise.resolve({
        identity_state: emptyWorkspaceIdentityState(),
        projection_state: emptyProjectionState,
      })
    },
    close: () => Promise.resolve(),
  } as unknown as WorkspaceGraphStoreClient
  const service = new WorkspaceGraphService({path: '/safe/not-used.sqlite', store_client: client})

  await service.open()

  assert.deepEqual(calls, ['open', 'compact', 'load'])
  await service.close()
})

test('startup compaction failure is advisory and still rebuilds service state', async () => {
  const calls: string[] = []
  const diagnostics: string[] = []
  const client = {
    publishedSnapshot: Object.freeze({
      schema_version: 3,
      publication_revision: 1,
      degraded: false,
      logical_workspaces: Object.freeze([]),
      workspace_instances: Object.freeze([]),
      relations: Object.freeze([]),
      aliases: Object.freeze([]),
    }),
    open: () => { calls.push('open'); return Promise.resolve() },
    compact: () => { calls.push('compact'); return Promise.reject(new Error('private failure')) },
    loadGraphState: () => {
      calls.push('load')
      return Promise.resolve({
        identity_state: emptyWorkspaceIdentityState(),
        projection_state: emptyProjectionState,
      })
    },
    close: () => Promise.resolve(),
  } as unknown as WorkspaceGraphStoreClient
  const service = new WorkspaceGraphService({
    path: '/safe/not-used.sqlite',
    store_client: client,
    on_diagnostic: code => diagnostics.push(code),
  })

  await service.open()

  assert.deepEqual(calls, ['open', 'compact', 'load'])
  assert.deepEqual(diagnostics, ['workspace_graph_write_failed'])
  assert.equal(service.degraded, false)
  await service.close()
})

test('startup compaction failure is retried after the next committed observation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-startup-compaction-retry-'))
  const path = join(directory, 'graph.sqlite')
  const client = new WorkspaceGraphStoreClient(path)
  const originalCompact = client.compact.bind(client)
  let compactionAttempts = 0
  client.compact = async (...args) => {
    compactionAttempts += 1
    if (compactionAttempts === 1) throw new Error('private startup failure')
    return originalCompact(...args)
  }
  const service = new WorkspaceGraphService({path, store_client: client})
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })

  await service.open()
  assert.equal(compactionAttempts, 1)
  assert.equal((await service.openWorkspace({
    path: '/safe/startup-retry', repository_fingerprint: 'host-startup-retry', now: 1,
  })).kind, 'resolved')

  assert.equal(compactionAttempts, 2)
  assert.equal((await client.diagnostics()).observations, 1)
  assert.equal((await client.diagnostics()).operation_receipts, 2)
})

test('task completion rejects an empty string but persists an explicit null summary', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-empty-summary-'))
  const path = join(directory, 'graph.sqlite')
  const service = new WorkspaceGraphService({
    path,
    id_factory: (() => { let value = 0; return () => `summary-observation-${++value}` })(),
  })
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const opened = await service.openWorkspace({
    path: '/safe/summary', repository_fingerprint: 'host-summary', now: 1,
  })
  assert.equal(opened.kind, 'resolved')

  await assert.rejects(Promise.resolve().then(() => service.recordTaskCompletion({
    workspace_instance_id: opened.instance.instance_id,
    summary: '',
    outcome: 'ok',
    now: 2,
    relation_cue: null,
  })), {code: 'GRAPH_SERVICE_INVALID_INPUT'})
  await service.recordTaskCompletion({
    workspace_instance_id: opened.instance.instance_id,
    summary: null,
    outcome: 'ok',
    now: 3,
    relation_cue: null,
  })
  await service.recordTaskCompletion({
    workspace_instance_id: opened.instance.instance_id,
    summary: '🚀'.repeat(119),
    outcome: 'ok',
    now: 4,
    relation_cue: null,
  })

  await service.close()
  const store = new WorkspaceGraphStoreClient(path)
  t.after(() => store.close())
  await store.open()
  const completions = (await store.listObservations()).filter(observation => (
    observation.observation_type === 'task_completed'
  ))
  assert.deepEqual(completions.map(observation => observation.summary), [null, '🚀'.repeat(119)])
  assert.deepEqual(completions.map(observation => observation.outcome), ['ok', 'ok'])
})

test('service schedules periodic compaction after 64 observation writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-periodic-compaction-'))
  const path = join(directory, 'graph.sqlite')
  const service = new WorkspaceGraphService({path})
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const opened = await service.openWorkspace({
    path: '/safe/periodic-compaction', repository_fingerprint: 'host-periodic-compaction', now: 1,
  })
  assert.equal(opened.kind, 'resolved')
  for (let index = 0; index < 63; index += 1) {
    await service.recordTaskCompletion({
      workspace_instance_id: opened.instance.instance_id,
      summary: `periodic observation ${index}`,
      outcome: 'ok',
      now: index + 2,
      relation_cue: null,
    })
  }
  await service.close()

  const store = new WorkspaceGraphStoreClient(path)
  t.after(() => store.close())
  await store.open()
  const diagnostics = await store.diagnostics()
  assert.equal(diagnostics.observations, 64)
  assert.equal(diagnostics.operation_receipts, 66)
})

test('periodic compaction failure preserves the committed write and retries after the next write', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-compaction-retry-'))
  const path = join(directory, 'graph.sqlite')
  const diagnostics: string[] = []
  const client = new WorkspaceGraphStoreClient(path)
  const originalCompact = client.compact.bind(client)
  let compactionAttempts = 0
  client.compact = async (...args) => {
    compactionAttempts += 1
    if (compactionAttempts === 2) throw new Error('private periodic failure')
    return originalCompact(...args)
  }
  const service = new WorkspaceGraphService({
    path,
    store_client: client,
    on_diagnostic: code => diagnostics.push(code),
  })
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const opened = await service.openWorkspace({
    path: '/safe/compaction-retry', repository_fingerprint: 'host-compaction-retry', now: 1,
  })
  assert.equal(opened.kind, 'resolved')
  for (let index = 0; index < 64; index += 1) {
    await service.recordTaskCompletion({
      workspace_instance_id: opened.instance.instance_id,
      summary: `retry observation ${index}`,
      outcome: 'ok',
      now: index + 2,
      relation_cue: null,
    })
  }

  assert.equal(compactionAttempts, 3)
  assert.deepEqual(diagnostics, ['workspace_graph_write_failed'])
  assert.equal((await client.diagnostics()).observations, 65)
  assert.equal((await client.diagnostics()).operation_receipts, 67)
})

test('service commits confirmed workspace lifecycle and reconstructs it after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-'))
  const path = join(directory, 'graph.sqlite')
  t.after(() => rm(directory, {recursive: true, force: true}))
  let sequence = 0
  const first = new WorkspaceGraphService({
    path,
    id_factory: () => `service-observation-${++sequence}`,
  })
  await first.open()
  const opened = await first.openWorkspace({
    path: '/safe/demo',
    repository_fingerprint: 'host-workspace-record-1',
    branch: 'main',
    now: 1,
  })
  assert.equal(opened.kind, 'resolved')
  const context = first.contextForTurn({
    session_epoch: 1,
    workspace_instance_id: opened.instance.instance_id,
    utterance: '继续当前项目',
    preferences: ['用中文'],
  })
  assert.match(context?.header ?? '', /workspace_context/)
  await first.close()

  const reopened = new WorkspaceGraphService({path})
  await reopened.open()
  t.after(() => reopened.close())
  assert.match(reopened.contextForTurn({
    session_epoch: 2,
    workspace_instance_id: opened.instance.instance_id,
    utterance: '继续当前项目',
    preferences: [],
  })?.header ?? '', /workspace_context/)
})

test('adjacent confirmed workspace transitions persist only a weak metadata relation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-transition-'))
  const path = join(directory, 'graph.sqlite')
  let sequence = 0
  const service = new WorkspaceGraphService({
    path,
    id_factory: () => `transition-observation-${++sequence}`,
  })
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const first = await service.openWorkspace({
    path: '/safe/transition-a', repository_fingerprint: 'host-transition-a', now: 1,
  })
  const second = await service.openWorkspace({
    path: '/safe/transition-b', repository_fingerprint: 'host-transition-b', now: 2,
  })
  assert.equal(first.kind, 'resolved')
  assert.equal(second.kind, 'resolved')
  assert.deepEqual(service.publishedSnapshot.relations, [{
    source_logical_id: first.logical_workspace.logical_workspace_id,
    target_logical_id: second.logical_workspace.logical_workspace_id,
    relation_type: 'discussed_with',
    confidence: 0.4,
    reason: 'adjacent confirmed workspace transition',
    evidence_refs: [{source: 'runtime', ref: 'transition-observation-2', observed_at: 2}],
    first_seen_at: 2,
    last_seen_at: 2,
    status: 'weak',
    revision: 0,
  }])

  await service.openWorkspace({
    path: '/safe/transition-b', repository_fingerprint: 'host-transition-b', now: 3,
  })
  await assert.rejects(service.openWorkspace({
    path: 'speculative-relative-path', repository_fingerprint: 'host-speculative', now: 4,
  }))
  assert.equal(service.publishedSnapshot.relations.length, 1)
  assert.equal(service.publishedSnapshot.relations[0]?.revision, 0)
  assert.equal(service.publishedSnapshot.relations[0]?.evidence_refs.length, 1)
  const third = await service.openWorkspace({
    path: '/safe/transition-c', repository_fingerprint: 'host-transition-c', now: 5,
  })
  assert.equal(third.kind, 'resolved')
  assert.equal(service.publishedSnapshot.relations.length, 2,
    'a failed candidate must not erase the last confirmed adjacency anchor')
  assert.ok(service.publishedSnapshot.relations.some(relation => (
    relation.source_logical_id === second.logical_workspace.logical_workspace_id
    && relation.target_logical_id === third.logical_workspace.logical_workspace_id
    && relation.revision === 0
  )))
})

test('queued committed transitions preserve host order as graph adjacency', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-transition-order-'))
  const service = new WorkspaceGraphService({
    path: join(directory, 'graph.sqlite'),
    id_factory: (() => { let value = 0; return () => `ordered-observation-${++value}` })(),
  })
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const first = await service.openWorkspace({
    path: '/safe/ordered-a', repository_fingerprint: 'host-ordered-a', now: 1,
  })
  const secondPending = service.openWorkspace({
    path: '/safe/ordered-b', repository_fingerprint: 'host-ordered-b', now: 2,
  })
  const thirdPending = service.openWorkspace({
    path: '/safe/ordered-c', repository_fingerprint: 'host-ordered-c', now: 3,
  })
  const [second, third] = await Promise.all([secondPending, thirdPending])
  assert.equal(first.kind, 'resolved')
  assert.equal(second.kind, 'resolved')
  assert.equal(third.kind, 'resolved')
  assert.deepEqual(service.publishedSnapshot.relations.map(relation => [
    relation.source_logical_id,
    relation.target_logical_id,
  ]), [
    [first.logical_workspace.logical_workspace_id, second.logical_workspace.logical_workspace_id],
    [second.logical_workspace.logical_workspace_id, third.logical_workspace.logical_workspace_id],
  ])
})

test('runtime transition preserves an existing higher-authority discussed-with relation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-transition-merge-'))
  const service = new WorkspaceGraphService({
    path: join(directory, 'graph.sqlite'),
    id_factory: (() => { let value = 0; return () => `merge-observation-${++value}` })(),
  })
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const first = await service.openWorkspace({
    path: '/safe/merge-a', repository_fingerprint: 'host-merge-a', now: 1,
  })
  await service.openWorkspace({
    path: '/safe/merge-b', repository_fingerprint: 'host-merge-b', now: 2,
  })
  const third = await service.openWorkspace({
    path: '/safe/merge-c', repository_fingerprint: 'host-merge-c', now: 3,
  })
  assert.equal(first.kind, 'resolved')
  assert.equal(third.kind, 'resolved')
  await service.recordTaskCompletion({
    workspace_instance_id: first.instance.instance_id,
    summary: 'typed coordination fact',
    outcome: 'ok',
    now: 4,
    relation_cue: {
      target_logical_id: third.logical_workspace.logical_workspace_id,
      relation_type: 'discussed_with',
      reason: 'typed coordination relationship',
    },
  })
  await service.openWorkspace({
    path: '/safe/merge-a', repository_fingerprint: 'host-merge-a', now: 5,
  })
  await service.openWorkspace({
    path: '/safe/merge-c', repository_fingerprint: 'host-merge-c', now: 6,
  })

  const merged = service.publishedSnapshot.relations.find(relation => (
    relation.source_logical_id === first.logical_workspace.logical_workspace_id
    && relation.target_logical_id === third.logical_workspace.logical_workspace_id
    && relation.relation_type === 'discussed_with'
  ))
  assert.equal(merged?.reason, 'typed coordination relationship')
  assert.equal(merged?.confidence, 0.8)
  assert.equal(merged?.status, 'active')
  assert.deepEqual(merged?.evidence_refs.map(evidence => evidence.source), ['executor', 'runtime'])
  assert.equal(merged?.revision, 1)
})

test('queued workspace maintenance ages transition relations using second-based runtime timestamps', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-aging-'))
  const path = join(directory, 'graph.sqlite')
  let sequence = 0
  const service = new WorkspaceGraphService({
    path,
    id_factory: () => `aging-observation-${++sequence}`,
  })
  await service.open()
  await service.openWorkspace({
    path: '/safe/aging-a', repository_fingerprint: 'host-aging-a', now: 1,
  })
  await service.openWorkspace({
    path: '/safe/aging-b', repository_fingerprint: 'host-aging-b', now: 2,
  })
  const ninetyDaysSeconds = 90 * 24 * 60 * 60
  await service.openWorkspace({
    path: '/safe/aging-b', repository_fingerprint: 'host-aging-b',
    now: 2 + ninetyDaysSeconds,
  })
  await service.close()

  const reopened = new WorkspaceGraphStoreClient(path)
  await reopened.open()
  t.after(async () => {
    await reopened.close()
    await rm(directory, {recursive: true, force: true})
  })
  const relations = await reopened.listRelations()
  assert.equal(relations.length, 1)
  assert.equal(relations[0]?.status, 'stale')
  assert.equal(relations[0]?.revision, 1)
  assert.ok((await reopened.diagnostics()).operation_receipts >= 4)
})

test('typed task relation yields bounded suggestion data without any workspace read', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-recall-'))
  const service = new WorkspaceGraphService({
    path: join(directory, 'graph.sqlite'),
    id_factory: (() => { let value = 0; return () => `service-observation-${++value}` })(),
  })
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const current = await service.openWorkspace({
    path: '/safe/current', repository_fingerprint: 'host-current', now: 1,
  })
  const related = await service.openWorkspace({
    path: '/safe/related', repository_fingerprint: 'host-related', now: 2,
  })
  assert.equal(current.kind, 'resolved')
  assert.equal(related.kind, 'resolved')
  await service.recordTaskCompletion({
    workspace_instance_id: current.instance.instance_id,
    summary: 'memory runtime integration completed',
    outcome: 'ok',
    now: 3,
    relation_cue: {
      target_logical_id: related.logical_workspace.logical_workspace_id,
      relation_type: 'shares_runtime',
      reason: 'shared memory runtime',
    },
  })
  const context = service.contextForTurn({
    session_epoch: 1,
    workspace_instance_id: current.instance.instance_id,
    utterance: 'memory runtime 下一步怎么做',
    preferences: [],
  })
  assert.match(context?.recall_pack ?? '', /suggestion_only/)
  assert.equal(context?.degraded, false)
})

test('service close drains queued writes and rejects later lifecycle calls', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-close-'))
  const service = new WorkspaceGraphService({path: join(directory, 'graph.sqlite')})
  t.after(() => rm(directory, {recursive: true, force: true}))
  await service.open()
  const pending = service.openWorkspace({
    path: '/safe/current', repository_fingerprint: 'host-current', now: 1,
  })
  await service.close()
  assert.equal((await pending).kind, 'resolved')
  await assert.rejects(service.openWorkspace({
    path: '/safe/later', repository_fingerprint: 'host-later', now: 2,
  }), {code: 'GRAPH_SERVICE_CLOSED'})
})

test('service sensitivity gates every lifecycle and episode text before SQLite and diagnostics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-sensitive-'))
  const diagnostics: string[] = []
  const service = new WorkspaceGraphService({
    path: join(directory, 'graph.sqlite'),
    denied_roots: ['/denied/private'],
    on_diagnostic: code => { diagnostics.push(code) },
    id_factory: (() => { let value = 0; return () => `safe-observation-${++value}` })(),
  })
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const current = await service.openWorkspace({
    path: '/safe/current', repository_fingerprint: 'host-current', now: 1,
  })
  const related = await service.openWorkspace({
    path: '/safe/related', repository_fingerprint: 'host-related', now: 2,
  })
  assert.equal(current.kind, 'resolved')
  assert.equal(related.kind, 'resolved')

  const secret = 'sk_abcdefghijklmnop'
  await assert.rejects(service.openWorkspace({
    path: '/safe/.ssh', repository_fingerprint: secret, branch: secret, now: 3,
  }))
  await service.recordTaskCompletion({
    workspace_instance_id: current.instance.instance_id,
    summary: `completed with ${secret} at /denied/private/credentials.txt`,
    outcome: 'ok',
    now: 4,
  })
  await service.recordTaskCompletion({
    workspace_instance_id: current.instance.instance_id,
    summary: 'safe typed objective',
    outcome: 'ok',
    now: 5,
    relation_cue: {
      target_logical_id: related.logical_workspace.logical_workspace_id,
      relation_type: 'shares_runtime',
      reason: `shared runtime; token=${secret}`,
    },
  })

  const bytes = (await Promise.all((await readdir(directory)).map(async file => (
    await readFile(join(directory, file))
  )))).map(value => value.toString('utf8')).join('\n')
  assert.equal(bytes.includes(secret), false)
  assert.equal(bytes.includes('/denied/private'), false)
  assert.equal(bytes.includes('credentials.txt'), false)
  assert.equal(diagnostics.join('\n').includes(secret), false)
  assert.equal(diagnostics.join('\n').includes('/denied/private'), false)
})

test('episode admission gates every field before lookup and persists no rejected relation target', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-admission-'))
  const path = join(directory, 'graph.sqlite')
  const service = new WorkspaceGraphService({path})
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  let summaryReads = 0
  const hostile = {
    workspace_instance_id: 'missing-instance',
    get summary() {
      summaryReads += 1
      return 'token=sk_abcdefghijklmnop'
    },
    outcome: 'ok',
    now: 1,
    relation_cue: null,
  } as const
  await assert.rejects(service.recordTaskCompletion(hostile))
  assert.equal(summaryReads > 0, true, 'summary must be gated before private-state lookup')

  const current = await service.openWorkspace({
    path: '/safe/current', repository_fingerprint: 'host-current', now: 2,
  })
  assert.equal(current.kind, 'resolved')
  await service.recordTaskCompletion({
    workspace_instance_id: current.instance.instance_id,
    summary: 'safe typed objective',
    outcome: 'ok',
    now: 3,
    relation_cue: {
      target_logical_id: 'unknown-logical-workspace',
      relation_type: 'shares_runtime',
      reason: 'unconfirmed relation target',
    },
  })
  await service.close()

  const client = new WorkspaceGraphStoreClient(path)
  await client.open()
  t.after(() => client.close())
  const episode = (await client.listObservations()).find(item => item.observation_type === 'task_completed')
  assert.equal(episode?.related_logical_workspace_id, null)
})

test('service queue has fixed admission capacity and a diagnostic cannot replace overflow', async () => {
  const gate = deferred<void>()
  const diagnostics: string[] = []
  const service = new WorkspaceGraphService({
    path: '/safe/not-used.sqlite',
    store_client: blockingClient(gate.promise),
    on_diagnostic: code => {
      diagnostics.push(code)
      if ((code as string) === 'workspace_graph_queue_full') throw new Error('observer failure')
    },
  })
  await service.open()
  const admitted = Array.from({length: 64}, (_, index) => service.openWorkspace({
    path: `/safe/queued-${index}`,
    repository_fingerprint: `host-queued-${index}`,
    now: index + 1,
  }))
  const overflow = service.openWorkspace({
    path: '/safe/overflow', repository_fingerprint: 'host-overflow', now: 100,
  })
  try {
    const outcome = await Promise.race([
      overflow.then(
        () => ({kind: 'resolved' as const}),
        (error: unknown) => ({kind: 'rejected' as const, error}),
      ),
      new Promise<{readonly kind: 'pending'}>(resolve => {
        setImmediate(() => { resolve({kind: 'pending'}) })
      }),
    ])
    assert.equal(outcome.kind, 'rejected')
    if (outcome.kind !== 'rejected') assert.fail('overflow must reject at admission')
    assert.equal((outcome.error as {readonly code?: unknown}).code, 'GRAPH_SERVICE_QUEUE_FULL')
    assert.deepEqual(diagnostics, ['workspace_graph_queue_full'])
  } finally {
    gate.resolve(undefined)
    await Promise.allSettled([...admitted, overflow])
    await service.close()
  }
})

test('service retries a stale graph batch only within the fixed mutation operation', async () => {
  const client = blockingClient(Promise.resolve()) as unknown as {
    applyGraphBatch: WorkspaceGraphStoreClient['applyGraphBatch']
  }
  const originalApply = client.applyGraphBatch.bind(client)
  let attempts = 0
  client.applyGraphBatch = async (...args) => {
    attempts += 1
    if (attempts === 1) throw new WorkspaceGraphStoreClientError('STORE_STALE_REVISION')
    return await originalApply(...args)
  }
  const service = new WorkspaceGraphService({
    path: '/safe/not-used.sqlite',
    store_client: client as unknown as WorkspaceGraphStoreClient,
  })
  await service.open()
  assert.equal((await service.openWorkspace({
    path: '/safe/retry', repository_fingerprint: 'host-retry', now: 1,
  })).kind, 'resolved')
  assert.equal(attempts, 2)
  await service.close()
})

test('degraded publication retains the last-good service identity and recall projection', async () => {
  let identityState = emptyWorkspaceIdentityState()
  let projectionState: WorkspaceGraphProjectionState = emptyProjectionState
  let commits = 0
  let snapshot: WorkspaceGraphStoreClient['publishedSnapshot'] = {
    schema_version: 3 as const,
    publication_revision: 1,
    degraded: false,
    logical_workspaces: Object.freeze([]),
    workspace_instances: Object.freeze([]),
    relations: Object.freeze([]),
    aliases: Object.freeze([]),
  }
  const client = {
    get publishedSnapshot() { return snapshot },
    open: () => Promise.resolve(),
    compact: () => Promise.resolve({derived_rows_before: 0, derived_rows_after: 0}),
    loadGraphState: () => Promise.resolve({identity_state: identityState, projection_state: projectionState}),
    applyGraphBatch: (batch: Parameters<WorkspaceGraphStoreClient['applyGraphBatch']>[0]) => {
      identityState = applyWorkspaceIdentityDeltas(identityState, batch.identity_deltas)
      projectionState = Object.freeze({
        ...projectionState,
        logical_workspaces: identityState.logical_workspaces,
        workspace_instances: identityState.workspace_instances,
      })
      commits += 1
      if (commits === 1) {
        snapshot = {
          ...snapshot,
          publication_revision: 2,
          logical_workspaces: identityState.logical_workspaces,
          workspace_instances: identityState.workspace_instances,
        }
      } else {
        snapshot = {...snapshot, degraded: true}
      }
      return Promise.resolve({
        evidence: {
          source: batch.observation.source,
          ref: batch.observation.observation_id,
          observed_at: batch.observation.occurred_at,
        },
        identity_delta_digest: '0'.repeat(64),
        projection_delta_digest: '0'.repeat(64),
      })
    },
    close: () => Promise.resolve(),
  } as unknown as WorkspaceGraphStoreClient
  const service = new WorkspaceGraphService({path: '/safe/not-used.sqlite', store_client: client})
  await service.open()
  const first = await service.openWorkspace({
    path: '/safe/first', repository_fingerprint: 'host-first', now: 1,
  })
  const second = await service.openWorkspace({
    path: '/safe/second', repository_fingerprint: 'host-second', now: 2,
  })
  assert.equal(first.kind, 'resolved')
  assert.equal(second.kind, 'resolved')
  assert.match(service.contextForTurn({
    session_epoch: 1, workspace_instance_id: first.instance.instance_id,
    utterance: '', preferences: [],
  })?.header ?? '', /workspace_context/u)
  assert.equal(service.contextForTurn({
    session_epoch: 1, workspace_instance_id: second.instance.instance_id,
    utterance: '', preferences: [],
  }), null)
  await service.close()
})

test('a locked service database keeps the event loop live and resumes the queued mutation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-lock-'))
  const path = join(directory, 'graph.sqlite')
  const service = new WorkspaceGraphService({path})
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const release = await holdWriteLock(path)
  const pending = service.openWorkspace({
    path: '/safe/locked', repository_fingerprint: 'host-locked', now: 1,
  })
  let timerRan = false
  await new Promise<void>(resolve => {
    setTimeout(() => { timerRan = true; resolve() }, 20)
  })
  assert.equal(timerRan, true)
  await release()
  assert.equal((await pending).kind, 'resolved')
})

test('service close force-owns a worker whose open RPC never settles', async () => {
  const client = new WorkspaceGraphStoreClient('/safe/not-used.sqlite', {
    workerFactory: (_url, options) => new Worker(
      new URL('./fixtures/workspace-graph-sqlite-worker.js', import.meta.url),
      {...options, workerData: {mode: 'silent'}},
    ),
  })
  const service = new WorkspaceGraphService({path: '/safe/not-used.sqlite', store_client: client})
  const opening = service.open().then(
    () => ({kind: 'resolved' as const}),
    (error: unknown) => ({kind: 'rejected' as const, error}),
  )
  await new Promise<void>(resolve => { setImmediate(resolve) })
  const closing = service.close()
  const outcome = await Promise.race([
    closing.then(() => 'closed' as const),
    new Promise<'pending'>(resolve => { setTimeout(() => { resolve('pending') }, 1_000) }),
  ])
  assert.equal(outcome, 'closed')
  const opened = await opening
  assert.equal(opened.kind, 'rejected')
  if (opened.kind !== 'rejected') assert.fail('stuck open must be rejected by close ownership')
  assert.equal((opened.error as {readonly code?: unknown}).code, 'CLIENT_CLOSED')
})

test('service close force-owns an already-open worker whose queued mutation never settles', async () => {
  const client = new WorkspaceGraphStoreClient('/safe/not-used.sqlite', {
    workerFactory: (_url, options) => new Worker(
      new URL('./fixtures/workspace-graph-sqlite-worker.js', import.meta.url),
      {...options, workerData: {mode: 'open_then_silent'}},
    ),
  })
  const service = new WorkspaceGraphService({path: '/safe/not-used.sqlite', store_client: client})
  await service.open()
  const mutation = service.openWorkspace({
    path: '/safe/stalled', repository_fingerprint: 'host-stalled', now: 1,
  }).then(
    () => ({kind: 'resolved' as const}),
    (error: unknown) => ({kind: 'rejected' as const, error}),
  )
  await new Promise<void>(resolve => { setImmediate(resolve) })
  try {
    const closing = service.close()
    const outcome = await Promise.race([
      closing.then(() => 'closed' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => { resolve('pending') }, 1_000) }),
    ])
    assert.equal(outcome, 'closed')
    const mutated = await mutation
    assert.equal(mutated.kind, 'rejected')
    if (mutated.kind !== 'rejected') assert.fail('stalled mutation must reject after force close')
    assert.equal((mutated.error as {readonly code?: unknown}).code, 'CLIENT_CLOSED')
    await service.close()
  } finally {
    await client.close()
  }
})

test('provider remains absent from open, switch, context, board snapshot, and default recall paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-provider-lazy-'))
  const calls: WorkspaceEvidenceLookupInput[] = []
  const provider: PersonalContextProvider = {
    lookupWorkspaceEvidence: input => {
      calls.push(input)
      return Promise.resolve(Object.freeze({
        evidence: Object.freeze([]), omitted_evidence: 0, degraded: false, diagnostic: null,
      }))
    },
  }
  const service = new WorkspaceGraphService({
    path: join(directory, 'graph.sqlite'), personal_context_provider: provider,
  })
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  assert.equal(calls.length, 0)
  await service.open()
  const current = await service.openWorkspace({
    path: '/safe/current', repository_fingerprint: 'host-current', now: 1,
  })
  assert.equal(current.kind, 'resolved')
  service.contextForTurn({
    session_epoch: 1,
    workspace_instance_id: current.instance.instance_id,
    utterance: 'why is this related',
    preferences: [],
  })
  JSON.stringify(service.publishedSnapshot)
  assert.equal(calls.length, 0)
})

test('explicit enrichment derives scope from the authoritative current published workspace only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-provider-scope-'))
  const calls: WorkspaceEvidenceLookupInput[] = []
  const returned: ProviderEnrichmentResult = Object.freeze({
    evidence: Object.freeze([Object.freeze({
      provider: 'mycontext',
      source: 'provider',
      trust: 'untrusted_external',
      source_ref: Object.freeze({provider: 'mycontext', ref: 'opaque-source'}),
      occurred_at: 3,
      confidence: 0.7,
      text: 'A meeting contains supporting evidence.',
    })]),
    omitted_evidence: 0,
    degraded: false,
    diagnostic: null,
  })
  const provider: PersonalContextProvider = {
    lookupWorkspaceEvidence: input => {
      calls.push(input)
      return Promise.resolve(returned)
    },
  }
  const service = new WorkspaceGraphService({
    path: join(directory, 'graph.sqlite'), personal_context_provider: provider,
  })
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const first = await service.openWorkspace({
    path: '/safe/first', repository_fingerprint: 'host-first', now: 1,
  })
  const second = await service.openWorkspace({
    path: '/safe/second', repository_fingerprint: 'host-second', now: 2,
  })
  assert.equal(first.kind, 'resolved')
  assert.equal(second.kind, 'resolved')

  const before = JSON.stringify(service.publishedSnapshot)
  const rejected = await service.enrichAfterExplicitRecall({
    workspace_instance_id: first.instance.instance_id,
    query: 'why is this related?',
    limit: 4,
  })
  assert.equal(rejected.diagnostic, 'protocol')
  assert.equal(calls.length, 0)

  const accepted = await service.enrichAfterExplicitRecall({
    workspace_instance_id: second.instance.instance_id,
    query: 'why is this related?',
    limit: 4,
  })
  assert.equal(accepted, returned)
  assert.deepEqual(calls, [{
    logical_workspace_id: second.logical_workspace.logical_workspace_id,
    workspace_name: second.logical_workspace.display_name,
    query: 'why is this related?',
    limit: 4,
  }])
  assert.equal(JSON.stringify(service.publishedSnapshot), before)
})

test('invalid, unknown, not-current, and provider-throwing explicit recall degrade without mutation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-provider-degrade-'))
  let calls = 0
  const provider: PersonalContextProvider = {
    lookupWorkspaceEvidence: () => {
      calls += 1
      return Promise.reject(new Error('endpoint and secret provider failure'))
    },
  }
  const service = new WorkspaceGraphService({
    path: join(directory, 'graph.sqlite'), personal_context_provider: provider,
  })
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const current = await service.openWorkspace({
    path: '/safe/current', repository_fingerprint: 'host-current', now: 1,
  })
  assert.equal(current.kind, 'resolved')
  const revision = service.publishedSnapshot.publication_revision
  for (const input of [
    {workspace_instance_id: 'unknown', query: 'why?', limit: 1},
    {workspace_instance_id: current.instance.instance_id, query: 'token=sk_abcdefghijklmnop', limit: 1},
    {workspace_instance_id: current.instance.instance_id, query: 'ｔｏｋｅｎ＝abcdefghijklmnop', limit: 1},
    {workspace_instance_id: current.instance.instance_id, query: '／home／user／.ssh／id_rsa', limit: 1},
    {workspace_instance_id: current.instance.instance_id, query: 'why\u202e?', limit: 1},
    {workspace_instance_id: current.instance.instance_id, query: 'why\u0001?', limit: 1},
    {workspace_instance_id: current.instance.instance_id, query: 'why\ud800?', limit: 1},
    {workspace_instance_id: current.instance.instance_id, query: 'ﷺ'.repeat(3_000), limit: 1},
    {workspace_instance_id: current.instance.instance_id, query: 'x'.repeat(5_000), limit: 1},
  ]) {
    const result = await service.enrichAfterExplicitRecall(input)
    assert.equal(result.diagnostic, 'protocol')
  }
  assert.equal(calls, 0)
  const failure = await service.enrichAfterExplicitRecall({
    workspace_instance_id: current.instance.instance_id, query: 'why?', limit: 1,
  })
  assert.deepEqual(failure, {
    evidence: [], omitted_evidence: 0, degraded: true, diagnostic: 'unavailable',
  })
  assert.equal(calls, 1)
  assert.equal(service.publishedSnapshot.publication_revision, revision)
})

test('a pending or completed workspace switch revokes prior provider scope immediately', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-provider-revoke-'))
  const path = join(directory, 'graph.sqlite')
  let providerCalls = 0
  const pendingProvider = deferred<ProviderEnrichmentResult>()
  const provider: PersonalContextProvider = {
    lookupWorkspaceEvidence: () => {
      providerCalls += 1
      return providerCalls === 1
        ? pendingProvider.promise
        : Promise.resolve(Object.freeze({
          evidence: Object.freeze([]), omitted_evidence: 0, degraded: false, diagnostic: null,
        }))
    },
  }
  const service = new WorkspaceGraphService({path, personal_context_provider: provider})
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const first = await service.openWorkspace({
    path: '/safe/first', repository_fingerprint: 'host-first', now: 1,
  })
  assert.equal(first.kind, 'resolved')

  const inFlightRecall = service.enrichAfterExplicitRecall({
    workspace_instance_id: first.instance.instance_id, query: 'why?', limit: 1,
  })
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(providerCalls, 1)

  const release = await holdWriteLock(path)
  const switching = service.openWorkspace({
    path: '/safe/second', repository_fingerprint: 'host-second', now: 2,
  })
  const revoked = await service.enrichAfterExplicitRecall({
    workspace_instance_id: first.instance.instance_id, query: 'why again?', limit: 1,
  })
  assert.equal(revoked.diagnostic, 'protocol')
  assert.equal(providerCalls, 1)

  pendingProvider.resolve(Object.freeze({
    evidence: Object.freeze([]), omitted_evidence: 0, degraded: false, diagnostic: null,
  }))
  assert.equal((await inFlightRecall).diagnostic, 'protocol', 'late old-scope result must be discarded')
  await release()
  assert.equal((await switching).kind, 'resolved')
})

test('an in-flight provider result is stale after reopening even the same workspace instance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-service-provider-generation-'))
  const pendingProvider = deferred<ProviderEnrichmentResult>()
  const provider: PersonalContextProvider = {
    lookupWorkspaceEvidence: () => pendingProvider.promise,
  }
  const service = new WorkspaceGraphService({
    path: join(directory, 'graph.sqlite'), personal_context_provider: provider,
  })
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const current = await service.openWorkspace({
    path: '/safe/current', repository_fingerprint: 'host-current', now: 1,
  })
  assert.equal(current.kind, 'resolved')
  const recall = service.enrichAfterExplicitRecall({
    workspace_instance_id: current.instance.instance_id, query: 'why?', limit: 1,
  })
  await new Promise<void>(resolve => { setImmediate(resolve) })
  const reopened = await service.openWorkspace({
    path: '/safe/current', repository_fingerprint: 'host-current', now: 2,
  })
  assert.equal(reopened.kind, 'resolved')
  assert.equal(reopened.instance.instance_id, current.instance.instance_id)
  pendingProvider.resolve(Object.freeze({
    evidence: Object.freeze([]), omitted_evidence: 0, degraded: false, diagnostic: null,
  }))
  assert.equal((await recall).diagnostic, 'protocol')
})
