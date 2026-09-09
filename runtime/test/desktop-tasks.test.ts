import {join, delimiter} from 'node:path'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {DesktopTasks, taskActionSchema, executorTasksSchema} from '../src/desktop-tasks.js'

test('tasks retain terminal facts, reject stale updates, and enrich exact roster metadata', () => {
  const tasks = new DesktopTasks('coding')
  const progress = {type: 'executor.progress' as const, executor: 'coding', delegate_id: 'a', phase: 'working' as const, summary: '最新发现', level: 'detail' as const, ts: 5}
  tasks.progress(progress)
  tasks.progress({...progress, ts: 4, summary: '旧消息'})
  tasks.project({workspace_display_name: 'P', roster: [{name: 'P', running: [{work_id: 'a', title: 'A'}]}, {name: 'Q', running: [{work_id: 'b', title: 'B'}]}]} as never)
  assert.equal(tasks.snapshot().tasks[0]?.summary, '最新发现')
  assert.equal(tasks.snapshot().tasks[0]?.title, 'A')
  tasks.progress({...progress, ts: 6, phase: 'completed'})
  tasks.progress({...progress, ts: 7})
  assert.equal(tasks.snapshot().tasks.find(x => x.work_id === 'a')?.phase, 'completed')
  tasks.progress({...progress, executor: 'monitor', delegate_id: 'm'})
  assert.equal(tasks.has('m', 'monitor'), false)
})
test('task controls reject renderer paths and invalid IDs', () => {
  const action = {type: 'executor.task_action', request_id: 'r', work_id: 'a', executor: 'coding', action: 'open'}
  assert.equal(taskActionSchema.safeParse(action).success, true)
  assert.equal(taskActionSchema.safeParse({...action, path: '/tmp'}).success, false)
  assert.equal(taskActionSchema.safeParse({...action, work_id: ' '}).success, false)
  assert.equal(taskActionSchema.safeParse({...action, work_id: '\u00a0'}).success, false)
  assert.equal(taskActionSchema.safeParse({...action, work_id: 'a\u0000b'}).success, false)
  assert.equal(taskActionSchema.safeParse({...action, work_id: '任务甲'}).success, true)
})

test('retention preserves running tasks and stays below socket byte limit', () => {
  const tasks = new DesktopTasks('coding')
  for (let i = 0; i < 30; i++) tasks.progress({type: 'executor.progress', executor: 'coding', delegate_id: String(i), phase: i === 0 ? 'working' : 'completed', summary: '测'.repeat(180), level: 'detail', ts: i})
  assert.ok(tasks.isRunning('0'))
  assert.ok(tasks.snapshot().tasks.length <= 16)
  assert.ok(Buffer.byteLength(JSON.stringify(tasks.snapshot())) <= 16 * 1024)
})

test('native opener accepts only canonical existing directories and passes no shell', async () => {
  const {openTaskDirectory} = await import('../src/desktop-task-opener.js')
  const {realpath} = await import('node:fs/promises')
  const path = await realpath(tmpdir())
  const launches: unknown[] = []
  await openTaskDirectory(path, (file, args) => { launches.push([file, args]); return Promise.resolve() }, 'darwin')
  assert.deepEqual(launches, [['/usr/bin/open', [path]]])
  await assert.rejects(openTaskDirectory('https://example.com', () => Promise.reject(new Error('must not launch'))))
  await assert.rejects(openTaskDirectory('/nonexistent-nova-task', () => Promise.reject(new Error('must not launch'))))
})

test('roster arriving before progress supplies metadata immediately', () => {
  const tasks = new DesktopTasks('coding')
  tasks.project({workspace_display_name: 'P', roster: [{name: 'P', running: [{work_id: 'a', title: '已知标题'}]}]} as never)
  tasks.progress({type: 'executor.progress', executor: 'coding', delegate_id: 'a', phase: 'working', summary: '公开进展', level: 'detail', ts: 1})
  assert.equal(tasks.snapshot().tasks[0]?.title, '已知标题')
  assert.equal(tasks.snapshot().tasks[0]?.project, 'P')
})

test('public labels strip controls without splitting astral characters', () => {
  const tasks = new DesktopTasks('coding')
  tasks.project({workspace_display_name: '项\u0000目', roster: [{name: '项\u0000目', running: [{work_id: 'a', title: '🌟'.repeat(121)}]}]} as never)
  tasks.progress({type: 'executor.progress', executor: 'coding', delegate_id: 'a', phase: 'working', summary: '继续工作', level: 'detail', ts: 1})
  assert.equal(tasks.snapshot().tasks[0]?.project, '项目')
  assert.equal(tasks.snapshot().tasks[0]?.title, '🌟'.repeat(120))
})

test('control-only project labels cannot invalidate outbound task snapshots', () => {
  const tasks = new DesktopTasks('coding')
  tasks.project({workspace_display_name: '\u0000', roster: []} as never)
  assert.equal(executorTasksSchema.safeParse(tasks.snapshot()).success, true)
  assert.equal(tasks.snapshot().active_project, null)
})


test('native opener drops an obsolete request after filesystem validation', async () => {
  const {openTaskDirectory} = await import('../src/desktop-task-opener.js')
  const {realpath} = await import('node:fs/promises')
  const path = await realpath(tmpdir())
  let wanted = true
  let launched = false
  const opening = openTaskDirectory(path, () => { launched = true; return Promise.resolve() }, 'darwin', () => wanted)
  wanted = false
  await opening
  assert.equal(launched, false)
})

test('empty roster names and titles retain valid task fallbacks', () => {
  const tasks = new DesktopTasks('coding')
  tasks.project({workspace_display_name: '', roster: [{name: '', running: [{work_id: 'a', title: '\u0000'}]}]} as never)
  tasks.progress({type: 'executor.progress', executor: 'coding', delegate_id: 'a', phase: 'working', summary: '继续工作', level: 'detail', ts: 1})
  const snapshot = executorTasksSchema.parse(tasks.snapshot())
  assert.equal(snapshot.active_project, null)
  assert.equal(snapshot.tasks[0]?.project, 'coding')
  assert.equal(snapshot.tasks[0]?.title, '任务')
})

test('a long-running native opener does not retain its caller process', {skip: process.platform === 'win32' ? 'POSIX executable fixture' : false}, async () => {
  const {spawnSync} = await import('node:child_process')
  const {mkdtemp, realpath, writeFile, readFile, rm} = await import('node:fs/promises')
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'nova-opener-')))
  const pidFile = join(directory, 'pid')
  let pid: number | undefined
  try {
    await writeFile(join(directory, 'xdg-open'), `#!${process.execPath}
require('node:fs').writeFileSync(process.env.NOVA_OPENER_TEST_PID, String(process.pid));
setInterval(() => {}, 1000);
`, {mode: 0o700})
    const module = new URL('../src/desktop-task-opener.js', import.meta.url).href
    const script = `import {openTaskDirectory} from ${JSON.stringify(module)}; await openTaskDirectory(${JSON.stringify(directory)}, undefined, 'linux');`
    const caller = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: {...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`, NOVA_OPENER_TEST_PID: pidFile},
      encoding: 'utf8', timeout: 3000,
    })
    // spawn success precedes the fixture's JS startup; always collect its PID for cleanup.
    for (let attempt = 0; attempt < 100 && pid === undefined; attempt++) {
      try {
        const value = Number(await readFile(pidFile, 'utf8'))
        if (!Number.isInteger(value) || value <= 0) throw new Error('fixture PID pending')
        pid = value
      }
      catch { await new Promise(resolve => setTimeout(resolve, 20)) }
    }
    assert.ok(pid !== undefined && Number.isInteger(pid) && pid > 0, 'native fixture started')
    process.kill(pid, 0)
    assert.equal(caller.status, 0, caller.error?.message ?? caller.stderr)
  } finally {
    if (pid !== undefined && Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGTERM') } catch { /* Fixture already exited. */ }
    }
    await rm(directory, {recursive: true, force: true})
  }
})
