import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MonotonicIdFactory, ScriptedIdFactory } from '../src/ids.js'
import { handoffPolicySchema } from '../src/memory.js'
import { executorManifestSchema, fastBrainOutputSchema, opSpecSchema } from '../src/ports.js'
import { CoreRuntime, type ModelCall } from '../src/runtime.js'
import { wakeReasonSchema, type Slot } from '../src/slots.js'
import { fixtureSlowSimManifest as fixtureSlowSim } from '../src/sim.js'

const manifest = executorManifestSchema.parse({
  name: 'slow_sim',
  policy: handoffPolicySchema.parse({
    channel: 'slow_sim',
    priority: 50,
    wake: 'fast',
    typical_latency: 5,
    compress_watermark: 8,
  }),
  ops: [{
    name: 'set_light',
    description: 'set light brightness',
    params: {},
    deadline_budget: 5,
    sensitive_params: [],
  }],
})

test('sensitive parameters must name declared request properties', () => {
  assert.throws(() => opSpecSchema.parse({
    name: 'write',
    description: 'invalid private request',
    params: {type: 'object', properties: {}},
    sensitive_params: ['secret'],
  }), /sensitive_params must name declared properties/u)
  assert.doesNotThrow(() => opSpecSchema.parse({
    name: 'write',
    description: 'valid private request',
    params: {type: 'object', properties: {secret: {type: 'string'}}},
    sensitive_params: ['secret'],
  }))
})

function dispatchedRuntime(): CoreRuntime {
  const runtime = new CoreRuntime({
    manifests: [manifest],
    ids: new ScriptedIdFactory({delegate: ['d-1']}),
  })
  const user = runtime.post({kind: 'user_input', payload: {text: 'dim it'}}, 0)
  const reason = runtime.apply(runtime.queue.popReady(0)!)
  assert.notEqual(reason, null)
  runtime.consumeFastBrain(fastBrainOutputSchema.parse({
    speak: {act: 'none'},
    action: {
      act: 'delegate',
      delegate: {
        executor: 'slow_sim',
        op: 'set_light',
        request: {room: 'living room', brightness: 30},
        origin_ref: 'conversation:1',
      },
    },
  }), reason!, user.seq)
  return runtime
}

test('host binding owns delegate identity, deadline, and routing class', () => {
  const runtime = dispatchedRuntime()
  assert.deepEqual(runtime.activeDelegates(), [{
    executor: 'slow_sim',
    op: 'set_light',
    request: {room: 'living room', brightness: 30},
    origin_ref: 'conversation:1',
    delegate_id: 'd-1',
    deadline: 5,
    routing_class: 'user_awaited',
    dispatched_at: 0,
  }])
  assert.equal(runtime.queue.nextTimestamp(), 5)
})

test('mismatched progress and observations cannot mutate memory', () => {
  const runtime = dispatchedRuntime()
  runtime.post({
    kind: 'progress',
    payload: {
      channel: 'slow_sim',
      delegate_id: 'd-stale',
      op: 'set_light',
      phase: 'working',
      internal_activity: 1,
      elapsed: 1,
      summary: 'wrong delegate',
    },
  }, 1)
  runtime.post({
    kind: 'observation',
    payload: {
      channel: 'slow_sim',
      delegate_id: 'd-1',
      op: 'set_light',
      origin_ref: 'conversation:999',
      trust: 'trusted_system',
      content: {state: 'wrong origin'},
      refs: [],
    },
  }, 1)

  runtime.apply(runtime.queue.popReady(1)!)
  runtime.apply(runtime.queue.popReady(1)!)

  assert.deepEqual(runtime.memory.channels.get('slow_sim')?.items, [])
})

test('malformed executor results become payload-free unknown handoffs', () => {
  const runtime = dispatchedRuntime()
  runtime.postExecutorResult(0, null, 1)
  runtime.apply(runtime.queue.popReady(1)!)

  const result = runtime.memory.channels.get('slow_sim')?.items[0]
  assert.equal(result?.outcome, 'unknown')
  assert.deepEqual(result?.content, {
    error: 'adapter_raised',
    exception: 'ExecutorContractError',
    detail: 'invalid_executor_output',
  })
})

test('exactly correlated progress appends without terminating the delegate', () => {
  const runtime = dispatchedRuntime()
  runtime.post({
    kind: 'progress',
    payload: {
      channel: 'slow_sim',
      delegate_id: 'd-1',
      op: 'set_light',
      phase: 'working',
      internal_activity: 2,
      elapsed: 1.5,
      summary: 'adjusting',
    },
  }, 1.5)

  runtime.apply(runtime.queue.popReady(1.5)!)

  assert.equal(runtime.activeDelegates().length, 1)
  assert.deepEqual(runtime.memory.channels.get('slow_sim')?.items[0]?.content, {
    op: 'set_light',
    phase: 'working',
    internal_activity: 2,
    elapsed: 1.5,
    summary: 'adjusting',
  })
})

test('deadline writes unknown before termination and a late handoff still appends', () => {
  const runtime = dispatchedRuntime()
  runtime.apply(runtime.queue.popReady(5)!)
  assert.equal(runtime.activeDelegates().length, 0)
  assert.equal(runtime.memory.channels.get('slow_sim')?.items[0]?.outcome, 'unknown')

  runtime.postExecutorCompletion(0, {
    outcome: 'ok',
    trust: 'trusted_system',
    content: {brightness: 30},
  }, 6)
  runtime.apply(runtime.queue.popReady(6)!)

  assert.deepEqual(
    runtime.memory.channels.get('slow_sim')?.items.map(item => item.outcome),
    ['unknown', 'ok'],
  )
})

test('structured update rejection is evidence rather than an exception', () => {
  const runtime = new CoreRuntime({
    manifests: [manifest],
    ids: new ScriptedIdFactory({delegate: []}),
  })
  const user = runtime.post({kind: 'user_input', payload: {text: 'relax'}}, 0)
  const reason = runtime.apply(runtime.queue.popReady(0)!)
  runtime.consumeFastBrain(fastBrainOutputSchema.parse({
    speak: {act: 'none'},
    action: {act: 'update', update: {target: 'intent', delta: {mood: 'calm'}}},
  }), reason!, user.seq)

  const rejection = runtime.memory.channels.get('conversation')?.items.at(-1)
  assert.equal(rejection?.outcome, 'failed')
  assert.deepEqual(rejection?.content, {
    error: 'update_rejected',
    target: 'intent',
    reason: 'unknown_fields',
    unknown: ['mood'],
  })
})

test('scripted ids fail when exhausted or left unused', () => {
  const ids = new ScriptedIdFactory({delegate: ['d-1']})
  assert.throws(() => ids.assertExhausted(), /unused scripted ids/u)
  assert.equal(ids.next('delegate'), 'd-1')
  ids.assertExhausted()
  assert.throws(() => ids.next('delegate'), /sequence exhausted/u)
})

test('handoff and deadline results wake the awaited FastBrain chain', () => {
  const completed = dispatchedRuntime()
  completed.postExecutorCompletion(0, {
    outcome: 'ok',
    trust: 'trusted_system',
    content: {brightness: 30},
  }, 1)
  const handoff = completed.apply(completed.queue.popReady(1)!)
  assert.deepEqual(handoff, {
    kind: 'handoff',
    priority: 50,
    routing_class: 'user_awaited',
    origin: 'd-1',
    selected_suggestion: null,
  })

  const timedOut = dispatchedRuntime()
  const deadline = timedOut.apply(timedOut.queue.popReady(5)!)
  assert.deepEqual(deadline, {
    kind: 'deadline',
    priority: 50,
    routing_class: 'user_awaited',
    origin: 'd-1',
    selected_suggestion: null,
  })
})

test('invalid model contracts become one-hop bounded compensation instead of exceptions', () => {
  const runtime = new CoreRuntime({
    manifests: [manifest],
    ids: new ScriptedIdFactory({delegate: []}),
  })
  runtime.post({kind: 'user_input', payload: {text: 'dim it'}}, 0)
  const reason = runtime.apply(runtime.queue.popReady(0)!)
  assert.notEqual(reason, null)

  const compensation = runtime.consumeFastBrain({
    speak: {act: 'say', text: 'not enough structure'},
  }, reason!, 1)
  assert.deepEqual(compensation, {
    kind: 'delegate_rejected',
    priority: 100,
    routing_class: 'user_awaited',
    origin: null,
    selected_suggestion: null,
  })
  assert.deepEqual(runtime.memory.channels.get('conversation')?.items.at(-1)?.content, {
    error: 'model_contract_failure',
    code: 'invalid_fastbrain_output',
    tool_name: null,
  })

  assert.equal(runtime.consumeFastBrain({invalid: true}, compensation, 1), null)
  assert.equal(runtime.memory.channels.get('conversation')?.items.length, 3)
})

test('unknown model delegates are rejected without consuming host identity', () => {
  const ids = new ScriptedIdFactory({delegate: ['still-unused']})
  const runtime = new CoreRuntime({
    manifests: [manifest],
    ids,
  })
  runtime.post({kind: 'user_input', payload: {text: 'dim it'}}, 0)
  const reason = runtime.apply(runtime.queue.popReady(0)!)

  const compensation = runtime.consumeFastBrain({
    speak: {act: 'none'},
    action: {
      act: 'delegate',
      delegate: {
        executor: 'missing',
        op: 'set_light',
        request: {},
        origin_ref: 'conversation:1',
      },
    },
  }, reason!, 1)

  assert.equal(compensation?.kind, 'delegate_rejected')
  assert.deepEqual(runtime.memory.channels.get('conversation')?.items.at(-1)?.content, {
    error: 'delegate_rejected',
    problem: 'unknown_executor',
    executor: 'missing',
    op: 'set_light',
    origin_ref: 'conversation:1',
  })
  assert.deepEqual(runtime.activeDelegates(), [])
  assert.throws(() => ids.assertExhausted(), /unused scripted ids/u)
})

test('invalid progress decorations never enter trusted Memory or wake the model', () => {
  const runtime = dispatchedRuntime()
  const invalid = [
    {phase: 'started' as const, internal_activity: 1, summary: null},
    {phase: 'started' as const, internal_activity: 0, summary: 'too early'},
    {phase: 'working' as const, internal_activity: 0, summary: null},
    {phase: 'working' as const, internal_activity: 1_048_577, summary: null},
    {phase: 'working' as const, internal_activity: 1, summary: 'line\nbreak'},
    {phase: 'working' as const, internal_activity: 1, summary: 'x'.repeat(401)},
  ]
  for (const [index, decoration] of invalid.entries()) {
    runtime.post({
      kind: 'progress',
      payload: {
        channel: 'slow_sim',
        delegate_id: 'd-1',
        op: 'set_light',
        elapsed: index,
        ...decoration,
      },
    }, index)
    assert.equal(runtime.apply(runtime.queue.popReady(index)!), null)
  }
  assert.deepEqual(runtime.memory.channels.get('slow_sim')?.items, [])
})

test('direct apply rejects a forged progress phase without trusting the caller type', () => {
  const runtime = dispatchedRuntime()
  const forged = {
    seq: 99,
    ts: 1,
    kind: 'progress',
    payload: {
      channel: 'slow_sim',
      delegate_id: 'd-1',
      op: 'set_light',
      phase: 'other',
      internal_activity: 1,
      elapsed: 1,
      summary: null,
    },
  } as unknown as Parameters<typeof runtime.apply>[0]

  assert.equal(runtime.apply(forged), null)
  assert.deepEqual(runtime.memory.channels.get('slow_sim')?.items, [])
})

function testManifest(options: {
  readonly wake: 'fast' | 'surrogate' | 'none'
  readonly suggest?: boolean
  readonly progressViaSurrogate?: boolean
  readonly compressWatermark?: number
}) {
  return executorManifestSchema.parse({
    name: 'route_sim',
    policy: {
      channel: 'route_sim',
      priority: 50,
      wake: options.wake,
      typical_latency: 5,
      compress_watermark: options.compressWatermark ?? 8,
      suggest: options.suggest ?? false,
      progress_via_surrogate: options.progressViaSurrogate ?? false,
    },
    ops: [{
      name: 'run',
      description: 'run deterministic work',
      params: {},
      deadline_budget: 5,
    }],
  })
}

function runtimeWithCalls(options: {
  readonly manifest: ReturnType<typeof testManifest>
  readonly delegateIds?: readonly string[]
  readonly slots?: readonly Slot[]
}) {
  const calls: ModelCall[] = []
  const runtime = new CoreRuntime({
    manifests: [options.manifest],
    ids: new ScriptedIdFactory({delegate: [...(options.delegateIds ?? [])]}),
    modelSlots: options.slots ?? ['fast', 'surrogate.watch'],
    onModelCall: call => calls.push(call),
  })
  return {runtime, calls}
}

test('model calls project channel updates through the configured fresh window', () => {
  const updateRefs = (freshWindow: number): string[] => {
    const calls: ModelCall[] = []
    const runtimeOptions = {
      manifests: [testManifest({wake: 'none'})],
      ids: new ScriptedIdFactory({delegate: []}),
      modelSlots: ['fast'] as const,
      freshWindow,
      onModelCall: (call: ModelCall) => calls.push(call),
    }
    const runtime = new CoreRuntime(runtimeOptions)
    runtime.post({
      kind: 'handoff',
      payload: {
        channel: 'route_sim',
        delegate_id: 'external-1',
        origin_ref: 'conversation:1',
        outcome: 'ok',
        trust: 'trusted_system',
        content: {status: 'ready'},
        refs: [],
      },
    }, 0)
    runtime.apply(runtime.queue.popReady(0)!)
    runtime.post({kind: 'user_input', payload: {text: 'status?'}}, 30)
    runtime.apply(runtime.queue.popReady(30)!)

    const call = calls[0] as ModelCall & {
      readonly context_view?: {
        readonly affordances: readonly {readonly source: string; readonly ref: string}[]
      }
    }
    return call.context_view?.affordances
      .filter(item => item.source === 'channel_update')
      .map(item => item.ref) ?? []
  }

  assert.deepEqual(updateRefs(45), ['route_sim:1'])
  assert.deepEqual(updateRefs(20), [])
})

function appendUserOrigin(runtime: CoreRuntime): void {
  runtime.memory.append('conversation', {
    ts: 0,
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'origin'},
  })
}

function dispatchRoute(runtime: CoreRuntime, routingClass: 'user_awaited' | 'ambient'): void {
  const reason = wakeReasonSchema.parse({
    kind: 'test',
    priority: routingClass === 'user_awaited' ? 100 : 50,
    routing_class: routingClass,
  })
  assert.equal(runtime.consumeFastBrain({
    speak: {act: 'none'},
    action: {
      act: 'delegate',
      delegate: {
        executor: 'route_sim',
        op: 'run',
        request: {},
        origin_ref: 'conversation:1',
      },
    },
  }, reason, 0), null)
}

test('recognized handoffs preserve awaited routing and apply ambient policy fallback', () => {
  const cases = [
    {wake: 'fast' as const, awaited: 'fast', ambient: 'fast'},
    {wake: 'surrogate' as const, awaited: 'fast', ambient: 'surrogate.watch'},
    {wake: 'none' as const, awaited: 'fast', ambient: 'surrogate.watch'},
  ]
  for (const route of cases) {
    for (const routingClass of ['user_awaited', 'ambient'] as const) {
      const {runtime, calls} = runtimeWithCalls({
        manifest: testManifest({wake: route.wake}),
        delegateIds: ['d-1'],
      })
      appendUserOrigin(runtime)
      dispatchRoute(runtime, routingClass)
      runtime.postExecutorCompletion(0, {
        outcome: 'ok',
        trust: 'trusted_system',
        content: {done: true},
      }, 1)
      runtime.apply(runtime.queue.popReady(1)!)
      assert.equal(calls.at(-1)?.slot, route[routingClass === 'user_awaited' ? 'awaited' : 'ambient'])
      assert.equal(calls.at(-1)?.reason.routing_class, routingClass)
    }
  }
})

test('external handoffs are ambient and obey fast, surrogate, and none exactly', () => {
  const cases = [
    {wake: 'fast' as const, expected: 'fast'},
    {wake: 'surrogate' as const, expected: 'surrogate.watch'},
    {wake: 'none' as const, expected: undefined},
  ]
  for (const route of cases) {
    const {runtime, calls} = runtimeWithCalls({manifest: testManifest({wake: route.wake})})
    appendUserOrigin(runtime)
    runtime.post({
      kind: 'handoff',
      payload: {
        channel: 'route_sim',
        delegate_id: 'external-1',
        origin_ref: 'conversation:1',
        outcome: 'ok',
        trust: 'trusted_system',
        content: {observed: true},
        refs: [],
      },
    }, 1)
    runtime.apply(runtime.queue.popReady(1)!)
    assert.equal(calls.at(-1)?.slot, route.expected)
    assert.equal(calls.at(-1)?.reason.routing_class, route.expected === undefined ? undefined : 'ambient')
    assert.equal(runtime.memory.channels.get('route_sim')?.items.length, 1)
  }
})

test('a duplicate definitive handoff cannot inherit reclaimed awaited routing', () => {
  const {runtime, calls} = runtimeWithCalls({
    manifest: testManifest({wake: 'none'}),
    delegateIds: ['d-1'],
    slots: ['fast'],
  })
  appendUserOrigin(runtime)
  dispatchRoute(runtime, 'user_awaited')

  const completion = {
    outcome: 'ok' as const,
    trust: 'trusted_system' as const,
    content: {done: true},
  }
  runtime.postExecutorCompletion(0, completion, 1)
  runtime.apply(runtime.queue.popReady(1)!)
  assert.equal(calls.length, 1)
  assert.equal(runtime.slots.pending.fast, null)

  runtime.postExecutorCompletion(0, completion, 2)
  runtime.apply(runtime.queue.popReady(2)!)
  assert.equal(calls.length, 1)
  assert.equal(runtime.slots.pending.fast, null)
})

test('an unknown handoff keeps awaited routing for a late definitive verdict', () => {
  const {runtime} = runtimeWithCalls({
    manifest: testManifest({wake: 'none'}),
    delegateIds: ['d-1'],
    slots: [],
  })
  appendUserOrigin(runtime)
  dispatchRoute(runtime, 'user_awaited')

  const unknown = runtime.postExecutorCompletion(0, {
    outcome: 'unknown',
    trust: 'trusted_system',
    content: {error: 'transport_timeout'},
  }, 1)
  assert.equal(runtime.queue.popReady(1), unknown)
  const unknownReason = runtime.apply(unknown)
  const verdict = runtime.postExecutorCompletion(0, {
    outcome: 'ok',
    trust: 'trusted_system',
    content: {done: true},
  }, 2)
  assert.equal(runtime.queue.popReady(2), verdict)
  const verdictReason = runtime.apply(verdict)
  const duplicate = runtime.postExecutorCompletion(0, {
    outcome: 'ok',
    trust: 'trusted_system',
    content: {duplicate: true},
  }, 3)
  assert.equal(runtime.queue.popReady(3), duplicate)
  const duplicateReason = runtime.apply(duplicate)

  assert.equal(unknownReason?.routing_class, 'user_awaited')
  assert.equal(verdictReason?.routing_class, 'user_awaited')
  assert.equal(duplicateReason, null)
})

test('an unknown result fences one identical retry and then releases it', () => {
  const {runtime} = runtimeWithCalls({
    manifest: testManifest({wake: 'none'}),
    delegateIds: ['d-1', 'd-2'],
    slots: [],
  })
  appendUserOrigin(runtime)
  dispatchRoute(runtime, 'user_awaited')
  const unknown = runtime.postExecutorCompletion(0, {
    outcome: 'unknown',
    trust: 'trusted_system',
    content: {error: 'transport_timeout'},
  }, 1)
  assert.equal(runtime.queue.popReady(1), unknown)
  runtime.apply(unknown)
  const retry = {
    executor: 'route_sim',
    op: 'run',
    request: {},
    origin_ref: 'conversation:1',
  } as const
  const reason = wakeReasonSchema.parse({
    kind: 'handoff',
    priority: 100,
    routing_class: 'user_awaited',
  })

  const compensation = runtime.consumeFastBrain({
    speak: {act: 'none'},
    action: {act: 'delegate', delegate: retry},
  }, reason, 2)
  const accepted = runtime.consumeFastBrain({
    speak: {act: 'none'},
    action: {act: 'delegate', delegate: retry},
  }, reason, 3)

  assert.equal(compensation?.kind, 'delegate_rejected')
  const problem = runtime.memory.channels.get('conversation')?.items.at(-1)?.content.problem
  if (typeof problem !== 'string') assert.fail('expected a string rejection problem')
  assert.match(problem, /d-1 stopped at unknown/u)
  assert.equal(accepted, null)
  assert.deepEqual(runtime.activeDelegates().map(delegate => delegate.delegate_id), ['d-2'])
})

test('a definitive late verdict stays inert after the uncertainty retry fence', () => {
  const {runtime} = runtimeWithCalls({
    manifest: testManifest({wake: 'none'}),
    delegateIds: ['d-1'],
    slots: [],
  })
  appendUserOrigin(runtime)
  dispatchRoute(runtime, 'user_awaited')
  const unknown = runtime.postExecutorCompletion(0, {
    outcome: 'unknown',
    trust: 'trusted_system',
    content: {error: 'transport_timeout'},
  }, 1)
  assert.equal(runtime.queue.popReady(1), unknown)
  runtime.apply(unknown)
  const reason = wakeReasonSchema.parse({
    kind: 'handoff',
    priority: 100,
    routing_class: 'user_awaited',
  })
  const fenced = runtime.consumeFastBrain({
    speak: {act: 'none'},
    action: {
      act: 'delegate',
      delegate: {
        executor: 'route_sim',
        op: 'run',
        request: {},
        origin_ref: 'conversation:1',
      },
    },
  }, reason, 2)
  const verdict = runtime.postExecutorCompletion(0, {
    outcome: 'ok',
    trust: 'trusted_system',
    content: {done: true},
  }, 3)
  assert.equal(runtime.queue.popReady(3), verdict)
  const verdictReason = runtime.apply(verdict)
  const duplicate = runtime.postExecutorCompletion(0, {
    outcome: 'ok',
    trust: 'trusted_system',
    content: {duplicate: true},
  }, 4)
  assert.equal(runtime.queue.popReady(4), duplicate)
  const duplicateReason = runtime.apply(duplicate)

  assert.equal(fenced?.kind, 'delegate_rejected')
  assert.equal(verdictReason, null)
  assert.equal(duplicateReason, null)
  assert.equal(runtime.memory.channels.get('route_sim')?.items.length, 3)
})

test('an ambient suggest miss appends evidence but neither pools nor wakes', () => {
  const {runtime, calls} = runtimeWithCalls({
    manifest: testManifest({wake: 'surrogate', suggest: true}),
  })
  appendUserOrigin(runtime)
  runtime.post({
    kind: 'handoff',
    payload: {
      channel: 'route_sim',
      delegate_id: 'external-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {hit: false},
      refs: [],
    },
  }, 1)
  runtime.apply(runtime.queue.popReady(1)!)

  assert.equal(runtime.memory.channels.get('route_sim')?.items.length, 1)
  assert.equal(runtime.suggestions.all().length, 0)
  assert.equal(calls.length, 0)
})

test('deadlines use the same awaited and ambient policy routing as recognized handoffs', () => {
  for (const [wake, expected] of [
    ['fast', 'fast'],
    ['surrogate', 'surrogate.watch'],
    ['none', 'surrogate.watch'],
  ] as const) {
    for (const routingClass of ['ambient', 'user_awaited'] as const) {
      const {runtime, calls} = runtimeWithCalls({
        manifest: testManifest({wake}),
        delegateIds: ['d-1'],
      })
      appendUserOrigin(runtime)
      dispatchRoute(runtime, routingClass)
      runtime.apply(runtime.queue.popReady(5)!)
      assert.equal(calls.at(-1)?.slot, routingClass === 'user_awaited' ? 'fast' : expected)
      assert.equal(calls.at(-1)?.reason.kind, 'deadline')
    }
  }
})

test('progress-via-Surrogate ignores started and summary-free progress', () => {
  const {runtime, calls} = runtimeWithCalls({
    manifest: testManifest({wake: 'none', progressViaSurrogate: true}),
    delegateIds: ['d-1'],
  })
  appendUserOrigin(runtime)
  dispatchRoute(runtime, 'ambient')
  for (const [at, phase, internalActivity] of [
    [1, 'started', 0],
    [2, 'working', 1],
  ] as const) {
    runtime.post({
      kind: 'progress',
      payload: {
        channel: 'route_sim',
        delegate_id: 'd-1',
        op: 'run',
        phase,
        internal_activity: internalActivity,
        elapsed: at,
        summary: null,
      },
    }, at)
    runtime.apply(runtime.queue.popReady(at)!)
  }
  assert.equal(runtime.memory.channels.get('route_sim')?.items.length, 2)
  assert.equal(runtime.suggestions.all().length, 0)
  assert.equal(calls.length, 0)
})

test('progress routed through Surrogate creates one bound candidate and only FastBrain speaks', () => {
  const {runtime, calls} = runtimeWithCalls({
    manifest: testManifest({wake: 'none', progressViaSurrogate: true}),
    delegateIds: ['d-1'],
  })
  appendUserOrigin(runtime)
  dispatchRoute(runtime, 'ambient')
  runtime.post({
    kind: 'progress',
    payload: {
      channel: 'route_sim',
      delegate_id: 'd-1',
      op: 'run',
      phase: 'working',
      internal_activity: 1,
      elapsed: 1,
      summary: 'halfway',
    },
  }, 1)
  runtime.apply(runtime.queue.popReady(1)!)
  assert.equal(calls[0]?.slot, 'surrogate.watch')
  assert.equal(runtime.suggestions.get('s-1')?.content.summary, 'halfway')

  runtime.completeModelCall(calls[0].job_id, {
    speak: true,
    suggestion_id: 's-1',
    reason: 'worth mentioning',
  }, 1)
  runtime.apply(runtime.queue.popReady(1)!)
  assert.equal(calls[1]?.slot, 'fast')
  assert.equal(calls[1]?.reason.selected_suggestion, 's-1')
})

test('an old Surrogate verdict cannot withdraw a replacement progress candidate', () => {
  const {runtime, calls} = runtimeWithCalls({
    manifest: testManifest({wake: 'none', progressViaSurrogate: true}),
    delegateIds: ['d-1'],
  })
  appendUserOrigin(runtime)
  dispatchRoute(runtime, 'ambient')
  for (const [at, summary] of [[1, 'first'], [2, 'second']] as const) {
    runtime.post({
      kind: 'progress',
      payload: {
        channel: 'route_sim',
        delegate_id: 'd-1',
        op: 'run',
        phase: 'working',
        internal_activity: at,
        elapsed: at,
        summary,
      },
    }, at)
    runtime.apply(runtime.queue.popReady(at)!)
  }
  assert.equal(calls.length, 1)
  assert.equal(runtime.suggestions.get('s-1')?.status, 'withdrawn')
  assert.equal(runtime.suggestions.get('s-2')?.status, 'pending')

  runtime.completeModelCall(calls[0]!.job_id, {
    speak: true,
    suggestion_id: 's-1',
    reason: 'stale',
  }, 2)
  runtime.apply(runtime.queue.popReady(2)!)
  assert.equal(calls[1]?.slot, 'surrogate.watch')
  assert.equal(runtime.suggestions.get('s-2')?.status, 'pending')
})

test('new user input keeps old speech but voids the old model action before dispatch', () => {
  const {runtime, calls} = runtimeWithCalls({
    manifest: testManifest({wake: 'fast'}),
    delegateIds: ['unused'],
    slots: ['fast'],
  })
  runtime.post({kind: 'user_input', payload: {text: 'dim it'}}, 0)
  runtime.apply(runtime.queue.popReady(0)!)
  runtime.post({kind: 'user_input', payload: {text: 'never mind'}}, 0.1)
  runtime.apply(runtime.queue.popReady(0.1)!)
  assert.equal(calls.length, 1)

  runtime.completeModelCall(calls[0]!.job_id, {
    speak: {act: 'say', text: 'Okay, cancelled.'},
    action: {
      act: 'delegate',
      delegate: {
        executor: 'route_sim',
        op: 'run',
        request: {},
        origin_ref: 'conversation:1',
      },
    },
  }, 1)
  assert.deepEqual([0, 1, 2].map(() => {
    const event = runtime.queue.popReady(1)!
    runtime.apply(event)
    return event.kind
  }), ['speak_start', 'speak_end', 'model_done'])
  assert.equal(calls.length, 2)
  assert.deepEqual(runtime.activeDelegates(), [])
  const conversation = runtime.memory.channels.get('conversation')!.items
  assert.equal(conversation.some(item => item.content.text === 'Okay, cancelled.'), true)
  const dropped = conversation.find(item => item.content.error === 'action_superseded')
  assert.deepEqual(dropped?.refs, ['conversation:2'])
  assert.equal(dropped?.content.op, 'run')

  runtime.completeModelCall(calls[1]!.job_id, {
    speak: {act: 'none'},
    action: {act: 'none'},
  }, 1)
  runtime.apply(runtime.queue.popReady(1)!)
  runtime.assertQuiescent()
})

test('system handoffs do not supersede an in-flight FastBrain action', () => {
  const {runtime, calls} = runtimeWithCalls({
    manifest: testManifest({wake: 'fast'}),
    delegateIds: ['d-1'],
    slots: ['fast'],
  })
  runtime.post({kind: 'user_input', payload: {text: 'run it'}}, 0)
  runtime.apply(runtime.queue.popReady(0)!)
  runtime.post({
    kind: 'handoff',
    payload: {
      channel: 'route_sim',
      delegate_id: 'external-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {observed: true},
      refs: [],
    },
  }, 0.5)
  runtime.apply(runtime.queue.popReady(0.5)!)

  const firstCall = calls[0]
  assert.ok(firstCall)
  runtime.completeModelCall(firstCall.job_id, {
    speak: {act: 'none'},
    action: {
      act: 'delegate',
      delegate: {
        executor: 'route_sim',
        op: 'run',
        request: {},
        origin_ref: 'conversation:1',
      },
    },
  }, 1)
  runtime.apply(runtime.queue.popReady(1)!)
  assert.equal(runtime.activeDelegates().length, 1)
  assert.equal(runtime.activeDelegates()[0]?.delegate_id, 'd-1')
  assert.equal(
    runtime.memory.channels.get('conversation')?.items
      .some(item => item.content.error === 'action_superseded'),
    false,
  )
})

test('malformed FastBrain completions trigger one bounded compensation job', () => {
  const {runtime, calls} = runtimeWithCalls({
    manifest: testManifest({wake: 'fast'}),
    slots: ['fast'],
  })
  runtime.post({kind: 'user_input', payload: {text: 'hello'}}, 0)
  runtime.apply(runtime.queue.popReady(0)!)
  runtime.completeModelCall(calls[0]!.job_id, {invalid: true}, 0)
  runtime.apply(runtime.queue.popReady(0)!)
  assert.equal(calls.length, 2)

  runtime.completeModelCall(calls[1]!.job_id, {still_invalid: true}, 0)
  runtime.apply(runtime.queue.popReady(0)!)
  assert.equal(calls.length, 2)
  assert.equal(
    runtime.memory.channels.get('conversation')?.items
      .filter(item => item.content.error === 'model_contract_failure').length,
    2,
  )
  runtime.assertQuiescent()
})

test('duplicate and wrong-slot completions do not consume the active model job', () => {
  const {runtime, calls} = runtimeWithCalls({
    manifest: testManifest({wake: 'none'}),
    slots: ['fast'],
  })
  runtime.post({kind: 'user_input', payload: {text: 'hello'}}, 0)
  runtime.apply(runtime.queue.popReady(0)!)
  const call = calls[0]!

  runtime.post({
    kind: 'model_done',
    payload: {slot: 'surrogate.watch', job_id: call.job_id},
  }, 0)
  runtime.completeModelCall(call.job_id, {
    speak: {act: 'none'},
    action: {act: 'none'},
  }, 0)
  assert.throws(() => runtime.completeModelCall(call.job_id, {
    speak: {act: 'none'},
    action: {act: 'none'},
  }, 0), /already completed/u)

  assert.throws(() => runtime.apply(runtime.queue.popReady(0)!), /unknown model completion/u)
  assert.equal(runtime.slots.activeJobId.fast, call.job_id)
  assert.equal(runtime.slots.inflight.fast, true)

  runtime.apply(runtime.queue.popReady(0)!)
  runtime.assertQuiescent()
  assert.throws(() => runtime.completeModelCall(call.job_id, {
    speak: {act: 'none'},
    action: {act: 'none'},
  }, 0), /unknown model job/u)
})

test('compressor completion publishes a trimmed summary through its own job slot', () => {
  const {runtime, calls} = runtimeWithCalls({
    manifest: testManifest({wake: 'none', compressWatermark: 1}),
    slots: ['compress'],
  })
  appendUserOrigin(runtime)
  runtime.post({
    kind: 'handoff',
    payload: {
      channel: 'route_sim',
      delegate_id: 'external-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {done: true},
      refs: [],
    },
  }, 0)
  runtime.apply(runtime.queue.popReady(0)!)
  runtime.apply(runtime.queue.popReady(0)!)
  assert.equal(calls[0]?.slot, 'compress')

  runtime.completeModelCall(calls[0].job_id, {channel: 'route_sim', summary: '  done  '}, 0)
  runtime.apply(runtime.queue.popReady(0)!)
  assert.equal(runtime.memory.channels.get('route_sim')?.summary, 'done')
  assert.equal(runtime.memory.channels.get('route_sim')?.uncompressed, 0)
  runtime.assertQuiescent()
})

test('a compressor result for the wrong channel is rejected with a bounded diagnostic', () => {
  const {runtime, calls} = runtimeWithCalls({
    manifest: testManifest({wake: 'none', compressWatermark: 1}),
    slots: ['compress'],
  })
  appendUserOrigin(runtime)
  runtime.post({
    kind: 'handoff',
    payload: {
      channel: 'route_sim',
      delegate_id: 'external-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {done: true},
      refs: [],
    },
  }, 0)
  runtime.apply(runtime.queue.popReady(0)!)
  runtime.apply(runtime.queue.popReady(0)!)

  runtime.completeModelCall(calls[0]!.job_id, {channel: 'other', summary: 'wrong'}, 0)
  runtime.apply(runtime.queue.popReady(0)!)
  assert.equal(runtime.memory.channels.get('route_sim')?.summary, null)
  assert.deepEqual(runtime.diagnostics, [{code: 'invalid_compressor_output'}])
  runtime.assertQuiescent()
})

test('a streaming port arbitrates the Floor at its first chunk, not at completion', () => {
  // Python consults the Floor when the first character arrives; deciding at model_done
  // instead would read a Floor that has already moved on. This exercises exactly that
  // window: the user starts speaking after the stream opened the Floor but before the
  // model output lands.
  const calls: ModelCall[] = []
  const runtime = new CoreRuntime({
    manifests: [],
    ids: new MonotonicIdFactory(),
    modelSlots: ['fast'],
    onModelCall: call => calls.push(call),
  })

  runtime.apply(runtime.queue.popReady(0)
    ?? runtime.post({kind: 'user_input', payload: {text: '把灯调暗'}}, 0))
  const pending = runtime.queue.popReady(0)
  if (pending !== undefined) runtime.apply(pending)

  const call = calls.at(-1)
  assert.ok(call !== undefined)
  assert.equal(call.slot, 'fast')
  // The utterance identity must reach the port, or it cannot open the Floor.
  assert.ok(typeof call.utterance_id === 'string' && call.utterance_id.length > 0)

  // First chunk arrives while the Floor is idle: allowed, and reserved in place.
  assert.equal(runtime.floor.state, 'idle')
  assert.equal(runtime.openFloor(call.job_id, call.utterance_id, 100, 0), true)
  assert.equal(runtime.floor.state, 'agent_speaking',
    'the reservation must be in place immediately, or a concurrent Surrogate view reads idle')

  // The user barges in mid-stream. Deciding at completion would have seen this and
  // deferred, contradicting the words already on the wire.
  runtime.startUserSpeech('speech-1')
  assert.equal(runtime.floor.state, 'user_speaking')

  runtime.closeFloor(call.utterance_id, 1)
  const speakEvents = []
  for (;;) {
    const event = runtime.queue.popReady(1)
    if (event === undefined) break
    if (event.kind === 'speak_start' || event.kind === 'speak_end') speakEvents.push(event.kind)
  }
  // Exactly one pair, posted by the streaming port rather than by completion handling.
  assert.deepEqual(speakEvents, ['speak_start', 'speak_end'])
})

test('a deferred streaming utterance posts no Floor events at all', () => {
  const calls: ModelCall[] = []
  const runtime = new CoreRuntime({
    manifests: [],
    ids: new MonotonicIdFactory(),
    modelSlots: ['fast'],
    onModelCall: call => calls.push(call),
  })
  // A user already holds the floor when the stream starts.
  runtime.startUserSpeech('speech-1')
  const first = runtime.post({kind: 'user_input', payload: {text: '你好'}}, 0)
  runtime.apply(first)
  const call = calls.at(-1)
  assert.ok(call?.utterance_id !== undefined)

  assert.equal(runtime.openFloor(call.job_id, call.utterance_id, 100, 0), false)
  assert.equal(runtime.floor.state, 'user_speaking', 'a deferred utterance must not reserve')
  const queued = []
  for (;;) {
    const event = runtime.queue.popReady(0)
    if (event === undefined) break
    queued.push(event.kind)
  }
  assert.ok(!queued.includes('speak_start'))
})

test('speech a streaming port already voiced is never reclassified as deferred', () => {
  // Without the completion-time guard, prepareSpeech re-decides against a Floor the
  // stream itself has already taken: decide(100) against agent_speaking(100) is `defer`,
  // so the utterance that was actually spoken would be filed in the suggestion pool
  // instead of the conversation channel and recorded as a deferred Floor decision.
  const calls: ModelCall[] = []
  const runtime = new CoreRuntime({
    manifests: [],
    ids: new MonotonicIdFactory(),
    modelSlots: ['fast'],
    onModelCall: call => calls.push(call),
  })
  runtime.apply(runtime.post({kind: 'user_input', payload: {text: 'hi'}}, 0))
  const call = calls.at(-1)
  assert.ok(call?.utterance_id !== undefined)

  assert.equal(runtime.openFloor(call.job_id, call.utterance_id, 100, 0), true)
  runtime.completeModelCall(call.job_id, {
    speak: {act: 'say', text: 'spoken words'},
    action: {act: 'none'},
  }, 0)
  for (;;) {
    const event = runtime.queue.popReady(0)
    if (event === undefined) break
    runtime.apply(event)
  }

  const conversation = runtime.memory.channels.get('conversation')?.items ?? []
  assert.ok(conversation.some(item => item.content.text === 'spoken words'),
    'voiced speech belongs in the conversation channel')
  assert.ok(!runtime.suggestions.all().some(item => item.content.text === 'spoken words'),
    'and must not also be offered as a suggestion')
  assert.deepEqual(runtime.floorDecisions.map(decision => decision.decision), ['allow'],
    'the recorded decision is the one the stream actually acted on')
})

test('a contract failure suppresses the action even when one is present', () => {
  // The oracle rejects the whole turn: an unknown tool alongside a valid delegate must
  // not dispatch, or a hallucinated tool name becomes a way to smuggle work through.
  const runtime = new CoreRuntime({
    manifests: [fixtureSlowSim],
    ids: new MonotonicIdFactory(),
    modelSlots: ['fast'],
    onModelCall: () => undefined,
  })
  runtime.apply(runtime.post({kind: 'user_input', payload: {text: 'hi'}}, 0))

  const compensation = runtime.consumeFastBrain({
    speak: {act: 'none'},
    action: {act: 'delegate', delegate: {
      executor: 'slow_sim', op: 'set_light', request: {}, origin_ref: 'conversation:1',
    }},
    contract_failures: [{code: 'unknown_tool', tool_name: 'nope__missing'}],
  }, wakeReasonSchema.parse({kind: 'user_input', priority: 100}), 1)

  assert.equal(runtime.executorEffects.length, 0, 'nothing may be dispatched')
  assert.equal(compensation?.kind, 'delegate_rejected')
  const refusal = runtime.memory.channels.get('conversation')?.items.at(-1)
  assert.equal(refusal?.outcome, 'failed')
  assert.equal(refusal?.content.error, 'model_contract_failure')
  assert.equal(refusal?.content.code, 'unknown_tool')
  assert.equal(refusal?.content.tool_name, 'nope__missing')
  // A single failure records no count; only a surplus does.
  assert.equal(refusal?.content.count, undefined)
})

test('several contract failures record their count', () => {
  const runtime = new CoreRuntime({
    manifests: [fixtureSlowSim],
    ids: new MonotonicIdFactory(),
    modelSlots: ['fast'],
    onModelCall: () => undefined,
  })
  runtime.apply(runtime.post({kind: 'user_input', payload: {text: 'hi'}}, 0))
  runtime.consumeFastBrain({
    speak: {act: 'none'},
    action: {act: 'none'},
    contract_failures: [
      {code: 'unknown_tool', tool_name: 'a'},
      {code: 'invalid_tool_arguments', tool_name: 'b'},
    ],
  }, wakeReasonSchema.parse({kind: 'user_input', priority: 100}), 1)
  const refusal = runtime.memory.channels.get('conversation')?.items.at(-1)
  assert.equal(refusal?.content.count, 2)
  // The first failure is the reported one.
  assert.equal(refusal?.content.tool_name, 'a')
})

test('a surplus action rejects every action, including the first', () => {
  // Executing the first and rejecting the rest would produce "one of your two requests
  // was handled; guess which".
  const runtime = new CoreRuntime({
    manifests: [fixtureSlowSim],
    ids: new MonotonicIdFactory(),
    modelSlots: ['fast'],
    onModelCall: () => undefined,
  })
  runtime.apply(runtime.post({kind: 'user_input', payload: {text: 'hi'}}, 0))
  runtime.consumeFastBrain({
    speak: {act: 'none'},
    action: {act: 'delegate', delegate: {
      executor: 'slow_sim', op: 'set_light', request: {}, origin_ref: 'conversation:1',
    }},
    extra_actions: 1,
  }, wakeReasonSchema.parse({kind: 'user_input', priority: 100}), 1)

  assert.equal(runtime.executorEffects.length, 0)
  const refusal = runtime.memory.channels.get('conversation')?.items.at(-1)
  assert.equal(refusal?.content.error, 'multiple_actions')
  assert.equal(refusal?.content.count, 2, 'the count includes the first action')
  assert.equal(refusal?.content.act, 'delegate')
})

test('speech is still consumed when the action is rejected', () => {
  // A rejected action does not retract words the user already heard.
  const runtime = new CoreRuntime({
    manifests: [fixtureSlowSim],
    ids: new MonotonicIdFactory(),
    modelSlots: ['fast'],
    onModelCall: () => undefined,
  })
  runtime.apply(runtime.post({kind: 'user_input', payload: {text: 'hi'}}, 0))
  runtime.consumeFastBrain({
    speak: {act: 'say', text: '在处理'},
    action: {act: 'none'},
    extra_actions: 2,
  }, wakeReasonSchema.parse({kind: 'user_input', priority: 100}), 1)

  const conversation = runtime.memory.channels.get('conversation')?.items ?? []
  assert.ok(conversation.some(item => item.content.text === '在处理'))
  assert.ok(conversation.some(item => item.content.error === 'multiple_actions'))
})
