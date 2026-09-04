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
    code: 'delegated', accepted: true, delegate_id: 'watch-1', detail: {channel: 'watch', op: 'start'},
  } satisfies AgentActionResult)
  assert.deepEqual(await facade.cancel(cancelRequest), {
    code: 'assessment_unavailable', accepted: false, detail: {},
  } satisfies AgentActionResult)
})
