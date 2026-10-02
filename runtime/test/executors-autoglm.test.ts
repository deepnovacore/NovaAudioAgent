import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import nodeTest, {type TestContext} from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {HostApprovalController} from '../src/core/approval.js'
import {RealClock} from '../src/core/clock.js'
import type {ExecutorDispatchContext, ExecutorProgress} from '../src/core/causal-runtime.js'
import {AutoGlmExecutor, loadAutoGlmConfig} from '../src/executors/autoglm.js'
import type {AgentRuntimeDispatchPort} from '../src/executors/agent-controller.js'

const fixture = fileURLToPath(new URL('../../test/fixtures/autoglm-bridge-fixture.mjs', import.meta.url))
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest
const env = {
  AUTOGLM_PYTHON: process.execPath,
  AUTOGLM_SOURCE_PATH: tmpdir(),
  AUTOGLM_DEVICE_ID: 'fake-serial',
  AUTOGLM_BASE_URL: 'http://127.0.0.1:8000/v1',
  AUTOGLM_MODEL: 'fake-model',
  AUTOGLM_API_KEY: 'fake-secret',
}
const userRequest = (instruction: string) => ({instruction, originalUserText: instruction,
  origin_ref: 'conversation:1', sessionEpoch: 1, acceptedUserInputRevision: 1, stillWanted: () => true})

async function setup(t: TestContext, deviceType?: 'ios' | 'android') {
  const root = await mkdtemp(join(tmpdir(), 'nova-autoglm-'))
  const clock = new RealClock()
  const approvals = new HostApprovalController({clock, idFactory: randomUUID})
  const config = {...loadAutoGlmConfig({...env, ...(deviceType ? {AUTOGLM_DEVICE_TYPE: deviceType} : {})}),
    sourcePath: root, lockRoot: join(root, 'locks'), budgetMs: 5000, maxSteps: 3}
  const executor = new AutoGlmExecutor(config, approvals, fixture)
  t.after(async () => { await executor.close(); await rm(root, {recursive: true, force: true}) })
  const progress: ExecutorProgress[] = []
  const abort = new AbortController()
  const context: ExecutorDispatchContext = {clock, signal: abort.signal, progress: value => progress.push(value),
    delegate: {delegate_id: 'd-autoglm', executor: 'autoglm', op: 'run', request: {}, origin_ref: 'conversation:1',
      deadline: clock.now() + 10, dispatched_at: clock.now(), routing_class: 'user_awaited'}}
  const transcript = async (): Promise<Record<string, unknown>[]> => {
    const raw = await readFile(join(root, 'protocol.jsonl'), 'utf8').catch(() => '')
    return raw.trim() ? raw.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
  }
  return {executor, config, approvals, context, abort, progress, transcript}
}

async function reserve(executor: AutoGlmExecutor, instruction: string) {
  const admitted: Parameters<AgentRuntimeDispatchPort['dispatch']>[0][] = []
  const controller = executor.controller({dispatch: request => {
    admitted.push(request)
    return {accepted: true, delegate_id: 'd-autoglm'}
  }})
  assert.equal((await controller.dispatch(userRequest(instruction))).code, 'delegated')
  const dispatched = admitted[0]!
  assert.equal(dispatched.channel, 'autoglm')
  assert.equal(dispatched.op, 'run')
  assert.equal(dispatched.stillWanted(), true)
  assert.match(dispatched.request.run_id as string, /^[a-f0-9-]{36}$/u)
  assert.equal(executor.admitRequest('run', dispatched.request).ok, true)
  return {controller, request: dispatched.request}
}

async function pending(approvals: HostApprovalController) {
  const deadline = Date.now() + 3000
  while (!approvals.pending && Date.now() < deadline) await delay(10)
  assert.equal(approvals.pending, true, 'bridge should offer a host approval')
  return approvals.view.pending_approval_id!
}

test('AutoGLM configuration rejects unsafe endpoints, paths, serials and budgets', () => {
  assert.equal(loadAutoGlmConfig(env).deviceId, 'fake-serial')
  assert.equal(loadAutoGlmConfig(env).deviceType, 'ios')
  assert.equal(loadAutoGlmConfig(env).wdaUrl, 'http://127.0.0.1:8100')
  const simulator = {...env, AUTOGLM_DEVICE_TYPE: 'ios-simulator'}
  assert.equal(loadAutoGlmConfig(simulator).deviceType, 'ios-simulator')
  for (const wdaUrl of ['https://example.com', 'http://127.0.0.1:8100/proxy']) {
    assert.throws(() => loadAutoGlmConfig({...simulator, AUTOGLM_WDA_URL: wdaUrl}))
  }
  for (const [key, value] of [
    ['BASE_URL', 'http://example.com/v1'], ['BASE_URL', 'https://user:secret@example.com/v1'],
    ['BASE_URL', 'https://example.com/v1?token=secret'], ['BASE_URL', 'https://example.com/v1#fragment'],
    ['PYTHON', 'python3'], ['SOURCE_PATH', './upstream'], ['DEVICE_ID', 'two devices'],
    ['DEVICE_ID', 'x'.repeat(129)], ['DEVICE_ID', ''], ['MAX_STEPS', '0'], ['TIMEOUT_SECONDS', 'Infinity'],
    ['DEVICE_TYPE', 'automatic'], ['WDA_URL', 'http://example.com:8100'],
    ['WDA_URL', 'https://user:secret@example.com'], ['WDA_URL', 'http://127.0.0.1:8100?token=secret'],
  ]) assert.throws(() => loadAutoGlmConfig({...env, [`AUTOGLM_${key}`]: value}), Error, `${key}=${value}`)
})

test('AutoGLM preserves the configured Python virtual environment', {skip: !process.env.AUTOGLM_TEST_PYTHON}, async t => {
  const h = await setup(t)
  const script = join(h.config.sourcePath, 'python-environment.py')
  await writeFile(script, 'import json,sys\nr=json.loads(input())\nprint(json.dumps(dict(version=1, taskId=r["taskId"], type="ready", upstreamCommit="a"*40)),flush=True)\nprint(json.dumps(dict(version=1, taskId=r["taskId"], type="terminal", code="model_finished", steps=0, message=sys.prefix)),flush=True)\n')
  const python = process.env.AUTOGLM_TEST_PYTHON!
  const executor = new AutoGlmExecutor({...h.config, python}, h.approvals, script)
  t.after(() => executor.close())
  const {request} = await reserve(executor, 'environment')
  const result = await executor.dispatch('run', request, h.context)
  assert.equal(result.outcome, 'ok')
  assert.equal(result.content.message, dirname(dirname(python)))
})

test('AutoGLM explicit Android bridge start omits WDA configuration', async t => {
  const h = await setup(t, 'android')
  const {request} = await reserve(h.executor, 'eof')
  const result = await h.executor.dispatch('run', request, h.context)
  assert.equal((result.content as Record<string, unknown>).code, 'bridge_eof')
  const start = (await h.transcript())[0]!
  assert.equal(start.deviceType, 'android')
  assert.equal(Object.hasOwn(start, 'wdaUrl'), false)
})

test('AutoGLM requires host reservation, rejects busy dispatch, and releases rejected/closed admission', async t => {
  const h = await setup(t)
  assert.equal(h.executor.admitRequest('run', {instruction: 'accept', run_id: randomUUID()}).ok, false)
  const rejected = h.executor.controller({dispatch: () => ({accepted: false, delegate_id: null})})
  assert.equal((await rejected.dispatch(userRequest('accept'))).code, 'runtime_rejected')
  const {controller, request} = await reserve(h.executor, 'accept')
  assert.equal((await controller.dispatch(userRequest('accept'))).code, 'busy')
  assert.equal(h.executor.admitRequest('run', {...request, run_id: randomUUID()}).ok, false)
  assert.equal(h.executor.admitRequest('run', {...request, deviceId: 'injected'}).ok, false)
  assert.equal((await controller.cancel(userRequest('cancel'))).code, 'accepted')
  assert.equal(h.executor.admitRequest('run', request).ok, false)
  await h.executor.close()
  assert.equal((await controller.dispatch(userRequest('accept'))).code, 'runtime_rejected')
  assert.equal((await h.executor.dispatch('run', request, h.context)).outcome, 'refused')
})

for (const decision of ['accept', 'decline'] as const) test(`AutoGLM ${decision} flows through shared host approval before execution`, async t => {
  const h = await setup(t)
  const {request} = await reserve(h.executor, decision)
  const result = h.executor.dispatch('run', request, h.context)
  const approvalId = await pending(h.approvals)
  assert.equal(h.approvals.view.executorIdentity?.executor, 'autoglm')
  assert.equal(h.approvals.view.work?.work_id, request.run_id)
  assert.match(JSON.stringify(h.approvals.view.local_detail), /example.fake/u)
  assert.deepEqual(h.approvals.view.allowed_decisions, ['accept', 'decline'])
  assert.equal((await h.transcript()).length, 1, 'no decision or action before user approval')
  assert.equal(h.approvals.acceptDecision({approvalId: 'action-1', decision}), false, 'bridge IDs carry no host authority')
  assert.equal(h.approvals.acceptDecision({approvalId, decision}), true)
  const terminal = await result
  assert.equal(terminal.outcome, decision === 'accept' ? 'ok' : 'refused')
  assert.equal(terminal.trust, 'untrusted_external')
  assert.deepEqual(terminal.content, {code: decision === 'accept' ? 'model_finished' : 'declined', verified: false,
    effects: 'unknown', steps: 1, last_action: 'Tap', ...(decision === 'accept' ? {last_returned_step: 1} : {})})
  const transcript = await h.transcript()
  assert.equal(transcript[0]?.deviceType, 'ios')
  assert.equal(transcript[0]?.wdaUrl, 'http://127.0.0.1:8100')
  assert.equal(transcript[1]?.decision, decision)
  assert.equal(transcript.some(value => value.executed === true), decision === 'accept')
  assert.equal(h.progress[0]?.phase, 'working')
  assert.equal(h.approvals.pending, false)
  assert.deepEqual(await readdir(h.config.lockRoot), [])
})

test('AutoGLM cancellation during approval kills bridge and invalidates decision', async t => {
  const h = await setup(t)
  const {request, controller} = await reserve(h.executor, 'wait')
  const result = h.executor.dispatch('run', request, h.context)
  const approvalId = await pending(h.approvals)
  await controller.cancel(userRequest('cancel'))
  assert.equal((await result).outcome, 'cancelled')
  assert.equal(h.approvals.acceptDecision({approvalId, decision: 'accept'}), false)
  assert.equal((await h.transcript()).some(value => value.executed === true), false)
  assert.deepEqual(await readdir(h.config.lockRoot), [])
})

test('AutoGLM cancellation preserves the last returned action without claiming its effect', async t => {
  const h = await setup(t)
  const {request} = await reserve(h.executor, 'partial-wait')
  let actionReturned!: () => void
  const returned = new Promise<void>(resolve => { actionReturned = resolve })
  let progressCount = 0
  const context = {...h.context, progress: (value: ExecutorProgress) => {
    h.context.progress(value)
    // Fixture emits model, then action_returned only after its accepted fake action.
    if (++progressCount === 2) actionReturned()
  }}
  const active = h.executor.dispatch('run', request, context)
  const approvalId = await pending(h.approvals)
  assert.equal(h.approvals.acceptDecision({approvalId, decision: 'accept'}), true)
  await Promise.race([returned, delay(1000).then(() => { throw new Error('missing action_returned progress') })])
  h.abort.abort()
  const terminal = await active
  assert.equal(terminal.outcome, 'cancelled')
  assert.equal(terminal.trust, 'untrusted_external')
  const content = terminal.content as Record<string, unknown>
  assert.equal(content.last_action, 'Tap')
  assert.equal(content.last_returned_step, 1)
  assert.equal(content.effects, 'unknown')
  assert.equal(content.verified, false)
  assert.equal((await h.transcript()).some(value => value.executed === true), true)
  assert.deepEqual(await readdir(h.config.lockRoot), [])
})

test('AutoGLM invalidated accepted decision declines the original action', async t => {
  const h = await setup(t)
  const {request} = await reserve(h.executor, 'accept')
  const active = h.executor.dispatch('run', request, h.context)
  const approvalId = await pending(h.approvals)
  assert.equal(h.approvals.acceptDecision({approvalId, decision: 'accept'}), true)
  h.approvals.invalidate('user_context_changed')
  const result = await active
  assert.equal((result.content as Record<string, unknown>).code, 'declined')
  const transcript = await h.transcript()
  assert.equal(transcript[1]?.decision, 'decline')
  assert.equal(transcript.some(value => value.executed === true), false)
  assert.equal(h.approvals.pending, false)
  assert.deepEqual(await readdir(h.config.lockRoot), [])
})

test('AutoGLM rejected launch fence releases its reservation for a new dispatch', async t => {
  const h = await setup(t)
  let wanted = true
  const captured: Parameters<AgentRuntimeDispatchPort['dispatch']>[0][] = []
  const controller = h.executor.controller({dispatch: request => {
    captured.push(request)
    return {accepted: true, delegate_id: `delegate-${captured.length}`}
  }})
  assert.equal((await controller.dispatch({...userRequest('first'), stillWanted: () => wanted})).code, 'delegated')
  wanted = false
  assert.equal(captured[0]!.stillWanted(), false)
  assert.equal(h.executor.admitRequest('run', captured[0]!.request).ok, false)
  assert.equal((await controller.dispatch(userRequest('second'))).code, 'delegated')
  assert.equal(captured.length, 2)
  assert.equal(captured[1]!.stillWanted(), true)
  assert.equal(h.executor.admitRequest('run', captured[1]!.request).ok, true)
})

test('AutoGLM bridge exit while offering approval invalidates it without waiting for TTL', async t => {
  const h = await setup(t)
  const {request} = await reserve(h.executor, 'exit-approval')
  const observed: string[] = []
  const stop = h.approvals.observe(view => {
    if (view.pending_approval_id) observed.push(view.pending_approval_id)
  })
  t.after(stop)
  const started = performance.now()
  const result = await h.executor.dispatch('run', request, h.context)
  assert.ok(performance.now() - started < 1000, 'bridge death must not wait for approval TTL or task budget')
  assert.equal(result.outcome, 'unknown')
  assert.ok(observed.length > 0, 'approval was offered before the bridge exited')
  assert.equal(h.approvals.pending, false)
  assert.equal(h.approvals.acceptDecision({approvalId: observed[0]!, decision: 'accept'}), false)
  assert.equal((await h.transcript()).some(value => value.executed === true), false)
  assert.deepEqual(await readdir(h.config.lockRoot), [])
})

test('AutoGLM task cancellation preserves and promotes another executor in shared approval FIFO', async t => {
  const h = await setup(t)
  const {request} = await reserve(h.executor, 'wait')
  const active = h.executor.dispatch('run', request, h.context)
  await pending(h.approvals)
  const codex = h.approvals.forWork({work_id: 'codex-work', project: 'Example', title: 'Other task'})
  const decision = codex.offer({kind: 'permissions', local_detail: {kind: 'permissions', scope: 'test'},
    operation_summary: 'Other task permission', executorIdentity: {executor: 'codex', display_name: 'Codex'}}, new AbortController().signal)
  assert.equal(h.approvals.view.queued, 1)
  h.abort.abort()
  assert.equal((await active).outcome, 'cancelled')
  assert.equal(h.approvals.view.work?.work_id, 'codex-work')
  assert.equal(h.approvals.acceptDecision({approvalId: h.approvals.view.pending_approval_id!, decision: 'accept'}), true)
  const resolution = await decision
  assert.ok(resolution)
  assert.equal(codex.consume(resolution), 'accept')
  assert.equal(h.approvals.pending, false)
})

test('AutoGLM deadline includes time waiting for host approval', async t => {
  const h = await setup(t)
  const {request} = await reserve(h.executor, 'wait')
  const context = {...h.context, delegate: {...h.context.delegate, deadline: h.context.clock.now() + 1.5}}
  const active = h.executor.dispatch('run', request, context)
  await pending(h.approvals)
  const terminal = await active
  assert.equal(terminal.outcome, 'unknown')
  assert.equal((terminal.content as Record<string, unknown>).code, 'timeout')
  assert.equal(h.approvals.pending, false)
  assert.equal((await h.transcript()).some(value => value.executed === true), false)
  assert.deepEqual(await readdir(h.config.lockRoot), [])
})

for (const mode of ['malformed', 'oversized', 'wrong-task', 'unready-terminal', 'eof']) test(`AutoGLM fails closed on ${mode}`, async t => {
  const h = await setup(t)
  const {request} = await reserve(h.executor, mode)
  const result = await h.executor.dispatch('run', request, h.context)
  assert.equal(result.outcome, 'unknown')
  assert.equal((result.content as Record<string, unknown>).code, mode === 'eof' ? 'bridge_eof' : 'bridge_protocol_failed')
  assert.equal(h.approvals.pending, false)
  assert.equal((await h.transcript()).some(value => value.executed === true), false)
  assert.deepEqual(await readdir(h.config.lockRoot), [])
})

test('AutoGLM device lock excludes a second executor and is reusable after cancellation', async t => {
  const h = await setup(t)
  const second = new AutoGlmExecutor(h.config, h.approvals, fixture)
  t.after(() => second.close())
  const first = await reserve(h.executor, 'wait')
  const active = h.executor.dispatch('run', first.request, h.context)
  await pending(h.approvals)
  const other = await reserve(second, 'accept')
  const blocked = await second.dispatch('run', other.request, h.context)
  assert.equal(blocked.outcome, 'refused')
  assert.equal((blocked.content as Record<string, unknown>).code, 'device_busy')
  assert.equal(h.approvals.pending, true, 'contending executor must not clear owner approval')
  h.abort.abort()
  assert.equal((await active).outcome, 'cancelled')
  assert.deepEqual(await readdir(h.config.lockRoot), [])
  const retry = await reserve(second, 'eof')
  const freshContext = {...h.context, signal: new AbortController().signal}
  assert.equal((await second.dispatch('run', retry.request, freshContext)).outcome, 'unknown')
  assert.deepEqual(await readdir(h.config.lockRoot), [])
})
