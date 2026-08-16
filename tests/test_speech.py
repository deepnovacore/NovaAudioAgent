"""The Floor guards the exit: all three arbitration branches, each on its real code path
(01-spine.md, the Floor section).

`tests/test_floor.py` verifies the three-state table itself. This one verifies **it wired into the
main runtime**: who calls `decide` and when, and where the verdict goes afterward.

## Why two use cases assign an initial value to `runtime.floor` directly

Nothing in B2 can produce `user_speaking` — its source is ASR/VAD, which is scheduled for stage C.
`agent_speaking` can genuinely occur, but the single-flight discipline (R1) guarantees only one fast
call at a time, so "one utterance is being spoken while another comes in to preempt it" can't be
constructed within B2 either. Neither case is "too lazy to build the scenario" — **this generation of
the system genuinely cannot reach that state.** Assigning the initial value tests the arbitration
branch itself, which is the seam between Floor and the main runtime, not Floor's internals.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.context_view import ContextView
from nova_audio_agent.events import UserInput
from nova_audio_agent.executors.sims import SlowSim
from nova_audio_agent.floor import Floor
from nova_audio_agent.memory import CONVERSATION_CHANNEL, Memory
from nova_audio_agent.ports import (
    ActionDelta,
    ActionOutput,
    DelegateRequest,
    FastBrain,
    FastBrainDelta,
    FastBrainOutput,
    SpeakOutput,
    TextDelta,
)
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.speech import RecordingSink
from fakes import ScriptedFastBrain
from policies import SIM_POLICIES

DIM_LIGHT = DelegateRequest(
    executor="slow_sim",
    op="set_light",
    request={"room": "客厅", "brightness": 30},
    origin_ref="conversation:1",
)
SAY_AND_DELEGATE = FastBrainOutput(
    speak=SpeakOutput(act="say", text="灯这就调暗"),
    action=ActionOutput(act="delegate", delegate=DIM_LIGHT),
)
ASK_ONLY = FastBrainOutput(
    speak=SpeakOutput(act="ask", text="要顺手把窗帘也拉上吗？"),
    action=ActionOutput(act="none"),
)
ASK_AND_DELEGATE = FastBrainOutput(
    speak=SpeakOutput(act="ask", text="要顺手把窗帘也拉上吗？"),
    action=ActionOutput(act="delegate", delegate=DIM_LIGHT),
)


async def _run_with(
    clock: VirtualClock, brain: FastBrain, *, floor: Floor
) -> tuple[Runtime, RecordingSink]:
    sink = RecordingSink(clock)
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=SIM_POLICIES),
        fastbrain=brain,
        executors={"slow_sim": SlowSim()},
        sink=sink,
    )
    runtime.floor = floor
    runtime.post(UserInput(text="把客厅灯调暗点"))

    await runtime.run()

    return runtime, sink


async def _run(*, floor: Floor, output: FastBrainOutput) -> tuple[Runtime, RecordingSink]:
    clock = VirtualClock()
    brain = ScriptedFastBrain([output], clock=clock, latency=0.25)
    return await _run_with(clock, brain, floor=floor)


class EmptyFirstDelta:
    """The first text segment is an empty string. A real provider's first chunk often carries only
    the role, no content.

    `ScriptedFastBrain` can't produce this shape (`_chunks` returns an empty sequence for empty
    text), so this fake, which exists only for this one use case, is necessary rather than lazy
    duplication.
    """

    def __init__(self, clock: VirtualClock) -> None:
        self._clock = clock
        self._calls = 0

    async def call(self, view: ContextView) -> AsyncIterator[FastBrainDelta]:
        self._calls += 1
        await self._clock.sleep(0.25)
        if (
            self._calls > 1
        ):  # silent on the call after handoff comes back, otherwise it keeps redispatching the same job
            return
        yield TextDelta(text="")
        await self._clock.sleep(0.25)
        yield ActionDelta(action=ActionOutput(act="delegate", delegate=DIM_LIGHT))


async def test_an_idle_floor_lets_the_utterance_through() -> None:
    """Row one: `idle` -> allow."""
    runtime, sink = await _run(floor=Floor(), output=SAY_AND_DELEGATE)

    assert sink.utterances() == ["灯这就调暗"]
    assert [event.KIND for event in runtime.applied].count("speak_start") == 1
    assert runtime.suggestions.all() == ()


async def test_a_louder_utterance_preempts_the_one_already_speaking() -> None:
    """Row two: `agent_speaking` and the new one is more urgent -> preempt.

    Preemption and letting-through take the same path (both post a speak_start); the difference is
    **afterward**: the Floor switches entirely to this new utterance, and the old one is no longer
    "current".
    Actually cutting off the previous utterance has no corresponding action under the text CLI —
    that only exists once TTS is wired in, which is a matter of swapping the sink.
    """
    runtime, sink = await _run(
        floor=Floor(state="agent_speaking", utterance_id="u-旧", priority=10),
        output=SAY_AND_DELEGATE,
    )

    assert sink.utterances() == ["灯这就调暗"]
    start = next(event for event in runtime.applied if event.KIND == "speak_start")
    assert start.utterance_id == "u-1"
    assert start.priority == 100  # the user utterance's priority, 10 < 100 so it can preempt
    # The old utterance doesn't get a speak_end appended for it: its late end is blocked by the
    # Floor itself recognizing the utterance_id no longer matches.
    assert [event.utterance_id for event in runtime.applied if event.KIND == "speak_end"] == ["u-1"]


async def test_a_deferred_utterance_goes_to_the_pool_while_the_action_axis_still_dispatches() -> (
    None
):
    """Row three: `user_speaking` -> defer. **Only the speak axis is held back; the act axis
    dispatches as usual.**

    If defer were implemented as "abort this whole call", then this "dim the light + say a line"
    utterance would lose even the light — the two-axes-are-orthogonal property (D5's nine
    combinations) would be gone right there. This use case exists to pin exactly that down.

    The suppressed utterance goes into the suggestion pool — it isn't dropped, and it isn't queued
    (02-memory.md): queuing would mean it automatically gets said once the user finishes talking, but
    by then it's usually stale.
    """
    runtime, sink = await _run(floor=Floor(state="user_speaking"), output=SAY_AND_DELEGATE)

    # Speak axis: not a single character went out, and the floor was never taken.
    assert sink.chunks == []
    assert [event.KIND for event in runtime.applied if event.KIND.startswith("speak_")] == []
    assert runtime.floor.state == "user_speaking"  # nobody released it on the user's behalf
    # That whole utterance went into the pool, and it's **not** mixed into the conversation channel —
    # it was never actually spoken.
    pooled = runtime.suggestions.all()
    assert [item.content["text"] for item in pooled] == ["灯这就调暗"]
    assert pooled[0].origin == "fast_brain"
    assert (
        pooled[0].salience == 100.0
    )  # borrowing this wake's priority for now; the real formula comes in B4
    assert all(
        item.trust != "trusted_system"
        for item in runtime.memory.channels[CONVERSATION_CHANNEL].items
    )
    # Act axis: the light gets dimmed regardless, all the way through to handoff.
    assert runtime.delegates.terminated_by("d-1") == "handoff"
    assert len(runtime.memory.channels["slow_sim"].items) == 1


async def test_a_deferred_question_lands_in_the_pool_as_a_question_not_a_notice() -> None:
    """`(ask, none)` gets suppressed: the pooled item's `kind` is `question` (R29).

    Of 02-memory.md's three entry points, the one for FastBrain explicitly says "when `(ask, ...)`
    is deferred, the **question** lands in the pool." Recording everything as `notify` would make it
    impossible for B4 to tell "should I ask them" apart from "should I tell them" — and B4 is the
    pool's first consumer.

    This cell (act axis `none`) is the reason `SpeakActDelta` has to be its own kind of delta:
    if it were attached to `ActionDelta`, this call wouldn't produce any act-axis output at all, and
    the act would still get dropped.
    """
    runtime, sink = await _run(floor=Floor(state="user_speaking"), output=ASK_ONLY)

    assert sink.chunks == []
    pooled = runtime.suggestions.all()
    assert [(item.kind, item.content["text"]) for item in pooled] == [
        ("question", "要顺手把窗帘也拉上吗？")
    ]


async def test_a_deferred_question_that_also_dispatches_keeps_both_halves() -> None:
    """`(ask, delegate)` gets suppressed: the question lands in the pool as `question`, and the light
    still gets dimmed.

    The only difference from the previous use case is the act axis. Both are needed: the previous
    one pins "act isn't dropped when there's no ActionDelta", this one pins "act also isn't
    overwritten by it when there is an ActionDelta".
    """
    runtime, sink = await _run(floor=Floor(state="user_speaking"), output=ASK_AND_DELEGATE)

    assert sink.chunks == []
    assert [item.kind for item in runtime.suggestions.all()] == ["question"]
    assert runtime.delegates.terminated_by("d-1") == "handoff"


async def test_an_empty_text_delta_is_not_a_first_token() -> None:
    """An empty delta doesn't count as speaking: it doesn't take the floor, doesn't reach the sink,
    and the act axis still dispatches.

    The port type allows `TextDelta(text="")`, and a real provider's first chunk is often exactly
    that. Treating it as the first token would take the floor for nothing — the `preempt` branch
    would even cut off whatever someone else was saying, in exchange for not a single character
    (codex review round two).
    """
    clock = VirtualClock()
    runtime, sink = await _run_with(clock, EmptyFirstDelta(clock), floor=Floor())

    assert sink.chunks == []
    assert [event.KIND for event in runtime.applied if event.KIND.startswith("speak_")] == []
    assert runtime.floor.state == "idle"
    assert runtime.delegates.terminated_by("d-1") == "handoff"


async def test_a_silent_call_never_asks_for_the_floor() -> None:
    """`(none, delegate)`: a call that says nothing at all must not take the floor for nothing.

    So arbitration is gated on **the instant right before the first text segment reaches the sink**,
    not on the moment the stream starts — at stream-start time it isn't known yet whether this call
    will say anything at all.
    """
    runtime, sink = await _run(
        floor=Floor(),
        output=FastBrainOutput(
            speak=SpeakOutput(act="none"),
            action=ActionOutput(act="delegate", delegate=DIM_LIGHT),
        ),
    )

    assert sink.chunks == []
    assert [event.KIND for event in runtime.applied if event.KIND.startswith("speak_")] == []
    assert runtime.floor.state == "idle"
    assert runtime.delegates.terminated_by("d-1") == "handoff"
