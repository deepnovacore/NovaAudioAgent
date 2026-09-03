import assert from 'node:assert/strict'
import {readdirSync} from 'node:fs'
import {mkdir, readFile, rename, rm, symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {test} from 'node:test'

import type {TransportOutcome} from '../src/executors/codex/app-server-transport.js'
import {CodexTransportError} from '../src/executors/codex/app-server-transport.js'
import {CODEX_PROJECT_MANIFEST} from '../src/executors/codex/contract.js'
import {ProjectStateError, type PublicProjectView} from '../src/project-store.js'
import {CausalRuntime, type ExecutorHandoff} from '../src/causal-runtime.js'
import {hostWorkspacePath} from '../src/host-paths.js'
import {ProjectResolutionError} from '../src/coding-executor.js'
import {MonotonicIdFactory} from '../src/ids.js'
import type {DelegateRequest} from '../src/ports.js'
import type {ConfirmedProjectOperation, ProjectProposal} from '../src/project-confirmation.js'
import type {WakeReason} from '../src/slots.js'
import {ProjectCodexAdapter} from '../src/executors/codex/adapter-project.js'
import {
  COMPLETE,
  context,
  fixture,
  observeCriticalProjectContext,
  run,
  settleWithin,
  storeWithPersistentHomeHook,
  type Fixture,
} from './fixtures/codex/project-adapter-fixture.js'

/** Host-side proposal + spoken confirmation, as `realtime-assembly` performs them (spec 08: only `create` asks). */
function confirmed(
  value: Fixture,
  input: Omit<Parameters<Fixture['confirmation']['prepare']>[0], 'origin_ref'> & {readonly origin_ref?: string},
): ConfirmedProjectOperation {
  const proposal: ProjectProposal = value.confirmation.prepare({origin_ref: 'conversation:1', ...input})
  const outcome = value.confirmation.acceptDirectDecision({proposalId: proposal.proposal_id, confirmed: true})
  assert.ok(outcome.operation, 'proposal must be accepted')
  return outcome.operation
}

/** The runtime's later `run` dispatch of a committed confirmed operation. */
function executeConfirmed(
  value: Fixture,
  operation: ConfirmedProjectOperation,
  delegateId: string,
  overrides: {readonly private?: unknown; readonly originRef?: string} = {},
): Promise<ExecutorHandoff> {
  const request = {work_order: operation.work_order ?? ''}
  return value.adapter.dispatch('run', request, context('run', request, value.clock, {
    private: overrides.private ?? operation,
    delegateId,
    originRef: overrides.originRef ?? operation.origin_ref,
  }))
}

test('project manifest exposes run, steer, status, cancel with sensitivity and an agent summary', () => {
  const adapter = new ProjectCodexAdapter({} as never)
  assert.equal(adapter.manifest, CODEX_PROJECT_MANIFEST)
  assert.deepEqual(adapter.manifest.ops.map(op => op.name), ['run', 'steer', 'status', 'cancel'])
  assert.deepEqual(adapter.manifest.ops[0]?.sensitive_params, ['work_order'])
  assert.deepEqual(adapter.manifest.ops[1]?.sensitive_params, ['instruction'])
  assert.ok(adapter.manifest.agent, 'agent executors carry a summary for the host dispatch tool')
})

test('initialize publishes the pre-existing active project with its roster using only the committed view', async () => {
  const value = await fixture({preexistingSession: true})
  try {
    const views: PublicProjectView[] = []
    const unsubscribe = value.adapter.observeProjectView(view => { views.push(view) })
    const first = value.adapter.initialize()
    assert.equal(value.adapter.initialize(), first)
    await first
    assert.deepEqual(value.adapter.publicProjectView(false), {
      workspace_display_name: 'alpha',
      session_title: 'Existing',
      roster: [{name: 'alpha', last_used_at: 100, running: []}],
      pending_confirmation: false,
      pending_confirmation_busy: false,
    })
    assert.deepEqual(value.adapter.roster(), [
      {name: 'alpha', last_used_at: 100, last_session_title: 'Existing', running: []},
    ])
    assert.deepEqual(views.at(-1), value.adapter.publicProjectView(false))
    await run(value, 'fresh session', {session: 'new', title: 'Fresh'})
    assert.equal(views.at(-1)?.session_title, 'Fresh')
    const beforeUnsubscribe = views.length
    unsubscribe()
    await run(value, 'silent observer', {session: 'new', title: 'Silent'})
    assert.equal(views.length, beforeUnsubscribe)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('new runs create distinct titled sessions with one closed transport each; latest resumes', async () => {
  const value = await fixture()
  try {
    const first = await run(value, 'first', {session: 'new', title: 'Task'})
    const second = await run(value, 'second', {session: 'new', title: 'task'})
    assert.equal(first.outcome, 'ok')
    assert.equal(second.outcome, 'ok')
    const workspace = await value.store.resolveWorkspace('alpha')
    const sessions = await value.store.listSessions(workspace)
    assert.deepEqual(sessions.map(session => [
      session.display_title, session.state, session.codex_thread_id,
    ]), [
      ['Task', 'ready', 'thread-1'],
      ['task (2)', 'ready', 'thread-2'],
    ])
    assert.deepEqual(value.factory.calls, [{resume: false}, {resume: false}])
    assert.deepEqual(value.factory.transports.map(transport => transport.runInputs[0]?.threadName), ['Task', 'task'])
    assert.deepEqual(value.factory.transports.map(transport => transport.closeCalls), [1, 1])

    const resumed = await run(value, 'third', {session: 'latest'})
    assert.equal(resumed.outcome, 'ok')
    assert.deepEqual(value.factory.calls.at(-1), {resume: true})
    assert.equal(value.factory.transports[2]?.threadId, 'thread-2')
    assert.equal(value.factory.transports[2]?.runInputs[0]?.threadName, undefined, 'resumed threads keep their Codex name')
    assert.equal((await value.store.listSessions(workspace)).length, 2)

    const untitled = await run(value, 'Fix the login page. Then run tests', {session: 'new'})
    assert.equal(untitled.outcome, 'ok')
    assert.equal(value.factory.transports[3]?.runInputs[0]?.threadName, 'Fix the login page', 'title falls back to deriveSessionTitle')

    const status = await value.adapter.dispatch('status', {}, context('status', {}, value.clock))
    assert.equal(status.content.run_sequence, 4)
    const steer = await value.adapter.dispatch(
      'steer',
      {instruction: 'after completion', project: null},
      context('steer', {instruction: 'after completion', project: null}, value.clock),
    )
    assert.equal(steer.content.code, 'no_active_turn')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('run with a project name activates that workspace without confirmation; unknown names refuse', async () => {
  const value = await fixture()
  try {
    const beta = await value.store.createManaged('beta')
    const alpha = await value.store.resolveWorkspace('alpha')
    assert.equal((await value.store.resolveWorkspace(null)).workspace_id, beta.workspace_id)
    const result = await run(value, 'work in alpha', {project: 'ALPHA', title: 'Alpha work'})
    assert.equal(result.outcome, 'ok')
    assert.equal(hostWorkspacePath(value.factory.bindings[0]!.workspace), alpha.canonical_path)
    assert.equal((await value.store.resolveWorkspace(null)).workspace_id, alpha.workspace_id)
    assert.deepEqual(value.factory.bindings[0]?.work, {work_id: 'delegate-work in alpha', project: 'alpha', title: 'Alpha work'})
    const unknown = await run(value, 'nowhere', {project: 'gamma'})
    assert.deepEqual(unknown.content, {op: 'run', code: 'workspace_not_found', recoverable: true})
    assert.equal(value.factory.calls.length, 1)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('committed workspace and typed terminal observers run after authoritative boundaries', async () => {
  const value = await fixture()
  try {
    const workspaces: string[] = []
    const completions: string[] = []
    const unsubscribeWorkspace = value.adapter.observeCommittedWorkspace(event => {
      workspaces.push(`${event.workspace.workspace_id}:${event.workspace.canonical_path}`)
    })
    const unsubscribeCompletion = value.adapter.observeTerminalWorkOrder(event => {
      completions.push(`${event.workspace.workspace_id}:${event.work_order}:${event.handoff.outcome}`)
    })
    const result = await run(value, 'typed completion', {title: 'Observed'})
    assert.equal(result.outcome, 'ok')
    assert.equal(workspaces.length, 1)
    assert.match(workspaces[0] ?? '', /^workspace-/u)
    assert.deepEqual(completions.map(item => item.split(':').slice(1)), [['typed completion', 'ok']])
    unsubscribeWorkspace()
    unsubscribeCompletion()
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('confirmed create builds the workspace, runs once with the proposal title, and rejects replay', async () => {
  const value = await fixture()
  try {
    const operation = confirmed(value, {
      action: 'create', workspace_display_name: 'beta', workspace_id: null,
      session_title: 'Initial', session_id: null, work_order: 'build it',
    })
    assert.equal(value.adapter.publicProjectView(true).pending_action, 'create_workspace')
    let delegated: DelegateRequest | null = null
    let delegatedReason: WakeReason | null = null
    let delegatedCapability: object | null = null
    const committed = await value.adapter.commitConfirmed(operation, (request, reason, capability) => {
      delegated = request
      delegatedReason = reason
      delegatedCapability = capability
      return {accepted: true, delegate_id: 'delegate-create'}
    })
    assert.deepEqual(committed, {accepted: true, code: 'accepted', delegate_id: 'delegate-create'})
    const capturedDelegate = delegated as unknown as DelegateRequest
    assert.deepEqual(capturedDelegate, {
      executor: 'codex', op: 'run', request: {work_order: 'build it'}, origin_ref: 'conversation:1',
    })
    assert.equal((delegatedReason as unknown as WakeReason).routing_class, 'user_awaited')
    assert.equal(delegatedCapability, operation)
    assert.deepEqual(readdirSync(join(value.root, 'managed')), [], 'nothing is created before the runtime runs it')

    const executed = await executeConfirmed(value, operation, 'delegate-create')
    const replayed = await executeConfirmed(value, operation, 'delegate-create')
    assert.equal(executed.outcome, 'ok')
    assert.deepEqual(replayed.content, {error: 'confirmation_binding_mismatch', op: 'run'})
    const beta = await value.store.resolveWorkspace('beta')
    assert.equal((await value.store.resolveWorkspace(null)).workspace_id, beta.workspace_id)
    assert.deepEqual(
      (await value.store.listSessions(beta)).map(item => [item.display_title, item.codex_thread_id]),
      [['Initial', 'thread-1']],
    )
    assert.equal(value.factory.transports[0]?.runInputs[0]?.threadName, 'Initial')
    assert.equal(value.factory.calls.length, 1)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('confirmed create without a host title derives the session title from the work order', async () => {
  const value = await fixture()
  try {
    const operation = confirmed(value, {
      action: 'create', workspace_display_name: 'beta', workspace_id: null,
      session_title: null, session_id: null, work_order: '修复登录页。然后跑测试',
    })
    assert.equal((await value.adapter.commitConfirmed(operation, () => ({accepted: true, delegate_id: 'd'}))).accepted, true)
    assert.equal((await executeConfirmed(value, operation, 'd')).outcome, 'ok')
    const beta = await value.store.resolveWorkspace('beta')
    assert.deepEqual((await value.store.listSessions(beta)).map(item => item.display_title), ['修复登录页'])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('confirmed resume binds one exact capability, delegate, origin, work order, and stored thread', async () => {
  const value = await fixture({preexistingSession: true})
  try {
    const alpha = await value.store.resolveWorkspace('alpha')
    const session = await value.store.resolveSession(alpha.workspace_id, 'Existing')
    const operation = confirmed(value, {
      action: 'resume', workspace_display_name: 'alpha', workspace_id: alpha.workspace_id,
      session_title: 'Existing', session_id: session.session_id, work_order: 'continue',
    })
    assert.equal((await value.adapter.commitConfirmed(
      operation, () => ({accepted: true, delegate_id: 'delegate-resume'}),
    )).accepted, true)
    const resumed = await executeConfirmed(value, operation, 'delegate-resume')
    assert.equal(resumed.outcome, 'ok')
    assert.deepEqual(value.factory.calls, [{resume: true}])
    assert.equal(value.factory.transports[0]?.threadId, 'thread-existing')
    const replay = await executeConfirmed(value, operation, 'delegate-resume')
    assert.deepEqual(replay.content, {error: 'confirmation_binding_mismatch', op: 'run'})
    assert.equal(value.factory.calls.length, 1)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('confirmed reuse revalidates workspace identity before dispatch', async () => {
  const value = await fixture()
  try {
    const original = await value.store.createManaged('beta')
    const operation = confirmed(value, {
      action: 'reuse', workspace_display_name: 'beta', workspace_id: original.workspace_id,
      session_title: 'Initial', session_id: null, work_order: 'build it',
    })
    assert.equal(await value.store.rollbackManagedCreate(original.workspace_id), true)
    const replacement = await value.store.createManaged('beta')
    const dispatched: DelegateRequest[] = []
    const committed = await value.adapter.commitConfirmed(operation, request => {
      dispatched.push(request)
      return {accepted: true, delegate_id: 'delegate-reuse-identity'}
    })
    assert.deepEqual(committed, {accepted: false, code: 'workspace_boundary_changed'})
    assert.deepEqual(dispatched, [])
    assert.equal((await value.store.resolveWorkspace('beta')).workspace_id, replacement.workspace_id)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('confirmed resume revalidates ready state before runtime dispatch', async () => {
  const value = await fixture({preexistingSession: true})
  try {
    const workspace = await value.store.resolveWorkspace('alpha')
    const session = await value.store.resolveSession(workspace.workspace_id, 'Existing')
    const operation = confirmed(value, {
      action: 'resume', workspace_display_name: 'alpha', workspace_id: workspace.workspace_id,
      session_title: 'Existing', session_id: session.session_id, work_order: 'continue it',
    })
    await value.store.markSessionUnavailable(session.session_id)
    const dispatched: DelegateRequest[] = []
    const committed = await value.adapter.commitConfirmed(operation, request => {
      dispatched.push(request)
      return {accepted: true, delegate_id: 'delegate-resume-state'}
    })
    assert.deepEqual(committed, {accepted: false, code: 'session_unavailable'})
    assert.deepEqual(dispatched, [])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('real external dispatch carries one opaque confirmation identity outside every public delegate', async () => {
  const value = await fixture()
  const runtime = new CausalRuntime({
    clock: value.clock,
    ids: new MonotonicIdFactory(),
    executors: [value.adapter],
  })
  const origin = runtime.memory.append('conversation', {
    ts: value.clock.now(),
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'continue exactly'},
  })
  const originRef = `${origin.channel}:${origin.seq}`
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)
  try {
    const operation = confirmed(value, {
      action: 'create', workspace_display_name: 'beta', workspace_id: null,
      session_title: 'exact work', session_id: null, work_order: 'exact work', origin_ref: originRef,
    })
    const handoff = new Promise<void>(resolve => {
      const dispose = runtime.observe(event => {
        if (event.kind !== 'handoff') return
        dispose()
        resolve()
      })
    })
    const committed = await value.adapter.commitConfirmed(
      operation,
      (request, reason, capability) => runtime.dispatchConfirmedExternal(request, reason, capability),
    )
    assert.equal(committed.accepted, true)
    const delegate = runtime.core.activeDelegates()[0]
    assert.ok(delegate)
    assert.equal(Object.hasOwn(delegate, 'private'), false)
    assert.equal(Object.hasOwn(delegate, 'hostCapability'), false)
    assert.equal(JSON.stringify(delegate).includes(operation.proposal_id), false)
    await settleWithin('real confirmed adapter handoff', handoff)
    assert.deepEqual(
      (await value.store.listWorkspaces()).map(workspace => workspace.display_name).sort(),
      ['alpha', 'beta'],
    )
    const beta = await value.store.resolveWorkspace('beta')
    assert.equal((await value.store.listSessions(beta))[0]?.display_title, 'exact work')
  } finally {
    stop.abort()
    await serving
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('wrong delegate, origin, copied capability, rejection, and replay have zero side effects', async () => {
  const value = await fixture()
  try {
    const first = confirmed(value, {
      action: 'create', workspace_display_name: 'beta', workspace_id: null,
      session_title: 'Initial', session_id: null, work_order: 'exact work',
    })
    const rejected = await value.adapter.commitConfirmed(first, () => ({accepted: false, delegate_id: null}))
    assert.deepEqual(rejected, {accepted: false, code: 'runtime_rejected'})
    assert.deepEqual((await value.store.listWorkspaces()).map(item => item.display_name), ['alpha'])
    assert.equal(value.factory.calls.length, 0)
    const replayAfterRejection = await executeConfirmed(value, first, 'delegate-rejected')
    assert.deepEqual(replayAfterRejection.content, {error: 'confirmation_binding_mismatch', op: 'run'})

    const second = confirmed(value, {
      action: 'create', workspace_display_name: 'beta', workspace_id: null,
      session_title: 'Initial', session_id: null, work_order: 'exact work',
    })
    await value.adapter.commitConfirmed(second, () => ({accepted: true, delegate_id: 'delegate-exact'}))
    const copied = {...second}
    for (const attempt of [
      {private: copied, delegateId: 'delegate-exact', originRef: 'conversation:1'},
      {private: second, delegateId: 'delegate-wrong', originRef: 'conversation:1'},
      {private: second, delegateId: 'delegate-exact', originRef: 'conversation:4'},
    ]) {
      const result = await executeConfirmed(value, second, attempt.delegateId, attempt)
      assert.deepEqual(result.content, {error: 'confirmation_binding_mismatch', op: 'run'})
      assert.equal(value.factory.calls.length, 0)
      assert.deepEqual((await value.store.listWorkspaces()).map(item => item.display_name), ['alpha'])
    }
    const wrongShape = await value.adapter.dispatch(
      'run', {work_order: 'exact work', project: null},
      context('run', {work_order: 'exact work', project: null}, value.clock, {private: second, delegateId: 'delegate-exact'}),
    )
    assert.deepEqual(wrongShape.content, {error: 'invalid_operation', op: 'run'})

    const accepted = await executeConfirmed(value, second, 'delegate-exact')
    assert.equal(accepted.outcome, 'ok')
    assert.deepEqual(
      (await value.store.listWorkspaces()).map(item => item.display_name).sort(),
      ['alpha', 'beta'],
    )
    assert.equal(value.factory.calls.length, 1)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('new-run missing thread rolls back provisional session and failed confirmed create rolls back empty workspace', async () => {
  const value = await fixture()
  try {
    const committedWorkspaces: string[] = []
    value.adapter.observeCommittedWorkspace(event => {
      committedWorkspaces.push(event.workspace.display_name)
    })
    value.factory.reportThread = false
    const failed = await run(value, 'cannot bind')
    assert.deepEqual(failed.content, {error: 'thread_id_invalid', op: 'run', stage: 'thread_start'})
    const alpha = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(await value.store.listSessions(alpha), [])

    const operation = confirmed(value, {
      action: 'create', workspace_display_name: 'beta', workspace_id: null,
      session_title: 'Initial', session_id: null, work_order: 'cannot bind',
    })
    await value.adapter.commitConfirmed(operation, () => ({accepted: true, delegate_id: 'delegate-create'}))
    const result = await executeConfirmed(value, operation, 'delegate-create')
    assert.equal(result.outcome, 'failed')
    assert.deepEqual(committedWorkspaces, ['alpha'],
      'a confirmed create that rolls back must never become graph evidence')
    assert.deepEqual((await value.store.listWorkspaces()).map(item => item.display_name), ['alpha'])
    const publicView = value.adapter.publicProjectView(false)
    assert.deepEqual(publicView, {
      workspace_display_name: 'alpha',
      session_title: null,
      roster: [{name: 'alpha', last_used_at: 100, running: []}],
      pending_confirmation: false,
      pending_confirmation_busy: false,
    })
    assert.equal(JSON.stringify(publicView).includes('thread'), false)
    assert.equal(JSON.stringify(publicView).includes('nonce'), false)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('a residual create race is recoverably refused before effects', async () => {
  const value = await fixture()
  try {
    const operation = confirmed(value, {
      action: 'create', workspace_display_name: 'beta', workspace_id: null,
      session_title: null, session_id: null, work_order: 'build it',
    })
    assert.equal((await value.adapter.commitConfirmed(
      operation, () => ({accepted: true, delegate_id: 'delegate-race'}),
    )).accepted, true)
    await value.store.createManaged('beta')
    const result = await executeConfirmed(value, operation, 'delegate-race')
    assert.equal(result.outcome, 'refused')
    assert.deepEqual(result.content, {op: 'run', code: 'workspace_name_conflict', recoverable: true})
    assert.equal(value.factory.calls.length, 0)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('threadless preflight failures preserve their safe category, stage, rollback, and terminal observation', async () => {
  for (const [code, stage] of [
    ['preflight_failed', 'preflight'],
    ['credential_missing', 'credential'],
  ] as const) {
    const value = await fixture()
    try {
      const terminals: ExecutorHandoff[] = []
      value.adapter.observeTerminalWorkOrder(event => { terminals.push(event.handoff) })
      value.factory.preflightError = new CodexTransportError(code)
      const failed = await run(value, `fail at ${stage}`)
      assert.equal(failed.outcome, 'failed')
      assert.equal(failed.content.code, code)
      assert.equal(failed.content.stage, stage)
      assert.equal(failed.content.error, undefined)
      const alpha = await value.store.resolveWorkspace('alpha')
      assert.deepEqual(await value.store.listSessions(alpha), [])
      assert.deepEqual(terminals, [failed])
    } finally {
      await value.adapter.close()
      await rm(value.root, {recursive: true, force: true})
    }
  }
})

test('threadless transport refusal stays the real failure instead of becoming thread_id_invalid', async () => {
  const value = await fixture()
  try {
    const terminals: ExecutorHandoff[] = []
    value.adapter.observeTerminalWorkOrder(event => { terminals.push(event.handoff) })
    value.factory.reportThread = false
    value.factory.nextOutcome = {
      classification: 'refused', code: 'server_rejected', turnStartWritten: false, completion: null,
    }
    const failed = await run(value, 'fail during thread start')
    assert.equal(failed.outcome, 'failed')
    assert.equal(failed.content.code, 'worker_refused')
    assert.equal(failed.content.stage, 'thread_start')
    const alpha = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(await value.store.listSessions(alpha), [])
    assert.deepEqual(terminals, [failed])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('spawn failure returns a safe staged terminal and rolls back the provisional Session', async () => {
  const value = await fixture()
  try {
    const terminals: ExecutorHandoff[] = []
    value.adapter.observeTerminalWorkOrder(event => { terminals.push(event.handoff) })
    value.factory.createFailure = new CodexTransportError('spawn_failed')
    const failed = await run(value, 'fail while spawning')
    assert.deepEqual(failed.content, {error: 'spawn_failed', op: 'run', stage: 'spawn'})
    const alpha = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(await value.store.listSessions(alpha), [])
    assert.deepEqual(terminals, [failed])
    assert.deepEqual(value.adapter.running(), [], 'a failed run releases its slot')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('runtime cancellation still rejects with AbortError after provisional-session rollback is joined', async () => {
  const value = await fixture()
  try {
    const cancellation = new AbortController()
    value.factory.onRun = () => { cancellation.abort() }
    await assert.rejects(
      run(value, 'cancel after begin', {signal: cancellation.signal}),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )
    const workspace = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(
      (await value.store.listSessions(workspace)).map(session => [session.state, session.codex_thread_id]),
      [['ready', 'thread-1']],
    )
    assert.deepEqual(value.adapter.running(), [])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('active Session view publishes before transport run and republishes rollback restoration', async () => {
  const value = await fixture()
  const views: PublicProjectView[] = []
  let releasePublication!: () => void
  const publicationGate = new Promise<void>(resolve => { releasePublication = resolve })
  let publicationStarted!: () => void
  const publicationObserved = new Promise<void>(resolve => { publicationStarted = resolve })
  value.adapter.observeProjectView(async view => {
    views.push(view)
    if (view.session_title === 'First') {
      publicationStarted()
      await publicationGate
    }
  })
  await value.adapter.initialize()
  let release!: (outcome: TransportOutcome) => void
  const gate = new Promise<TransportOutcome>(resolve => { release = resolve })
  value.factory.runGate = gate
  let running!: () => void
  const started = new Promise<void>(resolve => { running = resolve })
  let transportStarted = false
  value.factory.onRun = () => {
    transportStarted = true
    running()
  }
  try {
    const work = run(value, 'publish before transport', {title: 'First'})
    await settleWithin('provider observes active Session', publicationObserved)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    const transportStartedEarly = transportStarted
    releasePublication()
    if (transportStartedEarly) {
      release(COMPLETE)
      await work
    }
    assert.equal(transportStartedEarly, false, 'transport must wait for active-context publication')
    await settleWithin('transport starts', started)
    const runningView = value.adapter.publicProjectView(false)
    const publishedRunningView = views.at(-1)
    assert.deepEqual(runningView.roster[0]?.running, [{work_id: 'delegate-publish before transport', title: 'First'}])
    release(COMPLETE)
    assert.equal((await work).outcome, 'ok')
    assert.equal(runningView.session_title, 'First')
    assert.equal(publishedRunningView?.session_title, 'First')
    assert.deepEqual(value.adapter.publicProjectView(false).roster[0]?.running, [])

    value.factory.runGate = undefined
    value.factory.onRun = undefined
    value.factory.createFailure = new Error('construction failed')
    await assert.rejects(run(value, 'rollback construction', {session: 'new', title: 'Second'}), /construction failed/u)
    assert.equal(value.adapter.publicProjectView(false).session_title, 'First')
    assert.deepEqual(views.slice(-2).map(view => view.session_title), ['Second', 'First'])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('critical active Session publication fails closed and rolls back on persistent state_busy', async () => {
  const value = await fixture({
    decorateStore: store => new Proxy(store, {
      get(target, property) {
        if (property === 'publicContext') {
          return (): never => { throw new ProjectStateError('state_busy') }
        }
        const member: unknown = Reflect.get(target, property, target)
        if (typeof member !== 'function') return member
        const bound: unknown = member.bind(target)
        return bound
      },
    }),
  })
  try {
    const result = await run(value, 'must not run without provider context')
    assert.deepEqual(result.content, {error: 'state_busy', op: 'run'})
    assert.equal(value.factory.calls.length, 0)
    const active = await value.store.resolveWorkspace(null)
    assert.equal(active.display_name, 'alpha')
    assert.deepEqual(await value.store.listSessions(active), [])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('a successful new run stays successful when only ready-state finalization is busy', async () => {
  const value = await fixture({
    decorateStore: store => new Proxy(store, {
      get(target, property) {
        if (property === 'markSessionReady') {
          return (): never => { throw new ProjectStateError('state_busy') }
        }
        const member: unknown = Reflect.get(target, property, target)
        if (typeof member !== 'function') return member
        const bound: unknown = member.bind(target)
        return bound
      },
    }),
  })
  try {
    const result = await run(value, 'completed despite bookkeeping contention')
    assert.equal(result.outcome, 'ok')
    assert.equal(result.content.code, 'completed')
    const active = await value.store.resolveWorkspace(null)
    assert.deepEqual(await value.store.listSessions(active), [])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('critical provider publication failure rolls back before transport while UI remains advisory', async () => {
  const value = await fixture()
  const critical: {readonly workspace_id: string | null; readonly title: string | null}[] = []
  value.adapter.observeProjectView(() => { throw new Error('UI renderer failed') })
  const unsubscribe = observeCriticalProjectContext(value.adapter, contextValue => {
    critical.push({workspace_id: contextValue.workspace_id, title: contextValue.view.session_title})
    if (contextValue.view.session_title === 'Doomed') throw new Error('provider delivery proof mismatch')
  })
  try {
    const result = await run(value, 'must not reach transport', {title: 'Doomed'})
    assert.deepEqual(result.content, {error: 'context_delivery_failed', op: 'run'})
    assert.equal(value.factory.calls.length, 0)
    const active = await value.store.resolveWorkspace(null)
    assert.deepEqual(await value.store.listSessions(active), [])
    assert.deepEqual(critical, [
      {workspace_id: active.workspace_id, title: 'Doomed'},
      {workspace_id: active.workspace_id, title: null},
    ])
  } finally {
    unsubscribe()
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('critical confirmed-create publication failure removes the workspace and republishes prior state', async () => {
  const value = await fixture()
  const critical: {readonly workspace: string | null; readonly session: string | null}[] = []
  let rejectCreate = true
  const unsubscribe = observeCriticalProjectContext(value.adapter, contextValue => {
    critical.push({workspace: contextValue.view.workspace_display_name, session: contextValue.view.session_title})
    if (rejectCreate && contextValue.view.workspace_display_name === 'beta') {
      rejectCreate = false
      throw new Error('provider rejected created workspace context')
    }
  })
  try {
    const operation = confirmed(value, {
      action: 'create', workspace_display_name: 'beta', workspace_id: null,
      session_title: null, session_id: null, work_order: 'must not reach transport',
    })
    assert.equal((await value.adapter.commitConfirmed(
      operation, () => ({accepted: true, delegate_id: 'delegate-create-barrier'}),
    )).accepted, true)
    const result = await executeConfirmed(value, operation, 'delegate-create-barrier')
    assert.deepEqual(result.content, {error: 'context_delivery_failed', op: 'run'})
    assert.equal(value.factory.calls.length, 0)
    assert.deepEqual((await value.store.listWorkspaces()).map(item => item.display_name), ['alpha'])
    assert.deepEqual(critical.at(-1), {workspace: 'alpha', session: null})
  } finally {
    unsubscribe()
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('confirmed select publishes one atomic context before committed graph notification', async () => {
  const value = await fixture()
  await value.store.createManaged('beta')
  const order: string[] = []
  const unsubscribeContext = observeCriticalProjectContext(value.adapter, contextValue => {
    order.push(`context:${contextValue.workspace_id}:${contextValue.view.workspace_display_name}`)
  })
  const unsubscribeCommitted = value.adapter.observeCommittedWorkspace(event => {
    order.push(`committed:${event.workspace.workspace_id}:${event.workspace.display_name}`)
  })
  try {
    const alpha = await value.store.resolveWorkspace('alpha')
    const operation = confirmed(value, {
      action: 'select', workspace_display_name: 'alpha', workspace_id: alpha.workspace_id,
      session_title: null, session_id: null, work_order: null,
    })
    const committed = await value.adapter.commitConfirmed(operation, () => ({accepted: false, delegate_id: null}))
    assert.deepEqual(committed, {accepted: true, code: 'committed'})
    assert.deepEqual(order, [
      `context:${alpha.workspace_id}:alpha`,
      `committed:${alpha.workspace_id}:alpha`,
    ])
  } finally {
    unsubscribeContext()
    unsubscribeCommitted()
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('transport close rejection cannot downgrade a completed side effect into a retryable failure', async () => {
  const value = await fixture()
  try {
    value.factory.closeFailures = 1
    const result = await run(value, 'completed before cleanup')
    assert.equal(result.outcome, 'ok')
    const workspace = await value.store.resolveWorkspace('alpha')
    assert.deepEqual((await value.store.listSessions(workspace)).map(session => session.state), ['ready'])
    assert.equal(value.factory.transports[0]?.closeCalls, 1)
    value.factory.closeFailures = 0
    const second = await run(value, 'new process only after retained cleanup')
    assert.equal(second.outcome, 'ok')
    assert.equal(value.factory.transports[0]?.closeCalls, 2)
    assert.equal(value.factory.transports.length, 2)
  } finally {
    await value.adapter.close().catch(() => undefined)
    await rm(value.root, {recursive: true, force: true})
  }
})

test('a confirmed run into a busy project is rolled back at commit instead of racing the slot', async () => {
  const value = await fixture()
  let startedResolve!: () => void
  let finishResolve!: (outcome: TransportOutcome) => void
  const started = new Promise<void>(resolve => { startedResolve = resolve })
  value.factory.onRun = startedResolve
  value.factory.runGate = new Promise<TransportOutcome>(resolve => { finishResolve = resolve })
  try {
    const alpha = await value.store.resolveWorkspace('alpha')
    const operation = confirmed(value, {
      action: 'reuse', workspace_display_name: 'alpha', workspace_id: alpha.workspace_id,
      session_title: 'Initial', session_id: null, work_order: 'build',
    })
    const running = run(value, 'blocking', {title: 'Blocking'})
    await settleWithin('busy project run start', started)
    const committed = await value.adapter.commitConfirmed(operation, () => ({accepted: true, delegate_id: 'delegate-confirmed'}))
    assert.deepEqual(committed, {accepted: false, code: 'busy'})
    assert.equal(value.confirmation.pending, true, 'the proposal survives a busy rollback')
    finishResolve(COMPLETE)
    assert.equal((await settleWithin('busy project run completion', running)).outcome, 'ok')
  } finally {
    finishResolve?.(COMPLETE)
    await value.adapter.close().catch(() => undefined)
    await rm(value.root, {recursive: true, force: true})
  }
})

test('close aborts an active run, joins its durable session finalizer, then closes the store', async () => {
  const value = await fixture()
  let startedResolve!: () => void
  const started = new Promise<void>(resolve => { startedResolve = resolve })
  value.factory.onRun = startedResolve
  value.factory.runGate = new Promise<TransportOutcome>(() => undefined)
  const running = run(value, 'close while running')
  const runningOutcome = running.then<Error | null, Error | null>(() => null, error => (
    error instanceof Error ? error : new Error('non-error project rejection')
  ))
  try {
    await settleWithin('project transport run start', started)
    const closing = value.adapter.close()
    assert.equal(value.adapter.close(), closing)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    value.clock.advanceTo(value.clock.now() + 10)
    await settleWithin('project adapter close', closing)
    const runError = await settleWithin('cancelled project dispatch', runningOutcome)
    assert.equal(runError?.name, 'AbortError', 'a host shutdown is not a user cancel')
    assert.equal(value.factory.transports[0]?.closeCalls, 1)
    const state = JSON.parse(
      await readFile(join(value.root, 'state', 'codex-projects-v1.json'), 'utf8'),
    ) as {readonly sessions: Readonly<Record<string, {readonly state: string}>>}
    assert.equal(Object.values(state.sessions).some(session => session.state === 'starting'), false)
  } finally {
    await value.adapter.close().catch(() => undefined)
    await running.catch(() => undefined)
    await rm(value.root, {recursive: true, force: true})
  }
})

test('workspace replacement is rejected before a provisional session or transport exists', async () => {
  const value = await fixture()
  try {
    const workspacePath = join(value.root, 'workspace')
    const replacement = join(value.root, 'replacement')
    await mkdir(replacement, {mode: 0o700})
    await rename(workspacePath, join(value.root, 'workspace-original'))
    await symlink(replacement, workspacePath, process.platform === 'win32' ? 'junction' : 'dir')
    const result = await run(value, 'must not start')
    assert.deepEqual(result.content, {error: 'workspace_boundary_changed', op: 'run'})
    const workspace = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(await value.store.listSessions(workspace), [])
    assert.equal(value.factory.calls.length, 0)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('workspace replacement after persistent-home setup is rejected by the factory-bound revalidation', async () => {
  let replace = false
  let rootPath = ''
  const value = await fixture({
    decorateStore: store => storeWithPersistentHomeHook(store, async () => {
      if (!replace) return
      replace = false
      const workspacePath = join(rootPath, 'workspace')
      const replacement = join(rootPath, 'replacement-after-home')
      await mkdir(replacement, {mode: 0o700})
      await rename(workspacePath, join(rootPath, 'workspace-before-home-swap'))
      await symlink(replacement, workspacePath, process.platform === 'win32' ? 'junction' : 'dir')
    }),
  })
  rootPath = value.root
  try {
    replace = true
    const result = await run(value, 'must not bind replacement')
    assert.deepEqual(result.content, {error: 'workspace_boundary_changed', op: 'run'})
    assert.equal(value.factory.calls.length, 0)
    const workspace = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(await value.store.listSessions(workspace), [])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('resume exact-thread mismatch marks unavailable while transient transport refusal preserves ready', async () => {
  const value = await fixture()
  try {
    await run(value, 'first', {title: 'Task'})
    const workspace = await value.store.resolveWorkspace('alpha')
    const session = await value.store.resolveSession(workspace.workspace_id, 'Task')

    value.factory.reportThread = false
    value.factory.nextOutcome = {
      classification: 'refused', code: 'transport_lost', turnStartWritten: false, completion: null,
    }
    const transient = await run(value, 'continue', {session: 'latest', delegateId: 'delegate-transient'})
    assert.equal(transient.outcome, 'failed')
    assert.equal((await value.store.resolveSession(workspace.workspace_id, 'Task')).state, 'ready')

    value.factory.reportThread = true
    value.factory.nextOutcome = COMPLETE
    value.factory.overrideThreadId = 'wrong-thread'
    const mismatch = await run(value, 'continue again', {session: 'latest', delegateId: 'delegate-mismatch'})
    assert.deepEqual(mismatch.content, {error: 'session_thread_mismatch', op: 'run', stage: 'thread_start'})
    assert.equal((await value.store.resolveSession(workspace.workspace_id, session.display_title)).state, 'unavailable')

    value.factory.overrideThreadId = null
    const fresh = await run(value, 'start over', {session: 'latest', title: 'Fresh', delegateId: 'delegate-fresh'})
    assert.equal(fresh.outcome, 'ok')
    assert.deepEqual(value.factory.calls.at(-1), {resume: false}, 'latest without a resumable session starts a new one')
    assert.equal(value.factory.transports.at(-1)?.runInputs[0]?.threadName, 'Fresh')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('private resume-unavailable disposition marks the exact stored session unavailable', async () => {
  const value = await fixture()
  try {
    await run(value, 'first', {title: 'Task'})
    const workspace = await value.store.resolveWorkspace('alpha')
    value.factory.reportThread = false
    value.factory.nextOutcome = {
      classification: 'refused', code: 'resume_unavailable', turnStartWritten: false, completion: null,
    }
    const unavailable = await run(value, 'continue', {session: 'latest'})
    assert.equal(unavailable.content.code, 'worker_refused')
    assert.equal((await value.store.resolveSession(workspace.workspace_id, 'Task')).state, 'unavailable')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('confirmed resume whose session changed after persistent-home setup is refused before transport', async () => {
  let invalidate: (() => Promise<void>) | null = null
  const value = await fixture({
    decorateStore: store => storeWithPersistentHomeHook(store, async () => {
      await invalidate?.()
    }),
  })
  try {
    await run(value, 'first', {title: 'Task'})
    const workspace = await value.store.resolveWorkspace('alpha')
    const session = await value.store.resolveSession(workspace.workspace_id, 'Task')
    const operation = confirmed(value, {
      action: 'resume', workspace_display_name: 'alpha', workspace_id: workspace.workspace_id,
      session_title: 'Task', session_id: session.session_id, work_order: 'continue',
    })
    await value.adapter.commitConfirmed(operation, () => ({accepted: true, delegate_id: 'delegate-late-state'}))
    invalidate = async () => {
      invalidate = null
      await value.store.markSessionUnavailable(session.session_id, {wait: true})
    }
    const result = await executeConfirmed(value, operation, 'delegate-late-state')
    assert.equal(result.outcome, 'refused')
    assert.deepEqual(result.content, {op: 'run', code: 'session_unavailable', recoverable: true})
    assert.equal(value.factory.calls.length, 1)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('intake target resolution is canonical and side-effect free for work, create, and switch', async () => {
  const value = await fixture({preexistingSession: true})
  try {
    await value.adapter.initialize()
    const before = await value.store.snapshot()
    const workspace = await value.store.resolveWorkspace('alpha')
    const latest = await value.adapter.resolveIntakeTarget({kind: 'work', project: null, session: 'latest'})
    assert.deepEqual(latest, {
      action: 'resume', workspace: workspace.canonical_path, workspace_display_name: 'alpha',
      workspace_id: workspace.workspace_id, session_title: 'Existing', session_id: workspace.active_session_id,
    })
    const fresh = await value.adapter.resolveIntakeTarget({kind: 'work', project: 'ALPHA', session: 'new'})
    assert.equal(fresh.action, 'reuse')
    assert.equal(fresh.session_id, null)
    const created = await value.adapter.resolveIntakeTarget({kind: 'create', project: 'beta', session: 'new'})
    assert.deepEqual(created, {
      action: 'create', workspace: 'beta', workspace_display_name: 'beta', workspace_id: null,
      session_title: null, session_id: null,
    })
    assert.deepEqual(await value.store.snapshot(), before)
    assert.deepEqual(readdirSync(join(value.root, 'managed')), [])
    assert.equal(value.confirmation.pending, false)
    assert.equal(value.factory.calls.length, 0)

    await assert.rejects(
      value.adapter.resolveIntakeTarget({kind: 'create', project: 'alpha', session: 'new'}),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'workspace_name_conflict',
    )
    await assert.rejects(
      value.adapter.resolveIntakeTarget({kind: 'work', project: 'gamma', session: 'latest'}),
      (error: unknown) => error instanceof ProjectResolutionError && error.code === 'unknown_project'
        && error.detail.hint === 'create' && JSON.stringify(error.detail.suggestions) === '["alpha"]',
    )
    // `switch` resolves without side effects; `activateProject` then activates the named project, unconfirmed.
    const beta = await value.store.createManaged('beta')
    assert.equal((await value.store.resolveWorkspace(null)).workspace_id, beta.workspace_id)
    const switched = await value.adapter.resolveIntakeTarget({kind: 'switch', project: 'alpha', session: 'latest'})
    assert.equal(switched.action, 'resume')
    assert.equal((await value.store.resolveWorkspace(null)).workspace_id, beta.workspace_id)
    await value.adapter.activateProject(switched)
    assert.equal((await value.store.resolveWorkspace(null)).workspace_id, workspace.workspace_id)
    assert.equal(value.adapter.publicProjectView(false).workspace_display_name, 'alpha')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})