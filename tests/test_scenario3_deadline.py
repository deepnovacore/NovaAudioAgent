"""Scenario 3: dispatching a task always means there's a follow-up (06-verification.md's third acceptance line).

A dispatched task has four possible outcomes, one test for each here: the adapter times out on
its own, the adapter hangs so badly it never even returns a timeout, it comes back cleanly
before the deadline, or it comes back late after the deadline. **All four must have a
follow-up**—the model must either hear the result or hear "I'm not sure"; no task is allowed to
vanish without a trace.

This guards against two classic bugs (05-executors.md): a task that actually succeeded on time
but gets a fake "I'm not sure" (blocked by termination rule 1), and a task stuck in `in_flight`
forever with the eta perpetually climbing (blocked by rule 2).
"""

from __future__ import annotations

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import UserInput
from nova_audio_agent.executors.sims import SET_LIGHT, SLOW_SIM_POLICY, SlowSim
from nova_audio_agent.memory import CONVERSATION_CHANNEL, Memory, MemoryItem
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
LATENCY = 0.25  # same value as scenario 1, see there for why: 0.1 isn't binary-exact, so snapshots would be full of noise
# dispatch moment: two text segments + one action segment, each LATENCY. Dispatch happens inside on_done, so it's after the last segment.
DISPATCHED_AT = 3 * LATENCY
# deadline is an **absolute virtual moment**: dispatch time + this op's budget, same shape as eta.
DEADLINE_AT = DISPATCHED_AT + SET_LIGHT.deadline_budget  # 10.75


def _say_and_delegate(text: str, delegate: DelegateRequest = DIM_LIGHT) -> FastBrainOutput:
    return FastBrainOutput(
        speak=SpeakOutput(act="say", text=text),
        action=ActionOutput(act="delegate", delegate=delegate),
    )


def _say(text: str) -> FastBrainOutput:
    return FastBrainOutput(speak=SpeakOutput(act="say", text=text), action=ActionOutput(act="none"))


async def _run(
    sim: SlowSim, *, replies: list[FastBrainOutput] | None = None
) -> tuple[Runtime, ScriptedFastBrain, RecordingSink]:
    """One user input → dispatch one slow task → let the sim decide how it ends.

    **No max_steps given.** Even the hang path terminates: `next_timer_ts()` returns None for
    `inf`, and the task stuck on `clock.sleep(inf)` counts as a clock waiter, not runnable——
    so all three branches of the loop go empty, `run()` exits normally, and `_shutdown()` cleans
    it up. If this didn't hold, the test would hang instead of failing, which is exactly why
    max_steps is omitted here: it turns "the loop can't terminate" from a bug into a timeout,
    rather than an assertion.
    """
    clock = VirtualClock()
    brain = ScriptedFastBrain(
        [_say_and_delegate("好的，这就去调"), *(replies or [])],
        clock=clock,
        latency=LATENCY,
    )
    sink = RecordingSink(clock)
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=SIM_POLICIES),
        fastbrain=brain,
        executors={"slow_sim": sim},
        sink=sink,
    )
    runtime.post(UserInput(text="把客厅灯调暗点"))

    await runtime.run()

    return runtime, brain, sink


def _results(runtime: Runtime) -> list[tuple[float, str | None]]:
    """Result-type observations on the executor channel, laid out as (moment, outcome)."""
    return [(item.ts, item.outcome) for item in runtime.memory.channels["slow_sim"].items]


# ---- The two producers of rule 2: the adapter's own timeout, and the trunk's deadline ----


async def test_an_adapter_timeout_is_unknown_not_failed() -> None:
    """The adapter's own timeout path: `unknown`, **not** `failed`, and it **must wake**.

    "Unknown result ≠ failure." A timeout isn't evidence that "the thing didn't happen"—the
    light was very likely already adjusted. This path goes through termination rule 1 (the
    handoff arrives before the deadline), so the trunk doesn't write a second observation.

    The wake-up half was added in the third round of codex review: originally this test only
    checked the write, so an implementation where `_wake_handoff` returns empty when
    `outcome == "unknown"` would still pass——while 06-verification.md line 58 demands exactly
    "there must be a follow-up." This is the only path where `unknown` goes through
    `_wake_handoff` (elsewhere, unknowns are always written by the trunk's deadline).
    """
    runtime, brain, sink = await _run(
        SlowSim(inject="timeout"), replies=[_say("我不确定客厅灯调没调成")]
    )

    assert _results(runtime) == [(5.75, "unknown")]
    observation = runtime.memory.channels["slow_sim"].items[0]
    assert observation.content["error"] == "adapter_timeout"
    assert (
        runtime.delegates.terminated_by("d-1") == "handoff"
    )  # rule 1: the adapter got there first
    assert runtime.delegates.snapshot() == ()
    # "Dispatching a task always means there's a follow-up": that unknown woke the FastBrain, and it really spoke up.
    assert len(brain.views) == 2
    assert sink.utterances() == ["好的，这就去调", "我不确定客厅灯调没调成"]


async def test_a_handoff_landing_exactly_on_the_deadline_wins() -> None:
    """Same-moment race: handoff and deadline land at **exactly the same virtual moment**, and rule 1 says handoff wins.

    This is the exact cell called out in 05-executors.md line 134 (the equals sign in
    "timestamp ≤ deadline"). Scenario 3 originally only tested the strictly-earlier and
    strictly-later sides, so an implementation that wrote `<=` as `<` still passed all
    green——and its consequence is that every task that used up its budget exactly gets a fake
    "I'm not sure."

    This cell is held together by two things acting jointly, neither dispensable (see the
    `runtime.py` module docstring): the loop's three-branch order makes the two events land on
    the same ts, and `kind_rank` decides who goes first at the same moment. So the assertion
    here is on the **result** (handoff wins, no unknown), so that either one breaking turns it red.
    """
    runtime, _, _ = await _run(SlowSim(latency=SET_LIGHT.deadline_budget))

    handoff = next(event for event in runtime.applied if event.KIND == "handoff")
    deadline = next(event for event in runtime.applied if event.KIND == "deadline")
    assert (
        handoff.ts == deadline.ts == DEADLINE_AT
    )  # genuinely simultaneous, not this test fooling itself
    assert runtime.applied.index(handoff) < runtime.applied.index(deadline)
    assert runtime.delegates.terminated_by("d-1") == "handoff"
    assert _results(runtime) == [(DEADLINE_AT, "ok")]  # one real result, no fake unknown


async def test_a_failed_append_does_not_leave_the_delegate_half_terminated() -> None:
    """The four-step order puts append first: if the write fails, termination isn't allowed (codex review, third round).

    The reverse order (`terminate` before append) leaves a half-committed state when append
    raises: the task is already off the in-flight table, already recorded as terminated by the
    deadline, but the channel doesn't have that unknown. So it ends up with neither a result nor
    an "I'm not sure"—"dispatching a task always means there's a follow-up" breaks right there,
    and the next deadline would fall into rule 3, unable to self-heal.

    The exception itself blows up `run()`; this test doesn't pretend to recover from that. What
    it asserts is that **the state after the blow-up** is clean: the task is still in flight, no
    one has claimed the right to terminate it, and replaying this trace would land in the same
    situation.
    """
    clock = VirtualClock()
    memory = Memory(policies=SIM_POLICIES)
    real_append = memory.append

    def append_that_fails_on_the_executor_channel(channel: str, **fields: object) -> object:
        if channel == "slow_sim":
            raise RuntimeError("模拟写观测时挂了")
        return real_append(channel, **fields)  # type: ignore[arg-type]

    memory.append = append_that_fails_on_the_executor_channel  # type: ignore[method-assign]
    brain = ScriptedFastBrain([_say_and_delegate("好的，这就去调")], clock=clock, latency=LATENCY)
    runtime = Runtime(
        clock=clock,
        memory=memory,
        fastbrain=brain,
        executors={"slow_sim": SlowSim(inject="hang")},
        sink=RecordingSink(clock),
    )
    runtime.post(UserInput(text="把客厅灯调暗点"))

    with pytest.raises(RuntimeError, match="模拟写观测时挂了"):
        await runtime.run()

    assert [delegate.delegate_id for delegate in runtime.delegates.snapshot()] == ["d-1"]
    assert runtime.delegates.terminated_by("d-1") is None


async def test_a_hung_adapter_is_terminated_by_the_trunks_deadline() -> None:
    """The hang path: it doesn't even return its own timeout, only the trunk's deadline can catch it (termination rule 2).

    The two timeout producers are **deliberately not merged** (05-executors.md): the adapter's is
    faster and can carry transport-layer detail, while the trunk's is the fallback, meant to
    still hold when the adapter fails completely. This test verifies the latter.
    """
    runtime, _, _ = await _run(SlowSim(inject="hang"))

    assert _results(runtime) == [(DEADLINE_AT, "unknown")]
    observation = runtime.memory.channels["slow_sim"].items[0]
    assert observation.content["error"] == "deadline_exceeded"
    # This observation written by the trunk also needs to name its parent: it answers the user's original utterance, otherwise "who's waiting for it" would be lost.
    assert observation.refs == ("conversation:1",)
    # Carrying op and request is what lets the model say "I'm not sure whether the **living
    # room** light got adjusted"—this task has already vanished from the in-flight table, and
    # there's nowhere else in the view where its parameters are written.
    assert observation.content["op"] == "set_light"
    assert observation.content["request"] == {"room": "客厅", "brightness": 30}
    assert runtime.delegates.terminated_by("d-1") == "deadline"


async def test_a_hung_delegate_stops_appearing_in_the_context_view() -> None:
    """Step 2 of the atomic four steps: after the deadline it **no longer appears in in_flight**.

    If only unknown gets written without removing it from the in-flight table, that task stays
    in flight forever—ContextView keeps lying to the FastBrain, and R28's dedup key would then
    **never again allow** doing this a second time.

    What's asserted here is that "the entry disappears entirely," not "eta stops growing":
    `eta = dispatched_at + typical_latency` was always a constant, it never grows. What actually
    keeps climbing is the `now - eta` difference, and the only way to block that is to make the
    entry disappear.

    **What's needed is a before/after comparison**, so a user input is inserted midway:
    `views[1]` must see it in flight, `views[2]` must see it gone. The original first assertion
    read `views[0]` (the dispatch call itself), and at that point it obviously hadn't been
    dispatched yet—trivially true at t=0, distinguishing nothing.
    """
    clock = VirtualClock()
    brain = ScriptedFastBrain(
        [
            _say_and_delegate("好的，这就去调"),
            _say("还在调，稍等"),  # the call before the timeout: it's visible in flight
            _say("我不确定客厅灯调没调成"),  # the call woken by the timeout: it's already gone
        ],
        clock=clock,
        latency=LATENCY,
    )
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=SIM_POLICIES),
        fastbrain=brain,
        executors={"slow_sim": SlowSim(inject="hang")},
        sink=RecordingSink(clock),
    )
    runtime.post(UserInput(text="把客厅灯调暗点"))
    runtime.post(UserInput(text="灯怎么样了？"), delay=1.0)  # lands before the deadline

    await runtime.run()

    assert len(brain.views) == 3
    assert [delegate.delegate_id for delegate in brain.views[1].in_flight] == ["d-1"]
    woken_view = brain.views[2]  # the one woken by that deadline
    assert woken_view.in_flight == ()
    assert woken_view.now == DEADLINE_AT
    assert runtime.delegates.snapshot() == ()


async def test_a_delegate_that_beats_the_deadline_never_gets_a_fake_unknown() -> None:
    """The reverse case (termination rule 1): a task that comes back on time must **never** produce an unknown afterward.

    This guards against "the timer never gets cancelled when the handoff succeeds"—which would
    make every task that finished on time receive a fake "I'm not sure" once its deadline hits,
    even though the light was already adjusted long ago. In this loop, the shape of "cancelling
    the timer" is: the event still arrives, but it can't recognize whom it terminated.
    """
    runtime, brain, _ = await _run(SlowSim())  # default latency=5.0 < deadline 10.0

    assert _results(runtime) == [(5.75, "ok")]
    assert [event.KIND for event in runtime.applied if event.KIND == "deadline"] == ["deadline"]
    assert runtime.delegates.terminated_by("d-1") == "handoff"
    # The deadline tick didn't wake anyone: the handoff already woke it once, and that's where the second call comes from.
    assert len(brain.views) == 2
    assert brain.views[1].now == 5.75  # the handoff moment, not the deadline moment


# ---- The late handoff: neither discarded, nor treated as termination ----


async def _run_late() -> tuple[Runtime, ScriptedFastBrain, RecordingSink]:
    """The adapter is slower than the deadline: unknown at t=10, the real result at t=15.75."""
    return await _run(
        SlowSim(latency=15.0),
        replies=[_say("我不确定客厅灯调没调成"), _say("刚才说不确定，现在确认调暗了")],
    )


async def test_a_late_handoff_is_appended_and_terminates_nothing() -> None:
    """The late one still enters the channel as usual, but it's no longer a termination event.

    Dropping it would break replay (D14: the channel is the trace), and it's often **good
    news**—"it actually got adjusted." At the same time it doesn't cancel any timer, doesn't
    produce a new deadline, and doesn't count as a second delegate: one delegate leaves at most
    two result-type observations, the unknown written by the trunk and this late handoff.
    """
    runtime, _, _ = await _run_late()

    assert _results(runtime) == [(DEADLINE_AT, "unknown"), (15.75, "ok")]
    # The terminator is still that deadline: the late handoff didn't displace it.
    assert runtime.delegates.terminated_by("d-1") == "deadline"
    # No second delegate, and no second deadline.
    assert runtime.delegates.find("d-2") is None
    assert [event.KIND for event in runtime.applied if event.KIND == "deadline"] == ["deadline"]


async def test_a_late_handoff_wakes_a_self_correction() -> None:
    """The wake-up's routing class is **bound at dispatch time**, so the model can self-correct.

    Routing class isn't recomputed from "this wake-up's reason": that handoff was submitted by
    an executor, and recomputing it would turn it into ambient, silently downgrading the
    correction the user is waiting for into a record no one sees (R12 / 05-executors.md line 105).
    """
    runtime, brain, sink = await _run_late()

    assert runtime.delegates.routing_class_of("d-1") == "user_awaited"
    # Three calls: dispatch → say "not sure" after the timeout → correct after the late good news.
    assert len(brain.views) == 3
    assert sink.utterances() == [
        "好的，这就去调",
        "我不确定客厅灯调没调成",
        "刚才说不确定，现在确认调暗了",
    ]


async def test_the_material_the_model_reads_says_unknown_and_never_failed() -> None:
    """The harness half of the iron rule "`unknown` must not be phrased as `failed`": it **only manages the material**.

    **The wording itself can't be pinned down**: the fake says whatever lines we scripted into
    it. What can be pinned down is the material handed to the model—the observation it sees is
    `unknown`, not `failed`, `error` is `deadline_exceeded` and nothing else, so it has no reason
    to say "adjusting the light failed."

    So this test **cannot count** as output-side acceptance (that sentence in
    06-verification.md line 61), and its name mustn't imply that it does either (codex review,
    third round, accepted as-is). The counterexample is right there: probe Q5 observed
    qwen-max actually saying "the operation to adjust the living-room light just now didn't
    complete successfully," and this test still stays green. Output acceptance belongs to Stage
    C's real-model scorecard; probe Q5 is just a clue for that side.
    """
    _, brain, _ = await _run(SlowSim(inject="hang"), replies=[_say("我不确定客厅灯调没调成")])

    shown = [item for view in brain.views for channel in view.channels for item in channel.recent]
    outcomes = {item.outcome for item in shown if item.outcome is not None}
    assert outcomes == {"unknown"}
    assert all(item.content.get("error") != "delegate_failed" for item in shown)


async def test_the_context_view_keeps_the_time_each_value_was_observed() -> None:
    """The harness half of the cross-cutting assertion: observation timestamps make it into the view (06-verification.md).

    **The name must not mention "model quoting"**: this assertion never touches the output.
    `_run_late()`'s script says "just said I wasn't sure, now confirming it got dimmed," which
    doesn't contain a single timestamp, and this test still stays green—so the original name
    (`..._the_model_quotes_...`) was speaking for Stage C's scorecard instead (codex review,
    third round, accepted as-is). Output wording belongs to that scorecard; here it's only
    about the material.

    But it verifies something stricter than "the field is non-empty": the two observations seen
    on the third call have `ts` equal to the timeout moment and the late moment respectively,
    and both are **not equal** to that call's `now`. An implementation that casually fills in
    `now`, or uses the `append` moment as the observation moment, won't match here.
    """
    _, brain, _ = await _run_late()

    view = brain.views[2]
    recent = next(channel for channel in view.channels if channel.name == "slow_sim").recent

    assert [(item.ts, item.outcome) for item in recent] == [
        (DEADLINE_AT, "unknown"),
        (15.75, "ok"),
    ]
    assert view.now == 15.75
    assert recent[0].ts != view.now  # that unknown happened 5.75 virtual seconds earlier


async def test_context_view_snapshots_of_every_model_call() -> None:
    """One snapshot per model call, going through the late path—it passes through all three termination rules."""
    _, brain, _ = await _run_late()

    assert len(brain.views) == 3
    for index, view in enumerate(brain.views, start=1):
        assert_snapshot(f"scenario3_call{index}", to_snapshot(view))


async def test_the_deadline_observation_uses_the_delegates_own_channel_priority() -> None:
    """A timeout doesn't change how urgent this task originally was: that unknown's priority comes from its own channel.

    **The name was changed**: it used to be called "wake priority," but the assertion reads
    `MemoryItem.priority`, not the `WakeReason.priority` handed to the FastBrain. Wrongly
    changing `_wake_deadline` to `USER_PRIORITY` while keeping the observation's 50 would still
    pass this test green (codex review, third round, accepted as-is). The two objects share an
    origin but aren't the same thing, and the name has to tell the truth.

    What actually pins down the wake priority is the **same-named** test in
    `test_wake_targets.py`—that's where B1's mutation E originally went red. Same name,
    different thing, is one of the easiest ways to fool yourself.
    """
    runtime, _, _ = await _run(SlowSim(inject="hang"), replies=[_say("我不确定")])

    observation = runtime.memory.channels["slow_sim"].items[0]
    assert observation.priority == SLOW_SIM_POLICY.priority == 50


# ---- Dispatching the same thing again after stopping at unknown: refused once, but review isn't blocked (R49) ----

PROBE = DelegateRequest(
    executor="slow_sim",
    op="get_state",
    request={"room": "客厅"},
    origin_ref="conversation:1",
)


async def _resend(*requests: DelegateRequest) -> tuple[Runtime, ScriptedFastBrain]:
    """One task after another: each time it's woken, dispatch the next one in `requests`, until they run out.

    The first is triggered by that user input; every one after is woken by the previous one's
    outcome (an unknown's handoff, or a compensating wake-up after a refusal). The four tests
    here differ only in this list.

    `latency=1.0` instead of the 5.0 used elsewhere in this file: `get_state`'s budget also
    happens to be 5.0, and the default latency would make that handoff land on the same ts as
    its deadline. That cell is ordered by `kind_rank` and works fine, but it would bury what
    this section wants to examine inside an unrelated ordering rule.
    """
    clock = VirtualClock()
    brain = ScriptedFastBrain(
        [
            _say_and_delegate(f"第 {index} 次，这就去办", request)
            for index, request in enumerate(requests, start=1)
        ],
        clock=clock,
        latency=LATENCY,
    )
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=SIM_POLICIES),
        fastbrain=brain,
        executors={"slow_sim": SlowSim(latency=1.0, inject="timeout")},
        sink=RecordingSink(clock),
    )
    runtime.post(UserInput(text="把客厅灯调暗点"))

    await runtime.run()

    return runtime, brain


def _refusals(runtime: Runtime) -> list[MemoryItem]:
    return [
        item
        for item in runtime.memory.channels[CONVERSATION_CHANNEL].items
        if item.outcome == "failed"
    ]


async def test_resending_a_non_readonly_op_that_stopped_at_unknown_is_refused() -> None:
    """Dispatching the identical light-dimming request again after `unknown` → refused, rather than stacking another action on top of one that may have already taken effect.

    R28's in-flight dedup doesn't catch this cell: that task has already terminated, it's not on
    the in-flight table. And `unknown` means precisely "we don't know whether this happened or
    not"—resending at this point is a gamble, and getting it wrong means it ran twice.
    """
    runtime, brain = await _resend(DIM_LIGHT, DIM_LIGHT)

    (refused,) = _refusals(runtime)
    assert refused.content["error"] == "delegate_rejected"
    assert "d-1 停在 unknown" in refused.content["problem"]
    # The second task was never even created: the executor was only dispatched once, and the channel has only that one unknown.
    assert runtime.delegates.find("d-2") is None
    assert _results(runtime) == [(1.75, "unknown")]
    # After refusing, a wake-up is required (R30's first compensation), and that call has the
    # review probe on the table—what's blocked is the reflex, what's offered is an informed
    # choice. Not waking it up would turn into "refuse and don't even tell it."
    assert len(brain.views) == 3


async def test_a_readonly_probe_that_itself_stopped_at_unknown_is_not_refused() -> None:
    """The reverse twin, **this is the actual landing point of the `readonly` fork**: the probe itself stops at unknown.

    The test above only pins down "refused." Removing `if not op.readonly` from
    `_reject_reason` would still leave the above green—while this one turns red immediately,
    because a timed-out `get_state` would block its own retry, turning `unknown` into a cell
    with no way out: the only review entry point sealed off by its own first failure.
    """
    runtime, _ = await _resend(PROBE, PROBE)

    assert _refusals(runtime) == []
    assert runtime.delegates.terminated_by("d-2") == "handoff"
    assert [outcome for _, outcome in _results(runtime)] == ["unknown", "unknown"]


async def test_a_late_verdict_lifts_the_fence_and_the_refusal_never_lies() -> None:
    """A late verdict lifts the fence, because it's no longer an unknown → the fence lets go (R53).

    This cell is the next beat after `_run_late`'s self-correction: after the model reads "it
    actually got set," it dispatches the same light-dimming request again ("set it back, then
    dim it once more" is what that door deliberately leaves open for it). Before the fix it was
    blocked here, with an observation attached saying "d-1 stopped at unknown, review before
    deciding whether to resend"—**while that `ok` was sitting right there on the board**, the
    trunk was telling the model a flat-out lie while also blocking a legitimate resend.

    The root cause isn't in the fence but in the termination record: rule 3 doesn't allow the
    first terminator to be overwritten, so the late `ok` can't touch `record.event`, and the
    fence always reads that same `Deadline`.

    **This is the only landing point for "a late verdict" on the production path.** The test of
    the same name in `test_delegates.py` calls `note_resolved` directly; swap that call inside
    `_apply_handoff` for `pass` and it would still pass green.
    """
    runtime, brain, _ = await _run(
        SlowSim(latency=15.0),
        replies=[
            _say("我不确定客厅灯调没调成"),
            _say_and_delegate("既然调成了，那再调暗一点"),
        ],
    )

    assert _refusals(runtime) == []  # that lie never appeared
    resent = runtime.delegates.find("d-2")
    assert resent is not None and resent.request == DIM_LIGHT.request
    # Termination rule 3 untouched: the terminator of d-1 is still that deadline.
    assert runtime.delegates.terminated_by("d-1") == "deadline"
    # The task that got through also ran its full course (the same slow sim, so the same shape
    # plays out again): each task leaves an unknown + a late ok, four observations, no task loses its follow-up.
    assert _results(runtime) == [(10.75, "unknown"), (15.75, "ok"), (26.5, "unknown"), (31.5, "ok")]
    assert (
        len(brain.views) == 5
    )  # each of the two late pieces of good news wakes it once more, then the script runs out and it has nothing left to say


async def test_the_fence_only_stops_the_first_resend() -> None:
    """Blocked once, then it lets go: what's blocked is the reflex, not "resending" itself (R49).

    Blocked, told, and woken the 2nd time; sent through as-is the 3rd time—that one is the
    model's own choice after seeing the refusal observation, and the trunk doesn't interject
    again. Permanently fencing it off would instead be a **cell with no way out**: when the
    review probe comes back saying "the light never got adjusted," the one correct action would
    still be blocked.

    **This is the only landing point for "block once" on the production path.** The test of the
    same name in `test_delegates.py` calls `note_fenced` directly, pinning down that ledger
    method itself; swap that `note_fenced` call inside `_reject_reason` for `pass` (= permanently
    fenced) and it would still pass green—a mutation test, which is why this one has to live here.
    """
    runtime, _ = await _resend(DIM_LIGHT, DIM_LIGHT, DIM_LIGHT)

    assert len(_refusals(runtime)) == 1
    resent = runtime.delegates.find("d-2")
    assert resent is not None and resent.request == DIM_LIGHT.request


async def test_the_review_probe_after_an_unknown_set_light_gets_through() -> None:
    """The **designed** way out after `unknown`: switch to a read-only probe to review, and it still gets dispatched.

    **It's the joint exit of two safeguards, not the landing point of either one alone**—found by
    mutation testing: there are two reasons it's let through here, the `op.readonly` fork and the
    op comparison inside "all three fields equal counts as the same thing," each independently
    valid. So changing either one alone doesn't turn it red (drop the readonly fork → the twin
    test above turns red; narrow the three-field comparison down to `(executor,)` → the request
    twin test in `test_delegates.py` turns red). It's kept here because everywhere else only
    verifies one cell: what R13/R31's whole review chain is asking is whether this end-to-end path
    actually gets through.
    """
    runtime, _ = await _resend(DIM_LIGHT, PROBE)

    assert _refusals(runtime) == []
    probe = runtime.delegates.find("d-2")
    assert probe is not None and probe.op == "get_state"
