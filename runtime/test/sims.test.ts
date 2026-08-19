import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VirtualClock } from '../src/clock.js'
import type { ExecutorDispatchContext } from '../src/causal-runtime.js'
import type { JsonValue } from '../src/events.js'
import { delegateSchema } from '../src/ports.js'
import {
  FastSim,
  GET_STATE,
  SET_LIGHT,
  SlowSim,
  buildSimulator,
  checkParams,
  fastSimManifest,
  slowSimManifest,
} from '../src/sims.js'

function contextFor(clock: VirtualClock): ExecutorDispatchContext {
  return {
    clock,
    delegate: delegateSchema.parse({
      delegate_id: 'd-1', executor: 'slow_sim', op: 'set_light', request: {},
      origin_ref: 'conversation:1', deadline: 10, routing_class: 'user_awaited',
      dispatched_at: 0,
    }),
    signal: new AbortController().signal,
    progress: () => undefined,
    observe: () => undefined,
  }
}

test('required and top-level types are validated exactly as the oracle does', () => {
  const cases: {readonly request: Record<string, JsonValue>, readonly problems: string[]}[] = [
    {request: {}, problems: ['缺少必填参数 room', '缺少必填参数 brightness']},
    {request: {room: '客厅'}, problems: ['缺少必填参数 brightness']},
    {request: {room: '客厅', brightness: 30}, problems: []},
    // A boolean must not pass as an integer, which is where Python's bool-subclasses-int
    // guard matters and where a naive typeof check would let True through.
    {request: {room: '客厅', brightness: true}, problems: ['brightness 应为 integer']},
    {request: {room: 1, brightness: 30}, problems: ['room 应为 string']},
    {request: {room: '客厅', brightness: 30.5}, problems: ['brightness 应为 integer']},
    // Extra keys are not this layer's business.
    {request: {room: '客厅', brightness: 30, extra: 1}, problems: []},
  ]
  for (const {request, problems} of cases) {
    assert.deepEqual(checkParams(SET_LIGHT.params, request), problems, JSON.stringify(request))
  }
})

test('every simulator manifest offers a readonly recheck entry point', () => {
  for (const manifest of [fastSimManifest, slowSimManifest]) {
    assert.ok(manifest.ops.some(op => op.readonly), manifest.name)
    // And a non-readonly op, so the simulators share the real executor slot.
    assert.ok(manifest.ops.some(op => !op.readonly), manifest.name)
  }
  // Reading the light back settles an unknown set_light conclusively.
  assert.deepEqual([...GET_STATE.verifies], ['set_light'])
})

test('a hallucinated op is a failed observation, not an exception', async () => {
  const clock = new VirtualClock()
  const sim = new FastSim({latency: 0})
  const result = await sim.dispatch('no_such_op', {}, contextFor(clock))
  assert.deepEqual(result, {
    outcome: 'failed', trust: 'trusted_system',
    content: {error: 'unknown_op', op: 'no_such_op'},
  })
})

test('invalid params are failed, because it simply never happened', async () => {
  const clock = new VirtualClock()
  const sim = new FastSim({latency: 0})
  const result = await sim.dispatch('set_light', {room: '客厅'}, contextFor(clock))
  assert.equal(result.outcome, 'failed')
  assert.equal(result.content.error, 'invalid_params')
  assert.deepEqual(result.content.problems, ['缺少必填参数 brightness'])
})

test('a timeout is unknown, not failed, because the outcome is genuinely unknown', async () => {
  const clock = new VirtualClock()
  const sim = new SlowSim({latency: 1, inject: 'timeout'})
  const dispatched = sim.dispatch('set_light', {room: '客厅', brightness: 30}, contextFor(clock))
  clock.advanceTo(1)
  const result = await dispatched
  assert.equal(result.outcome, 'unknown', 'calling this failed is the mistake the split prevents')
  assert.equal(result.content.error, 'adapter_timeout')
})

test('a transport error is also unknown', async () => {
  const clock = new VirtualClock()
  const sim = new SlowSim({latency: 1, inject: 'transport'})
  const dispatched = sim.dispatch('get_state', {room: '客厅'}, contextFor(clock))
  clock.advanceTo(1)
  assert.equal((await dispatched).content.error, 'transport_error')
})

test('a hang never returns on its own, leaving only the core deadline to stop it', async () => {
  const clock = new VirtualClock()
  const sim = new SlowSim({latency: 1, inject: 'hang'})
  let settled = false
  void sim.dispatch('get_state', {room: '客厅'}, contextFor(clock)).then(() => { settled = true })
  // Advancing well past the latency must not release it.
  clock.advanceTo(1_000_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
})

test('a successful dispatch echoes the request beside the op', async () => {
  const clock = new VirtualClock()
  const sim = new SlowSim({latency: 2})
  const dispatched = sim.dispatch('set_light', {room: '卧室', brightness: 10}, contextFor(clock))
  clock.advanceTo(2)
  assert.deepEqual(await dispatched, {
    outcome: 'ok', trust: 'trusted_system',
    content: {op: 'set_light', room: '卧室', brightness: 10},
  })
})

test('only the two simulator names build a simulator', () => {
  assert.equal(buildSimulator('fast_sim')?.manifest.name, 'fast_sim')
  assert.equal(buildSimulator('slow_sim')?.manifest.name, 'slow_sim')
  assert.equal(buildSimulator('codex'), undefined)
})
