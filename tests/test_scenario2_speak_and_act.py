"""Scenario 2: speaking and delegating in the same turn (06-verification.md, second acceptance line).

One utterance produces both `SpeakAct=say` and `ActAct=delegate` at once: the text goes through the
streaming channel, the delegate goes through the structured one.

**The anti-regression assertion was swapped out (R24).** The original assertion was "`speak_start`
precedes the delegate dispatch", but the dispatch lands in `on_done` step 1, and `on_done` can only
happen after the stream ends — even a degenerate implementation that "buffers the whole stream and
flushes once at the end" satisfies it. It's vacuously true under a correct implementation and blocks
nothing. Replaced with **the timestamp of every chunk at the sink matching, chunk by chunk, the
timestamp at which the model emitted that chunk**: buffering the whole stream would bunch the sink's
timestamps all at the last moment, and half-buffering (only holding the first token) wouldn't match
either.
"""

from __future__ import annotations

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import UserInput
from nova_audio_agent.executors.sims import SlowSim
from nova_audio_agent.memory import CONVERSATION_CHANNEL, Memory
from nova_audio_agent.ports import ActionOutput, DelegateRequest, FastBrainOutput, SpeakOutput
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.speech import RecordingSink
from fakes import ScriptedFastBrain
from policies import SIM_POLICIES
from snapshot import assert_snapshot, to_snapshot

DIM_LIGHT = DelegateRequest(
    executor="slow_sim",
    op="set_light",
    request={"room": "客厅", "brightness": 30},
    origin_ref="conversation:1",
)
LATENCY = 0.25  # same reason as scenario 1: 0.1 isn't an exact binary value, the snapshot would be full of trailing-digit noise


async def _run_scenario() -> tuple[Runtime, ScriptedFastBrain, RecordingSink]:
    """One user utterance -> one call that produces both axes -> handoff comes back -> one more utterance."""
    clock = VirtualClock()
    brain = ScriptedFastBrain(
        [
            FastBrainOutput(
                speak=SpeakOutput(act="say", text="灯这就调暗，今晚这部片子挺合适"),
                action=ActionOutput(act="delegate", delegate=DIM_LIGHT),
            ),
            FastBrainOutput(
                speak=SpeakOutput(act="say", text="灯调好了"),
                action=ActionOutput(act="none"),
            ),
        ],
        clock=clock,
        latency=LATENCY,
    )
    sink = RecordingSink(clock)
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=SIM_POLICIES),
        fastbrain=brain,
        executors={"slow_sim": SlowSim()},
        sink=sink,
    )
    runtime.post(UserInput(text="把客厅灯调暗点，顺便说说今晚看什么"))

    await runtime.run()

    return runtime, brain, sink


async def test_one_call_produces_both_axes() -> None:
    """Scenario 2's main point: in the same call, the speak axis produced words and the act axis delegated work."""
    runtime, brain, sink = await _run_scenario()

    assert len(brain.views) == 2  # once for the user's utterance, once for the handoff coming back
    assert sink.text_of("u-1") == "灯这就调暗，今晚这部片子挺合适"
    # The work dispatched in this same call: origin_ref points at the user's utterance, and routing_class
    # is inherited along the causal chain.
    assert runtime.delegates.terminated_by("d-1") == "handoff"
    dispatched = runtime.delegates.find("d-1")
    assert dispatched is not None
    assert dispatched.origin_ref == "conversation:1"
    assert dispatched.routing_class == "user_awaited"
    # The speak-axis half lands back in the conversation channel; the act-axis half lands in the executor channel.
    said = [
        item.content["text"]
        for item in runtime.memory.channels[CONVERSATION_CHANNEL].items
        if item.trust == "trusted_system"
    ]
    assert said == ["灯这就调暗，今晚这部片子挺合适", "灯调好了"]
    assert len(runtime.memory.channels["slow_sim"].items) == 1


async def test_the_sink_gets_each_chunk_at_the_moment_the_model_produced_it() -> None:
    """Anti-regression (R24): the chunk timestamps at the sink match, chunk by chunk, the timestamps
    at which the model emitted them.

    The fake sleeps 0.25 between chunks, so a correct implementation records a strictly increasing
    sequence of timestamps. An implementation that buffers the whole stream records a sequence of
    identical timestamps (all equal to the moment the stream ended); a half-buffered implementation
    that "only holds the first token and buffers the rest" doesn't match either — only its first
    chunk would line up.

    The timestamp is obtained by the sink asking the clock itself (`RecordingSink(clock)`), not
    passed in by the caller. This was added in the second round of codex review: if it were passed
    in, an implementation that "buffers the chunks, flushes them all at once at the end, and
    backfills the timestamps it originally received" would still pass fully green — that
    implementation was actually caught fooling this assertion.
    """
    _, brain, sink = await _run_scenario()

    assert (
        len(brain.emitted) == 4
    )  # 3 chunks for the first utterance, 1 for the second; they need to be distinguishable for "chunk by chunk" to mean anything
    assert [(chunk.ts, chunk.text) for chunk in sink.chunks] == brain.emitted
    # Each chunk also has to be tied to **its own utterance**: comparing only (ts, text) wouldn't
    # catch the second utterance being misattributed to the first.
    assert [chunk.utterance_id for chunk in sink.chunks] == ["u-1", "u-1", "u-1", "u-2"]
    # Strictly increasing, not the same instant — the previous assertion degenerates into a vacuous
    # check when the "fake only emits one chunk".
    timestamps = [chunk.ts for chunk in sink.chunks]
    assert timestamps == sorted(timestamps)
    assert len(set(timestamps)) == len(timestamps)


async def test_the_floor_is_taken_and_returned_once_per_utterance() -> None:
    """The floor is taken once and returned once per utterance, at the priority of the wake that
    triggered it.

    **The two timing assertions below are structural checks, not anti-regression guarantees**
    (codex review round two):
    - `starts[0].ts <= sink.chunks[0].ts` reads the same virtual instant on both sides, so it
      evaluates to True whether arbitration happens before or after the emit. The real enforcement
      point for the R5 discipline is the defer assertion in `tests/test_speech.py` — moving
      arbitration to after the emit makes its `sink.chunks == []` fail immediately (verified with
      mutation K).
    - `speak_start < model_done` is the shape of the original assertion from 06-verification.md,
      and it's **vacuously true** under an implementation that dispatches in on_done (that's
      exactly what R24 replaced it for). Kept here as a scenario-level sanity check.
    """
    runtime, _, sink = await _run_scenario()

    kinds = [event.KIND for event in runtime.applied]
    starts = [event for event in runtime.applied if event.KIND == "speak_start"]
    ends = [event for event in runtime.applied if event.KIND == "speak_end"]

    assert [event.utterance_id for event in starts] == ["u-1", "u-2"]
    assert [event.utterance_id for event in ends] == ["u-1", "u-2"]
    assert starts[0].priority == 100  # triggered by the user's utterance, USER_PRIORITY
    assert starts[0].ts <= sink.chunks[0].ts
    assert kinds.index("speak_start") < kinds.index("model_done") < kinds.index("handoff")
    assert runtime.floor.state == "idle"  # returned once the utterance is done


async def test_context_view_snapshots_of_every_model_call() -> None:
    """One snapshot per model call.

    Both snapshots' `floor` is `idle`: the view is assembled in `_spawn_slot`, before the stream has
    started and before the floor has been requested. FastBrain can't see that "it is currently
    speaking" — it can only see what it has **already said** (the `trusted_system`
    conversation-channel item in the second snapshot).
    """
    _, brain, _ = await _run_scenario()

    for index, view in enumerate(brain.views, start=1):
        assert_snapshot(f"scenario2_call{index}", to_snapshot(view))
