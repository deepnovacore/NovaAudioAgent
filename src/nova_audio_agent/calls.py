"""The driver for one FastBrain call: a compiled view goes in, one CallRecord comes out.

It doesn't live in runtime.py, because that file should hold only three things:
the loop, the apply dispatch table, and the wake table. "How one call runs"
isn't the loop's business.

## Why the two-axis output is a record, not an in-place effect

The task that runs the stream **lands nothing**: it only puts the result into
the job table. Real consumption happens the moment `model_done` is applied —
at that point the loop is synchronous, so the four steps of `on_done`
(consume → take pending → clear inflight → rerun if pending) are naturally
atomic. Writing into the in-flight table in place inside the task would split
those four steps across two runs, and the single-flight discipline of R1
would fail on the spot.

**The speech axis is an exception, and it must be.** Text has to go out the
moment it's received; buffering it until `model_done` is applied would be
"harness buffering," and 04-ports.md says that's exactly the one half we
actually control, and also where scenario 2 lands. So: the sink is invoked
inside the task, while the two-axis output is consumed in apply.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from nova_audio_agent.context_view import ContextView
from nova_audio_agent.events import WakeReason
from nova_audio_agent.memory import MemoryRef
from nova_audio_agent.ports import (
    ActionDelta,
    ActionOutput,
    ContractFailureDelta,
    FastBrain,
    SpeakAct,
    SpeakActDelta,
    Surrogate,
    SurrogateOutput,
    TextDelta,
)
from nova_audio_agent.slots import Slot
from nova_audio_agent.speech import SpeechSink

# The model took no action this turn. The default for the action axis half of
# the nine combinations (D5).
NO_ACTION = ActionOutput(act="none")

# The two ends of Floor. **Only the core knows Floor's current state**, and
# only it can post events, so this only takes two callbacks instead of the
# whole Runtime.
# `open_floor` returns whether speaking is allowed; if so, it has already
# posted speak_start along the way.
OpenFloor = Callable[[str, int], bool]
CloseFloor = Callable[[str], None]


@dataclass(frozen=True, slots=True)
class CallRecord:
    """Everything one call produces.

    `view` isn't kept for debugging: the third check on `origin_ref` needs to
    ask "is this ref inside the context this call saw?", and by the time
    apply runs that view is long gone — memory has moved on. That's the only
    reason the whole view gets recorded in the job table.

    `spoken_text` and the chunks inside the sink are two different things,
    not a duplicate: the sink is the **output device** (once phase C swaps
    in TTS, it keeps no record), while this field is the copy that gets
    written to the conversation channel.

    `deferred` only speaks to the fate of the speech axis: Floor pushed this
    utterance down, so it should land in the suggestion pool instead of the
    conversation channel. **It does not affect the action axis.** If written
    as "defer aborts this call," then the "dim the lights + play a movie"
    case would lose the light too — the orthogonality of the nine
    combinations (D5) would break right there.

    `speak_act` is the type for the speech-axis half; when deferred, it
    decides whether the pool entry is recorded as `question` or `notify`
    (R29). Defaults to `say`: if the model doesn't tag it, it's a statement.

    `selected_suggestion` is the suggestion id carried down from the second
    hop of two-hop speaking — **the one the surrogate selected**. It rides
    along with the record for the whole trip because `fired` has to be
    marked at the instant the words actually go out (R26), and that happens
    in apply; by then it's long gone from the runtime (the view-compiling
    step already took it and cleared it — otherwise step 4 of `on_done`,
    the pending rerun, would carry it off).

    `action` is this turn's **first** action, and `extra_actions` counts how
    many more came after it. The action axis is still singular (D5), so the
    extras aren't "the last one wins" — they're a conflict. This used to
    overwrite entry by entry: two `set_light` calls (living room, bedroom)
    coming in would leave only the bedroom one, and the living-room half of
    the request wouldn't leave a single record. So the count gets recorded;
    how to handle it is `runtime._consume`'s call (R47).
    """

    slot: Slot
    reason: WakeReason
    view: ContextView
    utterance_id: str
    spoken_text: str
    action: ActionOutput
    deferred: bool = False
    speak_act: SpeakAct = "say"
    selected_suggestion: str | None = None
    extra_actions: int = 0
    contract_failures: tuple[ContractFailureDelta, ...] = ()


async def run_fast_brain_call(
    fastbrain: FastBrain,
    *,
    view: ContextView,
    reason: WakeReason,
    utterance_id: str,
    sink: SpeechSink,
    open_floor: OpenFloor,
    close_floor: CloseFloor,
    selected_suggestion: str | None = None,
) -> CallRecord:
    """Runs one stream to completion. Text is **forwarded the moment it's
    received**; the structured half (action axis + the speech-axis act) is
    accumulated until the end.

    Accumulating the action axis isn't laziness: the real provider's arrival
    order is always "text finishes → tool_calls" (per the spike measurements
    in 04-ports.md), so whether it's accumulated or not it ends up at the end
    anyway; and dispatch has to land in step 1 of `on_done` so that the
    pending rerun can see this new in-flight work.

    **Arbitration happens the instant the first chunk of text arrives,
    before it enters the sink** (R5). Any later is too late: asking "should
    I be speaking?" after the words are already out is meaningless. So
    `open_floor` sits right above `sink.emit`, not before the stream starts
    — at stream start it's not yet known whether there's anything to say
    this time, and a `(none, delegate)` combination would burn a turn of the
    floor for nothing.
    """
    said: list[str] = []
    # Collect **every** action-axis delta, don't overwrite one with the next.
    # Overwriting is silent: the real provider's `tool_calls` is an array,
    # which can naturally express two calls in one turn, and overwriting
    # would leave the earlier ones without a single record (R47). How to
    # handle them is `_consume`'s call; here the only job is not to lose them.
    actions: list[ActionOutput] = []
    contract_failures: list[ContractFailureDelta] = []
    speak_act: SpeakAct = "say"  # If the model doesn't tag it, it's a statement (R29)
    speaking: bool | None = None  # None = this call hasn't produced a single character yet
    async for delta in fastbrain.call(view):
        if isinstance(delta, TextDelta):
            # An empty delta doesn't count as speaking. The real provider's
            # first chunk often carries only a role, no content — treating it
            # as the first token would burn a turn of the floor for nothing,
            # and the `preempt` line would cut off someone else's ongoing
            # utterance in exchange for not a single word.
            if not delta.text:
                continue
            if speaking is None:
                speaking = open_floor(utterance_id, reason.priority)
            # Forward first, record second. This order *is* "no buffering":
            # `said` is the copy kept for the conversation channel, not a
            # queue for the output — the sink already got it on the line above.
            if speaking:
                sink.emit(utterance_id, delta.text)
            # Even a deferred utterance is collected in full: the whole thing
            # needs to go into the suggestion pool, and the stream won't
            # yield tool_calls until it's fully consumed.
            said.append(delta.text)
        elif isinstance(delta, SpeakActDelta):
            speak_act = delta.act
        elif isinstance(delta, ActionDelta):
            actions.append(delta.action)
        else:
            contract_failures.append(delta)
    if speaking:
        sink.end(utterance_id)
        close_floor(utterance_id)
    return CallRecord(
        slot="fast",
        reason=reason,
        view=view,
        utterance_id=utterance_id,
        spoken_text="".join(said),
        action=actions[0] if actions else NO_ACTION,
        deferred=speaking is False,
        speak_act=speak_act,
        selected_suggestion=selected_suggestion,
        extra_actions=max(len(actions) - 1, 0),
        contract_failures=tuple(contract_failures),
    )


@dataclass(frozen=True, slots=True)
class AttentionTrigger:
    suggestion_id: str
    delegate_id: str
    channel: str
    memory_ref: MemoryRef


@dataclass(frozen=True, slots=True)
class AttentionDecision:
    channel: str
    memory_ref: MemoryRef
    speak: bool
    selected: bool


@dataclass(frozen=True, slots=True)
class WatchRecord:
    """What one Surrogate call produces, without FastBrain's speech axis.

    `reason` rides along for the second hop: once the surrogate selects a
    suggestion, FastBrain must be woken to speak it, and that wake's
    priority has to inherit the event that triggered this watch (Floor's
    invariant). The product is handed off through the job table, and by
    handoff time that `reason` is long gone from hand — the only place left
    to record it is here.

    `offered` is **the ids of the suggestions actually put on the table this
    time** (R40). Without it, "the surrogate selected a suggestion it never
    even saw" can't be checked in the core: checking only current
    availability would let through a suggestion that just rearmed during
    this call's flight — the surrogate looked at the old table but answers
    with an id it never saw, and that's exactly the shape of a
    hallucination.

    **No `view`**: FastBrain's copy is kept for the third check on
    `origin_ref`, but the surrogate doesn't dispatch, so it has no ref to
    check. `offered` keeps only ids, not the whole view: what needs checking
    is "is this id on that table," and keeping the whole view would be
    storing an entire snapshot just for a set-membership check.

    `trigger` binds a progress verdict to the one candidate that caused this
    call. It keeps only routing identity and the evidence ref; model-facing
    content stays out of the in-process attention callback.
    """

    reason: WakeReason
    output: SurrogateOutput
    offered: tuple[str, ...] = ()
    trigger: AttentionTrigger | None = None


async def run_surrogate_call(
    surrogate: Surrogate,
    *,
    view: ContextView,
    reason: WakeReason,
    trigger: AttentionTrigger | None = None,
) -> WatchRecord:
    """Runs one surrogate call. **Same ContextView, the only difference is
    the prompt** (D11).

    Thin as this is, it still gets its own function only because `reason`
    and `offered` need to go into the job table alongside the product; the
    real asymmetry lies elsewhere: the surrogate never touches the sink or
    Floor, because it doesn't generate speech.

    `offered` is plucked from the view **before the call**: by the time the
    call returns, the world has moved on a bit, and plucking it then would
    grab a different table — while what needs checking is exactly the table
    the surrogate saw at the time.
    """
    offered = tuple(
        affordance.ref for affordance in view.affordances if affordance.source == "suggestion"
    )
    return WatchRecord(
        reason=reason,
        output=await surrogate.watch(view),
        offered=offered,
        trigger=trigger,
    )
