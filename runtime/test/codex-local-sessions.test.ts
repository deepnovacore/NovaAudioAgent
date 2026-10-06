import {fixture, context, run} from './fixtures/codex/project-adapter-fixture.js'
import {hostHomeValue, hostWorkspacePath, hostWorkspaceForTest} from '../src/projects/host-paths.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, realpath, rm, mkdir, access, rename, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {ProjectCodexAdapter} from '../src/executors/codex/adapter-project.js'
import {sharedHomeOverrides} from '../src/executors/codex/shared-home.js'
import {prepareManagedCodexMcp} from '../src/executors/codex/managed-mcp.js'
import {readLocalCodexSessions, readLocalCodexProjects} from '../src/executors/codex/local-sessions.js'

test('local catalog reads named top-level sessions and excludes archived, agents and missing workspaces', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'nova-local-catalog-')))
  try {
    const db = new DatabaseSync(join(home, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER)')
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)')
    insert.run('original', '修复登录', 'long original request', home, 'vscode', 0, 100)
    insert.run('archived', '隐藏', 'x', home, 'vscode', 1, 200)
    insert.run('agent', '隐藏', 'x', home, '{"subagent":{}}', 0, 300)
    insert.run('missing', '隐藏', 'x', join(home, 'missing'), 'cli', 0, 400)
    db.close()
    assert.deepEqual(await readLocalCodexSessions(home), [{threadId: 'original', title: '修复登录', cwd: home, updatedAt: 100}])
  } finally { await rm(home, {recursive: true, force: true}) }
})


test('a discovered title resolves to and resumes the original thread/home, not the newest session', async () => {
  // Keep the configured spelling: Windows TEMP can contain an 8.3 user-directory alias.
  const configuredHome = await mkdtemp(join(tmpdir(), 'nova-shared-session-'))
  const home = await realpath(configuredHome)
  const value = await fixture({localCodexHome: configuredHome})
  try {
    const db = new DatabaseSync(join(home, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER)')
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)')
    insert.run('original-older-thread', '修复登录', 'original', home, 'vscode', 0, 100)
    insert.run('newest-thread', '修改首页', 'newest', home, 'vscode', 0, 200)
    db.close()
    await value.adapter.initialize()
    const row = value.adapter.roster().find(row => row.sessions?.includes('修复登录'))
    assert.ok(row)
    const target = await value.adapter.resolveIntakeTarget({kind: 'work', project: row.name, session: 'latest', session_title: '修复登录'})
    assert.equal((await value.store.resolveWorkspace(null)).display_name, 'alpha', 'discovery does not activate a workspace')
    const request = {work_order: '继续修复', project: row.name, session: 'latest', session_id: target.session_id!}
    assert.equal((await value.adapter.dispatch('run', request, context('run', request, value.clock))).outcome, 'ok')
    assert.equal(value.factory.bindings[0]?.resumeThreadId, 'original-older-thread')
    assert.equal(value.factory.bindings[0]?.preserveHome, true)
    assert.equal(hostHomeValue(value.factory.bindings[0].codexHome!).path, home)
    assert.equal((await value.store.listSessions(target.workspace_id!)).length, 2)
    const before = (await value.store.listSessions(target.workspace_id!)).find(row => row.session_id === target.session_id)!
    const updated = await value.store.importSession(target.workspace_id!, {home, threadId: 'original-older-thread', title: '登录校验修复', updatedAt: 300})
    assert.equal(updated.session_id, before.session_id)
    assert.equal(updated.codex_thread_id, before.codex_thread_id)
    assert.equal(updated.origin, 'external')
    const changedCatalog = new DatabaseSync(join(home, 'state_5.sqlite'))
    changedCatalog.prepare('DELETE FROM threads WHERE id = ?').run('original-older-thread')
    changedCatalog.close()
    assert.equal((await value.adapter.dispatch('run', request, context('run', request, value.clock))).outcome, 'failed')
    assert.equal(value.factory.bindings.length, 1, 'an external session must remain catalog-backed')
    await assert.rejects(value.adapter.resolveIntakeTarget({kind: 'work', project: row.name, session: 'latest', session_title: updated.display_title}))
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
    await rm(home, {recursive: true, force: true})
  }
})


test('shared config overrides disable inherited tools without replacing the home configuration', () => {
  const args = sharedHomeOverrides({config: {
    features: {js_repl: true}, mcp_servers: {external: {enabled: true}},
    shell_environment_policy: {set: {EXTERNAL_VALUE: 'private'}},
  }}, undefined)
  assert.ok(args.includes('features.js_repl=false'))
  assert.ok(args.includes('mcp_servers={ "external" = { "enabled" = false } }'))
  assert.ok(args.includes('shell_environment_policy.set.EXTERNAL_VALUE=""'))
  assert.equal(args.includes('mcp_servers={}'), false)
})

test('shared config disables quoted MCP names without admitting inherited tools or copying their secrets', () => {
  const args = sharedHomeOverrides({config: {mcp_servers: {
    'corp.tools': {enabled: false, command: 'private-command'},
    'quoted"name': {enabled: true},
  }}}, undefined)
  assert.deepEqual(args.filter(value => value.startsWith('mcp_servers=')), [
    'mcp_servers={ "corp.tools" = { "enabled" = false }, "quoted\\"name" = { "enabled" = false } }',
  ])
  assert.equal(args.some(value => value.includes('private-command')), false)
})

test('shared config keeps managed MCP entries in the final table while disabling external entries', () => {
  const managed = prepareManagedCodexMcp({
    modules: {coding: {enabled: true}},
    mcpServers: {},
    serverStatuses: [],
  } as never, {managed: {
    enabled: true, transport: 'stdio', command: '/usr/bin/false', args: ['managed'],
    tools: {read: {enabled: true, timeoutMs: 8000, maxResultBytes: 32768, maxCallsPerTurn: 2}}, exposeTo: {frontbrain: false, codex: true},
  }})
  const args = sharedHomeOverrides({config: {mcp_servers: {
    external: {enabled: true, command: 'private-command'}, managed: {enabled: true},
  }}}, managed)

  assert.deepEqual(args.filter(value => value.startsWith('mcp_servers=')), [
    'mcp_servers={ "external" = { "enabled" = false }, "managed" = { "enabled" = true, "enabled_tools" = ["read"], "disabled_tools" = [], "startup_timeout_sec" = 15, "tool_timeout_sec" = 8, "default_tools_approval_mode" = "auto", "command" = "/usr/bin/false", "args" = ["managed"] } }',
  ])
  assert.equal(args.some(value => value.includes('private-command')), false)
})


test('Nova shared sessions persist HOME and remain resumable without catalog or the current HOME selection', async () => {
  const configuredHome = await mkdtemp(join(tmpdir(), 'nova-owned-home-'))
  const home = await realpath(configuredHome)
  const otherHome = await realpath(await mkdtemp(join(tmpdir(), 'nova-selected-home-')))
  const value = await fixture({localCodexHome: configuredHome})
  let switched: ProjectCodexAdapter | undefined
  try {
    await value.adapter.initialize()
    assert.equal((await run(value, 'new shared task', {session: 'new', title: 'Shared'})).outcome, 'ok')
    const workspace = await value.store.resolveWorkspace('alpha')
    const session = await value.store.resolveSession(workspace.workspace_id, 'Shared')
    assert.equal(session.executor_home, home)
    assert.equal(session.origin, 'nova')
    assert.equal(hostWorkspacePath(value.factory.bindings[0]!.workspace), workspace.canonical_path)
    assert.equal(hostHomeValue(value.factory.bindings[0]!.codexHome!).path, home)
    assert.equal(value.factory.bindings[0]!.preserveHome, true)
    assert.equal(value.factory.transports[0]!.runInputs[0]!.threadName, 'Shared')
    assert.ok(value.adapter.roster().find(row => row.name === 'alpha')?.sessions?.includes('Shared'))
    const target = await value.adapter.resolveIntakeTarget({kind: 'work', project: 'alpha', session: 'latest', session_title: 'Shared'})
    assert.equal(target.session_id, session.session_id)
    switched = new ProjectCodexAdapter({store: value.store, confirmation: value.confirmation, transportFactory: value.factory, localCodexHome: otherHome})
    await switched.initialize()
    assert.equal((await run({...value, adapter: switched}, 'resume bound task')).outcome, 'ok')
    assert.equal(hostHomeValue(value.factory.bindings[1]!.codexHome!).path, home)
    assert.equal(value.factory.bindings[1]!.resumeThreadId, session.codex_thread_id)
    assert.equal(value.factory.transports[1]!.runInputs[0]!.threadName, undefined)
    await rm(home, {recursive: true})
    assert.equal((await run({...value, adapter: switched}, 'missing bound home')).outcome, 'failed')
    assert.equal(value.factory.bindings.length, 2)
    await assert.rejects(access(home), {code: 'ENOENT'})
  } finally {
    await switched?.close()
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
    await rm(home, {recursive: true, force: true})
    await rm(otherHome, {recursive: true, force: true})
  }
})

test('legacy sessions retain their private HOME, including the older directory layout, and missing resume HOME is never recreated', async () => {
  const selected = await realpath(await mkdtemp(join(tmpdir(), 'nova-selected-home-')))
  const value = await fixture({localCodexHome: selected, preexistingSession: true})
  try {
    const workspace = await value.store.resolveWorkspace('alpha')
    const stateFile = join(value.root, 'state', 'codex-projects-v1.json')
    const oldState = JSON.parse(await readFile(stateFile, 'utf8')) as {sessions: Record<string, {origin?: string}>}
    for (const session of Object.values(oldState.sessions)) delete session.origin
    await writeFile(stateFile, JSON.stringify(oldState))
    assert.equal((await value.store.resolveSession(workspace.workspace_id, null)).origin, undefined)
    const original = hostHomeValue(await value.store.persistentHome(workspace.workspace_id)).path
    const legacyRoot = join(value.root, 'state', 'codex-workspaces')
    await rename(join(value.root, 'state', 'codex-homes'), legacyRoot)
    const legacy = join(await realpath(legacyRoot), workspace.codex_home_key)
    assert.equal((await run(value, 'resume legacy')).outcome, 'ok')
    assert.equal(value.factory.bindings[0]!.preserveHome, true)
    assert.equal(hostHomeValue(value.factory.bindings[0]!.codexHome!).path, legacy)
    assert.equal(value.factory.bindings[0]!.resumeThreadId, 'thread-existing')
    await assert.rejects(access(original), {code: 'ENOENT'})
    await rm(legacy, {recursive: true})
    assert.equal((await run(value, 'missing legacy')).outcome, 'failed')
    assert.equal(value.factory.bindings.length, 1)
    await assert.rejects(access(legacy), {code: 'ENOENT'})
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
    await rm(selected, {recursive: true, force: true})
  }
})

test('catalog deduplication preserves Nova bindings in both import orderings and isolates identical thread IDs by HOME', async () => {
  const value = await fixture()
  try {
    const home = join(value.root, 'shared')
    const otherHome = join(value.root, 'other-shared')
    await mkdir(home); await mkdir(otherHome)
    const canonical = await realpath(home)
    const workspace = await value.store.resolveWorkspace('alpha')
    const first = await value.store.beginSessionForRun(workspace.workspace_id, 'Nova title', canonical)
    const ready = await value.store.markSessionReady(first.session.session_id, 'same-thread')
    const discovered = await value.store.importSession(workspace.workspace_id, {home, threadId: 'same-thread', title: 'Scanner title', updatedAt: 1000})
    assert.deepEqual(discovered, ready)
    const other = await value.store.importSession(workspace.workspace_id, {home: otherHome, threadId: 'same-thread', title: 'Other HOME', updatedAt: 1000})
    assert.equal(other.origin, 'external')
    assert.notEqual(other.session_id, ready.session_id)
    const starting = await value.store.beginSessionForRun(workspace.workspace_id, 'Racing Nova', canonical)
    const importedFirst = await value.store.importSession(workspace.workspace_id, {home, threadId: 'racing-thread', title: 'Scanner first', updatedAt: 1001})
    await value.store.activateSession(workspace.workspace_id, importedFirst.session_id)
    const completed = await value.store.markSessionReady(starting.session.session_id, 'racing-thread')
    const sessions = await value.store.listSessions(workspace.workspace_id)
    assert.equal(sessions.filter(item => item.executor_home === canonical && item.codex_thread_id === 'racing-thread').length, 1)
    assert.equal(sessions.some(item => item.session_id === importedFirst.session_id), false)
    assert.equal(completed.origin, 'nova')
    assert.equal((await value.store.resolveSession(workspace.workspace_id, null)).session_id, completed.session_id)
    assert.equal(sessions.some(item => item.session_id === other.session_id), true)
    const secondWorkspacePath = join(value.root, 'second-workspace')
    await mkdir(secondWorkspacePath)
    const secondWorkspace = await value.store.ensureImported('beta', hostWorkspaceForTest(await realpath(secondWorkspacePath)))
    await assert.rejects(value.store.importSession(secondWorkspace.workspace_id, {home, threadId: 'same-thread', title: 'Wrong cwd', updatedAt: 1002}), {code: 'session_state_conflict'})
    assert.deepEqual(await value.store.resolveSession(workspace.workspace_id, 'Nova title'), ready)
    const conflict = await value.store.beginSessionForRun(workspace.workspace_id, 'Conflicting scanner', canonical)
    const elsewhere = await value.store.importSession(secondWorkspace.workspace_id, {home, threadId: 'conflicting-thread', title: 'Elsewhere', updatedAt: 1003})
    await assert.rejects(value.store.markSessionReady(conflict.session.session_id, 'conflicting-thread'), {code: 'session_state_conflict'})
    assert.equal((await value.store.resolveSession(workspace.workspace_id, 'Conflicting scanner')).state, 'starting')
    assert.equal((await value.store.resolveSession(secondWorkspace.workspace_id, 'Elsewhere')).session_id, elsewhere.session_id)
    const stateFile = join(value.root, 'state', 'codex-projects-v1.json')
    const oldState = JSON.parse(await readFile(stateFile, 'utf8')) as {sessions: Record<string, {origin?: string}>}
    delete oldState.sessions[other.session_id]!.origin
    await writeFile(stateFile, JSON.stringify(oldState))
    assert.equal((await value.store.resolveSession(workspace.workspace_id, 'Other HOME')).origin, 'external')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('an indexed thread with a missing rollout is not imported or selected for latest', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'nova-missing-rollout-')))
  const value = await fixture({localCodexHome: home})
  try {
    await run(value, 'first task', {session: 'new', title: 'Old'})
    const workspace = await value.store.resolveWorkspace('alpha')
    const session = await value.store.resolveSession(workspace.workspace_id, 'Old')
    const db = new DatabaseSync(join(home, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER, rollout_path TEXT)')
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(session.codex_thread_id, 'Old', workspace.canonical_path, 'app-server', 0, 100, join(home, 'missing.jsonl'))
    db.close()
    assert.deepEqual(await readLocalCodexSessions(home), [])
    const target = await value.adapter.resolveIntakeTarget({kind: 'work', project: 'alpha', session: 'latest'})
    assert.equal(target.action, 'reuse')
    assert.equal(target.session_id, null)
    assert.equal((await value.store.resolveSession(workspace.workspace_id, 'Old')).state, 'unavailable')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
    await rm(home, {recursive: true, force: true})
  }
})

test('listing coding targets does not re-import a catalog the store already holds', async () => {
  const configuredHome = await mkdtemp(join(tmpdir(), 'nova-target-list-'))
  const home = await realpath(configuredHome)
  const calls: string[] = []
  const value = await fixture({localCodexHome: configuredHome, decorateStore: store => new Proxy(store, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target)
      if (typeof member !== 'function') return member
      return (...args: unknown[]) => { calls.push(String(property)); return (member as (...values: unknown[]) => unknown).apply(target, args) }
    },
  })})
  try {
    const db = new DatabaseSync(join(home, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER)')
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (let index = 0; index < 5; index++) insert.run(`thread-${index}`, `会话 ${index}`, 'x', home, 'vscode', 0, 100 + index)
    db.close()
    await value.adapter.initialize()
    const first = await value.adapter.targetPort.list()
    assert.equal(first.filter(item => item.session_id !== null).length, 5)
    calls.length = 0
    const again = await value.adapter.targetPort.list()
    assert.deepEqual(again.map(item => [item.workspace_id, item.session_id]), first.map(item => [item.workspace_id, item.session_id]))
    assert.deepEqual(calls.filter(name => name === 'ensureImported' || name === 'importSession'), [], 'an unchanged catalog costs no store transaction')

    const later = new DatabaseSync(join(home, 'state_5.sqlite'))
    later.prepare('UPDATE threads SET updated_at = 500 WHERE id = ?').run('thread-2')
    later.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run('thread-new', '新会话', 'x', home, 'vscode', 0, 400)
    later.close()
    calls.length = 0
    const changed = await value.adapter.targetPort.list()
    assert.ok(changed.some(item => item.title === '新会话'), 'a new codex session appears on the next open')
    assert.equal(changed.find(item => item.session_id !== null)?.title, '会话 2', 'a touched session moves to the front')
    assert.equal(calls.filter(name => name === 'importSession').length, 2, 'only the two changed sessions are imported')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
    await rm(home, {recursive: true, force: true})
  }
})

test('a session evicted by an earlier import in the same refresh is imported again, not skipped', async () => {
  const configuredHome = await mkdtemp(join(tmpdir(), 'nova-target-evict-'))
  const home = await realpath(configuredHome)
  const value = await fixture({localCodexHome: configuredHome})
  try {
    const db = new DatabaseSync(join(home, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER)')
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (let index = 0; index < 200; index++) insert.run(`thread-${index}`, `会话 ${index}`, 'x', home, 'vscode', 0, 100 + index)
    db.close()
    await value.adapter.initialize()
    await value.adapter.targetPort.list()

    // The workspace is full; an older session appears and the newest one leaves the catalog.
    const later = new DatabaseSync(join(home, 'state_5.sqlite'))
    later.prepare('DELETE FROM threads WHERE id = ?').run('thread-199')
    later.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run('thread-old', '旧会话', 'x', home, 'vscode', 0, 50)
    later.close()
    await value.adapter.targetPort.list()
    const titles = new Set((await value.store.snapshot()).sessions.map(session => session.display_title))
    const missing = Array.from({length: 199}, (_, index) => `会话 ${index}`).filter(title => !titles.has(title))
    assert.deepEqual(missing, [], 'current catalog sessions must survive an older import')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
    await rm(home, {recursive: true, force: true})
  }
})

test('renaming a duplicate-titled catalog session refreshes it even when its timestamp did not change', async () => {
  const configuredHome = await mkdtemp(join(tmpdir(), 'nova-target-rename-'))
  const home = await realpath(configuredHome)
  const value = await fixture({localCodexHome: configuredHome})
  try {
    const db = new DatabaseSync(join(home, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER)')
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)')
    insert.run('thread-a', 'Fix', 'x', home, 'vscode', 0, 100)
    insert.run('thread-b', 'Fix', 'x', home, 'vscode', 0, 101)
    db.close()
    await value.adapter.initialize()
    const first = await value.adapter.targetPort.list()
    assert.deepEqual(first.filter(item => item.session_id !== null).map(item => item.title).sort(), ['Fix', 'Fix (2)'])

    const later = new DatabaseSync(join(home, 'state_5.sqlite'))
    later.prepare('UPDATE threads SET name = ? WHERE id = ?').run('Fix authentication', 'thread-a')
    later.prepare('UPDATE threads SET name = ? WHERE id = ?').run('Fix rollout', 'thread-b')
    later.close()
    const renamed = await value.adapter.targetPort.list()
    assert.deepEqual(renamed.filter(item => item.session_id !== null).map(item => item.title).sort(), ['Fix authentication', 'Fix rollout'])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
    await rm(home, {recursive: true, force: true})
  }
})


test('picker follows saved local projects and groups worktree sessions without changing their execution directory',async()=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),'nova-project-picker-'))),value=await fixture({localCodexHome:home})
 try{
  const root=join(home,'project'),tree=join(home,'worktree'),scratch=join(home,'scratch'),empty=join(home,'empty')
  for(const path of [root,tree,scratch,empty])await mkdir(path)
  await writeFile(join(home,'.codex-global-state.json'),JSON.stringify({'local-projects':{p:{name:'Project',rootPaths:[root]},e:{name:'Empty',rootPaths:[empty]}},'thread-project-assignments':{branch:{projectKind:'local',projectId:'p'}}}))
  const db=new DatabaseSync(join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads (id TEXT,title TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at INTEGER)')
  const insert=db.prepare('INSERT INTO threads VALUES (?,?,?,\'cli\',0,?)')
  insert.run('main','Main',root,1);insert.run('branch','Branch',tree,2);insert.run('scratch','Scratch',scratch,3);db.close()
  // Existing imported worktrees must not reappear as top-level projects after upgrading.
  await value.store.ensureImported('Old worktree',hostWorkspaceForTest(tree))
  // Upgrade a full legacy catalog without deleting old sessions or directories.
  for(let i=0;i<98;i++){const path=join(home,`legacy-${i}`);await mkdir(path);await value.store.ensureImported(`Legacy ${i}`,hostWorkspaceForTest(path))}
  await value.adapter.initialize()
  const targets=await value.adapter.targetPort.list(),roots=targets.filter(t=>t.session_id===null)
  assert.deepEqual(roots.map(t=>t.directory).sort(),[root,empty].sort())
  assert.equal(targets.some(t=>t.title==='Scratch'),false)
  const branch=targets.find(t=>t.title==='Branch')!
  assert.ok(branch);assert.equal(branch.directory,tree)
  const main=roots.find(t=>t.directory===root)!
  assert.equal((branch as typeof branch & {group_workspace_id:string}).group_workspace_id,main.workspace_id)
  const target=await value.adapter.targetPort.validate(branch)
  const request={work_order:'Continue branch',project:target.project,session:'latest',session_id:target.session_id!}
  assert.equal((await value.adapter.dispatch('run',request,context('run',request,value.clock))).outcome,'ok')
  assert.equal(hostWorkspacePath(value.factory.bindings[0]!.workspace),tree)
  assert.equal(value.factory.bindings[0]!.resumeThreadId,'branch')
 }finally{await value.adapter.close();await rm(value.root,{recursive:true,force:true});await rm(home,{recursive:true,force:true})}
})


test('desktop project discovery distinguishes missing, corrupt, empty and legacy registries',async()=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),'nova-project-registry-'))),file=join(home,'.codex-global-state.json')
 try{
  assert.equal(await readLocalCodexProjects(home),null)
  await writeFile(file,'{broken');assert.deepEqual(await readLocalCodexProjects(home),[])
  await writeFile(file,JSON.stringify({'local-projects':{},'electron-saved-workspace-roots':[home]}));assert.deepEqual(await readLocalCodexProjects(home),[])
  await writeFile(file,JSON.stringify({'electron-saved-workspace-roots':[home,'relative',join(home,'missing')]}))
  assert.deepEqual((await readLocalCodexProjects(home))?.map(project=>project.path),[home])
 }finally{await rm(home,{recursive:true,force:true})}
})
