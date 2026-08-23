import {createHash} from 'node:crypto'
import {posix, win32} from 'node:path'

import {canonicalJson, compareCodePoints} from '../canonical-json.js'
import {
  collapsePythonWhitespace,
  isWellFormed,
  stripLikePython,
} from '../python-text.js'
import {casefoldLikePython} from '../unicode-casefold.js'
import {normalizeNfkcPinned} from '../unicode-normalize.js'
import type {
  LogicalWorkspace,
  WorkspaceInstance,
} from './models.js'
import {
  SensitiveContentPolicy,
  SensitivePathPolicy,
} from './sensitivity.js'

export const ASR_ALIAS_CONFIDENCE_CAP = 0.25

export interface WorkspaceIdentityBinding {
  readonly binding_id: string
  readonly logical_workspace_id: string
  readonly instance_id: string
  readonly path_key: string
  readonly remote_key: string | null
  readonly repository_fingerprint: string | null
  readonly status: WorkspaceInstance['status']
  readonly first_seen_at: number
  readonly last_seen_at: number
}

export type WorkspaceAliasObservationStatus = 'candidate' | 'confirmed' | 'suppressed'

export interface WorkspaceAliasObservation {
  readonly observation_id: string
  readonly logical_workspace_id: string
  readonly spoken_alias: string
  readonly normalized_alias: string
  readonly status: WorkspaceAliasObservationStatus
  readonly confidence: number
  readonly evidence_ref: string
  readonly observed_at: number
}

/** Immutable input consumed by the resolver. Persistence remains an asynchronous caller concern. */
export interface WorkspaceIdentityState {
  readonly logical_workspaces: readonly LogicalWorkspace[]
  readonly workspace_instances: readonly WorkspaceInstance[]
  readonly bindings: readonly WorkspaceIdentityBinding[]
  readonly alias_observations: readonly WorkspaceAliasObservation[]
}

export type WorkspaceResolutionBasis =
  | 'user_confirmed'
  | 'prior_instance'
  | 'repository_fingerprint'
  | 'canonical_remote'
  | 'first_seen'

export type WorkspaceContinuityEvidence =
  | {
    readonly kind: 'prior_instance'
    readonly instance_id: string
  }
  | {
    readonly kind: 'user_confirmed'
    readonly logical_workspace_id: string
  }

export interface WorkspaceResolutionInput {
  readonly path: string
  readonly git_remote: string | null
  readonly repository_fingerprint?: string | null
  readonly branch?: string | null
  readonly continuity?: WorkspaceContinuityEvidence
  readonly now: number
}

export interface WorkspaceResolutionCandidate {
  readonly logical_workspace_id: string
  readonly display_name: string
  readonly evidence: readonly Exclude<WorkspaceResolutionBasis, 'first_seen'>[]
}

export type WorkspaceIdentityDelta =
  | {
    readonly kind: 'upsert_logical_workspace'
    readonly workspace: LogicalWorkspace
    readonly expected_revision: number | null
  }
  | {
    readonly kind: 'upsert_workspace_instance'
    readonly instance: WorkspaceInstance
    readonly expected_revision: number | null
  }
  | {
    readonly kind: 'observe_identity_binding'
    readonly binding: WorkspaceIdentityBinding
  }
  | {
    readonly kind: 'record_alias_observation'
    readonly observation: WorkspaceAliasObservation
  }
  | {
    readonly kind: 'deactivate_instance_bindings'
    readonly instance_id: string
    readonly observed_at: number
  }

export type WorkspaceResolutionDecision =
  | Readonly<{
    kind: 'resolved'
    resolution_basis: WorkspaceResolutionBasis
    logical_workspace: LogicalWorkspace
    instance: WorkspaceInstance
    deltas: readonly WorkspaceIdentityDelta[]
  }>
  | Readonly<{
    kind: 'ambiguous'
    candidates: readonly WorkspaceResolutionCandidate[]
    deltas: readonly WorkspaceIdentityDelta[]
  }>

export type WorkspaceInstanceLifecycleDecision =
  | Readonly<{
    kind: 'deactivated'
    logical_workspace_id: string
    instance: WorkspaceInstance
    deltas: readonly WorkspaceIdentityDelta[]
  }>
  | Readonly<{
    kind: 'stale_ignored'
    logical_workspace_id: string
    instance: WorkspaceInstance
    deltas: readonly WorkspaceIdentityDelta[]
  }>
  | Readonly<{
    kind: 'not_found'
    deltas: readonly WorkspaceIdentityDelta[]
  }>

export interface AsrAliasEvidence {
  readonly kind: 'asr_transcript'
  readonly ref: string
  readonly observed_at: number
  readonly confidence?: number
}

export interface UserConfirmedAliasEvidence {
  readonly kind: 'user_confirmed'
  readonly ref: string
  readonly observed_at: number
}

export type AliasLearningEvidence = AsrAliasEvidence | UserConfirmedAliasEvidence

export type AliasCandidateDecision = Readonly<{
  kind: 'candidate_observed'
  durable_binding: false
  routing_allowed: false
  observation: WorkspaceAliasObservation
  deltas: readonly WorkspaceIdentityDelta[]
}>

export type ConfirmedAliasLearningDecision =
  | Readonly<{
    kind: 'alias_bound'
    durable_binding: true
    routing_allowed: false
    observation: WorkspaceAliasObservation
    logical_workspace: LogicalWorkspace
    deltas: readonly WorkspaceIdentityDelta[]
  }>
  | Readonly<{
    kind: 'confirmation_ignored'
    durable_binding: false
    routing_allowed: false
    observation: WorkspaceAliasObservation
    deltas: readonly WorkspaceIdentityDelta[]
  }>

export type AliasLearningDecision = AliasCandidateDecision | ConfirmedAliasLearningDecision

export type AliasSuppressionDecision =
  | Readonly<{
    kind: 'alias_suppressed'
    observation: WorkspaceAliasObservation
    logical_workspace: LogicalWorkspace
    deltas: readonly WorkspaceIdentityDelta[]
  }>
  | Readonly<{
    kind: 'suppression_ignored'
    observation: WorkspaceAliasObservation
    logical_workspace: LogicalWorkspace
    deltas: readonly WorkspaceIdentityDelta[]
  }>

export interface AliasMatch {
  readonly logical_workspace_id: string
  readonly spoken_alias: string
  readonly normalized_alias: string
  readonly match_kind: 'confirmed' | 'candidate'
  readonly confidence: number
  readonly routing_allowed: boolean
}

export type InstanceSelection =
  | Readonly<{kind: 'none'; candidates: readonly WorkspaceInstance[]}>
  | Readonly<{
    kind: 'selected'
    instance: WorkspaceInstance
    candidates: readonly [WorkspaceInstance]
  }>
  | Readonly<{
    kind: 'ambiguous'
    candidates: readonly WorkspaceInstance[]
  }>

export interface WorkspaceIdentityResolverOptions {
  readonly pathPolicy?: SensitivePathPolicy
  readonly contentPolicy?: SensitiveContentPolicy
}

export type WorkspaceIdentityErrorCode =
  | 'IDENTITY_INVALID_INPUT'
  | 'IDENTITY_INVALID_STATE'
  | 'IDENTITY_SENSITIVE_PATH_DENIED'
  | 'IDENTITY_UNKNOWN_INSTANCE'
  | 'IDENTITY_UNKNOWN_LOGICAL_WORKSPACE'
  | 'IDENTITY_EVIDENCE_CONFLICT'
  | 'IDENTITY_REVISION_CONFLICT'

const identityErrorMessages: Readonly<Record<WorkspaceIdentityErrorCode, string>> = {
  IDENTITY_INVALID_INPUT: 'workspace identity input is invalid',
  IDENTITY_INVALID_STATE: 'workspace identity state is invalid',
  IDENTITY_SENSITIVE_PATH_DENIED: 'workspace identity path is denied',
  IDENTITY_UNKNOWN_INSTANCE: 'workspace identity instance is unknown',
  IDENTITY_UNKNOWN_LOGICAL_WORKSPACE: 'logical workspace identity is unknown',
  IDENTITY_EVIDENCE_CONFLICT: 'workspace identity evidence conflicts with prior evidence',
  IDENTITY_REVISION_CONFLICT: 'workspace identity revision conflicts with current state',
}

export class WorkspaceIdentityError extends Error {
  readonly code: WorkspaceIdentityErrorCode

  constructor(code: WorkspaceIdentityErrorCode) {
    super(identityErrorMessages[code])
    this.name = 'WorkspaceIdentityError'
    this.code = code
  }
}

const emptyTuple = Object.freeze([])

const emptyState: WorkspaceIdentityState = freezeState({
  logical_workspaces: [],
  workspace_instances: [],
  bindings: [],
  alias_observations: [],
})

export function emptyWorkspaceIdentityState(): WorkspaceIdentityState {
  return emptyState
}

/**
 * Pure decision engine. It holds a snapshot reference but never mutates it and never performs I/O.
 * Callers persist accepted deltas through the worker client, then construct a resolver over the
 * newly published state.
 */
export class WorkspaceIdentityResolver {
  readonly #state: WorkspaceIdentityState
  readonly #pathPolicy: SensitivePathPolicy
  readonly #contentPolicy: SensitiveContentPolicy

  constructor(state: WorkspaceIdentityState, options: WorkspaceIdentityResolverOptions = {}) {
    this.#state = state
    this.#pathPolicy = options.pathPolicy ?? new SensitivePathPolicy()
    this.#contentPolicy = options.contentPolicy ?? new SensitiveContentPolicy()
  }

  resolve(input: WorkspaceResolutionInput): WorkspaceResolutionDecision {
    const safePath = this.#safePath(input)
    const now = validTimestamp(input.now)
    const gitRemote = safeRemote(input.git_remote, this.#pathPolicy, this.#contentPolicy)
    const remoteKey = gitRemote === null ? null : opaqueKey('remote', gitRemote)
    const repositoryFingerprint = optionalSafeStableValue(
      input.repository_fingerprint,
      'repository_fingerprint',
      this.#pathPolicy,
      this.#contentPolicy,
    )
    const continuity = validContinuity(
      input.continuity,
      this.#pathPolicy,
      this.#contentPolicy,
    )
    const branch = input.branch === undefined
      ? undefined
      : optionalSafeLabel(input.branch, 'branch', this.#pathPolicy, this.#contentPolicy)
    const state = readState(this.#state)

    if (continuity?.kind === 'user_confirmed') {
      const workspace = state.logical_workspaces.find(candidate => (
        candidate.logical_workspace_id === continuity.logical_workspace_id
      ))
      if (workspace === undefined) {
        throw new WorkspaceIdentityError('IDENTITY_UNKNOWN_LOGICAL_WORKSPACE')
      }
      return this.#resolvedDecision({
        state,
        workspace,
        basis: 'user_confirmed',
        safePath,
        gitRemote,
        remoteKey,
        repositoryFingerprint,
        branch,
        now,
      })
    }

    const evidenceByLogicalId = new Map<string, Set<Exclude<WorkspaceResolutionBasis, 'first_seen'>>>()
    if (continuity?.kind === 'prior_instance') {
      const prior = state.workspace_instances.find(instance => (
        instance.instance_id === continuity.instance_id
      ))
      if (prior === undefined) throw new WorkspaceIdentityError('IDENTITY_UNKNOWN_INSTANCE')
      addCandidate(evidenceByLogicalId, prior.logical_workspace_id, 'prior_instance')
    }
    if (repositoryFingerprint !== null) {
      for (const instance of state.workspace_instances) {
        if (instance.repository_fingerprint === repositoryFingerprint) {
          addCandidate(
            evidenceByLogicalId,
            instance.logical_workspace_id,
            'repository_fingerprint',
          )
        }
      }
      for (const binding of state.bindings) {
        if (binding.repository_fingerprint === repositoryFingerprint) {
          addCandidate(
            evidenceByLogicalId,
            binding.logical_workspace_id,
            'repository_fingerprint',
          )
        }
      }
    }
    if (remoteKey !== null) {
      for (const workspace of state.logical_workspaces) {
        const canonicalRemote = safeRemote(
          workspace.canonical_remote,
          this.#pathPolicy,
          this.#contentPolicy,
        )
        if (canonicalRemote !== null && opaqueKey('remote', canonicalRemote) === remoteKey) {
          addCandidate(evidenceByLogicalId, workspace.logical_workspace_id, 'canonical_remote')
        }
      }
      for (const binding of state.bindings) {
        if (binding.remote_key === remoteKey) {
          addCandidate(evidenceByLogicalId, binding.logical_workspace_id, 'canonical_remote')
        }
      }
    }

    const candidates = [...evidenceByLogicalId.entries()]
      .flatMap(([logicalWorkspaceId, evidence]) => {
        const workspace = state.logical_workspaces.find(candidate => (
          candidate.logical_workspace_id === logicalWorkspaceId
        ))
        return workspace === undefined
          ? []
          : [freezeResolutionCandidate(workspace, evidence)]
      })
      .sort((left, right) => compareCodePoints(
        left.logical_workspace_id,
        right.logical_workspace_id,
      ))

    if (candidates.length > 1) {
      return Object.freeze({
        kind: 'ambiguous',
        candidates: Object.freeze(candidates),
        deltas: emptyTuple,
      })
    }
    if (candidates.length === 1) {
      const candidate = candidates[0]!
      const workspace = state.logical_workspaces.find(item => (
        item.logical_workspace_id === candidate.logical_workspace_id
      ))!
      return this.#resolvedDecision({
        state,
        workspace,
        basis: preferredResolutionBasis(candidate.evidence),
        safePath,
        gitRemote,
        remoteKey,
        repositoryFingerprint,
        branch,
        now,
      })
    }

    const logicalWorkspaceSeed = repositoryFingerprint === null
      ? remoteKey === null
        ? ['path', safePath.path_key]
        : ['remote', remoteKey]
      : ['repository', repositoryFingerprint]
    const logicalWorkspaceId = unoccupiedStableId(
      'lw',
      logicalWorkspaceSeed,
      new Set(state.logical_workspaces.map(workspace => workspace.logical_workspace_id)),
    )
    const workspace = freezeLogicalWorkspace({
      logical_workspace_id: logicalWorkspaceId,
      display_name: safePath.path_label,
      aliases: [],
      canonical_remote: gitRemote,
      created_at: now,
      updated_at: now,
      revision: 0,
    })
    return this.#resolvedDecision({
      state,
      workspace,
      basis: 'first_seen',
      safePath,
      gitRemote,
      remoteKey,
      repositoryFingerprint,
      branch,
      now,
      workspaceIsNew: true,
    })
  }

  deactivateInstance(
    instanceId: string,
    nowValue: number,
  ): WorkspaceInstanceLifecycleDecision {
    const safeInstanceId = requiredSafeReference(
      instanceId,
      'instance_id',
      this.#pathPolicy,
      this.#contentPolicy,
    )
    const now = validTimestamp(nowValue)
    const state = readState(this.#state)
    const instance = state.workspace_instances.find(candidate => (
      candidate.instance_id === safeInstanceId
    ))
    if (instance === undefined) {
      return Object.freeze({kind: 'not_found', deltas: emptyTuple})
    }
    if (now <= instance.last_seen_at) {
      return Object.freeze({
        kind: 'stale_ignored',
        logical_workspace_id: instance.logical_workspace_id,
        instance,
        deltas: emptyTuple,
      })
    }
    const inactive = freezeWorkspaceInstance({
      ...instance,
      status: 'inactive',
      last_seen_at: Math.max(instance.last_seen_at, now),
      revision: instance.revision + 1,
    })
    const deltas: WorkspaceIdentityDelta[] = [
      freezeDelta({
        kind: 'upsert_workspace_instance',
        instance: inactive,
        expected_revision: instance.revision,
      }),
      freezeDelta({
        kind: 'deactivate_instance_bindings',
        instance_id: instance.instance_id,
        observed_at: now,
      }),
    ]
    return Object.freeze({
      kind: 'deactivated',
      logical_workspace_id: instance.logical_workspace_id,
      instance: inactive,
      deltas: Object.freeze(deltas),
    })
  }

  matchAlias(spoken: string): readonly AliasMatch[] {
    const alias = safeNormalizedAlias(
      spoken,
      'spoken_alias',
      this.#pathPolicy,
      this.#contentPolicy,
    )
    if (alias === undefined) return Object.freeze([])
    const state = readState(this.#state)
    const logicalIds = new Set<string>()
    for (const workspace of state.logical_workspaces) {
      if (workspace.aliases.some(value => normalizedAlias(value)?.normalized === alias.normalized)) {
        logicalIds.add(workspace.logical_workspace_id)
      }
    }
    for (const observation of state.alias_observations) {
      if (observation.normalized_alias === alias.normalized) {
        logicalIds.add(observation.logical_workspace_id)
      }
    }

    const matches: Omit<AliasMatch, 'routing_allowed'>[] = []
    for (const logicalWorkspaceId of [...logicalIds].sort(compareCodePoints)) {
      const workspace = state.logical_workspaces.find(candidate => (
        candidate.logical_workspace_id === logicalWorkspaceId
      ))
      if (workspace === undefined) continue
      const observations = state.alias_observations.filter(observation => (
        observation.logical_workspace_id === logicalWorkspaceId
        && observation.normalized_alias === alias.normalized
      ))
      const latestSuppression = latestAliasObservation(observations, 'suppressed')
      const latestConfirmation = latestAliasObservation(observations, 'confirmed')
      const boundAlias = workspace.aliases.find(value => (
        normalizedAlias(value)?.normalized === alias.normalized
      ))
      const confirmationSurvives = boundAlias !== undefined && (
        latestSuppression === undefined
        || (latestConfirmation?.observed_at ?? workspace.updated_at) > latestSuppression.observed_at
      )
      if (confirmationSurvives) {
        matches.push({
          logical_workspace_id: logicalWorkspaceId,
          spoken_alias: boundAlias,
          normalized_alias: alias.normalized,
          match_kind: 'confirmed',
          confidence: 1,
        })
        continue
      }
      if (latestSuppression !== undefined) continue
      const candidates = observations.filter(observation => observation.status === 'candidate')
      if (candidates.length === 0) continue
      const newest = latestObservation(candidates)!
      matches.push({
        logical_workspace_id: logicalWorkspaceId,
        spoken_alias: newest.spoken_alias,
        normalized_alias: alias.normalized,
        match_kind: 'candidate',
        confidence: Math.min(
          ASR_ALIAS_CONFIDENCE_CAP,
          Math.max(...candidates.map(candidate => candidate.confidence)),
        ),
      })
    }

    const routingAllowed = matches.length === 1 && matches[0]?.match_kind === 'confirmed'
    return Object.freeze(matches.map(match => Object.freeze({
      ...match,
      routing_allowed: routingAllowed,
    })))
  }

  learnAlias(
    logicalWorkspaceId: string,
    spoken: string,
    evidence: UserConfirmedAliasEvidence,
  ): ConfirmedAliasLearningDecision {
    if (evidence?.kind !== 'user_confirmed') {
      throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
    }
    const decision = this.#learnOrObserveAlias(logicalWorkspaceId, spoken, evidence)
    if (decision.kind === 'candidate_observed') {
      throw new WorkspaceIdentityError('IDENTITY_INVALID_STATE')
    }
    return decision
  }

  observeAliasCandidate(
    logicalWorkspaceId: string,
    spoken: string,
    evidence: AsrAliasEvidence,
  ): AliasCandidateDecision {
    if (evidence?.kind !== 'asr_transcript') {
      throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
    }
    const decision = this.#learnOrObserveAlias(logicalWorkspaceId, spoken, evidence)
    if (decision.kind !== 'candidate_observed') {
      throw new WorkspaceIdentityError('IDENTITY_INVALID_STATE')
    }
    return decision
  }

  #learnOrObserveAlias(
    logicalWorkspaceId: string,
    spoken: string,
    evidence: AliasLearningEvidence,
  ): AliasLearningDecision {
    const safeLogicalWorkspaceId = requiredSafeReference(
      logicalWorkspaceId,
      'logical_workspace_id',
      this.#pathPolicy,
      this.#contentPolicy,
    )
    const alias = requiredSafeAlias(
      spoken,
      this.#pathPolicy,
      this.#contentPolicy,
    )
    const validEvidence = validAliasEvidence(
      evidence,
      this.#pathPolicy,
      this.#contentPolicy,
    )
    const state = readState(this.#state)
    const workspace = state.logical_workspaces.find(candidate => (
      candidate.logical_workspace_id === safeLogicalWorkspaceId
    ))
    if (workspace === undefined) {
      throw new WorkspaceIdentityError('IDENTITY_UNKNOWN_LOGICAL_WORKSPACE')
    }
    const status = validEvidence.kind === 'user_confirmed' ? 'confirmed' : 'candidate'
    const confidence = validEvidence.kind === 'user_confirmed'
      ? 1
      : Math.min(ASR_ALIAS_CONFIDENCE_CAP, validEvidence.confidence)
    const observation = freezeAliasObservation({
      observation_id: stableId('wao', [
        logicalWorkspaceId,
        alias.normalized,
        validEvidence.kind,
        validEvidence.ref,
      ]),
      logical_workspace_id: logicalWorkspaceId,
      spoken_alias: alias.display,
      normalized_alias: alias.normalized,
      status,
      confidence,
      evidence_ref: validEvidence.ref,
      observed_at: validEvidence.observed_at,
    })
    const existingEvidence = state.alias_observations.find(candidate => (
      candidate.evidence_ref === validEvidence.ref
    ))
    if (existingEvidence !== undefined && !sameAliasObservation(existingEvidence, observation)) {
      throw new WorkspaceIdentityError('IDENTITY_EVIDENCE_CONFLICT')
    }
    const recordedObservation = existingEvidence ?? observation
    const observationDeltas: readonly WorkspaceIdentityDelta[] = existingEvidence === undefined
      ? Object.freeze([freezeDelta({kind: 'record_alias_observation', observation})])
      : emptyTuple

    if (validEvidence.kind === 'asr_transcript') {
      return Object.freeze({
        kind: 'candidate_observed',
        durable_binding: false,
        routing_allowed: false,
        observation: recordedObservation,
        deltas: observationDeltas,
      })
    }

    const observations = state.alias_observations.filter(candidate => (
      candidate.logical_workspace_id === logicalWorkspaceId
      && candidate.normalized_alias === alias.normalized
    ))
    const latestSuppression = latestAliasObservation(observations, 'suppressed')
    const latestConfirmation = latestAliasObservation(observations, 'confirmed')
    const currentlyBound = workspace.aliases.some(value => (
      normalizedAlias(value)?.normalized === alias.normalized
    ))
    const latestBoundAt = latestConfirmation?.observed_at
      ?? (currentlyBound ? workspace.updated_at : undefined)
    if (
      (latestSuppression !== undefined
        && validEvidence.observed_at <= latestSuppression.observed_at)
      || (latestBoundAt !== undefined && validEvidence.observed_at <= latestBoundAt)
    ) {
      return Object.freeze({
        kind: 'confirmation_ignored',
        durable_binding: false,
        routing_allowed: false,
        observation: recordedObservation,
        deltas: observationDeltas,
      })
    }

    const aliases = workspace.aliases.filter(value => (
      normalizedAlias(value)?.normalized !== alias.normalized
    ))
    aliases.push(alias.display)
    aliases.sort(compareCodePoints)
    const updated = freezeLogicalWorkspace({
      ...workspace,
      aliases,
      updated_at: Math.max(workspace.updated_at, validEvidence.observed_at),
      revision: workspace.revision + 1,
    })
    const deltas: WorkspaceIdentityDelta[] = [
      freezeDelta({
        kind: 'upsert_logical_workspace',
        workspace: updated,
        expected_revision: workspace.revision,
      }),
      ...observationDeltas,
    ]
    return Object.freeze({
      kind: 'alias_bound',
      durable_binding: true,
      routing_allowed: false,
      observation: recordedObservation,
      logical_workspace: updated,
      deltas: Object.freeze(deltas),
    })
  }

  suppressAlias(
    logicalWorkspaceId: string,
    spoken: string,
    evidence: UserConfirmedAliasEvidence,
  ): AliasSuppressionDecision {
    const safeLogicalWorkspaceId = requiredSafeReference(
      logicalWorkspaceId,
      'logical_workspace_id',
      this.#pathPolicy,
      this.#contentPolicy,
    )
    const alias = requiredSafeAlias(
      spoken,
      this.#pathPolicy,
      this.#contentPolicy,
    )
    const validEvidence = validAliasEvidence(
      evidence,
      this.#pathPolicy,
      this.#contentPolicy,
    )
    if (validEvidence.kind !== 'user_confirmed') {
      throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
    }
    const state = readState(this.#state)
    const workspace = state.logical_workspaces.find(candidate => (
      candidate.logical_workspace_id === safeLogicalWorkspaceId
    ))
    if (workspace === undefined) {
      throw new WorkspaceIdentityError('IDENTITY_UNKNOWN_LOGICAL_WORKSPACE')
    }
    const observation = freezeAliasObservation({
      observation_id: stableId('wao', [
        logicalWorkspaceId,
        alias.normalized,
        'suppressed',
        validEvidence.ref,
      ]),
      logical_workspace_id: logicalWorkspaceId,
      spoken_alias: alias.display,
      normalized_alias: alias.normalized,
      status: 'suppressed',
      confidence: 1,
      evidence_ref: validEvidence.ref,
      observed_at: validEvidence.observed_at,
    })
    const existingEvidence = state.alias_observations.find(candidate => (
      candidate.evidence_ref === validEvidence.ref
    ))
    if (existingEvidence !== undefined && !sameAliasObservation(existingEvidence, observation)) {
      throw new WorkspaceIdentityError('IDENTITY_EVIDENCE_CONFLICT')
    }
    if (existingEvidence !== undefined) {
      return Object.freeze({
        kind: 'suppression_ignored',
        observation: existingEvidence,
        logical_workspace: workspace,
        deltas: emptyTuple,
      })
    }
    const observations = state.alias_observations.filter(candidate => (
      candidate.logical_workspace_id === safeLogicalWorkspaceId
      && candidate.normalized_alias === alias.normalized
    ))
    const latestConfirmation = latestAliasObservation(observations, 'confirmed')
    const currentlyBound = workspace.aliases.some(value => (
      normalizedAlias(value)?.normalized === alias.normalized
    ))
    const latestBoundAt = latestConfirmation?.observed_at
      ?? (currentlyBound ? workspace.updated_at : undefined)
    const observationDelta = freezeDelta({kind: 'record_alias_observation', observation})
    if (latestBoundAt !== undefined && validEvidence.observed_at <= latestBoundAt) {
      return Object.freeze({
        kind: 'suppression_ignored',
        observation,
        logical_workspace: workspace,
        deltas: Object.freeze([observationDelta]),
      })
    }
    const updated = freezeLogicalWorkspace({
      ...workspace,
      aliases: workspace.aliases.filter(value => (
        normalizedAlias(value)?.normalized !== alias.normalized
      )),
      updated_at: Math.max(workspace.updated_at, validEvidence.observed_at),
      revision: workspace.revision + 1,
    })
    const deltas: WorkspaceIdentityDelta[] = [
      freezeDelta({
        kind: 'upsert_logical_workspace',
        workspace: updated,
        expected_revision: workspace.revision,
      }),
      observationDelta,
    ]
    return Object.freeze({
      kind: 'alias_suppressed',
      observation,
      logical_workspace: updated,
      deltas: Object.freeze(deltas),
    })
  }

  #resolvedDecision(input: {
    readonly state: WorkspaceIdentityState
    readonly workspace: LogicalWorkspace
    readonly basis: WorkspaceResolutionBasis
    readonly safePath: SafePath
    readonly gitRemote: string | null
    readonly remoteKey: string | null
    readonly repositoryFingerprint: string | null
    readonly branch: string | null | undefined
    readonly now: number
    readonly workspaceIsNew?: boolean
  }): WorkspaceResolutionDecision {
    const instanceId = stableId('wi', [
      input.workspace.logical_workspace_id,
      input.safePath.path_key,
    ])
    const existing = input.state.workspace_instances.find(instance => (
      instance.instance_id === instanceId
      && instance.logical_workspace_id === input.workspace.logical_workspace_id
    ))
    if (existing !== undefined && input.now <= existing.last_seen_at) {
      return Object.freeze({
        kind: 'resolved',
        resolution_basis: input.basis,
        logical_workspace: input.workspace,
        instance: existing,
        deltas: emptyTuple,
      })
    }
    const logicalWorkspace = input.workspaceIsNew === true
      ? input.workspace
      : updatedLogicalWorkspace(input.workspace, input.gitRemote, input.now)
    const instance = freezeWorkspaceInstance({
      instance_id: instanceId,
      logical_workspace_id: logicalWorkspace.logical_workspace_id,
      display_name: input.safePath.path_label,
      path_label: input.safePath.path_label,
      branch: input.branch === undefined ? existing?.branch ?? null : input.branch,
      repository_fingerprint: input.repositoryFingerprint ?? existing?.repository_fingerprint ?? null,
      status: 'active',
      first_seen_at: existing?.first_seen_at ?? input.now,
      last_seen_at: Math.max(existing?.last_seen_at ?? input.now, input.now),
      revision: existing === undefined ? 0 : existing.revision + 1,
    })
    const existingBinding = input.state.bindings.find(binding => (
      binding.instance_id === instanceId
      && binding.path_key === input.safePath.path_key
      && binding.remote_key === input.remoteKey
      && binding.repository_fingerprint === instance.repository_fingerprint
    ))
    const binding = freezeBinding({
      binding_id: stableId('wib', [
        logicalWorkspace.logical_workspace_id,
        instanceId,
        input.safePath.path_key,
        input.remoteKey ?? '',
        instance.repository_fingerprint ?? '',
      ]),
      logical_workspace_id: logicalWorkspace.logical_workspace_id,
      instance_id: instanceId,
      path_key: input.safePath.path_key,
      remote_key: input.remoteKey,
      repository_fingerprint: instance.repository_fingerprint,
      status: 'active',
      first_seen_at: existingBinding?.first_seen_at ?? input.now,
      last_seen_at: Math.max(existingBinding?.last_seen_at ?? input.now, input.now),
    })
    const deltas: WorkspaceIdentityDelta[] = []
    if (input.workspaceIsNew === true || logicalWorkspace !== input.workspace) {
      deltas.push(freezeDelta({
        kind: 'upsert_logical_workspace',
        workspace: logicalWorkspace,
        expected_revision: input.workspaceIsNew === true ? null : input.workspace.revision,
      }))
    }
    deltas.push(
      freezeDelta({
        kind: 'upsert_workspace_instance',
        instance,
        expected_revision: existing?.revision ?? null,
      }),
      freezeDelta({kind: 'observe_identity_binding', binding}),
    )
    return Object.freeze({
      kind: 'resolved',
      resolution_basis: input.basis,
      logical_workspace: logicalWorkspace,
      instance,
      deltas: Object.freeze(deltas),
    })
  }

  #safePath(input: WorkspaceResolutionInput): SafePath {
    const path = input.path
    if (
      typeof path !== 'string'
      || !isWellFormed(path)
    ) {
      throw new WorkspaceIdentityError('IDENTITY_SENSITIVE_PATH_DENIED')
    }
    const normalizedPath = normalizeNfkcPinned(path)
    if (!this.#pathPolicy.allows(path) || !this.#pathPolicy.allows(normalizedPath)) {
      throw new WorkspaceIdentityError('IDENTITY_SENSITIVE_PATH_DENIED')
    }
    assertSafeIdentityText(
      'workspace_path',
      normalizedPath,
      this.#pathPolicy,
      this.#contentPolicy,
    )
    const pathLabel = this.#pathPolicy.redactLabel(normalizedPath)
    const displayLabel = pathLabel === null ? undefined : normalizedLabel(pathLabel)
    if (displayLabel === undefined) {
      throw new WorkspaceIdentityError('IDENTITY_SENSITIVE_PATH_DENIED')
    }
    const canonicalPath = isWindowsStyleAbsolute(path)
      ? casefoldLikePython(win32.normalize(path))
      : posix.normalize(path)
    return Object.freeze({
      path_key: opaqueKey('path', canonicalPath),
      path_label: displayLabel,
    })
  }
}

/** Applies already accepted deltas to a snapshot without mutating either input. */
export function applyWorkspaceIdentityDeltas(
  stateValue: WorkspaceIdentityState,
  deltas: readonly WorkspaceIdentityDelta[],
): WorkspaceIdentityState {
  const state = readState(stateValue)
  const logicalWorkspaces = new Map(state.logical_workspaces.map(workspace => (
    [workspace.logical_workspace_id, workspace] as const
  )))
  const workspaceInstances = new Map(state.workspace_instances.map(instance => (
    [instance.instance_id, instance] as const
  )))
  const bindings = new Map(state.bindings.map(binding => [binding.binding_id, binding] as const))
  const aliasObservations = new Map(state.alias_observations.map(observation => (
    [observation.observation_id, observation] as const
  )))

  for (const delta of deltas) {
    switch (delta.kind) {
      case 'upsert_logical_workspace': {
        const current = logicalWorkspaces.get(delta.workspace.logical_workspace_id)
        if (revisionedUpsertShouldWrite(
          current,
          delta.workspace,
          delta.expected_revision,
          sameLogicalWorkspace,
        )) {
          logicalWorkspaces.set(delta.workspace.logical_workspace_id, delta.workspace)
        }
        break
      }
      case 'upsert_workspace_instance': {
        const current = workspaceInstances.get(delta.instance.instance_id)
        if (revisionedUpsertShouldWrite(
          current,
          delta.instance,
          delta.expected_revision,
          sameWorkspaceInstance,
        )) {
          workspaceInstances.set(delta.instance.instance_id, delta.instance)
        }
        break
      }
      case 'observe_identity_binding':
        bindings.set(delta.binding.binding_id, delta.binding)
        break
      case 'record_alias_observation': {
        const byId = aliasObservations.get(delta.observation.observation_id)
        const byEvidence = [...aliasObservations.values()].find(observation => (
          observation.evidence_ref === delta.observation.evidence_ref
        ))
        if (
          (byId !== undefined && !sameAliasObservation(byId, delta.observation))
          || (byEvidence !== undefined && !sameAliasObservation(byEvidence, delta.observation))
        ) {
          throw new WorkspaceIdentityError('IDENTITY_EVIDENCE_CONFLICT')
        }
        if (byId === undefined && byEvidence === undefined) {
          aliasObservations.set(delta.observation.observation_id, delta.observation)
        }
        break
      }
      case 'deactivate_instance_bindings':
        for (const [bindingId, binding] of bindings) {
          if (binding.instance_id !== delta.instance_id) continue
          bindings.set(bindingId, freezeBinding({
            ...binding,
            status: 'inactive',
            last_seen_at: Math.max(binding.last_seen_at, delta.observed_at),
          }))
        }
        break
    }
  }

  return freezeState({
    logical_workspaces: [...logicalWorkspaces.values()].sort((left, right) => compareCodePoints(
      left.logical_workspace_id,
      right.logical_workspace_id,
    )),
    workspace_instances: [...workspaceInstances.values()].sort((left, right) => compareCodePoints(
      left.instance_id,
      right.instance_id,
    )),
    bindings: [...bindings.values()].sort((left, right) => compareCodePoints(
      left.binding_id,
      right.binding_id,
    )),
    alias_observations: [...aliasObservations.values()].sort(compareAliasObservations),
  })
}

export function selectInstance(
  logicalWorkspaceId: string,
  candidates: readonly WorkspaceInstance[],
): InstanceSelection {
  const active = [...new Map(candidates
    .filter(candidate => (
      candidate.logical_workspace_id === logicalWorkspaceId
      && candidate.status === 'active'
    ))
    .map(candidate => [candidate.instance_id, candidate] as const)).values()]
    .sort((left, right) => compareCodePoints(left.instance_id, right.instance_id))
  if (active.length === 0) {
    return Object.freeze({kind: 'none', candidates: emptyTuple})
  }
  if (active.length === 1) {
    const tuple = Object.freeze([active[0]!]) as readonly [WorkspaceInstance]
    return Object.freeze({kind: 'selected', instance: active[0]!, candidates: tuple})
  }
  return Object.freeze({kind: 'ambiguous', candidates: Object.freeze(active)})
}

interface SafePath {
  readonly path_key: string
  readonly path_label: string
}

interface NormalizedAlias {
  readonly display: string
  readonly normalized: string
}

function isWindowsStyleAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\')
}

function updatedLogicalWorkspace(
  workspace: LogicalWorkspace,
  gitRemote: string | null,
  now: number,
): LogicalWorkspace {
  const canonicalRemote = gitRemote !== null && now > workspace.updated_at
    ? gitRemote
    : workspace.canonical_remote
  const updatedAt = Math.max(workspace.updated_at, now)
  if (canonicalRemote === workspace.canonical_remote && updatedAt === workspace.updated_at) {
    return workspace
  }
  return freezeLogicalWorkspace({
    ...workspace,
    canonical_remote: canonicalRemote,
    updated_at: updatedAt,
    revision: workspace.revision + 1,
  })
}

function readState(state: WorkspaceIdentityState): WorkspaceIdentityState {
  try {
    if (
      !Array.isArray(state.logical_workspaces)
      || !Array.isArray(state.workspace_instances)
      || !Array.isArray(state.bindings)
      || !Array.isArray(state.alias_observations)
    ) {
      throw new WorkspaceIdentityError('IDENTITY_INVALID_STATE')
    }
    return state
  } catch (error) {
    if (error instanceof WorkspaceIdentityError) throw error
    throw new WorkspaceIdentityError('IDENTITY_INVALID_STATE')
  }
}

function validTimestamp(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
  }
  return value
}

function validContinuity(
  value: WorkspaceContinuityEvidence | undefined,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): WorkspaceContinuityEvidence | undefined {
  if (value === undefined) return undefined
  if (
    value.kind === 'prior_instance'
    && typeof value.instance_id === 'string'
    && value.instance_id !== ''
  ) {
    return Object.freeze({
      kind: 'prior_instance',
      instance_id: requiredSafeReference(
        value.instance_id,
        'instance_id',
        pathPolicy,
        contentPolicy,
      ),
    })
  }
  if (
    value.kind === 'user_confirmed'
    && typeof value.logical_workspace_id === 'string'
    && value.logical_workspace_id !== ''
  ) {
    return Object.freeze({
      kind: 'user_confirmed',
      logical_workspace_id: requiredSafeReference(
        value.logical_workspace_id,
        'logical_workspace_id',
        pathPolicy,
        contentPolicy,
      ),
    })
  }
  throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
}

function optionalSafeStableValue(
  value: string | null | undefined,
  field: string,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !isWellFormed(value)) {
    throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
  }
  const normalized = stripLikePython(value)
  if (normalized === '' || normalized.includes('\u0000')) {
    throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
  }
  assertSafeIdentityText(field, normalized, pathPolicy, contentPolicy)
  return normalized
}

function optionalSafeLabel(
  value: string | null,
  field: string,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): string | null {
  if (value === null) return null
  const label = normalizedLabel(value)
  if (label === undefined) throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
  assertSafeIdentityText(field, value, pathPolicy, contentPolicy)
  return label
}

function normalizedLabel(value: string): string | undefined {
  if (typeof value !== 'string' || !isWellFormed(value)) return undefined
  const display = stripLikePython(collapsePythonWhitespace(normalizeNfkcPinned(value)))
  return display !== '' && display.length <= 239 && !display.includes('\u0000')
    ? display
    : undefined
}

function safeRemote(
  value: string | null,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !isWellFormed(value)) {
    throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
  }
  assertSafeIdentityText('git_remote', value, pathPolicy, contentPolicy)
  const normalized = normalizedLabel(value)
  if (normalized === undefined) throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
  return normalized
}

function normalizedAlias(value: string): NormalizedAlias | undefined {
  const display = normalizedLabel(value)
  if (display === undefined) return undefined
  return Object.freeze({display, normalized: casefoldLikePython(display)})
}

function safeNormalizedAlias(
  value: string,
  field: string,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): NormalizedAlias | undefined {
  const alias = normalizedAlias(value)
  if (alias === undefined) return undefined
  assertSafeIdentityText(field, value, pathPolicy, contentPolicy)
  return alias
}

function requiredSafeAlias(
  value: string,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): NormalizedAlias {
  const alias = safeNormalizedAlias(value, 'spoken_alias', pathPolicy, contentPolicy)
  if (alias === undefined) throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
  return alias
}

function validAliasEvidence(
  evidence: AliasLearningEvidence,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): Required<AsrAliasEvidence> | UserConfirmedAliasEvidence {
  if (
    (evidence.kind !== 'asr_transcript' && evidence.kind !== 'user_confirmed')
    || typeof evidence.ref !== 'string'
    || evidence.ref === ''
    || !isWellFormed(evidence.ref)
  ) {
    throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
  }
  assertSafeIdentityText('evidence_ref', evidence.ref, pathPolicy, contentPolicy)
  const observedAt = validTimestamp(evidence.observed_at)
  if (evidence.kind === 'user_confirmed') {
    return Object.freeze({...evidence, observed_at: observedAt})
  }
  const confidence = evidence.confidence ?? ASR_ALIAS_CONFIDENCE_CAP
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0) {
    throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
  }
  return Object.freeze({
    ...evidence,
    observed_at: observedAt,
    confidence: Math.min(ASR_ALIAS_CONFIDENCE_CAP, confidence),
  })
}

function requiredSafeReference(
  value: string,
  field: string,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): string {
  if (
    typeof value !== 'string'
    || !isWellFormed(value)
    || stripLikePython(value) === ''
    || value.includes('\u0000')
  ) {
    throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
  }
  assertSafeIdentityText(field, value, pathPolicy, contentPolicy)
  return value
}

function assertSafeIdentityText(
  field: string,
  value: string,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): void {
  const normalized = normalizeNfkcPinned(value)
  const variants = normalized === value ? [value] : [value, normalized]
  for (const variant of variants) {
    if (pathPolicy.scrubText(field, variant).kind !== 'clean') {
      throw new WorkspaceIdentityError('IDENTITY_SENSITIVE_PATH_DENIED')
    }
    if (contentPolicy.scrub(field, variant).kind !== 'clean') {
      throw new WorkspaceIdentityError('IDENTITY_INVALID_INPUT')
    }
  }
}

function addCandidate(
  candidates: Map<string, Set<Exclude<WorkspaceResolutionBasis, 'first_seen'>>>,
  logicalWorkspaceId: string,
  basis: Exclude<WorkspaceResolutionBasis, 'first_seen'>,
): void {
  const evidence = candidates.get(logicalWorkspaceId) ?? new Set()
  evidence.add(basis)
  candidates.set(logicalWorkspaceId, evidence)
}

const resolutionBasisOrder: readonly Exclude<WorkspaceResolutionBasis, 'first_seen'>[] = [
  'user_confirmed',
  'prior_instance',
  'repository_fingerprint',
  'canonical_remote',
]

function preferredResolutionBasis(
  evidence: readonly Exclude<WorkspaceResolutionBasis, 'first_seen'>[],
): Exclude<WorkspaceResolutionBasis, 'first_seen'> {
  return resolutionBasisOrder.find(candidate => evidence.includes(candidate)) ?? 'canonical_remote'
}

function freezeResolutionCandidate(
  workspace: LogicalWorkspace,
  evidence: ReadonlySet<Exclude<WorkspaceResolutionBasis, 'first_seen'>>,
): WorkspaceResolutionCandidate {
  return Object.freeze({
    logical_workspace_id: workspace.logical_workspace_id,
    display_name: workspace.display_name,
    evidence: Object.freeze(resolutionBasisOrder.filter(candidate => evidence.has(candidate))),
  })
}

function latestAliasObservation(
  observations: readonly WorkspaceAliasObservation[],
  status: WorkspaceAliasObservationStatus,
): WorkspaceAliasObservation | undefined {
  return latestObservation(observations.filter(observation => observation.status === status))
}

function latestObservation(
  observations: readonly WorkspaceAliasObservation[],
): WorkspaceAliasObservation | undefined {
  return [...observations].sort((left, right) => (
    right.observed_at - left.observed_at
    || compareCodePoints(right.observation_id, left.observation_id)
  ))[0]
}

function compareAliasObservations(
  left: WorkspaceAliasObservation,
  right: WorkspaceAliasObservation,
): number {
  return left.observed_at - right.observed_at
    || compareCodePoints(left.observation_id, right.observation_id)
}

function revisionedUpsertShouldWrite<Value extends {readonly revision: number}>(
  current: Value | undefined,
  next: Value,
  expectedRevision: number | null,
  sameValue: (left: Value, right: Value) => boolean,
): boolean {
  if (current !== undefined && sameValue(current, next)) return false
  const validNew = current === undefined
    && expectedRevision === null
    && next.revision === 0
  const validUpdate = current !== undefined
    && expectedRevision !== null
    && current.revision === expectedRevision
    && next.revision === expectedRevision + 1
  if (!validNew && !validUpdate) {
    throw new WorkspaceIdentityError('IDENTITY_REVISION_CONFLICT')
  }
  return true
}

function sameLogicalWorkspace(left: LogicalWorkspace, right: LogicalWorkspace): boolean {
  return left.logical_workspace_id === right.logical_workspace_id
    && left.display_name === right.display_name
    && sameStrings(left.aliases, right.aliases)
    && left.canonical_remote === right.canonical_remote
    && left.created_at === right.created_at
    && left.updated_at === right.updated_at
    && left.revision === right.revision
}

function sameWorkspaceInstance(left: WorkspaceInstance, right: WorkspaceInstance): boolean {
  return left.instance_id === right.instance_id
    && left.logical_workspace_id === right.logical_workspace_id
    && left.display_name === right.display_name
    && left.path_label === right.path_label
    && left.branch === right.branch
    && left.repository_fingerprint === right.repository_fingerprint
    && left.status === right.status
    && left.first_seen_at === right.first_seen_at
    && left.last_seen_at === right.last_seen_at
    && left.revision === right.revision
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameAliasObservation(
  left: WorkspaceAliasObservation,
  right: WorkspaceAliasObservation,
): boolean {
  return left.observation_id === right.observation_id
    && left.logical_workspace_id === right.logical_workspace_id
    && left.spoken_alias === right.spoken_alias
    && left.normalized_alias === right.normalized_alias
    && left.status === right.status
    && left.confidence === right.confidence
    && left.evidence_ref === right.evidence_ref
    && left.observed_at === right.observed_at
}

function opaqueKey(namespace: string, value: string): string {
  return stableId(`wk-${namespace}`, [value])
}

function stableId(prefix: string, components: readonly string[]): string {
  const digest = createHash('sha256')
    .update(canonicalJson(components), 'utf8')
    .digest('hex')
  return `${prefix}-${digest.slice(0, 32)}`
}

function unoccupiedStableId(
  prefix: string,
  components: readonly string[],
  occupied: ReadonlySet<string>,
): string {
  let collisionMarker = ''
  for (;;) {
    const candidate = stableId(
      prefix,
      collisionMarker === '' ? components : [...components, collisionMarker],
    )
    if (!occupied.has(candidate)) return candidate
    collisionMarker += '#'
  }
}

function freezeLogicalWorkspace(workspace: LogicalWorkspace): LogicalWorkspace {
  const aliases = [...workspace.aliases]
  Object.freeze(aliases)
  return Object.freeze({...workspace, aliases})
}

function freezeWorkspaceInstance(instance: WorkspaceInstance): WorkspaceInstance {
  return Object.freeze(instance)
}

function freezeBinding(binding: WorkspaceIdentityBinding): WorkspaceIdentityBinding {
  return Object.freeze(binding)
}

function freezeAliasObservation(
  observation: WorkspaceAliasObservation,
): WorkspaceAliasObservation {
  return Object.freeze(observation)
}

function freezeDelta<Delta extends WorkspaceIdentityDelta>(delta: Delta): Delta {
  return Object.freeze(delta)
}

function freezeState(state: WorkspaceIdentityState): WorkspaceIdentityState {
  return Object.freeze({
    logical_workspaces: Object.freeze([...state.logical_workspaces]),
    workspace_instances: Object.freeze([...state.workspace_instances]),
    bindings: Object.freeze([...state.bindings]),
    alias_observations: Object.freeze([...state.alias_observations]),
  })
}
