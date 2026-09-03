import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executorResultDialogOptions,
  parseExecutorResult,
} from '../src/main/executor-result.mjs'

test('accepts a bounded terminal result and drops wire extras', () => {
  assert.deepEqual(parseExecutorResult({
    delegate_id: 'delegate-7', executor: 'codex', outcome: 'ok', summary: '任务完成',
    started_at: 10.25, ended_at: 13.5, changed_files: 2, forged: 'ignored',
  }), {
    delegateId: 'delegate-7', executor: 'codex', outcome: 'ok', summary: '任务完成',
    startedAt: 10.25, endedAt: 13.5, changedFiles: 2,
  })
})

test('accepts the renderer parser canonical camel-case result', () => {
  assert.deepEqual(parseExecutorResult({
    delegateId: 'delegate-7', executor: 'codex', outcome: 'ok', summary: '任务完成',
    startedAt: 10.25, endedAt: 13.5, changedFiles: 2,
  }), {
    delegateId: 'delegate-7', executor: 'codex', outcome: 'ok', summary: '任务完成',
    startedAt: 10.25, endedAt: 13.5, changedFiles: 2,
  })
})

test('rejects malformed results before a native dialog can render them', () => {
  assert.equal(parseExecutorResult({
    delegate_id: 'delegate-7', executor: 'codex', outcome: 'ok', summary: '/private/token',
    started_at: 4, ended_at: 3, changed_files: 0,
  }), null)
  assert.equal(parseExecutorResult({
    delegate_id: 'delegate-7', executor: 'codex', outcome: 'pending', summary: '任务完成',
    started_at: 1, ended_at: 2, changed_files: -1,
  }), null)
})

test('renders an honest native fallback with Memory Board as an explicit action', () => {
  const options = executorResultDialogOptions({
    delegateId: 'delegate-7', executor: 'codex', outcome: 'failed', summary: '依赖安装失败',
    startedAt: 10.25, endedAt: 13.5, changedFiles: null,
  })

  assert.equal(options.type, 'warning')
  assert.deepEqual(options.buttons, ['打开 Memory Board', '关闭'])
  assert.match(options.detail, /开始：t=10\.3s/u)
  assert.match(options.detail, /结束：t=13\.5s/u)
  assert.match(options.detail, /耗时：3\.3s/u)
  assert.match(options.detail, /变更文件：未知/u)
})
