"""Structured State's sole writer: `ActAct=update` (02-memory.md / B4).

The three structs on the blackboard (Intent / Goal / Authorization) have **no automatic reducer**:
"should this handoff rewrite Intent" is a judgment call, and that judgment belongs to the model. The
main runtime here only does four mechanical things — recognize the field, normalize it, overwrite by
field, and bump `revision`.

So the use cases here mostly come in pairs: one verifies "the change landed correctly", the other
verifies "the untouched fields stayed exactly as they were". Writing only the former would let a
wholesale-reset implementation pass fully green too, and its cost wouldn't show up until some future
call from the model happens to omit one field — at which point no assertion would go red.
"""

from __future__ import annotations

import math

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import UserInput
from nova_audio_agent.memory import (
    CONVERSATION_CHANNEL,
    Goal,
    Intent,
    Memory,
    StructuredState,
)
from nova_audio_agent.ports import ActionOutput, FastBrainOutput, SpeakOutput, UpdateSpec
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.speech import RecordingSink
from fakes import ScriptedFastBrain
from policies import SIM_POLICIES

LATENCY = 0.25


def _update(target: str, **delta: object) -> FastBrainOutput:
    """A call that only touches a struct and says nothing at all. `(none, update)` from the nine combinations."""
    return FastBrainOutput(
        speak=SpeakOutput(act="none"),
        action=ActionOutput(act="update", update=UpdateSpec(target=target, delta=dict(delta))),
    )


def _loaded() -> StructuredState:
    """A struct that **already has content**. An empty one couldn't tell "overwrite" apart from "reset"."""
    return StructuredState(
        intent=Intent(
            objective_hypothesis="把客厅灯调到偏暗",
            constraints=("不要全关",),
            unresolved_questions=("要多暗？",),
            uncertainty=0.4,
            revision=2,
        ),
        goal=Goal(objective="客厅灯调暗", acceptance_criteria=("亮度 < 40%",), revision=1),
    )


async def _run(*outputs: FastBrainOutput) -> tuple[Runtime, ScriptedFastBrain]:
    clock = VirtualClock()
    brain = ScriptedFastBrain(list(outputs), clock=clock, latency=LATENCY)
    memory = Memory(policies=SIM_POLICIES)
    memory.structured = _loaded()
    runtime = Runtime(clock=clock, memory=memory, fastbrain=brain, sink=RecordingSink(clock))
    runtime.post(UserInput(text="灯稍微再暗一点"))

    await runtime.run()

    return runtime, brain


async def test_an_update_overwrites_the_named_fields_and_bumps_the_revision() -> None:
    runtime, _ = await _run(_update("intent", uncertainty=0.1))

    intent = runtime.memory.structured.intent
    assert intent.uncertainty == 0.1
    assert intent.revision == 3  # bumped by the runtime, not supplied by the model


async def test_an_update_leaves_the_fields_it_did_not_mention_alone() -> None:
    """The real point of R37. **With a wholesale reset, a call that only meant to change
    `uncertainty` would incidentally wipe out `constraints`** — so the model would have to re-supply
    the entire struct on every single call, and the one time it forgets a field, no assertion would
    go red.

    Taken alone, the previous use case would also pass fully green under a
    `replace(StructuredState(), intent=...)`-style implementation; only putting the two together
    tells them apart.
    """
    runtime, _ = await _run(_update("intent", uncertainty=0.1))

    intent = runtime.memory.structured.intent
    assert intent.objective_hypothesis == "把客厅灯调到偏暗"
    assert intent.constraints == ("不要全关",)
    assert intent.unresolved_questions == ("要多暗？",)
    # Neither of the other two structs should be affected by this at all.
    assert runtime.memory.structured.goal == _loaded().goal


async def test_a_list_from_the_model_lands_as_a_tuple() -> None:
    """Normalization, not indulgence: all three structs' multi-value fields are tuples, while the
    model's side of the JSON only has lists.

    Storing a list as-is would poke a mutable hole in the frozen shell — whoever gets hold of this
    struct could just append to it in place, and a snapshot would end up written a different way too.
    """
    runtime, _ = await _run(_update("intent", constraints=["不要全关", "别晃眼"]))

    assert runtime.memory.structured.intent.constraints == ("不要全关", "别晃眼")


async def test_an_unknown_field_becomes_an_observation_not_an_exception() -> None:
    """The model made up a field name that doesn't exist. **The result is an observation, not a crash.**

    `replace`'s TypeError would propagate straight out of apply, so one hallucinated field name would
    kill the whole loop — and hallucination is the norm here: the B1 probe measured it hitting twice
    out of three, redispatching a duplicate job each time.
    """
    runtime, _ = await _run(_update("intent", mood="轻松一点"))

    assert runtime.memory.structured == _loaded()  # not a single field was touched
    rejection = runtime.memory.channels[CONVERSATION_CHANNEL].items[-1]
    assert rejection.outcome == "failed"
    assert rejection.content["error"] == "update_rejected"
    assert rejection.content["target"] == "intent"
    assert rejection.content["unknown"] == ["mood"]


async def test_the_model_cannot_set_the_revision_itself() -> None:
    """`revision` is managed by the runtime (R3). If the model fills it in, that's a bad field and
    goes down the same rejection path as above.

    Letting it through would let the model set revision to any value it likes — and downstream code
    relies on it to tell "is this struct newer than what I last saw". A monotonic counter that can be
    hallucinated to 999 isn't a counter.
    """
    runtime, _ = await _run(_update("intent", uncertainty=0.1, revision=999))

    assert (
        runtime.memory.structured.intent.revision == 2
    )  # unchanged, this whole call had no effect
    assert runtime.memory.structured.intent.uncertainty == 0.4
    rejection = runtime.memory.channels[CONVERSATION_CHANNEL].items[-1]
    assert rejection.content["unknown"] == ["revision"]


# ---- All four validations run before `getattr` (R41) ----


async def test_a_target_the_model_invented_does_not_kill_the_loop() -> None:
    """The `Literal` on `UpdateSpec.target` is only for the type checker's benefit — it catches
    nothing at runtime.

    Without this check, `getattr(structured, "made_up_name")` raises `AttributeError` — which
    propagates straight out of apply, and one hallucination kills the whole loop. The "not a crash"
    use case above guards against a bad **field name**; a bad **struct name** slips right past it.
    """
    runtime, brain = await _run(_update("not_a_target", objective_hypothesis="随便"))

    assert runtime.memory.structured == _loaded()
    rejection = runtime.memory.channels[CONVERSATION_CHANNEL].items[-1]
    assert rejection.outcome == "failed"
    assert rejection.content["reason"] == "unknown_target"
    assert len(brain.views) == 1  # the loop is still alive, and wasn't disturbed by this rejection


async def test_a_field_written_with_the_wrong_shape_is_refused_here_not_later() -> None:
    """`unresolved_questions=7` writes in fine, and **blows up on the next view assembly**: 'int'
    object is not iterable.

    This is the hardest kind of bug in this group to track down: the cause (this update) and the
    effect (the next view assembly) are separated by a whole event turn, and it looks like a bug in
    the view layer. So shape validation has to run before the write, not after.

    The second assertion pins down nesting: a nested list still looks like a list at the outer type
    level, and `tuple()` accepts it, leaving a mutable hole inside the frozen shell. The elements
    must be validated individually to catch this.
    """
    scalar, _ = await _run(_update("intent", unresolved_questions=7))
    nested, _ = await _run(_update("intent", constraints=[["嵌套列表"]]))

    for runtime, field in ((scalar, "unresolved_questions"), (nested, "constraints")):
        assert runtime.memory.structured == _loaded()
        rejection = runtime.memory.channels[CONVERSATION_CHANNEL].items[-1]
        assert rejection.outcome == "failed"
        assert rejection.content["reason"] == "bad_types"
        assert rejection.content["fields"] == [field]


async def test_a_bool_is_not_a_number_even_though_python_says_it_is() -> None:
    """`isinstance(True, int)` is true — shape validation goes by the current value's type, so this
    branch needs to be guarded separately.

    Letting it through would write `uncertainty=True` straight into the struct and then render it
    verbatim into the next view: the model would read back a field where "uncertainty = True".
    """
    runtime, _ = await _run(_update("intent", uncertainty=True))

    assert runtime.memory.structured.intent.uncertainty == 0.4
    assert runtime.memory.channels[CONVERSATION_CHANNEL].items[-1].content["fields"] == [
        "uncertainty"
    ]


@pytest.mark.parametrize("value", (math.nan, math.inf, -math.inf, 10**400))
async def test_non_finite_or_non_binary64_numbers_are_rejected(value: int | float) -> None:
    runtime, _ = await _run(_update("intent", uncertainty=value))

    assert runtime.memory.structured.intent.uncertainty == 0.4
    assert runtime.memory.channels[CONVERSATION_CHANNEL].items[-1].content["fields"] == [
        "uncertainty"
    ]


async def test_an_empty_update_is_not_a_free_revision_bump() -> None:
    """An empty delta changes nothing, yet would still bump `revision`.

    `revision` is itself the signal for "something changed": a no-op bump would be writing a false
    statement into the trace, and downstream code relies on it to tell "is this struct newer than
    what I last saw".
    """
    runtime, _ = await _run(_update("intent"))

    assert runtime.memory.structured.intent.revision == 2  # unchanged
    assert (
        runtime.memory.channels[CONVERSATION_CHANNEL].items[-1].content["reason"] == "empty_delta"
    )


async def test_a_delta_with_non_string_keys_still_gets_a_rejection_written() -> None:
    """When the keys are a mix of types, `sorted(unknown)` in the rejection path raises on its own
    first —

    so the `failed` observation that should have been written never gets written, and the exception
    is raised from inside apply, which still kills the loop just the same. **The validations have an
    order**: you have to recognize the keys before you can recognize the fields.
    """
    runtime, brain = await _run(
        FastBrainOutput(
            speak=SpeakOutput(act="none"),
            action=ActionOutput(
                act="update", update=UpdateSpec(target="intent", delta={7: "x", "mood": "y"})
            ),
        )
    )

    assert runtime.memory.structured == _loaded()
    assert runtime.memory.channels[CONVERSATION_CHANNEL].items[-1].content["reason"] == (
        "malformed_delta"
    )
    assert len(brain.views) == 1


async def test_a_rejected_update_does_not_wake_anybody() -> None:
    """The rejection writes an observation **but does not wake anyone** — otherwise it would just be
    R30's self-wake loop coming back through a different door.

    This is exactly where it differs from `_reject` (a rejected dispatch): that path also doesn't
    wake anyone, because the model would otherwise sit waiting for a handoff that will never arrive;
    here, nothing was dispatched at all, so nobody is waiting.
    Writing the observation is already enough — the next call will naturally see it.
    """
    _, brain = await _run(_update("intent", mood="轻松一点"))

    assert len(brain.views) == 1


async def test_the_next_call_can_see_what_the_previous_one_wrote() -> None:
    """What got written has to actually reach the model's eyes, otherwise this act axis is writing
    into a black hole.

    A `user_input` sits between the two calls: the second view assembly reads the struct after it
    was modified.
    """
    clock = VirtualClock()
    brain = ScriptedFastBrain(
        [_update("goal", objective="客厅灯调到 10%"), _update("intent", uncertainty=0.1)],
        clock=clock,
        latency=LATENCY,
    )
    memory = Memory(policies=SIM_POLICIES)
    memory.structured = _loaded()
    runtime = Runtime(clock=clock, memory=memory, fastbrain=brain, sink=RecordingSink(clock))
    runtime.post(UserInput(text="灯稍微再暗一点"))
    runtime.post(UserInput(text="再暗一点"), delay=1.0)

    await runtime.run()

    assert brain.views[0].structured.goal.objective == "客厅灯调暗"  # before the change
    assert brain.views[1].structured.goal.objective == "客厅灯调到 10%"  # after the change
    assert brain.views[1].structured.goal.revision == 2
