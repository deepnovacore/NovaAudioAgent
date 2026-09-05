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

test('cancelled results keep project and title through the dialog trust boundary', () => {
  const result = parseExecutorResult({delegateId: 'a', executor: 'codex', outcome: 'cancelled', summary: 'Stopped', startedAt: 1, endedAt: 2, changedFiles: 0, project: '<alpha>', title: '<img src=x>'})
  assert.ok(result)
  assert.match(executorResultDialogOptions(result).detail, /<alpha>.*<img src=x>/u)
  assert.equal(executorResultDialogOptions(result).message, '已停止')
})

test('project/result menu exposes independent runs and selects one retained outcome as plain native labels', async () => {
  const {executorResultMenuTemplate} = await import('../src/main/executor-result.mjs')
  const opened = []
  const result = {delegateId: 'a', executor: 'codex', outcome: 'ok', summary: '<b>done</b>', startedAt: 1, endedAt: 2, changedFiles: 3, project: '<alpha>', title: '<img src=x>'}
  const roster = [{name: '<alpha>', last_used_at: 1, running: [{work_id: 'live-a', title: 'A title'}]}, {name: 'beta', last_used_at: 2, running: [{work_id: 'live-b', title: 'B title'}]}]
  const menu = executorResultMenuTemplate({results: [result, {...result, delegateId: 'b', project: 'beta', title: 'B result'}], roster}, item => opened.push(item))
  assert.ok(menu)
  assert.ok(menu.some(item => item.label === '<alpha>'))
  assert.ok(menu.some(item => item.label?.includes('A title')))
  assert.ok(menu.some(item => item.label?.includes('B title')))
  const outcomes = menu.filter(item => typeof item.click === 'function')
  assert.equal(outcomes.length, 2)
  assert.match(outcomes[0].label, /<alpha>.*<img src=x>/u)
  outcomes[0].click()
  assert.deepEqual(opened, [result])
  assert.equal(executorResultMenuTemplate({results: Array(65).fill(result), roster}, () => {}), null)
  assert.equal(executorResultMenuTemplate({results: [result], roster: [{name: 'bad', last_used_at: 1, running: [{work_id: 'x', title: {html: 'unsafe'}}]}]}, () => {}), null)
})


test('project/title limits use the existing roster code-point bound', () => {
  const result = {delegateId: 'a', executor: 'codex', outcome: 'ok', summary: 'done', startedAt: 1, endedAt: 2, changedFiles: 0, project: '🌟'.repeat(120), title: '🌟'.repeat(120)}
  assert.ok(parseExecutorResult(result))
  assert.equal(parseExecutorResult({...result, title: '🌟'.repeat(121)}), null)
})
