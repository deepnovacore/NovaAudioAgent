import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {Worker, type WorkerOptions} from 'node:worker_threads'

import {
  WorkspaceIdentityResolver,
  emptyWorkspaceIdentityState,
} from '../src/workspace-graph/identity.js'
import type {Observation} from '../src/workspace-graph/models.js'
import {GraphProjector, relationDeltaDigest} from '../src/workspace-graph/projector.js'
import {
  WorkspaceGraphStoreClient,
  WorkspaceGraphStoreClientError,
  type WorkspaceGraphWorker,
} from '../src/workspace-graph/store-client.js'

function observation(id: string, logicalId: string, instanceId: string): Observation {
  return {
    observation_id: id,
    observation_type: 'workspace_opened',
    occurred_at: 1,
    source: 'runtime',
    trust: 'trusted_system',
    logical_workspace_id: logicalId,
    workspace_instance_id: instanceId,
    related_logical_workspace_id: null,
    summary: 'confirmed workspace lifecycle',
    outcome: 'ok',
    evidence_refs: [],
  }
}

async function projectionBatch(client: WorkspaceGraphStoreClient) {
  const first = new WorkspaceIdentityResolver(emptyWorkspaceIdentityState()).resolve({
    path: '/safe/first', git_remote: null, repository_fingerprint: 'workspace-first', now: 1,
  })
  assert.equal(first.kind, 'resolved')
  await client.applyGraphBatch({
    observation: observation('provenance-open-first', first.logical_workspace.logical_workspace_id,
      first.instance.instance_id),
    identity_deltas: first.deltas,
    projection_deltas: [],
  }, '91111111-1111-4111-8111-111111111111')
  let state = await client.loadGraphState()
  const second = new WorkspaceIdentityResolver(state.identity_state).resolve({
    path: '/safe/second', git_remote: null, repository_fingerprint: 'workspace-second', now: 2,
  })
  assert.equal(second.kind, 'resolved')
  await client.applyGraphBatch({
    observation: observation('provenance-open-second', second.logical_workspace.logical_workspace_id,
      second.instance.instance_id),
    identity_deltas: second.deltas,
    projection_deltas: [],
  }, '92222222-2222-4222-8222-222222222222')
  state = await client.loadGraphState()
  const evidence = Object.freeze({source: 'executor' as const, ref: 'provenance-relation', observed_at: 3})
  const relationObservation: Observation = Object.freeze({
    observation_id: 'provenance-relation',
    observation_type: 'task_completed',
    occurred_at: 3,
    source: 'executor',
    trust: 'trusted_system',
    logical_workspace_id: first.logical_workspace.logical_workspace_id,
    workspace_instance_id: first.instance.instance_id,
    related_logical_workspace_id: second.logical_workspace.logical_workspace_id,
    summary: 'shared runtime task',
    outcome: 'ok',
    evidence_refs: [evidence],
  })
  const projected = new GraphProjector(state.projection_state, {
    stale_after_ms: 90 * 24 * 60 * 60 * 1_000,
    proactive_confidence_threshold: 0.65,
  }).apply({
    origin: 'trusted_runtime',
    observation: relationObservation,
    relation_cue: {
      kind: 'task_completion',
      stance: 'supplement',
      source_logical_id: first.logical_workspace.logical_workspace_id,
      target_logical_id: second.logical_workspace.logical_workspace_id,
      relation_type: 'shares_runtime',
      reason: 'shared runtime task',
      evidence_refs: [evidence],
    },
  })
  assert.equal(projected.deltas.length, 2)
  return {relationObservation, deltas: projected.deltas}
}

async function transitionBatch(client: WorkspaceGraphStoreClient) {
  await projectionBatch(client)
  const state = await client.loadGraphState()
  const first = state.identity_state.workspace_instances.find(candidate => (
    candidate.repository_fingerprint === 'workspace-first'
  ))
  const second = state.identity_state.workspace_instances.find(candidate => (
    candidate.repository_fingerprint === 'workspace-second'
  ))
  assert.ok(first !== undefined)
  assert.ok(second !== undefined)
  const evidence = Object.freeze({
    source: 'runtime' as const, ref: 'transition-open-second', observed_at: 4,
  })
  const transitionObservation: Observation = Object.freeze({
    observation_id: 'transition-open-second', observation_type: 'workspace_opened',
    occurred_at: 4, source: 'runtime', trust: 'trusted_system',
    logical_workspace_id: second.logical_workspace_id,
    workspace_instance_id: second.instance_id,
    related_logical_workspace_id: first.logical_workspace_id,
    summary: 'confirmed workspace lifecycle', outcome: 'ok', evidence_refs: [evidence],
  })
  const projected = new GraphProjector(state.projection_state, {
    stale_after_ms: 90 * 24 * 60 * 60,
    proactive_confidence_threshold: 0.65,
  }).apply({
    origin: 'trusted_runtime', observation: transitionObservation,
    relation_cue: {
      kind: 'workspace_transition', stance: 'supplement',
      source_logical_id: first.logical_workspace_id,
      target_logical_id: second.logical_workspace_id,
      relation_type: 'discussed_with', reason: 'adjacent confirmed workspace transition',
      evidence_refs: [evidence],
    },
  })
  assert.equal(projected.deltas.length, 2)
  return {transitionObservation, deltas: projected.deltas}
}

test('atomic graph batch reconstructs identity private state after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-batch-'))
  const path = join(directory, 'graph.sqlite')
  t.after(() => rm(directory, {recursive: true, force: true}))
  const decision = new WorkspaceIdentityResolver(emptyWorkspaceIdentityState()).resolve({
    path: '/safe/demo',
    git_remote: null,
    repository_fingerprint: 'workspace-record-1',
    now: 1,
  })
  assert.equal(decision.kind, 'resolved')
  const first = new WorkspaceGraphStoreClient(path)
  await first.open()
  const committed = await first.applyGraphBatch({
    observation: observation('open-1', decision.logical_workspace.logical_workspace_id, decision.instance.instance_id),
    identity_deltas: decision.deltas,
    projection_deltas: [],
  }, '11111111-1111-4111-8111-111111111111')
  assert.equal(committed.evidence.ref, 'open-1')
  assert.equal(Object.isFrozen(committed), true)
  assert.equal(Object.isFrozen(committed.evidence), true)
  await first.close()

  const reopened = new WorkspaceGraphStoreClient(path)
  await reopened.open()
  t.after(() => reopened.close())
  const state = await reopened.loadGraphState()
  assert.equal(Object.isFrozen(state), true)
  assert.equal(Object.isFrozen(state.identity_state), true)
  assert.equal(Object.isFrozen(state.identity_state.logical_workspaces), true)
  assert.deepEqual(state.identity_state.logical_workspaces, [decision.logical_workspace])
  assert.deepEqual(state.identity_state.workspace_instances, [decision.instance])
  assert.equal(state.identity_state.bindings.length, 1)
})

test('atomic graph batch rolls observation back when an identity revision is stale', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-batch-stale-'))
  const path = join(directory, 'graph.sqlite')
  const client = new WorkspaceGraphStoreClient(path)
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  await client.open()
  const decision = new WorkspaceIdentityResolver(emptyWorkspaceIdentityState()).resolve({
    path: '/safe/demo', git_remote: null, repository_fingerprint: 'workspace-record-1', now: 1,
  })
  assert.equal(decision.kind, 'resolved')
  await client.applyGraphBatch({
    observation: observation('open-1', decision.logical_workspace.logical_workspace_id, decision.instance.instance_id),
    identity_deltas: decision.deltas,
    projection_deltas: [],
  }, '22222222-2222-4222-8222-222222222222')

  const stale = decision.deltas.map(delta => delta.kind === 'upsert_logical_workspace'
    ? {...delta, workspace: {...delta.workspace, display_name: 'stale overwrite'}}
    : delta)
  await assert.rejects(client.applyGraphBatch({
    observation: observation('open-stale', decision.logical_workspace.logical_workspace_id, decision.instance.instance_id),
    identity_deltas: stale,
    projection_deltas: [],
  }, '33333333-3333-4333-8333-333333333333'), {code: 'STORE_STALE_REVISION'})
  assert.equal(await client.getObservation('runtime', 'open-stale'), undefined)
})

test('graph batch operation replay returns exact receipt and does not double apply', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-batch-replay-'))
  const path = join(directory, 'graph.sqlite')
  const client = new WorkspaceGraphStoreClient(path)
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  await client.open()
  const decision = new WorkspaceIdentityResolver(emptyWorkspaceIdentityState()).resolve({
    path: '/safe/demo', git_remote: null, repository_fingerprint: 'workspace-record-1', now: 1,
  })
  assert.equal(decision.kind, 'resolved')
  const input = {
    observation: observation('open-1', decision.logical_workspace.logical_workspace_id, decision.instance.instance_id),
    identity_deltas: decision.deltas,
    projection_deltas: [],
  } as const
  const operationId = '44444444-4444-4444-8444-444444444444'
  const first = await client.applyGraphBatch(input, operationId)
  const replay = await client.applyGraphBatch(input, operationId)
  assert.deepEqual(replay, first)
  await assert.rejects(client.applyGraphBatch({
    ...input,
    observation: {...input.observation, summary: 'tampered replay'},
  }, operationId), (error: unknown) => error instanceof WorkspaceGraphStoreClientError
    && error.code === 'STORE_OPERATION_CONFLICT')
  assert.equal((await client.listObservations()).length, 1)
})

test('graph batch reconciles worker exit after commit without double application', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-batch-exit-'))
  const path = join(directory, 'graph.sqlite')
  let spawns = 0
  const workerFactory = (url: URL, options: WorkerOptions): WorkspaceGraphWorker => {
    spawns += 1
    const configured = options.workerData as Record<string, unknown>
    return new Worker(url, {
      ...options,
      workerData: spawns === 1
        ? {...configured, testHooks: {exitAfterCommitBeforeResponse: 'graph_batch'}}
        : configured,
    })
  }
  const client = new WorkspaceGraphStoreClient(path, {workerFactory})
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  await client.open()
  const decision = new WorkspaceIdentityResolver(emptyWorkspaceIdentityState()).resolve({
    path: '/safe/demo', git_remote: null, repository_fingerprint: 'workspace-record-1', now: 1,
  })
  assert.equal(decision.kind, 'resolved')
  const committed = await client.applyGraphBatch({
    observation: observation('open-after-exit', decision.logical_workspace.logical_workspace_id,
      decision.instance.instance_id),
    identity_deltas: decision.deltas,
    projection_deltas: [],
  }, '55555555-5555-4555-8555-555555555555')
  assert.equal(committed.evidence.ref, 'open-after-exit')
  assert.ok(spawns >= 2)
  assert.equal((await client.listObservations()).length, 1)
  assert.deepEqual((await client.loadGraphState()).identity_state.logical_workspaces,
    [decision.logical_workspace])
})

test('a mid-graph-batch relation fault rolls back observation, relation, projection, and receipt',
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'nova-graph-batch-fault-'))
    const path = join(directory, 'graph.sqlite')
    const workerFactory = (url: URL, options: WorkerOptions): WorkspaceGraphWorker => {
      const configured = options.workerData as Record<string, unknown>
      return new Worker(url, {
        ...options,
        workerData: {...configured, testHooks: {failAfterFirstRelationStatement: true}},
      })
    }
    const client = new WorkspaceGraphStoreClient(path, {workerFactory})
    t.after(async () => {
      await client.close()
      await rm(directory, {recursive: true, force: true})
    })
    await client.open()
    const first = new WorkspaceIdentityResolver(emptyWorkspaceIdentityState()).resolve({
      path: '/safe/first', git_remote: null, repository_fingerprint: 'workspace-first', now: 1,
    })
    assert.equal(first.kind, 'resolved')
    await client.applyGraphBatch({
      observation: observation('open-first', first.logical_workspace.logical_workspace_id,
        first.instance.instance_id),
      identity_deltas: first.deltas,
      projection_deltas: [],
    }, '66666666-6666-4666-8666-666666666666')
    let state = await client.loadGraphState()
    const second = new WorkspaceIdentityResolver(state.identity_state).resolve({
      path: '/safe/second', git_remote: null, repository_fingerprint: 'workspace-second', now: 2,
    })
    assert.equal(second.kind, 'resolved')
    await client.applyGraphBatch({
      observation: observation('open-second', second.logical_workspace.logical_workspace_id,
        second.instance.instance_id),
      identity_deltas: second.deltas,
      projection_deltas: [],
    }, '77777777-7777-4777-8777-777777777777')
    state = await client.loadGraphState()
    const evidence = Object.freeze({source: 'executor' as const, ref: 'typed-relation', observed_at: 3})
    const relationObservation: Observation = Object.freeze({
      observation_id: 'typed-relation',
      observation_type: 'task_completed',
      occurred_at: 3,
      source: 'executor',
      trust: 'trusted_system',
      logical_workspace_id: first.logical_workspace.logical_workspace_id,
      workspace_instance_id: first.instance.instance_id,
      related_logical_workspace_id: second.logical_workspace.logical_workspace_id,
      summary: 'shared runtime task',
      outcome: 'ok',
      evidence_refs: [evidence],
    })
    const projected = new GraphProjector(state.projection_state, {
      stale_after_ms: 90 * 24 * 60 * 60 * 1_000,
      proactive_confidence_threshold: 0.65,
    }).apply({
      origin: 'trusted_runtime',
      observation: relationObservation,
      relation_cue: {
        kind: 'task_completion',
        stance: 'supplement',
        source_logical_id: first.logical_workspace.logical_workspace_id,
        target_logical_id: second.logical_workspace.logical_workspace_id,
        relation_type: 'shares_runtime',
        reason: 'shared runtime task',
        evidence_refs: [evidence],
      },
    })
    assert.ok(projected.deltas.length > 0)
    const before = client.publishedSnapshot
    const operationId = '88888888-8888-4888-8888-888888888888'
    await assert.rejects(client.applyGraphBatch({
      observation: relationObservation,
      identity_deltas: [],
      projection_deltas: projected.deltas,
    }, operationId), (error: unknown) => error instanceof WorkspaceGraphStoreClientError
      && error.code === 'STORE_WRITE_FAILED')
    assert.equal(client.publishedSnapshot, before)
    assert.equal(await client.getObservation('executor', 'typed-relation'), undefined)
    assert.deepEqual(await client.listRelations(), [])
    assert.equal(await client.getOperationReceipt(operationId), undefined)
    assert.deepEqual((await client.loadGraphState()).projection_state.projection_records, [])
  })

test('first-insert graph batch rejects a projection record for a different observation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-batch-provenance-'))
  const client = new WorkspaceGraphStoreClient(join(directory, 'graph.sqlite'))
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  await client.open()
  const batch = await projectionBatch(client)
  const mismatched = batch.deltas.map(delta => delta.kind === 'record_projection'
    ? {...delta, record: {...delta.record, observation_id: 'different-observation'}}
    : delta)
  await assert.rejects(client.applyGraphBatch({
    observation: batch.relationObservation,
    identity_deltas: [],
    projection_deltas: mismatched,
  }, '93333333-3333-4333-8333-333333333333'), {code: 'STORE_OPERATION_CONFLICT'})
  assert.equal(await client.getObservation('executor', 'provenance-relation'), undefined)
})

test('authenticated projection batch rejects store-layer observation redaction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-batch-redaction-'))
  const client = new WorkspaceGraphStoreClient(join(directory, 'graph.sqlite'))
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  await client.open()
  const batch = await projectionBatch(client)
  await assert.rejects(client.applyGraphBatch({
    observation: {...batch.relationObservation, summary: 'token=sk_abcdefghijklmnop'},
    identity_deltas: [],
    projection_deltas: batch.deltas,
  }, '94444444-4444-4444-8444-444444444444'), {code: 'STORE_OPERATION_CONFLICT'})
  assert.equal(await client.getObservation('executor', 'provenance-relation'), undefined)
})

test('graph batch rejects an orphan relation delta without projection provenance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-batch-orphan-'))
  const client = new WorkspaceGraphStoreClient(join(directory, 'graph.sqlite'))
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  await client.open()
  const batch = await projectionBatch(client)
  const relationOnly = batch.deltas.filter(delta => delta.kind === 'upsert_relation')
  await assert.rejects(client.applyGraphBatch({
    observation: batch.relationObservation,
    identity_deltas: [],
    projection_deltas: relationOnly,
  }, '95555555-5555-4555-8555-555555555555'), {code: 'STORE_OPERATION_CONFLICT'})
  assert.equal(await client.getObservation('executor', 'provenance-relation'), undefined)
  assert.deepEqual(await client.listRelations(), [])
})

test('graph batch rejects an authenticated pair with an extra relation delta', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-batch-extra-'))
  const client = new WorkspaceGraphStoreClient(join(directory, 'graph.sqlite'))
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  await client.open()
  const batch = await projectionBatch(client)
  const relation = batch.deltas.find(delta => delta.kind === 'upsert_relation')
  assert.ok(relation?.kind === 'upsert_relation')
  const extra = {
    ...relation,
    relation: {
      ...relation.relation,
      source_logical_id: relation.relation.target_logical_id,
      target_logical_id: relation.relation.source_logical_id,
      relation_type: 'depends_on' as const,
    },
  }
  await assert.rejects(client.applyGraphBatch({
    observation: batch.relationObservation,
    identity_deltas: [],
    projection_deltas: [...batch.deltas, extra],
  }, '96666666-6666-4666-8666-666666666666'), {code: 'STORE_OPERATION_CONFLICT'})
  assert.equal(await client.getObservation('executor', 'provenance-relation'), undefined)
  assert.deepEqual(await client.listRelations(), [])
})

test('graph batch rejects a forged authority on workspace transition provenance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-batch-transition-authority-'))
  const client = new WorkspaceGraphStoreClient(join(directory, 'graph.sqlite'))
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  await client.open()
  const batch = await transitionBatch(client)
  const forged = batch.deltas.map(delta => delta.kind === 'record_projection'
    ? {...delta, record: {...delta.record, authority: 'trusted_system' as const}}
    : delta)

  await assert.rejects(client.applyGraphBatch({
    observation: batch.transitionObservation,
    identity_deltas: [],
    projection_deltas: forged,
  }, '97777777-7777-4777-8777-777777777777'), {code: 'STORE_OPERATION_CONFLICT'})
  assert.equal(await client.getObservation('runtime', 'transition-open-second'), undefined)
  assert.deepEqual(await client.listRelations(), [])
})

test('graph batch rejects a fixed transition cue paired with a forged result reason', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-batch-transition-result-'))
  const client = new WorkspaceGraphStoreClient(join(directory, 'graph.sqlite'))
  t.after(async () => {
    await client.close()
    await rm(directory, {recursive: true, force: true})
  })
  await client.open()
  const batch = await transitionBatch(client)
  const relationDelta = batch.deltas.find(delta => delta.kind === 'upsert_relation')
  assert.ok(relationDelta?.kind === 'upsert_relation')
  const forgedRelationDelta = {
    ...relationDelta,
    relation: {...relationDelta.relation, reason: 'forged transition conclusion'},
  }
  const forgedDigest = relationDeltaDigest(forgedRelationDelta)
  const forged = batch.deltas.map(delta => {
    if (delta.kind === 'upsert_relation') return forgedRelationDelta
    return {...delta, record: {...delta.record, relation_delta_digest: forgedDigest}}
  })

  await assert.rejects(client.applyGraphBatch({
    observation: batch.transitionObservation,
    identity_deltas: [],
    projection_deltas: forged,
  }, '98888888-8888-4888-8888-888888888888'), {code: 'STORE_OPERATION_CONFLICT'})
  assert.equal(await client.getObservation('runtime', 'transition-open-second'), undefined)
  assert.deepEqual(await client.listRelations(), [])
})
