import assert from 'node:assert/strict'
import test from 'node:test'
import type {CompleteRequest, ModelGateway} from '../src/model-gateway.js'
import {
  VISION_ASSESS_JSON_SCHEMA,
  VisionAgentControllerCore,
  type VisionControllerDispatchRequest,
  type VisionRuntimeOpPort,
} from '../src/executors/vision/controller-core.js'
import {VisionLifecycleBridge} from '../src/executors/vision/lifecycle.js'

const identity = {request_id: 'vision-1', revision: 7, session_epoch: 3}

function assessment(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    request_id: identity.request_id,
    revision: identity.revision,
    kind: 'monitor',
    condition: 'a person enters the room',
    urgency: 'routine',
    urgency_evidence: null,
    interval_s: null,
    duration_s: null,
    question: null,
    ...overrides,
  })
}

function requestIdFromPrompt(prompt: string): string {
  const parsed = JSON.parse(prompt) as {readonly request_id: string}
  return parsed.request_id
}

class ScriptedGateway implements ModelGateway {
  readonly requests: CompleteRequest[] = []
  constructor(
    private readonly text: string | Error | ((request: CompleteRequest) => string),
    private readonly onComplete?: () => void,
  ) {}
  stream(): AsyncIterable<never> { return {async *[Symbol.asyncIterator]() { /* no-op */ }} }
  complete(request: CompleteRequest): Promise<{readonly text: string}> {
    this.requests.push(request)
    this.onComplete?.()
    if (this.text instanceof Error) return Promise.reject(this.text)
    return Promise.resolve({text: typeof this.text === 'function' ? this.text(request) : this.text})
  }
}

function port(calls: Record<string, unknown>[], accepted = true): VisionRuntimeOpPort {
  return {
    dispatch(request) {
      calls.push({...request, request: {...request.request}})
      return {accepted, delegate_id: accepted ? `${request.channel}-delegate` : null}
    },
  }
}

function request(overrides: Partial<VisionControllerDispatchRequest> = {}): VisionControllerDispatchRequest {
  return {
    instruction: '提醒我有人进入房间',
    originalUserText: '提醒我有人进入房间',
    origin_ref: 'user-item-1',
    sessionEpoch: identity.session_epoch,
    acceptedUserInputRevision: identity.revision,
    stillWanted: () => true,
    ...overrides,
  }
}

function core(
  gateway: ModelGateway,
  calls: Record<string, unknown>[] = [],
  accepted = true,
  requestIdFactory = () => identity.request_id,
): VisionAgentControllerCore {
  return new VisionAgentControllerCore({
    gateway,
    watchModel: 'vision-model',
    requestIdFactory,
    runtimePort: port(calls, accepted),
    assessmentTimeoutMs: 50,
  })
}

test('routine and urgent assessments map to hidden watch and guard starts with exact defaults', async () => {
  const calls: Record<string, unknown>[] = []
  const routine = core(new ScriptedGateway(assessment()), calls)
  assert.deepEqual(await routine.dispatch(request()), {
    code: 'delegated', accepted: true, delegate_id: 'watch-delegate',
    detail: {channel: 'watch', op: 'start'},
  })
  assert.deepEqual(calls[0]?.request, {
    condition: 'a person enters the room', interval_s: 2.5, duration_s: 1800,
  })

  const urgentCalls: Record<string, unknown>[] = []
  const urgent = core(new ScriptedGateway(assessment({request_id: 'vision-2',
    urgency: 'urgent', urgency_evidence: '提醒我',
  })), urgentCalls, true, () => 'vision-2')
  const result = await urgent.dispatch(request({
    instruction: '提醒我有人进入房间', originalUserText: '请紧急提醒我有人进入房间',
  }))
  assert.equal(result.code, 'delegated')
  assert.equal(urgentCalls[0]?.channel, 'guard')
  assert.deepEqual(urgentCalls[0]?.request, {
    condition: 'a person enters the room', interval_s: 2.5, duration_s: 1800,
  })
})

test('a Vision-owned hit keeps the reservation busy until its exact terminal', async () => {
  const calls: Record<string, unknown>[] = []
  const lifecycle = new VisionLifecycleBridge()
  let next = 0
  const value = new VisionAgentControllerCore({
    gateway: new ScriptedGateway(sent => assessment({request_id: requestIdFromPrompt(sent.prompt)})), watchModel: 'vision-model',
    requestIdFactory: () => `vision-${++next}`, runtimePort: port(calls), lifecycleSink: lifecycle,
  })
  lifecycle.attach(value)
  assert.equal((await value.dispatch(request())).code, 'delegated')
  assert.equal(lifecycle.hit('watch-delegate'), true)
  assert.equal((await value.dispatch(request())).code, 'busy')
  lifecycle.terminal('watch-delegate')
  assert.equal((await value.dispatch(request())).code, 'delegated')
})

test('assessment sends the fixed system prompt, exact schema, and bounded identity prompt', async () => {
  const gateway = new ScriptedGateway(assessment())
  const value = core(gateway)
  await value.dispatch(request({instruction: 'instruction', originalUserText: 'original'}))
  const sent = gateway.requests[0]
  assert.ok(sent)
  assert.equal(sent?.model, 'vision-model')
  assert.match(sent?.system ?? '', /vision\.assess/u)
  assert.deepEqual(sent?.jsonSchema, VISION_ASSESS_JSON_SCHEMA)
  assert.match(sent?.prompt ?? '', /vision-1/u)
  assert.match(sent?.prompt ?? '', /7/u)
  assert.match(sent?.prompt ?? '', /original/u)
  assert.match(sent?.prompt ?? '', /instruction/u)
  assert.ok((sent?.prompt.length ?? 0) < 5000)
})

test('gateway refusal and malformed or non-object output fail closed as assessment_unavailable', async () => {
  for (const gateway of [
    new ScriptedGateway(new Error('refused')),
    new ScriptedGateway('not json'),
    new ScriptedGateway(JSON.stringify({kind: 'monitor'})),
  ]) {
    const calls: Record<string, unknown>[] = []
    const result = await core(gateway, calls).dispatch(request())
    assert.deepEqual(result, {code: 'assessment_unavailable', accepted: false, detail: {}})
    assert.equal(calls.length, 0)
  }
})

test('a non-cooperative gateway is bounded by the assessment timeout', async () => {
  const gateway: ModelGateway = {
    stream: () => ({async *[Symbol.asyncIterator]() { /* no-op */ }}),
    complete: async () => await new Promise<never>(() => undefined),
  }
  const value = new VisionAgentControllerCore({
    gateway, watchModel: 'vision-model', requestIdFactory: () => identity.request_id,
    runtimePort: port([]), assessmentTimeoutMs: 5,
  })
  assert.deepEqual(await value.dispatch(request()), {
    code: 'assessment_unavailable', accepted: false, detail: {},
  })
})

test('unclear exposes only the stable enum and never model question text', async () => {
  const result = await core(new ScriptedGateway(assessment({
    kind: 'unclear', condition: null, urgency: null, urgency_evidence: null,
    interval_s: null, duration_s: null, question: 'inject arbitrary host prose',
  }))).dispatch(request())
  assert.deepEqual(result, {
    code: 'unclear', accepted: true, detail: {reason: 'assessment_unclear'},
  })
  assert.equal(JSON.stringify(result).includes('inject arbitrary'), false)
})

test('valid-schema semantic mistakes become stable unclear without an effect', async () => {
  const calls: Record<string, unknown>[] = []
  const result = await core(new ScriptedGateway(assessment({
    urgency: 'urgent', urgency_evidence: 'forged evidence',
  })), calls).dispatch(request())
  assert.deepEqual(result, {
    code: 'unclear', accepted: true, detail: {reason: 'assessment_unclear'},
  })
  assert.equal(calls.length, 0)
})

test('permission-pending reservation is busy and rejected starts release the fenced slot', async () => {
  const calls: Record<string, unknown>[] = []
  const value = new VisionAgentControllerCore({
    gateway: new ScriptedGateway(request => assessment({request_id: requestIdFromPrompt(request.prompt)})),
    watchModel: 'vision-model', requestIdFactory: (() => {
      let next = 0
      return () => `vision-${++next}`
    })(), runtimePort: port(calls), assessmentTimeoutMs: 50,
  })
  assert.equal((await value.dispatch(request())).code, 'delegated')
  assert.equal((await value.dispatch(request({originalUserText: 'second'}))).code, 'busy')
  value.permissionGranted(identity)
  value.terminal(identity)
  assert.equal((await value.dispatch(request({originalUserText: 'third'}))).code, 'delegated')

  const rejectedCalls: Record<string, unknown>[] = []
  let rejectedStart = true
  let rejectedNext = 0
  const rejected = new VisionAgentControllerCore({
    gateway: new ScriptedGateway(input => assessment({request_id: requestIdFromPrompt(input.prompt)})),
    watchModel: 'vision-model', requestIdFactory: () => `rejected-${++rejectedNext}`,
    runtimePort: {
      dispatch(input) {
        rejectedCalls.push({...input, request: {...input.request}})
        if (input.op === 'start' && rejectedStart) {
          rejectedStart = false
          return {accepted: false, delegate_id: null}
        }
        return {accepted: true, delegate_id: `${input.channel}-delegate`}
      },
    }, assessmentTimeoutMs: 50,
  })
  assert.equal((await rejected.dispatch(request())).code, 'runtime_rejected')
  assert.equal((await rejected.dispatch(request({originalUserText: 'retry'}))).code, 'delegated')
})

test('post-admission staleness issues an exact compensating stop and remains terminal', async () => {
  let wanted = true
  const calls: Record<string, unknown>[] = []
  const runtimePort: VisionRuntimeOpPort = {
    dispatch(input) {
      calls.push({...input, request: {...input.request}})
      if (input.op === 'start') wanted = false
      return {accepted: true, delegate_id: `${input.channel}-delegate`}
    },
  }
  const value = new VisionAgentControllerCore({
    gateway: new ScriptedGateway(assessment()), watchModel: 'vision-model',
    requestIdFactory: () => identity.request_id, runtimePort, assessmentTimeoutMs: 50,
  })
  assert.equal((await value.dispatch(request({stillWanted: () => wanted}))).code, 'superseded')
  assert.deepEqual(calls.map(call => [call.channel, call.op]), [['watch', 'start'], ['watch', 'stop']])
  assert.equal(value.state, 'terminal')
  value.terminal(identity)
  assert.equal(value.state, 'idle')
})

test('a stale permission grant is fenced and compensated without activating the reservation', async () => {
  let wanted = true
  let currentRevision = identity.revision
  let currentSessionEpoch = identity.session_epoch
  const calls: Record<string, unknown>[] = []
  const value = core(new ScriptedGateway(assessment()), calls)
  assert.equal((await value.dispatch(request({
    stillWanted: () => wanted,
    currentRevision: () => currentRevision,
    currentSessionEpoch: () => currentSessionEpoch,
  }))).code, 'delegated')
  currentRevision += 1
  currentSessionEpoch += 1
  wanted = false
  assert.equal(value.permissionGranted(identity), false)
  assert.deepEqual(calls.map(call => [call.channel, call.op]), [['watch', 'start'], ['watch', 'stop']])
  assert.equal(value.state, 'terminal')
  value.terminal(identity)
})

test('a rejected explicit stop keeps the original monitor terminal until exact terminal recovery', async () => {
  const calls: Record<string, unknown>[] = []
  let stopAttempts = 0
  const runtimePort: VisionRuntimeOpPort = {
    dispatch(input) {
      calls.push({...input, request: {...input.request}})
      if (input.op === 'stop') {
        stopAttempts += 1
        return stopAttempts > 1
          ? {accepted: true, delegate_id: `${input.channel}-stop-retry`}
          : {accepted: false, delegate_id: null}
      }
      return {accepted: true, delegate_id: `${input.channel}-delegate`}
    },
  }
  let next = 0
  const value = new VisionAgentControllerCore({
    gateway: new ScriptedGateway(input => assessment({request_id: requestIdFromPrompt(input.prompt)})),
    watchModel: 'vision-model', requestIdFactory: () => `vision-${++next}`,
    runtimePort, assessmentTimeoutMs: 50,
  })
  assert.equal((await value.dispatch(request())).code, 'delegated')
  assert.equal((await value.cancel({stillWanted: () => true})).code, 'runtime_rejected')
  assert.equal(value.state, 'terminal')
  assert.equal((await value.dispatch(request())).code, 'busy')
  assert.equal((await value.cancel({stillWanted: () => true})).code, 'requested_stop')
  assert.equal(stopAttempts, 2)
  value.terminal({request_id: 'vision-1', revision: 7, session_epoch: 3})
  assert.equal((await value.dispatch(request())).code, 'delegated')
})

test('runtime admission must be an exact bounded data result before delegation', async () => {
  const hostileResults: unknown[] = [
    {accepted: true, delegate_id: 'x'.repeat(129)},
    {accepted: 'yes', delegate_id: 'delegate'},
    {accepted: true, delegate_id: 'delegate', extra: true},
    Object.create({accepted: true, delegate_id: 'delegate'}),
    {accepted: true, get delegate_id() { throw new Error('accessor') }},
    {accepted: false, delegate_id: null, extra: true},
  ]
  for (const hostile of hostileResults) {
    const runtimePort: VisionRuntimeOpPort = {
      dispatch: () => hostile as {readonly accepted: boolean; readonly delegate_id: string | null},
    }
    const candidate = new VisionAgentControllerCore({
      gateway: new ScriptedGateway(assessment()), watchModel: 'vision-model',
      requestIdFactory: () => identity.request_id, runtimePort, assessmentTimeoutMs: 50,
    })
    assert.equal((await candidate.dispatch(request())).code, 'runtime_rejected')
  }
})

test('runtime admission waits for durable confirmation before reporting a delegated monitor', async () => {
  let release!: () => void
  let entered!: () => void
  const called = new Promise<void>(resolve => { entered = resolve })
  const ready = new Promise<void>(resolve => { release = resolve })
  const promisePort: VisionRuntimeOpPort = {
    dispatch: async () => { entered(); await ready; return {accepted: true, delegate_id: 'promise-result'} },
  }
  const value = new VisionAgentControllerCore({
    gateway: new ScriptedGateway(assessment()), watchModel: 'vision-model',
    requestIdFactory: () => identity.request_id, runtimePort: promisePort, assessmentTimeoutMs: 50,
  })
  let settled = false
  const admission = value.dispatch(request()).then(result => { settled = true; return result })
  await called
  assert.equal(settled, false)
  assert.equal(value.state, 'permission-pending')
  release()
  assert.equal((await admission).code, 'delegated')
})

test('a reentrant terminal during synchronous start admission is compensated exactly', async () => {
  const calls: Record<string, unknown>[] = []
  let value: VisionAgentControllerCore | null = null
  const runtimePort: VisionRuntimeOpPort = {
    dispatch(input) {
      calls.push({...input, request: {...input.request}})
      if (input.op === 'start') value?.terminal(identity)
      return {accepted: true, delegate_id: `${input.channel}-delegate`}
    },
  }
  value = new VisionAgentControllerCore({
    gateway: new ScriptedGateway(assessment()),
    watchModel: 'vision-model', requestIdFactory: () => identity.request_id,
    runtimePort, assessmentTimeoutMs: 50,
  })
  assert.equal((await value.dispatch(request())).code, 'superseded')
  assert.deepEqual(calls.map(call => [call.origin_ref, call.op]), [
    ['user-item-1', 'start'], ['user-item-1', 'stop'],
  ])
  assert.equal(value.state, 'idle')
})

test('stale identity before and after assessment, and immediately before runtime, emits no operation', async () => {
  let wanted = true
  const before = core(new ScriptedGateway(assessment()))
  assert.equal((await before.dispatch(request({stillWanted: () => false}))).code, 'superseded')

  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const gateway = new ScriptedGateway(assessment(), () => { void waiting })
  const after = core(gateway)
  const pending = after.dispatch(request({stillWanted: () => wanted}))
  wanted = false
  release()
  assert.equal((await pending).code, 'superseded')

  let checks = 0
  const calls: Record<string, unknown>[] = []
  const justBefore = core(new ScriptedGateway(assessment()), calls)
  assert.equal((await justBefore.dispatch(request({stillWanted: () => {
    checks += 1
    return checks < 3
  }}))).code, 'superseded')
  assert.equal(calls.length, 0)
})

test('dispatch stop and public cancel target the sole channel, fence late callbacks, and tolerate duplicates', async () => {
  const calls: Record<string, unknown>[] = []
  const value = core(new ScriptedGateway(assessment()), calls)
  assert.equal((await value.dispatch(request())).code, 'delegated')
  assert.deepEqual(await value.cancel({origin_ref: 'user-item-2', stillWanted: () => true}), {
    code: 'cancelled', accepted: true, detail: {channel: 'watch', op: 'stop'},
  })
  assert.deepEqual(calls[1]?.request, {})
  assert.equal(calls[1]?.origin_ref, 'user-item-2')
  value.permissionGranted(identity)
  assert.equal((await value.cancel({origin_ref: 'user-item-2', stillWanted: () => true})).code, 'requested_stop')
  value.terminal(identity)
  value.hit(identity)

  const viaDispatchCalls: Record<string, unknown>[] = []
  const viaDispatch = core(new ScriptedGateway(assessment({kind: 'stop', condition: null, urgency: null,
    urgency_evidence: null, interval_s: null, duration_s: null, question: null})), viaDispatchCalls)
  assert.equal((await viaDispatch.dispatch(request({instruction: 'stop'}))).code, 'not_running')
  assert.equal(viaDispatchCalls.length, 0)
})

test('successful terminal and hit callbacks clean up only for exact identity', async () => {
  const calls: Record<string, unknown>[] = []
  let next = 0
  const value = new VisionAgentControllerCore({
    gateway: new ScriptedGateway(input => assessment({request_id: requestIdFromPrompt(input.prompt)})),
    watchModel: 'vision-model', requestIdFactory: () => `vision-${++next}`,
    runtimePort: port(calls), assessmentTimeoutMs: 50,
  })
  assert.equal((await value.dispatch(request())).code, 'delegated')
  value.terminal({...identity, revision: identity.revision + 1})
  assert.equal((await value.dispatch(request({originalUserText: 'still busy'}))).code, 'busy')
  value.permissionGranted(identity)
  value.hit(identity)
  assert.equal((await value.dispatch(request({originalUserText: 'free'}))).code, 'delegated')
})

test('concurrent stops share pending admission and a thrown admission permits retry', async () => {
  let attempts = 0
  let release!: (value: {accepted: boolean; delegate_id: string | null}) => void
  const pending = new Promise<{accepted: boolean; delegate_id: string | null}>(resolve => { release = resolve })
  const value = new VisionAgentControllerCore({
    gateway: new ScriptedGateway(assessment()), watchModel: 'vision-model', requestIdFactory: () => identity.request_id,
    runtimePort: {dispatch(input) {
      if (input.op !== 'stop') return {accepted: true, delegate_id: 'watch-start'}
      attempts += 1
      if (attempts === 1) throw new Error('unavailable')
      return pending
    }},
  })
  assert.equal((await value.dispatch(request())).code, 'delegated')
  assert.equal((await value.cancel({stillWanted: () => true})).code, 'runtime_rejected')
  const first = value.cancel({stillWanted: () => true})
  const second = value.cancel({stillWanted: () => true})
  assert.equal(attempts, 2)
  release({accepted: true, delegate_id: 'watch-stop'})
  assert.equal((await first).accepted, true)
  assert.equal((await second).accepted, true)
  assert.equal((await value.cancel({stillWanted: () => true})).accepted, true)
  assert.equal(attempts, 2)
})
