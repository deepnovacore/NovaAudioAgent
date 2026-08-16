"""Scenario 4: proactively speaking up when no one summoned it (06-verification.md's fourth acceptance line).

The difference between this one and the previous three is that **no one is waiting**: no user
input, no dispatched task coming back—only a little activity on the environment channel. It runs
in two hops—the surrogate glances at the world and decides whether to speak and which one to
pick, and then the FastBrain turns that material into words.

**The single-persona invariant lands on "what the surrogate lacks"**: none of `SurrogateOutput`'s
three fields is text; it doesn't touch the sink, doesn't touch the Floor, doesn't occupy an
utterance_id. So the tests here keep asking the same question over and over—whose output was
that line, in the end.

The two cooldown locks have paired unit-level tests in `test_suggestions.py`; here we only verify
that they're **actually locked across the whole pipeline**: the same suggestion can't be said a
second time within the cooldown, and after the cooldown expires plus a new observation it can be
said again.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import HandoffEvent, UserInput, WakeReason
from nova_audio_agent.executors.sims import SlowSim
from nova_audio_agent.memory import CONVERSATION_CHANNEL, USER_PRIORITY, Memory
from nova_audio_agent.ports import (
    ActionOutput,
    DelegateRequest,
    FastBrainOutput,
    SpeakOutput,
    SurrogateOutput,
)
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.speech import RecordingSink
from nova_audio_agent.suggestions import DEFAULT_COOLDOWN, Suggestion, is_available
from fakes import ScriptedFastBrain, ScriptedSurrogate
from policies import AMBIENT_POLICY, SIM_POLICIES
from snapshot import assert_snapshot, to_snapshot

LATENCY = 0.25  # same value as scenarios 1/3, see there for why: 0.1 isn't binary-exact, so snapshots would be full of noise
WATCH_LATENCY = 0.05

DIM_LIGHT = DelegateRequest(
    executor="slow_sim",
    op="set_light",
    request={"room": "客厅", "brightness": 30},
    origin_ref="conversation:1",
)


def _say(text: str) -> FastBrainOutput:
    return FastBrainOutput(speak=SpeakOutput(act="say", text=text), action=ActionOutput(act="none"))


def _ask(text: str) -> FastBrainOutput:
    return FastBrainOutput(speak=SpeakOutput(act="ask", text=text), action=ActionOutput(act="none"))


def _say_and_delegate(text: str) -> FastBrainOutput:
    return FastBrainOutput(
        speak=SpeakOutput(act="say", text=text),
        action=ActionOutput(act="delegate", delegate=DIM_LIGHT),
    )


def _ambient(**content: object) -> HandoffEvent:
    """An observation on the environment channel. **There's no delegate behind it**—the one shape gap this round.

    There's no "observation with no summoner" category among the seven lines/eight types: an
    observation on the executor side only ever comes in via a handoff. So here we borrow
    handoff's shell, and `delegate_id` points to a task that can't be found.
    `routing_class_of` falls back to `ambient` when it can't find one, and that result is
    correct—an observation no one claimed shouldn't have the standing to interrupt the user.

    **But "can't be found" is luck belonging to this fixture, not a property of this path**
    (codex review correction): swap `d-ambient` for a genuinely in-flight id, and
    `_apply_handoff`'s first line, `terminate`, would terminate that task (its own deadline then
    spins idle, and the `unknown` fallback never happens), while this exogenous observation gets
    mistaken for that task's result and wakes it by that task's routing class—`user_awaited`
    would bypass `policy.wake`. The real reason we don't hit this today is that **only the test's
    `post()` accepts a `HandoffEvent`**: what executors hand up no longer has a `delegate_id`
    (R46), so there's no second submitter on the production path.

    **Trigger condition**: once we wire in the first genuine push-style executor (sensor / timer),
    come back and settle this category's shape. Opening a second event category before that would
    be designing for something we haven't seen yet, and the debt of this shell-borrowing, along
    with its consequences, is recorded together in 08-deferred.md, "both sides of real ingress."
    """
    return HandoffEvent(
        channel="ambient",
        delegate_id="d-ambient",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content=dict(content),
    )


def _build(
    *,
    replies: Sequence[FastBrainOutput] = (),
    decisions: Sequence[SurrogateOutput] = (),
    on_suggestion_selected: Callable[[Suggestion, WakeReason], None] | None = None,
) -> tuple[Runtime, ScriptedFastBrain, ScriptedSurrogate, RecordingSink]:
    clock = VirtualClock()
    brain = ScriptedFastBrain(list(replies), clock=clock, latency=LATENCY)
    surrogate = ScriptedSurrogate(list(decisions), clock=clock, latency=WATCH_LATENCY)
    sink = RecordingSink(clock)
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(*SIM_POLICIES, AMBIENT_POLICY)),
        fastbrain=brain,
        surrogate=surrogate,
        executors={"slow_sim": SlowSim()},
        sink=sink,
        on_suggestion_selected=on_suggestion_selected,
    )
    return runtime, brain, surrogate, sink


def _remember(runtime: Runtime, text: str) -> None:
    """Write "the user said this before" straight into the conversation channel, **without posting a UserInput**.

    Posting a UserInput would wake the FastBrain on the spot, so there'd be no way to tell
    whether the following utterance was a wake-up response or spoken proactively—and "speaking
    up even when no one is waiting" is exactly the whole point of this acceptance line.
    This also gives `conversation:1`, which is the parent the ambient observation is attributed to.
    """
    runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=0.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": text},
    )


def _pooled(view: object) -> list[str]:
    """The suggestion ids currently sitting on the table in one view."""
    return [
        affordance.ref
        for affordance in view.affordances  # type: ignore[attr-defined]
        if affordance.source == "suggestion"
    ]


# ---- Two hops to speech ----


async def test_the_surrogate_picks_from_the_pool_and_the_fast_brain_says_it() -> None:
    """Scenario 4's trunk: one environment observation → the surrogate picks the one in the pool → the FastBrain speaks it.

    **The FastBrain is never woken directly by that observation**: the ambient channel's policy is
    `wake="surrogate"`, so the source of that one entry in `brain.views` can only be the second
    hop. That's the whole dividing line between "proactive" and "reactive," and it's the entire
    difference between this test and the previous three scenarios.
    """
    runtime, brain, surrogate, sink = _build(
        replies=[_say("刚才那次调灯到现在还没有回音，要我再试一次吗")],
        decisions=[SurrogateOutput(speak=True, suggestion_id="s-1", reason="灯的事还没着落")],
    )
    _remember(runtime, "帮我看着点客厅")
    runtime.suggestions.add(
        origin="fast_brain",
        kind="question",
        content={"text": "调灯那次没有回音"},
        evidence_refs=("ambient:1",),
    )
    runtime.post(_ambient(motion="客厅有人经过"))

    await runtime.run()

    # First hop: the surrogate saw it, and saw it via affordances, not from anywhere else.
    assert len(surrogate.watched) == 1
    assert _pooled(surrogate.watched[0]) == ["s-1"]
    # Second hop: on the FastBrain's view, that suggestion carries the "selected" mark.
    assert len(brain.views) == 1
    (selected,) = [
        affordance
        for affordance in brain.views[0].affordances
        if affordance.content.get("selected") is True
    ]
    assert selected.ref == "s-1"
    assert sink.utterances() == ["刚才那次调灯到现在还没有回音，要我再试一次吗"]
    # Only once the words actually went out does the pool lock at that moment (R26).
    fired = runtime.suggestions.get("s-1")
    assert fired is not None and fired.status == "fired"


async def test_the_words_are_the_fast_brains_not_the_surrogates() -> None:
    """Enforce one persona: neither Surrogate field is copied to the speech sink.

    The suggestion text and Surrogate reason are both **material** (D16), not user-
    facing utterances. Forwarding them directly would expose ledger language or the
    Surrogate's internal judgment. Assert both directions: the sink receives the
    FastBrain line and contains neither source phrase.

    The test name claims slightly more than a scripted model can prove. The scripted
    FastBrain returns a string written in the fixture, so its difference from the
    source phrases is predetermined. What this test actually fixes is the wiring:
    output comes from `FastBrainOutput.speak.text`, while neither Surrogate field,
    `suggestion_id` nor `reason`, has a path to the sink. It fails if the spine ever
    appends `reason` to user-facing speech. Whether a real model copies the supplied
    material belongs on the Stage C scorecard.
    """
    runtime, brain, surrogate, sink = _build(
        replies=[_say("客厅灯那边我还没等到回音，要不要我再试一次")],
        decisions=[SurrogateOutput(speak=True, suggestion_id="s-1", reason="灯的事还没着落")],
    )
    _remember(runtime, "帮我看着点客厅")
    runtime.suggestions.add(
        origin="fast_brain", kind="question", content={"text": "调灯那次没有回音"}
    )
    runtime.post(_ambient(motion="客厅有人经过"))

    await runtime.run()

    (spoken,) = sink.utterances()
    assert spoken == "客厅灯那边我还没等到回音，要不要我再试一次"
    assert "调灯那次没有回音" not in spoken  # The suggestion text was not forwarded.
    assert "灯的事还没着落" not in spoken  # The Surrogate reason is not user-facing.
    # Store AI speech in the conversation channel and distinguish its author by trust
    # (R22). The Surrogate hop writes nothing.
    said = [item for item in runtime.memory.channels[CONVERSATION_CHANNEL].items]
    assert [item.trust for item in said] == ["trusted_user", "trusted_system"]
    assert said[-1].content["text"] == spoken


async def test_fast_brain_text_path_takes_precedence_over_runtime_callback() -> None:
    selected: list[tuple[Suggestion, WakeReason]] = []
    runtime, _, _, sink = _build(
        replies=[_say("杯子还在桌上")],
        decisions=[SurrogateOutput(speak=True, suggestion_id="s-1", reason="值得提醒")],
        on_suggestion_selected=lambda suggestion, reason: selected.append((suggestion, reason)),
    )
    _remember(runtime, "帮我留意桌面")
    runtime.suggestions.add(origin="fast_brain", kind="notify", content={"text": "杯子还在桌上"})
    runtime.post(_ambient(observation="cup"))

    await runtime.run()

    assert sink.utterances() == ["杯子还在桌上"]
    assert selected == []


async def test_a_silent_second_hop_does_not_consume_the_suggestion() -> None:
    """R26's converse: silence does not count as having spoken.

    This covers the ledger mutation that fires a suggestion at selection time. The
    Surrogate selects it, but FastBrain emits nothing, the `(none, none)` combination.
    Firing on selection would start a full cooldown despite the user hearing nothing,
    and the suggestion would disappear from future views. Proactivity would fail
    silently without this test.
    """
    runtime, brain, surrogate, sink = _build(
        decisions=[SurrogateOutput(speak=True, suggestion_id="s-1", reason="灯的事还没着落")]
    )
    _remember(runtime, "帮我看着点客厅")
    runtime.suggestions.add(
        origin="fast_brain", kind="question", content={"text": "调灯那次没有回音"}
    )
    runtime.post(_ambient(motion="客厅有人经过"))

    await runtime.run()

    assert len(brain.views) == 1  # The second hop ran; it was not skipped.
    assert sink.utterances() == []  # But it emitted no speech.
    intact = runtime.suggestions.get("s-1")
    assert intact is not None
    assert intact.status == "pending"
    assert intact.cooldown_until == 0.0  # Cooldown never started.
    assert is_available(intact, now=runtime.clock.now())


# ---- Two locks: no repeats during cooldown; rearm permits another attempt ----


async def test_the_same_suggestion_cannot_be_said_twice_inside_the_cooldown() -> None:
    """Exercise the first lock across the full pipeline.

    The Surrogate selects the same suggestion again and is stopped in two places.
    First, view compilation uses `is_available` at `now`, so the suggestion is absent
    from the second watch view. Second, `_consume_watch` still rejects an ID that is
    currently unavailable; honoring that hallucination would bypass the cooldown.
    Both enforcement points share one predicate and therefore cannot disagree.
    """
    runtime, brain, surrogate, sink = _build(
        replies=[_say("客厅灯那边还没有回音")],
        decisions=[
            SurrogateOutput(speak=True, suggestion_id="s-1", reason="第一次"),
            SurrogateOutput(speak=True, suggestion_id="s-1", reason="再说一次"),
        ],
    )
    _remember(runtime, "帮我看着点客厅")
    runtime.suggestions.add(
        origin="fast_brain",
        kind="question",
        content={"text": "调灯那次没有回音"},
        evidence_refs=("ambient:1",),
    )
    runtime.post(_ambient(motion="客厅有人经过"))
    runtime.post(_ambient(motion="客厅还有人"), delay=1.0)  # Well inside the cooldown.

    await runtime.run()

    assert len(surrogate.watched) == 2
    assert _pooled(surrogate.watched[0]) == ["s-1"]
    assert _pooled(surrogate.watched[1]) == []  # Spoken suggestions leave the table.
    assert sink.utterances() == ["客厅灯那边还没有回音"]  # Spoken only once.
    assert len(brain.views) == 1


async def test_a_new_observation_after_the_cooldown_puts_it_back_on_the_table() -> None:
    """Exercise the second lock across the pipeline: rearm, not one-shot use.

    This complements the preceding test. That test alone would allow an
    implementation that treats `fired` as terminal, suppressing a suggestion forever
    even after the world changes. The two conditions are AND, not OR: cooldown has
    elapsed and a new observation has arrived. `test_suggestions.py` has a negative
    case for each missing condition.
    """
    runtime, brain, surrogate, sink = _build(
        replies=[_say("客厅灯那边还没有回音"), _say("客厅灯到现在也还是没有回音")],
        decisions=[
            SurrogateOutput(speak=True, suggestion_id="s-1", reason="第一次"),
            SurrogateOutput(speak=True, suggestion_id="s-1", reason="世界又动了一下"),
        ],
    )
    _remember(runtime, "帮我看着点客厅")
    runtime.suggestions.add(
        origin="fast_brain",
        kind="question",
        content={"text": "调灯那次没有回音"},
        evidence_refs=("ambient:1",),
    )
    runtime.post(_ambient(motion="客厅有人经过"))
    runtime.post(_ambient(motion="客厅又有人经过"), delay=DEFAULT_COOLDOWN + 10.0)

    await runtime.run()

    assert _pooled(surrogate.watched[1]) == ["s-1"]  # The suggestion is back on the table.
    assert sink.utterances() == ["客厅灯那边还没有回音", "客厅灯到现在也还是没有回音"]
    fired_again = runtime.suggestions.get("s-1")
    assert fired_again is not None and fired_again.status == "fired"
    assert not is_available(fired_again, now=runtime.clock.now())  # The second use locks it too.


# ---- Selection sensitivity ----


async def _run_selective() -> tuple[Runtime, ScriptedFastBrain, ScriptedSurrogate, RecordingSink]:
    """Offer two suggestions and select the later one related to in-flight work.

    Timeline: at t=0 the user speaks, and FastBrain speaks while dispatching work that
    takes five seconds. At t=1 the environment changes. The Surrogate can now see both
    in-flight `d-1` and the two pooled suggestions, selects `s-2`, and FastBrain speaks
    it. At t=5.75 the slow work returns and wakes FastBrain normally.
    """
    runtime, brain, surrogate, sink = _build(
        replies=[
            _say_and_delegate("好的，这就去调"),
            _say("客厅灯还在调，再等我一下"),
            _say("客厅灯调好了"),
        ],
        decisions=[SurrogateOutput(speak=True, suggestion_id="s-2", reason="在飞的那条活跟它有关")],
    )
    runtime.suggestions.add(
        origin="fast_brain",
        kind="notify",
        content={"text": "冰箱门好像没关"},
        evidence_refs=("ambient:1",),
    )
    runtime.suggestions.add(
        origin="fast_brain",
        kind="question",
        content={"text": "客厅灯这次要调到多暗"},
        evidence_refs=("slow_sim:1",),
    )
    runtime.post(UserInput(text="把客厅灯调暗点"))
    runtime.post(_ambient(motion="客厅有人经过"), delay=1.0)

    await runtime.run()

    return runtime, brain, surrogate, sink


async def test_the_pick_is_the_surrogates_own_not_the_first_row_in_the_pool() -> None:
    """Verify selection sensitivity: honor the Surrogate's choice, not pool order.

    A scripted Surrogate does not genuinely inspect `in_flight`; it returns the
    fixture's answer. The test therefore has two enforceable halves:

    - **Material:** the Surrogate's view contains both suggestions and the in-flight
      delegate, giving a real model enough information to identify the related item.
    - **Execution:** the Surrogate selects `s-2`, so the second-hop view must mark
      `s-2`. Changing `_consume_watch` to take the first available suggestion fails
      here, reproducing the ledger's "Surrogate takes `[0]`" mutation.

    The final sink assertion does not prove that speech semantically describes `s-2`.
    The scripted FastBrain says the fixture text regardless of suggestion content. It
    proves only that the second hop spoke and occupied the second position. Matching
    output content to the selected suggestion, and proving that the Surrogate really
    used `in_flight`, belong on the Stage C real-model scorecard.
    """
    runtime, brain, surrogate, sink = await _run_selective()

    watched = surrogate.watched[0]
    assert [delegate.delegate_id for delegate in watched.in_flight] == ["d-1"]
    assert _pooled(watched) == ["s-1", "s-2"]

    (selected,) = [
        affordance
        for affordance in brain.views[1].affordances
        if affordance.content.get("selected") is True
    ]
    assert selected.ref == "s-2"
    assert selected.content["suggestion"]["text"] == "客厅灯这次要调到多暗"
    assert sink.utterances()[1] == "客厅灯还在调，再等我一下"

    # The unselected item remains unchanged; selection does not consume the whole pool.
    untouched = runtime.suggestions.get("s-1")
    assert untouched is not None and untouched.status == "pending"


async def test_the_second_hop_only_sees_the_one_it_was_told_to_say() -> None:
    """R38: expose only the selected suggestion on the second-hop table.

    This rule came from probe results, not design speculation. When both suggestions
    remained visible and only the selected one was marked, qwen-max included the
    other suggestion in all three runs.

    The consequence is more than verbosity. The unselected item never reaches
    `_lock_spoken`, which fires only `record.selected_suggestion`, so it can be spoken
    without being locked. Its cooldown never starts and it appears on the next table,
    reopening the periodic replay path that the two locks in 02-memory.md must close.
    The second assertion below enforces that the item cannot be spoken, a prerequisite
    for the lock to remain truthful.

    The Surrogate hop is unaffected: it has no selection mark and must see both items
    in order to choose one.
    """
    runtime, brain, surrogate, _ = await _run_selective()

    assert _pooled(surrogate.watched[0]) == ["s-1", "s-2"]  # Surrogate sees the full table.
    assert _pooled(brain.views[1]) == ["s-2"]  # Second hop sees only its assignment.
    # If it cannot reach the table, it cannot be spoken without being locked.
    unlocked = runtime.suggestions.get("s-1")
    assert unlocked is not None and unlocked.cooldown_until == 0.0


async def test_the_delegates_own_handoff_does_not_rearm_a_suggestion_in_cooldown() -> None:
    """Do not rearm from the delegate's handoff while cooldown is active.

    The slow work returns at t=5.75 on the channel referenced by `s-2`, but source
    activity is only one of the two conditions. Without the cooldown condition, the
    next observation on its own channel would immediately unlock a just-spoken
    suggestion and repeat it to the user within seconds.
    """
    runtime, brain, _, sink = await _run_selective()

    assert [event.KIND for event in runtime.applied].count("handoff") == 2  # Ambient and slow sim.
    still_locked = runtime.suggestions.get("s-2")
    assert still_locked is not None and still_locked.status == "fired"
    # Three calls: dispatch, proactive speech, and the slow handoff. No fourth repeat.
    assert len(brain.views) == 3
    assert sink.utterances() == ["好的，这就去调", "客厅灯还在调，再等我一下", "客厅灯调好了"]


# ---- A selection travels with its wake; it is not a global scalar (R39/R40) ----


async def test_a_wake_that_loses_the_merge_takes_its_pick_down_with_it() -> None:
    """Discard a selection when a more urgent wake wins the pending merge.

    If the runtime stored "selected" in a scalar, the later weather call would take
    the refrigerator suggestion with it and `_lock_spoken` would fire it after the
    unrelated response. The user would hear nothing about the refrigerator while the
    suggestion remained locked for a full cooldown, reopening the R26 failure through
    another path.

    Timeline: at t=0 the user speaks and FastBrain remains busy until t=0.25. At
    t=0.05 the environment changes, and at t=0.10 the Surrogate selects `s-1`; because
    FastBrain is in flight, that wake merges into pending. At t=0.15 the user asks
    another question. Its priority 100 beats the environment's 10, so `higher()` keeps
    the user wake and discards its competitor together with the selection.

    Attaching the choice to `WakeReason` makes this automatic: the losing reason is
    discarded as a unit, and the spine need not know it also discarded a selection.
    """
    runtime, brain, _, sink = _build(
        replies=[_say("我盯着客厅呢"), _say("北京今天晴，最高 31 度")],
        decisions=[SurrogateOutput(speak=True, suggestion_id="s-1", reason="冰箱那事该说了")],
    )
    runtime.suggestions.add(
        origin="fast_brain",
        kind="notify",
        content={"text": "冰箱门好像没关"},
        evidence_refs=("ambient:1",),
    )
    runtime.post(UserInput(text="帮我看着点客厅"))
    runtime.post(_ambient(motion="客厅有人经过"), delay=0.05)
    runtime.post(UserInput(text="北京今天天气怎么样"), delay=0.15)

    await runtime.run()

    assert sink.utterances() == ["我盯着客厅呢", "北京今天晴，最高 31 度"]
    # The weather call carries no selection. Its table is the normal visible pool,
    # not a narrowed assignment.
    assert len(brain.views) == 2
    assert [
        affordance
        for affordance in brain.views[1].affordances
        if affordance.content.get("selected")
    ] == []
    # The suggestion remains intact, with no cooldown, so it can be spoken later.
    intact = runtime.suggestions.get("s-1")
    assert intact is not None and intact.status == "pending"
    assert intact.cooldown_until == 0.0


async def test_a_pick_that_went_stale_while_it_waited_is_dropped_at_spawn() -> None:
    """Drop a selection that becomes stale while waiting to spawn.

    Two watch calls select the same suggestion while it remains continuously
    available. Because `fire` occurs only when speech is emitted (R26), `s-1` is still
    present when the second watch view is compiled, so both selections are valid.
    The second ticket becomes invalid only when redeemed: it waits in pending until
    the first call speaks and locks `s-1`.

    A stale ticket does not repeat `s-1`, because firing an already fired suggestion
    is a no-op. Its harm is elsewhere and silent:

    - Under R38 it clears the whole table. R38 exposes only the selected item, but
      `is_available` now filters that item out, so the second call sees an empty table
      even though `s-2` is still waiting in the pool.
    - `_lock_spoken` sees `record.selected_suggestion`, fires it, and returns early, so
      the question actually spoken by this call leaves no `fired` row. The pool then
      stops being a ledger of questions, even though B4 selection must ask whether a
      question has already been asked.

    Timeline: at t=0 the environment changes, the Surrogate selects `s-1` at t=0.05,
    and FastBrain starts with it. At t=0.06 the environment changes again, and at
    t=0.11 the Surrogate selects still-pending `s-1` again. FastBrain is in flight, so
    this wake enters pending. When step 4 reruns it after the first call speaks and
    locks `s-1`, the ticket has expired.
    """
    runtime, brain, surrogate, sink = _build(
        replies=[_say("冰箱门好像忘了关"), _ask("客厅灯要调到多暗")],
        decisions=[
            SurrogateOutput(speak=True, suggestion_id="s-1", reason="第一次"),
            SurrogateOutput(speak=True, suggestion_id="s-1", reason="它还在桌上"),
        ],
    )
    _remember(runtime, "帮我看着点客厅")
    runtime.suggestions.add(
        origin="fast_brain",
        kind="notify",
        content={"text": "冰箱门好像没关"},
        evidence_refs=("ambient:1",),
    )
    runtime.suggestions.add(
        origin="fast_brain",
        kind="question",
        content={"text": "客厅灯这次要调到多暗"},
        evidence_refs=("ambient:1",),
    )
    runtime.post(_ambient(motion="客厅有人经过"))
    runtime.post(_ambient(motion="客厅还有人"), delay=0.06)

    await runtime.run()

    # Both watch calls saw a valid table; the selection time is not the problem.
    assert [_pooled(view) for view in surrogate.watched] == [["s-1", "s-2"], ["s-1", "s-2"]]
    assert _pooled(brain.views[0]) == ["s-1"]  # First hop: R38 exposes only its assignment.
    assert _pooled(brain.views[1]) == ["s-2"]  # No valid ticket; show the remaining item.
    assert sink.utterances() == ["冰箱门好像忘了关", "客厅灯要调到多暗"]
    # The second call asked a real question, so the pool must retain a `fired` row.
    assert [item.id for item in runtime.suggestions.all()] == ["s-1", "s-2", "s-3"]
    assert runtime.suggestions.get("s-3").status == "fired"  # type: ignore[union-attr]


async def test_a_pick_the_surrogate_never_saw_on_its_table_is_refused() -> None:
    """Reject a suggestion ID the Surrogate never saw on its table.

    The suggestion rearms while the Surrogate is in flight. Checking only current
    availability is insufficient: the table was compiled at t=0.05, consumption
    happens at t=0.10, and a genuine rearm occurs between them. Returning an unseen
    ID has the shape of a hallucination; honoring it would make the spine endorse the
    model's invention.

    Timeline: `s-1` was spoken at t=0 and remains on cooldown until t=60. At t=59.99
    the environment changes and the Surrogate starts while `s-1` is still locked and
    absent. At t=60.01 another observation arrives after cooldown, satisfying both
    locks and returning `s-1` to pending. At t=60.04 the Surrogate returns `s-1`.
    """
    runtime, brain, surrogate, sink = _build(
        decisions=[SurrogateOutput(speak=True, suggestion_id="s-1", reason="它刚回到桌上")]
    )
    _remember(runtime, "帮我看着点客厅")
    runtime.suggestions.add(
        origin="fast_brain",
        kind="notify",
        content={"text": "冰箱门好像没关"},
        evidence_refs=("ambient:1",),
    )
    runtime.suggestions.fire("s-1", now=0.0, cooldown=60.0)
    runtime.post(_ambient(motion="客厅有人经过"), delay=59.99)
    runtime.post(_ambient(motion="客厅还有人"), delay=60.01)

    await runtime.run()

    assert _pooled(surrogate.watched[0]) == []  # Its table was empty.
    assert runtime.suggestions.get("s-1").status == "pending"  # type: ignore[union-attr]
    assert sink.utterances() == []  # No second hop.
    assert brain.views == []


async def test_the_surrogate_never_sees_an_idle_floor_while_the_fast_brain_speaks() -> None:
    """Never show an idle Floor while FastBrain speech is already opening.

    When the Surrogate view is compiled, `speak_start` is still queued and has not
    been applied. Without the reservation in `_open_floor`, `self.floor` would still
    read `idle`, inviting the Surrogate to speak over FastBrain. That is not merely a
    stale value; it contradicts the actual state.

    The window is real: the ambient observation was enqueued before `speak_start`, so
    it has the lower sequence number while both have `kind_rank=0` and is applied
    first. The final assertion proves this ordering; otherwise the test could pass
    vacuously when `speak_start` happened to run first.
    """
    runtime, _, surrogate, _ = _build(replies=[_say("好的，我盯着客厅")])
    runtime.post(UserInput(text="帮我看着点客厅"))
    runtime.post(_ambient(motion="客厅有人经过"), delay=LATENCY)  # When the first text exits.

    await runtime.run()

    assert len(surrogate.watched) == 1
    assert surrogate.watched[0].now == LATENCY
    assert surrogate.watched[0].floor == "agent_speaking"
    kinds = [event.KIND for event in runtime.applied]
    assert kinds.index("handoff") < kinds.index("speak_start")


# ---- Proactive dispatch inherits routing from the wake, not the origin (R45) ----


async def test_a_dispatch_on_the_production_path_binds_routing_from_the_wake_not_the_origin() -> (
    None
):
    """Test production wiring beyond `bind_delegate`'s pure-function coverage.

    A review mutation changed `Runtime._dispatch` to infer routing from the
    `origin_ref` channel instead of `record.reason`; all 205 tests still passed because
    none created a production case where wake class and origin channel disagreed.
    This test creates that mismatch in both directions:

    - **Do not escalate d-1.** The proactive two-hop dispatch correctly references a
      real user utterance because that is what it answers, while its routing class
      remains `ambient`. Following the origin would give unsolicited proactive speech
      permission to interrupt the user.
    - **Do not silence d-2.** Work dispatched in response to the user references an
      environment observation, while its routing class remains `user_awaited`.
      Following the origin would leave the user's request with no follow-up.

    Both origins pass `validate_origin_ref` because both observations are genuinely in
    the view. This test therefore covers what is bound after validation, not
    validation itself.
    """
    runtime, brain, _, _ = _build(
        replies=[
            _say_and_delegate("好的，这就去调"),  # Proactive hop; origin is conversation:1.
            FastBrainOutput(
                speak=SpeakOutput(act="say", text="卧室灯也一起"),
                action=ActionOutput(
                    act="delegate",
                    delegate=DelegateRequest(
                        executor="slow_sim",
                        op="set_light",
                        request={"room": "卧室", "brightness": 30},
                        origin_ref="ambient:1",  # User wake; origin is an environment observation.
                    ),
                ),
            ),
        ],
        decisions=[SurrogateOutput(speak=True, suggestion_id="s-1", reason="灯的事还没着落")],
    )
    _remember(runtime, "帮我看着点客厅")
    runtime.suggestions.add(
        origin="fast_brain", kind="question", content={"text": "调灯那次没有回音"}
    )
    runtime.post(_ambient(motion="客厅有人经过"))
    runtime.post(UserInput(text="卧室灯也调暗点"), delay=2.0)  # Proactive hop has finished.

    await runtime.run()

    assert len(brain.views) >= 2  # Both hops ran; the scripted replies were consumed.
    proactive = runtime.delegates.find("d-1")
    awaited = runtime.delegates.find("d-2")
    assert proactive is not None and awaited is not None
    # Prove the origins form the intended crossed pair before checking routing.
    assert (proactive.origin_ref, awaited.origin_ref) == ("conversation:1", "ambient:1")
    assert proactive.routing_class == "ambient"
    assert awaited.routing_class == "user_awaited"


# ---- Route every question through the pool ----


async def test_a_question_that_got_through_still_leaves_a_fired_row_in_the_pool() -> None:
    """Leave a `fired` pool row even for an admitted question.

    This is one of the three entry paths in 02-memory.md. Without it, the pool records
    only questions that could not be asked, not all questions. B4 suggestion
    selection needs to know whether something was asked, not merely whether it was
    withheld.

    This record currently has no consumer and cannot prevent semantic repetition
    because the pool does not deduplicate by content. It blocks only reselection of
    the same pool record. True deduplication would require embeddings or
    normalization after a real-model probe establishes the shape of repetition.
    """
    runtime, _, _, sink = _build(replies=[_ask("客厅灯要调到多暗")])
    runtime.post(UserInput(text="把客厅灯调暗点"))

    await runtime.run()

    assert sink.utterances() == ["客厅灯要调到多暗"]
    (asked,) = runtime.suggestions.all()
    assert asked.kind == "question"
    assert asked.content["text"] == "客厅灯要调到多暗"
    assert asked.status == "fired"  # Already asked; the Surrogate must not select it.
    assert not is_available(asked, now=runtime.clock.now())


async def test_a_statement_that_got_through_leaves_nothing_in_the_pool() -> None:
    """The converse: the pool is a question ledger, not a copy of every utterance.

    Adding every statement would make the pool grow linearly with the conversation,
    and every entry would participate in `is_available` and rearm decisions at
    increasing cost with no benefit. This is the first behavioral consequence of the
    `speak_act` default: an unspecified act means `say` (R29).
    """
    runtime, _, _, sink = _build(replies=[_say("灯已经调好了")])
    runtime.post(UserInput(text="把客厅灯调暗点"))

    await runtime.run()

    assert sink.utterances() == ["灯已经调好了"]
    assert runtime.suggestions.all() == ()


async def test_context_view_snapshots_of_every_model_call() -> None:
    """Snapshot every model call for both slots.

    Use the selection-sensitive path because it is the only one of the four scenarios
    that simultaneously contains in-flight work, two suggestions, and a selection
    mark. The Surrogate snapshot is the first fixture that fixes exactly what the
    Surrogate saw.
    """
    _, brain, surrogate, _ = await _run_selective()

    assert len(brain.views) == 3
    for index, view in enumerate(brain.views, start=1):
        assert_snapshot(f"scenario4_call{index}", to_snapshot(view))
    assert len(surrogate.watched) == 1
    for index, view in enumerate(surrogate.watched, start=1):
        assert_snapshot(f"scenario4_watch{index}", to_snapshot(view))
