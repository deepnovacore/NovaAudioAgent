import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
  ASR_ALIAS_CONFIDENCE_CAP,
  WorkspaceIdentityError,
  WorkspaceIdentityResolver,
  applyWorkspaceIdentityDeltas,
  emptyWorkspaceIdentityState,
  selectInstance,
  type WorkspaceIdentityState,
  type WorkspaceResolutionDecision,
} from '../src/workspace-graph/identity.js'
import {
  WorkspaceInstanceSchema,
  type LogicalWorkspace,
  type WorkspaceInstance,
} from '../src/workspace-graph/models.js'
import {SensitivePathPolicy} from '../src/workspace-graph/sensitivity.js'

function requireResolved(
  decision: WorkspaceResolutionDecision,
): Extract<WorkspaceResolutionDecision, {readonly kind: 'resolved'}> {
  if (decision.kind !== 'resolved') throw new Error(`expected resolved, received ${decision.kind}`)
  return decision
}

function logicalWorkspace(
  logicalWorkspaceId: string,
  canonicalRemote: string | null = null,
  aliases: readonly string[] = [],
): LogicalWorkspace {
  return Object.freeze({
    logical_workspace_id: logicalWorkspaceId,
    display_name: logicalWorkspaceId,
    aliases: [...aliases],
    canonical_remote: canonicalRemote,
    created_at: 1,
    updated_at: 1,
    revision: 0,
  })
}

function workspaceInstance(
  instanceId: string,
  logicalWorkspaceId: string,
  repositoryFingerprint: string | null,
  status: WorkspaceInstance['status'] = 'active',
): WorkspaceInstance {
  return Object.freeze({
    instance_id: instanceId,
    logical_workspace_id: logicalWorkspaceId,
    display_name: instanceId,
    path_label: instanceId,
    branch: null,
    repository_fingerprint: repositoryFingerprint,
    status,
    first_seen_at: 1,
    last_seen_at: 1,
    revision: 0,
  })
}

function identityState(
  logicalWorkspaces: readonly LogicalWorkspace[],
  workspaceInstances: readonly WorkspaceInstance[] = [],
): WorkspaceIdentityState {
  return Object.freeze({
    logical_workspaces: Object.freeze([...logicalWorkspaces]),
    workspace_instances: Object.freeze([...workspaceInstances]),
    bindings: Object.freeze([]),
    alias_observations: Object.freeze([]),
  })
}

test('move and remote change retain logical identity with a known repository fingerprint', () => {
  const initialState = emptyWorkspaceIdentityState()
  const first = requireResolved(new WorkspaceIdentityResolver(initialState).resolve({
    path: '/work/a',
    git_remote: 'git@example/a.git',
    repository_fingerprint: 'repository-a',
    branch: 'main',
    now: 1,
  }))
  const afterFirst = applyWorkspaceIdentityDeltas(initialState, first.deltas)

  const moved = requireResolved(new WorkspaceIdentityResolver(afterFirst).resolve({
    path: '/work/renamed',
    git_remote: 'git@example/new.git',
    repository_fingerprint: 'repository-a',
    branch: 'main',
    now: 2,
  }))

  assert.equal(moved.logical_workspace.logical_workspace_id, first.logical_workspace.logical_workspace_id)
  assert.notEqual(moved.instance.instance_id, first.instance.instance_id)
  assert.equal(moved.resolution_basis, 'repository_fingerprint')
})

test('explicit prior-instance evidence retains identity across a move and remote change', () => {
  const initialState = emptyWorkspaceIdentityState()
  const first = requireResolved(new WorkspaceIdentityResolver(initialState).resolve({
    path: '/work/a',
    git_remote: 'git@example/a.git',
    now: 1,
  }))
  const afterFirst = applyWorkspaceIdentityDeltas(initialState, first.deltas)

  const moved = requireResolved(new WorkspaceIdentityResolver(afterFirst).resolve({
    path: '/archive/renamed',
    git_remote: 'git@example/new.git',
    continuity: {kind: 'prior_instance', instance_id: first.instance.instance_id},
    now: 2,
  }))

  assert.equal(moved.logical_workspace.logical_workspace_id, first.logical_workspace.logical_workspace_id)
  assert.notEqual(moved.instance.instance_id, first.instance.instance_id)
  assert.equal(moved.resolution_basis, 'prior_instance')
})

test('user-confirmed logical identity overrides conflicting path and remote evidence', () => {
  const state = identityState([
    logicalWorkspace('lw-confirmed', 'git@example/old.git'),
    logicalWorkspace('lw-remote-owner', 'git@example/new.git'),
  ])

  const decision = requireResolved(new WorkspaceIdentityResolver(state).resolve({
    path: '/moved/repository',
    git_remote: 'git@example/new.git',
    continuity: {kind: 'user_confirmed', logical_workspace_id: 'lw-confirmed'},
    now: 2,
  }))

  assert.equal(decision.logical_workspace.logical_workspace_id, 'lw-confirmed')
  assert.equal(decision.resolution_basis, 'user_confirmed')
})

test('simultaneous path and remote change without continuity evidence creates a new logical workspace', () => {
  const initialState = emptyWorkspaceIdentityState()
  const first = requireResolved(new WorkspaceIdentityResolver(initialState).resolve({
    path: '/work/a',
    git_remote: 'git@example/a.git',
    now: 1,
  }))
  const afterFirst = applyWorkspaceIdentityDeltas(initialState, first.deltas)

  const unrelated = requireResolved(new WorkspaceIdentityResolver(afterFirst).resolve({
    path: '/other/a',
    git_remote: 'git@example/new.git',
    now: 2,
  }))

  assert.notEqual(unrelated.logical_workspace.logical_workspace_id, first.logical_workspace.logical_workspace_id)
  assert.equal(unrelated.resolution_basis, 'first_seen')
})

test('an exact path alone cannot authorize a remote-change identity override', () => {
  const initialState = emptyWorkspaceIdentityState()
  const first = requireResolved(new WorkspaceIdentityResolver(initialState).resolve({
    path: '/work/a',
    git_remote: 'git@example/a.git',
    now: 1,
  }))
  const afterFirst = applyWorkspaceIdentityDeltas(initialState, first.deltas)

  const replaced = requireResolved(new WorkspaceIdentityResolver(afterFirst).resolve({
    path: '/work/a',
    git_remote: 'git@example/unrelated.git',
    now: 2,
  }))

  assert.notEqual(replaced.logical_workspace.logical_workspace_id, first.logical_workspace.logical_workspace_id)
  assert.equal(replaced.resolution_basis, 'first_seen')
})

test('a reused path without strong evidence cannot revive a prior logical workspace', () => {
  const initialState = emptyWorkspaceIdentityState()
  const first = requireResolved(new WorkspaceIdentityResolver(initialState).resolve({
    path: '/work/reused',
    git_remote: null,
    now: 1,
  }))
  let state = applyWorkspaceIdentityDeltas(initialState, first.deltas)
  const deactivated = new WorkspaceIdentityResolver(state).deactivateInstance(
    first.instance.instance_id,
    2,
  )
  state = applyWorkspaceIdentityDeltas(state, deactivated.deltas)

  const replacement = requireResolved(new WorkspaceIdentityResolver(state).resolve({
    path: '/work/reused',
    git_remote: null,
    now: 3,
  }))

  assert.notEqual(
    replacement.logical_workspace.logical_workspace_id,
    first.logical_workspace.logical_workspace_id,
  )
  assert.equal(replacement.resolution_basis, 'first_seen')
})

test('two live clones with one canonical remote are distinct instances of one logical workspace', () => {
  const initialState = emptyWorkspaceIdentityState()
  const left = requireResolved(new WorkspaceIdentityResolver(initialState).resolve({
    path: '/work/a',
    git_remote: 'git@example/a.git',
    branch: 'main',
    now: 1,
  }))
  const afterLeft = applyWorkspaceIdentityDeltas(initialState, left.deltas)
  const right = requireResolved(new WorkspaceIdentityResolver(afterLeft).resolve({
    path: '/other/a',
    git_remote: 'git@example/a.git',
    branch: 'feature',
    now: 2,
  }))

  assert.equal(right.logical_workspace.logical_workspace_id, left.logical_workspace.logical_workspace_id)
  assert.notEqual(right.instance.instance_id, left.instance.instance_id)
  assert.equal(right.resolution_basis, 'canonical_remote')
})

test('POSIX paths differing only by case remain distinct live instances', () => {
  const initialState = emptyWorkspaceIdentityState()
  const upper = requireResolved(new WorkspaceIdentityResolver(initialState).resolve({
    path: '/work/Repo',
    git_remote: 'git@example/repo.git',
    now: 1,
  }))
  let state = applyWorkspaceIdentityDeltas(initialState, upper.deltas)
  const lower = requireResolved(new WorkspaceIdentityResolver(state).resolve({
    path: '/work/repo',
    git_remote: 'git@example/repo.git',
    now: 2,
  }))
  state = applyWorkspaceIdentityDeltas(state, lower.deltas)

  assert.equal(lower.logical_workspace.logical_workspace_id, upper.logical_workspace.logical_workspace_id)
  assert.notEqual(lower.instance.instance_id, upper.instance.instance_id)
  assert.equal(state.workspace_instances.length, 2)
  assert.equal(
    selectInstance(upper.logical_workspace.logical_workspace_id, state.workspace_instances).kind,
    'ambiguous',
  )
})

test('NFKC-equivalent POSIX paths remain distinct physical instances', () => {
  const initialState = emptyWorkspaceIdentityState()
  const wide = requireResolved(new WorkspaceIdentityResolver(initialState).resolve({
    path: '/work/ＮＯＶＡ',
    git_remote: 'git@example/repo.git',
    now: 1,
  }))
  let state = applyWorkspaceIdentityDeltas(initialState, wide.deltas)
  const ascii = requireResolved(new WorkspaceIdentityResolver(state).resolve({
    path: '/work/NOVA',
    git_remote: 'git@example/repo.git',
    now: 2,
  }))
  state = applyWorkspaceIdentityDeltas(state, ascii.deltas)

  assert.equal(ascii.logical_workspace.logical_workspace_id, wide.logical_workspace.logical_workspace_id)
  assert.notEqual(ascii.instance.instance_id, wide.instance.instance_id)
  assert.equal(state.workspace_instances.length, 2)
})

test('basename similarity alone never merges unrelated repositories', () => {
  const initialState = emptyWorkspaceIdentityState()
  const left = requireResolved(new WorkspaceIdentityResolver(initialState).resolve({
    path: '/work/shared-name',
    git_remote: 'git@example/left.git',
    now: 1,
  }))
  const afterLeft = applyWorkspaceIdentityDeltas(initialState, left.deltas)
  const right = requireResolved(new WorkspaceIdentityResolver(afterLeft).resolve({
    path: '/other/shared-name',
    git_remote: 'git@example/right.git',
    now: 2,
  }))

  assert.notEqual(right.logical_workspace.logical_workspace_id, left.logical_workspace.logical_workspace_id)
})

test('conflicting fingerprint candidates return every logical candidate without a delta', () => {
  const state = identityState(
    [logicalWorkspace('lw-a'), logicalWorkspace('lw-b')],
    [
      workspaceInstance('wi-a', 'lw-a', 'shared-fingerprint'),
      workspaceInstance('wi-b', 'lw-b', 'shared-fingerprint'),
    ],
  )

  const decision = new WorkspaceIdentityResolver(state).resolve({
    path: '/work/new-clone',
    git_remote: null,
    repository_fingerprint: 'shared-fingerprint',
    now: 2,
  })

  assert.equal(decision.kind, 'ambiguous')
  if (decision.kind !== 'ambiguous') return
  assert.deepEqual(
    decision.candidates.map(candidate => candidate.logical_workspace_id),
    ['lw-a', 'lw-b'],
  )
  assert.deepEqual(decision.deltas, [])
})

test('simultaneous live worktrees remain ambiguous instance candidates', () => {
  const initialState = emptyWorkspaceIdentityState()
  const main = requireResolved(new WorkspaceIdentityResolver(initialState).resolve({
    path: '/work/repo',
    git_remote: 'git@example/repo.git',
    branch: 'main',
    now: 1,
  }))
  let state = applyWorkspaceIdentityDeltas(initialState, main.deltas)
  const feature = requireResolved(new WorkspaceIdentityResolver(state).resolve({
    path: '/work/repo-feature',
    git_remote: 'git@example/repo.git',
    branch: 'feature',
    now: 2,
  }))
  state = applyWorkspaceIdentityDeltas(state, feature.deltas)

  const selection = selectInstance(main.logical_workspace.logical_workspace_id, state.workspace_instances)

  assert.equal(selection.kind, 'ambiguous')
  assert.deepEqual(
    selection.candidates.map(candidate => candidate.instance_id).sort(),
    [main.instance.instance_id, feature.instance.instance_id].sort(),
  )
})

test('deactivating a deleted instance preserves its logical workspace', () => {
  const initialState = emptyWorkspaceIdentityState()
  const opened = requireResolved(new WorkspaceIdentityResolver(initialState).resolve({
    path: '/work/repo',
    git_remote: 'git@example/repo.git',
    now: 1,
  }))
  const active = applyWorkspaceIdentityDeltas(initialState, opened.deltas)

  const inactiveDecision = new WorkspaceIdentityResolver(active)
    .deactivateInstance(opened.instance.instance_id, 2)
  assert.equal(inactiveDecision.kind, 'deactivated')
  const inactive = applyWorkspaceIdentityDeltas(active, inactiveDecision.deltas)

  assert.equal(inactive.logical_workspaces.length, 1)
  assert.equal(inactive.logical_workspaces[0]?.logical_workspace_id, opened.logical_workspace.logical_workspace_id)
  assert.equal(inactive.workspace_instances[0]?.status, 'inactive')
  assert.equal(
    selectInstance(opened.logical_workspace.logical_workspace_id, inactive.workspace_instances).kind,
    'none',
  )
})

test('a delayed deactivate cannot override a newer live-instance observation', () => {
  const initialState = emptyWorkspaceIdentityState()
  const opened = requireResolved(new WorkspaceIdentityResolver(initialState).resolve({
    path: '/work/repo',
    git_remote: 'git@example/repo.git',
    now: 5,
  }))
  const active = applyWorkspaceIdentityDeltas(initialState, opened.deltas)

  const delayed = new WorkspaceIdentityResolver(active).deactivateInstance(
    opened.instance.instance_id,
    4,
  )
  const unchanged = applyWorkspaceIdentityDeltas(active, delayed.deltas)

  assert.equal((delayed as {readonly kind: string}).kind, 'stale_ignored')
  assert.deepEqual(delayed.deltas, [])
  assert.equal(unchanged.workspace_instances[0]?.status, 'active')
})

test('a delayed open cannot reactivate a more recently deactivated instance', () => {
  const initialState = emptyWorkspaceIdentityState()
  const opened = requireResolved(new WorkspaceIdentityResolver(initialState).resolve({
    path: '/work/repo',
    git_remote: 'git@example/repo.git',
    now: 5,
  }))
  let state = applyWorkspaceIdentityDeltas(initialState, opened.deltas)
  const deactivated = new WorkspaceIdentityResolver(state).deactivateInstance(
    opened.instance.instance_id,
    6,
  )
  state = applyWorkspaceIdentityDeltas(state, deactivated.deltas)

  const delayed = requireResolved(new WorkspaceIdentityResolver(state).resolve({
    path: '/work/repo',
    git_remote: 'git@example/repo.git',
    now: 5,
  }))
  const unchanged = applyWorkspaceIdentityDeltas(state, delayed.deltas)

  assert.equal(delayed.instance.status, 'inactive')
  assert.deepEqual(delayed.deltas, [])
  assert.equal(unchanged.workspace_instances[0]?.status, 'inactive')
})

test('denied paths fail safely before state lookup or label construction', () => {
  let stateLookedUp = false
  const hostileState = Object.defineProperty({}, 'logical_workspaces', {
    enumerable: true,
    get() {
      stateLookedUp = true
      throw new Error('private-state-marker')
    },
  }) as WorkspaceIdentityState
  const resolver = new WorkspaceIdentityResolver(hostileState, {
    pathPolicy: new SensitivePathPolicy({deniedRoots: ['/private/denied-root']}),
  })

  let error: unknown
  try {
    resolver.resolve({
      path: '/private/denied-root/secret-project-name',
      git_remote: null,
      now: 1,
    })
  } catch (caught) {
    error = caught
  }

  assert.ok(error instanceof WorkspaceIdentityError)
  assert.equal(error.code, 'IDENTITY_SENSITIVE_PATH_DENIED')
  assert.equal(stateLookedUp, false)
  assert.equal(error.message.includes('secret-project-name'), false)
  assert.equal(error.message.includes('private-state-marker'), false)
})

test('NFKC-equivalent sensitive path components fail before state lookup', () => {
  let stateLookups = 0
  const hostileState = Object.defineProperty({}, 'logical_workspaces', {
    enumerable: true,
    get() {
      stateLookups += 1
      throw new Error('state-must-not-be-read')
    },
  }) as WorkspaceIdentityState
  const resolver = new WorkspaceIdentityResolver(hostileState)

  for (const path of [
    '/safe/．env',
    '/safe/ｓｅｃｒｅｔ',
    '/safe/work／.env',
    '/safe/foo／．．／.env',
  ]) {
    assert.throws(
      () => resolver.resolve({path, git_remote: null, now: 1}),
      (error: unknown) => (
        error instanceof WorkspaceIdentityError
        && error.code === 'IDENTITY_SENSITIVE_PATH_DENIED'
      ),
    )
  }
  assert.equal(stateLookups, 0)
})

test('NFKC path normalization never emits dot or parent-segment labels', () => {
  const resolver = new WorkspaceIdentityResolver(emptyWorkspaceIdentityState())
  const currentDirectory = requireResolved(resolver.resolve({
    path: '/safe/．',
    git_remote: null,
    now: 1,
  }))

  assert.equal(currentDirectory.instance.path_label, 'safe')
  assert.throws(
    () => resolver.resolve({path: '/safe/．．', git_remote: null, now: 2}),
    WorkspaceIdentityError,
  )
})

test('secret-shaped path content fails before label construction or state lookup', () => {
  let stateLookups = 0
  const hostileState = Object.defineProperty({}, 'logical_workspaces', {
    enumerable: true,
    get() {
      stateLookups += 1
      throw new Error('state-must-not-be-read')
    },
  }) as WorkspaceIdentityState

  assert.throws(
    () => new WorkspaceIdentityResolver(hostileState).resolve({
      path: '/safe/sk-abcdefghijklmnop',
      git_remote: null,
      now: 1,
    }),
    WorkspaceIdentityError,
  )
  assert.equal(stateLookups, 0)
})

test('sensitive remote, fingerprint, and branch inputs fail before state lookup', () => {
  const deniedRoot = '/private/denied-root'
  for (const unsafeInput of [
    {git_remote: `file://${deniedRoot}/repo.git`},
    {git_remote: `file://${deniedRoot}/${'x'.repeat(240)}`},
    {git_remote: null, repository_fingerprint: `${deniedRoot}/fingerprint`},
    {git_remote: null, branch: 'Authorization: Basic secret-value'},
  ]) {
    let stateLookups = 0
    const hostileState = Object.defineProperty({}, 'logical_workspaces', {
      enumerable: true,
      get() {
        stateLookups += 1
        throw new Error('state-must-not-be-read')
      },
    }) as WorkspaceIdentityState
    const resolver = new WorkspaceIdentityResolver(hostileState, {
      pathPolicy: new SensitivePathPolicy({deniedRoots: [deniedRoot]}),
    })

    assert.throws(
      () => resolver.resolve({path: '/safe/repo', now: 1, ...unsafeInput}),
      WorkspaceIdentityError,
    )
    assert.equal(stateLookups, 0)
  }
})

test('sensitive alias text and evidence references never enter identity deltas', () => {
  const deniedRoot = '/private/denied-root'
  const resolver = new WorkspaceIdentityResolver(
    identityState([logicalWorkspace('lw-a')]),
    {pathPolicy: new SensitivePathPolicy({deniedRoots: [deniedRoot]})},
  )

  assert.throws(
    () => resolver.learnAlias(
      'lw-a',
      `${deniedRoot}/secret-alias`,
      {kind: 'user_confirmed', ref: 'safe-ref', observed_at: 2},
    ),
    WorkspaceIdentityError,
  )
  assert.throws(
    () => resolver.learnAlias(
      'lw-a',
      'safe alias',
      {kind: 'user_confirmed', ref: 'Authorization: Basic secret-value', observed_at: 2},
    ),
    WorkspaceIdentityError,
  )
})

test('safe path labels are normalized before producing Task 0 instance cards', () => {
  const decision = requireResolved(new WorkspaceIdentityResolver(
    emptyWorkspaceIdentityState(),
  ).resolve({
    path: `/work/ＮＯＶＡ${' '.repeat(260)}agent`,
    git_remote: null,
    now: 1,
  }))

  assert.equal(decision.instance.path_label, 'NOVA agent')
  assert.doesNotThrow(() => WorkspaceInstanceSchema.parse(decision.instance))
})

test('UTF-16-overlong aliases are rejected before producing invalid Task 0 cards', () => {
  const resolver = new WorkspaceIdentityResolver(identityState([logicalWorkspace('lw-a')]))

  assert.throws(
    () => resolver.learnAlias(
      'lw-a',
      '😀'.repeat(120),
      {kind: 'user_confirmed', ref: 'user-overlong-alias', observed_at: 2},
    ),
    WorkspaceIdentityError,
  )
})

test('resolution is deterministic and does not mutate immutable input state', () => {
  const state = emptyWorkspaceIdentityState()
  const input = Object.freeze({
    path: '/work/repo',
    git_remote: 'git@example/repo.git',
    repository_fingerprint: 'fingerprint-repo',
    branch: 'main',
    now: 10,
  })
  const resolver = new WorkspaceIdentityResolver(state)

  const first = resolver.resolve(input)
  const second = resolver.resolve(input)

  assert.deepEqual(second, first)
  assert.deepEqual(state, emptyWorkspaceIdentityState())
  assert.ok(Object.isFrozen(first))
  assert.ok(Object.isFrozen(first.deltas))
})

test('resolution never freezes or otherwise mutates nested input card values', () => {
  const workspace = logicalWorkspace('lw-a', 'git@example/repo.git', ['Existing Alias'])
  const aliases = workspace.aliases
  const state = identityState([workspace])
  assert.equal(Object.isFrozen(aliases), false)

  new WorkspaceIdentityResolver(state).resolve({
    path: '/work/repo',
    git_remote: 'git@example/repo.git',
    now: 2,
  })

  assert.equal(Object.isFrozen(aliases), false)
  assert.deepEqual(aliases, ['Existing Alias'])
})

test('confirmed aliases reuse pinned NFKC, full casefold, and whitespace normalization', () => {
  const state = identityState([logicalWorkspace('lw-a')])
  const learned = new WorkspaceIdentityResolver(state).learnAlias(
    'lw-a',
    '  ＮＯＶＡ   Straße  ',
    {kind: 'user_confirmed', ref: 'user-alias-1', observed_at: 2},
  )
  assert.equal(learned.kind, 'alias_bound')
  const withAlias = applyWorkspaceIdentityDeltas(state, learned.deltas)

  const matches = new WorkspaceIdentityResolver(withAlias).matchAlias('nova STRASSE')

  assert.equal(matches.length, 1)
  assert.equal(matches[0]?.logical_workspace_id, 'lw-a')
  assert.equal(matches[0]?.match_kind, 'confirmed')
  assert.equal(matches[0]?.routing_allowed, true)
})

test('a confirmed near-miss transcription can later match without fuzzy or pinyin lookup', () => {
  const state = identityState([logicalWorkspace('lw-a')])
  const learned = new WorkspaceIdentityResolver(state).learnAlias(
    'lw-a',
    '新穹项目',
    {kind: 'user_confirmed', ref: 'user-alias-near-miss', observed_at: 2},
  )
  const withAlias = applyWorkspaceIdentityDeltas(state, learned.deltas)

  assert.deepEqual(
    new WorkspaceIdentityResolver(withAlias).matchAlias('  新穹项目 ')
      .map(match => match.logical_workspace_id),
    ['lw-a'],
  )
  assert.deepEqual(new WorkspaceIdentityResolver(withAlias).matchAlias('深穹项目'), [])
})

test('repeated ASR transcripts stay capped candidates and never create durable routing', () => {
  let state = identityState([logicalWorkspace('lw-a')])
  const first = new WorkspaceIdentityResolver(state).observeAliasCandidate(
    'lw-a',
    '诺瓦',
    {kind: 'asr_transcript', ref: 'asr-1', observed_at: 2, confidence: 0.99},
  )
  assert.equal(first.kind, 'candidate_observed')
  state = applyWorkspaceIdentityDeltas(state, first.deltas)
  const second = new WorkspaceIdentityResolver(state).observeAliasCandidate(
    'lw-a',
    '诺瓦',
    {kind: 'asr_transcript', ref: 'asr-2', observed_at: 3, confidence: 0.99},
  )
  assert.equal(second.kind, 'candidate_observed')
  state = applyWorkspaceIdentityDeltas(state, second.deltas)

  assert.deepEqual(state.logical_workspaces[0]?.aliases, [])
  assert.equal(state.alias_observations.length, 2)
  assert.ok(state.alias_observations.every(observation => observation.status === 'candidate'))
  assert.ok(state.alias_observations.every(
    observation => observation.confidence <= ASR_ALIAS_CONFIDENCE_CAP,
  ))
  const matches = new WorkspaceIdentityResolver(state).matchAlias('诺瓦')
  assert.equal(matches.length, 1)
  assert.equal(matches[0]?.match_kind, 'candidate')
  assert.equal(matches[0]?.routing_allowed, false)
})

test('an exact alias-evidence replay is idempotent', () => {
  const initial = identityState([logicalWorkspace('lw-a')])
  const evidence = {
    kind: 'asr_transcript',
    ref: 'asr-idempotent',
    observed_at: 2,
    confidence: 0.2,
  } as const
  const first = new WorkspaceIdentityResolver(initial).observeAliasCandidate(
    'lw-a',
    'Nova',
    evidence,
  )
  const state = applyWorkspaceIdentityDeltas(initial, first.deltas)

  const replayed = new WorkspaceIdentityResolver(state).observeAliasCandidate(
    'lw-a',
    'Nova',
    evidence,
  )

  assert.deepEqual(replayed.deltas, [])
  assert.deepEqual(applyWorkspaceIdentityDeltas(state, replayed.deltas), state)
  assert.equal(state.alias_observations.length, 1)
})

test('a reused alias-evidence ref with changed payload is rejected without overwriting history', () => {
  const initial = identityState([logicalWorkspace('lw-a')])
  const first = new WorkspaceIdentityResolver(initial).observeAliasCandidate(
    'lw-a',
    'Nova',
    {kind: 'asr_transcript', ref: 'asr-conflict', observed_at: 2, confidence: 0.2},
  )
  const state = applyWorkspaceIdentityDeltas(initial, first.deltas)

  assert.throws(
    () => new WorkspaceIdentityResolver(state).observeAliasCandidate(
      'lw-a',
      'NOVA',
      {kind: 'asr_transcript', ref: 'asr-conflict', observed_at: 3, confidence: 0.2},
    ),
    (error: unknown) => (
      error instanceof WorkspaceIdentityError
      && error.code === 'IDENTITY_EVIDENCE_CONFLICT'
    ),
  )
  assert.equal(state.alias_observations.length, 1)
  assert.equal(state.alias_observations[0]?.observed_at, 2)
})

test('the pure reducer rejects conflicting same-snapshot alias evidence', () => {
  const initial = identityState([logicalWorkspace('lw-a')])
  const resolver = new WorkspaceIdentityResolver(initial)
  const first = resolver.observeAliasCandidate(
    'lw-a',
    'Nova',
    {kind: 'asr_transcript', ref: 'asr-concurrent-conflict', observed_at: 2},
  )
  const conflicting = resolver.observeAliasCandidate(
    'lw-a',
    'NOVA',
    {kind: 'asr_transcript', ref: 'asr-concurrent-conflict', observed_at: 3},
  )

  assert.throws(
    () => applyWorkspaceIdentityDeltas(initial, [...first.deltas, ...conflicting.deltas]),
    WorkspaceIdentityError,
  )
})

test('only explicit confirmation promotes a candidate alias into a durable binding', () => {
  const initial = identityState([logicalWorkspace('lw-a')])
  const candidate = new WorkspaceIdentityResolver(initial).observeAliasCandidate(
    'lw-a',
    '小诺',
    {kind: 'asr_transcript', ref: 'asr-candidate', observed_at: 2, confidence: 0.2},
  )
  const withCandidate = applyWorkspaceIdentityDeltas(initial, candidate.deltas)
  const promoted = new WorkspaceIdentityResolver(withCandidate).learnAlias(
    'lw-a',
    '小诺',
    {kind: 'user_confirmed', ref: 'user-promoted', observed_at: 3},
  )
  assert.equal(promoted.kind, 'alias_bound')
  const confirmed = applyWorkspaceIdentityDeltas(withCandidate, promoted.deltas)

  assert.deepEqual(confirmed.logical_workspaces[0]?.aliases, ['小诺'])
  assert.deepEqual(
    new WorkspaceIdentityResolver(confirmed).matchAlias('小诺').map(match => ({
      kind: match.match_kind,
      routing: match.routing_allowed,
    })),
    [{kind: 'confirmed', routing: true}],
  )
})

test('a user confirmation at timestamp zero can create the first durable alias', () => {
  const initial = identityState([logicalWorkspace('lw-a')])

  const learned = new WorkspaceIdentityResolver(initial).learnAlias(
    'lw-a',
    'epoch alias',
    {kind: 'user_confirmed', ref: 'confirm-at-epoch', observed_at: 0},
  )

  assert.equal(learned.kind, 'alias_bound')
  assert.deepEqual(learned.logical_workspace.aliases, ['epoch alias'])
})

test('a persisted card alias remains a confirmed binding after restart without raw observations', () => {
  const restarted = identityState([
    logicalWorkspace('lw-a', null, ['Persisted Alias']),
  ])

  assert.deepEqual(
    new WorkspaceIdentityResolver(restarted).matchAlias('persisted alias').map(match => ({
      logical_workspace_id: match.logical_workspace_id,
      kind: match.match_kind,
      routing_allowed: match.routing_allowed,
    })),
    [{logical_workspace_id: 'lw-a', kind: 'confirmed', routing_allowed: true}],
  )
})

test('a shared confirmed alias returns every candidate and never chooses an action target', () => {
  let state = identityState([logicalWorkspace('lw-a'), logicalWorkspace('lw-b')])
  let latestRoutingAllowed = true
  for (const [logicalWorkspaceId, ref] of [['lw-a', 'confirm-a'], ['lw-b', 'confirm-b']] as const) {
    const learned = new WorkspaceIdentityResolver(state).learnAlias(
      logicalWorkspaceId,
      '共享项目',
      {kind: 'user_confirmed', ref, observed_at: 2},
    )
    latestRoutingAllowed = learned.routing_allowed
    state = applyWorkspaceIdentityDeltas(state, learned.deltas)
  }

  const matches = new WorkspaceIdentityResolver(state).matchAlias('共享项目')

  assert.deepEqual(matches.map(match => match.logical_workspace_id), ['lw-a', 'lw-b'])
  assert.ok(matches.every(match => match.match_kind === 'confirmed'))
  assert.ok(matches.every(match => !match.routing_allowed))
  assert.equal(latestRoutingAllowed, false)
})

test('alias learning never authorizes routing before competing deltas are committed', () => {
  const state = identityState([logicalWorkspace('lw-a'), logicalWorkspace('lw-b')])
  const resolver = new WorkspaceIdentityResolver(state)
  const left = resolver.learnAlias(
    'lw-a',
    'shared alias',
    {kind: 'user_confirmed', ref: 'confirm-left', observed_at: 2},
  )
  const right = resolver.learnAlias(
    'lw-b',
    'shared alias',
    {kind: 'user_confirmed', ref: 'confirm-right', observed_at: 2},
  )

  assert.equal(left.routing_allowed, false)
  assert.equal(right.routing_allowed, false)
  const committed = applyWorkspaceIdentityDeltas(state, [...left.deltas, ...right.deltas])
  assert.equal(new WorkspaceIdentityResolver(committed).matchAlias('shared alias').length, 2)
})

test('same-workspace alias decisions from one revision conflict instead of losing an update', () => {
  const initial = identityState([logicalWorkspace('lw-a')])
  const resolver = new WorkspaceIdentityResolver(initial)
  const alpha = resolver.learnAlias(
    'lw-a',
    'alpha',
    {kind: 'user_confirmed', ref: 'confirm-alpha', observed_at: 2},
  )
  const beta = resolver.learnAlias(
    'lw-a',
    'beta',
    {kind: 'user_confirmed', ref: 'confirm-beta', observed_at: 2},
  )

  assert.throws(
    () => applyWorkspaceIdentityDeltas(initial, [...alpha.deltas, ...beta.deltas]),
    WorkspaceIdentityError,
  )

  let state = applyWorkspaceIdentityDeltas(initial, alpha.deltas)
  const retriedBeta = new WorkspaceIdentityResolver(state).learnAlias(
    'lw-a',
    'beta',
    {kind: 'user_confirmed', ref: 'confirm-beta', observed_at: 2},
  )
  state = applyWorkspaceIdentityDeltas(state, retriedBeta.deltas)
  assert.deepEqual(state.logical_workspaces[0]?.aliases, ['alpha', 'beta'])
})

test('a delayed confirmation cannot replace a newer confirmed alias spelling', () => {
  const initial = identityState([logicalWorkspace('lw-a')])
  const current = new WorkspaceIdentityResolver(initial).learnAlias(
    'lw-a',
    'Current Name',
    {kind: 'user_confirmed', ref: 'confirm-current', observed_at: 5},
  )
  let state = applyWorkspaceIdentityDeltas(initial, current.deltas)
  const delayed = new WorkspaceIdentityResolver(state).learnAlias(
    'lw-a',
    'CURRENT NAME',
    {kind: 'user_confirmed', ref: 'confirm-delayed', observed_at: 3},
  )
  state = applyWorkspaceIdentityDeltas(state, delayed.deltas)

  assert.equal(delayed.kind, 'confirmation_ignored')
  assert.deepEqual(state.logical_workspaces[0]?.aliases, ['Current Name'])
  assert.equal(state.alias_observations.length, 2)
})

test('confirmed suppression removes an alias until a newer explicit confirmation restores it', () => {
  const initial = identityState([logicalWorkspace('lw-a')])
  const bound = new WorkspaceIdentityResolver(initial).learnAlias(
    'lw-a',
    '旧名字',
    {kind: 'user_confirmed', ref: 'confirm-old', observed_at: 2},
  )
  let state = applyWorkspaceIdentityDeltas(initial, bound.deltas)
  const suppressed = new WorkspaceIdentityResolver(state).suppressAlias(
    'lw-a',
    '旧名字',
    {kind: 'user_confirmed', ref: 'remove-old', observed_at: 3},
  )
  state = applyWorkspaceIdentityDeltas(state, suppressed.deltas)
  assert.deepEqual(new WorkspaceIdentityResolver(state).matchAlias('旧名字'), [])
  assert.deepEqual(state.logical_workspaces[0]?.aliases, [])

  const noisy = new WorkspaceIdentityResolver(state).observeAliasCandidate(
    'lw-a',
    '旧名字',
    {kind: 'asr_transcript', ref: 'asr-after-removal', observed_at: 4, confidence: 1},
  )
  state = applyWorkspaceIdentityDeltas(state, noisy.deltas)
  assert.deepEqual(new WorkspaceIdentityResolver(state).matchAlias('旧名字'), [])

  const restored = new WorkspaceIdentityResolver(state).learnAlias(
    'lw-a',
    '旧名字',
    {kind: 'user_confirmed', ref: 'restore-old', observed_at: 5},
  )
  state = applyWorkspaceIdentityDeltas(state, restored.deltas)

  assert.equal(new WorkspaceIdentityResolver(state).matchAlias('旧名字')[0]?.match_kind, 'confirmed')
  assert.equal(state.alias_observations.length, 4, 'alias evidence history was deleted')
})

test('a delayed suppression observation cannot remove a newer confirmed alias', () => {
  const initial = identityState([logicalWorkspace('lw-a')])
  const confirmed = new WorkspaceIdentityResolver(initial).learnAlias(
    'lw-a',
    'current name',
    {kind: 'user_confirmed', ref: 'confirm-current', observed_at: 5},
  )
  let state = applyWorkspaceIdentityDeltas(initial, confirmed.deltas)
  const delayed = new WorkspaceIdentityResolver(state).suppressAlias(
    'lw-a',
    'current name',
    {kind: 'user_confirmed', ref: 'delayed-suppression', observed_at: 3},
  )
  state = applyWorkspaceIdentityDeltas(state, delayed.deltas)

  assert.equal(new WorkspaceIdentityResolver(state).matchAlias('current name')[0]?.match_kind, 'confirmed')
  assert.deepEqual(state.logical_workspaces[0]?.aliases, ['current name'])
  assert.deepEqual(
    state.alias_observations.map(observation => observation.status),
    ['suppressed', 'confirmed'],
  )
})

test('an unrelated workspace update does not make an older alias immune to suppression', () => {
  const initial = identityState([logicalWorkspace('lw-a')])
  const confirmed = new WorkspaceIdentityResolver(initial).learnAlias(
    'lw-a',
    'removable name',
    {kind: 'user_confirmed', ref: 'confirm-removable', observed_at: 2},
  )
  let state = applyWorkspaceIdentityDeltas(initial, confirmed.deltas)
  const workspaceUpdated = requireResolved(new WorkspaceIdentityResolver(state).resolve({
    path: '/work/repo',
    git_remote: 'git@example/repo.git',
    continuity: {kind: 'user_confirmed', logical_workspace_id: 'lw-a'},
    now: 10,
  }))
  state = applyWorkspaceIdentityDeltas(state, workspaceUpdated.deltas)

  const suppressed = new WorkspaceIdentityResolver(state).suppressAlias(
    'lw-a',
    'removable name',
    {kind: 'user_confirmed', ref: 'suppress-removable', observed_at: 5},
  )
  state = applyWorkspaceIdentityDeltas(state, suppressed.deltas)

  assert.equal(suppressed.kind, 'alias_suppressed')
  assert.deepEqual(new WorkspaceIdentityResolver(state).matchAlias('removable name'), [])
})
