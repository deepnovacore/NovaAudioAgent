/**
 * One Surrogate call, run to completion.
 *
 * Ports the Surrogate half of `src/nova_audio_agent/calls.py`. The FastBrain half left
 * with the text front brain: the realtime provider owns the user turn, so nothing in
 * this module streams or arbitrates the Floor any more.
 */

import type { ContextView } from './context-view.js'
import type { WakeReason } from './slots.js'

export interface AttentionTrigger {
  readonly suggestion_id: string
  readonly delegate_id: string
  readonly channel: string
  readonly memory_ref: string
}

export interface SurrogateVerdictOutput {
  readonly speak: boolean
  readonly suggestion_id: string | null
  readonly progress_class: 'routine_delta' | 'milestone' | 'blocker' | 'action_required' | null
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

export type SurrogateVerdictAttribution =
  | 'silent'
  | 'missing_selection'
  | 'selection_not_offered'
  | 'selected'

/** Classify only bounded contract state; never expose the model's free-form reason. */
export function classifySurrogateVerdict(record: WatchRecord): SurrogateVerdictAttribution {
  if (!record.output.speak) return 'silent'
  const selected = record.output.suggestion_id
  if (selected === null) return 'missing_selection'
  return record.offered.includes(selected) ? 'selected' : 'selection_not_offered'
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
