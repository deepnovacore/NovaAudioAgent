import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
  GraphProjector,
  GraphProjectorError,
  applyWorkspaceGraphProjectionDeltas,
  retainRelationEvidence,
  type ProjectionResult,
  type ProjectionSignal,
  type WorkspaceGraphProjectionState,
} from '../src/workspace-graph/projector.js'
import type {
  EvidenceRef,
  LogicalWorkspace,
  Observation,
  RelationCard,
} from '../src/workspace-graph/models.js'

const DAY_MS = 24 * 60 * 60 * 1_000
const projectorOptions = Object.freeze({
  stale_after_ms: 90 * DAY_MS,
  proactive_confidence_threshold: 0.65,
})

function relationDelta(result: ProjectionResult) {
  const delta = result.deltas[0]
  if (delta?.kind !== 'upsert_relation') {
    assert.fail('expected an upsert_relation delta')
  }
  return delta
}

function logicalWorkspace(logicalWorkspaceId: string): LogicalWorkspace {
  const aliases: string[] = []
  Object.freeze(aliases)
  return Object.freeze({
    logical_workspace_id: logicalWorkspaceId,
    display_name: logicalWorkspaceId,
    aliases,
    canonical_remote: null,
    created_at: 0,
    updated_at: 0,
    revision: 0,
  })
}

function projectionState(
  relations: readonly RelationCard[] = [],
): WorkspaceGraphProjectionState {
  return Object.freeze({
    logical_workspaces: Object.freeze([
      logicalWorkspace('lw-a'),
      logicalWorkspace('lw-b'),
      logicalWorkspace('lw-unrelated'),
    ]),
    workspace_instances: Object.freeze([]),
    relations: Object.freeze([...relations]),
    projection_records: Object.freeze([]),
  })
}

function artifactSignal(
  evidence: EvidenceRef = Object.freeze({
    source: 'runtime',
    ref: 'artifact-1',
    observed_at: 10,
  }),
): ProjectionSignal {
  const observationEvidence: EvidenceRef[] = [evidence]
  const cueEvidence: EvidenceRef[] = [evidence]
  Object.freeze(observationEvidence)
  Object.freeze(cueEvidence)
  const observation: Observation = Object.freeze({
    observation_id: 'observation-artifact-1',
    observation_type: 'task_artifact_reference',
    occurred_at: 10,
    source: 'runtime',
    trust: 'trusted_system',
    logical_workspace_id: 'lw-a',
    workspace_instance_id: null,
    related_logical_workspace_id: 'lw-b',
    summary: 'The task used the shared runtime contract',
    outcome: 'ok',
    evidence_refs: observationEvidence,
  })
  return Object.freeze({
    origin: 'trusted_runtime',
    observation,
    relation_cue: Object.freeze({
      kind: 'artifact_reference',
      stance: 'supplement',
      source_logical_id: 'lw-a',
      target_logical_id: 'lw-b',
      relation_type: 'shares_runtime',
      reason: 'Shared runtime contract',
      evidence_refs: cueEvidence,
    }),
  })
}

function relationSignal(input: {
  readonly id: string
  readonly observation_type: Observation['observation_type']
  readonly source: Observation['source']
  readonly trust: Observation['trust']
  readonly origin: ProjectionSignal['origin']
  readonly cue_kind: NonNullable<ProjectionSignal['relation_cue']>['kind']
  readonly stance?: NonNullable<ProjectionSignal['relation_cue']>['stance']
  readonly relation_type?: RelationCard['relation_type']
  readonly reason?: string
  readonly occurred_at?: number
}): ProjectionSignal {
  const occurredAt = input.occurred_at ?? 20
  const evidence = Object.freeze({
    source: input.source,
    ref: `evidence-${input.id}`,
    observed_at: occurredAt,
  }) satisfies EvidenceRef
  const observationEvidence: EvidenceRef[] = [evidence]
  Object.freeze(observationEvidence)
  const cueEvidence: EvidenceRef[] = [evidence]
  Object.freeze(cueEvidence)
  return Object.freeze({
    origin: input.origin,
    observation: Object.freeze({
      observation_id: `observation-${input.id}`,
      observation_type: input.observation_type,
      occurred_at: occurredAt,
      source: input.source,
      trust: input.trust,
      logical_workspace_id: 'lw-a',
      workspace_instance_id: null,
      related_logical_workspace_id: 'lw-b',
      summary: input.reason ?? `Summary ${input.id}`,
      outcome: input.observation_type === 'task_completed'
        || input.observation_type === 'work_order_summary'
        || input.observation_type === 'task_artifact_reference'
        ? 'ok'
        : null,
      evidence_refs: observationEvidence,
    }),
    relation_cue: Object.freeze({
      kind: input.cue_kind,
      stance: input.stance ?? 'supplement',
      source_logical_id: 'lw-a',
      target_logical_id: 'lw-b',
      relation_type: input.relation_type ?? 'shares_runtime',
      reason: input.reason ?? `Reason ${input.id}`,
      evidence_refs: cueEvidence,
    }),
  })
}

test('a typed artifact cue creates shares_runtime with evidence and an optimistic revision', () => {
  const state = projectionState()
  const result = new GraphProjector(state, projectorOptions).apply(artifactSignal())

  assert.equal(result.changed_cards, 0)
  assert.equal(result.changed_relations, 1)
  assert.equal(result.evidence_added, 1)
  assert.equal(result.ignored_reason, null)
  const delta = relationDelta(result)
  assert.equal(delta.expected_revision, null)
  assert.deepEqual(delta.relation, {
    source_logical_id: 'lw-a',
    target_logical_id: 'lw-b',
    relation_type: 'shares_runtime',
    confidence: 0.8,
    reason: 'Shared runtime contract',
    evidence_refs: [{source: 'runtime', ref: 'artifact-1', observed_at: 10}],
    first_seen_at: 10,
    last_seen_at: 10,
    status: 'active',
    revision: 0,
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.deltas), true)
  assert.equal(Object.isFrozen(delta.relation), true)
  assert.equal(Object.isFrozen(delta.relation.evidence_refs), true)
  assert.equal(Object.isFrozen(delta.relation.evidence_refs[0]), true)
  assert.deepEqual(state.relations, [])
})

test('an exact projection replay is delta-free and idempotent', () => {
  const signal = artifactSignal()
  const initial = projectionState()
  const first = new GraphProjector(initial, projectorOptions).apply(signal)
  const projected = applyWorkspaceGraphProjectionDeltas(initial, first.deltas)

  const replay = new GraphProjector(projected, projectorOptions).apply(signal)

  assert.equal(replay.ignored_reason, 'PROJECTOR_EXACT_REPLAY')
  assert.deepEqual(replay.deltas, [])
  assert.deepEqual(
    applyWorkspaceGraphProjectionDeltas(projected, first.deltas),
    projected,
  )
})

test('an accepted projection batch remains idempotent after later relation revisions', () => {
  const initial = projectionState()
  const first = new GraphProjector(initial, projectorOptions).apply(artifactSignal())
  const afterFirst = applyWorkspaceGraphProjectionDeltas(initial, first.deltas)
  const later = new GraphProjector(afterFirst, projectorOptions).apply(relationSignal({
    id: 'later-before-old-replay',
    observation_type: 'task_completed',
    source: 'executor',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'task_completion',
    occurred_at: 20,
  }))
  const afterLater = applyWorkspaceGraphProjectionDeltas(afterFirst, later.deltas)

  const replayed = applyWorkspaceGraphProjectionDeltas(afterLater, first.deltas)

  assert.deepEqual(replayed, afterLater)
})

test('an accepted projection record cannot mask a changed relation delta payload', () => {
  const initial = projectionState()
  const first = new GraphProjector(initial, projectorOptions).apply(artifactSignal())
  const afterFirst = applyWorkspaceGraphProjectionDeltas(initial, first.deltas)
  const acceptedRelation = relationDelta(first)
  const acceptedRecord = first.deltas.find(delta => delta.kind === 'record_projection')
  if (acceptedRecord?.kind !== 'record_projection') {
    assert.fail('expected a record_projection delta')
  }
  const changedEvidence: EvidenceRef[] = [{
    source: 'runtime',
    ref: 'changed-replay-evidence',
    observed_at: 10,
  }]
  Object.freeze(changedEvidence)
  const changedRelation = Object.freeze({
    ...acceptedRelation.relation,
    reason: 'masked relation payload',
    evidence_refs: changedEvidence,
  })
  const changedBatch = Object.freeze([
    Object.freeze({...acceptedRelation, relation: changedRelation}),
    acceptedRecord,
  ])

  assert.throws(
    () => applyWorkspaceGraphProjectionDeltas(afterFirst, changedBatch),
    (error: unknown) => (
      error instanceof GraphProjectorError
      && error.code === 'PROJECTOR_EVIDENCE_CONFLICT'
      && !error.message.includes('masked relation payload')
    ),
  )
})

test('an adjacent authoritative workspace transition creates only weak discussed-with metadata', () => {
  const evidence = Object.freeze({
    source: 'runtime' as const,
    ref: 'transition-open-b',
    observed_at: 30,
  })
  const result = new GraphProjector(projectionState(), projectorOptions).apply({
    origin: 'trusted_runtime',
    observation: {
      observation_id: 'transition-open-b',
      observation_type: 'workspace_opened',
      occurred_at: 30,
      source: 'runtime',
      trust: 'trusted_system',
      logical_workspace_id: 'lw-b',
      workspace_instance_id: 'wi-b',
      related_logical_workspace_id: 'lw-a',
      summary: 'confirmed workspace lifecycle',
      outcome: 'ok',
      evidence_refs: [evidence],
    },
    relation_cue: {
      kind: 'workspace_transition',
      stance: 'supplement',
      source_logical_id: 'lw-a',
      target_logical_id: 'lw-b',
      relation_type: 'discussed_with',
      reason: 'adjacent confirmed workspace transition',
      evidence_refs: [evidence],
    },
  })

  const delta = relationDelta(result)
  assert.deepEqual(delta.relation, {
    source_logical_id: 'lw-a',
    target_logical_id: 'lw-b',
    relation_type: 'discussed_with',
    confidence: 0.4,
    reason: 'adjacent confirmed workspace transition',
    evidence_refs: [evidence],
    first_seen_at: 30,
    last_seen_at: 30,
    status: 'weak',
    revision: 0,
  })
  const record = result.deltas.find(candidate => candidate.kind === 'record_projection')
  assert.equal(record?.kind, 'record_projection')
  if (record?.kind === 'record_projection') {
    assert.equal(record.record.cue_kind, 'workspace_transition')
    assert.equal(record.record.authority, 'runtime_inferred')
  }
})

test('workspace transition inference rejects evidence not bound to its lifecycle observation', () => {
  const evidence = Object.freeze({
    source: 'runtime' as const,
    ref: 'unrelated-runtime-record',
    observed_at: 30,
  })
  const result = new GraphProjector(projectionState(), projectorOptions).apply({
    origin: 'trusted_runtime',
    observation: {
      observation_id: 'transition-open-b', observation_type: 'workspace_opened', occurred_at: 30,
      source: 'runtime', trust: 'trusted_system', logical_workspace_id: 'lw-b',
      workspace_instance_id: 'wi-b', related_logical_workspace_id: 'lw-a',
      summary: 'confirmed workspace lifecycle', outcome: 'ok', evidence_refs: [evidence],
    },
    relation_cue: {
      kind: 'workspace_transition', stance: 'supplement', source_logical_id: 'lw-a',
      target_logical_id: 'lw-b', relation_type: 'discussed_with',
      reason: 'adjacent confirmed workspace transition', evidence_refs: [evidence],
    },
  })

  assert.equal(result.ignored_reason, 'PROJECTOR_UNAUTHORIZED_SIGNAL')
  assert.deepEqual(result.deltas, [])
})

test('aging marks an old relation stale without deleting its evidence or card', () => {
  const evidence = Object.freeze({
    source: 'runtime',
    ref: 'old-runtime-evidence',
    observed_at: 0,
  }) satisfies EvidenceRef
  const evidenceRefs: EvidenceRef[] = [evidence]
  Object.freeze(evidenceRefs)
  const relation = Object.freeze({
    source_logical_id: 'lw-a',
    target_logical_id: 'lw-b',
    relation_type: 'shares_runtime',
    confidence: 0.8,
    reason: 'Shared runtime contract',
    evidence_refs: evidenceRefs,
    first_seen_at: 0,
    last_seen_at: 0,
    status: 'active',
    revision: 4,
  }) satisfies RelationCard
  const state = projectionState([relation])

  const result = new GraphProjector(state, projectorOptions).age(90 * DAY_MS)
  const projected = applyWorkspaceGraphProjectionDeltas(state, result.deltas)

  assert.equal(result.changed_relations, 1)
  assert.equal(result.evidence_added, 0)
  assert.equal(projected.relations.length, 1)
  assert.equal(projected.relations[0]?.status, 'stale')
  assert.equal(projected.relations[0]?.revision, 5)
  assert.deepEqual(projected.relations[0]?.evidence_refs, [evidence])
  const delta = relationDelta(result)
  assert.equal(delta.expected_revision, 4)
})

test('the authorized observation source and trust matrix determines relation authority', () => {
  const cases = [
    {
      signal: relationSignal({
        id: 'artifact-executor',
        observation_type: 'task_artifact_reference',
        source: 'executor',
        trust: 'trusted_system',
        origin: 'trusted_runtime',
        cue_kind: 'artifact_reference',
      }),
      confidence: 0.8,
      status: 'active',
    },
    {
      signal: relationSignal({
        id: 'task-completed',
        observation_type: 'task_completed',
        source: 'executor',
        trust: 'trusted_system',
        origin: 'trusted_runtime',
        cue_kind: 'task_completion',
      }),
      confidence: 0.8,
      status: 'active',
    },
    {
      signal: relationSignal({
        id: 'work-order',
        observation_type: 'work_order_summary',
        source: 'executor',
        trust: 'trusted_system',
        origin: 'trusted_runtime',
        cue_kind: 'work_order',
      }),
      confidence: 0.8,
      status: 'active',
    },
    {
      signal: relationSignal({
        id: 'user-confirmed',
        observation_type: 'user_relation_statement',
        source: 'user',
        trust: 'user_confirmed',
        origin: 'user_utterance',
        cue_kind: 'user_statement',
      }),
      confidence: 1,
      status: 'active',
    },
    {
      signal: relationSignal({
        id: 'user-transcript',
        observation_type: 'user_relation_statement',
        source: 'user',
        trust: 'trusted_user',
        origin: 'user_utterance',
        cue_kind: 'user_statement',
      }),
      confidence: 0.35,
      status: 'weak',
    },
    {
      signal: relationSignal({
        id: 'provider',
        observation_type: 'provider_relation_evidence',
        source: 'provider',
        trust: 'untrusted_external',
        origin: 'provider_adapter',
        cue_kind: 'provider_evidence',
      }),
      confidence: 0.2,
      status: 'weak',
    },
    {
      signal: relationSignal({
        id: 'suppression',
        observation_type: 'relation_suppressed',
        source: 'user',
        trust: 'user_confirmed',
        origin: 'user_utterance',
        cue_kind: 'suppression',
        stance: 'suppress',
      }),
      confidence: 0,
      status: 'suppressed',
    },
  ] as const

  for (const entry of cases) {
    const result = new GraphProjector(projectionState(), projectorOptions).apply(entry.signal)
    const delta = relationDelta(result)
    assert.equal(delta.relation.confidence, entry.confidence)
    assert.equal(delta.relation.status, entry.status)
    assert.equal(result.changed_cards, 0, entry.signal.observation.observation_type)
  }
})

test('natural-language relation prose without a typed cue creates no edge', () => {
  const typed = relationSignal({
    id: 'summary-only',
    observation_type: 'user_relation_statement',
    source: 'user',
    trust: 'user_confirmed',
    origin: 'user_utterance',
    cue_kind: 'user_statement',
    reason: 'Workspace A definitely depends on workspace B',
  })
  const summaryOnly = Object.freeze({...typed, relation_cue: null})

  const result = new GraphProjector(projectionState(), projectorOptions).apply(summaryOnly)

  assert.equal(result.ignored_reason, 'PROJECTOR_MISSING_CUE')
  assert.deepEqual(result.deltas, [])
  assert.equal(result.changed_relations, 0)
})

test('relation projection retains bounded user, incoming, and newest remaining evidence', () => {
  const existingEvidence: EvidenceRef[] = [
    Object.freeze({source: 'user', ref: 'evidence-retention-user', observed_at: 1}),
    ...Array.from({length: 47}, (_, index) => Object.freeze({
      source: 'executor' as const,
      ref: `evidence-retention-runtime-${index}`,
      observed_at: index + 2,
    })),
  ]
  Object.freeze(existingEvidence)
  const state = projectionState([Object.freeze({
    source_logical_id: 'lw-a',
    target_logical_id: 'lw-b',
    relation_type: 'shares_runtime',
    confidence: 0.8,
    reason: 'Shared runtime contract',
    evidence_refs: existingEvidence,
    first_seen_at: 1,
    last_seen_at: 48,
    status: 'active',
    revision: 47,
  })])
  const result = new GraphProjector(state, projectorOptions).apply(relationSignal({
    id: 'retention-runtime-incoming',
    observation_type: 'task_completed',
    source: 'executor',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'task_completion',
    occurred_at: 0,
  }))
  const evidence = relationDelta(result).relation.evidence_refs

  assert.equal(evidence.length, 48)
  assert.equal(evidence.some(item => item.ref === 'evidence-retention-user'), true)
  assert.equal(evidence.some(item => item.ref === 'evidence-retention-runtime-incoming'), true)
  assert.equal(evidence.some(item => item.ref === 'evidence-retention-runtime-0'), false)
  assert.deepEqual(
    retainRelationEvidence(
      [{source: 'runtime', ref: 'same-key', observed_at: 1}],
      [{source: 'runtime', ref: 'same-key', observed_at: 2}],
    ),
    [{source: 'runtime', ref: 'same-key', observed_at: 2}],
  )
})

test('self and unknown workspace cues are ignored without a delta', () => {
  const base = relationSignal({
    id: 'known-distinct',
    observation_type: 'task_artifact_reference',
    source: 'runtime',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'artifact_reference',
  })
  if (base.relation_cue === null) assert.fail('expected a relation cue')
  const self = Object.freeze({
    ...base,
    observation: Object.freeze({
      ...base.observation,
      related_logical_workspace_id: 'lw-a',
    }),
    relation_cue: Object.freeze({
      ...base.relation_cue,
      target_logical_id: 'lw-a',
    }),
  })
  const unknown = Object.freeze({
    ...base,
    observation: Object.freeze({
      ...base.observation,
      related_logical_workspace_id: 'lw-missing',
    }),
    relation_cue: Object.freeze({
      ...base.relation_cue,
      target_logical_id: 'lw-missing',
    }),
  })

  const selfResult = new GraphProjector(projectionState(), projectorOptions).apply(self)
  const unknownResult = new GraphProjector(projectionState(), projectorOptions).apply(unknown)

  assert.equal(selfResult.ignored_reason, 'PROJECTOR_SELF_RELATION')
  assert.equal(unknownResult.ignored_reason, 'PROJECTOR_UNKNOWN_WORKSPACE')
  assert.deepEqual(selfResult.deltas, [])
  assert.deepEqual(unknownResult.deltas, [])
})

test('malformed and sensitive signals are rejected before projection-state lookup', () => {
  let stateLookups = 0
  const hostileState = Object.defineProperty({}, 'logical_workspaces', {
    enumerable: true,
    get() {
      stateLookups += 1
      throw new Error('state-must-not-be-read')
    },
  }) as WorkspaceGraphProjectionState
  const sensitive = relationSignal({
    id: 'sensitive',
    observation_type: 'task_artifact_reference',
    source: 'runtime',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'artifact_reference',
  })
  const sensitiveObservation = Object.freeze({
    ...sensitive.observation,
    summary: 'Authorization: Basic private-marker',
  })
  const sensitiveSignal = Object.freeze({...sensitive, observation: sensitiveObservation})
  const projector = new GraphProjector(hostileState, projectorOptions)
  const hostileSignal = Object.defineProperty({}, 'origin', {
    enumerable: true,
    get() {
      throw new Error('hostile-signal-marker')
    },
  })

  const malformedResult = projector.apply({origin: 'trusted_runtime'})
  const sensitiveResult = projector.apply(sensitiveSignal)
  const hostileResult = projector.apply(hostileSignal)

  assert.equal(malformedResult.ignored_reason, 'PROJECTOR_INVALID_SIGNAL')
  assert.equal(sensitiveResult.ignored_reason, 'PROJECTOR_SENSITIVE_INPUT')
  assert.equal(hostileResult.ignored_reason, 'PROJECTOR_INVALID_SIGNAL')
  assert.deepEqual(malformedResult.deltas, [])
  assert.deepEqual(sensitiveResult.deltas, [])
  assert.equal(JSON.stringify(hostileResult).includes('hostile-signal-marker'), false)
  assert.equal(stateLookups, 0)
})

test('a cue must match its observation fields, evidence, source, and trust', () => {
  const base = relationSignal({
    id: 'cue-binding',
    observation_type: 'task_artifact_reference',
    source: 'runtime',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'artifact_reference',
  })
  if (base.relation_cue === null) assert.fail('expected a relation cue')
  const wrongTarget = Object.freeze({
    ...base,
    relation_cue: Object.freeze({...base.relation_cue, target_logical_id: 'lw-unrelated'}),
  })
  const unboundEvidence: EvidenceRef[] = [Object.freeze({
    source: 'runtime',
    ref: 'not-on-observation',
    observed_at: 20,
  })]
  Object.freeze(unboundEvidence)
  const wrongEvidence = Object.freeze({
    ...base,
    relation_cue: Object.freeze({...base.relation_cue, evidence_refs: unboundEvidence}),
  })
  const wrongTrust = Object.freeze({
    ...base,
    observation: Object.freeze({...base.observation, trust: 'untrusted_external' as const}),
  })

  const projector = new GraphProjector(projectionState(), projectorOptions)
  const targetResult = projector.apply(wrongTarget)
  const evidenceResult = projector.apply(wrongEvidence)
  const trustResult = projector.apply(wrongTrust)

  assert.equal(targetResult.ignored_reason, 'PROJECTOR_INVALID_CUE')
  assert.equal(evidenceResult.ignored_reason, 'PROJECTOR_INVALID_CUE')
  assert.equal(trustResult.ignored_reason, 'PROJECTOR_UNAUTHORIZED_SIGNAL')
  assert.deepEqual(targetResult.deltas, [])
  assert.deepEqual(evidenceResult.deltas, [])
  assert.deepEqual(trustResult.deltas, [])
})

test('agent-originated output is never projection input', () => {
  let stateLookups = 0
  const hostileState = Object.defineProperty({}, 'logical_workspaces', {
    enumerable: true,
    get() {
      stateLookups += 1
      throw new Error('agent-output-must-not-read-state')
    },
  }) as WorkspaceGraphProjectionState
  const runtimeSignal = relationSignal({
    id: 'agent-output',
    observation_type: 'task_artifact_reference',
    source: 'runtime',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'artifact_reference',
  })
  const agentSignal = Object.freeze({...runtimeSignal, origin: 'agent_output' as const})

  const result = new GraphProjector(hostileState, projectorOptions).apply(agentSignal)

  assert.equal(result.ignored_reason, 'PROJECTOR_AGENT_ORIGIN')
  assert.deepEqual(result.deltas, [])
  assert.equal(stateLookups, 0)
})

test('supplemental evidence is unioned and refreshes an existing relation', () => {
  const initial = projectionState()
  const first = new GraphProjector(initial, projectorOptions).apply(artifactSignal())
  const existing = applyWorkspaceGraphProjectionDeltas(initial, first.deltas)
  const supplement = relationSignal({
    id: 'supplement',
    observation_type: 'work_order_summary',
    source: 'executor',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'work_order',
    reason: 'The work order also exercised the runtime',
    occurred_at: 20,
  })

  const result = new GraphProjector(existing, projectorOptions).apply(supplement)
  const delta = relationDelta(result)

  assert.equal(delta.expected_revision, 0)
  assert.equal(delta.relation.revision, 1)
  assert.equal(delta.relation.reason, 'Shared runtime contract')
  assert.equal(delta.relation.confidence, 0.8)
  assert.equal(delta.relation.last_seen_at, 20)
  assert.deepEqual(
    delta.relation.evidence_refs.map(evidence => evidence.ref),
    ['artifact-1', 'evidence-supplement'],
  )
  assert.equal(result.evidence_added, 1)
})

test('confirming evidence raises confidence while retaining the existing wording', () => {
  const initial = projectionState()
  const first = new GraphProjector(initial, projectorOptions).apply(artifactSignal())
  const existing = applyWorkspaceGraphProjectionDeltas(initial, first.deltas)
  const confirmation = relationSignal({
    id: 'confirmation',
    observation_type: 'task_completed',
    source: 'executor',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'task_completion',
    stance: 'confirm',
    reason: 'Shared runtime contract',
    occurred_at: 20,
  })

  const result = new GraphProjector(existing, projectorOptions).apply(confirmation)
  const delta = relationDelta(result)

  assert.equal(delta.relation.confidence, 0.85)
  assert.equal(delta.relation.reason, 'Shared runtime contract')
  assert.equal(delta.relation.evidence_refs.length, 2)
})

test('confirmation is an explicit cue and does not depend on reason-string equality', () => {
  const initial = projectionState()
  const first = new GraphProjector(initial, projectorOptions).apply(artifactSignal())
  const existing = applyWorkspaceGraphProjectionDeltas(initial, first.deltas)
  const base = relationSignal({
    id: 'explicit-confirmation',
    observation_type: 'task_completed',
    source: 'executor',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'task_completion',
    reason: 'Different wording must not become merge classification',
    occurred_at: 20,
  })
  if (base.relation_cue === null) assert.fail('expected a relation cue')
  const confirmation = Object.freeze({
    ...base,
    relation_cue: Object.freeze({...base.relation_cue, stance: 'confirm'}),
  })

  const result = new GraphProjector(existing, projectorOptions).apply(confirmation)
  const delta = relationDelta(result)

  assert.equal(delta.relation.confidence, 0.85)
  assert.equal(delta.relation.reason, 'Shared runtime contract')
})

test('conflicting evidence is retained, lowers confidence, and emits bounded metadata', () => {
  const initial = projectionState()
  const first = new GraphProjector(initial, projectorOptions).apply(artifactSignal())
  const existing = applyWorkspaceGraphProjectionDeltas(initial, first.deltas)
  const conflict = relationSignal({
    id: 'conflict',
    observation_type: 'task_completed',
    source: 'executor',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'task_completion',
    stance: 'conflict',
    reason: 'A contradictory runtime attribution',
    occurred_at: 20,
  })

  const result = new GraphProjector(existing, projectorOptions).apply(conflict)
  const delta = relationDelta(result)

  assert.equal(delta.relation.confidence, 0.6)
  assert.equal(delta.relation.status, 'weak')
  assert.equal(delta.relation.reason, 'Shared runtime contract')
  assert.deepEqual(
    delta.relation.evidence_refs.map(evidence => evidence.ref),
    ['artifact-1', 'evidence-conflict'],
  )
  assert.deepEqual(result.conflicts, [{
    code: 'PROJECTOR_RELATION_CONFLICT',
    source_logical_id: 'lw-a',
    target_logical_id: 'lw-b',
    relation_type: 'shares_runtime',
    incoming_authority: 'trusted_system',
    evidence_count: 2,
  }])
  assert.equal(Object.isFrozen(result.conflicts), true)
  assert.equal(Object.isFrozen(result.conflicts[0]), true)
  assert.equal(JSON.stringify(result.conflicts).includes('contradictory'), false)
})

test('a conflict cue cannot create a positive relation from no prior value', () => {
  const conflict = relationSignal({
    id: 'conflict-without-relation',
    observation_type: 'task_completed',
    source: 'executor',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'task_completion',
    stance: 'conflict',
  })

  const result = new GraphProjector(projectionState(), projectorOptions).apply(conflict)

  assert.equal(result.ignored_reason, 'PROJECTOR_CONFLICT_WITHOUT_RELATION')
  assert.deepEqual(result.deltas, [])
  assert.equal(result.changed_relations, 0)
})

test('confirmed user wording replaces automation and survives later automatic conflict', () => {
  const initial = projectionState()
  const automatic = new GraphProjector(initial, projectorOptions).apply(artifactSignal())
  let state = applyWorkspaceGraphProjectionDeltas(initial, automatic.deltas)
  const userStatement = relationSignal({
    id: 'user-wording',
    observation_type: 'user_relation_statement',
    source: 'user',
    trust: 'user_confirmed',
    origin: 'user_utterance',
    cue_kind: 'user_statement',
    reason: 'The desktop is explicitly coupled to this runtime',
    occurred_at: 20,
  })
  const confirmed = new GraphProjector(state, projectorOptions).apply(userStatement)
  state = applyWorkspaceGraphProjectionDeltas(state, confirmed.deltas)

  assert.equal(state.relations[0]?.confidence, 1)
  assert.equal(state.relations[0]?.reason, 'The desktop is explicitly coupled to this runtime')

  const automaticConflict = relationSignal({
    id: 'automatic-after-user',
    observation_type: 'task_completed',
    source: 'executor',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'task_completion',
    stance: 'conflict',
    reason: 'Automatic wording must not replace the user',
    occurred_at: 30,
  })
  const conflicted = new GraphProjector(state, projectorOptions).apply(automaticConflict)
  state = applyWorkspaceGraphProjectionDeltas(state, conflicted.deltas)

  assert.equal(state.relations[0]?.confidence, 0.8)
  assert.equal(state.relations[0]?.reason, 'The desktop is explicitly coupled to this runtime')
  assert.equal(state.relations[0]?.evidence_refs.length, 3)
})

test('provider-only confirmations remain weak and below the proactive threshold', () => {
  let state = projectionState()
  for (let index = 1; index <= 5; index += 1) {
    const signal = relationSignal({
      id: `provider-${index}`,
      observation_type: 'provider_relation_evidence',
      source: 'provider',
      trust: 'untrusted_external',
      origin: 'provider_adapter',
      cue_kind: 'provider_evidence',
      stance: index === 1 ? 'supplement' : 'confirm',
      reason: 'Provider reports a shared runtime',
      occurred_at: index * 10,
    })
    const result = new GraphProjector(state, projectorOptions).apply(signal)
    state = applyWorkspaceGraphProjectionDeltas(state, result.deltas)
  }

  assert.equal(state.relations[0]?.confidence, 0.3)
  assert.ok((state.relations[0]?.confidence ?? 1) < projectorOptions.proactive_confidence_threshold)
  assert.equal(state.relations[0]?.status, 'weak')
  assert.equal(state.relations[0]?.evidence_refs.length, 5)
})

test('provider and transcript-only evidence remain candidates under a low threshold', () => {
  const lowThresholdOptions = Object.freeze({
    ...projectorOptions,
    proactive_confidence_threshold: 0.1,
  })
  const cases = [
    relationSignal({
      id: 'low-threshold-provider',
      observation_type: 'provider_relation_evidence',
      source: 'provider',
      trust: 'untrusted_external',
      origin: 'provider_adapter',
      cue_kind: 'provider_evidence',
    }),
    relationSignal({
      id: 'low-threshold-transcript',
      observation_type: 'user_relation_statement',
      source: 'user',
      trust: 'trusted_user',
      origin: 'user_utterance',
      cue_kind: 'user_statement',
    }),
  ]

  for (const signal of cases) {
    const result = new GraphProjector(projectionState(), lowThresholdOptions).apply(signal)
    assert.equal(relationDelta(result).relation.status, 'weak')
  }
})

test('suppression preserves evidence and blocks automatic reactivation', () => {
  const initial = projectionState()
  const first = new GraphProjector(initial, projectorOptions).apply(artifactSignal())
  let state = applyWorkspaceGraphProjectionDeltas(initial, first.deltas)
  const suppression = relationSignal({
    id: 'suppress',
    observation_type: 'relation_suppressed',
    source: 'user',
    trust: 'user_confirmed',
    origin: 'user_utterance',
    cue_kind: 'suppression',
    stance: 'suppress',
    reason: 'Do not surface this relationship',
    occurred_at: 20,
  })
  const suppressed = new GraphProjector(state, projectorOptions).apply(suppression)
  state = applyWorkspaceGraphProjectionDeltas(state, suppressed.deltas)

  assert.equal(state.relations[0]?.status, 'suppressed')
  assert.equal(state.relations[0]?.reason, 'Do not surface this relationship')
  assert.equal(state.relations[0]?.confidence, 0.8)
  assert.equal(state.relations[0]?.evidence_refs.length, 2)

  const automatic = relationSignal({
    id: 'automatic-after-suppression',
    observation_type: 'task_completed',
    source: 'executor',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'task_completion',
    reason: 'Automatic evidence after suppression',
    occurred_at: 30,
  })
  const blocked = new GraphProjector(state, projectorOptions).apply(automatic)
  state = applyWorkspaceGraphProjectionDeltas(state, blocked.deltas)

  assert.equal(state.relations[0]?.status, 'suppressed')
  assert.equal(state.relations[0]?.reason, 'Do not surface this relationship')
  assert.equal(state.relations[0]?.evidence_refs.length, 3)
})

test('only a newer confirmed user statement reverses suppression', () => {
  const initial = projectionState()
  const suppressedSignal = relationSignal({
    id: 'initial-suppression',
    observation_type: 'relation_suppressed',
    source: 'user',
    trust: 'user_confirmed',
    origin: 'user_utterance',
    cue_kind: 'suppression',
    stance: 'suppress',
    reason: 'Keep this relationship suppressed',
    occurred_at: 20,
  })
  const suppressed = new GraphProjector(initial, projectorOptions).apply(suppressedSignal)
  let state = applyWorkspaceGraphProjectionDeltas(initial, suppressed.deltas)
  const reversal = relationSignal({
    id: 'confirmed-reversal',
    observation_type: 'user_relation_statement',
    source: 'user',
    trust: 'user_confirmed',
    origin: 'user_utterance',
    cue_kind: 'user_statement',
    reason: 'This relationship is useful after all',
    occurred_at: 30,
  })

  const reversed = new GraphProjector(state, projectorOptions).apply(reversal)
  state = applyWorkspaceGraphProjectionDeltas(state, reversed.deltas)

  assert.equal(state.relations[0]?.status, 'active')
  assert.equal(state.relations[0]?.confidence, 1)
  assert.equal(state.relations[0]?.reason, 'This relationship is useful after all')
  assert.equal(state.relations[0]?.evidence_refs.length, 2)
})

test('delayed suppression and reversal evidence cannot overwrite newer user state', () => {
  let state = projectionState()
  const signals = [
    relationSignal({
      id: 'suppression-at-20',
      observation_type: 'relation_suppressed',
      source: 'user',
      trust: 'user_confirmed',
      origin: 'user_utterance',
      cue_kind: 'suppression',
      stance: 'suppress',
      reason: 'Suppressed at twenty',
      occurred_at: 20,
    }),
    relationSignal({
      id: 'reversal-at-40',
      observation_type: 'user_relation_statement',
      source: 'user',
      trust: 'user_confirmed',
      origin: 'user_utterance',
      cue_kind: 'user_statement',
      reason: 'Confirmed relation at forty',
      occurred_at: 40,
    }),
    relationSignal({
      id: 'delayed-suppression-at-30',
      observation_type: 'relation_suppressed',
      source: 'user',
      trust: 'user_confirmed',
      origin: 'user_utterance',
      cue_kind: 'suppression',
      stance: 'suppress',
      reason: 'Delayed suppression must not win',
      occurred_at: 30,
    }),
    relationSignal({
      id: 'suppression-at-50',
      observation_type: 'relation_suppressed',
      source: 'user',
      trust: 'user_confirmed',
      origin: 'user_utterance',
      cue_kind: 'suppression',
      stance: 'suppress',
      reason: 'Current suppression at fifty',
      occurred_at: 50,
    }),
    relationSignal({
      id: 'delayed-reversal-at-45',
      observation_type: 'user_relation_statement',
      source: 'user',
      trust: 'user_confirmed',
      origin: 'user_utterance',
      cue_kind: 'user_statement',
      reason: 'Delayed reversal must not win',
      occurred_at: 45,
    }),
  ]

  for (const signal of signals) {
    const result = new GraphProjector(state, projectorOptions).apply(signal)
    state = applyWorkspaceGraphProjectionDeltas(state, result.deltas)
  }

  assert.equal(state.relations[0]?.status, 'suppressed')
  assert.equal(state.relations[0]?.reason, 'Current suppression at fifty')
  assert.equal(state.relations[0]?.last_seen_at, 50)
  assert.equal(state.relations[0]?.evidence_refs.length, 5)
  assert.equal(state.projection_records.length, 5)
})

test('equal-time suppression and confirmed wording converge regardless of arrival order', () => {
  const suppression = relationSignal({
    id: 'equal-time-suppression',
    observation_type: 'relation_suppressed',
    source: 'user',
    trust: 'user_confirmed',
    origin: 'user_utterance',
    cue_kind: 'suppression',
    stance: 'suppress',
    reason: 'Equal-time suppression wins',
    occurred_at: 50,
  })
  const reversal = relationSignal({
    id: 'equal-time-reversal',
    observation_type: 'user_relation_statement',
    source: 'user',
    trust: 'user_confirmed',
    origin: 'user_utterance',
    cue_kind: 'user_statement',
    reason: 'Equal-time reversal must not win',
    occurred_at: 50,
  })
  const wordingA = relationSignal({
    id: 'equal-time-wording-a',
    observation_type: 'user_relation_statement',
    source: 'user',
    trust: 'user_confirmed',
    origin: 'user_utterance',
    cue_kind: 'user_statement',
    reason: 'Confirmed wording A',
    occurred_at: 60,
  })
  const wordingB = relationSignal({
    id: 'equal-time-wording-b',
    observation_type: 'user_relation_statement',
    source: 'user',
    trust: 'user_confirmed',
    origin: 'user_utterance',
    cue_kind: 'user_statement',
    reason: 'Confirmed wording B',
    occurred_at: 60,
  })
  const project = (signals: readonly ProjectionSignal[]) => {
    let state = projectionState()
    for (const signal of signals) {
      const result = new GraphProjector(state, projectorOptions).apply(signal)
      state = applyWorkspaceGraphProjectionDeltas(state, result.deltas)
    }
    return state
  }

  const suppressionFirst = project([suppression, reversal])
  const reversalFirst = project([reversal, suppression])
  const wordingAFirst = project([wordingA, wordingB])
  const wordingBFirst = project([wordingB, wordingA])

  assert.deepEqual(suppressionFirst.relations, reversalFirst.relations)
  assert.deepEqual(
    suppressionFirst.projection_records.map(record => record.record_id),
    reversalFirst.projection_records.map(record => record.record_id),
  )
  assert.equal(suppressionFirst.relations[0]?.status, 'suppressed')
  assert.equal(suppressionFirst.relations[0]?.reason, 'Equal-time suppression wins')
  assert.deepEqual(wordingAFirst.relations, wordingBFirst.relations)
  assert.deepEqual(
    wordingAFirst.projection_records.map(record => record.record_id),
    wordingBFirst.projection_records.map(record => record.record_id),
  )
})

test('reusing an evidence key with changed projection payload is rejected safely', () => {
  const initial = projectionState()
  const original = artifactSignal()
  const first = new GraphProjector(initial, projectorOptions).apply(original)
  const state = applyWorkspaceGraphProjectionDeltas(initial, first.deltas)
  if (original.relation_cue === null) assert.fail('expected a relation cue')
  const changed = Object.freeze({
    ...original,
    observation: Object.freeze({
      ...original.observation,
      observation_id: 'observation-artifact-reused',
      summary: 'changed-payload-marker',
    }),
    relation_cue: Object.freeze({
      ...original.relation_cue,
      reason: 'changed-payload-marker',
    }),
  })

  let error: unknown
  try {
    new GraphProjector(state, projectorOptions).apply(changed)
  } catch (caught) {
    error = caught
  }

  assert.ok(error instanceof GraphProjectorError)
  assert.equal(error.code, 'PROJECTOR_EVIDENCE_CONFLICT')
  assert.equal(error.message.includes('changed-payload-marker'), false)
  assert.equal(state.relations[0]?.reason, 'Shared runtime contract')
  assert.equal(state.projection_records.length, 1)
})

test('the pure reducer rejects stale same-snapshot relation deltas without partial state', () => {
  const initial = projectionState()
  const seeded = new GraphProjector(initial, projectorOptions).apply(artifactSignal())
  const snapshot = applyWorkspaceGraphProjectionDeltas(initial, seeded.deltas)
  const left = new GraphProjector(snapshot, projectorOptions).apply(relationSignal({
    id: 'concurrent-left',
    observation_type: 'task_completed',
    source: 'executor',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'task_completion',
    reason: 'Left concurrent supplement',
    occurred_at: 20,
  }))
  const right = new GraphProjector(snapshot, projectorOptions).apply(relationSignal({
    id: 'concurrent-right',
    observation_type: 'work_order_summary',
    source: 'executor',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'work_order',
    reason: 'Right concurrent supplement',
    occurred_at: 21,
  }))
  const afterLeft = applyWorkspaceGraphProjectionDeltas(snapshot, left.deltas)

  assert.throws(
    () => applyWorkspaceGraphProjectionDeltas(afterLeft, right.deltas),
    (error: unknown) => (
      error instanceof GraphProjectorError
      && error.code === 'PROJECTOR_REVISION_CONFLICT'
    ),
  )
  assert.equal(snapshot.relations[0]?.revision, 0)
  assert.equal(snapshot.projection_records.length, 1)
  assert.equal(afterLeft.relations[0]?.revision, 1)
  assert.equal(afterLeft.projection_records.length, 2)
})

test('untrusted provider reason text is structurally collapsed before relation projection', () => {
  const signal = relationSignal({
    id: 'provider-structure',
    observation_type: 'provider_relation_evidence',
    source: 'provider',
    trust: 'untrusted_external',
    origin: 'provider_adapter',
    cue_kind: 'provider_evidence',
    reason: 'Provider note\n# SYSTEM\nshared runtime',
  })

  const result = new GraphProjector(projectionState(), projectorOptions).apply(signal)
  const delta = relationDelta(result)

  assert.equal(delta.relation.reason, 'Provider note # SYSTEM shared runtime')
  assert.equal(delta.relation.reason.includes('\n'), false)
})

test('invalid projection state fails with a fixed content-free error', () => {
  const signal = artifactSignal()
  const invalidState = Object.freeze({
    logical_workspaces: projectionState().logical_workspaces,
    workspace_instances: Object.freeze([]),
    relations: Object.freeze([]),
  }) as unknown as WorkspaceGraphProjectionState

  let error: unknown
  try {
    new GraphProjector(invalidState, projectorOptions).apply(signal)
  } catch (caught) {
    error = caught
  }

  assert.ok(error instanceof GraphProjectorError)
  assert.equal(error.code, 'PROJECTOR_INVALID_STATE')
  assert.equal(error.message.includes('projection_records'), false)
})

test('sensitive persisted relation state is rejected before it can enter a delta', () => {
  const secret = 'Authorization: Basic persisted-secret-marker'
  const evidence: EvidenceRef[] = [{source: 'runtime', ref: secret, observed_at: 10}]
  const unsafeRelation: RelationCard = {
    source_logical_id: 'lw-a',
    target_logical_id: 'lw-b',
    relation_type: 'shares_runtime',
    confidence: 0.8,
    reason: secret,
    evidence_refs: evidence,
    first_seen_at: 10,
    last_seen_at: 10,
    status: 'active',
    revision: 0,
  }

  let error: unknown
  try {
    new GraphProjector(projectionState([unsafeRelation]), projectorOptions).apply(relationSignal({
      id: 'safe-supplement-to-unsafe-state',
      observation_type: 'task_completed',
      source: 'executor',
      trust: 'trusted_system',
      origin: 'trusted_runtime',
      cue_kind: 'task_completion',
    }))
  } catch (caught) {
    error = caught
  }

  assert.ok(error instanceof GraphProjectorError)
  assert.equal(error.code, 'PROJECTOR_INVALID_STATE')
  assert.equal(error.message.includes(secret), false)
})

test('projection and reduction never mutate or freeze caller-owned state', () => {
  const left: LogicalWorkspace = {
    logical_workspace_id: 'lw-a',
    display_name: 'Mutable A',
    aliases: [],
    canonical_remote: null,
    created_at: 0,
    updated_at: 0,
    revision: 0,
  }
  const right: LogicalWorkspace = {
    logical_workspace_id: 'lw-b',
    display_name: 'Mutable B',
    aliases: [],
    canonical_remote: null,
    created_at: 0,
    updated_at: 0,
    revision: 0,
  }
  const mutableState: WorkspaceGraphProjectionState = {
    logical_workspaces: [left, right],
    workspace_instances: [],
    relations: [],
    projection_records: [],
  }

  const result = new GraphProjector(mutableState, projectorOptions).apply(artifactSignal())
  const reduced = applyWorkspaceGraphProjectionDeltas(mutableState, result.deltas)

  assert.deepEqual(mutableState.relations, [])
  assert.deepEqual(mutableState.projection_records, [])
  assert.equal(Object.isFrozen(mutableState), false)
  assert.equal(Object.isFrozen(left), false)
  assert.equal(Object.isFrozen(left.aliases), false)
  assert.equal(Object.isFrozen(reduced), true)
  assert.equal(Object.isFrozen(reduced.logical_workspaces), true)
  assert.equal(Object.isFrozen(reduced.logical_workspaces[0]), true)
  assert.equal(Object.isFrozen(reduced.logical_workspaces[0]?.aliases), true)
  assert.equal(Object.isFrozen(reduced.relations[0]?.evidence_refs[0]), true)
  assert.notEqual(reduced.logical_workspaces[0], left)
})

test('workspace lifecycle and basename prose stay in Task 3 without card or relation deltas', () => {
  const cases = [
    {observation_type: 'workspace_opened', source: 'runtime'},
    {observation_type: 'instance_observed', source: 'git'},
  ] as const

  for (const [index, entry] of cases.entries()) {
    const evidence: EvidenceRef[] = [{
      source: entry.source,
      ref: `lifecycle-${index}`,
      observed_at: 10,
    }]
    const signal: ProjectionSignal = {
      origin: 'trusted_runtime',
      observation: {
        observation_id: `lifecycle-observation-${index}`,
        observation_type: entry.observation_type,
        occurred_at: 10,
        source: entry.source,
        trust: 'trusted_system',
        logical_workspace_id: 'lw-a',
        workspace_instance_id: null,
        related_logical_workspace_id: null,
        summary: 'The checkout basename resembles lw-b',
        outcome: null,
        evidence_refs: evidence,
      },
      relation_cue: null,
    }

    const result = new GraphProjector(projectionState(), projectorOptions).apply(signal)
    assert.equal(result.ignored_reason, 'PROJECTOR_IDENTITY_LIFECYCLE_ONLY')
    assert.equal(result.changed_cards, 0)
    assert.equal(result.changed_relations, 0)
    assert.deepEqual(result.deltas, [])
  }
})

test('delayed historical evidence cannot reactivate a stale relation', () => {
  const existingEvidence: EvidenceRef[] = [{
    source: 'runtime',
    ref: 'freshest-known',
    observed_at: 10,
  }]
  const stale: RelationCard = {
    source_logical_id: 'lw-a',
    target_logical_id: 'lw-b',
    relation_type: 'shares_runtime',
    confidence: 0.8,
    reason: 'Existing relation wording',
    evidence_refs: existingEvidence,
    first_seen_at: 10,
    last_seen_at: 10,
    status: 'stale',
    revision: 3,
  }
  const delayed = relationSignal({
    id: 'delayed-historical',
    observation_type: 'task_completed',
    source: 'executor',
    trust: 'trusted_system',
    origin: 'trusted_runtime',
    cue_kind: 'task_completion',
    reason: 'Delayed historical supplement',
    occurred_at: 5,
  })

  const result = new GraphProjector(projectionState([stale]), projectorOptions).apply(delayed)
  const delta = relationDelta(result)

  assert.equal(delta.relation.status, 'stale')
  assert.equal(delta.relation.last_seen_at, 10)
  assert.equal(delta.relation.reason, 'Existing relation wording')
  assert.equal(delta.relation.evidence_refs.length, 2)
})
