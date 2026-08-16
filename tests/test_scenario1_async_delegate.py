"""Scenario 1: async delegation doesn't block (06-verification.md's first acceptance line).

Delegate a slow activity, then post a second user input before the handoff comes back:
FastBrain should still be woken and speak, while that delegate is still `in_flight`.

**Of the three assertions, the second is the one that matters most.** The first alone
doesn't rule out a disguise: "spawn an independent coroutine per request, and inside that
coroutine still await the executor" would also let the event loop pick up the second
utterance, and would also leave the old delegate still in flight. So we need to pin down
directly that "**no single model call spans the delegate's lifetime**" — ReAct necessarily
fails on this one; this asserts a property, not a feature.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import replace

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.context_view import ContextView
from nova_audio_agent.events import HandoffEvent, UserInput
from nova_audio_agent.executors.sims import SLOW_SIM_POLICY, SlowSim
from nova_audio_agent.memory import CONVERSATION_CHANNEL, Memory, MemoryItem
from nova_audio_agent.ports import (
    ActionDelta,
    ActionOutput,
    DelegateRequest,
    FastBrain,
    FastBrainDelta,
    FastBrainOutput,
    SpeakOutput,
)
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
# Virtual duration between deltas. We use 0.25 instead of the fake's default 0.1 for one
# reason only: 0.1 isn't exact in binary, so sleeping three times turns dispatched_at into
# 0.30000000000000004, and once the snapshot is full of that noise nobody looks at the diff
# anymore — and the whole value of a snapshot is in that one glance.
LATENCY = 0.25


def _say_and_delegate(text: str, delegate: DelegateRequest = DIM_LIGHT) -> FastBrainOutput:
    return FastBrainOutput(
        speak=SpeakOutput(act="say", text=text),
        action=ActionOutput(act="delegate", delegate=delegate),
    )


def _say(text: str) -> FastBrainOutput:
    return FastBrainOutput(speak=SpeakOutput(act="say", text=text), action=ActionOutput(act="none"))


def _runtime(clock: VirtualClock, brain: FastBrain, sink: RecordingSink) -> tuple[Runtime, Memory]:
    memory = Memory(policies=SIM_POLICIES)
    runtime = Runtime(
        clock=clock,
        memory=memory,
        fastbrain=brain,
        executors={"slow_sim": SlowSim()},
        sink=sink,
    )
    return runtime, memory


async def _run_scenario() -> tuple[Runtime, ScriptedFastBrain, RecordingSink]:
    """Script: the first utterance delegates, the second is posted before the handoff comes back (t=1.0)."""
    clock = VirtualClock()
    brain = ScriptedFastBrain(
        [
            _say_and_delegate("好的，这就去调"),
            _say("灯那边还在跑，电影我先说两句"),
        ],
        clock=clock,
        latency=LATENCY,
    )
    sink = RecordingSink(clock)
    runtime, _ = _runtime(clock, brain, sink)
    runtime.post(UserInput(text="把客厅灯调暗点"))
    runtime.post(UserInput(text="顺便，今晚适合看什么电影？"), delay=1.0)

    await runtime.run()

    return runtime, brain, sink


async def test_a_second_user_input_is_served_while_the_delegate_is_still_in_flight() -> None:
    """Scenario 1's main point: the slow activity is still in flight, and the second utterance still gets a response."""
    runtime, brain, sink = await _run_scenario()

    in_flight = brain.views[1].in_flight  # the world **seen** by the second call
    assert [delegate.delegate_id for delegate in in_flight] == ["d-1"]
    assert in_flight[0].origin_ref == "conversation:1"
    assert in_flight[0].what == "slow_sim.set_light(brightness=30, room='客厅')"
    assert (
        in_flight[0].routing_class == "user_awaited"
    )  # inherited along the causal chain from that user input
    # eta is an absolute virtual instant: dispatch time + this channel's typical latency, same shape as deadline.
    assert in_flight[0].eta == in_flight[0].dispatched_at + SLOW_SIM_POLICY.typical_latency
    # Dispatch happens at the exact moment that call's model_done gets applied: the call **finishes first, then delegates**.
    first_model_done = next(event for event in runtime.applied if event.KIND == "model_done")
    assert in_flight[0].dispatched_at == first_model_done.ts

    assert sink.utterances() == ["好的，这就去调", "灯那边还在跑，电影我先说两句"]
    # Spoken utterances fall back into the conversation channel, sharing it with user utterances; trust tells them apart (R22).
    spoken = [
        item
        for item in runtime.memory.channels[CONVERSATION_CHANNEL].items
        if item.trust == "trusted_system"
    ]
    assert [item.content["text"] for item in spoken] == sink.utterances()


async def test_no_model_call_spans_the_delegate_lifetime() -> None:
    """Anti-regression: this is the one that carries scenario 1's real point — it directly asserts the "not-ReAct" property itself.

    **Reads only the event sequence, never ContextView.** A lesson learned from mutation testing:
    a ReAct implementation would push the second call back until after the handoff, so "what did
    the second call see" blows up with an IndexError before this assertion ever runs. The assertion
    has to land on something the degenerate implementation is guaranteed to produce, otherwise it's
    guarding against a different pitfall, not this one.
    """
    runtime, _, _ = await _run_scenario()

    model_dones = [event for event in runtime.applied if event.KIND == "model_done"]
    handoff = next(event for event in runtime.applied if event.KIND == "handoff")

    # (1) The one 06-verification.md spells out explicitly: the model_done of the call that
    #     delegates comes before the handoff. ReAct necessarily violates this — its model_done
    #     can only come **after** the handoff.
    assert model_dones[0].ts < handoff.ts
    assert runtime.applied.index(model_dones[0]) < runtime.applied.index(handoff)
    # (2) Positive twin: a whole model call **runs to completion** inside that activity's flight window.
    #     Without it, an implementation that "delegates once and never calls the model again" could also satisfy (1).
    assert model_dones[0].ts < model_dones[1].ts < handoff.ts


async def test_the_handoff_takes_the_delegate_out_of_the_in_flight_table() -> None:
    """The handoff must remove the delegate from the in-flight table the moment it lands, otherwise ContextView keeps lying to FastBrain about that activity still hanging around."""
    runtime, brain, _ = await _run_scenario()

    assert brain.views[2].in_flight == ()  # the call that follows the handoff
    assert runtime.delegates.snapshot() == ()
    assert runtime.delegates.terminated_by("d-1") == "handoff"
    # The slow activity came back before its deadline, so that deadline event was just a no-op.
    assert [event.KIND for event in runtime.applied if event.KIND == "deadline"] == ["deadline"]
    assert all(item.outcome != "unknown" for item in runtime.memory.channels["slow_sim"].items)


def _exogenous(**content: object) -> HandoffEvent:
    """An observation **nobody summoned**. The ledger has no parent to look up, so it borrows the handoff's shell (the same gap as scenario 4).

    We need it here only because it's the kind of event that can merge FastBrain into pending
    without being user speech — after R48 these two things have to be tested separately (see the
    two twin cases below).
    """
    return HandoffEvent(
        channel="fast_sim",  # wake="fast": for exogenous observations, this field is decided by channel policy (R44)
        delegate_id="d-none",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content=dict(content),
    )


async def test_pending_rerun_sees_the_delegate_that_the_same_call_dispatched() -> None:
    """Dispatch must land in on_done's **step 1**, not a step later.

    An exogenous observation arrives while the first call is still in flight -> gets merged into
    pending -> is picked up by the rerun in step 4. That rerun must recompile the view; if the
    delegate isn't in the in-flight table yet by then, FastBrain will either dispatch it twice, or
    the filler utterance will fail to mention it (05-executors.md, "ContextView keeps lying to FastBrain").

    **The event that used to trigger the rerun was the second user input; after R48 it's an
    exogenous observation.** What changed is the trigger, not the property being pinned down —
    "dispatch in step 1, rerun in step 4" has nothing to do with "what puts the rerun into pending",
    while user input now happens to void the action axis (the twin case below), so using it as the
    trigger would no longer let us observe the dispatch.
    """
    clock = VirtualClock()
    brain = ScriptedFastBrain(
        [_say_and_delegate("好的，这就去调"), _say("灯还在调，我先说两句")],
        clock=clock,
        latency=LATENCY,
    )
    runtime, _ = _runtime(clock, brain, RecordingSink(clock))
    runtime.post(UserInput(text="把客厅灯调暗点"))
    runtime.post(_exogenous(motion="客厅有人经过"), delay=0.1)  # lands mid-flight of the first call

    await runtime.run()

    assert len(brain.views) >= 2
    assert [delegate.delegate_id for delegate in brain.views[1].in_flight] == ["d-1"]


def _conversation(runtime: Runtime) -> list[MemoryItem]:
    return list(runtime.memory.channels[CONVERSATION_CHANNEL].items)


async def test_a_new_user_utterance_voids_the_action_the_old_call_was_about_to_take() -> None:
    """The **reverse twin** of the case above: swap the rerun's trigger for user speech, and the whole action axis gets voided (R48).

    A shape that's actually happened before: "dim the living room light" -> FastBrain starts
    running -> the user changes their mind, "never mind, don't dim it" -> the first call returns,
    and that stale `set_light` gets dispatched anyway. On the way out, the model says "okay,
    cancelled" — but the light has already been dimmed. **What was said and what was done are two
    different things**, and no assertion goes red for it.

    The main loop **does not judge** whether this action still makes sense (that would be a
    heuristic leaking back into the loop body, the exact regression from v3 back to v2 noted
    elsewhere) — it only compares the world's version number: is the world that call answered
    still around? If not, hand the action to the rerun that's **already queued in pending** — it
    can see the full conversation plus the observation below.

    The two cases have literally identical skeletons; the only difference is what line
    `runtime.post` posts. That single variable is exactly what pins down "is the voiding criterion
    specifically **user** speech" — swap it for handoff and the case above turns red on the spot.
    """
    clock = VirtualClock()
    brain = ScriptedFastBrain(
        [_say_and_delegate("好的，这就去调"), _say("好，取消了")],
        clock=clock,
        latency=LATENCY,
    )
    runtime, _ = _runtime(clock, brain, RecordingSink(clock))
    runtime.post(UserInput(text="把客厅灯调暗点"))
    runtime.post(UserInput(text="算了，别调了"), delay=0.1)  # lands mid-flight of the first call

    await runtime.run()

    # The light was never touched: the in-flight table is empty, nothing happened on the executor's channel, and no fallback timer was left behind.
    assert runtime.delegates.snapshot() == ()
    assert runtime.memory.channels["slow_sim"].items == ()
    assert [event.KIND for event in runtime.applied if event.KIND == "deadline"] == []

    # But it left a trace: not writing one means "did it halfway and left no trace" — the model's next turn would just assume it went through (D14).
    cancel = next(
        item for item in _conversation(runtime) if item.content.get("text") == "算了，别调了"
    )
    (dropped,) = [item for item in _conversation(runtime) if item.outcome == "failed"]
    assert dropped.content["error"] == "action_superseded"
    assert dropped.content["act"] == "delegate"
    assert dropped.content["op"] == "set_light"
    assert dropped.refs == (cancel.ref,)  # can point to who overrode it

    # The rerun **can see** this observation — "hand it to the rerun to decide" isn't just a saying.
    # Exactly two is right: >=2 means that rerun actually ran; <=2 means it didn't turn into a
    # refuse -> wake -> refuse-again self-waking loop.
    # (It doesn't pin down "no extra wake on voiding": at that moment `inflight` hasn't cleared yet,
    #  so an extra wake would merge into the same pending anyway — the two ways of writing it are
    #  equivalent here; see the mutation-testing notes on `_drop_stale_action`.)
    assert len(brain.views) == 2
    recent = next(view for view in brain.views[1].channels if view.name == CONVERSATION_CHANNEL)
    assert dropped in recent.recent


async def test_context_view_snapshots_of_every_model_call() -> None:
    """One snapshot per model call: pins down exactly "what did FastBrain see"."""
    _, brain, _ = await _run_scenario()

    assert len(brain.views) == 3
    for index, view in enumerate(brain.views, start=1):
        assert_snapshot(f"scenario1_call{index}", to_snapshot(view))


# ---- Three reasons a delegate can't be dispatched ----


async def _run_rejected(delegate: DelegateRequest) -> tuple[Runtime, ScriptedFastBrain]:
    clock = VirtualClock()
    brain = ScriptedFastBrain(
        [_say_and_delegate("这就去办", delegate)], clock=clock, latency=LATENCY
    )
    runtime, _ = _runtime(clock, brain, RecordingSink(clock))
    runtime.post(UserInput(text="把客厅灯调暗点"))

    await runtime.run()

    return runtime, brain


async def test_a_delegate_that_cannot_be_dispatched_becomes_a_failed_observation() -> None:
    """Three reasons, one shared exit: a failed observation + one wake, **not an exception**.

    It lands on the conversation channel rather than the executor channel: this activity never
    reached an executor, so recording it there would falsely claim an interaction happened; and
    when the executor name is fake, that channel doesn't even exist.
    """
    hallucinations = {
        "执行器不存在": DelegateRequest(
            executor="ha",
            op="set_light",
            request={"room": "客厅", "brightness": 30},
            origin_ref="conversation:1",
        ),
        "op 不存在": DelegateRequest(
            executor="slow_sim",
            op="play_music",
            request={"track": "夜曲"},
            origin_ref="conversation:1",
        ),
        "origin_ref 是编的": DelegateRequest(
            executor="slow_sim",
            op="set_light",
            request={"room": "客厅", "brightness": 30},
            origin_ref="conversation:99",
        ),
    }

    for label, delegate in hallucinations.items():
        runtime, brain = await _run_rejected(delegate)

        failed = [
            item
            for item in runtime.memory.channels[CONVERSATION_CHANNEL].items
            if item.outcome == "failed"
        ]
        assert len(failed) == 1, label
        assert failed[0].content["error"] == "delegate_rejected", label
        assert runtime.delegates.snapshot() == (), label  # never entered the in-flight table
        assert [event.KIND for event in runtime.applied if event.KIND == "deadline"] == [], label
        # FastBrain gets woken to handle it: without notifying the model, that activity truly has "no follow-up".
        assert len(brain.views) == 2, label


async def test_redispatching_an_in_flight_activity_is_rejected_without_disturbing_it() -> None:
    """R28, pinned down by probing in practice: the model dispatches the exact same activity again against the in-flight table.

    Not a hypothetical degenerate implementation — qwen-max, holding call2's snapshot, did this
    two times out of three, **while the speak axis in that same reply was saying "the light is
    already being adjusted"**. The two axes each read their own thing.
    Two things get pinned down here: the duplicate gets blocked, and the original **is unaffected**
    (neither overwritten nor terminated).
    """
    clock = VirtualClock()
    brain = ScriptedFastBrain(
        [_say_and_delegate("好的，这就去调"), _say_and_delegate("灯已经在调整中了")],
        clock=clock,
        latency=LATENCY,
    )
    runtime, _ = _runtime(clock, brain, RecordingSink(clock))
    runtime.post(UserInput(text="把客厅灯调暗点"))
    runtime.post(UserInput(text="灯怎么样了？"), delay=1.0)

    await runtime.run()

    failed = [
        item
        for item in runtime.memory.channels[CONVERSATION_CHANNEL].items
        if item.outcome == "failed"
    ]
    assert len(failed) == 1
    assert "d-1 正在做同一件事" in failed[0].content["problem"]
    # The original activity lived out its full life: not overridden, wrapped up by handoff on schedule.
    assert runtime.delegates.terminated_by("d-1") == "handoff"
    assert runtime.delegates.terminated_by("d-2") is None  # the second one was never created at all
    assert [event.KIND for event in runtime.applied if event.KIND == "handoff"] == ["handoff"]


async def test_a_rejected_delegates_observation_does_not_promote_itself() -> None:
    """The model referenced the wrong ref, and that shouldn't earn it the right to interrupt the user: priority follows whatever wake it happened under.

    **This only pins down that observation's priority.** The rerun's `WakeReason` priority is
    likewise inherited (`_reject` passes `reason.priority`), but B1 has no observable point for
    it — priority only becomes visible at Floor arbitration, and Floor is B2. Add an end-to-end
    case for it then.
    """
    runtime, _ = await _run_rejected(
        DelegateRequest(
            executor="slow_sim",
            op="set_light",
            request={"room": "客厅", "brightness": 30},
            origin_ref="conversation:99",
        )
    )

    user_said = runtime.memory.channels[CONVERSATION_CHANNEL].items[0]
    failed = next(
        item
        for item in runtime.memory.channels[CONVERSATION_CHANNEL].items
        if item.outcome == "failed"
    )

    assert failed.priority == user_said.priority


# ---- A rejected activity doesn't wake itself up (R30, added for B3) ----


class _StubbornFastBrain:
    """A **never-silent** FastBrain: every time it's woken, it dispatches a bad activity.

    `ScriptedFastBrain`'s script goes quiet once it runs out, which happens to paper over exactly
    this loop — the second wake in the loop does nothing, so it looks like there's no loop. A real
    model isn't that considerate: at temperature 0, given the same context, it produces the same
    bad activity.

    When `vary` is true, it swaps in a different fictional executor name each round. This is the
    path uncovered by mutation testing in the third round of codex review (accepted as-is). The
    model doesn't even need to repeat itself to keep the loop going — just changing the name each
    round is enough to instantly break "bounded per distinct bad request" (it ran up to 50 model calls).
    """

    def __init__(
        self, delegate: DelegateRequest, *, clock: VirtualClock, vary: bool = False
    ) -> None:
        self._delegate = delegate
        self._clock = clock
        self._vary = vary
        self.calls = 0

    async def call(self, view: ContextView) -> AsyncIterator[FastBrainDelta]:
        self.calls += 1
        await self._clock.sleep(LATENCY)
        delegate = self._delegate
        if self._vary:
            delegate = replace(delegate, executor=f"ghost-{self.calls}")
        yield ActionDelta(action=ActionOutput(act="delegate", delegate=delegate))


BAD_REF = DelegateRequest(
    executor="slow_sim",
    op="set_light",
    request={"room": "客厅", "brightness": 30},
    origin_ref="conversation:99",  # a made-up ref, the fourth of the four rejection reasons
)


async def _run_stubborn(*, vary: bool) -> tuple[Runtime, _StubbornFastBrain]:
    clock = VirtualClock()
    brain = _StubbornFastBrain(BAD_REF, clock=clock, vary=vary)
    runtime, _ = _runtime(clock, brain, RecordingSink(clock))
    runtime.post(UserInput(text="把客厅灯调暗点"))

    await runtime.run(max_steps=200)

    return runtime, brain


def _rejections(runtime: Runtime) -> list[MemoryItem]:
    return [
        item
        for item in runtime.memory.channels[CONVERSATION_CHANNEL].items
        if item.outcome == "failed"
    ]


async def test_a_model_that_keeps_redispatching_the_same_bad_request_stops_being_woken() -> None:
    """R30: a rejected dispatch should wake, but one wake chain only compensates once.

    "Dispatch always has a follow-up" applies to rejections too — without notifying the model,
    it would just keep waiting on a handoff that will never arrive. But after that wake, the model
    is entirely free to dispatch another bad one, and that's a reject -> wake -> dispatch-again ->
    reject-again self-waking loop, burning one model call per turn. So the observation is always
    written (the channel is the trace), but compensation is granted only to non-compensated chains.

    `max_steps` here is **part of the assertion**, not a safety fuse: if the loop comes back, the
    case hits the step limit and fails on `calls == 2`, instead of hanging the whole test suite waiting for a timeout.
    """
    runtime, brain = await _run_stubborn(vary=False)

    # The first wake comes from user input, the second from that rejection's compensation. A third would be the loop.
    assert brain.calls == 2
    failed = _rejections(runtime)
    # Two observations: every attempt leaves a trace (D14). Only the wake is suppressed.
    assert len(failed) == 2
    assert all(item.content["error"] == "delegate_rejected" for item in failed)


async def test_a_model_that_invents_a_new_bad_request_every_round_also_stops_being_woken() -> None:
    """The same loop's second variant: **without repeating itself**, swapping in a new fictional executor name each round.

    This is the diagnosis from codex review round three (accepted as-is). The old R30 braked on
    "has this bad request been rejected before" — but the value space of `executor` / `op` /
    `request` / `origin_ref` is unbounded, so the model just needs a new name every round to earn
    a free wake each time. codex measured 50 model calls, 49 rejection observations — the loop
    never converged, it just went from "repeat the same line" to "enumerate infinite new lines".

    So the brake was changed to key on the **wake chain** instead: if this round's wake was itself
    a compensation, don't compensate again. Both variants give the same number here, which is
    exactly where "counting by chain" beats "counting by request".
    """
    runtime, brain = await _run_stubborn(vary=True)

    assert brain.calls == 2
    failed = _rejections(runtime)
    assert len(failed) == 2
    # Each observation records its own fictional executor name: every attempt leaves a trace, only the wake is suppressed.
    assert [item.content["executor"] for item in failed] == ["ghost-1", "ghost-2"]


async def test_a_fresh_user_input_earns_a_new_rejection_compensation() -> None:
    """The brake mustn't brake forever: **fresh** user input still opens a new compensation window.

    Only counting by wake chain makes this possible. If instead we kept a global table of "requests
    already rejected", the same request being rejected again would permanently lose its wake — and
    that would conflict with 05-executors.md line 114: "any validation failure -> failed observation + wake FastBrain".
    """
    clock = VirtualClock()
    brain = _StubbornFastBrain(BAD_REF, clock=clock)
    runtime, _ = _runtime(clock, brain, RecordingSink(clock))
    runtime.post(UserInput(text="把客厅灯调暗点"))
    runtime.post(UserInput(text="再说一次，把客厅灯调暗点"), delay=5.0)

    await runtime.run(max_steps=200)

    # Two chains, each running its own "wake -> reject -> compensate once -> reject again": 4 calls, 4 observations.
    assert brain.calls == 4
    assert len(_rejections(runtime)) == 4
