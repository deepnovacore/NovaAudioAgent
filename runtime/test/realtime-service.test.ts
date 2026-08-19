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
import type { RealtimeSession } from '../src/realtime/session.js'
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
  // drive continuations looks exactly like one with nothing to drive.
  const service = queueOnlyService()
  assert.throws(() => service.projectRuntimeEvent({}, {
    kind: 'test',
    priority: 50,
    routing_class: 'user_awaited',
    origin: null,
    selected_suggestion: null,
  }), NotYetPortedError)
  await assert.rejects(() => service.driveContinuations(), NotYetPortedError)
  await assert.rejects(
    () => service.handleEvent({
      kind: 'response_cancel_rejected',
      session_epoch: 1,
      response_id: 'r-1',
      cancel_request_id: 'cancel-1',
      reason: 'no_active_response',
    }),
    NotYetPortedError,
  )
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
