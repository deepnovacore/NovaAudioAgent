"""ContextView: a pure function plus snapshot-based test records (Phase A green items A2-2, A2-3).

FastBrain doesn't read channels directly; this layer sits in between (D9). It's
the one place that can hold back context bloat, and the one place that can pin
down exactly "what FastBrain actually saw".

In A2 it only fills in channels / floor / now; the six historical fields are present, and
the three historical empty fields are there too. M1 adds a seventh, default-empty trigger field.
"""

from __future__ import annotations

import pytest

from nova_audio_agent.context_view import FRESH_WINDOW, ContextView, compile_context_view
from nova_audio_agent.executors import SlowSim
from nova_audio_agent.memory import (
    CONVERSATION_CHANNEL,
    Authorization,
    Goal,
    Intent,
    Memory,
    StructuredState,
    parse_ref,
)
from nova_audio_agent.suggestions import SuggestionPool
from policies import SLOW_SIM_POLICY
from snapshot import assert_snapshot, to_snapshot


def _loaded_memory() -> Memory:
    """The snapshot's input fixture can't be an empty memory, or the first snapshot would be an empty file."""
    memory = Memory(policies=(SLOW_SIM_POLICY,))
    memory.append(
        CONVERSATION_CHANNEL,
        ts=0.0,
        trust="trusted_user",
        priority=100,
        content={"text": "帮我把客厅灯调暗点"},
    )
    memory.append(
        CONVERSATION_CHANNEL,
        ts=6.0,
        trust="trusted_user",
        priority=100,
        content={"text": "顺便，今晚适合看什么电影？"},
    )
    memory.append(
        "slow_sim",
        ts=5.0,
        trust="trusted_system",
        priority=50,
        content={"room": "客厅", "brightness": 30},
        outcome="ok",
        refs=("conversation:1",),
    )
    memory.append(
        "slow_sim",
        ts=5.5,
        trust="trusted_system",
        priority=50,
        content={"room": "客厅", "state": "on"},
        outcome="ok",
        refs=("conversation:1",),
    )
    memory.structured = StructuredState(
        intent=Intent(
            objective_hypothesis="把客厅灯调到偏暗",
            constraints=("不要全关",),
            unresolved_questions=("要多暗？",),
            uncertainty=0.4,
            revision=2,
        ),
        goal=Goal(objective="客厅灯调暗", acceptance_criteria=("亮度 < 40%",), revision=1),
        authorization=Authorization(
            allow=("客厅灯开关",), evidence_refs=("conversation:1",), revision=1
        ),
    )
    return memory


def test_compile_is_a_pure_function() -> None:
    memory = _loaded_memory()

    first = compile_context_view(memory, floor="idle", now=7.0)
    second = compile_context_view(memory, floor="idle", now=7.0)

    assert first == second
    untouched = _loaded_memory().channels[CONVERSATION_CHANNEL].items
    assert memory.channels[CONVERSATION_CHANNEL].items == untouched


def test_different_memories_compile_to_different_views() -> None:
    """Positive twin: a view that always returns a constant would perfectly satisfy "pure function", so we must verify it actually reads memory."""
    memory = _loaded_memory()
    view = compile_context_view(memory, floor="idle", now=7.0)

    memory.append(
        CONVERSATION_CHANNEL, ts=8.0, trust="trusted_user", priority=100, content={"text": "算了"}
    )
    after = compile_context_view(memory, floor="idle", now=9.0)

    assert after != view
    assert after.channels != view.channels


def test_view_carries_the_seven_fields() -> None:
    memory = _loaded_memory()

    view = compile_context_view(memory, floor="user_speaking", now=7.0)

    assert set(to_snapshot(view)) == {
        "structured",
        "channels",
        "in_flight",
        "affordances",
        "floor",
        "now",
        "trigger_kind",
    }
    assert view.floor == "user_speaking"
    assert view.now == 7.0
    assert view.trigger_kind is None
    assert view.in_flight == ()  # the in-flight table is provided by the caller; not given here
    assert view.structured.intent.objective_hypothesis == "把客厅灯调到偏暗"
    # Even without a suggestion pool or manifests, there are still two affordance
    # sources: the unresolved question in Intent, and the observation that just
    # arrived on the slow_sim channel.
    assert [affordance.source for affordance in view.affordances] == [
        "unresolved_question",
        "channel_update",
    ]


def test_channels_view_reads_the_summary_slot_not_the_raw_log() -> None:
    """The output of compression lands in channel.summary; ContextView reads it (the writer arrives in Phase C)."""
    memory = _loaded_memory()
    memory.channels["slow_sim"].summary = "调过一次客厅灯，成功"

    view = compile_context_view(memory, floor="idle", now=7.0)
    slow = next(channel for channel in view.channels if channel.name == "slow_sim")

    assert slow.summary == "调过一次客厅灯，成功"
    assert [item.content["brightness"] for item in slow.recent if "brightness" in item.content] == [
        30
    ]


# ---- Summary blind spot: the items pushed out of the window must be countable (R50) ----


def _many(count: int) -> Memory:
    memory = Memory(policies=(SLOW_SIM_POLICY,))
    for index in range(count):
        memory.append(
            CONVERSATION_CHANNEL,
            ts=float(index),
            trust="trusted_user",
            priority=100,
            content={"text": f"第 {index + 1} 句"},
        )
    return memory


def test_a_channel_reports_how_many_items_the_window_left_out() -> None:
    """`omitted` = the count of items pushed out by the recent window.

    Without it, "how much content on this channel isn't on the table" can only be
    worked out backward by counting items -- but `Memory` isn't in the view, so
    neither the model nor an assertion can count it. When the window isn't full it
    must be 0, not negative: a `RECENT_LIMIT - len(items)` style implementation would
    give -3 here.
    """
    view = compile_context_view(_many(8), floor="idle", now=8.0)
    conversation = next(
        channel for channel in view.channels if channel.name == CONVERSATION_CHANNEL
    )

    assert len(conversation.recent) == 5
    assert conversation.omitted == 3
    assert conversation.recent[0].content["text"] == "第 4 句"

    thin = compile_context_view(_many(2), floor="idle", now=2.0)
    assert all(channel.omitted == 0 for channel in thin.channels)


def test_each_channel_counts_its_own_omissions() -> None:
    """`omitted` is **per-channel**, not "copy the conversation channel's number to everyone".

    The previous case only feeds the conversation channel, so it can't catch an
    implementation where `omitted` always reads `channels["conversation"]` --
    mutation-tested: written that way, the full suite of 210 cases stays green
    (codex review flagged this). A miscounted blind spot isn't just an ugly number:
    the only reason `omitted` exists is to let **the model see what it can't see**
    (R50), and channels like search that return several items at once are exactly
    the ones most prone to overflow and that need it most.

    The second part is the sharper half: the conversation channel is **not full**
    while the executor channel overflows. Copying the conversation channel's
    implementation here would report 0 -- turning a real blind spot into "no blind
    spot".
    """
    both = _many(8)
    for index in range(12):
        both.append(
            "slow_sim",
            ts=float(index),
            trust="trusted_system",
            priority=50,
            content={"text": f"第 {index + 1} 条"},
        )
    omitted = {
        channel.name: channel.omitted
        for channel in compile_context_view(both, floor="idle", now=12.0).channels
    }

    assert omitted == {CONVERSATION_CHANNEL: 3, "slow_sim": 7}

    quiet_user = _many(2)
    for index in range(9):
        quiet_user.append(
            "slow_sim",
            ts=float(index),
            trust="trusted_system",
            priority=50,
            content={"text": f"第 {index + 1} 条"},
        )
    lopsided = {
        channel.name: channel.omitted
        for channel in compile_context_view(quiet_user, floor="idle", now=9.0).channels
    }

    assert lopsided == {CONVERSATION_CHANNEL: 0, "slow_sim": 4}


def test_an_uncovered_channel_is_visible_as_such() -> None:
    """The **only** reason this field exists: `omitted > 0 and summary is None` must be countable.

    This is exactly the cell codex #28 reproduced -- 6 items, watermark 40,
    `summary=None`, the model sees 5, the 1st line isn't in the raw text and nobody
    speaks for it, and at the time **no assertion could see this happening**.

    Today this is a known, unfinished boundary of Phase C (the compression chain is
    still an empty stub), **not a bug**, so this case asserts that "the blind spot
    is observable", not "the blind spot doesn't exist". Once the compression chain is
    wired up, the half that flips is `summary is None`; the `omitted` half stays as
    is -- that's when it starts constraining coverage.
    """
    view = compile_context_view(_many(6), floor="idle", now=6.0)
    conversation = next(
        channel for channel in view.channels if channel.name == CONVERSATION_CHANNEL
    )

    assert conversation.omitted == 1 and conversation.summary is None
    # Positive twin: the omitted item really does exist on the board, it just leaves no trace in the view.
    assert all(item.content["text"] != "第 1 句" for item in conversation.recent)


def _with_unknown(memory: Memory, *, op: str = "set_light", ts: float = 6.5) -> Memory:
    """Appends an "I'm not sure" entry to the slow_sim channel. The sole trigger source for the probe affordance."""
    memory.append(
        "slow_sim",
        ts=ts,
        trust="trusted_system",
        priority=50,
        content={"error": "adapter_timeout", "op": op},
        outcome="unknown",
        refs=("conversation:1",),
    )
    return memory


def test_an_unknown_puts_the_recheck_probe_on_the_table() -> None:
    """R31: in the B3 probe, after `unknown`, qwen-max blindly resent the same activity two times out of three,

    and rendering the recheck probe is the variable that flipped that to 3/3. It comes first among the four affordance sources.
    """
    memory = _with_unknown(_loaded_memory())

    view = compile_context_view(memory, floor="idle", now=7.0, manifests=(SlowSim().manifest,))

    probes = [affordance for affordance in view.affordances if affordance.source == "probe"]
    assert [(probe.content["executor"], probe.content["op"]) for probe in probes] == [
        ("slow_sim", "get_state")
    ]
    # `conclusive` is worked out by matching OpSpec.verifies against the op name
    # recorded on that unknown: the light's actual brightness **is** the result of
    # that set_light call.
    assert probes[0].conclusive is True
    assert probes[0].ref == memory.channels["slow_sim"].items[-1].ref


def test_a_probe_that_cannot_settle_the_unknown_says_so() -> None:
    """Reverse case. Without this annotation, the model would probe an unrelated observable and then declare success (R13).

    Here the unknown originates from `get_state` itself, and `GET_STATE.verifies`
    only contains `set_light` -- querying the state again can't tell you whether the
    previous query actually succeeded.
    """
    memory = _with_unknown(_loaded_memory(), op="get_state")

    view = compile_context_view(memory, floor="idle", now=7.0, manifests=(SlowSim().manifest,))

    probes = [affordance for affordance in view.affordances if affordance.source == "probe"]
    assert [probe.conclusive for probe in probes] == [False]


def test_no_manifest_means_no_probe() -> None:
    """Manifests come from the executor registry, not read from memory -- without that executor installed, no recheck activity can be dispatched."""
    memory = _with_unknown(_loaded_memory())

    view = compile_context_view(memory, floor="idle", now=7.0)

    assert [affordance.source for affordance in view.affordances] == [
        "unresolved_question",
        "channel_update",
    ]


def test_the_pool_is_filtered_by_now_not_by_the_pool() -> None:
    """Cooldown and expiry are lazily decided here by `now`, so the trunk doesn't need a `tick` event."""
    memory = _loaded_memory()
    pool = SuggestionPool()
    alive = pool.add(origin="fast_brain", kind="question", content={"text": "要多暗？"})
    spoken = pool.add(origin="fast_brain", kind="notify", content={"text": "灯调好了"})
    pool.fire(spoken.id, now=0.0, cooldown=60.0)

    view = compile_context_view(memory, floor="idle", now=7.0, suggestions=pool.all())

    pooled = [affordance for affordance in view.affordances if affordance.source == "suggestion"]
    assert [affordance.ref for affordance in pooled] == [alive.id]
    assert pooled[0].content["kind"] == "question"
    assert "selected" not in pooled[0].content


def test_the_selected_suggestion_is_marked_but_not_restated() -> None:
    """The second hop of two-hop speaking: the mark is just a key in content, not state inside the pool.

    Marking it `fired` would make `is_available` filter it out right there -- FastBrain
    would never see the one the agent chose to have said.

    **Also pins R38: only that one is left on the table for this hop.** With both
    sitting there, probe testing showed 3/3 would end up saying the one that wasn't
    selected too, and that one never reaches `_lock_spoken` -- said aloud but never
    locked. Without a selection mark, everything is still handed over as-is (next
    case), because the agent needs to pick from among them.
    """
    memory = _loaded_memory()
    pool = SuggestionPool()
    pool.add(origin="fast_brain", kind="notify", content={"text": "灯调好了"})
    second = pool.add(origin="fast_brain", kind="question", content={"text": "要多暗？"})

    view = compile_context_view(
        memory, floor="idle", now=7.0, suggestions=pool.all(), selected_suggestion=second.id
    )

    pooled = [affordance for affordance in view.affordances if affordance.source == "suggestion"]
    assert [affordance.ref for affordance in pooled] == [second.id]
    assert pooled[0].content["selected"] is True


def test_without_a_pick_the_whole_table_is_on_offer_in_the_order_they_arrived() -> None:
    """Companion to the previous case. **This is exactly what the agent hop sees** -- it has to pick one from it.

    Not reordered by salience: which one should be said first is the agent's
    judgment call; the trunk re-sorting it would take the decision back, and
    salience is already handed over alongside each item anyway.
    """
    memory = _loaded_memory()
    pool = SuggestionPool()
    first = pool.add(origin="fast_brain", kind="notify", content={"text": "灯调好了"}, salience=9.0)
    second = pool.add(origin="fast_brain", kind="question", content={"text": "要多暗？"})

    view = compile_context_view(memory, floor="idle", now=7.0, suggestions=pool.all())

    pooled = [affordance for affordance in view.affordances if affordance.source == "suggestion"]
    assert [affordance.ref for affordance in pooled] == [
        first.id,
        second.id,
    ]  # unchanged pool-arrival order
    assert all(affordance.content.get("selected") is None for affordance in pooled)


def test_unresolved_questions_do_not_pretend_to_be_memory_refs() -> None:
    """`intent.q0` refers to a position within Structured State, not an observation on a channel.

    If it were formatted as `intent:0`, the first validation check would let it
    through when the model uses it as `origin_ref` to dispatch an activity, and it
    would get stuck on the second check instead -- failing later and less clearly.
    """
    view = compile_context_view(_loaded_memory(), floor="idle", now=7.0)

    question = next(
        affordance for affordance in view.affordances if affordance.source == "unresolved_question"
    )
    assert question.ref == "intent.q0"
    assert question.content == {"question": "要多暗？"}
    with pytest.raises(ValueError):
        parse_ref(question.ref)


def test_channel_updates_skip_the_conversation_and_the_stale() -> None:
    """The model is speaking in the conversation channel; what it just said itself isn't "material", and anything too old doesn't count as "just arrived" either."""
    memory = _loaded_memory()
    latest = memory.channels["slow_sim"].items[-1]

    fresh = compile_context_view(memory, floor="idle", now=latest.ts + 1.0)
    stale = compile_context_view(memory, floor="idle", now=latest.ts + FRESH_WINDOW + 1.0)

    updates = [
        affordance for affordance in fresh.affordances if affordance.source == "channel_update"
    ]
    assert [affordance.content["channel"] for affordance in updates] == ["slow_sim"]
    # `ts` is carried along too, exactly the number the cross-cutting assertion
    # "citing a stale value must carry the observation time" needs.
    assert updates[0].content["ts"] == latest.ts
    assert [
        affordance for affordance in stale.affordances if affordance.source == "channel_update"
    ] == []


def test_the_four_sources_come_in_a_pinned_order() -> None:
    """The order must be pinned down because it goes into the snapshot: without a fixed order, every snapshot would drift with dict iteration order."""
    memory = _with_unknown(_loaded_memory())
    pool = SuggestionPool()
    pool.add(origin="fast_brain", kind="question", content={"text": "要多暗？"})

    view = compile_context_view(
        memory,
        floor="idle",
        now=7.0,
        suggestions=pool.all(),
        manifests=(SlowSim().manifest,),
    )

    assert [affordance.source for affordance in view.affordances] == [
        "probe",
        "suggestion",
        "unresolved_question",
        "channel_update",
    ]


def test_context_view_snapshot() -> None:
    memory = _loaded_memory()

    view = compile_context_view(memory, floor="idle", now=7.0)

    assert isinstance(view, ContextView)
    assert_snapshot("context_view_a2", to_snapshot(view))
