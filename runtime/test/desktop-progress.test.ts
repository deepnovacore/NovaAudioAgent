import assert from 'node:assert/strict'
import {test} from 'node:test'
import {executorProgressSchema, executorResultSchema, projectExecutorEvent, safeProgressSummary} from '../src/desktop-progress.js'
import type {EventRecord} from '../src/events.js'
import type {Delegate} from '../src/ports.js'

const delegate: Delegate = {delegate_id: 'd', executor: 'codex', op: 'project', request: {},
  origin_ref: 'conversation:1', deadline: 60, routing_class: 'user_awaited', dispatched_at: 1}
const evidence = {inFlightDelegate: () => delegate, claimedHandoff: () => delegate,
  delegateFor: () => delegate, terminatedByDeadline: () => true,
  executors: new Map([['codex', {manifest: {display_name: 'Codex'}}]])}

test('progress projects only correlated accepted evidence and never private commands or paths', () => {
  const started: EventRecord = {seq: 1, ts: 1, kind: 'progress', payload: {
    channel: 'codex', delegate_id: 'd', op: 'project', phase: 'started', internal_activity: 0, elapsed: 0, summary: null,
  }}
  assert.equal(projectExecutorEvent(started, evidence)?.progress.level, 'milestone')
  assert.equal(projectExecutorEvent(started, evidence)?.result, null)
  assert.equal(projectExecutorEvent(started, {...evidence, inFlightDelegate: () => undefined}), null)
  assert.equal(projectExecutorEvent({...started, payload: {...started.payload, delegate_id: 'stale'}}, evidence), null)
  const working = {...started, payload: {...started.payload, phase: 'working' as const, internal_activity: 1, summary: '正在检查测试结果'}}
  assert.equal(projectExecutorEvent(working, evidence)?.progress.level, 'detail')
  for (const unsafe of [
    'curl https://secret.example/key', '/Users/private/key', 'TOKEN=secret', 'Bearer opaque',
    'sk-secret1234', 'C:\\private', 'npm install pkg', 'AWS_SECRET_ACCESS_KEY=real-secret',
    'Authorization: Basic YWJj', '--token secret',
  ]) {
    assert.equal(safeProgressSummary(unsafe, '处理中'), '处理中')
  }
  const terminal: EventRecord = {seq: 2, ts: 3, kind: 'handoff', payload: {
    channel: 'codex', delegate_id: 'd', origin_ref: 'conversation:1', outcome: 'ok', trust: 'untrusted_external', content: {}, refs: [],
  }}
  assert.deepEqual(projectExecutorEvent(terminal, evidence)?.result, {
    delegate_id: 'd', executor: 'codex', outcome: 'ok', summary: 'Codex 已完成任务。', started_at: 1, ended_at: 3, changed_files: null,
  })
  assert.equal(projectExecutorEvent(terminal, {...evidence, claimedHandoff: () => undefined}), null)
  assert.equal(projectExecutorEvent({...terminal, ts: 0}, evidence), null)
  const frame = projectExecutorEvent(started, evidence)!.progress
  assert.equal(executorProgressSchema.safeParse({...frame, summary: 'x'.repeat(181)}).success, false)
  assert.equal('extra' in executorProgressSchema.parse({...frame, extra: 'not a wire field'}), false)
  assert.equal(executorResultSchema.safeParse({
    type: 'executor.result',
    result: {delegate_id: 'd', executor: 'codex', outcome: 'ok', summary: 'done', started_at: -1, ended_at: 0, changed_files: null},
  }).success, false)
  assert.equal(executorResultSchema.safeParse({
    type: 'executor.result',
    result: {delegate_id: 'd', executor: 'codex', outcome: 'ok', summary: 'done', started_at: 2, ended_at: 1, changed_files: null},
  }).success, false)
})
