import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { test } from 'node:test'
import { CausalRuntime, type ExecutorAdapter, type ModelPort } from '../src/causal-runtime.js'
import { RealClock } from '../src/clock.js'
import type { EventRecord } from '../src/events.js'
import { MonotonicIdFactory } from '../src/ids.js'
import { executorManifestSchema } from '../src/ports.js'
import { slowSimManifest } from '../src/sim.js'

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

test('async model and executor completions re-enter through the causal event queue', async () => {
  const firstModel = deferred<unknown>()
  const secondModel = deferred<unknown>()
  const executorResult = deferred<unknown>()
  const modelCalls: Parameters<ModelPort['complete']>[0][] = []
  const fast: ModelPort = {
    complete: call => {
      modelCalls.push(call)
      return modelCalls.length === 1 ? firstModel.promise : secondModel.promise
    },
  }
  const adapter: ExecutorAdapter = {
    manifest: slowSimManifest,
    dispatch: () => executorResult.promise,
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
    ...slowSimManifest,
    name: 'compress_sim',
    policy: {
      ...slowSimManifest.policy,
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
