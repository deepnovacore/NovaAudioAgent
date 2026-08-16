"""Unit tests for the in-flight table and origin_ref validation (B1).

Scenario 1's end-to-end script proves "the whole chain works", but it can't prove
these edge cases: what routing class an unfindable delegate counts as, what
happens when an already-terminated activity gets terminated a second time, and
whether a ref that **exists but has slid out of the recent window** counts as a
hallucination. Each gets its own case.
"""

from __future__ import annotations

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.context_view import RECENT_LIMIT, compile_context_view
from nova_audio_agent.delegates import DelegateLedger, validate_origin_ref
from nova_audio_agent.events import Deadline, HandoffEvent, WakeReason
from nova_audio_agent.executors.sims import SET_LIGHT
from nova_audio_agent.memory import CONVERSATION_CHANNEL, Memory
from nova_audio_agent.ports import Delegate, DelegateRequest, bind_delegate
from nova_audio_agent.runtime import Runtime
from policies import SIM_POLICIES

USER_WAKE = WakeReason(kind="user_input", priority=100, routing_class="user_awaited")
AMBIENT_WAKE = WakeReason(kind="handoff", priority=50, routing_class="ambient")


def _delegate(delegate_id: str, *, now: float = 0.0, wake: WakeReason = USER_WAKE) -> Delegate:
    return bind_delegate(
        DelegateRequest(
            executor="slow_sim",
            op="set_light",
            request={"room": "客厅", "brightness": 30},
            origin_ref="conversation:1",
        ),
        wake_reason=wake,
        op=SET_LIGHT,
        now=now,
        delegate_id=delegate_id,
    )


def _handoff(delegate_id: str, *, outcome: str = "ok") -> HandoffEvent:
    return HandoffEvent(
        channel="slow_sim",
        delegate_id=delegate_id,
        origin_ref="conversation:1",
        outcome=outcome,
        trust="trusted_system",
        content={"op": "set_light"},
    )


def test_terminating_a_delegate_twice_reports_the_second_time_as_a_no_op() -> None:
    """The observable form of termination rule 3: the second termination gets None, and it does **not overwrite** the first terminator."""
    ledger = DelegateLedger()
    ledger.dispatch(_delegate("d-1"))

    assert ledger.terminate("d-1", event=_handoff("d-1")) is not None
    assert ledger.terminate("d-1", event=Deadline(delegate_id="d-1")) is None
    assert ledger.terminated_by("d-1") == "handoff"


def test_a_delegate_nobody_dispatched_was_terminated_by_nobody() -> None:
    """`_wake_deadline` must return "not terminated by me" for a delegate it's never seen."""
    assert DelegateLedger().terminated_by("d-404") is None


def test_definite_handoff_reclaims_routing_record_but_keeps_termination_history() -> None:
    ledger = DelegateLedger()
    delegate = _delegate("d-1")
    ledger.dispatch(delegate)
    event = _handoff(delegate.delegate_id)
    ledger.terminate(delegate.delegate_id, event=event)

    ledger.after_routing(event)

    assert ledger.find(delegate.delegate_id) is None
    assert ledger.terminated_by(delegate.delegate_id) == "handoff"


def test_first_handoff_claim_is_visible_only_for_the_exact_event_until_reclaimed() -> None:
    ledger = DelegateLedger()
    delegate = _delegate("d-1")
    event = _handoff("d-1")
    equal_but_distinct = _handoff("d-1")
    ledger.dispatch(delegate)

    assert ledger.claim_first_handoff(event) == delegate
    assert ledger.claimed_handoff(event) == delegate
    assert ledger.claimed_handoff(equal_but_distinct) is None

    ledger.terminate("d-1", event=event)
    ledger.after_routing(event)

    assert ledger.claimed_handoff(event) is None
    assert ledger.claim_first_handoff(equal_but_distinct) is None


def test_late_after_deadline_handoff_gets_one_exact_projection_claim() -> None:
    ledger = DelegateLedger()
    delegate = _delegate("d-1")
    deadline = Deadline(delegate_id="d-1")
    event = _handoff("d-1")
    duplicate = _handoff("d-1")
    ledger.dispatch(delegate)
    ledger.terminate("d-1", event=deadline)

    assert ledger.claim_first_handoff(event) == delegate
    assert ledger.claimed_handoff(event) == delegate
    assert ledger.claim_first_handoff(duplicate) is None

    ledger.after_routing(event)
    assert ledger.claimed_handoff(event) is None


async def test_deterministic_run_reclaims_the_handoff_claim_after_observation() -> None:
    runtime = Runtime(clock=VirtualClock(), memory=Memory(policies=SIM_POLICIES))
    delegate = _delegate("d-1")
    runtime.delegates.dispatch(delegate)
    event = runtime.post(_handoff("d-1"))
    observed_claims: list[Delegate | None] = []

    runtime.observe(
        lambda observed: observed_claims.append(runtime.delegates.claimed_handoff(observed))
    )

    await runtime.run()

    assert observed_claims == [delegate]
    assert runtime.delegates.claimed_handoff(event) is None
    assert runtime.delegates.find("d-1") == delegate
    assert runtime.delegates.terminated_by("d-1") == "handoff"


def test_unknown_handoff_is_reclaimed_after_its_one_fence() -> None:
    ledger = DelegateLedger()
    delegate = _delegate("d-1")
    ledger.dispatch(delegate)
    event = _handoff(delegate.delegate_id, outcome="unknown")
    ledger.terminate(delegate.delegate_id, event=event)
    ledger.after_routing(event)

    assert ledger.find(delegate.delegate_id) == delegate
    ledger.note_fenced(delegate.delegate_id)

    assert ledger.find(delegate.delegate_id) is None
    assert ledger.terminated_by(delegate.delegate_id) == "handoff"


def test_routing_class_survives_termination() -> None:
    """A late handoff must also wake by the routing class bound **at dispatch time**, so it must still be findable in the terminated table."""
    ledger = DelegateLedger()
    ledger.dispatch(_delegate("d-1", wake=USER_WAKE))
    ledger.terminate("d-1", event=Deadline(delegate_id="d-1"))

    assert ledger.routing_class_of("d-1") == "user_awaited"


def test_an_unknown_delegate_is_ambient() -> None:
    """Falls back to ambient when not found: a handoff nobody claims shouldn't have the standing to interrupt the user."""
    assert DelegateLedger().routing_class_of("d-404") == "ambient"


def test_snapshot_is_ordered_by_dispatch_time_not_insertion_order() -> None:
    """The snapshot is ordered, or else ContextView would drift with dict insertion order and snapshot tests couldn't pin anything down."""
    ledger = DelegateLedger()
    ledger.dispatch(_delegate("d-2", now=9.0))
    ledger.dispatch(_delegate("d-1", now=1.0))

    assert [delegate.delegate_id for delegate in ledger.snapshot()] == ["d-1", "d-2"]


def test_snapshot_does_not_leak_the_live_table() -> None:
    """A precondition of the "pure function" property: compiling the view gets a snapshot, not a live reference."""
    ledger = DelegateLedger()
    ledger.dispatch(_delegate("d-1"))
    taken = ledger.snapshot()

    ledger.terminate("d-1", event=_handoff("d-1"))

    assert [delegate.delegate_id for delegate in taken] == ["d-1"]
    assert ledger.snapshot() == ()


def test_the_same_activity_dispatched_twice_is_a_duplicate() -> None:
    """R28: it only counts as a duplicate if all three match -- executor, op, and the whole request."""
    ledger = DelegateLedger()
    ledger.dispatch(_delegate("d-1"))

    same = {"room": "客厅", "brightness": 30}
    assert ledger.duplicate_of("slow_sim", "set_light", same) is not None
    # Two different activities with the same op: running them concurrently is entirely legitimate, not a duplicate.
    assert ledger.duplicate_of("slow_sim", "set_light", {"room": "卧室", "brightness": 30}) is None
    assert ledger.duplicate_of("slow_sim", "set_light", {"room": "客厅", "brightness": 80}) is None
    assert ledger.duplicate_of("fast_sim", "set_light", same) is None
    assert ledger.duplicate_of("slow_sim", "get_state", same) is None


def test_the_dedup_key_does_not_alias_the_request_the_model_handed_in() -> None:
    """`Delegate` is frozen, but the request on it is a dict -- that's a hole in this layer's invariant.

    The model's `DelegateRequest`, the ledger's dedup key, and what the executor holds
    are originally the same object. If anyone mutates it in place, the dedup key and
    the `what` in ContextView quietly drift together.
    """
    request = {"room": "客厅", "brightness": 30}
    delegate = bind_delegate(
        DelegateRequest(
            executor="slow_sim", op="set_light", request=request, origin_ref="conversation:1"
        ),
        wake_reason=USER_WAKE,
        op=SET_LIGHT,
        now=0.0,
        delegate_id="d-1",
    )
    ledger = DelegateLedger()
    ledger.dispatch(delegate)

    request["brightness"] = 80  # the model's copy got mutated in place

    assert delegate.request == {"room": "客厅", "brightness": 30}
    assert ledger.duplicate_of("slow_sim", "set_light", {"room": "客厅", "brightness": 30})
    assert ledger.duplicate_of("slow_sim", "set_light", request) is None


def test_a_finished_activity_can_be_dispatched_again() -> None:
    """Only blocks the **in-flight** copy. Turning the light back up, then dimming it again, are two legitimate things.

    Checking the terminated table would turn this into "this thing may only ever
    happen once in its lifetime" -- that's a different thing, not deduplication.
    """
    ledger = DelegateLedger()
    ledger.dispatch(_delegate("d-1"))
    ledger.terminate("d-1", event=_handoff("d-1"))

    assert ledger.duplicate_of("slow_sim", "set_light", {"room": "客厅", "brightness": 30}) is None


# ---- The one that stopped at unknown: a resend must be fenced once first (R49) ----


def _unknown_handoff(delegate_id: str) -> HandoffEvent:
    """The uncertainty the adapter reports itself (timeout / transport interruption), not the one a deadline writes."""
    return HandoffEvent(
        channel="slow_sim",
        delegate_id=delegate_id,
        origin_ref="conversation:1",
        outcome="unknown",
        trust="trusted_system",
        content={"error": "adapter_timeout", "op": "set_light"},
    )


def _dim_light() -> dict[str, object]:
    return {"room": "客厅", "brightness": 30}


def test_a_delegate_that_ended_in_unknown_blocks_the_same_request_once() -> None:
    """The one terminated by a deadline: dispatching the same thing again is recognized.

    `duplicate_of` can't answer here anymore -- it only scans the in-flight table, and
    this activity is long out of flight.
    """
    ledger = DelegateLedger()
    ledger.dispatch(_delegate("d-1"))
    ledger.terminate("d-1", event=Deadline(delegate_id="d-1"))

    found = ledger.unresolved_duplicate_of("slow_sim", "set_light", _dim_light())
    assert found is not None and found.delegate_id == "d-1"


def test_an_adapter_declared_unknown_counts_too() -> None:
    """The other half: the one where the executor **itself says** it's uncertain counts the same as one a deadline writes.

    Without this, "only recognize deadline" would also pass the case above -- and
    what it misses is exactly timeout and transport interruption, the most common
    kind of unknown on a real executor.
    """
    ledger = DelegateLedger()
    ledger.dispatch(_delegate("d-1"))
    ledger.terminate("d-1", event=_unknown_handoff("d-1"))

    assert ledger.unresolved_duplicate_of("slow_sim", "set_light", _dim_light()) is not None


def test_a_delegate_that_ended_with_a_verdict_does_not_block_anything() -> None:
    """Reverse twin: the one that concluded with `ok` is not fenced.

    Without this, "fence anything with a match in the terminated table" would also
    pass the two cases above -- and that would turn into "this thing may only ever
    happen once in its lifetime", closing the door that the `duplicate_of` case above
    deliberately left open.
    """
    ledger = DelegateLedger()
    ledger.dispatch(_delegate("d-1"))
    ledger.terminate("d-1", event=_handoff("d-1"))  # outcome="ok"

    assert ledger.unresolved_duplicate_of("slow_sim", "set_light", _dim_light()) is None


def test_a_verdict_that_arrives_late_also_stops_the_fence() -> None:
    """The **late-arriving version** of the previous case: a deadline has already written unknown, and then that `ok` comes back afterward (R53).

    This cell differs from the previous one only in arrival order, but it goes down a
    completely different path: the termination record is already occupied by the
    deadline, rule 3 says it may not be overwritten, so `terminate` returns None and
    `record.event` stays that `Deadline` forever -- and that's what the fence reads.

    Not fixing this has two consequences, the second one worse:
    - the rejection observation says "d-1 stopped at unknown", while the board plainly shows an `ok`;
    - it fences a **legitimate** resend ("turn the light back up, then dim it again"),
      and the door the previous case deliberately left open exists exactly for this.

    **Rule 3 doesn't change a single word**: what terminated it really was the
    deadline; what's asserted here is that record was never rewritten.
    """
    ledger = DelegateLedger()
    ledger.dispatch(_delegate("d-1"))
    ledger.terminate("d-1", event=Deadline(delegate_id="d-1"))
    assert ledger.unresolved_duplicate_of("slow_sim", "set_light", _dim_light()) is not None

    ledger.note_resolved("d-1")  # the trunk records this in _apply_handoff for a late ok / failed

    assert ledger.unresolved_duplicate_of("slow_sim", "set_light", _dim_light()) is None
    assert (
        ledger.terminated_by("d-1") == "deadline"
    )  # termination rule 3 wasn't quietly changed along the way


def test_the_fence_lets_the_second_attempt_through() -> None:
    """Fence once, then step aside: what's being fenced is the reflex, not the resend itself (R49).

    The first rejection writes an observation explaining why, and wakes the model;
    at that point a recheck probe is on the table (R31). Whether it looks that over
    and still wants to resend is the decision port's call. Permanently fencing it
    would be a cell with no way out -- when the probe comes back saying "the light
    never actually got dimmed", the one correct action would still be fenced.

    **This case pins down the ledger method; it can't pin down whether the trunk
    actually calls it**: it calls `note_fenced` itself. Swap that call inside
    `_reject_reason` for `pass` (= permanently fenced), and this still passes green --
    mutation-tested. The production-path half of this lives in
    `test_scenario3_deadline.py`, the case with the same name.
    """
    ledger = DelegateLedger()
    ledger.dispatch(_delegate("d-1"))
    ledger.terminate("d-1", event=Deadline(delegate_id="d-1"))

    assert ledger.unresolved_duplicate_of("slow_sim", "set_light", _dim_light()) is not None
    ledger.note_fenced("d-1")
    assert ledger.unresolved_duplicate_of("slow_sim", "set_light", _dim_light()) is None


def test_a_different_request_is_not_the_same_unresolved_thing() -> None:
    """A different room is a different thing, measured with the same ruler `duplicate_of` uses."""
    ledger = DelegateLedger()
    ledger.dispatch(_delegate("d-1"))
    ledger.terminate("d-1", event=Deadline(delegate_id="d-1"))

    other = {"room": "卧室", "brightness": 30}
    assert ledger.unresolved_duplicate_of("slow_sim", "set_light", other) is None


def test_the_fence_is_keyed_on_the_executor_and_op_as_well() -> None:
    """The fence's ruler is the same three things -- `(executor, op, the whole request)` -- as R28's dedup.

    The previous case only varies `request`, so it can't catch a "compares only
    request" implementation -- mutation-tested: delete the two clauses
    `delegate.executor != executor or delegate.op != op`, and the full suite of 210
    cases stays green (codex review flagged this). The consequence of comparing only
    request is **false fencing**: two different things with identically-shaped
    parameters -- swap the executor, or swap the op on the same executor -- the first
    one stopped at unknown, and the second gets fenced at the door too, along with a
    false observation claiming it's "stopped at unknown".

    Neither case looks at `readonly`: the recheck gate `if not op.readonly` lives on
    the call side (`Runtime._reject_reason`); this layer of the ledger only answers
    "is this the same thing".
    """
    ledger = DelegateLedger()
    ledger.dispatch(_delegate("d-1"))
    ledger.terminate("d-1", event=Deadline(delegate_id="d-1"))

    assert ledger.unresolved_duplicate_of("fast_sim", "set_light", _dim_light()) is None
    assert ledger.unresolved_duplicate_of("slow_sim", "get_state", _dim_light()) is None
    # Positive twin: the one where all three match is still fenced, or else "let everything through" would also pass the two lines above.
    assert ledger.unresolved_duplicate_of("slow_sim", "set_light", _dim_light()) is not None


# ---- Memo of rejected dispatch attempts (R30 revised: only a clue, not a brake) ----


def test_the_memo_remembers_a_request_that_was_already_rejected() -> None:
    """The memo recognizes the repeated one. **But it no longer decides waking** (R30 revised).

    The brake moved to counting along the wake chain (`Runtime._reject`), on the
    grounds that this table can't stop a loop by "different bad requests" at all --
    the value space of those four fields is unbounded. What's kept here is just the
    clue itself -- afterward you still need to tell "the model is spinning in place"
    apart from "the model is trying new things one after another", since the
    prescription differs.
    """
    ledger = DelegateLedger()
    bad = DelegateRequest(
        executor="slow_sim", op="set_light", request={"room": "客厅"}, origin_ref="conversation:404"
    )

    assert ledger.rejected_before(bad) is False
    ledger.note_rejection(bad)
    assert ledger.rejected_before(bad) is True


def test_the_memo_does_not_confuse_two_different_bad_requests() -> None:
    """Changing one value makes it a different attempt.

    **This case used to be backwards**: it originally asserted "every different bad
    request earns another wake", writing an unbounded behavior as a positive
    requirement (codex review's third round pointed this out, and it was accepted).
    Now it only says the memo can tell two attempts apart; it no longer claims that
    gives boundedness.
    """
    ledger = DelegateLedger()
    base = DelegateRequest(
        executor="slow_sim", op="set_light", request={"room": "客厅"}, origin_ref="conversation:404"
    )
    ledger.note_rejection(base)

    other = DelegateRequest(
        executor="slow_sim", op="set_light", request={"room": "卧室"}, origin_ref="conversation:404"
    )
    assert ledger.rejected_before(other) is False


def test_the_rejection_memo_does_not_alias_the_request_the_model_handed_in() -> None:
    """The same hole as R28's dedup key: that dict comes from the model, and mutating it in place would make the memo misidentify it."""
    ledger = DelegateLedger()
    request = {"room": "客厅"}
    bad = DelegateRequest(
        executor="slow_sim", op="set_light", request=request, origin_ref="conversation:404"
    )
    ledger.note_rejection(bad)

    request["room"] = "卧室"  # the model's copy got mutated in place

    # The entry in the memo is still the one that was originally rejected, so sending the exact same thing again is still recognized.
    assert (
        ledger.rejected_before(
            DelegateRequest(
                executor="slow_sim",
                op="set_light",
                request={"room": "客厅"},
                origin_ref="conversation:404",
            )
        )
        is True
    )


# ---- Three origin_ref validation cases ----


def _memory_with(count: int) -> Memory:
    memory = Memory(policies=SIM_POLICIES)
    for index in range(count):
        memory.append(
            CONVERSATION_CHANNEL,
            ts=float(index),
            trust="trusted_user",
            priority=100,
            content={"text": f"第 {index + 1} 句"},
        )
    return memory


def test_a_well_formed_visible_ref_passes() -> None:
    memory = _memory_with(1)
    view = compile_context_view(memory, floor="idle", now=1.0)

    assert validate_origin_ref("conversation:1", memory=memory, view=view) is None


def test_an_unparseable_ref_is_rejected() -> None:
    memory = _memory_with(1)
    view = compile_context_view(memory, floor="idle", now=1.0)

    assert validate_origin_ref("客厅的灯", memory=memory, view=view) is not None


def test_a_ref_to_a_nonexistent_item_is_rejected() -> None:
    """The shape is right, the channel is right, but that observation simply doesn't exist -- the most common kind of hallucination."""
    memory = _memory_with(1)
    view = compile_context_view(memory, floor="idle", now=1.0)

    assert validate_origin_ref("conversation:99", memory=memory, view=view) is not None
    assert validate_origin_ref("slow_sim:1", memory=memory, view=view) is not None
    assert validate_origin_ref("no_such_channel:1", memory=memory, view=view) is not None


def test_a_real_item_outside_the_recent_window_is_still_rejected() -> None:
    """The third check is the most useful of the three: **it exists, but this call didn't see it**.

    The first two only catch things made up out of thin air. If the model still cites
    an item after it's been pushed out of the recent window, that's not a good memory
    -- it's gambling -- so it's treated as a hallucination.
    """
    memory = _memory_with(RECENT_LIMIT + 1)
    view = compile_context_view(memory, floor="idle", now=9.0)
    recent = next(channel for channel in view.channels if channel.name == CONVERSATION_CHANNEL)

    # Positive twin: this ref really does exist in memory, just not in the view.
    assert any(item.ref == "conversation:1" for item in memory.channels[CONVERSATION_CHANNEL].items)
    assert all(item.ref != "conversation:1" for item in recent.recent)
    assert validate_origin_ref("conversation:1", memory=memory, view=view) is not None
    assert validate_origin_ref(recent.recent[0].ref, memory=memory, view=view) is None
