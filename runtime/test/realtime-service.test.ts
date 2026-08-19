/**
 * The Node leg of the realtime service parity suite, plus the lifecycle tests.
 *
 * The parity half covers the part of the service that decides *order*: which host fact reaches the
 * provider next. All three ordering fields earn their place -- priority so a Guard alert does not wait
 * behind a routine announcement, preemptiveness so two facts of equal priority are not equally
 * interruptive, and the sequence so delivery order does not depend on what the heap did with a tie.
 *
 * The lifecycle half is Node-only: it exercises the loops and locks, which are structurally different
 * from asyncio and so cannot be pinned by a shared golden.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical-json.js'
import { VirtualClock } from '../src/clock.js'
import type { JsonValue } from '../src/events.js'
import { Memory } from '../src/memory.js'
import { executorManifestSchema } from '../src/ports.js'
import { RealtimeRuntimeBridge } from '../src/realtime/bridge.js'
import type { HostContextItem, HostResponseIntent } from '../src/realtime/protocol.js'
import { ItemDeliveryUncertainError } from '../src/realtime/protocol.js'
import {
  NotYetPortedError,
  RealtimeService,
  type ServiceProvider,
} from '../src/realtime/service.js'
import { PREEMPT_MIN_PRIORITY, type QueuedHostResponse } from '../src/realtime/service-state.js'
import { RealtimeSession, type SessionProvider } from '../src/realtime/session.js'
import { PlaybackRegistry } from '../src/playback.js'
import { compileToolSchema } from '../src/tool-schema.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/realtime/service/v1')

interface Step {
  readonly kind: string
  readonly event_id?: string
  readonly priority?: number
  readonly preemptive?: boolean
  readonly at?: number
  readonly semantic_event_id?: string | null
  readonly guard_delegate_id?: string | null
  readonly source_epoch?: number
}

interface Scenario {
  readonly name: string
  readonly covers: readonly string[]
  readonly steps: readonly Step[]
}

const document = JSON.parse(readFileSync(resolve(fixtureRoot, 'scenarios.json'), 'utf8')) as {
  readonly scenarios: readonly Scenario[]
}
const golden = JSON.parse(
  readFileSync(resolve(fixtureRoot, 'scenarios-expected.json'), 'utf8'),
) as {
  readonly constants: {readonly preempt_min_priority: number; readonly user_priority: number}
  readonly scenarios: readonly Record<string, unknown>[]
}

function hostFact(eventId: string): HostResponseIntent {
  const item: HostContextItem = {
    kind: 'final',
    host_item_id: `host-${eventId}`,
    event_id: eventId,
    content: 'x',
    call_id: null,
  }
  return {kind: 'host_fact', item, task_summary: null, origin_spoken: false}
}

/**
 * A service with only the queue wired.
 *
 * The parity scenarios exercise ordering, and a fully assembled service would be measuring the
 * provider, session, and bridge instead. Everything unused is a stub that throws if reached, so a
 * scenario that wandered outside the queue fails by name rather than silently exercising a double.
 */
function queueOnlyService(): RealtimeService {
  return new RealtimeService(queueOnlyOptions())
}

function runScenario(scenario: Scenario): Record<string, unknown> {
  const service = queueOnlyService()
  const steps: Record<string, unknown>[] = []
  let seq = 0
  for (const [index, step] of scenario.steps.entries()) {
    let result: unknown = null
    if (step.kind === 'queue') {
      const priority = step.priority ?? 50
      seq += 1
      service.queueHostItem(hostFact(step.event_id!), {
        priority,
        preemptive: step.preemptive ?? false,
        semanticEventId: step.semantic_event_id ?? null,
        guardDelegateId: step.guard_delegate_id ?? null,
      })
      result = {
        seq,
        effective_priority: Math.min(priority, golden.constants.user_priority - 1),
      }
    } else if (step.kind === 'pop') {
      result = describe(service.takeNextQueuedHostItem())
    } else if (step.kind === 'drain') {
      const drained: unknown[] = []
      for (;;) {
        const popped = service.takeNextQueuedHostItem()
        if (popped === undefined) break
        drained.push(describe(popped))
      }
      result = drained
    } else {
      throw new Error(`unsupported step kind: ${step.kind}`)
    }
    const armed = service.armedPreemptPriority
    steps.push({
      step: index,
      kind: step.kind,
      result,
      armed_preempt_priority: armed,
      eligible_preempt: armed !== null && armed >= PREEMPT_MIN_PRIORITY,
      queued_order: service.queuedHostItems().map(item => ({
        event_id: item.intent.item.event_id,
        seq: item.seq,
      })),
    })
  }
  return {name: scenario.name, steps}
}

function describe(queued: QueuedHostResponse | undefined): unknown {
  if (queued === undefined) return null
  return {
    event_id: queued.intent.item.event_id,
    priority: queued.priority,
    preemptive: queued.preemptive,
    seq: queued.seq,
  }
}

test('every service queue scenario matches the Python-exported golden', () => {
  const mismatched: string[] = []
  for (const [index, scenario] of document.scenarios.entries()) {
    const actual = runScenario(scenario)
    if (canonicalJson(actual) !== canonicalJson(golden.scenarios[index])) {
      mismatched.push(scenario.name)
    }
  }
  assert.deepEqual(mismatched, [], 'queue ordering differs from the oracle')
})

test('the bounds the golden records are the bounds the module uses', () => {
  // The constants are behavior: `PREEMPT_MIN_PRIORITY` is the line between a fact that waits and one
  // that interrupts. Reading them from the golden rather than restating them means a change on either
  // side has to be a deliberate re-export.
  assert.equal(PREEMPT_MIN_PRIORITY, golden.constants.preempt_min_priority)
})

test('every scenario declares what it covers', () => {
  for (const scenario of document.scenarios) {
    assert.ok(scenario.covers.length > 0, scenario.name)
    assert.ok(scenario.steps.length > 0, scenario.name)
  }
})

test('the scenario set exercises all three ordering fields', () => {
  // A set that only varied priority would pass with the other two fields deleted.
  const kinds = new Set(document.scenarios.flatMap(scenario => scenario.covers))
  for (const expected of [
    'service.queue_priority',
    'service.queue_fifo_within_priority',
    'service.queue_preemptive_tiebreak',
    'service.priority_clamp',
    'service.armed_preempt',
  ]) {
    assert.ok(kinds.has(expected), `no scenario covers ${expected}`)
  }
})

test('an unported family fails by name rather than behaving as if it were off', async () => {
  // Silence here would be indistinguishable from correctness: a service that quietly declined to
  // project runtime events looks exactly like one with no events to project. Each entry point still
  // waiting on a family is listed, so this test is the record of what is missing.
  const service = queueOnlyService()
  assert.throws(() => service.projectRuntimeEvent({}, {
    kind: 'test',
    priority: 50,
    routing_class: 'user_awaited',
    origin: null,
    selected_suggestion: null,
  }), NotYetPortedError, 'family O: runtime event projection')
  await assert.rejects(
    () => service.handleEvent({
      kind: 'response_cancel_rejected',
      session_epoch: 1,
      response_id: 'r-1',
      cancel_request_id: 'cancel-1',
      reason: 'no_active_response',
    }),
    NotYetPortedError,
    'family L: guard cancel rejection',
  )
})

test('driving continuations with nothing queued is a no-op, not a refusal', () => {
  // The drive runs on every accepted event, so its empty case is the common one. It has to return
  // quietly rather than throw or block, or an ordinary event would fail.
  const service = queueOnlyService()
  return service.driveContinuations()
})

test('the guard history arms are the measured ones, and nothing else', () => {
  // 1, 2, or 4 rather than any positive number: these are the arms the recovery experiment has, and
  // an unlisted value would silently be a fifth arm nobody measured.
  for (const pairs of [0, 3, 5, 8, -1, 1.5]) {
    assert.throws(
      () => new RealtimeService({
        ...queueOnlyOptions(),
        guardHistoryPairs: pairs,
      }),
      /pair budget must be 1, 2, or 4/u,
      `pairs=${pairs}`,
    )
  }
  for (const pairs of [1, 2, 4]) {
    assert.doesNotThrow(() => new RealtimeService({...queueOnlyOptions(), guardHistoryPairs: pairs}))
  }
  assert.throws(
    () => new RealtimeService({
      ...queueOnlyOptions(),
      guardHistoryRecovery: 'sideways' as 'none',
    }),
    /unknown Guard history recovery arm/u,
  )
})

test('the provider schemas are copied, not aliased', () => {
  // They are handed to the provider on every connect, including after a reconnect. A caller mutating
  // its own array afterwards would change what the model is told its tools are, mid-session.
  const schemas: Record<string, JsonValue>[] = [{function: {name: 'a', parameters: {}}}]
  const service = new RealtimeService({...queueOnlyOptions(), providerSchemas: schemas})
  const before = canonicalJson(service.providerSchemasForTest)
  schemas[0]!.function = {name: 'tampered', parameters: {}}
  schemas.push({function: {name: 'added', parameters: {}}})
  assert.equal(
    canonicalJson(service.providerSchemasForTest),
    before,
    'the caller mutating its array must not change what the service will send',
  )
  assert.equal(service.providerSchemasForTest.length, 1)
  assert.equal(
    canonicalJson(service.providerSchemasForTest[0]),
    canonicalJson({function: {name: 'a', parameters: {}}}),
  )
})

/**
 * Options for a service with only the queue wired.
 *
 * The parity scenarios exercise ordering, and a fully assembled service would be measuring the
 * provider, session, and bridge instead. Everything unused throws if reached, so a scenario that
 * wandered outside the queue fails by name rather than silently exercising a double.
 */
function queueOnlyOptions(): ConstructorParameters<typeof RealtimeService>[0] {
  const manifest = executorManifestSchema.parse({
    name: 'queue_sim',
    policy: {
      channel: 'queue_sim',
      priority: 50,
      wake: 'fast',
      typical_latency: 5,
      compress_watermark: 8,
    },
    ops: [{
      name: 'look',
      description: 'readonly',
      params: {type: 'object', properties: {}, additionalProperties: false},
      readonly: true,
      deadline_budget: 5,
    }],
  })
  const clock = new VirtualClock()
  const memory = new Memory({policies: [manifest.policy]})
  const executors = new Map([[manifest.name, {manifest}]])
  const unreachable = (name: string) => (): never => {
    throw new Error(`${name} must not be reached by a queue-ordering scenario`)
  }
  return {
    provider: {
      sendAudio: unreachable('sendAudio'),
      events: unreachable('events'),
      close: () => Promise.resolve(),
    } satisfies ServiceProvider,
    runtime: {
      clock,
      executors,
      observe: () => unsubscribeNothing,
      // Never resolves: the runtime loop outlives every test here, and resolving it would look like
      // the loop ending, which the service treats as a failure.
      serve: () => new Promise<void>(() => undefined),
    },
    tools: compileToolSchema([manifest]),
    session: {} as unknown as RealtimeSession,
    bridge: new RealtimeRuntimeBridge({
      runtime: {
        clock,
        memory,
        executors,
        ingestUserInput: unreachable('ingestUserInput'),
        updateExternal: unreachable('updateExternal'),
        dispatchExternal: unreachable('dispatchExternal'),
      },
      tools: compileToolSchema([manifest]),
      idFactory: () => 'id-1',
    }),
    idFactory: () => 'host-1',
  }
}

/** An unsubscribe for an observer nobody registered. Named so it is not an anonymous empty arrow. */
function unsubscribeNothing(): void {
  // Intentionally empty: nothing was subscribed.
}

test('a recovery item that comes back uncertain stops the service rather than retrying', async () => {
  // Retrying a recovery injection means reconnecting, and a recovery injection is what a reconnect
  // *is* -- so the retry would recurse. Two uncertainties for the same item mean the transport cannot
  // be trusted to report anything, and guessing whether the model has seen a fact is worse than
  // stopping.
  const diagnostics: string[] = []
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    onDiagnostic: line => diagnostics.push(line),
  })
  const uncertain = new ItemDeliveryUncertainError({
    session_epoch: 1,
    host_item_id: 'host-1',
    provider_item_id: 'provider-1',
    item_kind: 'recovery',
  })
  await service.reportUncertainDeliveryForTest(uncertain)
  assert.equal(service.stopped, true)
  assert.deepEqual(diagnostics, ['[realtime-diagnostic] uncertain_delivery_exhausted'])
})

test('an ordinary item is retried once, and a second uncertainty stops the service', async () => {
  // One retry per item: the first uncertainty is a transport that might recover, the second is a
  // transport that cannot be trusted to report anything. Guessing whether the model has seen a fact
  // is worse than stopping, so the second attempt does not happen.
  const diagnostics: string[] = []
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    onDiagnostic: line => diagnostics.push(line),
  })
  const uncertain = (hostItemId: string): ItemDeliveryUncertainError => new ItemDeliveryUncertainError({
    session_epoch: 1,
    host_item_id: hostItemId,
    provider_item_id: 'provider-1',
    item_kind: 'final',
  })

  // The first attempt reaches the reconnect, which is not ported -- so it fails by name rather than
  // reporting the retry budget as exhausted.
  await assert.rejects(
    () => service.reportUncertainDeliveryForTest(uncertain('host-1')),
    NotYetPortedError,
  )
  assert.equal(service.stopped, false, 'a first uncertainty must not stop the service')
  assert.deepEqual(diagnostics, [])

  // The same item again: the retry is already spent, so it never reaches the reconnect.
  await service.reportUncertainDeliveryForTest(uncertain('host-1'))
  assert.equal(service.stopped, true)
  assert.deepEqual(diagnostics, ['[realtime-diagnostic] uncertain_delivery_exhausted'])
})

test('the retry budget is per item, not global', async () => {
  // A different item gets its own first attempt: one flaky injection must not spend the budget of
  // every later one.
  const service = new RealtimeService(queueOnlyOptions())
  const uncertain = (hostItemId: string): ItemDeliveryUncertainError => new ItemDeliveryUncertainError({
    session_epoch: 1,
    host_item_id: hostItemId,
    provider_item_id: 'provider-1',
    item_kind: 'final',
  })
  await assert.rejects(
    () => service.reportUncertainDeliveryForTest(uncertain('host-1')),
    NotYetPortedError,
  )
  await assert.rejects(
    () => service.reportUncertainDeliveryForTest(uncertain('host-2')),
    NotYetPortedError,
    'a second item still gets its own retry',
  )
  assert.equal(service.stopped, false)
})

test('the stop flag is a real AbortSignal, because the runtime registers a listener on it', async () => {
  // The finding this test exists for: a look-alike carrying only `aborted` throws
  // `TypeError: addEventListener is not a function` inside `serve`, which the task guard then reports
  // as a provider failure -- so the service would stop on its first `start()`.
  let received: AbortSignal | undefined
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    session: {
      connect: () => Promise.resolve(),
    } as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      events: () => emptyStream(),
      close: () => Promise.resolve(),
    },
    runtime: {
      ...queueOnlyOptions().runtime,
      serve: (signal: AbortSignal) => {
        received = signal
        // Exactly what CausalRuntime.serve does first.
        signal.addEventListener('abort', () => undefined, {once: true})
        return new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), {once: true})
        })
      },
    },
  })
  await service.start()
  assert.ok(received instanceof AbortSignal, 'the runtime must be handed a real AbortSignal')
  assert.equal(service.stopped, false, 'start must not have tripped the failure path')
  await service.close()
  assert.equal(service.stopped, true)
  assert.equal(received.aborted, true, 'close must abort the signal the runtime is watching')
})

test('start after close works, because the stop flag is replaced rather than reset', async () => {
  // An AbortController cannot be un-aborted, so a service that kept one would never start again.
  const signals: AbortSignal[] = []
  const options = {
    ...queueOnlyOptions(),
    session: {connect: () => Promise.resolve()} as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      events: () => emptyStream(),
      close: () => Promise.resolve(),
    },
  }
  const service = new RealtimeService({
    ...options,
    runtime: {
      ...options.runtime,
      serve: (signal: AbortSignal) => {
        signals.push(signal)
        return new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), {once: true})
        })
      },
    },
  })
  await service.start()
  await service.close()
  await service.start()
  assert.equal(signals.length, 2)
  assert.equal(signals[0]!.aborted, true)
  assert.equal(signals[1]!.aborted, false, 'the second run gets a signal that is not already aborted')
  assert.equal(service.stopped, false)
  await service.close()
})

test('close returns even when a task stays parked, and says so', async () => {
  // A JavaScript promise cannot be cancelled the way an asyncio task can. A loop that ignored its
  // abort signal would make `close` wait forever, and a service that never finishes closing is worse
  // than one that names the task it could not stop.
  const diagnostics: string[] = []
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    session: {connect: () => Promise.resolve()} as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      events: () => emptyStream(),
      close: () => Promise.resolve(),
    },
    runtime: {
      ...queueOnlyOptions().runtime,
      // Deliberately ignores the signal.
      serve: () => new Promise<void>(() => undefined),
    },
    onDiagnostic: line => diagnostics.push(line),
  })
  await service.start()
  const started = Date.now()
  await service.close()
  assert.ok(Date.now() - started < 5_000, 'close must not wait forever')
  assert.equal(service.stopped, true)
  assert.equal(
    diagnostics.some(line => line.includes('shutdown_tasks_abandoned')),
    true,
    'a task that could not be stopped has to be reported, not hidden',
  )
})

test('a provider stream parked at shutdown does not hold close open', async () => {
  // The normal shutdown case: the provider has nothing to say and the iterator is suspended. It gets
  // the stop signal precisely so it can unpark itself.
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    session: {connect: () => Promise.resolve()} as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      events: (signal: AbortSignal) => parkedStream(signal),
      close: () => Promise.resolve(),
    },
    runtime: {
      ...queueOnlyOptions().runtime,
      serve: (signal: AbortSignal) => new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), {once: true})
      }),
    },
    onDiagnostic: () => undefined,
  })
  await service.start()
  const started = Date.now()
  await service.close()
  assert.ok(Date.now() - started < 5_000)
  assert.equal(service.stopped, true)
})

test('a provider close failure is raised, after every task has been dealt with', async () => {
  // A close that failed still has to leave the service disconnected and its tasks stopped, so the
  // failure is held and re-raised at the very end rather than short-circuiting the shutdown.
  let serveAborted = false
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    session: {connect: () => Promise.resolve()} as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      events: () => emptyStream(),
      close: () => Promise.reject(new Error('transport refused to close')),
    },
    runtime: {
      ...queueOnlyOptions().runtime,
      serve: (signal: AbortSignal) => new Promise<void>(resolve => {
        signal.addEventListener('abort', () => {
          serveAborted = true
          resolve()
        }, {once: true})
      }),
    },
    onDiagnostic: () => undefined,
  })
  await service.start()
  await assert.rejects(() => service.close(), /transport refused to close/u)
  assert.equal(service.stopped, true, 'still stopped')
  assert.equal(serveAborted, true, 'the runtime task was still aborted')
})

/** A stream that ends immediately, which the receive loop treats as a provider that is gone. */
async function* emptyStream(): AsyncGenerator<never> {
  // Nothing to yield.
}

/** A stream that yields nothing and stays suspended until the stop signal fires. */
async function* parkedStream(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise<void>(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), {once: true})
  })
}

/**
 * An end-to-end pass through the pipeline, against a real session.
 *
 * The parity scenarios above cover ordering, and the lifecycle tests cover the loops. Neither exercises
 * the thing the pipeline exists for: a user turn arriving, a tool call being admitted against it, and
 * the batch that speaks about the result. That is what these do.
 */
function pipelineService(options: {
  readonly toolResult?: {readonly accepted: boolean; readonly delegateId: string | null}
} = {}): {
  readonly service: RealtimeService
  readonly actions: string[]
  readonly session: RealtimeSession
} {
  const manifest = executorManifestSchema.parse({
    name: 'codex',
    policy: {
      channel: 'codex',
      priority: 50,
      wake: 'fast',
      typical_latency: 5,
      compress_watermark: 8,
    },
    ops: [
      {
        name: 'start',
        description: 'begin work',
        params: {
          type: 'object',
          properties: {work_order: {type: 'string', minLength: 1, maxLength: 4_000}},
          required: ['work_order'],
          additionalProperties: false,
        },
        deadline_budget: 30,
      },
      {
        name: 'status',
        description: 'read status',
        params: {type: 'object', properties: {}, additionalProperties: false},
        readonly: true,
        deadline_budget: 5,
      },
    ],
  })
  const clock = new VirtualClock()
  const memory = new Memory({policies: [manifest.policy]})
  const executors = new Map([[manifest.name, {manifest}]])
  const actions: string[] = []
  let idSeq = 0
  const nextId = (): string => {
    idSeq += 1
    return `id-${idSeq}`
  }
  const playback = new PlaybackRegistry({
    idFactory: nextId,
    onFrame: () => undefined,
    onClear: (utteranceId, generationEpoch) => {
      actions.push(`clear:${utteranceId}:${generationEpoch}`)
    },
    onAlert: () => undefined,
  })
  const provider: SessionProvider & ServiceProvider = {
    connect: () => {
      actions.push('connect')
      return Promise.resolve({epoch: 1})
    },
    injectHostItem: (item) => {
      actions.push(`inject:${item.event_id}`)
      return Promise.resolve({session_epoch: 1, host_item_id: item.host_item_id})
    },
    createResponse: (intent) => {
      actions.push(`create_response:${intent.kind}`)
      return Promise.resolve()
    },
    cancelResponse: (responseId) => {
      actions.push(`cancel:${responseId}`)
      return Promise.resolve()
    },
    sendAudio: () => Promise.resolve(),
    events: () => emptyStream(),
    close: () => {
      actions.push('close')
      return Promise.resolve()
    },
  }
  const session = new RealtimeSession({
    provider,
    playback,
    idFactory: nextId,
    clock,
    onDiagnostic: () => undefined,
  })
  const scripted = options.toolResult ?? {accepted: true, delegateId: 'd-1'}
  let ingested = 0
  const service = new RealtimeService({
    provider,
    runtime: {
      clock,
      executors,
      observe: () => unsubscribeNothing,
      serve: (signal: AbortSignal) => new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), {once: true})
      }),
    },
    tools: compileToolSchema([manifest]),
    session,
    bridge: new RealtimeRuntimeBridge({
      runtime: {
        clock,
        memory,
        executors,
        ingestUserInput: (input: {readonly text: string}) => {
          ingested += 1
          const item = memory.append('conversation', {
            ts: ingested,
            trust: 'trusted_user',
            priority: 100,
            content: {text: input.text},
          })
          return Promise.resolve(`${item.channel}:${item.seq}`)
        },
        updateExternal: () => true,
        dispatchExternal: () => ({
          accepted: scripted.accepted,
          delegate_id: scripted.delegateId,
        }),
      },
      tools: compileToolSchema([manifest]),
      idFactory: nextId,
    }),
    idFactory: nextId,
    onDiagnostic: () => undefined,
  })
  return {service, actions, session}
}

test('a tool call is admitted against the user turn that justifies it', async () => {
  const {service, actions, session} = pipelineService()
  await service.connect()

  // The user speaks, then their transcript lands, then the model calls a tool in response.
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  // The user has to stop speaking first: while they hold the floor a response is refused and
  // cancelled outright, which is the session's barge-in guard rather than anything this layer decides.
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-item-1',
    name: 'codex__start',
    arguments: {work_order: 'compile the runtime'},
    response_id: 'r-1',
  })

  const admitted = service.toolCallAcceptances()
  assert.equal(admitted.length, 1, 'exactly one call admitted')
  assert.equal(admitted[0]!.acceptance.accepted, true)
  assert.equal(admitted[0]!.acceptance.delegate_id, 'd-1')
  assert.equal(admitted[0]!.call_id, 'call-1')
  // The delegate is registered on the session, which is what makes the work visible to the model.
  assert.equal(session.snapshot().active_delegates.length, 1)
  assert.equal(service.codexState, 'running', 'the renderer is told Codex is working')

  // The response ends, so the batch becomes ready and the tool result reaches the provider.
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-1',
    status: 'completed',
    reason: '',
  })
  assert.ok(
    actions.some(action => action.startsWith('create_response:')),
    'a continuation turn was requested for the finished work',
  )
})

test('a tool call arriving before its transcript waits, then runs', async () => {
  // The provider can finish a function call before emitting the turn's transcript final. Handling it
  // immediately would bind it to the *previous* user turn -- the citation the origin check exists to
  // stop -- so it waits, and the transcript releases it.
  const {service} = pipelineService()
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  // The user has to stop speaking first: while they hold the floor a response is refused and
  // cancelled outright, which is the session's barge-in guard rather than anything this layer decides.
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-item-1',
    name: 'codex__start',
    arguments: {work_order: 'compile the runtime'},
    response_id: 'r-1',
  })
  assert.equal(service.toolCallAcceptances().length, 0, 'held, not admitted')

  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  const admitted = service.toolCallAcceptances()
  assert.equal(admitted.length, 1, 'the transcript released it')
  assert.equal(admitted[0]!.acceptance.accepted, true)
})

test('a failed transcript releases the calls waiting on it rather than stranding them', async () => {
  // The transcript will never arrive, so anything waiting is waiting forever. The calls still need an
  // answer: the bridge refuses them for want of evidence, which the provider can render.
  const {service} = pipelineService()
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  // The user has to stop speaking first: while they hold the floor a response is refused and
  // cancelled outright, which is the session's barge-in guard rather than anything this layer decides.
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-item-1',
    name: 'codex__start',
    arguments: {work_order: 'compile the runtime'},
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_failed',
    session_epoch: 1,
    item_id: 'user-item-1',
  })
  const admitted = service.toolCallAcceptances()
  assert.equal(admitted.length, 1, 'answered rather than stranded')
  assert.equal(admitted[0]!.acceptance.accepted, false)
  assert.equal(admitted[0]!.acceptance.code, 'missing_origin_ref')
})

test('a runtime rejection is recorded as a refusal the provider can see', async () => {
  const {service} = pipelineService({toolResult: {accepted: false, delegateId: null}})
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  // The user has to stop speaking first: while they hold the floor a response is refused and
  // cancelled outright, which is the session's barge-in guard rather than anything this layer decides.
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-item-1',
    name: 'codex__start',
    arguments: {work_order: 'compile the runtime'},
    response_id: 'r-1',
  })
  const admitted = service.toolCallAcceptances()
  assert.equal(admitted.length, 1)
  assert.equal(admitted[0]!.acceptance.accepted, false)
  assert.equal(admitted[0]!.acceptance.code, 'runtime_rejected')
  assert.equal(service.codexState, 'idle', 'nothing was dispatched, so nothing is running')
})

test('a replayed user-start cannot put a spent origin back in the queue', async () => {
  // The evidence boundary. Once an item has a transcript it is spent; re-queueing it would let a
  // *later* response bind to a turn the user has moved past, and admit a tool call citing it. Three
  // guards, and this exercises the two that are easy to omit.
  const {service} = pipelineService()
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  // The item now has a transcript. A replayed start for it must be ignored.
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  // The original entry is still there -- nothing has claimed it -- but the replay must not have
  // added a second. Two copies would let two different responses each bind to the same spent turn.
  assert.equal(
    service.unboundUserOriginCountForTest,
    1,
    'the replay must not enqueue a second copy of a spent item',
  )

  // One response claims it, and the queue is empty afterwards.
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'r-1',
  })
  assert.equal(service.unboundUserOriginCountForTest, 0)

  // And a second response finds nothing to claim, so it cannot be handed the same turn.
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-1',
    status: 'completed',
    reason: '',
  })
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'r-2',
  })
  assert.equal(
    service.boundOriginCountForTest,
    1,
    'one response holds the turn; the second was not given a copy of it',
  )
})

test('an item already bound to a response cannot be queued again', async () => {
  const {service} = pipelineService()
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  // The response claims the item, emptying the unbound queue.
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'r-1',
  })
  assert.equal(service.unboundUserOriginCountForTest, 0, 'claimed by the response')
  // A replay while it is bound but before its transcript arrives.
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  assert.equal(
    service.unboundUserOriginCountForTest,
    0,
    'an item already bound to a response is not waiting for another',
  )
})

test('a task abandoned by one close cannot take down the next run', async () => {
  // A JavaScript promise cannot be cancelled, so a task the previous `close` gave up on can still
  // resolve later. Without scoping the guard to its own run it would read the *replacement*
  // controller, find it un-aborted, and stop a service that had already been restarted.
  const diagnostics: string[] = []
  let resolveStubborn: (() => void) | undefined
  const options = {
    ...queueOnlyOptions(),
    session: {connect: () => Promise.resolve()} as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      // Parked, not empty: a stream that ends is a provider that is gone, and the service is right to
      // stop for it -- which would mask what this test is about.
      events: (signal: AbortSignal) => parkedStream(signal),
      close: () => Promise.resolve(),
    },
    onDiagnostic: (line: string) => diagnostics.push(line),
  }
  let call = 0
  const service = new RealtimeService({
    ...options,
    runtime: {
      ...options.runtime,
      serve: (signal: AbortSignal) => {
        call += 1
        if (call === 1) {
          // Ignores the abort, then *fails* after the restart. A clean return from an aborted run is
          // an ordinary shutdown and correctly says nothing; a failure is what would otherwise be
          // charged to whichever run happens to be current.
          return new Promise<void>((_resolve, reject) => {
            resolveStubborn = () => reject(new Error('late failure from an abandoned run'))
          })
        }
        return new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), {once: true})
        })
      },
    },
  })
  await service.start()
  await service.close()
  await service.start()
  assert.equal(service.stopped, false, 'the second run is live')

  // The abandoned first task finishes now.
  resolveStubborn?.()
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  assert.equal(service.stopped, false, 'the previous run must not stop this one')
  assert.equal(
    diagnostics.some(line => line.includes('task_failure_from_previous_run')),
    true,
    'and it is recorded rather than silently ignored',
  )
  await service.close()
})

test('a provider close that never settles does not block shutdown', async () => {
  // The failure mode a degraded transport actually has. Bounding only the loops left this one able to
  // hold application shutdown open forever.
  const diagnostics: string[] = []
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    session: {connect: () => Promise.resolve()} as unknown as RealtimeSession,
    provider: {
      sendAudio: () => Promise.resolve(),
      events: () => emptyStream(),
      close: () => new Promise<void>(() => undefined),
    },
    runtime: {
      ...queueOnlyOptions().runtime,
      serve: (signal: AbortSignal) => new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), {once: true})
      }),
    },
    onDiagnostic: line => diagnostics.push(line),
  })
  await service.start()
  const started = Date.now()
  await service.close()
  assert.ok(Date.now() - started < 5_000, 'close must not wait on the transport forever')
  assert.equal(service.stopped, true)
  assert.equal(
    diagnostics.some(line => line.includes('shutdown_provider_close_abandoned')),
    true,
    'a transport that would not close has to be named',
  )
})
