/**
 * Deterministic fixture host: replays a recorded scenario through the real reducer.
 *
 * This is test-oracle machinery, not product code. It lives outside `runtime.ts`
 * so the production reducer never depends on the fixture contract, and so a
 * packaged desktop runtime does not load the virtual clock, the scripted id
 * factory, or this replay loop just by importing the runtime.
 */

import type { z } from 'zod'
import { VirtualClock } from './clock.js'
import { resolveProactivityPreset } from './config.js'
import type { DesktopEffect } from './effects.js'
import {
  fixtureExpectedSchema,
  fixtureModelViewSchema,
  type FixtureExpected,
  type RuntimeFixture,
} from './fixtures.js'
import { ScriptedIdFactory } from './ids.js'
import { PlaybackRegistry } from './playback.js'
import type { ExecutorManifest } from './ports.js'
import { CoreRuntime } from './runtime.js'
import { SLOTS } from './slots.js'

type PlaybackEffect = NonNullable<FixtureExpected['playback_effects']>[number]

interface ScheduledModelCompletion {
  readonly kind: 'model'
  readonly jobId: string
  readonly output: unknown
  readonly due: number
  readonly sequence: number
}

interface ScheduledExecutorCompletion {
  readonly kind: 'executor'
  readonly dispatchIndex: number
  readonly output: unknown
  readonly due: number
  readonly sequence: number
}

type ScheduledFixtureCompletion = ScheduledModelCompletion | ScheduledExecutorCompletion

export function runRuntimeFixture(
  fixture: RuntimeFixture,
  manifestRegistry: readonly ExecutorManifest[],
): FixtureExpected {
  const enabled = new Set(fixture.input.configuration.enabled_executors)
  const manifests = manifestRegistry.filter(manifest => enabled.has(manifest.name))
  if (manifests.length !== enabled.size) {
    const found = new Set(manifests.map(manifest => manifest.name))
    const missing = [...enabled].filter(name => !found.has(name))
    throw new Error(`fixture executors are not registered: ${missing.join(', ')}`)
  }
  const clock = new VirtualClock(fixture.input.initial_clock)
  const ids = new ScriptedIdFactory(fixture.input.id_sequences)
  const scripts = {
    fast: [...fixture.input.ports.fastbrain],
    'surrogate.watch': [...fixture.input.ports.surrogate],
    compress: [...fixture.input.ports.compressor],
  }
  const executorScripts = Object.fromEntries(Object.entries(fixture.input.ports.executors ?? {}).map(
    ([name, completions]) => [name, [...completions]],
  ))
  for (const name of Object.keys(executorScripts)) {
    if (!enabled.has(name)) throw new Error(`scripted executor is not enabled: ${name}`)
  }
  const scheduler = new FixtureModelScheduler()
  const outboundDesktop: DesktopEffect[] = []
  const playbackEffects: PlaybackEffect[] = []
  const modelViews: z.infer<typeof fixtureModelViewSchema>[] = []
  const playback = new PlaybackRegistry({
    idFactory: () => ids.next('playback'),
    onFrame: frame => outboundDesktop.push({
      kind: 'audio_frame',
      data: {
        utterance_id: frame.utterance_id,
        generation_epoch: frame.generation_epoch,
        sequence: frame.sequence,
        pcm_base64: Buffer.from(frame.pcm).toString('base64'),
      },
    }),
    onClear: (utteranceId, generationEpoch) => outboundDesktop.push({
      kind: 'audio_clear',
      data: {utterance_id: utteranceId, generation_epoch: generationEpoch},
    }),
    onAlert: (utteranceId, generationEpoch) => outboundDesktop.push({
      kind: 'audio_alert',
      data: {utterance_id: utteranceId, generation_epoch: generationEpoch},
    }),
  })
  const proactivity = resolveProactivityPreset(fixture.input.configuration.proactivity_preset)
  const runtime = new CoreRuntime({
    manifests,
    ids,
    modelSlots: SLOTS,
    retainRoutingHistory: true,
    suggestionCooldown: proactivity.cooldown,
    freshWindow: proactivity.fresh_window,
    onModelCall: call => {
      if (call.context_view !== undefined) {
        modelViews.push(fixtureModelViewSchema.parse({
          slot: call.slot,
          view: call.context_view,
        }))
      }
      const completion = scripts[call.slot].shift()
      if (completion === undefined) throw new Error(`missing scripted ${call.slot} output`)
      scheduler.schedule(
        call.job_id,
        completion.output,
        call.started_at + completion.delay,
      )
    },
    onExecutorDispatch: (dispatchIndex, delegate) => {
      if (!Object.hasOwn(executorScripts, delegate.executor)) return
      const completion = executorScripts[delegate.executor]!.shift()
      if (completion === undefined) {
        throw new Error(`missing scripted ${delegate.executor} output`)
      }
      scheduler.scheduleExecutor(
        dispatchIndex,
        completion.output,
        delegate.dispatched_at + completion.delay,
      )
    },
  })
  const stimuli = fixture.input.stimuli
    .map((stimulus, index) => ({stimulus, index}))
    .sort((left, right) => left.stimulus.at - right.stimulus.at || left.index - right.index)

  let offset = 0
  while (offset < stimuli.length) {
    const at = stimuli[offset]!.stimulus.at
    advanceBefore(clock, runtime, scheduler, at)
    clock.advanceTo(at)
    const group = []
    while (offset < stimuli.length && stimuli[offset]!.stimulus.at === at) {
      group.push(stimuli[offset]!.stimulus)
      offset += 1
    }
    for (const stimulus of group) {
      if (stimulus.kind === 'playback_open') {
        const generation = playback.openResponse({
          sessionEpoch: stimulus.session_epoch,
          responseId: stimulus.response_id,
        })
        playbackEffects.push({kind: 'open', generation})
      } else if (stimulus.kind === 'playback_audio') {
        playback.pushAudio({
          sessionEpoch: stimulus.session_epoch,
          responseId: stimulus.response_id,
          pcm: decodeFixturePcm(stimulus.pcm_base64),
        })
      } else if (stimulus.kind === 'playback_transcript') {
        playback.setTranscript({
          sessionEpoch: stimulus.session_epoch,
          responseId: stimulus.response_id,
          text: stimulus.text,
        })
      } else if (stimulus.kind === 'playback_terminal') {
        playback.markProviderTerminal({
          sessionEpoch: stimulus.session_epoch,
          responseId: stimulus.response_id,
          disposition: stimulus.disposition,
        })
      } else if (stimulus.kind === 'playback_start') {
        const accepted = playback.markStarted(stimulus.utterance_id, stimulus.generation_epoch)
        playbackEffects.push({
          kind: 'ack',
          ack: 'started',
          utterance_id: stimulus.utterance_id,
          generation_epoch: stimulus.generation_epoch,
          accepted,
          completion: null,
        })
      } else if (stimulus.kind === 'playback_fence_current') {
        playback.fenceCurrent({alert: stimulus.alert})
      } else if (stimulus.kind === 'playback_cleared') {
        const completion = playback.recordCleared(
          stimulus.utterance_id,
          stimulus.generation_epoch,
          stimulus.played_ms,
        )
        playbackEffects.push({
          kind: 'ack',
          ack: 'cleared',
          utterance_id: stimulus.utterance_id,
          generation_epoch: stimulus.generation_epoch,
          accepted: completion !== null,
          completion,
        })
      } else if (stimulus.kind === 'playback_done') {
        const completion = playback.ackDone(
          stimulus.utterance_id,
          stimulus.generation_epoch,
          stimulus.played_ms,
        )
        playbackEffects.push({
          kind: 'ack',
          ack: 'done',
          utterance_id: stimulus.utterance_id,
          generation_epoch: stimulus.generation_epoch,
          accepted: completion !== null,
          completion,
        })
      } else if (stimulus.kind === 'floor_user_start') {
        runtime.startUserSpeech(stimulus.speech_id)
      } else if (stimulus.kind === 'floor_user_end') {
        runtime.endUserSpeech(stimulus.speech_id)
      } else if (stimulus.kind === 'floor_agent_start') {
        runtime.startAgentSpeech(stimulus.utterance_id, stimulus.priority)
      } else if (stimulus.kind === 'floor_agent_end') {
        runtime.endAgentSpeech(stimulus.utterance_id)
      } else if (stimulus.kind === 'user_input') {
        runtime.post({
          kind: 'user_input',
          payload: stimulus.media_refs === undefined
            ? {text: stimulus.text}
            : {text: stimulus.text, media_refs: stimulus.media_refs},
        }, at)
      } else if (stimulus.kind === 'executor_complete') {
        runtime.postExecutorCompletion(stimulus.dispatch_index, stimulus, at)
      } else if (stimulus.kind === 'executor_progress') {
        runtime.postExecutorProgress(stimulus.dispatch_index, stimulus, at)
      } else if (stimulus.kind === 'executor_observation') {
        runtime.postExecutorObservation(stimulus.dispatch_index, stimulus, at)
      } else if (stimulus.kind === 'raw_progress') {
        runtime.post({
          kind: 'progress',
          payload: {
            channel: stimulus.channel,
            delegate_id: stimulus.delegate_id,
            op: stimulus.op,
            phase: stimulus.phase,
            internal_activity: stimulus.internal_activity,
            elapsed: stimulus.elapsed,
            summary: stimulus.summary,
          },
        }, at)
      } else if (stimulus.kind === 'raw_observation') {
        runtime.post({
          kind: 'observation',
          payload: {
            channel: stimulus.channel,
            delegate_id: stimulus.delegate_id,
            op: stimulus.op,
            origin_ref: stimulus.origin_ref,
            trust: stimulus.trust,
            content: stimulus.content,
            refs: stimulus.refs,
          },
        }, at)
      }
      if (stimulus.kind !== 'advance_clock') drainReady(clock, runtime, scheduler)
    }
    for (const stimulus of group) {
      if (stimulus.kind === 'advance_clock') {
        advanceBefore(clock, runtime, scheduler, stimulus.to)
        clock.advanceTo(stimulus.to)
      }
    }
  }

  while (runtime.queue.size > 0 || scheduler.size > 0) {
    const next = earliest(runtime.queue.nextTimestamp(), scheduler.nextTimestamp())
    if (next === undefined) break
    advanceAndDrain(clock, runtime, scheduler, next)
  }
  for (const slot of SLOTS) {
    if (scripts[slot].length > 0) {
      throw new Error(`unused ${slot} outputs: ${scripts[slot].length}`)
    }
  }
  for (const [name, completions] of Object.entries(executorScripts)) {
    if (completions.length > 0) throw new Error(`unused ${name} outputs: ${completions.length}`)
  }
  runtime.assertQuiescent()
  ids.assertExhausted()
  const snapshot = runtimeSnapshot(runtime)
  return fixtureExpectedSchema.parse({
    ...snapshot,
    model_views: modelViews,
    outbound_desktop: outboundDesktop,
    ...(playbackEffects.length === 0 ? {} : {playback_effects: playbackEffects}),
  })
}

function decodeFixturePcm(value: string): Uint8Array {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.byteLength === 0 || decoded.toString('base64') !== value) {
    throw new Error('fixture PCM must use canonical non-empty base64')
  }
  return decoded
}

function advanceBefore(
  clock: VirtualClock,
  runtime: CoreRuntime,
  scheduler: FixtureModelScheduler,
  target: number,
): void {
  if (target < clock.now()) throw new RangeError(`fixture clock cannot move backwards: ${target}`)
  while (true) {
    const next = earliest(runtime.queue.nextTimestamp(), scheduler.nextTimestamp())
    if (next === undefined || next >= target) return
    clock.advanceTo(next)
    drainReady(clock, runtime, scheduler)
  }
}

function advanceAndDrain(
  clock: VirtualClock,
  runtime: CoreRuntime,
  scheduler: FixtureModelScheduler,
  target: number,
): void {
  if (target < clock.now()) throw new RangeError(`fixture clock cannot move backwards: ${target}`)
  while (true) {
    const next = earliest(runtime.queue.nextTimestamp(), scheduler.nextTimestamp())
    if (next === undefined || next > target) break
    clock.advanceTo(next)
    drainReady(clock, runtime, scheduler)
  }
  clock.advanceTo(target)
  drainReady(clock, runtime, scheduler)
}

function drainReady(
  clock: VirtualClock,
  runtime: CoreRuntime,
  scheduler: FixtureModelScheduler,
): void {
  while (true) {
    scheduler.materializeDue(clock.now(), runtime)
    const event = runtime.queue.popReady(clock.now())
    if (event === undefined) return
    runtime.apply(event)
  }
}

class FixtureModelScheduler {
  readonly #pending: ScheduledFixtureCompletion[] = []
  #sequence = 0

  schedule(jobId: string, output: unknown, due: number): void {
    if (!Number.isFinite(due)) throw new TypeError(`model completion timestamp is invalid: ${due}`)
    this.#sequence += 1
    this.#pending.push({
      kind: 'model',
      jobId,
      output: structuredClone(output),
      due,
      sequence: this.#sequence,
    })
    this.#sort()
  }

  scheduleExecutor(dispatchIndex: number, output: unknown, due: number): void {
    if (!Number.isFinite(due)) throw new TypeError(`executor completion timestamp is invalid: ${due}`)
    this.#sequence += 1
    this.#pending.push({
      kind: 'executor',
      dispatchIndex,
      output: structuredClone(output),
      due,
      sequence: this.#sequence,
    })
    this.#sort()
  }

  #sort(): void {
    this.#pending.sort((left, right) => left.due - right.due || left.sequence - right.sequence)
  }

  materializeDue(now: number, runtime: CoreRuntime): void {
    while (this.#pending[0]?.due !== undefined && this.#pending[0].due <= now) {
      const completion = this.#pending.shift()!
      if (completion.kind === 'model') {
        runtime.completeModelCall(completion.jobId, completion.output, completion.due)
      } else {
        runtime.postExecutorResult(completion.dispatchIndex, completion.output, completion.due)
      }
    }
  }

  nextTimestamp(): number | undefined {
    return this.#pending[0]?.due
  }

  get size(): number {
    return this.#pending.length
  }
}

function earliest(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.min(left, right)
}

function runtimeSnapshot(runtime: CoreRuntime): FixtureExpected {
  const channels = Object.fromEntries([...runtime.memory.channels].map(([name, channel]) => [
    name,
    structuredClone(channel.items),
  ]))
  const summaries = Object.fromEntries([...runtime.memory.channels].map(([name, channel]) => [
    name,
    channel.summary,
  ]))
  return fixtureExpectedSchema.parse({
    schema_version: 1,
    model_views: [],
    applied_events: runtime.appliedEvents,
    memory: {
      channels,
      structured: runtime.memory.structured,
      summaries,
    },
    delegates: runtime.activeDelegates(),
    suggestions: runtime.suggestions.all().map(suggestion => ({
      ...suggestion,
      expires_at: Number.isFinite(suggestion.expires_at) ? suggestion.expires_at : null,
    })),
    floor_decisions: runtime.floorDecisions,
    outbound_desktop: [],
    executor_effects: runtime.executorEffects,
    diagnostics: runtime.diagnostics,
  })
}
