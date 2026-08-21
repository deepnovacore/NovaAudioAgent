/**
 * One model call, run to completion, with the speech axis forwarded as it streams.
 *
 * Ports `src/nova_audio_agent/calls.py`. This module is the boundary where a streaming
 * provider meets Floor arbitration, and its ordering rules are behavior, not style:
 * text goes out the moment it arrives, and the Floor is consulted at the first
 * non-empty chunk rather than at stream start.
 */

import type { ContextView } from './context-view.js'
import type { FastBrainDelta } from './model-adapters.js'
import type { DelegateAction, UpdateAction } from './model-adapters.js'
import type { Slot, WakeReason } from './slots.js'

export type SpeakAct = 'say' | 'ask'

export interface NoAction {
  readonly act: 'none'
}

export type CallAction = NoAction | DelegateAction | UpdateAction

export const NO_ACTION: NoAction = {act: 'none'}

export interface ContractFailure {
  readonly code: string
  readonly tool_name: string | null
}

/** Emits speech chunks to the output device. Keeps no record of its own. */
export interface SpeechSink {
  emit(utteranceId: string, text: string): void
  end(utteranceId: string): void
}

/** Returns whether this utterance may actually be voiced. */
export type OpenFloor = (utteranceId: string, priority: number) => boolean
export type CloseFloor = (utteranceId: string) => void

/**
 * Everything one call produces.
 *
 * `view` is retained because the third `origin_ref` check has to ask whether a ref was
 * inside the context this call saw, and by apply time that view is gone.
 *
 * `spoken_text` is not a duplicate of what the sink received: the sink is the output
 * device and keeps no record, while this is the copy written to the conversation
 * channel.
 *
 * `deferred` speaks only to the fate of the speech axis. It does not cancel the action
 * axis: treating defer as "abort the call" would lose the light in a "dim the lights and
 * play a movie" turn.
 *
 * `action` is this turn's FIRST action and `extra_actions` counts the surplus. The
 * action axis is singular, so extras are a conflict rather than last-one-wins; an
 * earlier design overwrote them, which silently dropped one of two set_light calls.
 */
export interface CallRecord {
  readonly slot: Slot
  readonly reason: WakeReason
  readonly view: ContextView
  readonly utterance_id: string
  readonly spoken_text: string
  readonly action: CallAction
  readonly deferred: boolean
  readonly speak_act: SpeakAct
  readonly selected_suggestion: string | null
  readonly extra_actions: number
  readonly contract_failures: readonly ContractFailure[]
}

export interface FastBrainPort {
  call(view: ContextView, signal?: AbortSignal): AsyncIterable<FastBrainDelta>
}

export interface FastBrainCallOptions {
  readonly view: ContextView
  readonly reason: WakeReason
  readonly utteranceId: string
  readonly sink: SpeechSink
  readonly openFloor: OpenFloor
  readonly closeFloor: CloseFloor
  readonly selectedSuggestion?: string | null
  readonly signal?: AbortSignal
}

/**
 * Run one FastBrain stream to completion.
 *
 * Text is forwarded the moment it is received; the structured half is accumulated until
 * the end. Accumulating the action axis is not laziness: the provider's arrival order is
 * always text-then-tool_calls, so it lands at the end either way, and dispatch has to
 * happen in the first step of completion handling so a pending rerun can see the new
 * in-flight work.
 */
export async function runFastBrainCall(
  fastbrain: FastBrainPort,
  options: FastBrainCallOptions,
): Promise<CallRecord> {
  const said: string[] = []
  // Collect EVERY action delta rather than overwriting: the provider's tool_calls is an
  // array and can legitimately carry two calls in one turn.
  const actions: CallAction[] = []
  const contractFailures: ContractFailure[] = []
  const speakAct: SpeakAct = 'say'
  // undefined means this call has not produced a single character yet.
  let speaking: boolean | undefined

  // The Floor must be released on every exit path, not only the normal one. Once
  // openFloor has posted speak_start and reserved the Floor, a throwing sink or a
  // rejecting iterator would otherwise strand that reservation: the trace keeps an
  // unmatched speak_start and every later equal-or-lower-priority utterance defers
  // forever against a stale active utterance. The oracle has this same gap -- its
  // `close_floor` also sits after the loop with no try/finally -- so this is a
  // deliberate repair rather than a reproduction.
  let opened = false
  try {
    for await (const delta of fastbrain.call(
      options.view,
      ...(options.signal === undefined ? [] : [options.signal]),
    )) {
      if (delta.kind === 'text') {
        // An empty delta does not count as speaking. The provider's first chunk often
        // carries only a role; treating it as the first token would burn a Floor turn and
        // the preempt path would cut off someone else's utterance for not one word.
        if (delta.text === '') continue
        // Arbitration happens the instant the first character arrives, before it enters
        // the sink. Asking "should I be speaking?" after the words are out is meaningless,
        // and asking at stream start is too early: it is not yet known whether there is
        // anything to say this turn. The compound assignment only fires while `speaking`
        // is still undefined, so the Floor is consulted exactly once per call.
        speaking ??= options.openFloor(options.utteranceId, options.reason.priority)
        opened ||= speaking
        // Forward first, record second. That order IS "no buffering": `said` is the copy
        // kept for the conversation channel, not a queue for the output device.
        if (speaking) options.sink.emit(options.utteranceId, delta.text)
        // A deferred utterance is still collected in full: the whole thing goes into the
        // suggestion pool, and the stream will not yield tool calls until it is drained.
        said.push(delta.text)
        continue
      }
      if (delta.kind === 'action') {
        actions.push(delta.action)
        continue
      }
      contractFailures.push({code: delta.code, tool_name: delta.tool_name})
    }
    if (opened) options.sink.end(options.utteranceId)
  } finally {
    // Release before the original failure propagates, and never let a failing release
    // replace the cause the caller needs to see.
    if (opened) {
      try {
        options.closeFloor(options.utteranceId)
      } catch {
        // A Floor release that itself fails must not mask the stream or sink error.
      }
    }
  }

  return {
    slot: 'fast',
    reason: options.reason,
    view: options.view,
    utterance_id: options.utteranceId,
    spoken_text: said.join(''),
    action: actions[0] ?? NO_ACTION,
    deferred: speaking === false,
    speak_act: speakAct,
    selected_suggestion: options.selectedSuggestion ?? null,
    extra_actions: Math.max(actions.length - 1, 0),
    contract_failures: contractFailures,
  }
}

export interface AttentionTrigger {
  readonly suggestion_id: string
  readonly delegate_id: string
  readonly channel: string
  readonly memory_ref: string
}

export interface SurrogateVerdictOutput {
  readonly speak: boolean
  readonly suggestion_id: string | null
  readonly reason: string
}

/**
 * What one Surrogate call produces, without FastBrain's speech axis.
 *
 * `reason` rides along for the second hop: once the Surrogate selects a suggestion,
 * FastBrain must be woken to speak it and that wake inherits the triggering event's
 * priority. By handoff time the reason is gone from hand, so this is the only place left
 * to record it.
 *
 * `offered` is the ids actually put on the table for THIS call. Checking only current
 * availability would let through a suggestion that rearmed mid-flight: the Surrogate
 * looked at the old table and answered with an id it never saw, which is exactly the
 * shape of a hallucination.
 *
 * No `view`: the Surrogate does not dispatch, so it has no `origin_ref` to check, and
 * keeping ids alone avoids storing a whole snapshot for a set-membership test.
 */
export interface WatchRecord {
  readonly reason: WakeReason
  readonly output: SurrogateVerdictOutput
  readonly offered: readonly string[]
  readonly trigger: AttentionTrigger | null
}

export interface SurrogatePort {
  watch(view: ContextView, signal?: AbortSignal): Promise<SurrogateVerdictOutput>
}

/**
 * Run one Surrogate call. Same ContextView as FastBrain; only the prompt differs.
 *
 * `offered` is plucked from the view BEFORE the call: by the time it returns the world
 * has moved on, and plucking it then would grab a different table than the one the
 * Surrogate actually saw.
 */
export async function runSurrogateCall(
  surrogate: SurrogatePort,
  options: {
    readonly view: ContextView
    readonly reason: WakeReason
    readonly trigger?: AttentionTrigger | null
    readonly signal?: AbortSignal
  },
): Promise<WatchRecord> {
  const offered = options.view.affordances
    .filter(affordance => affordance.source === 'suggestion')
    .map(affordance => affordance.ref)
  return {
    reason: options.reason,
    output: await surrogate.watch(
      options.view,
      ...(options.signal === undefined ? [] : [options.signal]),
    ),
    offered,
    trigger: options.trigger ?? null,
  }
}
