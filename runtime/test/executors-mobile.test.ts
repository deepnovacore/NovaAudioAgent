import assert from 'node:assert/strict'
import {randomUUID, createHash} from 'node:crypto'
import {mkdtemp, mkdir, readdir, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import test, {type TestContext} from 'node:test'
import {HostApprovalController} from '../src/core/approval.js'
import {RealClock} from '../src/core/clock.js'
import type {ExecutorDispatchContext} from '../src/core/causal-runtime.js'
import type {AgentRuntimeDispatchPort} from '../src/executors/agent-controller.js'
import {MobileExecutor, loadMobileConfig} from '../src/executors/mobile.js'
import type {runMobileIos} from '../src/executors/mobile-ios.js'

const env = {MOBILE_DEVICE_ID: 'test-device', MOBILE_DEVICE_TYPE: 'ios-simulator',
  MOBILE_BASE_URL: 'http://127.0.0.1:8000/v1', MOBILE_MODEL: 'test-model',
  MOBILE_MODEL_FAMILY: 'test-family', MOBILE_API_KEY: 'test-secret'}
const user = () => ({instruction: 'Open settings', originalUserText: 'Open settings', origin_ref: 'conversation:1',
  sessionEpoch: 1, acceptedUserInputRevision: 1, stillWanted: () => true})
async function setup(t: TestContext, runner: typeof runMobileIos) {
  const root = await mkdtemp(join(tmpdir(), 'nova-mobile-test-'))
  const config = {...loadMobileConfig(env), lockRoot: root}
  const clock = new RealClock()
  const approvals = new HostApprovalController({clock, idFactory: randomUUID})
  const executor = new MobileExecutor(config, approvals, runner)
  t.after(async () => { await executor.close(); await rm(root, {recursive: true, force: true}) })
  const abort = new AbortController()
  const context: ExecutorDispatchContext = {clock, signal: abort.signal, progress: () => undefined,
    delegate: {delegate_id: 'mobile-1', executor: 'mobile', op: 'run', request: {}, origin_ref: 'conversation:1',
      deadline: clock.now() + 5, dispatched_at: clock.now(), routing_class: 'user_awaited'}}
  return {config, approvals, executor, abort, context}
}
async function reserve(executor: MobileExecutor) {
  const captured: Parameters<AgentRuntimeDispatchPort['dispatch']>[0][] = []
  const controller = executor.controller({dispatch: request => {
    captured.push(request)
    return {accepted: true, delegate_id: 'mobile-1'}
  }})
  assert.equal((await controller.dispatch(user())).code, 'delegated')
  assert.equal(captured[0]!.channel, 'mobile')
  return {controller, request: captured[0]!.request}
}
async function pending(approvals: HostApprovalController) {
  for (let i = 0; i < 100 && !approvals.pending; i++) await delay(5)
  assert.equal(approvals.pending, true)
  return approvals.view.pending_approval_id!
}

test('mobile config keeps engine, model family and iOS host identity explicit', () => {
  const config = loadMobileConfig(env)
  assert.equal(config.modelFamily, 'test-family')
  assert.equal(config.wdaUrl, 'http://127.0.0.1:8100')
  assert.equal(config.settleMs, 4000)
  assert.equal(loadMobileConfig({...env, MOBILE_SETTLE_MS: '0'}).settleMs, 0)
  assert.equal(loadMobileConfig({...env, MOBILE_SETTLE_MS: '30000'}).settleMs, 30000)
  assert.match(config.lockRoot, /autoglm-devices$/u)
  for (const [key, value] of [['ENGINE', 'other'], ['DEVICE_TYPE', 'unknown'], ['DEVICE_ID', 'two devices'],
    ['BASE_URL', 'http://remote.example/v1'], ['BASE_URL', 'https://user:secret@remote.example/v1'],
    ['WDA_URL', 'https://remote.example'], ['MODEL_FAMILY', ''], ['MAX_STEPS', '0'],
    ['SETTLE_MS', '-1'], ['SETTLE_MS', '30001'], ['SETTLE_MS', '1.5'], ['SETTLE_MS', 'NaN']]) {
    assert.throws(() => loadMobileConfig({...env, [`MOBILE_${key}`]: value}))
  }
})

test('mobile streams visible planning and action phases with monotonic event activity', async t => {
  const progress: Parameters<ExecutorDispatchContext['progress']>[0][] = []
  const h = await setup(t, (_config, _instruction, hooks) => {
    hooks.progress({phase: 'planning', steps: 0})
    hooks.progress({phase: 'action_pending', steps: 0, actionName: 'Tap'})
    hooks.progress({phase: 'action_returned', steps: 1, actionName: 'Tap'})
    hooks.progress({phase: 'model_finished', steps: 1})
    return Promise.resolve({code: 'model_finished', steps: 1})
  })
  const {request} = await reserve(h.executor)
  await h.executor.dispatch('run', request, {...h.context, progress: value => progress.push(value)})
  assert.deepEqual(progress.map(value => value.internal_activity), [1, 2, 3, 4])
  assert.deepEqual(progress.map(value => value.summary), ['正在观察屏幕并规划下一步', '等待批准', '动作已返回，等待下一次观察', '模型已结束，结果尚未验证'])
  assert.ok(progress.every(value => value.phase === 'working'))
})

test('mobile suppresses progress after cancellation while retaining returned action facts', async t => {
  const progress: Parameters<ExecutorDispatchContext['progress']>[0][] = []
  const h = await setup(t, (_config, _instruction, hooks) => {
    hooks.progress({phase: 'planning', steps: 0})
    abort()
    hooks.progress({phase: 'action_returned', steps: 1, actionName: 'Tap'})
    hooks.progress({phase: 'model_finished', steps: 1})
    return Promise.resolve({code: 'model_finished', steps: 1})
  })
  const abort = () => h.abort.abort()
  const {request} = await reserve(h.executor)
  const result = await h.executor.dispatch('run', request, {...h.context, progress: value => progress.push(value)})
  assert.equal(progress.length, 1)
  assert.equal(result.outcome, 'cancelled')
  assert.equal(result.content.last_action, 'Tap')
  assert.equal(result.content.last_returned_step, 1)
  assert.equal(result.content.effects, 'unknown')
})

for (const decision of ['accept', 'decline', 'revoke'] as const) test(`mobile ${decision} binds a single shared host decision before action`, async t => {
  let writes = 0
  const h = await setup(t, async (_config, instruction, hooks) => {
    assert.equal(instruction, 'Open settings')
    if (!await hooks.approve('Tap', {x: 10, y: 20})) return {code: 'declined', steps: 0}
    writes++
    hooks.progress({phase: 'action_returned', steps: 1, actionName: 'Tap'})
    return {code: 'model_finished', steps: 1}
  })
  const {request} = await reserve(h.executor)
  const active = h.executor.dispatch('run', request, h.context)
  const approvalId = await pending(h.approvals)
  assert.equal(h.approvals.view.executorIdentity?.executor, 'mobile')
  assert.equal(h.approvals.view.work?.work_id, request.run_id)
  assert.equal(writes, 0)
  h.approvals.acceptDecision({approvalId, decision: decision === 'decline' ? 'decline' : 'accept'})
  if (decision === 'revoke') h.approvals.invalidate('changed')
  const result = await active
  assert.equal(writes, decision === 'accept' ? 1 : 0)
  assert.equal(result.outcome, decision === 'accept' ? 'ok' : 'refused')
  assert.equal(result.trust, 'untrusted_external')
  assert.equal(result.content.verified, false)
  assert.equal(result.content.effects, 'unknown')
  if (decision === 'accept') {
    assert.equal(result.content.last_action, 'Tap')
    assert.equal(result.content.last_returned_step, 1)
  }
  assert.equal(h.approvals.pending, false)
  assert.deepEqual(await readdir(h.config.lockRoot), [])
})

test('mobile holds legacy device lock until cancellation cleanup actually settles', async t => {
  let cleanup!: () => void
  const cleaning = new Promise<void>(resolve => { cleanup = resolve })
  t.after(cleanup)
  const h = await setup(t, async (_config, _instruction, hooks) => {
    await hooks.approve('Home', {})
    await cleaning
    return {code: 'model_finished', steps: 0}
  })
  const {request, controller} = await reserve(h.executor)
  const active = h.executor.dispatch('run', request, h.context)
  await pending(h.approvals)
  const other = h.approvals.forWork({work_id: 'codex-other', project: 'Other', title: 'Other work'})
  const otherDecision = other.offer({kind: 'permissions', local_detail: {kind: 'permissions', scope: 'Other'},
    operation_summary: 'Other permission'}, new AbortController().signal)
  let cancelled = false
  const cancel = controller.cancel(user()).then(() => { cancelled = true })
  await delay(10)
  const lock = join(h.config.lockRoot, createHash('sha256').update(`${h.config.deviceType}:${h.config.deviceId}`).digest('hex'))
  assert.equal((await stat(lock)).isDirectory(), true)
  assert.equal(cancelled, false)
  assert.equal((await controller.dispatch(user())).code, 'busy')
  cleanup()
  assert.equal((await active).outcome, 'cancelled')
  await cancel
  assert.equal(h.approvals.view.work?.work_id, 'codex-other')
  h.approvals.acceptDecision({approvalId: h.approvals.view.pending_approval_id!, decision: 'decline'})
  assert.equal(other.consume((await otherDecision)!), 'decline')
  assert.equal(h.approvals.pending, false)
  assert.deepEqual(await readdir(h.config.lockRoot), [])
})

test('mobile deadline aborts pending approval and cannot become late success', async t => {
  const h = await setup(t, async (_config, _instruction, hooks) => {
    assert.equal(await hooks.approve('Home', {}), false)
    return {code: 'model_finished', steps: 0}
  })
  const {request} = await reserve(h.executor)
  const context = {...h.context, delegate: {...h.context.delegate, deadline: h.context.clock.now() + 0.08}}
  const active = h.executor.dispatch('run', request, context)
  await pending(h.approvals)
  // Keep a foreground timer while AbortSignal.timeout's unref'ed timer runs.
  await delay(100)
  const result = await active
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.content.code, 'timeout')
  assert.equal(h.approvals.pending, false)
  assert.deepEqual(await readdir(h.config.lockRoot), [])
})

test('mobile respects legacy lock and sanitizes runner errors', async t => {
  let called = false
  const h = await setup(t, () => { called = true; return Promise.reject(new Error('SECRET https://private.example')) })
  const lock = join(h.config.lockRoot, createHash('sha256').update(`${h.config.deviceType}:${h.config.deviceId}`).digest('hex'))
  await mkdir(lock)
  const first = await reserve(h.executor)
  const busy = await h.executor.dispatch('run', first.request, h.context)
  assert.equal(busy.content.code, 'device_busy')
  assert.equal(called, false)
  await rm(lock, {recursive: true})
  const second = await reserve(h.executor)
  const failed = await h.executor.dispatch('run', second.request, h.context)
  assert.equal(failed.outcome, 'unknown')
  assert.equal(JSON.stringify(failed).includes('SECRET'), false)
  assert.deepEqual(await readdir(h.config.lockRoot), [])
})

for (const cancelRequested of [false, true]) test(`mobile quarantines uncertain device cleanup, cancel=${cancelRequested}`, async t => {
  let finish!: () => void
  const released = new Promise<void>(resolve => { finish = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  t.after(finish)
  const h = await setup(t, async () => {
    entered()
    await released
    return {code: 'cleanup_unknown', steps: 1}
  })
  const {request, controller} = await reserve(h.executor)
  const active = h.executor.dispatch('run', request, h.context)
  await started
  const cancellation = cancelRequested ? controller.cancel(user()) : undefined
  finish()
  const result = await active
  await cancellation
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.content.code, 'cleanup_unknown')
  assert.equal(result.content.cleanup_required, true)
  assert.equal(result.content.effects, 'unknown')
  assert.equal(result.content.verified, false)
  if (cancelRequested) assert.equal(result.content.cancel_requested, true)
  const lock = join(h.config.lockRoot, createHash('sha256').update(`${h.config.deviceType}:${h.config.deviceId}`).digest('hex'))
  assert.equal((await stat(lock)).isDirectory(), true)
  let ran = false
  const contender = new MobileExecutor(h.config, h.approvals, () => { ran = true; return Promise.resolve({code: 'model_finished', steps: 0}) })
  t.after(() => contender.close())
  const next = await reserve(contender)
  const blocked = await contender.dispatch('run', next.request, h.context)
  assert.equal(blocked.content.code, 'device_busy')
  assert.equal(ran, false)
})

test('mobile rejects forged requests and releases a superseded launch reservation', async t => {
  const h = await setup(t, () => Promise.resolve({code: 'model_finished', steps: 0}))
  assert.equal(h.executor.admitRequest('run', {instruction: 'Home', run_id: randomUUID()}).ok, false)
  let wanted = true
  const captured: Parameters<AgentRuntimeDispatchPort['dispatch']>[0][] = []
  const controller = h.executor.controller({dispatch: request => { captured.push(request); return {accepted: true, delegate_id: 'd'} }})
  await controller.dispatch({...user(), stillWanted: () => wanted})
  wanted = false
  assert.equal(captured[0]!.stillWanted(), false)
  assert.equal(h.executor.admitRequest('run', captured[0]!.request).ok, false)
  assert.equal((await controller.dispatch(user())).code, 'delegated')
  assert.equal(h.executor.admitRequest('run', {...captured[1]!.request, wdaUrl: 'injected'}).ok, false)
  await h.executor.close()
  assert.equal((await controller.dispatch(user())).code, 'runtime_rejected')
})

 test('mobile Android config selects an explicit ADB device without WDA', () => {
  const config = loadMobileConfig({...env, MOBILE_DEVICE_TYPE: 'android'});
  assert.equal(config.deviceType, 'android');
  assert.equal(config.deviceId, 'test-device');
 });
