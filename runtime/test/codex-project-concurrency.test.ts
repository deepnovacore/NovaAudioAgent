/**
 * Spec 08 run slots: one running work per workspace, `MAX_CONCURRENT_WORK` across workspaces,
 * adapter-level cancel, host titles on new threads, and the deterministic intake resolver.
 */
import assert from 'node:assert/strict'
import {rm} from 'node:fs/promises'
import {test} from 'node:test'

import type {TransportOutcome} from '../src/executors/codex/app-server-transport.js'
import {ProjectResolutionError, type RunningWork} from '../src/coding-executor.js'
import type {ExecutorHandoff} from '../src/causal-runtime.js'
import {MAX_CONCURRENT_WORK} from '../src/work-tools.js'
import {
  COMPLETE,
  context,
  fixture,
  run,
  settleWithin,
  type Fixture,
} from './fixtures/codex/project-adapter-fixture.js'

interface Gate {
  readonly started: Promise<void>
  readonly release: (outcome?: TransportOutcome) => void
}

/** One gate per project so runs can be held open and released independently. */
function gateProjects(value: Fixture, projects: readonly string[]): Map<string, Gate> {
  const gates = new Map<string, Gate>()
  const outcomes = new Map<string, Promise<TransportOutcome>>()
  const starters = new Map<string, () => void>()
  for (const project of projects) {
    let release!: (outcome: TransportOutcome) => void
    let start!: () => void
    outcomes.set(project, new Promise<TransportOutcome>(resolve => { release = resolve }))
    const started = new Promise<void>(resolve => { start = resolve })
    starters.set(project, start)
    gates.set(project, {started, release: (outcome = COMPLETE) => { release(outcome) }})
  }
  value.factory.gateFor = binding => outcomes.get(binding.work.project)
  value.factory.onRun = () => {
    // The transport that just started is the last one created.
    const binding = value.factory.bindings.at(-1)
    if (binding !== undefined) starters.get(binding.work.project)?.()
  }
  return gates
}

async function withProjects(value: Fixture, names: readonly string[]): Promise<void> {
  for (const name of names) await value.store.createManaged(name)
}

const noResolver = {resolveCancelTarget: (): Promise<string | null> => Promise.reject(new Error('must not be asked'))}

test('different projects run in parallel; a busy project refuses; the cap refuses with the running list', async () => {
  const value = await fixture()
  await withProjects(value, ['beta', 'gamma', 'delta'])
  const gates = gateProjects(value, ['alpha', 'beta', 'gamma'])
  const terminals: ExecutorHandoff[] = []
  value.adapter.observeTerminalWorkOrder(event => { terminals.push(event.handoff) })
  try {
    const alpha = run(value, 'alpha work', {project: 'alpha', title: 'Alpha', delegateId: 'work-alpha'})
    await settleWithin('alpha starts', gates.get('alpha')!.started)
    const beta = run(value, 'beta work', {project: 'beta', title: 'Beta', delegateId: 'work-beta'})
    await settleWithin('beta starts', gates.get('beta')!.started)

    assert.deepEqual(value.adapter.running(), [
      {work_id: 'work-alpha', project: 'alpha', title: 'Alpha'},
      {work_id: 'work-beta', project: 'beta', title: 'Beta'},
    ])
    const byName = <T extends {readonly name: string}>(entries: readonly T[]): Record<string, T> =>
      Object.fromEntries(entries.map(entry => [entry.name, entry]))
    const roster = byName(value.adapter.roster())
    assert.deepEqual(Object.keys(roster).sort(), ['alpha', 'beta', 'delta', 'gamma'])
    assert.deepEqual(roster.alpha, {name: 'alpha', last_used_at: 100, last_session_title: 'Alpha', running: [{work_id: 'work-alpha', title: 'Alpha'}]})
    assert.deepEqual(roster.beta?.running, [{work_id: 'work-beta', title: 'Beta'}])
    assert.deepEqual(roster.gamma?.running, [])
    const publicRoster = byName(value.adapter.publicProjectView(false).roster)
    assert.deepEqual(publicRoster.alpha, {name: 'alpha', last_used_at: 100, running: [{work_id: 'work-alpha', title: 'Alpha'}]})
    assert.deepEqual(publicRoster.delta?.running, [])

    const busy = await run(value, 'second alpha', {project: 'alpha', session: 'new', delegateId: 'work-alpha-2'})
    assert.deepEqual(busy, {
      outcome: 'refused', trust: 'trusted_system',
      content: {op: 'run', code: 'busy_project', project: 'alpha', work_id: 'work-alpha', title: 'Alpha', recoverable: true},
    })
    assert.equal(value.factory.calls.length, 2, 'a refused run constructs no transport')

    const gamma = run(value, 'gamma work', {project: 'gamma', title: 'Gamma', delegateId: 'work-gamma'})
    await settleWithin('gamma starts', gates.get('gamma')!.started)
    assert.equal(value.adapter.running().length, MAX_CONCURRENT_WORK)
    const capacity = await run(value, 'delta work', {project: 'delta', delegateId: 'work-delta'})
    assert.equal(capacity.outcome, 'refused')
    assert.deepEqual(capacity.content, {
      op: 'run', code: 'capacity', recoverable: true,
      running: [
        {work_id: 'work-alpha', project: 'alpha', title: 'Alpha'},
        {work_id: 'work-beta', project: 'beta', title: 'Beta'},
        {work_id: 'work-gamma', project: 'gamma', title: 'Gamma'},
      ],
    })

    for (const gate of gates.values()) gate.release()
    const results = await Promise.all([alpha, beta, gamma])
    assert.deepEqual(results.map(result => result.outcome), ['ok', 'ok', 'ok'])
    assert.deepEqual(value.adapter.running(), [])
    assert.deepEqual(value.adapter.roster().map(entry => entry.running), [[], [], [], []])
    assert.deepEqual(value.factory.transports.map(transport => transport.closeCalls), [1, 1, 1])
    assert.equal(terminals.length, 3, 'refusals are not terminal work-order events')
    for (const name of ['alpha', 'beta', 'gamma']) {
      const workspace = await value.store.resolveWorkspace(name)
      assert.deepEqual(
        (await value.store.listSessions(workspace)).map(session => [session.state, session.display_title]),
        [['ready', name[0]!.toUpperCase() + name.slice(1)]],
      )
    }
  } finally {
    for (const gate of gates.values()) gate.release()
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('cancel aborts the run slot: one close, a cancelled handoff through the normal path, then not_running', async () => {
  const value = await fixture()
  const gates = gateProjects(value, ['alpha'])
  const terminals: ExecutorHandoff[] = []
  value.adapter.observeTerminalWorkOrder(event => { terminals.push(event.handoff) })
  try {
    const work = run(value, 'long task', {title: 'Long', delegateId: 'work-1'})
    await settleWithin('run starts', gates.get('alpha')!.started)
    const cancelled = await value.adapter.cancel(undefined, noResolver)
    assert.deepEqual(cancelled, {code: 'cancelled', work: {work_id: 'work-1', project: 'alpha', title: 'Long'}})
    const handoff = await settleWithin('cancelled handoff', work)
    assert.deepEqual(handoff, {
      outcome: 'cancelled', trust: 'trusted_system', content: {reason: 'user_cancelled', work_id: 'work-1'},
    })
    assert.equal(value.factory.transports[0]?.closeCalls, 1, 'close (which interrupts) happens exactly once')
    assert.deepEqual(terminals, [handoff])
    assert.deepEqual(value.adapter.running(), [])
    assert.deepEqual(await value.adapter.cancel(undefined, noResolver), {code: 'not_running'})
    const workspace = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(
      (await value.store.listSessions(workspace)).map(session => [session.state, session.codex_thread_id]),
      [['ready', 'thread-1']],
      'a cancelled session whose thread was reported survives as resumable history',
    )
    assert.deepEqual(value.adapter.publicProjectView(false).roster[0]?.running, [])
  } finally {
    for (const gate of gates.values()) gate.release()
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('cancel before the thread exists rolls the provisional session back', async () => {
  const value = await fixture()
  value.factory.reportThread = false
  const gates = gateProjects(value, ['alpha'])
  try {
    const work = run(value, 'never binds', {delegateId: 'work-1'})
    await settleWithin('run starts', gates.get('alpha')!.started)
    assert.equal((await value.adapter.cancel(undefined, noResolver)).code, 'cancelled')
    const handoff = await settleWithin('cancelled handoff', work)
    assert.equal(handoff.outcome, 'cancelled')
    assert.deepEqual(await value.store.listSessions(await value.store.resolveWorkspace('alpha')), [])
  } finally {
    for (const gate of gates.values()) gate.release()
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('cancel with several running works asks resolveCancelTarget once and reports ambiguity honestly', async () => {
  const value = await fixture()
  await withProjects(value, ['beta', 'gamma'])
  const gates = gateProjects(value, ['alpha', 'beta', 'gamma'])
  const works: Promise<ExecutorHandoff>[] = []
  try {
    for (const project of ['alpha', 'beta', 'gamma']) {
      works.push(run(value, `${project} work`, {project, title: project, delegateId: `work-${project}`}))
      await settleWithin(`${project} starts`, gates.get(project)!.started)
    }
    const running = value.adapter.running()
    assert.equal(running.length, 3)

    assert.deepEqual(await value.adapter.cancel(undefined, noResolver), {code: 'ambiguous_work', running})
    assert.deepEqual(await value.adapter.cancel('', noResolver), {code: 'ambiguous_work', running})

    const asked: [string, readonly RunningWork[]][] = []
    const resolver = (answer: string | null) => ({
      resolveCancelTarget: (instruction: string, candidates: readonly RunningWork[]): Promise<string | null> => {
        asked.push([instruction, candidates])
        return Promise.resolve(answer)
      },
    })
    assert.deepEqual(await value.adapter.cancel('the beta one', resolver('work-beta')), {
      code: 'cancelled', work: {work_id: 'work-beta', project: 'beta', title: 'beta'},
    })
    assert.deepEqual(asked, [['the beta one', running]])
    assert.equal((await settleWithin('beta cancelled', works[1]!)).outcome, 'cancelled')

    const remaining = value.adapter.running()
    assert.deepEqual(remaining.map(work => work.work_id), ['work-alpha', 'work-gamma'])
    assert.deepEqual(await value.adapter.cancel('something vague', resolver(null)), {code: 'ambiguous_work', running: remaining})
    assert.deepEqual(await value.adapter.cancel('stale', resolver('work-beta')), {code: 'ambiguous_work', running: remaining})

    const viaOp = await value.adapter.dispatch('cancel', {work_id: 'work-alpha'}, context('cancel', {work_id: 'work-alpha'}, value.clock))
    assert.deepEqual(viaOp, {outcome: 'ok', trust: 'trusted_system', content: {op: 'cancel', code: 'cancelled', work_id: 'work-alpha'}})
    assert.equal((await settleWithin('alpha cancelled', works[0]!)).outcome, 'cancelled')
    const again = await value.adapter.dispatch('cancel', {work_id: 'work-alpha'}, context('cancel', {work_id: 'work-alpha'}, value.clock))
    assert.deepEqual(again.content, {op: 'cancel', code: 'not_running', work_id: 'work-alpha'})

    assert.deepEqual(await value.adapter.cancel(undefined, noResolver), {
      code: 'cancelled', work: {work_id: 'work-gamma', project: 'gamma', title: 'gamma'},
    })
    assert.equal((await settleWithin('gamma cancelled', works[2]!)).outcome, 'cancelled')
    assert.deepEqual(value.factory.transports.map(transport => transport.closeCalls), [1, 1, 1])
  } finally {
    for (const gate of gates.values()) gate.release()
    await Promise.allSettled(works)
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('steer targets the named project slot; idle projects report no_active_turn', async () => {
  const value = await fixture()
  await withProjects(value, ['beta'])
  const gates = gateProjects(value, ['alpha'])
  try {
    const work = run(value, 'alpha work', {project: 'alpha', title: 'Alpha', delegateId: 'work-alpha'})
    await settleWithin('alpha starts', gates.get('alpha')!.started)
    const steerAlpha = await value.adapter.dispatch(
      'steer', {instruction: 'also lint', project: 'alpha'},
      context('steer', {instruction: 'also lint', project: 'alpha'}, value.clock),
    )
    assert.equal(steerAlpha.content.code, 'accepted')
    const steerBeta = await value.adapter.dispatch(
      'steer', {instruction: 'nothing runs here', project: 'beta'},
      context('steer', {instruction: 'nothing runs here', project: 'beta'}, value.clock),
    )
    assert.equal(steerBeta.content.code, 'no_active_turn')
    const steerUnknown = await value.adapter.dispatch(
      'steer', {instruction: 'nowhere', project: 'omega'},
      context('steer', {instruction: 'nowhere', project: 'omega'}, value.clock),
    )
    assert.deepEqual(steerUnknown.content, {op: 'steer', code: 'workspace_not_found', recoverable: true})
    gates.get('alpha')!.release()
    assert.equal((await work).outcome, 'ok')
  } finally {
    for (const gate of gates.values()) gate.release()
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('a new thread is named by the host title and a Codex rename is mirrored into the session and running work', async () => {
  const titleWrites: Promise<boolean>[] = []
  const value = await fixture({
    decorateStore: store => new Proxy(store, {
      get(target, property) {
        if (property === 'setSessionTitle') {
          return (sessionId: string, title: string) => {
            const write = target.setSessionTitle(sessionId, title)
            titleWrites.push(write)
            return write
          }
        }
        const member: unknown = Reflect.get(target, property, target)
        return typeof member === 'function' ? member.bind(target) as unknown : member
      },
    }),
  })
  const gates = gateProjects(value, ['alpha'])
  let work: Promise<ExecutorHandoff> | null = null
  try {
    work = run(value, 'write the blog post', {title: 'Blog', delegateId: 'work-1'})
    await settleWithin('run starts', gates.get('alpha')!.started)
    const transport = value.factory.transports[0]!
    assert.equal(transport.runInputs[0]?.threadName, 'Blog')
    assert.equal(value.adapter.running()[0]?.title, 'Blog')
    transport.observers[0]!.onThreadNamed?.('thread-1', 'Blog: draft outline')
    transport.observers[0]!.onThreadNamed?.('thread-1', null)
    assert.equal(titleWrites.length, 1, 'a cleared name is not mirrored')
    assert.equal(await titleWrites[0], true)
    assert.equal(value.adapter.running()[0]?.title, 'Blog: draft outline')
    const workspace = await value.store.resolveWorkspace('alpha')
    assert.deepEqual((await value.store.listSessions(workspace)).map(session => session.display_title), ['Blog: draft outline'])
    gates.get('alpha')!.release()
    assert.equal((await work).outcome, 'ok')
    assert.deepEqual(value.adapter.roster()[0]?.last_session_title, 'Blog: draft outline')
  } finally {
    for (const gate of gates.values()) gate.release()
    await work?.catch(() => undefined)
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('resolveIntakeTarget refuses busy and full deterministically while switch still activates', async () => {
  const value = await fixture()
  await withProjects(value, ['beta', 'gamma', 'delta'])
  const gates = gateProjects(value, ['alpha', 'beta', 'gamma'])
  try {
    const alpha = run(value, 'alpha work', {project: 'alpha', title: 'Alpha', delegateId: 'work-alpha'})
    await settleWithin('alpha starts', gates.get('alpha')!.started)

    await assert.rejects(
      value.adapter.resolveIntakeTarget({kind: 'work', project: 'alpha', session: 'new'}),
      (error: unknown) => error instanceof ProjectResolutionError && error.code === 'busy_project'
        && JSON.stringify(error.detail) === JSON.stringify({
          project: 'alpha', work_id: 'work-alpha', title: 'Alpha', options: ['steer', 'cancel'],
        }),
    )
    const idle = await value.adapter.resolveIntakeTarget({kind: 'work', project: 'beta', session: 'latest'})
    assert.equal(idle.action, 'reuse')
    assert.equal(idle.workspace_display_name, 'beta')

    const beta = run(value, 'beta work', {project: 'beta', title: 'Beta', delegateId: 'work-beta'})
    await settleWithin('beta starts', gates.get('beta')!.started)
    const gamma = run(value, 'gamma work', {project: 'gamma', title: 'Gamma', delegateId: 'work-gamma'})
    await settleWithin('gamma starts', gates.get('gamma')!.started)
    await assert.rejects(
      value.adapter.resolveIntakeTarget({kind: 'work', project: 'delta', session: 'latest'}),
      (error: unknown) => error instanceof ProjectResolutionError && error.code === 'capacity'
        && JSON.stringify(error.detail) === JSON.stringify({running: value.adapter.running()}),
    )
    await assert.rejects(
      value.adapter.resolveIntakeTarget({kind: 'work', project: 'epsilon', session: 'latest'}),
      (error: unknown) => error instanceof ProjectResolutionError && error.code === 'unknown_project'
        && Array.isArray(error.detail.suggestions) && error.detail.suggestions.length === 3,
    )
    await assert.rejects(
      value.adapter.resolveIntakeTarget({kind: 'work', project: 'bet', session: 'latest'}),
      (error: unknown) => error instanceof ProjectResolutionError && error.code === 'unknown_project'
        && JSON.stringify(error.detail.suggestions) === '["beta"]',
    )

    // Switching to a busy or idle project is allowed while full: it changes focus, not capacity.
    const switched = await value.adapter.resolveIntakeTarget({kind: 'switch', project: 'delta', session: 'latest'})
    assert.equal(switched.action, 'reuse')
    assert.equal((await value.store.resolveWorkspace(null)).display_name, 'delta')
    assert.equal(value.adapter.publicProjectView(false).workspace_display_name, 'delta')
    const focusBusy = await value.adapter.resolveIntakeTarget({kind: 'switch', project: 'alpha', session: 'latest'})
    assert.equal(focusBusy.workspace_display_name, 'alpha')

    for (const gate of gates.values()) gate.release()
    assert.deepEqual((await Promise.all([alpha, beta, gamma])).map(result => result.outcome), ['ok', 'ok', 'ok'])
  } finally {
    for (const gate of gates.values()) gate.release()
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})
