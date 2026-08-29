/**
 * The Node leg of the realtime session fixture harness.
 *
 * Replays a committed scenario through the real `RealtimeSession` and produces the same
 * observation shape retained in the committed migration fixtures, so results can be compared as
 * canonical JSON. Every recording decision here mirrors one there: the shared action log, reading
 * the fence interruption once per step, and the id sequence being a hard error in both directions.
 */

import { VirtualClock } from '../src/clock.js'
import {
  PlaybackRegistry,
  type PlaybackCompletion,
  type PlaybackFrame,
  type PlaybackGeneration,
} from '../src/playback.js'
import {
  RealtimeSession,
  type FenceInterruption,
  type HostResponseDelivery,
  type SessionProvider,
} from '../src/realtime/session.js'
import type {
  HostContextItem,
  HostResponseIntent,
  RealtimeProviderEvent,
} from '../src/realtime/protocol.js'
import type { SessionFixture, SessionFixtureStep } from '../src/realtime/session-fixtures.js'

/** The one host-allocated id sequence, shared by the session and the playback registry. */
class IdSequence {
  #index = 0

  constructor(private readonly values: readonly string[]) {}

  next = (): string => {
    if (this.#index >= this.values.length) {
      throw new Error(
        `id sequence exhausted after ${this.#index} id(s); declare more in input.ids`,
      )
    }
    const value = this.values[this.#index]!
    this.#index += 1
    return value
  }

  requireExhausted(): void {
    if (this.#index === this.values.length) return
    const remaining = this.values.slice(this.#index)
    throw new Error(`id sequence left ${remaining.length} unconsumed: ${remaining.join(', ')}`)
  }
}

/** Records every provider call instead of talking to a provider. `events()` is never used. */
class RecordingProvider implements SessionProvider {
  #epoch = 0

  constructor(private readonly actions: string[]) {}

  connect(options: {readonly tools: readonly Record<string, unknown>[]}): Promise<{
    readonly epoch: number
  }> {
    this.#epoch += 1
    this.actions.push(`connect:${options.tools.length}`)
    return Promise.resolve({epoch: this.#epoch})
  }

  injectHostItem(
    item: HostContextItem,
    options?: {
      readonly confirmationTimeout?: number | null
      readonly asUserActivation?: boolean
    },
  ): Promise<{readonly session_epoch: number; readonly host_item_id: string}> {
    const timeout = options?.confirmationTimeout ?? null
    // Python renders the timeout with `repr`, which prints a float without a trailing `.0` only
    // when it has one; matching that spelling keeps the action logs comparable.
    const detail = timeout === null ? '' : `:timeout=${formatPythonRepr(timeout)}`
    const activation = options?.asUserActivation === true ? ':activation' : ''
    this.actions.push(`inject:${item.host_item_id}${detail}${activation}`)
    return Promise.resolve({session_epoch: this.#epoch, host_item_id: item.host_item_id})
  }

  createResponse(intent: HostResponseIntent): Promise<void> {
    const spoken = intent.origin_spoken ? ':origin_spoken' : ''
    this.actions.push(`create_response:${intent.kind}${spoken}`)
    return Promise.resolve()
  }

  cancelResponse(responseId: string): Promise<void> {
    this.actions.push(`cancel:${responseId}`)
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.actions.push('close')
    return Promise.resolve()
  }
}

/**
 * Python's `repr` for a float.
 *
 * An integral value keeps its `.0`, but only while Python prints it in positional form: past 1e16
 * it switches to exponent notation, which carries no `.0`, and JavaScript switches at 1e21. Between
 * those two the spellings differ regardless, so anything at or above 1e16 is refused rather than
 * guessed at -- a fixture needing such a timeout would have to pin the spelling with a vector.
 */
function formatPythonRepr(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e16) {
    throw new Error(`confirmation timeout is outside the proven repr range: ${value}`)
  }
  return Number.isInteger(value) ? `${value}.0` : `${value}`
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(value, 'base64')
  const owned = new Uint8Array(new ArrayBuffer(decoded.byteLength))
  owned.set(decoded)
  return owned
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
}

function buildPcm(spec: {readonly pcm_base64: string} | {
  readonly pcm_fill: {readonly byte: number; readonly length: number}
}): Uint8Array<ArrayBuffer> {
  if ('pcm_base64' in spec) return decodeBase64(spec.pcm_base64)
  const filled = new Uint8Array(new ArrayBuffer(spec.pcm_fill.length))
  filled.fill(spec.pcm_fill.byte)
  return filled
}

function buildEvent(spec: Record<string, unknown>): RealtimeProviderEvent {
  const {kind, ...rest} = spec
  if (kind === 'response_audio_delta') {
    return {
      kind: 'response_audio_delta',
      session_epoch: rest.session_epoch as number,
      response_id: rest.response_id as string,
      pcm: buildPcm(rest.pcm as never),
    }
  }
  return {kind, ...rest} as RealtimeProviderEvent
}

function tools(count: number): Record<string, unknown>[] {
  return Array.from({length: count}, (_unused, index) => ({name: `tool-${index}`}))
}

export async function runSessionFixture(fixture: SessionFixture): Promise<unknown> {
  const steps = fixture.input.steps
  const {responseIds, eventIds} = mentionedIds(steps)
  const ids = new IdSequence(fixture.input.ids)

  const actions: string[] = []
  const frames: PlaybackFrame[] = []
  const alerts: (readonly [string | null, number | null])[] = []
  const deliveries: PlaybackCompletion[] = []
  const spoken: string[] = []
  const diagnostics: string[] = []

  const playback = new PlaybackRegistry({
    idFactory: ids.next,
    onFrame: frame => frames.push(frame),
    onClear: (utteranceId, generationEpoch) => {
      actions.push(`clear:${utteranceId}:${generationEpoch}`)
    },
    onAlert: (utteranceId, generationEpoch) => alerts.push([utteranceId, generationEpoch]),
  })
  const provider = new RecordingProvider(actions)
  const clock = new VirtualClock()
  const session = new RealtimeSession({
    provider,
    playback,
    idFactory: ids.next,
    clock,
    onSpoken: text => {
      spoken.push(text)
    },
    onDelivery: completion => {
      deliveries.push(completion)
    },
    onDiagnostic: line => {
      diagnostics.push(line)
    },
  })

  const observations: unknown[] = []
  for (const [index, step] of steps.entries()) {
    const marks = {
      actions: actions.length,
      frames: frames.length,
      alerts: alerts.length,
      deliveries: deliveries.length,
      spoken: spoken.length,
      diagnostics: diagnostics.length,
    }
    const result = await applyStep(session, step, clock)
    // Reading the fence interruption clears it, and nothing else in the session reads that field,
    // so taking it once per step costs no fidelity and covers every path that sets it.
    const interruption = session.takeFenceInterruption()
    observations.push({
      step: index,
      kind: step.kind,
      result: resultRecord(result),
      actions: actions.slice(marks.actions),
      frames: frames.slice(marks.frames).map(frameRecord),
      alerts: alerts.slice(marks.alerts).map(alert => [...alert]),
      deliveries: deliveries.slice(marks.deliveries).map(completionRecord),
      spoken: spoken.slice(marks.spoken),
      diagnostics: diagnostics.slice(marks.diagnostics),
      fence_interruption: interruptionRecord(interruption),
      state: observedState(session, clock, responseIds, eventIds),
    })
  }
  ids.requireExhausted()
  return {schema_version: 1, observations}
}

async function applyStep(
  session: RealtimeSession,
  step: SessionFixtureStep,
  clock: VirtualClock,
): Promise<unknown> {
  switch (step.kind) {
    case 'connect':
      await session.connect({tools: tools(step.tools)})
      return null
    case 'reconnect':
      await session.reconnect({tools: tools(step.tools)})
      return null
    case 'reconnect_for_guard': {
      const generation = session.currentGeneration
      if (generation === null) throw new Error('reconnect_for_guard needs a generation to retain')
      return session.reconnectForGuard({
        tools: tools(step.tools),
        oldGeneration: generation,
        confirmationTimeout: step.confirmation_timeout,
        history: step.history,
        historyMode: step.history_mode,
      })
    }
    case 'provider_event':
      return session.accept(buildEvent(step.event))
    case 'deliver_host_item':
      return session.deliverHostItem(buildItem(step.item))
    case 'deliver_host_response':
      return session.deliverHostResponse(buildIntent(step.intent), {
        asUserActivation: step.as_user_activation,
      })
    case 'deliver_preemptive_host_response':
      return session.deliverPreemptiveHostResponse(buildIntent(step.intent), {
        confirmationTimeout: step.confirmation_timeout,
        asUserActivation: step.as_user_activation,
      })
    case 'inject_tool_output':
      return session.injectToolOutput(buildItem(step.item))
    case 'request_tool_continuation':
      return session.requestToolContinuation(step.intents.map(buildIntent), {
        originSpoken: step.origin_spoken,
      })
    case 'caption_for':
      return session.captionFor(buildEvent(step.event), {accepted: step.accepted})
    case 'reset_captions':
      session.resetCaptions()
      return null
    case 'arm_next_response_fence':
      session.armNextResponseFence()
      return null
    case 'local_speech_onset':
      await session.localSpeechOnset(step.speech_id)
      return null
    case 'host_preempt':
      return session.hostPreempt()
    case 'playback_started':
      return session.playbackStarted(step.utterance_id, step.generation_epoch)
    case 'playback_done':
      return session.playbackDone(step.utterance_id, step.generation_epoch, step.played_ms)
    case 'complete_playback':
      return session.completePlayback(step.utterance_id, step.generation_epoch, step.played_ms)
    case 'playback_cleared':
      return session.playbackCleared(step.utterance_id, step.generation_epoch, step.played_ms)
    case 'playback_stopped':
      return session.playbackStopped(step.utterance_id, step.generation_epoch, step.played_ms)
    case 'advance_clock':
      clock.advanceTo(step.to)
      return null
    case 'release_stale_user_hold':
      return session.releaseStaleUserHold(step.max_hold_s)
    default:
      throw new Error(`unsupported step kind: ${(step as {kind: string}).kind}`)
  }
}

function buildItem(spec: {
  readonly kind: string
  readonly host_item_id: string
  readonly event_id: string
  readonly content: string
  readonly call_id: string | null
}): HostContextItem {
  return spec as HostContextItem
}

function buildIntent(spec: {
  readonly kind: string
  readonly item: Parameters<typeof buildItem>[0]
  readonly task_summary: string | null
  readonly origin_spoken: boolean
}): HostResponseIntent {
  return {
    kind: spec.kind,
    item: buildItem(spec.item),
    task_summary: spec.task_summary,
    origin_spoken: spec.origin_spoken,
  } as HostResponseIntent
}

function mentionedIds(steps: readonly SessionFixtureStep[]): {
  readonly responseIds: readonly string[]
  readonly eventIds: readonly string[]
} {
  const responses = new Set<string>()
  const events = new Set<string>()
  for (const step of steps) {
    if ('event' in step) {
      const responseId = (step.event as {response_id?: unknown}).response_id
      if (typeof responseId === 'string') responses.add(responseId)
    }
    if ('item' in step) events.add(step.item.event_id)
    if ('intent' in step) events.add(step.intent.item.event_id)
    if ('intents' in step) for (const intent of step.intents) events.add(intent.item.event_id)
  }
  return {
    responseIds: [...responses].sort(),
    eventIds: [...events].sort(),
  }
}

function frameRecord(frame: PlaybackFrame): unknown {
  return {
    utterance_id: frame.utterance_id,
    generation_epoch: frame.generation_epoch,
    sequence: frame.sequence,
    pcm_base64: encodeBase64(frame.pcm),
  }
}

function completionRecord(completion: PlaybackCompletion): unknown {
  return {
    session_epoch: completion.session_epoch,
    response_id: completion.response_id,
    utterance_id: completion.utterance_id,
    generation_epoch: completion.generation_epoch,
    text: completion.text,
    disposition: completion.disposition,
    started: completion.started,
    played_ms: completion.played_ms ?? null,
  }
}

function generationRecord(generation: PlaybackGeneration | null): unknown {
  if (generation === null) return null
  return {
    session_epoch: generation.session_epoch,
    generation_epoch: generation.generation_epoch,
    generation_id: generation.generation_id,
    utterance_id: generation.utterance_id,
    response_id: generation.response_id,
  }
}

function interruptionRecord(interruption: FenceInterruption | null): unknown {
  if (interruption === null) return null
  return {session_epoch: interruption.session_epoch, event_ids: [...interruption.event_ids]}
}

function resultRecord(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (isCompletion(value)) return completionRecord(value)
  if (isDelivery(value)) {
    return {accepted: value.accepted, injection_epoch: value.injectionEpoch}
  }
  if (isCaption(value)) return {role: value.role, text: value.text, final: value.final}
  throw new Error(`unserializable step result: ${JSON.stringify(value)}`)
}

function isCompletion(value: unknown): value is PlaybackCompletion {
  return typeof value === 'object' && value !== null && 'disposition' in value
}

function isDelivery(value: unknown): value is HostResponseDelivery {
  return typeof value === 'object' && value !== null && 'accepted' in value
}

function isCaption(value: unknown): value is {role: string; text: string; final: boolean} {
  return typeof value === 'object' && value !== null && 'role' in value
}

function observedState(
  session: RealtimeSession,
  clock: VirtualClock,
  responseIds: readonly string[],
  eventIds: readonly string[],
): unknown {
  const responses: Record<string, unknown> = {}
  for (const responseId of responseIds) {
    responses[responseId] = {
      phase: session.providerTurnPhase(responseId) ?? null,
      was_fenced: session.providerTurnWasFenced(responseId),
      user_input_revision: session.providerTurnUserInputRevision(responseId) ?? null,
      has_spoken: session.responseHasSpoken(responseId),
      event_ids: [...session.responseEventIds(responseId)],
    }
  }
  const snapshot = session.snapshot()
  return {
    clock: clock.now(),
    session_epoch: session.sessionEpoch,
    user_input_revision: session.userInputRevision,
    active_provider_response_id: session.activeProviderResponseId,
    provider_idle: session.providerIdle,
    foreground_idle: session.foregroundIdle,
    current_generation: generationRecord(session.currentGeneration),
    floor_state: session.floor.state,
    user_caption: session.userCaption,
    assistant_caption: session.assistantCaption,
    responses,
    host_events_deduplicated: eventIds.filter(id => session.hostEventIsDeduplicated(id)),
    snapshot: {
      version: snapshot.version,
      active_delegates: snapshot.active_delegates.map(([id, record]) => [id, {...record}]),
      spoken_event_ids: [...snapshot.spoken_event_ids],
      interrupted_event_ids: [...snapshot.interrupted_event_ids],
    },
  }
}
