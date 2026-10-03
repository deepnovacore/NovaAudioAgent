import type {TaskToolHost} from '../../src/core/task-tools.js'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import type {AgentController} from '../../src/executors/agent-controller.js'
import {VirtualClock} from '../../src/core/clock.js'
import type {AgentExecutor} from '../../src/executors/coding-executor.js'
import type {EventRecord, JsonValue} from '../../src/core/events.js'
import {HostApprovalController, type ApprovalResolution} from '../../src/core/approval.js'
import {
  CODEX_AGENT_SUMMARY,
  CODEX_PROJECT_APPROVAL_MANIFEST,
  CODEX_PROJECT_MANIFEST,
} from '../../src/executors/codex/contract.js'
import {CodexAgentController} from '../../src/executors/codex/controller.js'
import {type IntakeOptions} from '../../src/executors/coding/intake.js'
import {Memory} from '../../src/core/memory.js'
import {PlaybackRegistry} from '../../src/realtime/playback.js'
import {executorManifestSchema} from '../../src/core/ports.js'
import {
  ProjectConfirmationController,
  type ConfirmedProjectOperation,
  type ProjectConfirmationView,
} from '../../src/projects/project-confirmation.js'
import {
  RealtimeRuntimeBridge,
  type PersonalMemoryRecallPort,
  type ToolAcceptance,
} from '../../src/realtime/bridge.js'
import type {HostContextItem, HostResponseIntent, ResponseOrigin} from '../../src/realtime/protocol.js'
import {
  PREEMPT_MIN_PRIORITY,
  type QueuedHostResponse
} from '../../src/realtime/service-state.js'
import {RealtimeService, type ServiceProvider} from '../../src/realtime/service.js'
import {RealtimeSession, type SessionProvider} from '../../src/realtime/session.js'
import {compileToolSchema} from '../../src/core/tool-schema.js'

export const fixtureRoot = resolve(import.meta.dirname, '../../../../tests/fixtures/realtime/service/v1')

export interface Step {
  readonly kind: string
  readonly event_id?: string
  readonly priority?: number
  readonly preemptive?: boolean
  readonly at?: number
  readonly semantic_event_id?: string | null
  readonly guard_delegate_id?: string | null
  readonly source_epoch?: number
}

export interface Scenario {
  readonly name: string
  readonly covers: readonly string[]
  readonly steps: readonly Step[]
}

export const document = JSON.parse(readFileSync(resolve(fixtureRoot, 'scenarios.json'), 'utf8')) as {
  readonly scenarios: readonly Scenario[]
}

export const golden = JSON.parse(
  readFileSync(resolve(fixtureRoot, 'scenarios-expected.json'), 'utf8'),
) as {
  readonly constants: {readonly preempt_min_priority: number; readonly user_priority: number}
  readonly scenarios: readonly Record<string, unknown>[]
}

export function hostFact(eventId: string): HostResponseIntent {
  const item: HostContextItem = {
    kind: 'final',
    host_item_id: `host-${eventId}`,
    event_id: eventId,
    content: 'x',
    call_id: null,
  }
  return {kind: 'host_fact', item, task_summary: null, origin_spoken: false}
}

export function runScenario(scenario: Scenario): Record<string, unknown> {
  const service = realtimeServiceHarness('queue')
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
        preemptiveAlertDelegateId: step.guard_delegate_id ?? null,
      })
      result = {
        seq,
        effective_priority: Math.min(priority, golden.constants.user_priority - 1),
      }
    } else if (step.kind === 'pop') {
      result = describe(service.takeNextQueuedHostItem())
    } else if (step.kind === 'drain') {
      const drained: unknown[] = []
      for (; ;) {
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

export function describe(queued: QueuedHostResponse | undefined): unknown {
  if (queued === undefined) return null
  return {
    event_id: queued.intent.item.event_id,
    priority: queued.priority,
    preemptive: queued.preemptive,
    seq: queued.seq,
  }
}

/**
 * Options for a service with only the queue wired.
 *
 * The parity scenarios exercise ordering, and a fully assembled service would be measuring the
 * provider, session, and bridge instead. Everything unused throws if reached, so a scenario that
 * wandered outside the queue fails by name rather than silently exercising a double.
 */
export function queueOnlyOptions(): ConstructorParameters<typeof RealtimeService>[0] {
  const manifest = executorManifestSchema.parse({
    name: 'queue_sim',
    display_name: 'Queue Sim',
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
      ...runtimePorts(),
    },
    tools: compileToolSchema([manifest]),
    session: {} as unknown as RealtimeSession,
    bridge: new RealtimeRuntimeBridge({
      runtime: {
        clock,
        memory,
        executors,
        ingestUserInput: unreachable('ingestUserInput'),
        dispatchExternal: unreachable('dispatchExternal'),
      },
      tools: compileToolSchema([manifest]),
      idFactory: () => 'id-1',
    }),
    idFactory: () => 'host-1',
  }
}

/** An unsubscribe for an observer nobody registered. Named so it is not an anonymous empty arrow. */
export function unsubscribeNothing(): void {
  // Intentionally empty: nothing was subscribed.
}

/** A stream that ends immediately, which the receive loop treats as a provider that is gone. */
export async function* emptyStream(): AsyncGenerator<never> {
  // Nothing to yield.
}

/** A stream that yields nothing and stays suspended until the stop signal fires. */
export async function* parkedStream(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise<void>(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), {once: true})
  })
}

/**
 * The projection's spoken text, against the Python-exported golden.
 *
 * What a user hears is the part where two runtimes that both "work" can still differ: the wording, the
 * elapsed-seconds rendering, and the priority a hit is queued at. Exercised through the same helpers
 * the projection uses rather than through a whole assembled service, which would be measuring the
 * provider and session instead.
 */
export interface Projection {
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

export const projectionDocument = JSON.parse(
  readFileSync(resolve(fixtureRoot, 'scenarios.json'), 'utf8'),
) as {readonly projections: readonly Projection[]}

export const projectionGolden = JSON.parse(
  readFileSync(resolve(fixtureRoot, 'scenarios-expected.json'), 'utf8'),
) as {readonly projections: readonly Record<string, unknown>[]}

/**
 * Run one projection *through the service*, and report what the user would get.
 *
 * Deliberately not a reimplementation of the formatting. A test that restated the wording would agree
 * with itself no matter what the service did -- which is exactly what an earlier version of this file
 * did, and a mutation sweep found five projection changes it could not see.
 */
export function runProjection(spec: Projection): Record<string, unknown> {
  const channel = spec.display_name === 'Codex' ? 'codex' : spec.display_name
  const priority = spec.manifest_priority ?? 50
  // The exported parity matrix predates monitor policy; keep those priority-only vectors on the
  // legacy task branch while the monitor-specific regressions below cover policy delivery.
  const monitor = (spec.display_name === 'watch' || spec.display_name === 'guard')
    && spec.kind !== 'hit_priority'
  const {service, queuedItems} = realtimeServiceHarness('projection', {
    delegate: {executor: channel, op: 'start', routing_class: 'user_awaited'},
    priority,
    ...(spec.display_name === 'watch' ? {displayName: '观察'}
      : spec.display_name === 'guard' ? {displayName: '监控'} : {}),
    ...(monitor ? {
      operationClass: 'monitor' as const,
      alertDelivery: spec.display_name === 'guard' ? 'preemptive' as const : 'deferred' as const,
    } : {}),
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
        : content.slice(content.indexOf('：') + 1)
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

export function progressEvent(input: {
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

/** Spec 08 host tools on the pipeline fixture: `dispatch` / `cancel` / `confirm` are the only coding tools the model sees. */
export async function dispatchTurn(
  service: RealtimeService,
  name: 'task' | 'dispatch' | 'cancel' | 'confirm' | `codex__${string}`,
  arguments_: Readonly<Record<string, JsonValue>>,
  responseId = 'origin',
): Promise<ToolAcceptance> {
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1, speech_id: `speech-${responseId}`, provider_item_id: `user-${responseId}`,
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1, speech_id: `speech-${responseId}`, provider_item_id: `user-${responseId}`,
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1, item_id: `user-${responseId}`, text: 'build timer',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: responseId})
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1, call_id: `call-${responseId}`, item_id: `tool-${responseId}`,
    name, arguments: arguments_, response_id: responseId,
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: responseId, status: 'completed', reason: '',
  })
  return service.toolCallAcceptances().find(snapshot => snapshot.call_id === `call-${responseId}`)!.acceptance
}

/** Seed causal user input for the continuation tests; pass two to exercise an orphaned revision. */
export async function twoTurns(service: RealtimeService, count = 1): Promise<void> {
  for (const index of [1, 2].slice(0, count)) {
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

export async function openCompletedAcknowledgementPlayback(
  service: RealtimeService,
  session: RealtimeSession,
  providerCompleted = true,
): Promise<NonNullable<RealtimeSession['currentGeneration']>> {
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'user-item-1', text: 'compile the runtime',
  })
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1,
    call_id: 'call-1', item_id: 'tool-1', name: 'codex__run',
    arguments: {work_order: 'compile the runtime'}, response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1,
    response_id: 'r-1', status: 'completed', reason: '',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-2'})
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1,
    response_id: 'r-2', pcm: new Uint8Array([0, 1]),
  })
  const generation = session.currentGeneration
  assert.notEqual(generation, null)
  assert.equal(service.playbackStarted(generation!.utterance_id, generation!.generation_epoch), true)
  if (providerCompleted) {
    await service.handleEvent({
      kind: 'response_terminal', session_epoch: 1,
      response_id: 'r-2', status: 'completed', reason: '',
    })
  }
  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'bound')
  return generation!
}

export function guardFact(eventId = 'final:d-guard'): Parameters<RealtimeService['queueHostItem']>[0] {
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

export function offerCodexCommand(
  controller: HostApprovalController,
  signal: AbortSignal = new AbortController().signal,
): Promise<ApprovalResolution | null> {
  return controller.offer({
    kind: 'command_execution',
    local_detail: {
      kind: 'command_execution',
      command: 'Remove-Item C:\\private\\raw-command.txt',
      cwd: 'C:\\private\\raw-cwd',
    },
    operation_summary: 'Codex 请求执行一条工作区命令。',
  }, signal)
}

export async function finishExecutorApprovalQuestion(service: RealtimeService, responseId: string): Promise<void> {
  await new Promise<void>(resolve => {setImmediate(resolve)})
  await service.flushHostItems()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: responseId})
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: responseId,
    status: 'completed', reason: '',
  })
  await service.localSpeechOnset(`local-onset-${responseId}`)
}

export async function beginExecutorApprovalCarrier(
  service: RealtimeService,
  input: {
    readonly itemId: string | null
    readonly responseId: string
    readonly revealItemAtEnd?: string
    readonly origin?: ResponseOrigin
  },
): Promise<void> {
  await new Promise<void>(resolve => {setImmediate(resolve)})
  const speechId = `speech-${input.responseId}`
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1, speech_id: speechId,
    provider_item_id: input.itemId,
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: input.responseId,
    ...(input.origin === undefined ? {} : {origin: input.origin}),
  })
  if (input.revealItemAtEnd !== undefined) return
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1, speech_id: speechId,
    provider_item_id: input.itemId,
  })
}

export async function endExecutorApprovalSpeech(
  service: RealtimeService,
  responseId: string,
  itemId: string,
): Promise<void> {
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1, speech_id: `speech-${responseId}`,
    provider_item_id: itemId,
  })
}

export async function emitExecutorApprovalFunction(
  service: RealtimeService,
  input: {
    readonly approvalId: string
    readonly approved: JsonValue
    readonly responseId: string | null
    readonly callId?: string
    readonly epoch?: number
  },
): Promise<void> {
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: input.epoch ?? 1,
    call_id: input.callId ?? `call-${input.responseId ?? 'none'}`,
    item_id: `function-${input.responseId ?? 'none'}`,
    response_id: input.responseId,
    name: 'confirm',
    arguments: {id: input.approvalId, accepted: input.approved},
  })
}

export async function finishProviderResponse(service: RealtimeService, responseId: string): Promise<void> {
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: responseId,
    status: 'completed',
    reason: 'completed',
  })
}

/**
 * Whether the user was told something about the confirmation.
 *
 * Queued or already injected: the fact is enqueued synchronously and delivered by the pass at the end
 * of the event, which only fires when the floor is free. Asserting on the injection alone would make
 * this a test of floor state.
 */
export function toldAboutConfirmation(service: RealtimeService, actions: readonly string[]): boolean {
  return actions.some(action => action.startsWith('inject:project-confirmation:'))
    || service.queuedHostItems().some(item => (
      item.intent.item.event_id.startsWith('project-confirmation:')
    ))
}

export function propose(controller: ProjectConfirmationController) {
  return controller.prepare({
    action: 'create',
    workspace_display_name: '研究项目',
    workspace_id: null,
    session_title: null,
    session_id: null,
    work_order: null,
    origin_ref: 'conversation:1',
  })
}

export async function confirmationTurn(
  service: RealtimeService,
  input: {
    readonly proposalId: string
    readonly confirmed: JsonValue
    readonly callId?: string
    readonly itemId?: string
    readonly responseId?: string
    readonly transcript?: string
  },
): Promise<void> {
  const itemId = input.itemId ?? 'user-item-1'
  const responseId = input.responseId ?? 'response-1'
  await reserveConfirmationTurn(service, {
    itemId,
    responseId,
    ...(input.transcript === undefined ? {} : {transcript: input.transcript}),
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: input.callId ?? 'confirm-1',
    item_id: 'function-1',
    response_id: responseId,
    name: 'confirm',
    arguments: {id: input.proposalId, accepted: input.confirmed},
  })
}

export async function reserveConfirmationTurn(
  service: RealtimeService,
  input: {readonly itemId: string; readonly responseId: string; readonly transcript?: string},
): Promise<void> {
  const {itemId, responseId} = input
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
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: responseId})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: itemId,
    text: input.transcript ?? '好，创建吧',
  })
}

export async function speak(service: RealtimeService, itemId: string, text: string): Promise<void> {
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

/** The coordinator ports the service must be given; a test names only what it expects to be reached. */
export function intakePorts(
  overrides: Partial<NonNullable<ConstructorParameters<typeof RealtimeService>[0]['intake']>> = {},
): NonNullable<ConstructorParameters<typeof RealtimeService>[0]['intake']> {
  const unexpected = () => {throw new Error('unbound draft must not reach intake')}
  return {
    settings: {clarification_depth: 'balanced', plan_readback: 'silent'},
    roster: () => [], running: () => [], activeProject: () => 'alpha',
    resolveTarget: unexpected,
    models: {assess: unexpected, plan: unexpected, targets: {resolveIntake: () => Promise.reject(new Error('unexpected target call')), resolveWork: unexpected}},
    dispatch: unexpected, steer: unexpected,
    record: () => undefined,
    ...overrides,
  }
}

// Every step awaits the real public delivery/event boundary; no background service loop or timer sleeps.
export const deliveryPassScenarios = [
  {
    name: 'idle drains one host response and reserves the provider', steps: [
      {event: 'queue', queued: ['fixture'], floor: 'idle', idle: true},
      {event: 'flush', queued: [], floor: 'idle', idle: false},
      {event: 'flush', queued: [], floor: 'idle', idle: false},
    ]
  },
  {
    name: 'active provider holds ordinary delivery until its terminal', steps: [
      {event: 'response', queued: [], floor: 'idle', idle: false},
      {event: 'queue', queued: ['fixture'], floor: 'idle', idle: false},
      {event: 'flush', queued: ['fixture'], floor: 'idle', idle: false},
      {event: 'terminal', queued: [], floor: 'idle', idle: false},
    ]
  },
  {
    name: 'stale user hold is released strictly after the deadline', steps: [
      {event: 'speech', queued: [], floor: 'user_speaking', idle: true},
      {event: 'queue', queued: ['fixture'], floor: 'user_speaking', idle: true},
      {event: 'at-deadline', queued: ['fixture'], floor: 'user_speaking', idle: true},
      {event: 'past-deadline', queued: [], floor: 'idle', idle: false},
    ]
  },
  {
    name: 'renderer disconnect pauses and explicit resume releases delivery', steps: [
      {event: 'disconnect', queued: [], floor: 'idle', idle: true, paused: true},
      {event: 'queue', queued: ['fixture'], floor: 'idle', idle: true, paused: true},
      {event: 'flush', queued: ['fixture'], floor: 'idle', idle: true, paused: true},
      {event: 'resume', queued: [], floor: 'idle', idle: false},
    ]
  },
] as const

type RuntimePorts = Pick<ConstructorParameters<typeof RealtimeService>[0]['runtime'],
  'observe' | 'serve' | 'claimedHandoff' | 'terminatedByDeadline' | 'delegateFor' | 'inFlightDelegate'>

function runtimePorts(overrides: Partial<RuntimePorts> = {}): RuntimePorts {
  return {
    observe: () => unsubscribeNothing,
    // The parked runtime loop never ends, which the service would treat as a failure.
    serve: () => new Promise<void>(() => undefined),
    claimedHandoff: () => undefined,
    terminatedByDeadline: () => false,
    delegateFor: () => undefined,
    inFlightDelegate: () => undefined,
    ...overrides,
  }
}

function loggedProviderPorts(actions: string[], labels: {readonly create: string; readonly ensure: string; readonly cancel: string}) {
  return {
    createResponse: (intent: {readonly kind: string}) => {
      actions.push(`${labels.create}:${intent.kind}`)
      return Promise.resolve()
    },
    ensureResponse: () => {
      actions.push(labels.ensure)
      return Promise.resolve()
    },
    cancelResponse: (responseId: string) => {
      actions.push(`${labels.cancel}:${responseId}`)
      return Promise.resolve()
    },
    sendAudio: () => Promise.resolve(),
    events: () => emptyStream(),
    close: () => Promise.resolve(),
  }
}

function playbackPorts(idFactory: () => string, onClear: ConstructorParameters<typeof PlaybackRegistry>[0]['onClear']) {
  return new PlaybackRegistry({idFactory, onFrame: () => undefined, onClear})
}

interface PipelineOptions {
  readonly userResponseMode?: 'automatic' | 'requested'
  readonly intake?: ConstructorParameters<typeof RealtimeService>[0]['intake']
  readonly toolResult?: {readonly accepted: boolean; readonly delegateId: string | null}
  readonly onCaption?: (frame: {
    readonly turn_id?: string
    readonly role: string
    readonly text: string
    readonly final: boolean
  }) => void
  readonly includeRecall?: boolean
  readonly projectTool?: boolean
  readonly retireFailure?: boolean
  readonly parkProviderEvents?: boolean
  readonly providerEvents?: ServiceProvider['events']
  readonly beforeInjectConfirmation?: (item: HostContextItem) => Promise<void>
  readonly beforeCancelResponse?: () => Promise<void>
  readonly withExecutorApproval?: boolean
  readonly ensureResponseFailure?: boolean
  readonly failReconnect?: boolean
  readonly agentExecutor?: Pick<AgentExecutor, 'cancel'>
  readonly agentControllers?: readonly AgentController[]
  readonly beforeAgentRuntimeDispatch?: () => void
  readonly personalMemory?: PersonalMemoryRecallPort
  readonly onUserTranscriptAccepted?: (turn: {
    readonly text: string
    readonly originRef: string
    readonly sessionEpoch: number
    readonly itemId: string
  }) => void | Promise<void>
  readonly failTranscriptIngest?: boolean
  readonly beforeTranscriptIngest?: () => Promise<void>
  readonly clearConversation?: () => Promise<void>
  /** Fold the ops into the spec 08 host tools; a raw `codex__*` from the provider is then refused. */
  readonly taskHost?: TaskToolHost
  readonly agent?: boolean
}

interface ProjectionOptions {
  readonly delegate?: {readonly executor: string; readonly op: string; readonly routing_class: string}
  readonly suggest?: boolean
  readonly priority?: number
  readonly displayName?: string
  readonly operationClass?: 'task' | 'monitor'
  readonly alertDelivery?: 'none' | 'deferred' | 'preemptive'
  readonly agentName?: string
  readonly progressViaSurrogate?: boolean
  readonly syncResultOps?: boolean
  readonly onActiveWorkChanged?: () => void
  /** What the runtime's lookups return. Each default is the permissive answer, so a test that needs a
   * guard to fire says so explicitly rather than relying on a double that happens to refuse. */
  readonly claims?: boolean
  readonly terminates?: boolean
  readonly inFlight?: boolean
  readonly delegateOverride?: Partial<{
    readonly request: Readonly<Record<string, JsonValue>>
    readonly executor: string
    readonly op: string
    readonly origin_ref: string
    readonly routing_class: string
  }>
}

interface GuardOptions {
  readonly controlledReconnect?: boolean
  readonly recoveryTexts?: readonly [string, string]
  readonly channel?: string
  readonly priority?: number
  readonly operationClass?: 'task' | 'monitor'
  readonly alertDelivery?: 'none' | 'deferred' | 'preemptive'
}

interface ConfirmationOptions {
  readonly commit?: (
    operation: ConfirmedProjectOperation,
  ) => Promise<{readonly accepted: boolean; readonly code: string}>
  readonly withoutCommit?: boolean
  /** Make the provider's injection hang, so an expiry outlives the shutdown grace period. */
  readonly hangInjection?: boolean
  readonly beforeInjection?: (item: HostContextItem) => Promise<void>
  readonly expiryStepTimeoutMs?: number
  readonly idFactory?: () => string
  readonly withExecutorApproval?: boolean
}

export function realtimeServiceHarness(profile: 'queue'): RealtimeService
export function realtimeServiceHarness(profile: 'pipeline', options?: PipelineOptions): {
  readonly service: RealtimeService & {readonly intakeSession: ReturnType<CodexAgentController['inspectIntakeForTest']>; settleIntakeForTest(): Promise<void>}
  readonly actions: string[]
  readonly injectedContents: string[]
  readonly injectedItems: HostContextItem[]
  readonly session: RealtimeSession
  readonly clock: VirtualClock
  readonly diagnostics: string[]
  readonly executorApproval: HostApprovalController | null
  readonly telemetry: {readonly kind: string; readonly payload: Readonly<Record<string, JsonValue>>}[]
  readonly runtimeDispatches: () => number
}
export function realtimeServiceHarness(profile: 'projection', options?: ProjectionOptions): {
  readonly service: RealtimeService
  readonly queued: () => readonly string[]
  readonly queuedItems: () => readonly QueuedHostResponse[]
  readonly memory: Memory
}
export function realtimeServiceHarness(profile: 'guard', options?: GuardOptions): {
  readonly service: RealtimeService
  readonly actions: string[]
  readonly clock: VirtualClock
  readonly telemetry: {readonly kind: string; readonly payload: Readonly<Record<string, JsonValue>>}[]
}
export function realtimeServiceHarness(profile: 'confirmation', options?: ConfirmationOptions): {
  readonly service: RealtimeService
  readonly controller: ProjectConfirmationController
  readonly actions: string[]
  readonly injected: HostContextItem[]
  readonly views: ProjectConfirmationView[]
  readonly diagnostics: string[]
  readonly telemetry: {readonly kind: string; readonly payload: Readonly<Record<string, JsonValue>>}[]
  readonly clock: VirtualClock
  readonly executorApproval: HostApprovalController | null
}
export function realtimeServiceHarness(profile: 'queue' | 'pipeline' | 'projection' | 'guard' | 'confirmation', input?: unknown): unknown {
  switch (profile) {
    case 'queue': {

      return new RealtimeService(queueOnlyOptions())

    }
    case 'pipeline': {
      const options = (input === undefined ? {} : input) as PipelineOptions

      const manifest = options.withExecutorApproval
        ? CODEX_PROJECT_APPROVAL_MANIFEST
        : options.projectTool ? CODEX_PROJECT_MANIFEST : executorManifestSchema.parse({
          name: 'codex',
          display_name: 'Codex',
          roles: ['coding'],
          // A plain delegate by default so the acknowledgement / continuation tests drive `codex__run` directly;
          // a hidden Codex variant reaches `run` only through the host `dispatch` tool.
          model_visibility: options.agent === true ? 'hidden' : 'direct',
          policy: {
            channel: 'codex',
            priority: 50,
            wake: 'fast',
            typical_latency: 5,
            compress_watermark: 8,
          },
          ops: [
            {
              name: 'run',
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
              sync_result: true,
              deadline_budget: 5,
            },
          ],
        })
      const clock = new VirtualClock()
      const agentDescriptors = manifest.model_visibility === 'hidden'
        ? [{name: 'codex', summary: CODEX_AGENT_SUMMARY, ownedChannels: ['codex']}]
        : []
      const memory = new Memory({policies: [manifest.policy]})
      const executors = new Map([[manifest.name, {manifest}]])
      const actions: string[] = []
      const injectedContents: string[] = []
      const injectedItems: HostContextItem[] = []
      const diagnostics: string[] = []
      const telemetry: {kind: string; payload: Readonly<Record<string, JsonValue>>}[] = []
      let idSeq = 0
      const nextId = (): string => {
        idSeq += 1
        return `id-${idSeq}`
      }
      const executorApproval = options.withExecutorApproval === true
        ? new HostApprovalController({clock, idFactory: nextId})
        : null
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
        ...(options.userResponseMode === undefined ? {} : {userResponseMode: options.userResponseMode}),
        connect: () => {
          epoch += 1
          actions.push('connect')
          if (options.failReconnect === true && epoch > 1) {
            return Promise.reject(new Error('secret reconnect provider error'))
          }
          return Promise.resolve({epoch})
        },
        injectHostItem: async (item) => {
          actions.push(`inject:${item.event_id}`)
          injectedContents.push(item.content)
          injectedItems.push(item)
          await options.beforeInjectConfirmation?.(item)
          return {
            session_epoch: epoch,
            host_item_id: item.host_item_id,
            provider_item_id: `provider:${item.event_id}`,
          }
        },
        retireHostItem: (providerItemId) => {
          actions.push(`retire:${providerItemId}`)
          if (options.retireFailure === true) return Promise.reject(new Error('provider refused delete'))
          return Promise.resolve(true)
        },
        createResponse: (intent) => {
          actions.push(`create_response:${intent.kind}`)
          return Promise.resolve()
        },
        ensureResponse: () => {
          actions.push('ensure_response')
          if (options.ensureResponseFailure === true) {
            return Promise.reject(new Error('provider refused response request'))
          }
          return Promise.resolve()
        },
        cancelResponse: async (responseId) => {
          actions.push(`cancel:${responseId}`)
          await options.beforeCancelResponse?.()
        },
        sendAudio: () => Promise.resolve(),
        events: signal => options.providerEvents?.(signal)
          ?? (options.parkProviderEvents === true ? parkedStream(signal) : emptyStream()),
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
        onDiagnostic: line => diagnostics.push(line),
      })
      const scripted = options.toolResult ?? {accepted: true, delegateId: 'd-1'}
      let runtimeDispatches = 0
      const pipelineDelegate = {
        delegate_id: 'd-1',
        executor: 'codex',
        op: 'run',
        origin_ref: 'conversation:1',
        routing_class: 'user_awaited',
      }
      let ingested = 0
      let codingController: CodexAgentController | undefined
      // Test inspection is owned by the concrete controller, never part of the production service port.
      class TestService extends RealtimeService {
        get intakeSession() {return codingController?.inspectIntakeForTest() ?? null}
        async settleIntakeForTest(): Promise<void> {await codingController?.settleIntakeForTest()}
      }
      const service = new TestService({
        ...(options.taskHost?{taskHost:options.taskHost}:{}),
        provider,
        runtime: {
          clock,
          memory,
          executors,
          // Keep a live delegate so projection reaches the pipeline decisions under test.
          ...runtimePorts({
            claimedHandoff: () => pipelineDelegate,
            terminatedByDeadline: () => true,
            delegateFor: () => pipelineDelegate,
            inFlightDelegate: () => pipelineDelegate,
            serve: (signal: AbortSignal) => new Promise<void>(resolve => {
              signal.addEventListener('abort', () => resolve(), {once: true})
            }),
          }),
          clearConversation: options.clearConversation ?? (() => Promise.resolve()),
        },
        tools: compileToolSchema([manifest], {includeTasks:!!options.taskHost,includeMemoryRecall: options.includeRecall ?? false, agentDescriptors}),
        session,
        bridge: new RealtimeRuntimeBridge({
          runtime: {
            clock,
            memory,
            executors,
            ingestUserInput: async (input: {readonly text: string}) => {
              if (options.failTranscriptIngest === true) return Promise.reject(new Error('synthetic transcript ingest failure'))
              await options.beforeTranscriptIngest?.()
              ingested += 1
              const item = memory.append('conversation', {
                ts: ingested,
                trust: 'trusted_user',
                priority: 100,
                content: {text: input.text},
              })
              return `${item.channel}:${item.seq}`
            },
            dispatchExternal: () => ({
              accepted: scripted.accepted,
              delegate_id: scripted.delegateId,
            }),
          },
          tools: compileToolSchema([manifest], {includeTasks:!!options.taskHost,includeMemoryRecall: options.includeRecall ?? false, agentDescriptors}),
          idFactory: nextId,
          ...(options.personalMemory === undefined ? {} : {personalMemory: options.personalMemory}),
        }),
        ...(options.intake === undefined ? {} : {intake: options.intake}),
        ...(manifest.model_visibility === 'hidden' && options.agentControllers === undefined ? {
          agentControllerFactory: {
            create: ({intake}: {readonly intake: IntakeOptions | undefined}) => (codingController = new CodexAgentController({
              ...(intake === undefined ? {} : {intake}),
              ...(options.agentExecutor === undefined ? {} : {executor: options.agentExecutor}),
              dispatchPort: {
                dispatch: request => {
                  options.beforeAgentRuntimeDispatch?.()
                  if (!request.stillWanted()) return {accepted: false, delegate_id: null}
                  runtimeDispatches += 1
                  return {accepted: scripted.accepted, delegate_id: scripted.delegateId}
                },
              },
              resolveCancelTarget: () => Promise.resolve(null),
            })),
          }
        } : {}),
        ...(options.agentControllers === undefined ? {} : {agentControllers: options.agentControllers}),
        ...(executorApproval === null ? {} : {executorApproval}),
        idFactory: nextId,
        // Spread rather than assigned: `exactOptionalPropertyTypes` distinguishes an absent optional from
        // one explicitly set to undefined, and the service's contract is the former.
        ...(options.onCaption === undefined ? {} : {onCaption: options.onCaption}),
        ...(options.onUserTranscriptAccepted === undefined ? {} : {onUserTranscriptAccepted: options.onUserTranscriptAccepted}),
        onDiagnostic: line => diagnostics.push(line),
        telemetry: {
          record: (kind, payload) => telemetry.push({kind, payload}),
          close: () => undefined,
        },
      })
      return {
        service, actions, injectedContents, injectedItems, session, clock, diagnostics, executorApproval,
        telemetry, runtimeDispatches: () => runtimeDispatches,
      }

    }
    case 'projection': {
      const options = (input === undefined ? {} : input) as ProjectionOptions

      const delegate = options.delegate ?? {
        executor: 'codex',
        op: 'start',
        routing_class: 'user_awaited',
      }
      const manifest = executorManifestSchema.parse({
        name: delegate.executor,
        display_name: options.displayName ?? (delegate.executor === 'codex' ? 'Codex' : delegate.executor),
        ...(options.agentName === undefined ? {} : {model_visibility: 'hidden' as const}),
        ...(delegate.executor === 'codex' ? {roles: ['coding']} : {}),
        policy: {
          channel: delegate.executor,
          priority: options.priority ?? 50,
          wake: 'fast',
          typical_latency: 5,
          compress_watermark: 8,
          operation_class: options.operationClass ?? 'task',
          alert_delivery: options.alertDelivery ?? 'none',
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
      const agentControllers: readonly AgentController[] = options.agentName === undefined ? [] : [{
        descriptor: {name: options.agentName, summary: 'public monitor agent', ownedChannels: [manifest.name]},
        dispatch: () => Promise.resolve({code: 'unsupported_tool', accepted: false, detail: {}}),
        cancel: () => Promise.resolve({code: 'unsupported_tool', accepted: false, detail: {}}),
      }]
      const tools = compileToolSchema([manifest], {
        agentDescriptors: agentControllers.map(controller => controller.descriptor),
      })
      let providerEpoch = 0
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
          ...runtimePorts({
            claimedHandoff: () => (options.claims ?? true) ? full : undefined,
            terminatedByDeadline: () => options.terminates ?? true,
            delegateFor: () => full,
            inFlightDelegate: () => (options.inFlight ?? true) ? full : undefined,
          }),
          memory,
        },
        tools,
        session: new RealtimeSession({
          provider: {
            connect: () => Promise.resolve({epoch: ++providerEpoch}),
            injectHostItem: (item) => Promise.resolve({
              session_epoch: providerEpoch,
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
            dispatchExternal: () => ({accepted: true, delegate_id: 'd-1'}),
          },
          tools,
          idFactory: nextId,
        }),
        idFactory: nextId,
        ...(agentControllers.length === 0 ? {} : {agentControllers}),
        onDiagnostic: () => undefined,
        ...(options.onActiveWorkChanged === undefined
          ? {}
          : {onActiveWorkChanged: options.onActiveWorkChanged}),
      })
      return {
        service,
        queued: () => service.queuedHostItems().map(item => item.intent.item.content),
        queuedItems: () => service.queuedHostItems(),
        memory,
      }

    }
    case 'guard': {
      const options = (input === undefined ? {} : input) as GuardOptions

      const channel = options.channel ?? 'guard'
      const manifest = executorManifestSchema.parse({
        name: channel,
        display_name: 'Guard',
        policy: {
          channel,
          priority: options.priority ?? 90,
          wake: 'fast',
          typical_latency: 2,
          compress_watermark: 8,
          operation_class: options.operationClass ?? 'task',
          alert_delivery: options.alertDelivery ?? 'none',
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
      if (options.recoveryTexts !== undefined) {
        memory.append('conversation', {
          ts: 1,
          trust: 'trusted_user',
          priority: 100,
          content: {text: options.recoveryTexts[0]},
        })
        memory.append('conversation', {
          ts: 2,
          trust: 'trusted_system',
          priority: 100,
          content: {text: options.recoveryTexts[1], delivery: 'spoken', played_ms: 1},
        })
      }
      const executors = new Map([[manifest.name, {manifest}]])
      const alertDelegate = {
        delegate_id: 'd-alert', executor: channel, op: 'start', request: {},
        origin_ref: 'conversation:1', deadline: 30, routing_class: 'user_awaited' as const, dispatched_at: 0,
      }
      const actions: string[] = []
      const telemetry: {kind: string; payload: Readonly<Record<string, JsonValue>>}[] = []
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
        ...loggedProviderPorts(actions, {create: 'create', ensure: 'ensure-response', cancel: 'cancel'}),
      }
      const session = new RealtimeSession({
        provider,
        playback: playbackPorts(nextId, (utteranceId, generationEpoch) => {
          actions.push(`clear:${utteranceId}:${generationEpoch}`)
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
          ...runtimePorts({
            inFlightDelegate: delegateId => delegateId === alertDelegate.delegate_id ? alertDelegate : undefined,
          }),
        },
        tools: compileToolSchema([manifest]),
        session,
        bridge: new RealtimeRuntimeBridge({
          runtime: {
            clock,
            memory,
            executors,
            ingestUserInput: () => Promise.reject(new Error('unused')),
            dispatchExternal: () => ({accepted: false, delegate_id: null}),
          },
          tools: compileToolSchema([manifest]),
          idFactory: nextId,
        }),
        idFactory: nextId,
        controlledPreemptiveAlertReconnect: options.controlledReconnect ?? false,
        ...(options.recoveryTexts === undefined
          ? {}
          : {
            preemptiveAlertHistoryRecovery: 'packed' as const,
            preemptiveAlertHistoryPairs: 1,
            telemetry: {
              record: (kind: string, payload: Readonly<Record<string, JsonValue>>) => {
                telemetry.push({kind, payload})
              },
              close: () => undefined,
            },
          }),
        onDiagnostic: () => undefined,
      })
      return {service, actions, clock, telemetry}

    }
    case 'confirmation': {
      const options = (input === undefined ? {} : input) as ConfirmationOptions

      const manifest = executorManifestSchema.parse({
        name: 'codex',
        display_name: 'Codex',
        roles: ['coding'],
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
      const injected: HostContextItem[] = []
      const views: ProjectConfirmationView[] = []
      const diagnostics: string[] = []
      const telemetry: {kind: string; payload: Readonly<Record<string, JsonValue>>}[] = []
      let ids = 0
      const defaultNextId = (): string => `id-${++ids}`
      const nextId = options.idFactory ?? defaultNextId
      let epoch = 0
      const provider = {
        connect: () => {
          epoch += 1
          actions.push(`connect:${epoch}`)
          return Promise.resolve({epoch})
        },
        injectHostItem: async (item: {readonly host_item_id: string; readonly event_id: string}) => {
          actions.push(`inject:${item.event_id}`)
          injected.push(item as HostContextItem)
          if (options.hangInjection === true) return new Promise<never>(() => undefined)
          await options.beforeInjection?.(item as HostContextItem)
          return {
            session_epoch: epoch,
            host_item_id: item.host_item_id,
            provider_item_id: `provider:${item.event_id}`,
          }
        },
        retireHostItem: (providerItemId: string) => {
          actions.push(`retire:${providerItemId}`)
          return Promise.resolve(true)
        },
        ...loggedProviderPorts(actions, {create: 'create', ensure: 'ensure-response', cancel: 'cancel'}),
      }
      const session = new RealtimeSession({
        provider,
        playback: playbackPorts(nextId, () => undefined),
        idFactory: nextId,
        clock,
        onDiagnostic: () => undefined,
      })
      const controller = new ProjectConfirmationController({clock, idFactory: nextId})
      const executorApproval = options.withExecutorApproval === true
        ? new HostApprovalController({clock, idFactory: nextId})
        : null
      let ingested = 0
      const externalCommit = options.commit ?? ((): Promise<{
        readonly accepted: boolean
        readonly code: string
      }> => {
        actions.push('commit')
        return Promise.resolve({accepted: true, code: 'ok'})
      })
      const commit = options.withoutCommit === true
        ? undefined
        : async (operation: ConfirmedProjectOperation): Promise<{
          readonly accepted: boolean
          readonly code: string
        }> => {
          const result = await externalCommit(operation)
          // The production adapter records successful runtime admission before consuming the
          // controller authority. This fixture supplies the same boundary for lightweight callbacks.
          if (result.accepted) {
            controller.recordRuntimeAdmission(operation)
            assert.equal(controller.claimConfirmed(operation), true)
          } else if (result.code === 'runtime_rejected') {
            assert.equal(controller.rollbackConfirmed(operation), true)
          }
          return result
        }
      const service = new RealtimeService({
        provider,
        runtime: {
          clock,
          executors,
          memory,
          ...runtimePorts(),
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
            dispatchExternal: () => ({accepted: true, delegate_id: 'd-1'}),
          },
          tools: compileToolSchema([manifest]),
          idFactory: nextId,
        }),
        idFactory: nextId,
        projectConfirmation: controller,
        ...(executorApproval === null ? {} : {executorApproval}),
        ...(options.expiryStepTimeoutMs === undefined
          ? {}
          : {projectExpiryStepTimeoutMs: options.expiryStepTimeoutMs}),
        ...(commit === undefined ? {} : {commitProjectOperation: commit}),
        onProjectView: view => views.push(view),
        onDiagnostic: line => diagnostics.push(line),
        telemetry: {
          record: (kind, payload) => telemetry.push({kind, payload}),
          close: () => undefined,
        },
      })
      return {service, controller, actions, injected, views, diagnostics, telemetry, clock, executorApproval}

    }
  }
}
