import assert from 'node:assert/strict'
import {test} from 'node:test'
import {DesktopTasks, taskActionSchema} from '../src/desktop-tasks.js'

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
  const path = await realpath('/tmp')
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
