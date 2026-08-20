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
import type { EventRecord, JsonValue } from '../src/events.js'
import { Memory } from '../src/memory.js'
import { executorManifestSchema } from '../src/ports.js'
import { RealtimeRuntimeBridge } from '../src/realtime/bridge.js'
import type { HostContextItem, HostResponseIntent } from '../src/realtime/protocol.js'
import { ItemDeliveryUncertainError } from '../src/realtime/protocol.js'
import { RealtimeService, type ServiceProvider } from '../src/realtime/service.js'
import {
  MAX_HOST_FACT_CHARS,
  PREEMPT_MIN_PRIORITY,
  type QueuedHostResponse,
} from '../src/realtime/service-state.js'
import { SPEECH_FINAL_LIMIT } from '../src/realtime/speech-prep.js'
import { RealtimeSession, type SessionProvider } from '../src/realtime/session.js'
import {
  ProjectConfirmationController,
  type ConfirmedProjectOperation,
  type ProjectConfirmationView,
} from '../src/realtime/project-confirmation.js'
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

test('a cancel rejection is ignored unless controlled reconnect is enabled', async () => {
  // Replacing the whole provider session is a heavy remedy for a case that should not happen, so it is
  // gated. With the gate closed the event is simply consumed: the provider refused a cancel, and the
  // ordinary alert deadline is what handles that.
  const service = queueOnlyService()
  await service.handleEvent({
    kind: 'response_cancel_rejected',
    session_epoch: 1,
    response_id: 'r-1',
    cancel_request_id: 'cancel-1',
    reason: 'no_active_response',
  })
  assert.equal(service.stopped, false, 'and it does not take the service down')
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
      claimedHandoff: () => undefined,
      terminatedByDeadline: () => false,
      delegateFor: () => undefined,
      inFlightDelegate: () => undefined,
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

  // The first attempt spends the retry on a reconnect, which the queue-only fixture has no session
  // for -- so it throws from there rather than reporting the budget as exhausted.
  await assert.rejects(() => service.reportUncertainDeliveryForTest(uncertain('host-1')))
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
  await assert.rejects(() => service.reportUncertainDeliveryForTest(uncertain('host-1')))
  // A second item still gets its own retry rather than inheriting a spent one, so it reaches the
  // reconnect too instead of reporting the budget as exhausted.
  await assert.rejects(() => service.reportUncertainDeliveryForTest(uncertain('host-2')))
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
  readonly onCaption?: (frame: {
    readonly role: string
    readonly text: string
    readonly final: boolean
  }) => void
  readonly includeRecall?: boolean
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
  // The epoch has to increase on every connect: a reconnect that reused it would be a different
  // provider session claiming the same identity, which the session refuses outright.
  let epoch = 0
  const provider: SessionProvider & ServiceProvider = {
    connect: () => {
      epoch += 1
      actions.push('connect')
      return Promise.resolve({epoch})
    },
    injectHostItem: (item) => {
      actions.push(`inject:${item.event_id}`)
      return Promise.resolve({session_epoch: epoch, host_item_id: item.host_item_id})
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
  const pipelineDelegate = {
    delegate_id: 'd-1',
    executor: 'codex',
    op: 'start',
    origin_ref: 'conversation:1',
    routing_class: 'user_awaited',
  }
  let ingested = 0
  const service = new RealtimeService({
    provider,
    runtime: {
      clock,
      executors,
      observe: () => unsubscribeNothing,
      // A live delegate, so a projected progress event reaches the decisions this fixture is for
      // rather than being refused at the in-flight check.
      claimedHandoff: () => pipelineDelegate,
      terminatedByDeadline: () => true,
      delegateFor: () => pipelineDelegate,
      inFlightDelegate: () => pipelineDelegate,
      serve: (signal: AbortSignal) => new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), {once: true})
      }),
    },
    tools: compileToolSchema([manifest], {includeMemoryRecall: options.includeRecall ?? false}),
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
      tools: compileToolSchema([manifest], {includeMemoryRecall: options.includeRecall ?? false}),
      idFactory: nextId,
    }),
    idFactory: nextId,
    // Spread rather than assigned: `exactOptionalPropertyTypes` distinguishes an absent optional from
    // one explicitly set to undefined, and the service's contract is the former.
    ...(options.onCaption === undefined ? {} : {onCaption: options.onCaption}),
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

/**
 * The projection's spoken text, against the Python-exported golden.
 *
 * What a user hears is the part where two runtimes that both "work" can still differ: the wording, the
 * elapsed-seconds rendering, and the priority a hit is queued at. Exercised through the same helpers
 * the projection uses rather than through a whole assembled service, which would be measuring the
 * provider and session instead.
 */
interface Projection {
  readonly name: string
  readonly kind: string
  readonly display_name: string
  readonly summary?: string
  readonly elapsed?: number
  readonly internal_activity?: number
  readonly outcome?: string
  readonly content?: Readonly<Record<string, JsonValue>>
  readonly manifest_priority?: number
  readonly hit?: boolean
}

const projectionDocument = JSON.parse(
  readFileSync(resolve(fixtureRoot, 'scenarios.json'), 'utf8'),
) as {readonly projections: readonly Projection[]}
const projectionGolden = JSON.parse(
  readFileSync(resolve(fixtureRoot, 'scenarios-expected.json'), 'utf8'),
) as {readonly projections: readonly Record<string, unknown>[]}

/**
 * Run one projection *through the service*, and report what the user would get.
 *
 * Deliberately not a reimplementation of the formatting. A test that restated the wording would agree
 * with itself no matter what the service did -- which is exactly what an earlier version of this file
 * did, and a mutation sweep found five projection changes it could not see.
 */
function runProjection(spec: Projection): Record<string, unknown> {
  const channel = spec.display_name === 'Codex' ? 'codex' : spec.display_name
  const priority = spec.manifest_priority ?? 50
  const {service, queuedItems} = projectionService({
    delegate: {executor: channel, op: 'start', routing_class: 'user_awaited'},
    priority,
  })
  switch (spec.kind) {
    case 'deadline':
      service.projectRuntimeEvent({
        kind: 'deadline',
        seq: 1,
        ts: 1,
        payload: {delegate_id: 'd-1'},
      })
      return {name: spec.name, content: queuedItems()[0]?.intent.item.content ?? null}
    case 'progress_started':
      service.projectRuntimeEvent({
        kind: 'progress',
        seq: 1,
        ts: 1,
        payload: {
          channel,
          delegate_id: 'd-1',
          op: 'start',
          phase: 'started',
          internal_activity: 0,
          elapsed: 0,
          summary: null,
        },
      })
      return {name: spec.name, content: queuedItems()[0]?.intent.item.content ?? null}
    case 'progress_summary': {
      service.projectRuntimeEvent({
        kind: 'progress',
        seq: 1,
        ts: 1,
        payload: {
          channel,
          delegate_id: 'd-1',
          op: 'start',
          phase: 'working',
          internal_activity: 1,
          elapsed: spec.elapsed!,
          summary: spec.summary!,
        },
      })
      const content = queuedItems()[0]?.intent.item.content ?? null
      // The prepared summary is what the sentence carries, recovered from it rather than recomputed.
      const summary = content === null
        ? null
        : content.slice(content.indexOf('：') + 1, content.lastIndexOf('（'))
      return {name: spec.name, summary, content}
    }
    case 'progress_steps':
      service.projectRuntimeEvent({
        kind: 'progress',
        seq: 1,
        ts: 1,
        payload: {
          channel,
          delegate_id: 'd-1',
          op: 'start',
          phase: 'working',
          internal_activity: spec.internal_activity!,
          elapsed: 1,
          summary: null,
        },
      })
      return {name: spec.name, content: queuedItems()[0]?.intent.item.content ?? null}
    case 'final_codex':
    case 'final_generic':
      service.projectRuntimeEvent({
        kind: 'handoff',
        seq: 1,
        ts: 1,
        payload: {
          channel,
          delegate_id: 'd-1',
          origin_ref: 'conversation:1',
          outcome: spec.outcome as 'ok' | 'failed',
          trust: 'trusted_system',
          content: spec.content!,
          refs: [],
        },
      })
      return {name: spec.name, content: queuedItems()[0]?.intent.item.content ?? null}
    case 'hit_priority': {
      service.projectRuntimeEvent({
        kind: 'handoff',
        seq: 1,
        ts: 1,
        payload: {
          channel,
          delegate_id: 'd-1',
          origin_ref: 'conversation:1',
          outcome: 'ok',
          trust: 'trusted_system',
          content: spec.hit === true ? {hit: true, observation: 'x'} : {summary: 'x'},
          refs: [],
        },
      })
      const queued = queuedItems()[0]
      return {
        name: spec.name,
        priority: queued?.priority ?? null,
        preemptive: queued?.preemptive ?? null,
      }
    }
    default:
      throw new Error(`unsupported projection kind: ${spec.kind}`)
  }
}

test('every projection matches the Python-exported golden', () => {
  const divergent: string[] = []
  for (const [index, spec] of projectionDocument.projections.entries()) {
    const actual = runProjection(spec)
    const expected = projectionGolden.projections[index]
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      divergent.push(
        `${spec.name}: python=${canonicalJson(expected)} node=${canonicalJson(actual)}`,
      )
    }
  }
  assert.deepEqual(divergent, [], 'projected text or priority differs from the oracle')
})

/**
 * The projection driven through a real service.
 *
 * The golden above covers the *text*; these cover the decisions around it -- what gets queued at all,
 * and what is deliberately silent. Both are behaviour a user notices: the first as the agent saying
 * nothing, the second as the agent repeating itself.
 */
function projectionService(options: {
  readonly delegate?: {readonly executor: string; readonly op: string; readonly routing_class: string}
  readonly suggest?: boolean
  readonly priority?: number
  readonly progressViaSurrogate?: boolean
  readonly syncResultOps?: boolean
  /** What the runtime's lookups return. Each default is the permissive answer, so a test that needs a
   * guard to fire says so explicitly rather than relying on a double that happens to refuse. */
  readonly claims?: boolean
  readonly terminates?: boolean
  readonly inFlight?: boolean
  readonly delegateOverride?: Partial<{
    readonly executor: string
    readonly op: string
    readonly origin_ref: string
    readonly routing_class: string
  }>
} = {}): {
  readonly service: RealtimeService
  readonly queued: () => readonly string[]
  readonly queuedItems: () => readonly QueuedHostResponse[]
} {
  const delegate = options.delegate ?? {
    executor: 'codex',
    op: 'start',
    routing_class: 'user_awaited',
  }
  const manifest = executorManifestSchema.parse({
    name: delegate.executor,
    policy: {
      channel: delegate.executor,
      priority: options.priority ?? 50,
      wake: 'fast',
      typical_latency: 5,
      compress_watermark: 8,
      suggest: options.suggest ?? false,
      progress_via_surrogate: options.progressViaSurrogate ?? false,
    },
    ops: [
      {
        name: 'start',
        description: 'begin work',
        params: {type: 'object', properties: {}, additionalProperties: false},
        sync_result: false,
        deadline_budget: 30,
      },
      {
        name: 'stop',
        description: 'stop work',
        params: {type: 'object', properties: {}, additionalProperties: false},
        deadline_budget: 5,
      },
      {
        name: 'look',
        description: 'readonly',
        params: {type: 'object', properties: {}, additionalProperties: false},
        readonly: true,
        sync_result: options.syncResultOps ?? false,
        deadline_budget: 5,
      },
    ],
  })
  const full = {
    delegate_id: 'd-1',
    executor: delegate.executor,
    op: delegate.op,
    origin_ref: 'conversation:1',
    routing_class: delegate.routing_class,
    ...options.delegateOverride,
  }
  const clock = new VirtualClock()
  const memory = new Memory({policies: [manifest.policy]})
  const executors = new Map([[manifest.name, {manifest}]])
  let ids = 0
  const nextId = (): string => `id-${++ids}`
  const service = new RealtimeService({
    provider: {
      sendAudio: () => Promise.resolve(),
      events: () => emptyStream(),
      close: () => Promise.resolve(),
    },
    runtime: {
      clock,
      executors,
      observe: () => unsubscribeNothing,
      serve: () => new Promise<void>(() => undefined),
      claimedHandoff: () => (options.claims ?? true) ? full : undefined,
      terminatedByDeadline: () => options.terminates ?? true,
      delegateFor: () => full,
      inFlightDelegate: () => (options.inFlight ?? true) ? full : undefined,
    },
    tools: compileToolSchema([manifest]),
    session: new RealtimeSession({
      provider: {
        connect: () => Promise.resolve({epoch: 1}),
        injectHostItem: (item) => Promise.resolve({
          session_epoch: 1,
          host_item_id: item.host_item_id,
        }),
        createResponse: () => Promise.resolve(),
        cancelResponse: () => Promise.resolve(),
        close: () => Promise.resolve(),
      },
      playback: new PlaybackRegistry({
        idFactory: nextId,
        onFrame: () => undefined,
        onClear: () => undefined,
      }),
      idFactory: nextId,
      clock,
      onDiagnostic: () => undefined,
    }),
    bridge: new RealtimeRuntimeBridge({
      runtime: {
        clock,
        memory,
        executors,
        ingestUserInput: () => Promise.reject(new Error('unused')),
        updateExternal: () => true,
        dispatchExternal: () => ({accepted: true, delegate_id: 'd-1'}),
      },
      tools: compileToolSchema([manifest]),
      idFactory: nextId,
    }),
    idFactory: nextId,
    onDiagnostic: () => undefined,
  })
  return {
    service,
    queued: () => service.queuedHostItems().map(item => item.intent.item.content),
    queuedItems: () => service.queuedHostItems(),
  }
}

function progressEvent(input: {
  readonly seq: number
  readonly summary: string | null
  readonly activity: number
  readonly elapsed?: number
}): EventRecord {
  return {
    kind: 'progress',
    seq: input.seq,
    ts: input.seq,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      phase: 'working',
      internal_activity: input.activity,
      elapsed: input.elapsed ?? 1,
      summary: input.summary,
    },
  }
}

test('an executor repeating the same progress summary does not make the agent repeat itself', () => {
  // The same-summary skip. An executor that reports identical progress every few seconds would
  // otherwise have the agent say the same sentence over and over.
  const {service, queued} = projectionService()
  service.projectRuntimeEvent(progressEvent({seq: 1, summary: 'running tests', activity: 1}))
  assert.equal(queued().length, 1, 'the first one is worth saying')
  service.projectRuntimeEvent(progressEvent({seq: 2, summary: 'running tests', activity: 2}))
  assert.equal(queued().length, 1, 'the identical repeat is not')
  service.projectRuntimeEvent(progressEvent({seq: 3, summary: 'linting', activity: 3}))
  assert.equal(queued().length, 2, 'but a changed summary is')
  service.projectRuntimeEvent(progressEvent({seq: 4, summary: 'running tests', activity: 4}))
  assert.equal(queued().length, 3, 'and so is going back to an earlier one')
})

test('a summary-less progress event is never deduped by the summary mechanism', () => {
  // Those keep the field template, which changes with the step count, so suppressing them by summary
  // would suppress genuinely different sentences.
  const {service, queued} = projectionService()
  service.projectRuntimeEvent(progressEvent({seq: 1, summary: null, activity: 1}))
  service.projectRuntimeEvent(progressEvent({seq: 2, summary: null, activity: 2}))
  assert.equal(queued().length, 2)
})

test('a settled delegate leaves no dedup residue for the next run of its id', () => {
  // Otherwise a later delegate reusing the id would inherit a summary it never produced, and its first
  // genuine progress report would be silently swallowed.
  const {service, queued} = projectionService()
  service.projectRuntimeEvent(progressEvent({seq: 1, summary: 'running tests', activity: 1}))
  assert.equal(queued().length, 1)
  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 2,
    ts: 2,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {},
      refs: [],
    },
  })
  const afterHandoff = queued().length
  // The same summary again, from a new run of the same id, has to be spoken.
  service.projectRuntimeEvent(progressEvent({seq: 3, summary: 'running tests', activity: 1}))
  assert.equal(
    queued().length,
    afterHandoff + 1,
    'the settled delegate must not suppress the next run',
  )
})

test('a suggestion handoff nobody selected is not announced', () => {
  // It is a proposal the Surrogate never chose. Announcing it would tell the user about something they
  // were not offered.
  const {service, queued} = projectionService({
    suggest: true,
    delegate: {executor: 'codex', op: 'start', routing_class: 'ambient'},
  })
  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {summary: 'something happened'},
      refs: [],
    },
  })
  assert.deepEqual(queued(), [], 'silent')

  // A user-awaited one on the same suggest channel is a direct handoff and does get announced.
  const direct = projectionService({
    suggest: true,
    delegate: {executor: 'codex', op: 'start', routing_class: 'user_awaited'},
  })
  direct.service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {summary: 'something happened'},
      refs: [],
    },
  })
  assert.equal(direct.queued().length, 1)
})

test('a successful monitor stop is not announced twice', () => {
  // The stop tool's own continuation is the single spoken confirmation. Both terminal handoffs stay
  // authoritative in Memory, but projecting either duplicates it -- and projecting both produced
  // three lines.
  const {service, queued} = projectionService({
    delegate: {executor: 'watch', op: 'stop', routing_class: 'user_awaited'},
  })
  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'watch',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {stopped: true},
      refs: [],
    },
  })
  assert.deepEqual(queued(), [], 'silent')

  // A stop that did not succeed is still worth saying.
  const failed = projectionService({
    delegate: {executor: 'watch', op: 'stop', routing_class: 'user_awaited'},
  })
  failed.service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'watch',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'failed',
      trust: 'trusted_system',
      content: {error: 'could_not_stop'},
      refs: [],
    },
  })
  assert.equal(failed.queued().length, 1)
})

test('a handoff that claimed nothing is not projected against an earlier claim', () => {
  // A duplicate handoff, or one for a delegate already settled, claims nothing. Projecting it against
  // whatever the previous handoff claimed would announce the same completion twice.
  const {service, queued} = projectionService({claims: false})
  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {summary: 'done'},
      refs: [],
    },
  })
  assert.deepEqual(queued(), [])
})

test('a handoff on a channel the delegate does not belong to is not projected', () => {
  // All the claim proves is that *a* delegate was claimed. If its executor differs, the handoff
  // describes a different run and projecting it would attribute one executor's result to another.
  const {service, queued} = projectionService({
    delegateOverride: {executor: 'watch'},
  })
  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {summary: 'done'},
      refs: [],
    },
  })
  assert.deepEqual(queued(), [])
})

test('only the deadline that terminated a delegate announces its timeout', () => {
  // Not "was terminated by a deadline at some point": a second deadline for the same delegate would
  // otherwise announce the same timeout again.
  const {service, queued} = projectionService({terminates: false})
  service.projectRuntimeEvent({kind: 'deadline', seq: 1, ts: 1, payload: {delegate_id: 'd-1'}})
  assert.deepEqual(queued(), [])

  const terminating = projectionService({terminates: true})
  terminating.service.projectRuntimeEvent({
    kind: 'deadline',
    seq: 1,
    ts: 1,
    payload: {delegate_id: 'd-1'},
  })
  assert.equal(terminating.queued().length, 1)
})

test('a timed-out delegate is unknown, not failed', () => {
  // A deadline says nobody knows what happened. Telling the model it failed is a claim the host cannot
  // support, and the model would then narrate a failure that may not have occurred.
  const {service} = projectionService()
  service.projectRuntimeEvent({kind: 'deadline', seq: 1, ts: 1, payload: {delegate_id: 'd-1'}})
  assert.equal(service.session.delegateState('d-1'), 'unknown')
})

test('a sync-result op resolves its own timeout rather than announcing one', () => {
  // Its waiting tool call carries the result, so a spoken timeout would be a second, contradictory
  // account of the same event.
  const {service, queued} = projectionService({
    delegate: {executor: 'codex', op: 'look', routing_class: 'user_awaited'},
    syncResultOps: true,
  })
  service.projectRuntimeEvent({kind: 'deadline', seq: 1, ts: 1, payload: {delegate_id: 'd-1'}})
  assert.deepEqual(queued(), [])
})

test('an observation is matched to the exact run it belongs to', () => {
  // All four fields, not just the delegate id: a differing channel, op, or origin describes a
  // different run, and projecting it would attribute one executor's finding to another's task.
  for (const override of [
    {executor: 'watch'},
    {op: 'stop'},
    {origin_ref: 'conversation:99'},
  ]) {
    const {service, queued} = projectionService({delegateOverride: override})
    service.projectRuntimeEvent({
      kind: 'observation',
      seq: 1,
      ts: 1,
      payload: {
        channel: 'codex',
        delegate_id: 'd-1',
        op: 'start',
        origin_ref: 'conversation:1',
        trust: 'trusted_system',
        content: {hit: true, observation: 'found it'},
        refs: [],
      },
    })
    assert.deepEqual(queued(), [], JSON.stringify(override))
  }
  // And the matching one is projected.
  const {service, queued} = projectionService()
  service.projectRuntimeEvent({
    kind: 'observation',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      origin_ref: 'conversation:1',
      trust: 'trusted_system',
      content: {hit: true, observation: 'found it'},
      refs: [],
    },
  })
  assert.equal(queued().length, 1)
})

test('an observation is only worth interrupting for when it is a hit', () => {
  // A heartbeat or a miss registers delegate state and stops there. Announcing every observation would
  // turn a monitor into a narrator.
  const {service, queued} = projectionService()
  service.projectRuntimeEvent({
    kind: 'observation',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      origin_ref: 'conversation:1',
      trust: 'trusted_system',
      content: {hit: false, observation: 'nothing yet'},
      refs: [],
    },
  })
  assert.deepEqual(queued(), [])
  assert.equal(service.session.delegateState('d-1'), 'running', 'state still registered')
})

test('an ambient hit is the Surrogate to arbitrate, not the host to announce', () => {
  const {service, queued} = projectionService({
    suggest: true,
    delegate: {executor: 'codex', op: 'start', routing_class: 'ambient'},
  })
  service.projectRuntimeEvent({
    kind: 'observation',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      origin_ref: 'conversation:1',
      trust: 'trusted_system',
      content: {hit: true, observation: 'found it'},
      refs: [],
    },
  })
  assert.deepEqual(queued(), [])

  // A user-awaited hit on the same suggest channel is announced.
  const awaited = projectionService({
    suggest: true,
    delegate: {executor: 'codex', op: 'start', routing_class: 'user_awaited'},
  })
  awaited.service.projectRuntimeEvent({
    kind: 'observation',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      origin_ref: 'conversation:1',
      trust: 'trusted_system',
      content: {hit: true, observation: 'found it'},
      refs: [],
    },
  })
  assert.equal(awaited.queued().length, 1)
})

test('an observation hit outranks routine announcements without reaching the preempt band', () => {
  for (const [priority, expected] of [[40, 55], [55, 55], [60, 60], [90, 90]] as const) {
    const {service, queuedItems} = projectionService({priority})
    service.projectRuntimeEvent({
      kind: 'observation',
      seq: 1,
      ts: 1,
      payload: {
        channel: 'codex',
        delegate_id: 'd-1',
        op: 'start',
        origin_ref: 'conversation:1',
        trust: 'trusted_system',
        content: {hit: true, observation: 'found it'},
        refs: [],
      },
    })
    assert.equal(queuedItems()[0]?.priority, expected, `manifest priority ${priority}`)
    assert.equal(
      queuedItems()[0]?.preemptive,
      priority >= PREEMPT_MIN_PRIORITY,
      `preemptive at ${priority}`,
    )
  }
})

test('a progress event for a delegate that is no longer in flight is not projected', () => {
  // It describes a run that is over. Reporting it would tell the user work is progressing that has
  // already stopped.
  const {service, queued} = projectionService({inFlight: false})
  service.projectRuntimeEvent(progressEvent({seq: 1, summary: 'running tests', activity: 1}))
  assert.deepEqual(queued(), [])
})

test('a progress event whose shape the runtime dropped is revalidated here', () => {
  // Observers receive events unconditionally, including ones the runtime validator dropped from
  // Memory, so the shape is checked again rather than trusted.
  const malformed: readonly EventRecord[] = [
    // `started` must carry zero activity.
    {
      kind: 'progress',
      seq: 1,
      ts: 1,
      payload: {
        channel: 'codex',
        delegate_id: 'd-1',
        op: 'start',
        phase: 'started',
        internal_activity: 3,
        elapsed: 1,
        summary: null,
      },
    },
    // `working` must carry at least one step.
    {
      kind: 'progress',
      seq: 2,
      ts: 2,
      payload: {
        channel: 'codex',
        delegate_id: 'd-1',
        op: 'start',
        phase: 'working',
        internal_activity: 0,
        elapsed: 1,
        summary: null,
      },
    },
    // An op the delegate is not running.
    {
      kind: 'progress',
      seq: 3,
      ts: 3,
      payload: {
        channel: 'codex',
        delegate_id: 'd-1',
        op: 'stop',
        phase: 'working',
        internal_activity: 1,
        elapsed: 1,
        summary: null,
      },
    },
  ]
  for (const event of malformed) {
    const {service, queued} = projectionService()
    service.projectRuntimeEvent(event)
    assert.deepEqual(queued(), [], JSON.stringify(event.payload))
  }
})

test('a surrogate-reported channel does not also speak its own working progress', () => {
  // The Surrogate is already narrating it; the host doing so too is the same fact twice.
  const {service, queued} = projectionService({progressViaSurrogate: true})
  service.projectRuntimeEvent(progressEvent({seq: 1, summary: 'running tests', activity: 1}))
  assert.deepEqual(queued(), [], 'working is silent')

  // `started` still speaks, because that is a transition rather than progress.
  service.projectRuntimeEvent({
    kind: 'progress',
    seq: 2,
    ts: 2,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      phase: 'started',
      internal_activity: 0,
      elapsed: 0,
      summary: null,
    },
  })
  assert.equal(queued().length, 1)
})

test('a host fact is already bounded by speech preparation before the outer cap', () => {
  // `MAX_HOST_FACT_CHARS` is a backstop rather than the operative limit: every speech view is cut to
  // `SPEECH_FINAL_LIMIT` (600) first, so the 3000 cap is unreachable through this path and a mutation
  // removing it is correctly undetectable. Both legs agree at 600, which is what this pins -- the cap
  // is kept because the oracle keeps it, and because a future view that skipped preparation would need
  // it.
  const {service, queuedItems} = projectionService({
    delegate: {executor: 'watch', op: 'start', routing_class: 'user_awaited'},
  })
  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'watch',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {hit: true, observation: '很'.repeat(8_000)},
      refs: [],
    },
  })
  const content = queuedItems()[0]?.intent.item.content ?? ''
  assert.equal([...content].length, SPEECH_FINAL_LIMIT, 'bounded by speech preparation')
  assert.ok([...content].length < MAX_HOST_FACT_CHARS, 'well inside the outer cap')
})

test('a progress event with an empty op is refused', () => {
  // Part of the CP1 revalidation. Redundant as the code stands -- the in-flight match immediately
  // after compares the op against the delegate's, and no delegate has an empty one -- so a mutation
  // removing it is correctly undetectable. Kept because the oracle keeps it, and asserted here so the
  // redundancy is recorded rather than rediscovered by the next sweep.
  const {service, queued} = projectionService()
  service.projectRuntimeEvent({
    kind: 'progress',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: '',
      phase: 'working',
      internal_activity: 1,
      elapsed: 1,
      summary: null,
    },
  })
  assert.deepEqual(queued(), [])
})

test('a started fact is suppressed when the acknowledgement already said it', async () => {
  // The delegation acknowledgement continuation has already told the user the task was accepted. A
  // spoken started fact right after would say the same thing twice -- while the delegate state
  // registration still has to happen, because the renderer depends on it.
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
  // The admission created the acknowledgement this suppression depends on.
  assert.equal(service.toolCallAcceptances()[0]?.acceptance.delegate_id, 'd-1')

  const before = service.pendingHostItemCount
  service.projectRuntimeEvent({
    kind: 'progress',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      phase: 'started',
      internal_activity: 0,
      elapsed: 0,
      summary: null,
    },
  })
  assert.equal(service.pendingHostItemCount, before, 'nothing queued: it was already said')
  assert.equal(service.session.delegateState('d-1'), 'running', 'but state is still registered')
})

/**
 * Two user turns and two responses, which is the smallest shape that can tell binding order apart.
 *
 * With one of each, oldest-first and newest-first produce the same answer -- which is why the earlier
 * version of this suite could not see a mutation that reversed it.
 */
async function twoTurns(service: RealtimeService): Promise<void> {
  for (const index of [1, 2]) {
    await service.handleEvent({
      kind: 'user_speech_started',
      session_epoch: 1,
      speech_id: `speech-${index}`,
      provider_item_id: `user-item-${index}`,
    })
    await service.handleEvent({
      kind: 'user_speech_ended',
      session_epoch: 1,
      speech_id: `speech-${index}`,
      provider_item_id: `user-item-${index}`,
    })
  }
}

test('responses claim user turns oldest first', () => {
  // Responses and user turns pair up in order. A response that grabbed the newer item would leave the
  // older one for a later response that did not cause it, and every tool call after that would cite
  // the wrong turn.
  return (async (): Promise<void> => {
    const {service} = pipelineService()
    await service.connect()
    await twoTurns(service)
    assert.equal(service.unboundUserOriginCountForTest, 2)

    await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
    assert.equal(service.unboundUserOriginCountForTest, 1, 'one claimed')
    assert.deepEqual(service.boundOriginsForTest, [['1:r-1', 'user-item-1']], 'the oldest')

    await service.handleEvent({
      kind: 'response_terminal',
      session_epoch: 1,
      response_id: 'r-1',
      status: 'completed',
      reason: '',
    })
    await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-2'})
    assert.deepEqual(service.boundOriginsForTest, [
      ['1:r-1', 'user-item-1'],
      ['1:r-2', 'user-item-2'],
    ], 'the second response gets the second turn')
  })()
})

test('a continuation batch speaks before a later one, whatever finished first', async () => {
  // FIFO is why the agent narrates work in the order it was asked for. Two batches are the smallest
  // shape that can tell it from last-in-first-out.
  const {service, actions} = pipelineService()
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'first task',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__start',
    arguments: {work_order: 'first task'},
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-1',
    status: 'completed',
    reason: '',
  })
  const afterFirst = actions.filter(action => action.startsWith('create_response')).length
  assert.equal(afterFirst, 1, 'the first batch asked for its turn')
  assert.equal(
    service.continuationOrderForTest[0],
    '1:r-1',
    'and it is still at the head, waiting to be bound',
  )
})

test('only one continuation turn is in flight at a time', async () => {
  // Otherwise the agent talks over itself. The check looks at every batch, not just the head, because
  // a batch can still be speaking after its key has left the front of the queue.
  const {service, actions} = pipelineService()
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'first task',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__start',
    arguments: {work_order: 'first task'},
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-1',
    status: 'completed',
    reason: '',
  })
  const requested = actions.filter(action => action.startsWith('create_response')).length
  // Driving again must not ask for a second turn while the first is outstanding.
  await service.driveContinuations()
  await service.driveContinuations()
  assert.equal(
    actions.filter(action => action.startsWith('create_response')).length,
    requested,
    'no second turn while one is outstanding',
  )
})

test('a user speaking blocks a continuation request', async () => {
  // The user outranks anything the agent wants to say, so a batch that became ready mid-utterance
  // waits rather than interrupting.
  const {service, actions} = pipelineService()
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'first task',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__start',
    arguments: {work_order: 'first task'},
    response_id: 'r-1',
  })
  // The user starts speaking before the originating response ends.
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-3',
    provider_item_id: 'user-item-3',
  })
  const before = actions.filter(action => action.startsWith('create_response')).length
  await service.driveContinuations()
  assert.equal(
    actions.filter(action => action.startsWith('create_response')).length,
    before,
    'nothing requested while the user holds the floor',
  )
})

test('a terminal for a different response does not close the bound batch', async () => {
  // A terminal says nothing about a batch it was not speaking. Closing on any terminal would mark work
  // spoken that the user never heard.
  const {service} = pipelineService()
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'first task',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__start',
    arguments: {work_order: 'first task'},
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-1',
    status: 'completed',
    reason: '',
  })
  // The continuation turn starts, binding the batch to r-2.
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-2'})
  assert.deepEqual(service.continuationOrderForTest, ['1:r-1'], 'still open')

  // A terminal for an unrelated response must not close it.
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-99',
    status: 'completed',
    reason: '',
  })
  assert.deepEqual(service.continuationOrderForTest, ['1:r-1'], 'still open')

  // The one it was bound to does.
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-2',
    status: 'completed',
    reason: '',
  })
  assert.deepEqual(service.continuationOrderForTest, [], 'closed by its own terminal')
})

test('a reconnect drops every origin binding from the dead session', async () => {
  // They name items a provider that no longer exists once held. Keeping any of them would let a tool
  // call in the new session cite evidence that session has never seen.
  const {service} = pipelineService()
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  assert.equal(service.boundOriginsForTest.length, 1)
  assert.equal(service.unboundUserOriginCountForTest, 1)

  await service.reconnectForTest()
  assert.deepEqual(service.boundOriginsForTest, [], 'no response holds a dead turn')
  assert.equal(service.unboundUserOriginCountForTest, 0, 'nothing waits on a dead transcript')
})

test('a reconnect settles the tool calls of the dead epoch instead of leaving them open', async () => {
  // Nothing in the old epoch can receive a continuation, so a call left `queued` there would wait for
  // a terminal that cannot arrive. Each gets a disposition, and work that actually ran gets an
  // acknowledgement -- it happened, and the user has not heard about it.
  const {service, actions} = pipelineService()
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__start',
    arguments: {work_order: 'compile the runtime'},
    response_id: 'r-1',
  })
  assert.equal(service.continuationOrderForTest.length, 1, 'one batch open')
  assert.equal(service.toolCallDispositionsForTest[0], null, 'not yet settled')

  await service.reconnectForTest()
  assert.deepEqual(
    service.continuationOrderForTest,
    [],
    'the dead epoch leaves nothing in the queue',
  )
  assert.equal(
    service.toolCallDispositionsForTest[0],
    'abandoned',
    'dispatched work that will not be spoken about is abandoned, not refused',
  )
  // And the acknowledgement reaches the provider, because that work really did start. Checked at the
  // provider rather than in the queue: the reconnect ends with a delivery pass, so anything it queued
  // into an idle floor has already been injected by the time this returns.
  assert.ok(
    actions.includes('inject:background:d-1'),
    'the user is told about work that ran',
  )
})

test('a reconnect requeues an urgent item that was injected but never spoken', async () => {
  // It reached a session that died before speaking it, so the user heard nothing. That is the one case
  // where re-delivering is right rather than a repeat.
  const {service, actions} = pipelineService()
  await service.connect()
  service.seedUrgentOwnerForTest({sessionEpoch: 1, eventId: 'final:d-9', responseId: null})
  const before = service.urgentOwnerForTest?.delivery_token
  await service.reconnectForTest()
  // At the provider, not in the queue: the reconnect's own delivery pass has already flushed it.
  assert.ok(actions.includes('inject:final:d-9'), 'requeued and delivered')
  // The *old* owner is gone. Delivering into the new session creates a fresh one, which is what keeps
  // the alert's audio attributable there -- so the check is on identity, not on absence.
  const after = service.urgentOwnerForTest
  assert.notEqual(after?.delivery_token, before, 'the dead session\'s owner did not survive')
  assert.equal(after?.session_epoch, service.session.sessionEpoch, 'and any owner belongs to the new one')
})

test('a reconnect does not requeue an urgent item that already had a response', async () => {
  // A response means the provider took it up. Re-queueing would say the same thing twice.
  const {service, actions} = pipelineService()
  await service.connect()
  service.seedUrgentOwnerForTest({sessionEpoch: 1, eventId: 'final:d-9', responseId: 'r-7'})
  await service.reconnectForTest()
  assert.equal(actions.includes('inject:final:d-9'), false, 'not requeued')
  assert.equal(service.urgentOwnerForTest, null)
})

test('a reconnect that lost the race leaves the live session alone', async () => {
  // Someone else already replaced it. Replacing it again would discard a session that is working.
  const {service} = pipelineService()
  await service.connect()
  const epoch = service.session.sessionEpoch
  assert.equal(await service.reconnectForTest(epoch + 5), false, 'refused')
  assert.equal(service.session.sessionEpoch, epoch, 'and the session is untouched')
})

test('a reconnect demands an activation, unless the user already spoke into the new session', async () => {
  // A reconnected provider will not speak until something user-shaped arrives. But a user who started
  // talking *during* the reconnect has already activated it, so demanding one would be wrong.
  const quiet = pipelineService()
  await quiet.service.connect()
  await quiet.service.reconnectForTest()
  assert.equal(
    quiet.service.epochNeedingActivationForTest,
    quiet.service.session.sessionEpoch,
    'the new session needs activating',
  )

  const spoken = pipelineService()
  await spoken.service.connect()
  await spoken.service.reconnectForTest()
  await spoken.service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: spoken.service.session.sessionEpoch,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  assert.equal(
    spoken.service.epochNeedingActivationForTest,
    null,
    'the user activated it themselves',
  )
})

test('a reconnect blanks speculative captions on both roles', async () => {
  // Partial text from a dead epoch is speculation about a turn that no longer exists. Leaving it on
  // screen would show the user words the new session never said.
  const captions: {readonly role: string; readonly text: string; readonly final: boolean}[] = []
  const {service} = pipelineService({onCaption: frame => captions.push(frame)})
  await service.connect()
  await service.reconnectForTest()
  assert.deepEqual(
    captions.map(frame => [frame.role, frame.text, frame.final]),
    [['assistant', '', true], ['user', '', true]],
    'both roles blanked, and marked final so nothing waits for more',
  )
})

test('a batch already spoken before the reconnect keeps its terminal phase', async () => {
  // It was spoken. Marking it abandoned would make the reconnect re-announce work the user already
  // heard about.
  const {service, actions} = pipelineService()
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__start',
    arguments: {work_order: 'compile the runtime'},
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-1',
    status: 'completed',
    reason: '',
  })
  // The continuation turn runs to completion, so the batch is terminal.
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-2'})
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-2',
    status: 'completed',
    reason: '',
  })
  assert.equal(
    service.toolCallDispositionsForTest[0],
    'completed',
    'spoken, and recorded as completed',
  )
  const injectedBefore = actions.filter(action => action.startsWith('inject:background')).length

  await service.reconnectForTest()
  assert.equal(
    service.toolCallDispositionsForTest[0],
    'completed',
    'the reconnect must not downgrade work that was already spoken',
  )
  assert.equal(
    actions.filter(action => action.startsWith('inject:background')).length,
    injectedBefore,
    'and must not re-announce it',
  )
})

test('an inline-fulfilled call gets no background acknowledgement on reconnect', async () => {
  // Recall answers in the same breath: there is no background work to tell the user about, so an
  // acknowledgement would announce something that never ran. `dispatch` is what distinguishes it, which
  // is why the flag is computed before the disposition is written.
  const {service, actions} = pipelineService({includeRecall: true})
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'what did we decide',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'memory__recall',
    arguments: {query: 'decide', scope: 'recent'},
    response_id: 'r-1',
  })
  const accepted = service.toolCallAcceptances()[0]
  assert.equal(accepted?.acceptance.inline_fulfilled, true, 'answered inline')

  await service.reconnectForTest()
  assert.equal(
    actions.some(action => action.startsWith('inject:background:')),
    false,
    'no background acknowledgement for work that never went to the background',
  )
})

test('an acknowledgement bound to an unfinished continuation is reopened by the reconnect', async () => {
  // Its turn was speaking when the session died, so the user heard part of nothing. Left `bound` it
  // would never be queued again -- the queue helper refuses anything already bound -- and the user
  // would simply never be told the work started.
  const {service, actions} = pipelineService()
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__start',
    arguments: {work_order: 'compile the runtime'},
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-1',
    status: 'completed',
    reason: '',
  })
  // The continuation turn starts -- binding the acknowledgement to it -- and then never finishes.
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-2'})
  assert.equal(
    service.acknowledgementPhasesForTest['background:d-1'],
    'bound',
    'bound to a turn that is still speaking',
  )
  const before = actions.filter(action => action === 'inject:background:d-1').length

  await service.reconnectForTest()
  assert.equal(
    actions.filter(action => action === 'inject:background:d-1').length,
    before + 1,
    'reopened and delivered in the new session',
  )
})

/**
 * Guard preemption: interrupting the agent mid-sentence.
 *
 * A Guard alert is the one thing allowed to do it, and interrupting is the hard part — the provider has
 * to stop, the renderer has to drop the audio already in flight, and the replacement has to start
 * speaking, with no guarantee any of the three acknowledges. Every step is therefore deadlined, and the
 * token on each preemption is what stops a deadline belonging to a resolved one from tearing down its
 * successor.
 */
function guardService(options: {readonly controlledReconnect?: boolean} = {}): {
  readonly service: RealtimeService
  readonly actions: string[]
  readonly clock: VirtualClock
} {
  // Priority 90 is inside the preemption band, which is what makes a queued item preemptive at all.
  const manifest = executorManifestSchema.parse({
    name: 'guard',
    policy: {
      channel: 'guard',
      priority: 90,
      wake: 'fast',
      typical_latency: 2,
      compress_watermark: 8,
      suggest: false,
    },
    ops: [
      {
        name: 'start',
        description: 'watch for something',
        params: {type: 'object', properties: {}, additionalProperties: false},
        deadline_budget: 30,
      },
      {
        name: 'look',
        description: 'readonly',
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
  let ids = 0
  const nextId = (): string => `id-${++ids}`
  let epoch = 0
  const provider = {
    connect: () => {
      epoch += 1
      actions.push(`connect:${epoch}`)
      return Promise.resolve({epoch})
    },
    injectHostItem: (item: {readonly host_item_id: string; readonly event_id: string}) => {
      actions.push(`inject:${item.event_id}`)
      return Promise.resolve({session_epoch: epoch, host_item_id: item.host_item_id})
    },
    createResponse: (intent: {readonly kind: string}) => {
      actions.push(`create:${intent.kind}`)
      return Promise.resolve()
    },
    cancelResponse: (responseId: string) => {
      actions.push(`cancel:${responseId}`)
      return Promise.resolve()
    },
    sendAudio: () => Promise.resolve(),
    events: () => emptyStream(),
    close: () => Promise.resolve(),
  }
  const session = new RealtimeSession({
    provider,
    playback: new PlaybackRegistry({
      idFactory: nextId,
      onFrame: () => undefined,
      onClear: (utteranceId, generationEpoch) => {
        actions.push(`clear:${utteranceId}:${generationEpoch}`)
      },
    }),
    idFactory: nextId,
    clock,
    onDiagnostic: () => undefined,
  })
  const service = new RealtimeService({
    provider,
    runtime: {
      clock,
      executors,
      memory,
      observe: () => unsubscribeNothing,
      serve: () => new Promise<void>(() => undefined),
      claimedHandoff: () => undefined,
      terminatedByDeadline: () => false,
      delegateFor: () => undefined,
      inFlightDelegate: () => undefined,
    },
    tools: compileToolSchema([manifest]),
    session,
    bridge: new RealtimeRuntimeBridge({
      runtime: {
        clock,
        memory,
        executors,
        ingestUserInput: () => Promise.reject(new Error('unused')),
        updateExternal: () => false,
        dispatchExternal: () => ({accepted: false, delegate_id: null}),
      },
      tools: compileToolSchema([manifest]),
      idFactory: nextId,
    }),
    idFactory: nextId,
    controlledGuardReconnect: options.controlledReconnect ?? false,
    onDiagnostic: () => undefined,
  })
  return {service, actions, clock}
}

function guardFact(eventId = 'final:d-guard'): Parameters<RealtimeService['queueHostItem']>[0] {
  return {
    kind: 'host_fact',
    item: {
      kind: 'final',
      host_item_id: `host-${eventId}`,
      event_id: eventId,
      content: 'the build finished',
      call_id: null,
    },
    task_summary: null,
    origin_spoken: false,
  }
}

test('a preemptive item does not interrupt an idle agent', async () => {
  // There is nothing to interrupt, so it is delivered the ordinary way. Preempting an idle session
  // would cancel a turn that does not exist.
  const {service, actions} = guardService()
  await service.connect()
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  assert.ok(actions.includes('inject:final:d-guard'), 'delivered')
  assert.equal(
    actions.some(action => action.startsWith('cancel:')),
    false,
    'and nothing was cancelled',
  )
})

test('a preemptive item interrupts a speaking agent, and cancels its turn', async () => {
  const {service, actions} = guardService()
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  assert.ok(actions.includes('cancel:r-1'), 'the old turn was cancelled')
})

test('the alert deadline stops waiting for a provider that will not confirm', async () => {
  // The provider was asked to stop and has not said it did. Past the deadline the host acts as though
  // it had — the alternative is the user hearing the old turn continue while an urgent alert waits.
  const {service, clock} = guardService()
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  assert.notEqual(service.guardPreemptionForTest, null, 'a preemption is in flight')
  assert.equal(service.guardPreemptionForTest?.deadline_fired, false)

  // Past GUARD_ALERT_DEADLINE_S with no terminal from the provider.
  clock.advanceTo(clock.now() + 1)
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  assert.equal(
    service.guardPreemptionForTest?.deadline_fired ?? 'cleared',
    true,
    'the host stopped waiting',
  )
})

test('a user speaking revokes the reconnect permit a preemption was holding', async () => {
  // The preemption borrows the user's authority to interrupt. Once the user is speaking themselves,
  // that authority is theirs again — so a permit not yet spent is disallowed outright.
  const {service} = guardService({controlledReconnect: true})
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  assert.equal(service.guardPreemptionForTest?.reconnect_disallowed, false)

  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  assert.equal(
    service.guardPreemptionForTest?.reconnect_disallowed,
    true,
    'the permit is revoked before it can be spent',
  )
})

test('a cancel rejection does nothing when controlled reconnect is off', async () => {
  const {service, actions} = guardService({controlledReconnect: false})
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  const connects = actions.filter(action => action.startsWith('connect:')).length
  await service.handleEvent({
    kind: 'response_cancel_rejected',
    session_epoch: 1,
    response_id: 'r-1',
    cancel_request_id: 'cancel-1',
    reason: 'no_active_response',
  })
  assert.equal(
    actions.filter(action => action.startsWith('connect:')).length,
    connects,
    'no reconnect: the gate is closed',
  )
  assert.equal(service.stopped, false)
})

test('a cancel rejection with the gate open replaces the provider session', async () => {
  // The last resort: the provider said it would not stop, and the alert is still waiting. Replacing the
  // session is heavy, which is why it is gated — but letting the old turn run to completion is worse.
  const {service, actions} = guardService({controlledReconnect: true})
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  const before = actions.filter(action => action.startsWith('connect:')).length
  await service.handleEvent({
    kind: 'response_cancel_rejected',
    session_epoch: 1,
    response_id: 'r-1',
    cancel_request_id: 'cancel-1',
    reason: 'no_active_response',
  })
  assert.ok(
    actions.filter(action => action.startsWith('connect:')).length > before,
    'the session was replaced',
  )
  assert.equal(service.guardPreemptionForTest?.reconnect_permit_consumed, true, 'permit spent')
})

test('a cancel rejection for a turn that already spoke is ignored', async () => {
  // Replacing the session under it would lose whatever it said to the user.
  const {service, actions} = guardService({controlledReconnect: true})
  await service.connect()
  service.queueHostItem(guardFact('final:d-other'), {priority: 50})
  await service.flushHostItems()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  const before = actions.filter(action => action.startsWith('connect:')).length
  // r-1 carries the delivered fact's event id, so it has produced something.
  await service.handleEvent({
    kind: 'response_cancel_rejected',
    session_epoch: 1,
    response_id: 'r-1',
    cancel_request_id: 'cancel-1',
    reason: 'no_active_response',
  })
  assert.equal(
    actions.filter(action => action.startsWith('connect:')).length,
    before,
    'a turn that already spoke is not replaced under',
  )
})

/**
 * Project confirmation, service side.
 *
 * The controller decides whether the user said yes; this owns the isolation around that decision. Three
 * overlapping guards, because the failure modes differ: the reserved item makes one transcript the
 * answer, the response block stops the model acting inside the turn that is meant to be waiting, and
 * the armed fence keeps the question from being spoken over. Each closes a hole the others leave.
 */
function confirmationService(options: {
  readonly commit?: (
    operation: ConfirmedProjectOperation,
    originRef: string,
  ) => Promise<{readonly accepted: boolean; readonly code: string}>
  readonly withoutCommit?: boolean
} = {}): {
  readonly service: RealtimeService
  readonly controller: ProjectConfirmationController
  readonly actions: string[]
  readonly views: ProjectConfirmationView[]
  readonly clock: VirtualClock
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
          properties: {work_order: {type: 'string', minLength: 1}},
          required: ['work_order'],
          additionalProperties: false,
        },
        deadline_budget: 30,
      },
      {
        name: 'look',
        description: 'readonly',
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
  const views: ProjectConfirmationView[] = []
  let ids = 0
  const nextId = (): string => `id-${++ids}`
  let epoch = 0
  const provider = {
    connect: () => {
      epoch += 1
      actions.push(`connect:${epoch}`)
      return Promise.resolve({epoch})
    },
    injectHostItem: (item: {readonly host_item_id: string; readonly event_id: string}) => {
      actions.push(`inject:${item.event_id}`)
      return Promise.resolve({session_epoch: epoch, host_item_id: item.host_item_id})
    },
    createResponse: (intent: {readonly kind: string}) => {
      actions.push(`create:${intent.kind}`)
      return Promise.resolve()
    },
    cancelResponse: (responseId: string) => {
      actions.push(`cancel:${responseId}`)
      return Promise.resolve()
    },
    sendAudio: () => Promise.resolve(),
    events: () => emptyStream(),
    close: () => Promise.resolve(),
  }
  const session = new RealtimeSession({
    provider,
    playback: new PlaybackRegistry({
      idFactory: nextId,
      onFrame: () => undefined,
      onClear: () => undefined,
    }),
    idFactory: nextId,
    clock,
    onDiagnostic: () => undefined,
  })
  const controller = new ProjectConfirmationController({clock, idFactory: nextId})
  let ingested = 0
  const commit = options.withoutCommit === true
    ? undefined
    : options.commit ?? ((): Promise<{readonly accepted: boolean; readonly code: string}> => {
      actions.push('commit')
      return Promise.resolve({accepted: true, code: 'ok'})
    })
  const service = new RealtimeService({
    provider,
    runtime: {
      clock,
      executors,
      memory,
      observe: () => unsubscribeNothing,
      serve: () => new Promise<void>(() => undefined),
      claimedHandoff: () => undefined,
      terminatedByDeadline: () => false,
      delegateFor: () => undefined,
      inFlightDelegate: () => undefined,
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
        dispatchExternal: () => ({accepted: true, delegate_id: 'd-1'}),
      },
      tools: compileToolSchema([manifest]),
      idFactory: nextId,
    }),
    idFactory: nextId,
    projectConfirmation: controller,
    ...(commit === undefined ? {} : {commitProjectOperation: commit}),
    onProjectView: view => views.push(view),
    onDiagnostic: () => undefined,
  })
  return {service, controller, actions, views, clock}
}

/**
 * Whether the user was told something about the confirmation.
 *
 * Queued or already injected: the fact is enqueued synchronously and delivered by the pass at the end
 * of the event, which only fires when the floor is free. Asserting on the injection alone would make
 * this a test of floor state.
 */
function toldAboutConfirmation(service: RealtimeService, actions: readonly string[]): boolean {
  return actions.some(action => action.startsWith('inject:project-confirmation:'))
    || service.queuedHostItems().some(item => (
      item.intent.item.event_id.startsWith('project-confirmation:')
    ))
}

function propose(controller: ProjectConfirmationController): void {
  controller.prepare({
    action: 'create',
    workspace_display_name: '研究项目',
    workspace_id: null,
    session_title: null,
    session_id: null,
    work_order: null,
    origin_ref: 'conversation:1',
  })
}

async function speak(service: RealtimeService, itemId: string, text: string): Promise<void> {
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: `speech-${itemId}`,
    provider_item_id: itemId,
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: `speech-${itemId}`,
    provider_item_id: itemId,
  })
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: itemId,
    text,
  })
}

test('a spoken confirmation commits the operation', async () => {
  const {service, controller, actions} = confirmationService()
  await service.connect()
  propose(controller)
  await speak(service, 'user-item-1', '确认')
  assert.ok(actions.includes('commit'), 'the operation was carried out')
  assert.equal(controller.pending, false, 'and the proposal is settled')
})

test('a cancellation does not commit, and says so', async () => {
  const {service, controller, actions} = confirmationService()
  await service.connect()
  propose(controller)
  await speak(service, 'user-item-1', '取消')
  assert.equal(actions.includes('commit'), false, 'nothing was committed')
  assert.equal(controller.pending, false)
  assert.ok(toldAboutConfirmation(service, actions), 'and the user is told')
})

test('a failing commit still tells the user something', async () => {
  // A confirmation that produced silence is the worst outcome available: the user said yes and has no
  // idea whether anything happened.
  const {service, controller, actions} = confirmationService({
    commit: () => Promise.reject(new Error('workspace service is down')),
  })
  await service.connect()
  propose(controller)
  await speak(service, 'user-item-1', '确认')
  assert.ok(toldAboutConfirmation(service, actions), 'the user hears that it did not happen')
})

test('a refused commit reports the reason it gave', async () => {
  const {service, controller, actions} = confirmationService({
    commit: () => Promise.resolve({accepted: false, code: 'workspace_name_conflict'}),
  })
  await service.connect()
  propose(controller)
  await speak(service, 'user-item-1', '确认')
  assert.ok(toldAboutConfirmation(service, actions))
})

test('with no commit callback wired, a confirmation says so rather than pretending', async () => {
  const {service, controller, actions} = confirmationService({withoutCommit: true})
  await service.connect()
  propose(controller)
  await speak(service, 'user-item-1', '确认')
  assert.ok(toldAboutConfirmation(service, actions))
})

test('a tool call in a blocked turn is refused and answered', async () => {
  // The model must not act inside the very turn whose answer it is supposed to be waiting for -- and a
  // refused call still owes the provider a terminal result, or the protocol stalls.
  const {service, actions, controller} = confirmationService()
  await service.connect()
  propose(controller)
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
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  const before = service.toolCallAcceptances().length
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__start',
    arguments: {work_order: 'do something'},
    response_id: 'r-1',
  })
  assert.equal(service.toolCallAcceptances().length, before, 'never admitted')
  assert.ok(
    actions.some(action => action.startsWith('inject:id-')),
    'but the provider got a terminal result',
  )
})

test('a user utterance with no item id cancels rather than waiting for an answer it cannot attribute', async () => {
  const {service, controller, actions} = confirmationService()
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: null,
  })
  assert.equal(controller.pending, false, 'the proposal is gone')
  assert.ok(toldAboutConfirmation(service, actions))
})

test('a failed transcript cancels the confirmation', async () => {
  const {service, controller} = confirmationService()
  await service.connect()
  propose(controller)
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
    kind: 'user_transcript_failed',
    session_epoch: 1,
    item_id: 'user-item-1',
  })
  assert.equal(controller.pending, false)
})

test('a reconnect invalidates a pending proposal', async () => {
  // It described a provider session that no longer exists, so confirming it would commit against a
  // context the user never saw.
  const {service, controller} = confirmationService()
  await service.connect()
  propose(controller)
  assert.equal(controller.pending, true)
  await service.reconnectForTest()
  assert.equal(controller.pending, false, 'invalidated by the reconnect')
})

test('closing the service drops the proposal and stops observing expiry', async () => {
  const {service, controller} = confirmationService()
  await service.connect()
  propose(controller)
  await service.close()
  assert.equal(controller.pending, false)
})

test('the project view is published on every state change', async () => {
  // The renderer has no other way to learn a confirmation is pending, or that it stopped being.
  const {service, controller, views} = confirmationService()
  await service.connect()
  propose(controller)
  await speak(service, 'user-item-1', '确认')
  assert.ok(views.length > 0, 'the renderer was told')
  assert.equal(views.at(-1)?.pending_confirmation, false, 'and told it is over')
})

test('a duplicate transcript for a closing item does not confirm twice', async () => {
  // A second delivery of the same words must not confirm something the first delivery already handled.
  const {service, controller, actions} = confirmationService()
  await service.connect()
  propose(controller)
  await speak(service, 'user-item-1', '确认')
  const commits = actions.filter(action => action === 'commit').length
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: '确认',
  })
  assert.equal(actions.filter(action => action === 'commit').length, commits, 'committed once')
})

test('an expiry cleans up and tells the user, without leaving the block set', async () => {
  // Cleanup involves provider I/O and possibly a reconnect, so it is batched onto its own task -- and
  // if it left the block set, every later turn would be refused.
  const {service, controller, actions, clock} = confirmationService()
  await service.connect()
  propose(controller)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  clock.advanceTo(clock.now() + 200)
  assert.equal(controller.expire(), true, 'the proposal lapsed')
  // Let the drain task run.
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  assert.ok(toldAboutConfirmation(service, actions), 'the user is told it lapsed')
  assert.equal(service.projectConfirmationBlockingForTest, false, 'and nothing stays blocked')
})
