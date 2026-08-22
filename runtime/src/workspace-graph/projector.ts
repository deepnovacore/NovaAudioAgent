import {createHash} from 'node:crypto'

import {z} from 'zod'

import {canonicalJson, compareCodePoints} from '../canonical-json.js'
import {collapsePythonWhitespace, isWellFormed, stripLikePython} from '../python-text.js'
import {normalizeNfkcPinned} from '../unicode-normalize.js'
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
import {SensitiveContentPolicy, SensitivePathPolicy} from './sensitivity.js'

export type ProjectionOrigin =
  | 'trusted_runtime'
  | 'user_utterance'
  | 'provider_adapter'
  | 'agent_output'

export type RelationCueKind =
  | 'artifact_reference'
  | 'task_completion'
  | 'work_order'
  | 'user_statement'
  | 'provider_evidence'
  | 'suppression'

export type ProjectionStance = 'confirm' | 'supplement' | 'conflict' | 'suppress'

export interface RelationProjectionCue {
  readonly kind: RelationCueKind
  readonly stance: ProjectionStance
  readonly source_logical_id: string
  readonly target_logical_id: string
  readonly relation_type: RelationCard['relation_type']
  readonly reason: string
  readonly evidence_refs: readonly EvidenceRef[]
}

export interface ProjectionSignal {
  readonly origin: ProjectionOrigin
  readonly observation: Observation
  readonly relation_cue: RelationProjectionCue | null
}

const projectionReasonSchema = z.string().min(1).max(239).regex(/\S/u)

const relationProjectionCueSchema = z.object({
  kind: z.enum([
    'artifact_reference',
    'task_completion',
    'work_order',
    'user_statement',
    'provider_evidence',
    'suppression',
  ]),
  stance: z.enum(['confirm', 'supplement', 'conflict', 'suppress']),
  source_logical_id: z.string().min(1).regex(/\S/u),
  target_logical_id: z.string().min(1).regex(/\S/u),
  relation_type: relationTypeSchema,
  reason: projectionReasonSchema,
  evidence_refs: z.array(EvidenceRefSchema).min(1),
}).strict()

export const ProjectionSignalSchema: z.ZodType<ProjectionSignal> = z.object({
  origin: z.enum(['trusted_runtime', 'user_utterance', 'provider_adapter', 'agent_output']),
  observation: ObservationSchema,
  relation_cue: relationProjectionCueSchema.nullable(),
}).strict()

export type ProjectionAuthority =
  | 'provider'
  | 'user_transcript'
  | 'trusted_system'
  | 'user_confirmed'

export interface ProjectionRecord {
  readonly record_id: string
  readonly relation_delta_digest: string
  readonly observation_source: Observation['source']
  readonly observation_id: string
  readonly signal_digest: string
  readonly source_logical_id: string
  readonly target_logical_id: string
  readonly relation_type: RelationCard['relation_type']
  readonly cue_kind: RelationCueKind
  readonly stance: ProjectionStance
  readonly authority: ProjectionAuthority
  readonly occurred_at: number
  readonly evidence_refs: readonly EvidenceRef[]
}

const projectionRecordSchema: z.ZodType<ProjectionRecord> = z.object({
  record_id: z.string().min(1),
  relation_delta_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  observation_source: z.enum(['runtime', 'filesystem', 'git', 'executor', 'user', 'provider']),
  observation_id: z.string().min(1),
  signal_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  source_logical_id: z.string().min(1),
  target_logical_id: z.string().min(1),
  relation_type: relationTypeSchema,
  cue_kind: z.enum([
    'artifact_reference',
    'task_completion',
    'work_order',
    'user_statement',
    'provider_evidence',
    'suppression',
  ]),
  stance: z.enum(['confirm', 'supplement', 'conflict', 'suppress']),
  authority: z.enum(['provider', 'user_transcript', 'trusted_system', 'user_confirmed']),
  occurred_at: z.number().finite().nonnegative(),
  evidence_refs: z.array(EvidenceRefSchema).min(1),
}).strict()

export interface WorkspaceGraphProjectionState {
  readonly logical_workspaces: readonly LogicalWorkspace[]
  readonly workspace_instances: readonly WorkspaceInstance[]
  readonly relations: readonly RelationCard[]
  readonly projection_records: readonly ProjectionRecord[]
}

export type WorkspaceGraphProjectionDelta =
  | Readonly<{
    kind: 'upsert_relation'
    relation: RelationCard
    expected_revision: number | null
  }>
  | Readonly<{
    kind: 'record_projection'
    record: ProjectionRecord
  }>

export type ProjectionIgnoredReason =
  | 'PROJECTOR_AGENT_ORIGIN'
  | 'PROJECTOR_CONFLICT_WITHOUT_RELATION'
  | 'PROJECTOR_EXACT_REPLAY'
  | 'PROJECTOR_IDENTITY_LIFECYCLE_ONLY'
  | 'PROJECTOR_INVALID_CUE'
  | 'PROJECTOR_INVALID_SIGNAL'
  | 'PROJECTOR_MISSING_CUE'
  | 'PROJECTOR_NO_CHANGE'
  | 'PROJECTOR_SELF_RELATION'
  | 'PROJECTOR_SENSITIVE_INPUT'
  | 'PROJECTOR_UNAUTHORIZED_SIGNAL'
  | 'PROJECTOR_UNKNOWN_WORKSPACE'

export interface ProjectionConflict {
  readonly code: 'PROJECTOR_RELATION_CONFLICT'
  readonly source_logical_id: string
  readonly target_logical_id: string
  readonly relation_type: RelationCard['relation_type']
  readonly incoming_authority: ProjectionAuthority
  readonly evidence_count: number
}

export interface ProjectionResult {
  readonly deltas: readonly WorkspaceGraphProjectionDelta[]
  readonly changed_cards: number
  readonly changed_relations: number
  readonly recorded_signals: number
  readonly evidence_added: number
  readonly ignored_reason: ProjectionIgnoredReason | null
  readonly conflicts: readonly ProjectionConflict[]
}

export interface GraphProjectorOptions {
  readonly stale_after_ms: number
  readonly proactive_confidence_threshold: number
  readonly path_policy?: SensitivePathPolicy
  readonly content_policy?: SensitiveContentPolicy
}

export type GraphProjectorErrorCode =
  | 'PROJECTOR_EVIDENCE_CONFLICT'
  | 'PROJECTOR_INVALID_CONFIGURATION'
  | 'PROJECTOR_INVALID_STATE'
  | 'PROJECTOR_REVISION_CONFLICT'

const projectorErrorMessages: Readonly<Record<GraphProjectorErrorCode, string>> = {
  PROJECTOR_EVIDENCE_CONFLICT: 'workspace graph projection evidence conflicts with prior evidence',
  PROJECTOR_INVALID_CONFIGURATION: 'workspace graph projector configuration is invalid',
  PROJECTOR_INVALID_STATE: 'workspace graph projection state is invalid',
  PROJECTOR_REVISION_CONFLICT: 'workspace graph projection revision conflicts with current state',
}

export class GraphProjectorError extends Error {
  readonly code: GraphProjectorErrorCode

  constructor(code: GraphProjectorErrorCode) {
    super(projectorErrorMessages[code])
    this.name = 'GraphProjectorError'
    this.code = code
  }
}

const emptyDeltas = Object.freeze([]) as readonly WorkspaceGraphProjectionDelta[]
const emptyConflicts = Object.freeze([]) as readonly ProjectionConflict[]

export class GraphProjector {
  readonly #state: WorkspaceGraphProjectionState
  readonly #staleAfterMs: number
  readonly #proactiveConfidenceThreshold: number
  readonly #pathPolicy: SensitivePathPolicy
  readonly #contentPolicy: SensitiveContentPolicy

  constructor(state: WorkspaceGraphProjectionState, options: GraphProjectorOptions) {
    if (
      !Number.isFinite(options.stale_after_ms)
      || options.stale_after_ms <= 0
      || !Number.isFinite(options.proactive_confidence_threshold)
      || options.proactive_confidence_threshold <= 0
      || options.proactive_confidence_threshold > 1
    ) {
      throw new GraphProjectorError('PROJECTOR_INVALID_CONFIGURATION')
    }
    this.#state = state
    this.#staleAfterMs = options.stale_after_ms
    this.#proactiveConfidenceThreshold = options.proactive_confidence_threshold
    this.#pathPolicy = options.path_policy ?? new SensitivePathPolicy()
    this.#contentPolicy = options.content_policy ?? new SensitiveContentPolicy()
  }

  apply(signalValue: unknown): ProjectionResult {
    const signal = readProjectionSignal(signalValue)
    if (signal === undefined) return ignoredResult('PROJECTOR_INVALID_SIGNAL')
    if (!signalIsSafe(signal, this.#pathPolicy, this.#contentPolicy)) {
      return ignoredResult('PROJECTOR_SENSITIVE_INPUT')
    }
    if (signal.origin === 'agent_output') {
      return ignoredResult('PROJECTOR_AGENT_ORIGIN')
    }
    const cue = signal.relation_cue
    if (
      signal.observation.observation_type === 'workspace_opened'
      || signal.observation.observation_type === 'instance_observed'
    ) {
      const sourceAllowed = signal.observation.observation_type === 'workspace_opened'
        ? signal.observation.source === 'runtime'
        : signal.observation.source === 'runtime'
          || signal.observation.source === 'filesystem'
          || signal.observation.source === 'git'
      return cue === null
        && signal.origin === 'trusted_runtime'
        && signal.observation.trust === 'trusted_system'
        && sourceAllowed
        ? ignoredResult('PROJECTOR_IDENTITY_LIFECYCLE_ONLY')
        : ignoredResult('PROJECTOR_UNAUTHORIZED_SIGNAL')
    }
    if (cue === null) return ignoredResult('PROJECTOR_MISSING_CUE')
    const normalizedReason = normalizedProjectionReason(cue.reason)
    if (!projectionReasonSchema.safeParse(normalizedReason).success) {
      return ignoredResult('PROJECTOR_INVALID_CUE')
    }
    if (!cueMatchesObservation(cue, signal.observation)) {
      return ignoredResult('PROJECTOR_INVALID_CUE')
    }
    const authority = projectionAuthority(signal)
    if (authority === undefined) {
      return ignoredResult('PROJECTOR_UNAUTHORIZED_SIGNAL')
    }
    if (cue.source_logical_id === cue.target_logical_id) {
      return ignoredResult('PROJECTOR_SELF_RELATION')
    }
    const state = readProjectionState(this.#state, this.#pathPolicy, this.#contentPolicy)
    const knownLogicalIds = new Set(state.logical_workspaces.map(workspace => (
      workspace.logical_workspace_id
    )))
    if (
      !knownLogicalIds.has(cue.source_logical_id)
      || !knownLogicalIds.has(cue.target_logical_id)
    ) {
      return ignoredResult('PROJECTOR_UNKNOWN_WORKSPACE')
    }

    const digest = projectionDigest(signal)
    const recordId = `projection-${digest}`
    const replay = state.projection_records.find(record => (
      record.observation_source === signal.observation.source
      && record.observation_id === signal.observation.observation_id
    ))
    if (replay !== undefined) {
      if (replay.signal_digest !== digest) {
        throw new GraphProjectorError('PROJECTOR_EVIDENCE_CONFLICT')
      }
      return ignoredResult('PROJECTOR_EXACT_REPLAY')
    }
    const evidenceWasUsed = state.projection_records.some(record => (
      record.evidence_refs.some(existing => (
        cue.evidence_refs.some(incoming => sameEvidenceKey(existing, incoming))
      ))
    )) || state.relations.some(relation => (
      relation.evidence_refs.some(existing => (
        cue.evidence_refs.some(incoming => sameEvidenceKey(existing, incoming))
      ))
    ))
    if (evidenceWasUsed) {
      throw new GraphProjectorError('PROJECTOR_EVIDENCE_CONFLICT')
    }

    const current = state.relations.find(relation => (
      relationKey(relation) === relationKey(cue)
    ))
    if (current === undefined && cue.stance === 'conflict') {
      return ignoredResult('PROJECTOR_CONFLICT_WITHOUT_RELATION')
    }
    const incomingConfidence = cue.stance === 'suppress' ? 0 : authorityConfidence(authority)
    const mergedEvidence = current === undefined
      ? sortedEvidence(cue.evidence_refs)
      : unionEvidence(current.evidence_refs, cue.evidence_refs)
    const confidence = current === undefined
      ? incomingConfidence
      : cue.stance === 'conflict'
        ? roundConfidence(Math.max(0, current.confidence - 0.2))
        : cue.stance === 'confirm'
        ? confirmingConfidence(current.confidence, incomingConfidence, authority)
          : Math.max(current.confidence, incomingConfidence)
    const latestConfirmedUser = latestRecord(
      state.projection_records,
      cue,
      record => record.authority === 'user_confirmed' && record.stance !== 'suppress',
    )
    const latestSuppression = latestRecord(
      state.projection_records,
      cue,
      record => record.stance === 'suppress',
    )
    const hasAuthoritativeEvidence = current !== undefined && current.confidence > 0.49
      || state.projection_records.some(record => (
        relationKey(record) === relationKey(cue)
        && (record.authority === 'trusted_system' || record.authority === 'user_confirmed')
        && record.stance !== 'suppress'
      ))
    const candidateOnly = (
      authority === 'provider' || authority === 'user_transcript'
    ) && !hasAuthoritativeEvidence
    const incomingOrder = {
      occurred_at: signal.observation.occurred_at,
      record_id: recordId,
      stance: cue.stance,
    } satisfies ProjectionOrder
    const afterLatestConfirmed = latestConfirmedUser === undefined
      || compareProjectionOrder(incomingOrder, latestConfirmedUser) > 0
    const afterLatestSuppression = latestSuppression !== undefined
      ? compareProjectionOrder(incomingOrder, latestSuppression) > 0
      : current?.status !== 'suppressed'
        || signal.observation.occurred_at > current.last_seen_at
    const effectiveSuppression = cue.stance === 'suppress'
      && afterLatestConfirmed
      && afterLatestSuppression
    const effectiveReversal = current?.status === 'suppressed'
      && authority === 'user_confirmed'
      && cue.stance !== 'suppress'
      && afterLatestSuppression
    const refreshesRelation = current === undefined
      || signal.observation.occurred_at > current.last_seen_at
    const reason = current === undefined
      ? normalizedReason
      : effectiveSuppression
        ? normalizedReason
        : authority === 'user_confirmed'
        && cue.stance !== 'suppress'
        && afterLatestConfirmed
        && (current.status !== 'suppressed' || effectiveReversal)
          ? normalizedReason
          : current.reason
    const mergedStatus = effectiveSuppression
      ? 'suppressed'
      : current?.status === 'suppressed' && !effectiveReversal
        ? 'suppressed'
        : current?.status === 'stale' && !refreshesRelation
          ? 'stale'
        : candidateOnly
          ? 'weak'
        : confidence >= this.#proactiveConfidenceThreshold
          ? 'active'
          : 'weak'
    const relation = freezeRelation(current === undefined ? {
      source_logical_id: cue.source_logical_id,
      target_logical_id: cue.target_logical_id,
      relation_type: cue.relation_type,
      confidence,
      reason,
      evidence_refs: mergedEvidence,
      first_seen_at: signal.observation.occurred_at,
      last_seen_at: signal.observation.occurred_at,
      status: cue.stance === 'suppress' ? 'suppressed' : mergedStatus,
      revision: 0,
    } : {
      ...current,
      confidence,
      reason,
      evidence_refs: mergedEvidence,
      last_seen_at: Math.max(current.last_seen_at, signal.observation.occurred_at),
      status: mergedStatus,
      revision: current.revision + 1,
    })
    const relationDelta = Object.freeze({
      kind: 'upsert_relation' as const,
      relation,
      expected_revision: current?.revision ?? null,
    })
    const record = freezeProjectionRecord({
      record_id: recordId,
      relation_delta_digest: relationDeltaDigest(relationDelta),
      observation_source: signal.observation.source,
      observation_id: signal.observation.observation_id,
      signal_digest: digest,
      source_logical_id: cue.source_logical_id,
      target_logical_id: cue.target_logical_id,
      relation_type: cue.relation_type,
      cue_kind: cue.kind,
      stance: cue.stance,
      authority,
      occurred_at: signal.observation.occurred_at,
      evidence_refs: sortedEvidence(cue.evidence_refs),
    })
    const deltas = Object.freeze([
      relationDelta,
      Object.freeze({kind: 'record_projection' as const, record}),
    ])
    const conflicts = cue.stance === 'conflict' && current !== undefined
      ? Object.freeze([Object.freeze({
        code: 'PROJECTOR_RELATION_CONFLICT' as const,
        source_logical_id: cue.source_logical_id,
        target_logical_id: cue.target_logical_id,
        relation_type: cue.relation_type,
        incoming_authority: authority,
        evidence_count: relation.evidence_refs.length,
      })])
      : emptyConflicts
    return freezeResult({
      deltas,
      changed_cards: 0,
      changed_relations: 1,
      recorded_signals: 1,
      evidence_added: relation.evidence_refs.length - (current?.evidence_refs.length ?? 0),
      ignored_reason: null,
      conflicts,
    })
  }

  age(now: number): ProjectionResult {
    if (!Number.isFinite(now) || now < 0) {
      return ignoredResult('PROJECTOR_INVALID_SIGNAL')
    }
    const state = readProjectionState(this.#state, this.#pathPolicy, this.#contentPolicy)
    const deltas = state.relations
      .filter(relation => (
        (relation.status === 'active' || relation.status === 'weak')
        && now - relation.last_seen_at >= this.#staleAfterMs
      ))
      .map(relation => Object.freeze({
        kind: 'upsert_relation' as const,
        relation: freezeRelation({
          ...relation,
          status: 'stale',
          revision: relation.revision + 1,
        }),
        expected_revision: relation.revision,
      }))
    if (deltas.length === 0) return ignoredResult('PROJECTOR_NO_CHANGE')
    return freezeResult({
      deltas: Object.freeze(deltas),
      changed_cards: 0,
      changed_relations: deltas.length,
      recorded_signals: 0,
      evidence_added: 0,
      ignored_reason: null,
      conflicts: emptyConflicts,
    })
  }
}

function readProjectionSignal(value: unknown): ProjectionSignal | undefined {
  try {
    const parsed = ProjectionSignalSchema.safeParse(value)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export function applyWorkspaceGraphProjectionDeltas(
  state: WorkspaceGraphProjectionState,
  deltas: readonly WorkspaceGraphProjectionDelta[],
): WorkspaceGraphProjectionState {
  const safeState = readProjectionState(state)
  const relations = new Map(safeState.relations.map(relation => [relationKey(relation), relation] as const))
  const records = new Map(safeState.projection_records.map(record => [record.record_id, record] as const))
  if (isExactAcceptedBatchReplay(safeState.projection_records, deltas)) {
    return freezeProjectionState(safeState)
  }

  for (const delta of deltas) {
    if (delta.kind === 'upsert_relation') {
      const key = relationKey(delta.relation)
      const current = relations.get(key)
      if (current !== undefined && sameValue(current, delta.relation)) continue
      const validInsert = current === undefined
        && delta.expected_revision === null
        && delta.relation.revision === 0
      const validUpdate = delta.expected_revision !== null
        && current?.revision === delta.expected_revision
        && delta.relation.revision === delta.expected_revision + 1
      if (!validInsert && !validUpdate) {
        throw new GraphProjectorError('PROJECTOR_REVISION_CONFLICT')
      }
      relations.set(key, delta.relation)
      continue
    }

    const byId = records.get(delta.record.record_id)
    const bySignal = [...records.values()].find(record => (
      record.observation_source === delta.record.observation_source
      && record.observation_id === delta.record.observation_id
    ))
    const evidenceConflict = [...records.values()].some(record => (
      record.record_id !== delta.record.record_id
      && record.evidence_refs.some(existing => (
        delta.record.evidence_refs.some(incoming => sameEvidenceKey(existing, incoming))
      ))
    ))
    if (
      (byId !== undefined && !sameValue(byId, delta.record))
      || (bySignal !== undefined && !sameValue(bySignal, delta.record))
      || evidenceConflict
    ) {
      throw new GraphProjectorError('PROJECTOR_EVIDENCE_CONFLICT')
    }
    if (byId === undefined && bySignal === undefined) {
      records.set(delta.record.record_id, delta.record)
    }
  }

  return freezeProjectionState({
    logical_workspaces: safeState.logical_workspaces,
    workspace_instances: safeState.workspace_instances,
    relations: [...relations.values()].sort(compareRelations),
    projection_records: [...records.values()].sort(compareProjectionRecords),
  })
}

function isExactAcceptedBatchReplay(
  records: readonly ProjectionRecord[],
  deltas: readonly WorkspaceGraphProjectionDelta[],
): boolean {
  if (deltas.length !== 2) return false
  const relationDelta = deltas.find(delta => delta.kind === 'upsert_relation')
  const recordDelta = deltas.find(delta => delta.kind === 'record_projection')
  if (
    relationDelta?.kind !== 'upsert_relation'
    || recordDelta?.kind !== 'record_projection'
  ) return false
  if (
    relationKey(relationDelta.relation) !== relationKey(recordDelta.record)
    || relationDeltaDigest(relationDelta) !== recordDelta.record.relation_delta_digest
  ) {
    throw new GraphProjectorError('PROJECTOR_EVIDENCE_CONFLICT')
  }
  const byId = records.find(record => record.record_id === recordDelta.record.record_id)
  const bySignal = records.find(record => (
    record.observation_source === recordDelta.record.observation_source
    && record.observation_id === recordDelta.record.observation_id
  ))
  if (byId === undefined && bySignal === undefined) return false
  if (
    (byId !== undefined && !sameValue(byId, recordDelta.record))
    || (bySignal !== undefined && !sameValue(bySignal, recordDelta.record))
  ) {
    throw new GraphProjectorError('PROJECTOR_EVIDENCE_CONFLICT')
  }
  return true
}

function ignoredResult(ignoredReason: ProjectionIgnoredReason): ProjectionResult {
  return freezeResult({
    deltas: emptyDeltas,
    changed_cards: 0,
    changed_relations: 0,
    recorded_signals: 0,
    evidence_added: 0,
    ignored_reason: ignoredReason,
    conflicts: emptyConflicts,
  })
}

function readProjectionState(
  value: WorkspaceGraphProjectionState,
  pathPolicy = new SensitivePathPolicy(),
  contentPolicy = new SensitiveContentPolicy(),
): WorkspaceGraphProjectionState {
  try {
    if (
      !isArray(value.logical_workspaces)
      || !isArray(value.workspace_instances)
      || !isArray(value.relations)
      || !isArray(value.projection_records)
      || value.logical_workspaces.some(item => !LogicalWorkspaceSchema.safeParse(item).success)
      || value.workspace_instances.some(item => !WorkspaceInstanceSchema.safeParse(item).success)
      || value.relations.some(item => !RelationCardSchema.safeParse(item).success)
      || value.projection_records.some(item => !projectionRecordSchema.safeParse(item).success)
      || !projectionStateIsSafe(value, pathPolicy, contentPolicy)
    ) {
      throw new GraphProjectorError('PROJECTOR_INVALID_STATE')
    }
    const workspaceIds = value.logical_workspaces.map(item => item.logical_workspace_id)
    const instanceIds = value.workspace_instances.map(item => item.instance_id)
    const relationKeys = value.relations.map(relationKey)
    const recordIds = value.projection_records.map(item => item.record_id)
    const signalKeys = value.projection_records.map(item => (
      `${item.observation_source}\u0000${item.observation_id}`
    ))
    if (
      new Set(workspaceIds).size !== workspaceIds.length
      || new Set(instanceIds).size !== instanceIds.length
      || new Set(relationKeys).size !== relationKeys.length
      || new Set(recordIds).size !== recordIds.length
      || new Set(signalKeys).size !== signalKeys.length
    ) {
      throw new GraphProjectorError('PROJECTOR_INVALID_STATE')
    }
    return value
  } catch (error) {
    if (error instanceof GraphProjectorError) throw error
    throw new GraphProjectorError('PROJECTOR_INVALID_STATE')
  }
}

function projectionStateIsSafe(
  state: WorkspaceGraphProjectionState,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): boolean {
  const values: (readonly [string, string | null])[] = []
  for (const workspace of state.logical_workspaces) {
    values.push(['logical_workspace_id', workspace.logical_workspace_id])
    values.push(['display_name', workspace.display_name])
    values.push(['canonical_remote', workspace.canonical_remote])
    for (const alias of workspace.aliases) values.push(['alias', alias])
  }
  for (const instance of state.workspace_instances) {
    values.push(['instance_id', instance.instance_id])
    values.push(['instance_logical_workspace_id', instance.logical_workspace_id])
    values.push(['instance_display_name', instance.display_name])
    values.push(['path_label', instance.path_label])
    values.push(['branch', instance.branch])
    values.push(['repository_fingerprint', instance.repository_fingerprint])
  }
  for (const relation of state.relations) {
    values.push(['relation_source_logical_id', relation.source_logical_id])
    values.push(['relation_target_logical_id', relation.target_logical_id])
    values.push(['relation_type', relation.relation_type])
    values.push(['reason', relation.reason])
    for (const evidence of relation.evidence_refs) {
      values.push(['relation_evidence_source', evidence.source])
      values.push(['relation_evidence_ref', evidence.ref])
    }
  }
  for (const record of state.projection_records) {
    values.push(['projection_record_id', record.record_id])
    values.push(['projection_relation_delta_digest', record.relation_delta_digest])
    values.push(['projection_observation_source', record.observation_source])
    values.push(['projection_observation_id', record.observation_id])
    values.push(['projection_signal_digest', record.signal_digest])
    values.push(['projection_source_logical_id', record.source_logical_id])
    values.push(['projection_target_logical_id', record.target_logical_id])
    values.push(['projection_relation_type', record.relation_type])
    values.push(['projection_cue_kind', record.cue_kind])
    values.push(['projection_stance', record.stance])
    values.push(['projection_authority', record.authority])
    for (const evidence of record.evidence_refs) {
      values.push(['projection_evidence_source', evidence.source])
      values.push(['projection_evidence_ref', evidence.ref])
    }
  }
  return values.every(([field, value]) => (
    value === null || safeString(field, value, pathPolicy, contentPolicy)
  ))
}

function isArray(value: unknown): boolean {
  return Array.isArray(value)
}

function projectionAuthority(signal: ProjectionSignal): ProjectionAuthority | undefined {
  const {observation, relation_cue: cue} = signal
  if (cue === null) return undefined
  if (
    signal.origin === 'trusted_runtime'
    && observation.trust === 'trusted_system'
    && cue.stance !== 'suppress'
  ) {
    if (
      observation.observation_type === 'task_artifact_reference'
      && cue.kind === 'artifact_reference'
      && (
        observation.source === 'runtime'
        || observation.source === 'filesystem'
        || observation.source === 'git'
        || observation.source === 'executor'
      )
    ) return 'trusted_system'
    if (
      observation.observation_type === 'task_completed'
      && observation.source === 'executor'
      && cue.kind === 'task_completion'
    ) return 'trusted_system'
    if (
      observation.observation_type === 'work_order_summary'
      && observation.source === 'executor'
      && cue.kind === 'work_order'
    ) return 'trusted_system'
  }
  if (
    signal.origin === 'user_utterance'
    && observation.source === 'user'
    && observation.observation_type === 'user_relation_statement'
    && cue.kind === 'user_statement'
    && cue.stance !== 'suppress'
  ) {
    if (observation.trust === 'user_confirmed') return 'user_confirmed'
    if (observation.trust === 'trusted_user') return 'user_transcript'
  }
  if (
    signal.origin === 'provider_adapter'
    && observation.source === 'provider'
    && observation.trust === 'untrusted_external'
    && observation.observation_type === 'provider_relation_evidence'
    && cue.kind === 'provider_evidence'
    && cue.stance !== 'suppress'
  ) return 'provider'
  if (
    signal.origin === 'user_utterance'
    && observation.source === 'user'
    && observation.trust === 'user_confirmed'
    && observation.observation_type === 'relation_suppressed'
    && cue.kind === 'suppression'
    && cue.stance === 'suppress'
  ) return 'user_confirmed'
  return undefined
}

function cueMatchesObservation(
  cue: RelationProjectionCue,
  observation: Observation,
): boolean {
  if (
    cue.source_logical_id !== observation.logical_workspace_id
    || cue.target_logical_id !== observation.related_logical_workspace_id
  ) return false
  const evidenceKeys = new Set<string>()
  for (const evidence of cue.evidence_refs) {
    const key = evidenceKey(evidence)
    if (evidenceKeys.has(key) || evidence.observed_at > observation.occurred_at) return false
    evidenceKeys.add(key)
    if (!observation.evidence_refs.some(candidate => sameEvidence(candidate, evidence))) return false
  }
  const allowedEvidenceSources = allowedEvidenceSourcesFor(observation.observation_type)
  return cue.evidence_refs.every(evidence => allowedEvidenceSources.has(evidence.source))
}

function allowedEvidenceSourcesFor(
  observationType: Observation['observation_type'],
): ReadonlySet<EvidenceRef['source']> {
  switch (observationType) {
    case 'task_artifact_reference':
    case 'task_completed':
    case 'work_order_summary':
      return systemEvidenceSources
    case 'user_relation_statement':
    case 'relation_suppressed':
      return userEvidenceSources
    case 'provider_relation_evidence':
      return providerEvidenceSources
    case 'workspace_opened':
    case 'instance_observed':
      return emptyEvidenceSources
  }
}

const systemEvidenceSources: ReadonlySet<EvidenceRef['source']> = new Set([
  'runtime',
  'filesystem',
  'git',
  'executor',
])
const userEvidenceSources: ReadonlySet<EvidenceRef['source']> = new Set(['user'])
const providerEvidenceSources: ReadonlySet<EvidenceRef['source']> = new Set(['provider'])
const emptyEvidenceSources: ReadonlySet<EvidenceRef['source']> = new Set()

function authorityConfidence(authority: ProjectionAuthority): number {
  switch (authority) {
    case 'provider': return 0.2
    case 'user_transcript': return 0.35
    case 'trusted_system': return 0.8
    case 'user_confirmed': return 1
  }
}

function confirmingConfidence(
  current: number,
  incoming: number,
  authority: ProjectionAuthority,
): number {
  const raised = Math.max(current, incoming) + 0.05
  return roundConfidence(Math.max(current, Math.min(authorityConfidenceCap(authority), raised)))
}

function authorityConfidenceCap(authority: ProjectionAuthority): number {
  switch (authority) {
    case 'provider': return 0.3
    case 'user_transcript': return 0.49
    case 'trusted_system': return 0.9
    case 'user_confirmed': return 1
  }
}

function roundConfidence(confidence: number): number {
  return Math.round(confidence * 100) / 100
}

function signalIsSafe(
  signal: ProjectionSignal,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): boolean {
  const observation = signal.observation
  const values: (readonly [string, string | null])[] = [
    ['origin', signal.origin],
    ['observation_id', observation.observation_id],
    ['observation_type', observation.observation_type],
    ['source', observation.source],
    ['trust', observation.trust],
    ['logical_workspace_id', observation.logical_workspace_id],
    ['workspace_instance_id', observation.workspace_instance_id],
    ['related_logical_workspace_id', observation.related_logical_workspace_id],
    ['summary', observation.summary],
    ['outcome', observation.outcome],
  ]
  for (const evidence of observation.evidence_refs) {
    values.push(['observation_evidence_source', evidence.source])
    values.push(['observation_evidence_ref', evidence.ref])
  }
  const cue = signal.relation_cue
  if (cue !== null) {
    values.push(['cue_kind', cue.kind])
    values.push(['cue_stance', cue.stance])
    values.push(['cue_source_logical_id', cue.source_logical_id])
    values.push(['cue_target_logical_id', cue.target_logical_id])
    values.push(['cue_relation_type', cue.relation_type])
    values.push(['cue_reason', cue.reason])
    for (const evidence of cue.evidence_refs) {
      values.push(['cue_evidence_source', evidence.source])
      values.push(['cue_evidence_ref', evidence.ref])
    }
  }
  try {
    return values.every(([field, value]) => (
      value === null || safeString(field, value, pathPolicy, contentPolicy)
    ))
  } catch {
    return false
  }
}

function safeString(
  field: string,
  value: string,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): boolean {
  if (!isWellFormed(value) || value.includes('\u0000')) return false
  const normalized = normalizeNfkcPinned(value)
  const variants = normalized === value ? [value] : [value, normalized]
  return variants.every(variant => (
    pathPolicy.scrubText(field, variant).kind === 'clean'
    && contentPolicy.scrub(field, variant).kind === 'clean'
  ))
}

function normalizedProjectionReason(value: string): string {
  return stripLikePython(collapsePythonWhitespace(normalizeNfkcPinned(value)))
}

function projectionDigest(signal: ProjectionSignal): string {
  return createHash('sha256').update(canonicalJson(signal), 'utf8').digest('hex')
}

function relationDeltaDigest(
  delta: Extract<WorkspaceGraphProjectionDelta, {kind: 'upsert_relation'}>,
): string {
  return createHash('sha256').update(canonicalJson(delta), 'utf8').digest('hex')
}

function relationKey(relation: Pick<
  RelationCard,
  'source_logical_id' | 'target_logical_id' | 'relation_type'
>): string {
  return `${relation.source_logical_id}\u0000${relation.target_logical_id}\u0000${relation.relation_type}`
}

function sortedEvidence(evidenceRefs: readonly EvidenceRef[]): EvidenceRef[] {
  const evidence = evidenceRefs.map(item => Object.freeze({...item}))
  evidence.sort((left, right) => (
    left.observed_at - right.observed_at
    || compareCodePoints(left.source, right.source)
    || compareCodePoints(left.ref, right.ref)
  ))
  Object.freeze(evidence)
  return evidence
}

function unionEvidence(
  existing: readonly EvidenceRef[],
  incoming: readonly EvidenceRef[],
): EvidenceRef[] {
  const evidence = new Map(existing.map(item => [evidenceKey(item), item] as const))
  for (const item of incoming) evidence.set(evidenceKey(item), item)
  return sortedEvidence([...evidence.values()])
}

function sameEvidenceKey(left: EvidenceRef, right: EvidenceRef): boolean {
  return left.source === right.source && left.ref === right.ref
}

function sameEvidence(left: EvidenceRef, right: EvidenceRef): boolean {
  return sameEvidenceKey(left, right) && left.observed_at === right.observed_at
}

function evidenceKey(evidence: EvidenceRef): string {
  return `${evidence.source}\u0000${evidence.ref}`
}

type ProjectionOrder = Pick<ProjectionRecord, 'occurred_at' | 'record_id' | 'stance'>

function compareProjectionOrder(left: ProjectionOrder, right: ProjectionOrder): number {
  if (left.occurred_at !== right.occurred_at) {
    return left.occurred_at < right.occurred_at ? -1 : 1
  }
  const leftSuppression = left.stance === 'suppress' ? 1 : 0
  const rightSuppression = right.stance === 'suppress' ? 1 : 0
  return leftSuppression - rightSuppression
    || compareCodePoints(left.record_id, right.record_id)
}

function latestRecord(
  records: readonly ProjectionRecord[],
  relation: Pick<RelationCard, 'source_logical_id' | 'target_logical_id' | 'relation_type'>,
  predicate: (record: ProjectionRecord) => boolean,
): ProjectionRecord | undefined {
  return records
    .filter(record => relationKey(record) === relationKey(relation) && predicate(record))
    .sort((left, right) => compareProjectionOrder(right, left))[0]
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function compareRelations(left: RelationCard, right: RelationCard): number {
  return compareCodePoints(relationKey(left), relationKey(right))
}

function compareProjectionRecords(left: ProjectionRecord, right: ProjectionRecord): number {
  return compareCodePoints(left.record_id, right.record_id)
}

function freezeRelation(relation: RelationCard): RelationCard {
  const parsed = RelationCardSchema.parse(relation)
  return Object.freeze({...parsed, evidence_refs: sortedEvidence(parsed.evidence_refs)})
}

function freezeProjectionRecord(record: ProjectionRecord): ProjectionRecord {
  const evidence = sortedEvidence(record.evidence_refs)
  return Object.freeze({...record, evidence_refs: evidence})
}

function freezeProjectionState(
  state: WorkspaceGraphProjectionState,
): WorkspaceGraphProjectionState {
  return Object.freeze({
    logical_workspaces: Object.freeze(state.logical_workspaces.map(workspace => {
      const aliases = [...workspace.aliases]
      Object.freeze(aliases)
      return Object.freeze({...workspace, aliases})
    })),
    workspace_instances: Object.freeze(state.workspace_instances.map(instance => (
      Object.freeze({...instance})
    ))),
    relations: Object.freeze(state.relations.map(freezeRelation)),
    projection_records: Object.freeze(state.projection_records.map(freezeProjectionRecord)),
  })
}

function freezeResult(result: ProjectionResult): ProjectionResult {
  return Object.freeze(result)
}
