import assert from 'node:assert/strict'
import {test} from 'node:test'

import type {AgentActionResult, AgentCancelRequest, AgentDispatchRequest} from '../src/agent-controller.js'
import {VisionAgentController} from '../src/executors/vision/controller.js'
import type {VisionAgentControllerCore, VisionControllerResult} from '../src/executors/vision/controller-core.js'

const dispatchRequest: AgentDispatchRequest = {
  instruction: '请监控门口', originalUserText: '请监控门口', origin_ref: 'item:1',
  sessionEpoch: 2, acceptedUserInputRevision: 3, stillWanted: () => true,
}
const cancelRequest: AgentCancelRequest = {
  instruction: '停止监控', originalUserText: '停止监控', origin_ref: 'item:2',
  sessionEpoch: 2, acceptedUserInputRevision: 4, stillWanted: () => true,
}

function fakeCore(result: VisionControllerResult): VisionAgentControllerCore {
  return {
    descriptor: {name: 'vision', summary: 'vision', ownedChannels: ['watch', 'guard']},
    dispatch: () => Promise.resolve(result),
    cancel: () => Promise.resolve(result),
  } as unknown as VisionAgentControllerCore
}

test('vision facade exposes the bounded public descriptor and maps both monitor channels', async () => {
  for (const channel of ['watch', 'guard'] as const) {
    const facade = new VisionAgentController({core: fakeCore({
      code: 'delegated', accepted: true, delegate_id: `${channel}-1`, detail: {channel, op: 'start'},
    })})
    assert.deepEqual(facade.descriptor, {
      name: 'vision', summary: 'Monitors the camera for a bounded visual condition.',
      ownedChannels: ['watch', 'guard'],
    })
    assert.deepEqual(await facade.dispatch(dispatchRequest), {
      code: 'delegated', accepted: true, delegate_id: `${channel}-1`, detail: {channel, op: 'start'},
    })
  }
})

test('vision facade maps unclear and busy to host facts without controller prose', async () => {
  for (const result of [
    {code: 'unclear', accepted: true, detail: {reason: 'assessment_unclear'}},
    {code: 'busy', accepted: true, detail: {}},
  ] as const) {
    const facade = new VisionAgentController({core: fakeCore(result)})
    const mapped = await facade.dispatch(dispatchRequest)
    assert.deepEqual(mapped, {
      code: result.code === 'unclear' ? 'clarification_required' : 'busy', accepted: true, detail: {},
    })
    assert.equal(Object.hasOwn(mapped, 'message'), false)
    assert.equal(Object.hasOwn(mapped.detail, 'question'), false)
  }
})

test('vision facade maps all stop paths to one bounded monitor stop fact', async () => {
  for (const code of ['cancelled', 'requested_stop'] as const) {
    const facade = new VisionAgentController({core: fakeCore({
      code, accepted: true, detail: {channel: 'guard', op: 'stop'},
    })})
    assert.deepEqual(await facade.cancel(cancelRequest), {
      code: 'monitor_stop_requested', accepted: true, detail: {channel: 'guard', op: 'stop'},
    })
  }
})

test('vision facade strips hostile detail and fails closed for invalid core facts', async () => {
  const hostile: VisionControllerResult = {
    code: 'delegated', accepted: true, delegate_id: 'watch-1',
    detail: {channel: 'watch', op: 'start'},
  }
  const facade = new VisionAgentController({core: {
    descriptor: {name: 'vision', summary: 'vision', ownedChannels: ['watch', 'guard']},
    dispatch: () => Promise.resolve({...hostile, detail: {...hostile.detail, message: 'smuggled prose'}} as never),
    cancel: () => Promise.resolve({code: 'requested_stop', accepted: true,
      detail: {channel: 'codex', op: 'stop'}} as never),
  } as unknown as VisionAgentControllerCore})
  assert.deepEqual(await facade.dispatch(dispatchRequest), {
    code: 'assessment_unavailable', accepted: false, detail: {},
  } satisfies AgentActionResult)
  assert.deepEqual(await facade.cancel(cancelRequest), {
    code: 'assessment_unavailable', accepted: false, detail: {},
  } satisfies AgentActionResult)
})

test('vision facade does not invoke result getters and rejects proxy traps', async () => {
  let getterCalls = 0
  const getterResult = Object.create(Object.prototype) as Record<string, unknown>
  Object.defineProperty(getterResult, 'code', {
    enumerable: true, get: () => { getterCalls += 1; return 'busy' },
  })
  Object.defineProperty(getterResult, 'accepted', {enumerable: true, value: true})
  Object.defineProperty(getterResult, 'detail', {enumerable: true, value: {}})
  const getterFacade = new VisionAgentController({core: fakeCore(getterResult as never)})
  assert.deepEqual(await getterFacade.dispatch(dispatchRequest), {
    code: 'assessment_unavailable', accepted: false, detail: {},
  })
  assert.equal(getterCalls, 0)

  let traps = 0
  const proxy = new Proxy({code: 'busy', accepted: true, detail: {}}, {
    get: (_target, key) => {
      if (key === 'then') return undefined
      traps += 1
      throw new Error('get trap')
    },
    getPrototypeOf: () => { traps += 1; throw new Error('prototype trap') },
    ownKeys: () => { traps += 1; throw new Error('keys trap') },
  })
  const proxyFacade = new VisionAgentController({core: fakeCore(proxy as never)})
  assert.deepEqual(await proxyFacade.dispatch(dispatchRequest), {
    code: 'assessment_unavailable', accepted: false, detail: {},
  })
  assert.equal(traps, 0)
})

test('vision facade requires exact own enumerable data keys for result and detail', async () => {
  const inherited = Object.create({code: 'busy'}) as Record<string, unknown>
  Object.assign(inherited, {accepted: true, detail: {}})
  const nonEnumerable = {code: 'busy', accepted: true, detail: {}} as Record<string, unknown>
  Object.defineProperty(nonEnumerable, 'code', {enumerable: false, value: 'busy'})
  const extra = {code: 'busy', accepted: true, detail: {}, extra: 'prose'}
  const inheritedDetail = Object.create({channel: 'watch'}) as Record<string, unknown>
  inheritedDetail.op = 'start'
  const inheritedDetailResult = {code: 'delegated', accepted: true, delegate_id: 'd-1', detail: inheritedDetail}
  for (const result of [inherited, nonEnumerable, extra, inheritedDetailResult]) {
    const facade = new VisionAgentController({core: fakeCore(result as never)})
    assert.deepEqual(await facade.dispatch(dispatchRequest), {
      code: 'assessment_unavailable', accepted: false, detail: {},
    })
  }
})

test('vision facade requires the exact accepted literal for every core result class', async () => {
  const cases = [
    {code: 'delegated', accepted: false, delegate_id: 'd-1', detail: {channel: 'watch', op: 'start'}},
    {code: 'cancelled', accepted: false, detail: {channel: 'watch', op: 'stop'}},
    {code: 'requested_stop', accepted: false, detail: {channel: 'watch', op: 'stop'}},
    {code: 'unclear', accepted: false, detail: {reason: 'assessment_unclear'}},
    {code: 'busy', accepted: false, detail: {}},
    {code: 'not_running', accepted: false, detail: {}},
    {code: 'assessment_unavailable', accepted: true, detail: {}},
    {code: 'superseded', accepted: true, detail: {}},
    {code: 'runtime_rejected', accepted: true, detail: {}},
  ] as const
  for (const result of cases) {
    const facade = new VisionAgentController({core: fakeCore(result as never)})
    const mapped = result.code === 'cancelled' || result.code === 'requested_stop'
      ? await facade.cancel(cancelRequest) : await facade.dispatch(dispatchRequest)
    assert.deepEqual(mapped, {code: 'assessment_unavailable', accepted: false, detail: {}})
  }
})
