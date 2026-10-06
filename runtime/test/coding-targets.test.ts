import assert from 'node:assert/strict'
import test from 'node:test'
import {rm} from 'node:fs/promises'
import {CodingTargetController, type CodingTarget} from '../src/personal-agent/coding-targets.js'
import {fixture, run, context} from './fixtures/codex/project-adapter-fixture.js'

const work = {kind: 'work', project: null, session: 'latest'} as const

test('conversation targets retain exact sessions across global focus changes and dispatch the selected thread', async () => {
  const value = await fixture({preexistingSession: true})
  try {
    await value.adapter.initialize()
    const a = new CodingTargetController(value.adapter.targetPort)
    const b = new CodingTargetController(value.adapter.targetPort)
    const original = await a.port.validate((await a.list()).find(target => target.session_id !== null)!)
    assert.deepEqual(Object.keys(original).sort(), ['executor', 'project', 'session_id', 'title', 'workspace_id'])
    await a.setTarget(original)
    await run(value, 'another task', {session: 'new', title: 'Another'})
    const latest = await b.port.validate((await b.list()).find(target => target.title === 'Another')!)
    assert.deepEqual(await value.adapter.targetPort.forWork!('delegate-another task'), latest)
    await b.setTarget(latest)
    assert.notEqual(latest.session_id, original.session_id)
    assert.equal((await a.resolveTarget(work)).session_id, original.session_id)
    assert.equal((await b.resolveTarget(work)).session_id, latest.session_id)
    const beta = await value.store.createManaged('beta')
    await value.store.selectWorkspace('beta')
    assert.deepEqual(await value.adapter.targetPort.forWork!('delegate-another task'), latest, 'work binding ignores later global focus')
    assert.equal((await a.resolveTarget(work)).workspace_id, original.workspace_id)
    assert.equal((await a.resolveTarget({...work, project: 'beta', session: 'new'})).workspace_id, beta.workspace_id)
    const resolved = await a.resolveTarget(work)
    const request = {work_order: 'continue original', project: resolved.workspace_display_name, session: 'latest', session_id: resolved.session_id!}
    assert.equal((await value.adapter.dispatch('run', request, context('run', request, value.clock))).outcome, 'ok')
    assert.equal(value.factory.bindings.at(-1)?.resumeThreadId, 'thread-existing')
    assert.equal(await value.adapter.targetPort.forWork!('unknown-work'), null)
    await a.setTarget({...original, session_id: null})
    assert.equal((await a.resolveTarget({...work, session: 'new'})).session_id, null, 'project-only target starts a new session')
    await a.setTarget(null)
    await assert.rejects(a.resolveTarget(work), {code: 'unknown_project'})
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('mismatched and stale exact targets fail closed without falling back to the global session', async () => {
  const value = await fixture({preexistingSession: true})
  try {
    await value.adapter.initialize()
    const controller = new CodingTargetController(value.adapter.targetPort)
    const target = (await controller.list()).find(target => target.session_id !== null)!
    await controller.setTarget(target)
    const beta = await value.store.createManaged('beta')
    await assert.rejects(controller.setTarget({...target, workspace_id: beta.workspace_id}), {code: 'unknown_session'})
    await assert.rejects(value.adapter.targetPort.resolve({...work, project: 'beta'}, target), {code: 'unknown_project'})
    await value.store.markSessionUnavailable(target.session_id!, {wait: true})
    await assert.rejects(controller.resolveTarget(work), {code: 'unknown_session'})
    assert.equal((await controller.list()).some(item => item.session_id === target.session_id), false)
    assert.equal((await controller.resolveTarget({...work, session: 'new'})).session_id, null, 'explicit new-session intent does not inherit a stale session')
    assert.equal(value.factory.calls.length, 0)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})


test('accepted work remembers its native session and a confirmed switch fences old completions', async () => {
  const value = await fixture()
  const remembered: CodingTarget[] = []
  const controller = new CodingTargetController(value.adapter.targetPort, (target, current) => {
    if (!current()) return Promise.resolve(false)
    remembered.push(target)
    return Promise.resolve(true)
  })
  try {
    await value.adapter.initialize()
    const project = (await controller.list())[0]!
    await controller.accepted(project, 'delegate-first', controller.revision)
    assert.equal(controller.target?.session_id, null)
    await run(value, 'first', {session: 'new'})
    await controller.refreshWork()
    const actual = await value.adapter.targetPort.forWork!('delegate-first')
    assert.ok(actual?.session_id)
    assert.deepEqual(controller.target, actual)
    assert.equal((await controller.resolveTarget(work)).session_id, actual.session_id)
    assert.deepEqual(remembered.at(-1), actual)

    await controller.accepted(project, 'delegate-old', controller.revision)
    const beta = await value.store.createManaged('beta')
    await controller.accepted({workspace_id: beta.workspace_id, session_id: null}, undefined, controller.revision)
    await run(value, 'old', {project: 'alpha', session: 'new'})
    await controller.refreshWork()
    assert.equal(controller.target?.workspace_id, beta.workspace_id)
    assert.equal(remembered.at(-1)?.workspace_id, beta.workspace_id)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('late per-work lookup cannot replace an explicit target chosen while it was awaiting validation', async () => {
  const selected = {workspace_id: 'a', session_id: 'selected', project: 'alpha', title: 'selected', executor: 'codex'} as const
  let finish!: (target: CodingTarget) => void
  const delayed = new Promise<CodingTarget>(resolve => { finish = resolve })
  const persisted: CodingTarget[] = []
  let lookup = false
  const controller = new CodingTargetController({
    list: () => Promise.resolve([selected]), validate: () => Promise.resolve(selected),
    resolve: () => Promise.reject(Error('unused')),
    forWork: () => lookup ? delayed : Promise.resolve(null),
  }, (target, current) => { if (!current()) return Promise.resolve(false); persisted.push(target); return Promise.resolve(true) })
  await controller.accepted(null, 'old-work', controller.revision)
  lookup = true
  const refresh = controller.refreshWork()
  await controller.setTarget(selected)
  finish({...selected, session_id: 'old-session'})
  await refresh
  assert.equal(controller.target?.session_id, 'selected')
  assert.equal(persisted.length, 0)
})


test('exact validation and defaults remain valid after sessions and projects leave the bounded picker', async () => {
  const value = await fixture({preexistingSession: true})
  try {
    await value.adapter.initialize()
    const first = await value.adapter.targetPort.validate((await value.adapter.targetPort.list()).find(item => item.session_id !== null)!)
    for (let index = 0; index < 21; index++) {
      const session = await value.store.beginSession(first.workspace_id, `Recent ${index}`)
      await value.store.markSessionReady(session.session_id, `thread-recent-${index}`)
    }
    const listed = await value.adapter.targetPort.list()
    const aged = (await value.store.snapshot()).sessions.find(session => !listed.some(item => item.session_id === session.session_id))!
    assert.ok(aged)
    const original = {...first, session_id: aged.session_id, title: aged.display_title}
    assert.equal((await value.adapter.targetPort.list()).some(item => item.session_id === original.session_id), false)
    assert.deepEqual(await value.adapter.targetPort.validate(original), original)
    for (let index = 0; index < 11; index++) await value.store.createManaged(`Recent project ${index}`)
    const listedProjects = await value.adapter.targetPort.list()
    const hiddenProject = (await value.store.snapshot()).workspaces.find(workspace => !listedProjects.some(item => item.workspace_id === workspace.workspace_id))!
    assert.ok(hiddenProject)
    assert.equal((await value.adapter.targetPort.list()).some(item => item.workspace_id === hiddenProject.workspace_id), false)
    const controller = new CodingTargetController(value.adapter.targetPort)
    await controller.setTarget(original)
    assert.equal((await controller.resolveTarget(work)).session_id, original.session_id)
    await controller.setTarget({workspace_id: hiddenProject.workspace_id, session_id: null})
    assert.equal((await controller.resolveTarget({...work, session: 'new'})).workspace_id, hiddenProject.workspace_id)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})


test('two bound workspaces stay independent of global focus and continuation requires an exact session', async () => {
  const value = await fixture({preexistingSession: true})
  try {
    await value.adapter.initialize()
    const a = new CodingTargetController(value.adapter.targetPort)
    const b = new CodingTargetController(value.adapter.targetPort)
    const original = await a.port.validate((await a.list()).find(target => target.session_id !== null)!)
    await a.setTarget(original)
    const beta = await value.store.createManaged('beta')
    await b.setTarget({workspace_id: beta.workspace_id, session_id: null})
    await value.store.createManaged('global-third')
    await value.store.selectWorkspace('global-third')
    assert.equal((await a.resolveTarget({...work, session: 'new'})).workspace_id, original.workspace_id)
    assert.equal((await b.resolveTarget({...work, session: 'new'})).workspace_id, beta.workspace_id)
    assert.equal((await a.resolveTarget(work)).session_id, original.session_id)
    for (const [controller, decision] of [[b, work], [a, {...work, project: 'beta'}]] as const) {
      await assert.rejects(controller.resolveTarget(decision), {code: 'unknown_session', detail: {reason: 'continuation_target_required'}})
    }
    await b.setTarget(null)
    await assert.rejects(b.resolveTarget({...work, session: 'new'}), {code: 'unknown_project'})
    await assert.rejects(b.resolveTarget({...work, project: 'alpha'}), {code: 'unknown_session'})
  } finally {await value.adapter.close(); await rm(value.root, {recursive: true, force: true})}
})


test('picker directory metadata comes from the registered workspace and never enters stored coding targets', async () => {
  const value = await fixture()
  try {
    await value.adapter.initialize()
    const choice = (await value.adapter.targetPort.list())[0]!
    assert.equal(choice.directory, (await value.store.resolveWorkspace('alpha')).canonical_path)
    const controller = new CodingTargetController(value.adapter.targetPort)
    await controller.setTarget(choice)
    assert.deepEqual(Object.keys(controller.target!).sort(), ['executor', 'project', 'session_id', 'title', 'workspace_id'])
  } finally {await value.adapter.close(); await rm(value.root, {recursive: true, force: true})}
})
