import assert from 'node:assert/strict'
import test from 'node:test'
import type {CompleteRequest, ModelGateway} from '../src/model-gateway.js'
import {
  VISION_ASSESS_JSON_SCHEMA,
  VisionAgentControllerCore,
  type VisionControllerDispatchRequest,
  type VisionRuntimeOpPort,
} from '../src/executors/vision/controller-core.js'

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

class ScriptedGateway implements ModelGateway {
  readonly requests: CompleteRequest[] = []
  constructor(private readonly text: string | Error, private readonly onComplete?: () => void) {}
  stream(): AsyncIterable<never> { return {async *[Symbol.asyncIterator]() { /* no-op */ }} }
  complete(request: CompleteRequest): Promise<{readonly text: string}> {
    this.requests.push(request)
    this.onComplete?.()
    if (this.text instanceof Error) return Promise.reject(this.text)
    return Promise.resolve({text: this.text})
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
  const value = core(new ScriptedGateway(assessment()), calls)
  assert.equal((await value.dispatch(request())).code, 'delegated')
  assert.equal((await value.dispatch(request({originalUserText: 'second'}))).code, 'busy')
  value.permissionGranted(identity)
  value.terminal(identity)
  const restarted = core(new ScriptedGateway(assessment()))
  assert.equal((await restarted.dispatch(request({originalUserText: 'third'}))).code, 'delegated')

  const rejectedCalls: Record<string, unknown>[] = []
  const rejected = core(new ScriptedGateway(assessment()), rejectedCalls, false)
  assert.equal((await rejected.dispatch(request())).code, 'runtime_rejected')
  const retry = core(new ScriptedGateway(assessment()))
  assert.equal((await retry.dispatch(request({originalUserText: 'retry'}))).code, 'delegated')
})

test('cancel can fence an asynchronous permission-pending admission before it settles', async () => {
  const calls: Record<string, unknown>[] = []
  let resolveStart!: (value: {readonly accepted: boolean; readonly delegate_id: string | null}) => void
  const startAdmission = new Promise<{readonly accepted: boolean; readonly delegate_id: string | null}>(resolve => {
    resolveStart = resolve
  })
  const runtimePort: VisionRuntimeOpPort = {
    dispatch(input) {
      calls.push({...input, request: {...input.request}})
      return input.op === 'start'
        ? startAdmission
        : Promise.resolve({accepted: true, delegate_id: null})
    },
  }
  const value = new VisionAgentControllerCore({
    gateway: new ScriptedGateway(assessment()), watchModel: 'vision-model',
    requestIdFactory: () => identity.request_id, runtimePort, assessmentTimeoutMs: 50,
  })
  const starting = value.dispatch(request())
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(value.state, 'permission-pending')
  assert.equal((await value.cancel({stillWanted: () => true})).code, 'cancelled')
  value.permissionGranted(identity)
  resolveStart({accepted: true, delegate_id: 'late-start'})
  assert.equal((await starting).code, 'superseded')
  assert.equal(value.state, 'terminal')
  value.terminal(identity)
  assert.deepEqual(calls.map(call => [call.channel, call.op]), [['watch', 'start'], ['watch', 'stop']])
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
  assert.equal(value.permissionGranted(identity), undefined)
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
  const value = core(new ScriptedGateway(assessment()), calls)
  assert.equal((await value.dispatch(request())).code, 'delegated')
  value.terminal({...identity, revision: identity.revision + 1})
  assert.equal((await value.dispatch(request({originalUserText: 'still busy'}))).code, 'busy')
  value.hit(identity)
  const free = core(new ScriptedGateway(assessment()))
  assert.equal((await free.dispatch(request({originalUserText: 'free'}))).code, 'delegated')
})
