import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { test } from 'node:test'
import {
  CausalRuntime,
  type ExecutorAdapter,
  type ExecutorDispatchContext,
  type ExecutorHandoff,
  type ModelPort,
} from '../src/core/causal-runtime.js'
import { RealClock, VirtualClock } from '../src/core/clock.js'
import type { EventRecord } from '../src/core/events.js'
import { MonotonicIdFactory } from '../src/core/ids.js'
import { delegateSchema, executorManifestSchema } from '../src/core/ports.js'
import { fixtureSlowSimManifest } from '../eval/sim.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>(complete => { resolve = complete })
  return {promise, resolve: value => resolve?.(value)}
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await yieldToLoop()
  }
  assert.fail('condition did not become true')
}



test('executor contexts permit direct dispatch without an observation sink', () => {
  // Watch returns `observation_unavailable` in this deliberate direct-use case; the serving runtime
  // still supplies observe when it owns dispatch (covered below by its injection boundary).
  const context: ExecutorDispatchContext = {
    clock: new VirtualClock(),
    delegate: delegateSchema.parse({
      delegate_id: 'direct-context', executor: 'slow_sim', op: 'set_light', request: {},
      origin_ref: 'conversation:1', deadline: 10, routing_class: 'user_awaited', dispatched_at: 0,
    }),
    signal: new AbortController().signal,
    progress: () => undefined,
  }
  assert.equal(context.observe, undefined)
})

test('async model and executor completions re-enter through the causal event queue', async () => {
  const firstModel = deferred<unknown>()
  const secondModel = deferred<unknown>()
  const executorResult = deferred<ExecutorHandoff>()
  let injectedObserve: ExecutorDispatchContext['observe'] = undefined
  const modelCalls: Parameters<ModelPort['complete']>[0][] = []
  const fast: ModelPort = {
    complete: call => {
      modelCalls.push(call)
      return modelCalls.length === 1 ? firstModel.promise : secondModel.promise
    },
  }
  const adapter: ExecutorAdapter = {
    manifest: fixtureSlowSimManifest,
    dispatch: (_op, _request, context) => {
      injectedObserve = context.observe
      return executorResult.promise
    },
  }
  const runtime = new CausalRuntime({
    clock: new RealClock(),
    ids: new MonotonicIdFactory(),
    models: {fast},
    executors: [adapter],
  })
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)

  try {
    runtime.post({kind: 'user_input', payload: {text: 'dim the light'}})
    await eventually(() => modelCalls.length === 1)
    assert.equal(runtime.core.appliedEvents.some(event => event.kind === 'model_done'), false)

    firstModel.resolve({
      speak: {act: 'none'},
      action: {
        act: 'delegate',
        delegate: {
          executor: 'slow_sim',
          op: 'set_light',
          request: {brightness: 30},
          origin_ref: 'conversation:1',
        },
      },
    })
    await eventually(() => runtime.core.executorEffects.length === 1)
    await eventually(() => injectedObserve !== undefined)
    assert.equal(typeof injectedObserve, 'function')
    assert.equal(runtime.core.activeDelegates().length, 1)

    executorResult.resolve({
      outcome: 'ok',
      trust: 'trusted_system',
      content: {brightness: 30},
      refs: [],
    })
    await eventually(() => modelCalls.length === 2)
    assert.equal(modelCalls[1]?.reason.kind, 'handoff')
    assert.equal(runtime.core.activeDelegates().length, 0)

    secondModel.resolve({speak: {act: 'none'}, action: {act: 'none'}})
    await eventually(() => !runtime.core.slots.inflight.fast)
  } finally {
    stop.abort()
    await serving
  }
})

test('a throwing executor adapter reports its error class and code, never its message', async () => {
  const failure = Object.assign(new Error('SECRET adapter prose'), {name: 'ProjectResolutionError', code: 'unknown_session'})
  const modelCalls: Parameters<ModelPort['complete']>[0][] = []
  const fast: ModelPort = {complete: call => {
    modelCalls.push(call)
    return Promise.resolve(modelCalls.length === 1
      ? {speak: {act: 'none'}, action: {act: 'delegate', delegate: {executor: 'slow_sim', op: 'set_light', request: {brightness: 30}, origin_ref: 'conversation:1'}}}
      : {speak: {act: 'none'}, action: {act: 'none'}})
  }}
  const adapter: ExecutorAdapter = {manifest: fixtureSlowSimManifest, dispatch: () => Promise.reject(failure)}
  const runtime = new CausalRuntime({clock: new RealClock(), ids: new MonotonicIdFactory(), models: {fast}, executors: [adapter]})
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)
  try {
    runtime.post({kind: 'user_input', payload: {text: 'dim the light'}})
    await eventually(() => (runtime.memory.channels.get('slow_sim')?.items.length ?? 0) > 0)
    const handoff = runtime.memory.channels.get('slow_sim')!.items[0]!
    assert.equal(handoff.outcome, 'unknown')
    assert.deepEqual(handoff.content, {error: 'adapter_raised', exception: 'ExecutorFailure', detail: 'dispatch_failed', cause: 'ProjectResolutionError', cause_code: 'unknown_session'})
    assert.equal(JSON.stringify(handoff).includes('SECRET'), false)
  } finally {
    stop.abort()
    await serving
  }
  const errors: Error[] = [new Error('session_busy'), new Error('Session is busy with SECRET')]
  const seen: unknown[] = []
  for (const error of errors) {
    const calls: unknown[] = []
    const model: ModelPort = {complete: () => Promise.resolve(calls.push(1) === 1
      ? {speak: {act: 'none'}, action: {act: 'delegate', delegate: {executor: 'slow_sim', op: 'set_light', request: {brightness: 30}, origin_ref: 'conversation:1'}}}
      : {speak: {act: 'none'}, action: {act: 'none'}})}
    const plain = new CausalRuntime({clock: new RealClock(), ids: new MonotonicIdFactory(), models: {fast: model},
      executors: [{manifest: fixtureSlowSimManifest, dispatch: () => Promise.reject(error)}]})
    const halt = new AbortController(), running = plain.serve(halt.signal)
    try {
      plain.post({kind: 'user_input', payload: {text: 'dim the light'}})
      await eventually(() => (plain.memory.channels.get('slow_sim')?.items.length ?? 0) > 0)
      seen.push(plain.memory.channels.get('slow_sim')!.items[0]!.content)
    } finally { halt.abort(); await running }
  }
  assert.deepEqual(seen, [
    {error: 'adapter_raised', exception: 'ExecutorFailure', detail: 'dispatch_failed', cause: 'Error', cause_code: 'session_busy'},
    {error: 'adapter_raised', exception: 'ExecutorFailure', detail: 'dispatch_failed', cause: 'Error'},
  ])
})

test('shutdown aborts and awaits an in-flight owned model call', async () => {
  let started = false
  let aborted = false
  const fast: ModelPort = {
    complete: async (_call, signal) => {
      started = true
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        }, {once: true})
      })
      return {speak: {act: 'none'}, action: {act: 'none'}}
    },
  }
  const runtime = new CausalRuntime({
    clock: new RealClock(),
    ids: new MonotonicIdFactory(),
    models: {fast},
  })
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)
  runtime.post({kind: 'user_input', payload: {text: 'wait'}})
  await eventually(() => started)

  stop.abort()
  await serving

  assert.equal(aborted, true)
  assert.equal(runtime.ownedTaskCount, 0)
})

test('shutdown remains bounded when an owned port ignores cancellation', async () => {
  const gate = deferred<unknown>()
  let started = false
  let aborted = false
  const runtime = new CausalRuntime({
    clock: new RealClock(),
    ids: new MonotonicIdFactory(),
    shutdownGrace: 0.005,
    models: {
      fast: {
        complete: (_call, signal) => {
          started = true
          signal.addEventListener('abort', () => { aborted = true }, {once: true})
          return gate.promise
        },
      },
    },
  })
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)
  runtime.post({kind: 'user_input', payload: {text: 'wait forever'}})
  await eventually(() => started)

  stop.abort()
  const stoppedWithinBound = await Promise.race([
    serving.then(() => true),
    delay(50).then(() => false),
  ])
  gate.resolve({speak: {act: 'none'}, action: {act: 'none'}})
  await serving

  assert.equal(stoppedWithinBound, true)
  assert.equal(aborted, true)
  assert.equal(runtime.core.appliedEvents.some(event => event.kind === 'model_done'), false)
})

test('realtime ingestion resolves its applied MemoryRef and observers see applied events', async () => {
  const runtime = new CausalRuntime({
    clock: new RealClock(),
    ids: new MonotonicIdFactory(),
  })
  const observed: EventRecord[] = []
  const unsubscribe = runtime.observe(event => observed.push(event))
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)

  try {
    assert.equal(await runtime.ingestUserInput({text: 'hello'}), 'conversation:1')
    assert.deepEqual(observed.map(event => event.kind), ['user_input'])

    unsubscribe()
    runtime.post({kind: 'user_input', payload: {text: 'after unsubscribe'}})
    await eventually(() => runtime.core.appliedEvents.length === 2)
    assert.deepEqual(observed.map(event => event.kind), ['user_input'])
  } finally {
    stop.abort()
    await serving
  }
})

test('compressor calls receive the frozen channel snapshot they summarize', async () => {
  const manifest = executorManifestSchema.parse({
    ...fixtureSlowSimManifest,
    name: 'compress_sim',
    display_name: 'Compress Sim',
    policy: {
      ...fixtureSlowSimManifest.policy,
      channel: 'compress_sim',
      wake: 'none',
      compress_watermark: 1,
    },
    ops: [{
      name: 'run',
      description: 'produce one compressible result',
      params: {},
      deadline_budget: 5,
    }],
  })
  let fastCalls = 0
  const fast: ModelPort = {
    complete: () => {
      fastCalls += 1
      return Promise.resolve(fastCalls === 1
        ? {
            speak: {act: 'none'},
            action: {
              act: 'delegate',
              delegate: {
                executor: 'compress_sim',
                op: 'run',
                request: {},
                origin_ref: 'conversation:1',
              },
            },
          }
        : {speak: {act: 'none'}, action: {act: 'none'}})
    },
  }
  let compressorCall: Parameters<ModelPort['complete']>[0] | undefined
  const compress: ModelPort = {
    complete: call => {
      compressorCall = call
      return Promise.resolve({channel: 'compress_sim', summary: 'finished'})
    },
  }
  const runtime = new CausalRuntime({
    clock: new RealClock(),
    ids: new MonotonicIdFactory(),
    models: {fast, compress},
    executors: [{
      manifest,
      dispatch: () => Promise.resolve({
        outcome: 'ok',
        trust: 'trusted_system',
        content: {done: true},
        refs: [],
      }),
    }],
  })
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)

  try {
    runtime.post({kind: 'user_input', payload: {text: 'run it'}})
    await eventually(() => compressorCall !== undefined)
    assert.equal(compressorCall?.channel, 'compress_sim')
    assert.deepEqual(compressorCall?.compression_items?.map(item => item.content), [{done: true}])
    await eventually(() => runtime.core.memory.channels.get('compress_sim')?.summary === 'finished')
  } finally {
    stop.abort()
    await serving
  }
})

test('ports and observers cannot mutate runtime-owned causal records', async () => {
  let modelStarted = false
  const runtime = new CausalRuntime({
    clock: new RealClock(),
    ids: new MonotonicIdFactory(),
    models: {
      fast: {
        complete: call => {
          modelStarted = true
          const mutableReason = call.reason as {
            priority: number
            routing_class: 'ambient' | 'user_awaited'
          }
          mutableReason.priority = -999
          mutableReason.routing_class = 'ambient'
          return Promise.resolve({
            speak: {act: 'say', text: 'acknowledged'},
            action: {act: 'none'},
          })
        },
      },
    },
  })
  const queued = runtime.post({kind: 'user_input', payload: {text: 'original'}})
  if (queued.kind !== 'user_input') assert.fail('expected queued user input')
  queued.payload.text = 'mutated through post result'
  runtime.observe(event => {
    if (event.kind === 'user_input') event.payload.text = 'mutated through observer'
  })
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)

  try {
    await eventually(() => modelStarted && !runtime.core.slots.inflight.fast)
    const applied = runtime.core.appliedEvents[0]
    assert.equal(applied?.kind, 'user_input')
    if (applied?.kind !== 'user_input') assert.fail('expected applied user input')
    assert.equal(applied.payload.text, 'original')
    assert.equal(runtime.core.memory.channels.get('conversation')?.items[0]?.content.text, 'original')
    assert.equal(runtime.core.floorDecisions[0]?.priority, 100)
  } finally {
    stop.abort()
    await serving
  }
})

test('cancelling an admitted delegate before launch produces cancelled without invoking the executor', async () => {
  let starts = 0
  const runtime = new CausalRuntime({clock: new RealClock(), ids: new MonotonicIdFactory(),
    models: {fast: {complete: () => Promise.resolve({speak: {act: 'none'}, action: {act: 'none'}})}},
    executors: [{manifest: fixtureSlowSimManifest, dispatch: () => {starts++; return Promise.resolve({outcome: 'ok', trust: 'trusted_system', content: {}, refs: []})}}]})
  const origin = runtime.memory.append('conversation', {ts: 0, trust: 'trusted_user', priority: 100, content: {text: 'dim light'}})
  const admission = await runtime.dispatchExternal({executor: 'slow_sim', op: 'set_light', request: {brightness: 30}, origin_ref: `conversation:${origin.seq}`},
    {kind: 'realtime_tool', priority: 100, routing_class: 'ambient', origin: null, selected_suggestion: null}, undefined, () => true)
  assert.equal(admission.accepted, true)
  assert.equal(runtime.cancelPendingDispatch(admission.delegate_id!), true)
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)
  try {
    await eventually(() => runtime.memory.channels.get('slow_sim')?.items.some(item => item.outcome === 'cancelled') === true)
    assert.equal(starts, 0)
    assert.equal(runtime.cancelPendingDispatch(admission.delegate_id!), false)
  } finally { stop.abort(); await serving }
})
