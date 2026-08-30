import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {test} from 'node:test'
import {pathToFileURL} from 'node:url'

interface Criterion {
  readonly expectation: 'clarify' | 'dispatch' | 'respond'
  readonly requiredWorkOrderTerms?: readonly string[]
}

interface Observation {
  readonly transcript: string
  readonly toolCalls: readonly {
    readonly name: string
    readonly arguments: Readonly<Record<string, unknown>>
  }[]
}

const scoreModule = await import(pathToFileURL(resolve(
  import.meta.dirname,
  '../../scripts/qwen-codex-clarification-score.mjs',
)).href) as {
  readonly scoreCodexClarificationTurn: (
    criterion: Criterion,
    observation: Observation,
  ) => readonly string[]
}
const {scoreCodexClarificationTurn} = scoreModule

const projectCall = (workOrder = '修复空密码登录并运行现有测试') => ({
  name: 'codex__project',
  arguments: {action: 'start_session', work_order: workOrder},
})

test('clarification requires one user-facing question and forbids project dispatch', () => {
  assert.deepEqual(scoreCodexClarificationTurn(
    {expectation: 'clarify'},
    {transcript: '你希望登录优化解决哪一个具体问题？', toolCalls: []},
  ), [])
  assert.deepEqual(scoreCodexClarificationTurn(
    {expectation: 'clarify'},
    {transcript: '我来处理', toolCalls: [projectCall()]},
  ), [
    'unexpected codex__project dispatch',
    'clarification response does not contain a question',
  ])
  assert.deepEqual(scoreCodexClarificationTurn(
    {expectation: 'clarify'},
    {transcript: '', toolCalls: []},
  ), ['clarification response is empty'])
})

test('dispatch requires exactly one project call with the merged work order terms', () => {
  assert.deepEqual(scoreCodexClarificationTurn(
    {expectation: 'dispatch', requiredWorkOrderTerms: ['空密码', '校验错误', '现有测试']},
    {transcript: '收到，我准备提交。', toolCalls: [projectCall('修复空密码登录，返回校验错误并运行现有测试')]},
  ), [])
  assert.deepEqual(scoreCodexClarificationTurn(
    {expectation: 'dispatch', requiredWorkOrderTerms: ['空密码', '校验错误']},
    {transcript: '收到。', toolCalls: [projectCall('修复空密码登录'), projectCall('再试一次')]},
  ), [
    'expected exactly one codex__project dispatch, got 2',
    'work_order is missing required term: 校验错误',
  ])
})

test('discussion requests require a response without project dispatch', () => {
  assert.deepEqual(scoreCodexClarificationTurn(
    {expectation: 'respond'},
    {transcript: '可以，我们先比较两种实现边界。', toolCalls: []},
  ), [])
  assert.deepEqual(scoreCodexClarificationTurn(
    {expectation: 'respond'},
    {transcript: '', toolCalls: [projectCall()]},
  ), [
    'unexpected codex__project dispatch',
    'response is empty',
  ])
})
