import {createHash} from 'node:crypto'

import {canonicalJson, compareCodePoints} from '../canonical-json.js'
import {normalizeAndLowerPinned} from '../unicode-normalize.js'
import {
  GraphHintSchema,
  type EvidenceRef,
  type GraphHint,
} from './models.js'
import {
  WORKSPACE_GRAPH_SCHEMA_VERSION,
  type PublishedGraphSnapshot,
} from './store.js'

export const GRAPH_RECALL_MAX_HINTS = 2
export const GRAPH_RECALL_UTTERANCE_CODE_POINTS = 512

const GRAPH_RECALL_FIELD_CODE_POINTS = 239
const GRAPH_RECALL_ALIASES_PER_WORKSPACE = 16
const GRAPH_RECALL_MAX_LOGICAL_WORKSPACES = 128
const GRAPH_RECALL_MAX_WORKSPACE_INSTANCES = 128
const GRAPH_RECALL_MAX_RELATIONS = 128
const GRAPH_RECALL_MAX_PUBLISHED_ALIASES = 256
const GRAPH_RECALL_MAX_EVIDENCE_REFS = 64
const GRAPH_RECALL_MAX_STABLE_ID_CODE_UNITS = 4_800
const ASCII_TOKEN = /[a-z0-9]+/gu
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿]+/gu

export interface GraphRecallResult {
  readonly hints: readonly GraphHint[]
  readonly omitted_hints: number
  readonly degraded: boolean
}

interface RecallCandidate {
  readonly overlap: number
  readonly relation: IndexedRelation
  readonly otherWorkspace: IndexedWorkspace
}

interface IndexedWorkspace {
  readonly logical_workspace_id: string
  readonly display_name: string
  readonly aliases: readonly string[]
}

interface IndexedInstance {
  readonly instance_id: string
  readonly logical_workspace_id: string
  readonly status: 'active' | 'inactive'
}

interface IndexedRelation {
  readonly source_logical_id: string
  readonly target_logical_id: string
  readonly relation_type: GraphHint['relation_type']
  readonly confidence: number
  readonly reason: string
  readonly evidence_ref: EvidenceRef
  readonly last_seen_at: number
  readonly status: 'active' | 'weak'
  readonly revision: number
}

interface RecallIndex {
  readonly degraded: boolean
  readonly workspaces_complete: boolean
  readonly instances_complete: boolean
  readonly relations_complete: boolean
  readonly logical_workspaces: readonly IndexedWorkspace[]
  readonly workspace_instances: readonly IndexedInstance[]
  readonly relations: readonly IndexedRelation[]
}

interface Projection<Value> {
  readonly value: Value | null
  readonly degraded: boolean
}

interface ArrayProjection<Value> {
  readonly values: readonly Value[]
  readonly complete: boolean
  readonly degraded: boolean
}

/**
 * Builds an owned bounded index once; turn-time suggestions never traverse the published snapshot.
 * Task 6 should rebuild/swap this index off the hot turn path after snapshot publication.
 */
export class GraphRecall {
  readonly #index: RecallIndex

  constructor(snapshot: PublishedGraphSnapshot | null) {
    this.#index = snapshot === null ? emptyIndex(true) : buildRecallIndex(snapshot)
  }

  suggest(currentInstanceId: string, utterance: string, limit = GRAPH_RECALL_MAX_HINTS): GraphRecallResult {
    const index = this.#index
    if (
      !index.instances_complete
      || !index.workspaces_complete
      || !index.relations_complete
    ) return emptyResult(true)
    if (!boundedStableId(currentInstanceId) || typeof utterance !== 'string') {
      return emptyResult(index.degraded)
    }

    const instances = index.workspace_instances.filter(item => item.instance_id === currentInstanceId)
    if (instances.length !== 1 || instances[0]?.status !== 'active') {
      return emptyResult(index.degraded)
    }
    const currentLogicalId = instances[0].logical_workspace_id
    const currentCards = index.logical_workspaces.filter(
      item => item.logical_workspace_id === currentLogicalId,
    )
    if (currentCards.length !== 1) return emptyResult(index.degraded)

    const queryTokens = lexicalTokens(firstCodePoints(
      utterance,
      GRAPH_RECALL_UTTERANCE_CODE_POINTS,
    ))
    if (queryTokens.size === 0) return emptyResult(index.degraded)

    const cards = uniqueCards(index.logical_workspaces)
    const candidates = new Map<string, RecallCandidate>()
    for (const relation of index.relations) {
      const adjacentFromSource = relation.source_logical_id === currentLogicalId
      const adjacentFromTarget = relation.target_logical_id === currentLogicalId
      if (adjacentFromSource === adjacentFromTarget) continue
      const otherLogicalId = adjacentFromSource
        ? relation.target_logical_id
        : relation.source_logical_id
      if (otherLogicalId === currentLogicalId) continue
      const otherWorkspace = cards.get(otherLogicalId)
      if (otherWorkspace === undefined) continue

      const candidateTokens = relationTokens(
        relation,
        otherWorkspace,
        otherWorkspace.aliases,
      )
      const overlap = overlapCount(queryTokens, candidateTokens)
      if (overlap === 0) continue
      const candidate = {overlap, relation, otherWorkspace}
      const key = relationIdentity(relation)
      const existing = candidates.get(key)
      if (
        existing === undefined
        || relation.revision > existing.relation.revision
        || (relation.revision === existing.relation.revision
          && compareCandidates(candidate, existing) < 0)
      ) {
        candidates.set(key, candidate)
      }
    }

    const ranked = [...candidates.values()].sort(compareCandidates)
    const selectedLimit = Number.isSafeInteger(limit)
      ? Math.min(Math.max(limit, 0), GRAPH_RECALL_MAX_HINTS)
      : 0
    const hints = ranked.slice(0, selectedLimit).map(toHint)
    return deepFreeze({
      hints,
      omitted_hints: ranked.length - hints.length,
      degraded: index.degraded,
    })
  }
}

function buildRecallIndex(snapshot: PublishedGraphSnapshot): RecallIndex {
  try {
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
      throw new TypeError()
    }
    const input = snapshot as unknown as Record<string, unknown>
    const schemaVersion = input.schema_version
    const publicationRevision = input.publication_revision
    const snapshotDegraded = input.degraded
    const logicalWorkspacesInput = input.logical_workspaces
    const workspaceInstancesInput = input.workspace_instances
    const relationsInput = input.relations
    const aliasesInput = input.aliases
    if (
      schemaVersion !== WORKSPACE_GRAPH_SCHEMA_VERSION
      || !isRevision(publicationRevision)
      || typeof snapshotDegraded !== 'boolean'
    ) throw new TypeError()

    const workspaceProjection = projectArray(
      logicalWorkspacesInput,
      GRAPH_RECALL_MAX_LOGICAL_WORKSPACES,
      projectWorkspace,
    )
    const instanceProjection = projectArray(
      workspaceInstancesInput,
      GRAPH_RECALL_MAX_WORKSPACE_INSTANCES,
      projectInstance,
    )
    const relationProjection = projectArray(
      relationsInput,
      GRAPH_RECALL_MAX_RELATIONS,
      projectRelation,
    )
    const aliasProjection = projectArray(
      aliasesInput,
      GRAPH_RECALL_MAX_PUBLISHED_ALIASES,
      projectPublishedAlias,
    )
    const mergedAliases = mergeAliases(workspaceProjection.values, aliasProjection.values)
    return deepFreeze({
      degraded: snapshotDegraded
        || workspaceProjection.degraded
        || instanceProjection.degraded
        || relationProjection.degraded
        || aliasProjection.degraded
        || mergedAliases.degraded,
      workspaces_complete: workspaceProjection.complete,
      instances_complete: instanceProjection.complete,
      relations_complete: relationProjection.complete,
      logical_workspaces: mergedAliases.workspaces,
      workspace_instances: instanceProjection.values,
      relations: relationProjection.values,
    })
  } catch {
    return emptyIndex(true)
  }
}

function emptyIndex(degraded: boolean): RecallIndex {
  return deepFreeze({
    degraded,
    workspaces_complete: true,
    instances_complete: true,
    relations_complete: true,
    logical_workspaces: [],
    workspace_instances: [],
    relations: [],
  })
}

function projectArray<Value>(
  input: unknown,
  maxItems: number,
  project: (value: unknown) => Projection<Value>,
): ArrayProjection<Value> {
  if (!Array.isArray(input)) throw new TypeError()
  const inputLength = input.length
  if (!Number.isSafeInteger(inputLength) || inputLength < 0) throw new TypeError()
  const inspectCount = Math.min(inputLength, maxItems)
  const values: Value[] = []
  let complete = inputLength <= maxItems
  let degraded = !complete
  for (let index = 0; index < inspectCount; index += 1) {
    const projected = project(input[index] as unknown)
    degraded ||= projected.degraded
    if (projected.value === null) complete = false
    else values.push(projected.value)
  }
  return {values, complete, degraded: degraded || !complete}
}

function projectWorkspace(input: unknown): Projection<IndexedWorkspace> {
  const record = objectRecord(input)
  const logicalWorkspaceId = record.logical_workspace_id
  const displayName = record.display_name
  const aliasesInput = record.aliases
  if (!boundedStableId(logicalWorkspaceId) || !boundedLabel(displayName)) {
    return {value: null, degraded: true}
  }
  const aliases = projectArray(
    aliasesInput,
    GRAPH_RECALL_ALIASES_PER_WORKSPACE,
    projectAliasLabel,
  )
  return {
    value: {
      logical_workspace_id: logicalWorkspaceId,
      display_name: displayName,
      aliases: aliases.values,
    },
    degraded: aliases.degraded,
  }
}

function projectInstance(input: unknown): Projection<IndexedInstance> {
  const record = objectRecord(input)
  const instanceId = record.instance_id
  const logicalWorkspaceId = record.logical_workspace_id
  const status = record.status
  if (
    !boundedStableId(instanceId)
    || !boundedStableId(logicalWorkspaceId)
    || (status !== 'active' && status !== 'inactive')
  ) return {value: null, degraded: true}
  return {
    value: {
      instance_id: instanceId,
      logical_workspace_id: logicalWorkspaceId,
      status,
    },
    degraded: false,
  }
}

function projectRelation(input: unknown): Projection<IndexedRelation> {
  const record = objectRecord(input)
  const sourceLogicalId = record.source_logical_id
  const targetLogicalId = record.target_logical_id
  const relationType = record.relation_type
  const confidence = record.confidence
  const reason = record.reason
  const evidenceInput = record.evidence_refs
  const lastSeenAt = record.last_seen_at
  const status = record.status
  const revision = record.revision
  if (
    !boundedStableId(sourceLogicalId)
    || !boundedStableId(targetLogicalId)
    || !isRelationType(relationType)
    || !isConfidence(confidence)
    || !boundedLabel(reason)
    || !isTimestamp(lastSeenAt)
    || (status !== 'active' && status !== 'weak')
    || !isRevision(revision)
  ) return {value: null, degraded: true}

  const evidence = projectArray(
    evidenceInput,
    GRAPH_RECALL_MAX_EVIDENCE_REFS,
    projectEvidence,
  )
  const evidenceRef = [...evidence.values].sort(compareEvidence)[0]
  if (evidenceRef === undefined) return {value: null, degraded: true}
  return {
    value: {
      source_logical_id: sourceLogicalId,
      target_logical_id: targetLogicalId,
      relation_type: relationType,
      confidence,
      reason,
      evidence_ref: evidenceRef,
      last_seen_at: lastSeenAt,
      status,
      revision,
    },
    degraded: evidence.degraded,
  }
}

function projectEvidence(input: unknown): Projection<EvidenceRef> {
  const record = objectRecord(input)
  const source = record.source
  const ref = record.ref
  const observedAt = record.observed_at
  if (!isEvidenceSource(source) || !boundedStableId(ref) || !isTimestamp(observedAt)) {
    return {value: null, degraded: true}
  }
  return {value: {source, ref, observed_at: observedAt}, degraded: false}
}

interface IndexedPublishedAlias {
  readonly alias: string
  readonly logical_workspace_id: string
}

function projectPublishedAlias(input: unknown): Projection<IndexedPublishedAlias> {
  const record = objectRecord(input)
  const alias = record.alias
  const logicalWorkspaceId = record.logical_workspace_id
  if (!boundedLabel(alias) || !boundedStableId(logicalWorkspaceId)) {
    return {value: null, degraded: true}
  }
  return {
    value: {alias, logical_workspace_id: logicalWorkspaceId},
    degraded: false,
  }
}

function projectAliasLabel(input: unknown): Projection<string> {
  return boundedLabel(input)
    ? {value: input, degraded: false}
    : {value: null, degraded: true}
}

function mergeAliases(
  workspaces: readonly IndexedWorkspace[],
  publishedAliases: readonly IndexedPublishedAlias[],
): {readonly workspaces: readonly IndexedWorkspace[]; readonly degraded: boolean} {
  const byWorkspace = new Map<string, Set<string>>()
  for (const workspace of workspaces) {
    const aliases = byWorkspace.get(workspace.logical_workspace_id) ?? new Set<string>()
    for (const alias of workspace.aliases) aliases.add(alias)
    byWorkspace.set(workspace.logical_workspace_id, aliases)
  }
  for (const entry of publishedAliases) {
    const aliases = byWorkspace.get(entry.logical_workspace_id)
    if (aliases !== undefined) aliases.add(entry.alias)
  }
  let degraded = false
  return {
    workspaces: workspaces.map(workspace => {
      const aliases = [...(byWorkspace.get(workspace.logical_workspace_id) ?? [])]
        .sort(compareCodePoints)
      if (aliases.length > GRAPH_RECALL_ALIASES_PER_WORKSPACE) degraded = true
      return {
        ...workspace,
        aliases: aliases.slice(0, GRAPH_RECALL_ALIASES_PER_WORKSPACE),
      }
    }),
    degraded,
  }
}

function objectRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError()
  return input as Record<string, unknown>
}

function boundedStableId(input: unknown): input is string {
  return typeof input === 'string'
    && input.length <= GRAPH_RECALL_MAX_STABLE_ID_CODE_UNITS
    && /\S/u.test(input)
}

function boundedLabel(input: unknown): input is string {
  return typeof input === 'string'
    && input.length <= GRAPH_RECALL_FIELD_CODE_POINTS
    && /\S/u.test(input)
}

function isTimestamp(input: unknown): input is number {
  return typeof input === 'number' && Number.isFinite(input) && input >= 0
}

function isRevision(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) >= 0
}

function isConfidence(input: unknown): input is number {
  return typeof input === 'number' && Number.isFinite(input) && input >= 0 && input <= 1
}

function isRelationType(input: unknown): input is GraphHint['relation_type'] {
  return input === 'depends_on'
    || input === 'sibling_of'
    || input === 'replaces'
    || input === 'shares_runtime'
    || input === 'discussed_with'
}

function isEvidenceSource(input: unknown): input is EvidenceRef['source'] {
  return input === 'runtime'
    || input === 'filesystem'
    || input === 'git'
    || input === 'executor'
    || input === 'user'
    || input === 'provider'
}

function emptyResult(degraded: boolean): GraphRecallResult {
  return deepFreeze({hints: [], omitted_hints: 0, degraded})
}

function uniqueCards(
  workspaces: readonly IndexedWorkspace[],
): ReadonlyMap<string, IndexedWorkspace> {
  const cards = new Map<string, IndexedWorkspace | null>()
  for (const workspace of workspaces) {
    cards.set(
      workspace.logical_workspace_id,
      cards.has(workspace.logical_workspace_id) ? null : workspace,
    )
  }
  return new Map(
    [...cards.entries()].flatMap(([key, value]) => value === null ? [] : [[key, value] as const]),
  )
}

function relationTokens(
  relation: IndexedRelation,
  workspace: IndexedWorkspace,
  aliases: readonly string[],
): ReadonlySet<string> {
  const tokens = new Set<string>()
  const fields = [
    relation.reason,
    relation.relation_type,
    workspace.display_name,
    ...aliases,
  ]
  for (const field of fields) {
    const bounded = firstCodePoints(field, GRAPH_RECALL_FIELD_CODE_POINTS)
    for (const token of lexicalTokens(bounded)) tokens.add(token)
  }
  return tokens
}

function lexicalTokens(text: string): ReadonlySet<string> {
  const normalized = normalizeAndLowerPinned(text)
  const tokens = new Set<string>()
  for (const match of normalized.matchAll(ASCII_TOKEN)) {
    if (match[0].length >= 2) tokens.add(match[0])
  }
  for (const match of normalized.matchAll(CJK_RUN)) {
    const run = [...match[0]]
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2).join(''))
    }
  }
  return tokens
}

function firstCodePoints(value: string, limit: number): string {
  let output = ''
  let count = 0
  for (const character of value) {
    if (count >= limit) break
    output += character
    count += 1
  }
  return output
}

function overlapCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let overlap = 0
  for (const token of left) if (right.has(token)) overlap += 1
  return overlap
}

function compareCandidates(left: RecallCandidate, right: RecallCandidate): number {
  return right.overlap - left.overlap
    || right.relation.confidence - left.relation.confidence
    || statusRank(right.relation.status) - statusRank(left.relation.status)
    || right.relation.last_seen_at - left.relation.last_seen_at
    || compareCodePoints(
      left.otherWorkspace.logical_workspace_id,
      right.otherWorkspace.logical_workspace_id,
    )
    || compareCodePoints(left.relation.relation_type, right.relation.relation_type)
    || compareCodePoints(left.relation.source_logical_id, right.relation.source_logical_id)
    || compareCodePoints(left.relation.target_logical_id, right.relation.target_logical_id)
}

function statusRank(status: IndexedRelation['status']): number {
  return status === 'active' ? 1 : 0
}

function relationIdentity(relation: IndexedRelation): string {
  return canonicalJson({
    relation_type: relation.relation_type,
    source_logical_id: relation.source_logical_id,
    target_logical_id: relation.target_logical_id,
  })
}

function toHint(candidate: RecallCandidate): GraphHint {
  const relation = candidate.relation
  const hint = GraphHintSchema.parse({
    hint_id: hintId(relation),
    logical_workspace_id: candidate.otherWorkspace.logical_workspace_id,
    relation_type: relation.relation_type,
    relation_status: relation.status,
    confidence: relation.confidence,
    reason: relation.reason,
    evidence_refs: [{...relation.evidence_ref}],
    revision: relation.revision,
  })
  return deepFreeze(hint)
}

function compareEvidence(left: EvidenceRef, right: EvidenceRef): number {
  return right.observed_at - left.observed_at
    || compareCodePoints(left.source, right.source)
    || compareCodePoints(left.ref, right.ref)
}

function hintId(relation: IndexedRelation): string {
  const identity = canonicalJson({
    relation_type: relation.relation_type,
    revision: relation.revision,
    source_logical_id: relation.source_logical_id,
    target_logical_id: relation.target_logical_id,
  })
  return `hint-${createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 24)}`
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
