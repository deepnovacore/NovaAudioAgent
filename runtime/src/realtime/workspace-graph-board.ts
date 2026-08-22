import {Buffer} from 'node:buffer'

import type {PublishedGraphSnapshot} from '../workspace-graph/store.js'

export const MAX_WORKSPACE_GRAPH_BOARD_BYTES = 16 * 1_024
export const MAX_GRAPH_BOARD_LOGICAL_WORKSPACES = 64
export const MAX_GRAPH_BOARD_WORKSPACE_INSTANCES = 128
export const MAX_GRAPH_BOARD_RELATIONS = 128

const MAX_LOGICAL_CANDIDATES = 128
const MAX_INSTANCE_CANDIDATES = 256
const MAX_RELATION_CANDIDATES = 256
const MAX_IDENTIFIER_CODE_POINTS = 256
const MAX_DISPLAY_NAME_CODE_POINTS = 239

export type WorkspaceGraphBoardAvailability = 'ready' | 'disabled' | 'degraded'

interface BoardLogicalWorkspace {
  readonly logical_workspace_id: string
  readonly display_name: string
}

interface BoardWorkspaceInstance {
  readonly instance_id: string
  readonly logical_workspace_id: string
  readonly display_name: string
  readonly active: boolean
  readonly last_seen_at: number
}

interface BoardRelation {
  readonly source_logical_id: string
  readonly target_logical_id: string
  readonly relation_type:
    | 'depends_on'
    | 'sibling_of'
    | 'replaces'
    | 'shares_runtime'
    | 'discussed_with'
  readonly confidence: number
  readonly status: 'active' | 'weak'
  readonly last_seen_at: number
  readonly evidence_count: number
}

interface MutableBoard {
  readonly type: 'workspace_graph.board'
  readonly request_id: string
  availability: WorkspaceGraphBoardAvailability
  publication_revision: number
  readonly omitted: {
    logical_workspaces: number
    workspace_instances: number
    relations: number
  }
  logical_workspaces: BoardLogicalWorkspace[]
  workspace_instances: BoardWorkspaceInstance[]
  relations: BoardRelation[]
}

export function workspaceGraphBoardMessage(
  requestId: string,
  snapshot: PublishedGraphSnapshot | null,
  availability: WorkspaceGraphBoardAvailability,
): string {
  validateRequestId(requestId)
  if (availability !== 'ready' && availability !== 'disabled' && availability !== 'degraded') {
    throw new TypeError('workspace graph board request is invalid')
  }
  if (availability === 'disabled') return JSON.stringify(emptyBoard(requestId, 'disabled'))
  if (snapshot === null) return JSON.stringify(emptyBoard(requestId, 'degraded'))

  try {
    const board = projectBoard(requestId, snapshot, availability)
    enforceMessageBudget(board)
    return JSON.stringify(board)
  } catch {
    return JSON.stringify(emptyBoard(requestId, 'degraded'))
  }
}

function projectBoard(
  requestId: string,
  snapshot: PublishedGraphSnapshot,
  requestedAvailability: WorkspaceGraphBoardAvailability,
): MutableBoard {
  const publicationRevision = nonNegativeInteger(snapshot.publication_revision)
  const snapshotDegraded = boolean(snapshot.degraded)
  const logicalInput = boundedArray(snapshot.logical_workspaces, MAX_LOGICAL_CANDIDATES)
  const instanceInput = boundedArray(snapshot.workspace_instances, MAX_INSTANCE_CANDIDATES)
  const relationInput = boundedArray(snapshot.relations, MAX_RELATION_CANDIDATES)

  const instanceCandidates = instanceInput.values.map(instanceView)
  if (new Set(instanceCandidates.map(item => item.instance_id)).size !== instanceCandidates.length) {
    throw new TypeError('invalid snapshot')
  }
  const instanceActivity = new Map<string, {active: boolean; lastSeen: number}>()
  for (const instance of instanceCandidates) {
    const previous = instanceActivity.get(instance.logical_workspace_id)
    instanceActivity.set(instance.logical_workspace_id, {
      active: instance.active || (previous?.active ?? false),
      lastSeen: Math.max(instance.last_seen_at, previous?.lastSeen ?? 0),
    })
  }

  const logicalCandidates = logicalInput.values.map(logicalWorkspaceView)
  const candidateLogicalIds = new Set(logicalCandidates.map(item => item.logical_workspace_id))
  if (candidateLogicalIds.size !== logicalCandidates.length) throw new TypeError('invalid snapshot')
  if (
    logicalInput.total <= MAX_LOGICAL_CANDIDATES
    && instanceCandidates.some(instance => !candidateLogicalIds.has(instance.logical_workspace_id))
  ) throw new TypeError('invalid snapshot')
  logicalCandidates.sort((left, right) => {
    const leftActivity = instanceActivity.get(left.logical_workspace_id)
    const rightActivity = instanceActivity.get(right.logical_workspace_id)
    const activeOrder = Number(rightActivity?.active ?? false) - Number(leftActivity?.active ?? false)
    if (activeOrder !== 0) return activeOrder
    const recentOrder = (rightActivity?.lastSeen ?? right.updated_at)
      - (leftActivity?.lastSeen ?? left.updated_at)
    if (recentOrder !== 0) return recentOrder
    return compareCodePoints(left.logical_workspace_id, right.logical_workspace_id)
  })
  const logicalWorkspaces = logicalCandidates
    .slice(0, MAX_GRAPH_BOARD_LOGICAL_WORKSPACES)
    .map(item => ({
      logical_workspace_id: item.logical_workspace_id,
      display_name: item.display_name,
    }))
  const includedLogicalIds = new Set(logicalWorkspaces.map(item => item.logical_workspace_id))

  instanceCandidates.sort((left, right) => (
    Number(right.active) - Number(left.active)
    || right.last_seen_at - left.last_seen_at
    || compareCodePoints(left.instance_id, right.instance_id)
  ))
  const workspaceInstances = instanceCandidates.filter(instance => (
    includedLogicalIds.has(instance.logical_workspace_id)
  )).slice(0, MAX_GRAPH_BOARD_WORKSPACE_INSTANCES)

  const relationCandidates = relationInput.values.map(relationView)
  if (
    logicalInput.total <= MAX_LOGICAL_CANDIDATES
    && relationCandidates.some(relation => (
      !candidateLogicalIds.has(relation.source_logical_id)
      || !candidateLogicalIds.has(relation.target_logical_id)
    ))
  ) throw new TypeError('invalid snapshot')
  relationCandidates.sort((left, right) => (
    relationStatusPriority(left.status) - relationStatusPriority(right.status)
    || right.confidence - left.confidence
    || right.last_seen_at - left.last_seen_at
    || compareCodePoints(left.source_logical_id, right.source_logical_id)
    || compareCodePoints(left.target_logical_id, right.target_logical_id)
    || compareCodePoints(left.relation_type, right.relation_type)
  ))
  const relations = relationCandidates.filter(relation => (
    includedLogicalIds.has(relation.source_logical_id)
    && includedLogicalIds.has(relation.target_logical_id)
  )).slice(0, MAX_GRAPH_BOARD_RELATIONS)

  return {
    type: 'workspace_graph.board',
    request_id: requestId,
    availability: snapshotDegraded || requestedAvailability === 'degraded' ? 'degraded' : 'ready',
    publication_revision: publicationRevision,
    omitted: {
      logical_workspaces: safeOmitted(logicalInput.total, logicalWorkspaces.length),
      workspace_instances: safeOmitted(instanceInput.total, workspaceInstances.length),
      relations: safeOmitted(relationInput.total, relations.length),
    },
    logical_workspaces: logicalWorkspaces,
    workspace_instances: workspaceInstances,
    relations,
  }
}

function enforceMessageBudget(board: MutableBoard): void {
  while (Buffer.byteLength(JSON.stringify(board), 'utf8') > MAX_WORKSPACE_GRAPH_BOARD_BYTES) {
    if (board.relations.length > 0) {
      board.relations.pop()
      board.omitted.relations += 1
      continue
    }
    if (board.workspace_instances.length > 0) {
      board.workspace_instances.pop()
      board.omitted.workspace_instances += 1
      continue
    }
    const referenced = new Set<string>()
    for (const relation of board.relations) {
      referenced.add(relation.source_logical_id)
      referenced.add(relation.target_logical_id)
    }
    for (const instance of board.workspace_instances) referenced.add(instance.logical_workspace_id)
    const removable = board.logical_workspaces.findLastIndex(node => (
      !referenced.has(node.logical_workspace_id)
    ))
    if (removable >= 0) {
      board.logical_workspaces.splice(removable, 1)
      board.omitted.logical_workspaces += 1
      continue
    }
    board.availability = 'degraded'
    board.publication_revision = 0
    board.omitted.logical_workspaces = 0
    board.omitted.workspace_instances = 0
    board.omitted.relations = 0
    board.logical_workspaces = []
    board.workspace_instances = []
    board.relations = []
    return
  }
}

function logicalWorkspaceView(value: unknown): BoardLogicalWorkspace & {readonly updated_at: number} {
  const item = plainObject(value)
  return {
    logical_workspace_id: identifier(item.logical_workspace_id),
    display_name: displayName(item.display_name),
    updated_at: finiteTimestamp(item.updated_at),
  }
}

function instanceView(value: unknown): BoardWorkspaceInstance {
  const item = plainObject(value)
  if (item.status !== 'active' && item.status !== 'inactive') throw new TypeError('invalid snapshot')
  return {
    instance_id: identifier(item.instance_id),
    logical_workspace_id: identifier(item.logical_workspace_id),
    display_name: displayName(item.display_name),
    active: item.status === 'active',
    last_seen_at: finiteTimestamp(item.last_seen_at),
  }
}

function relationView(value: unknown): BoardRelation {
  const item = plainObject(value)
  if (
    item.relation_type !== 'depends_on'
    && item.relation_type !== 'sibling_of'
    && item.relation_type !== 'replaces'
    && item.relation_type !== 'shares_runtime'
    && item.relation_type !== 'discussed_with'
  ) throw new TypeError('invalid snapshot')
  if (item.status !== 'active' && item.status !== 'weak') throw new TypeError('invalid snapshot')
  if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)) {
    throw new TypeError('invalid snapshot')
  }
  if (item.confidence < 0 || item.confidence > 1) throw new TypeError('invalid snapshot')
  if (!Array.isArray(item.evidence_refs)) throw new TypeError('invalid snapshot')
  return {
    source_logical_id: identifier(item.source_logical_id),
    target_logical_id: identifier(item.target_logical_id),
    relation_type: item.relation_type,
    confidence: item.confidence,
    status: item.status,
    last_seen_at: finiteTimestamp(item.last_seen_at),
    evidence_count: safeCount(item.evidence_refs.length),
  }
}

function boundedArray(value: unknown, cap: number): {readonly values: unknown[]; readonly total: number} {
  if (!Array.isArray(value)) throw new TypeError('invalid snapshot')
  const total = safeCount(value.length)
  const values: unknown[] = []
  const limit = Math.min(total, cap)
  for (let index = 0; index < limit; index += 1) values.push(value[index])
  return {values, total}
}

function emptyBoard(
  requestId: string,
  availability: 'disabled' | 'degraded',
): MutableBoard {
  return {
    type: 'workspace_graph.board',
    request_id: requestId,
    availability,
    publication_revision: 0,
    omitted: {logical_workspaces: 0, workspace_instances: 0, relations: 0},
    logical_workspaces: [],
    workspace_instances: [],
    relations: [],
  }
}

function validateRequestId(value: string): void {
  if (typeof value !== 'string') throw new TypeError('workspace graph board request is invalid')
  const codePoints = [...value]
  if (
    codePoints.length === 0
    || codePoints.length > MAX_IDENTIFIER_CODE_POINTS
    || value.trim() === ''
    || hasUnpairedSurrogate(value)
  ) throw new TypeError('workspace graph board request is invalid')
}

function identifier(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('invalid snapshot')
  const length = [...value].length
  if (length === 0 || length > MAX_IDENTIFIER_CODE_POINTS || value.trim() === '' || hasUnpairedSurrogate(value)) {
    throw new TypeError('invalid snapshot')
  }
  return value
}

function displayName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('invalid snapshot')
  const length = [...value].length
  if (length === 0 || length > MAX_DISPLAY_NAME_CODE_POINTS || value.trim() === '' || hasUnpairedSurrogate(value)) {
    throw new TypeError('invalid snapshot')
  }
  return value
}

function plainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('invalid snapshot')
  }
  return value as Record<string, unknown>
}

function finiteTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('invalid snapshot')
  }
  return value
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('invalid snapshot')
  }
  return value
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('invalid snapshot')
  return value
}

function safeCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid snapshot')
  return value
}

function safeOmitted(total: number, included: number): number {
  return Math.max(0, total - included)
}

function relationStatusPriority(status: BoardRelation['status']): number {
  return status === 'active' ? 0 : 1
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map(point => point.codePointAt(0)!)
  const rightPoints = [...right].map(point => point.codePointAt(0)!)
  const limit = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < limit; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

export function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true
  }
  return false
}
