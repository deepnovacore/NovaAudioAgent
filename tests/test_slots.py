"""Single-flight over three slots (**stage A green item 3**: 09-roadmap.md's "single-flight, three use cases").

The three use cases correspond to three ways to get it wrong:
1. A second wake-up while in-flight must be merged, taking the higher priority — a boolean bit can't do this (R1)
2. Swapping on_done steps 3 and 4 -> **an extra spurious wake** (leaves a pending nobody picks up)
3. Moving step 2 to after step 3 -> **another form of an extra spurious wake** (a stale pending gets re-read)

Each of the two failure directions needs its own use case. The assertions are written to be
sensitive to exactly these two mutations — verified in development by actually mutating each and
watching the test go red.
"""

from __future__ import annotations

from dataclasses import replace

from nova_audio_agent.events import WakeReason
from nova_audio_agent.slots import SLOTS, SlotSet, higher

USER_WAKE = WakeReason(kind="user_input", priority=100, routing_class="user_awaited")
HANDOFF_WAKE = WakeReason(kind="handoff", priority=50)
COMPRESS_WAKE = WakeReason(kind="compress", priority=0)


class _Recorder:
    """Records every spawn. The spawn count is the observable signal for "extra wake / missed wake"."""

    def __init__(self) -> None:
        self.spawns: list[tuple[str, WakeReason]] = []

    def __call__(self, slot: str, reason: WakeReason) -> None:
        self.spawns.append((slot, reason))


def test_watch_and_compress_have_independent_slots() -> None:
    """Each call has its own inflight / pending domain; sharing one slot silently drops one of them (R1).

    The name only states what this use case actually pins down: the three slots don't collapse into two.
    "Not split by backend" can't be tested until stage C wires both ports into the same gateway (R21).
    """
    assert SLOTS == ("fast", "surrogate.watch", "compress")

    recorder = _Recorder()
    slots = SlotSet(recorder)
    slots.wake("surrogate.watch", HANDOFF_WAKE)
    slots.wake("compress", COMPRESS_WAKE)

    assert [slot for slot, _ in recorder.spawns] == ["surrogate.watch", "compress"]


def test_second_wake_while_inflight_merges_and_keeps_the_higher_priority() -> None:
    """Use case one: a second wake-up while in-flight merges, taking the higher priority."""
    recorder = _Recorder()
    slots = SlotSet(recorder)

    slots.wake("fast", HANDOFF_WAKE)  # takes off
    slots.wake("fast", USER_WAKE)  # arrives while in-flight: merges, doesn't spawn
    # The third wake, at a **lower** priority, is what this use case is really about: sending only
    # "low -> high" wakes would let a "last one wins" merge (that never even calls higher()) produce
    # the same result.
    slots.wake("fast", COMPRESS_WAKE)

    assert len(recorder.spawns) == 1  # no second spawn allowed while in-flight
    assert slots.pending["fast"] == USER_WAKE  # the higher-priority one, not the last one to arrive

    slots.on_done("fast", lambda: None)

    assert len(recorder.spawns) == 2  # positive twin: the pending one really was rerun
    assert recorder.spawns[1][1] == USER_WAKE  # and it used the higher-priority one
    assert slots.pending["fast"] is None  # and left no lingering ghost pending


def test_pending_is_consumed_exactly_once() -> None:
    """Use case two (guards against "swapping steps 3 and 4"): a ghost pending would make the next
    unrelated wake run an extra time."""
    recorder = _Recorder()
    slots = SlotSet(recorder)

    slots.wake("fast", HANDOFF_WAKE)
    slots.wake("fast", USER_WAKE)
    slots.on_done("fast", lambda: None)  # reruns once (2nd spawn)
    slots.on_done("fast", lambda: None)  # that rerun also finishes; pending should now be empty

    assert len(recorder.spawns) == 2  # exactly this many
    assert slots.inflight["fast"] is False

    slots.wake("fast", COMPRESS_WAKE)  # a brand-new, unrelated wake

    assert len(recorder.spawns) == 3  # exactly once, not twice
    assert recorder.spawns[2][1] == COMPRESS_WAKE


def test_wake_raised_while_consuming_the_output_is_not_lost() -> None:
    """Use case three (guards against "moving step 2 to after step 3"): a wake raised at the moment
    the output is consumed.

    apply(output) can itself wake other slots, and possibly this slot too (the norm in stage B).
    Step 1 runs while inflight is still true, so this wake must be merged into pending and picked up
    by step 2.
    """
    recorder = _Recorder()
    slots = SlotSet(recorder)
    slots.wake("fast", HANDOFF_WAKE)

    def consume() -> None:
        slots.wake(
            "fast", USER_WAKE
        )  # discovers while consuming the output that it needs to run again

    slots.on_done("fast", consume)

    assert len(recorder.spawns) == 2  # not lost
    assert recorder.spawns[1][1] == USER_WAKE
    assert slots.pending["fast"] is None  # and no duplicate copy left behind
    assert slots.inflight["fast"] is True  # the rerun is now in flight


def test_wake_raised_by_the_respawn_is_not_lost() -> None:
    """Use case three, part two (guards against "splitting apart the take-and-clear of step 2"):
    the **missed-wake** direction.

    09-roadmap.md's original wording is "moving step 2 to after step 3 -> missed wake". In practice
    that mutation turns out to be **unobservable** in this implementation's shape: on_done and wake
    are fully synchronous, so nothing can slip in between steps 2 and 3.

    The real missed-wake direction is **splitting "take and clear pending" into two halves**: the
    clear action lands after step 4, so a wake raised by the rerun itself gets wiped out by the
    clear that follows.
    """
    recorder = _Recorder()
    slots = SlotSet(lambda slot, reason: _respawn_wakes_again(slots, recorder, slot, reason))

    slots.wake("fast", HANDOFF_WAKE)  # spawn 1
    slots.wake("fast", USER_WAKE)  # merges into pending
    slots.on_done("fast", lambda: None)  # step 4 -> spawn 2, which itself asks to run again

    assert slots.pending["fast"] == COMPRESS_WAKE  # this wake wasn't wiped out

    slots.on_done("fast", lambda: None)

    assert len(recorder.spawns) == 3  # positive twin: it really was rerun


def _respawn_wakes_again(
    slots: SlotSet, recorder: _Recorder, slot: str, reason: WakeReason
) -> None:
    recorder(slot, reason)
    if (
        len(recorder.spawns) == 2
    ):  # while the rerun is in flight, it discovers it needs to run again too
        slots.wake(slot, COMPRESS_WAKE)


def test_idle_slot_spawns_immediately_without_throttling() -> None:
    """The observable point of O1: no throttling while idle.

    Merging during a burst is handled by single-flight's pending, with no separate throttle. When
    inflight is false, it always spawns immediately — no window check, no retry timer. Scheduling a
    timer would just be bringing back the flush timer that R2 killed, under a different name. The
    `HandoffPolicy.min_interval` field, which had no readers, was already removed in R43; this use
    case pins down the behavior that still holds after its removal.
    """
    recorder = _Recorder()
    slots = SlotSet(recorder)

    slots.wake("fast", HANDOFF_WAKE)
    slots.on_done("fast", lambda: None)
    slots.wake(
        "fast", HANDOFF_WAKE
    )  # a second one at the same virtual instant, nowhere near a window

    assert len(recorder.spawns) == 2


def test_higher_breaks_ties_on_routing_class_then_on_arrival() -> None:
    """Both tie-breaking dimensions need to be explicit, otherwise "take the highest priority" is
    ambiguous on a tie."""
    ambient = WakeReason(kind="handoff", priority=50, routing_class="ambient")
    awaited = WakeReason(kind="handoff", priority=50, routing_class="user_awaited")

    assert higher(None, ambient) is ambient
    assert higher(ambient, awaited) is awaited  # priority tied -> compare routing_class
    assert higher(awaited, ambient) is awaited

    first = WakeReason(kind="handoff", priority=50, origin="slow_sim:1")
    second = WakeReason(kind="handoff", priority=50, origin="slow_sim:2")
    assert higher(first, second) is first  # both tied -> the first one to arrive stays


def test_a_more_urgent_ambient_wake_does_not_swallow_a_pending_user_awaited_one() -> None:
    """The rerun produced by a merge answers both original reasons at once, so routing_class takes
    the union instead of being decided by priority (R52).

    `08-deferred.md`'s "AI interrupts the user" already plans for a preemption tier above
    `USER_PRIORITY`; this fills in a pothole that day will hit ahead of time: the way axes get
    crossed here is silent — the work dispatched by the rerun gets tagged `ambient`, routing hands
    it back to `policy.wake`, and on a channel with `wake="none"` the user's original question never
    gets a follow-up (the very door R44 just closed gets pried back open from the merge side).

    **Mutation tested**: reverting `higher` to a single total order (dropping the three lines that
    take the union) makes this test fail immediately on the first assertion;
    `test_higher_breaks_ties_on_routing_class_then_on_arrival` stays fully green.
    """
    awaited = WakeReason(kind="user_input", priority=100, routing_class="user_awaited")
    preempt = WakeReason(kind="handoff", priority=150, routing_class="ambient")

    merged = higher(awaited, preempt)
    assert (
        merged.routing_class == "user_awaited"
    )  # someone is waiting on this; the merge must not drop it
    assert merged.priority == 150  # while the speaking still follows the more urgent priority
    assert (
        merged.kind == "handoff"
    )  # the winner carries its kind along: the more urgent one is the real trigger for this rerun

    # Same result in reverse arrival order. When `ambient` arrives first and `user_awaited` arrives
    # later, it loses on priority — losing on kind is correct (it's less urgent), losing "someone is
    # waiting" is not.
    reverse = higher(preempt, awaited)
    assert reverse.routing_class == "user_awaited"
    assert reverse.priority == 150

    # Upper bound: when neither side has anyone waiting, it must not conjure a user_awaited out of thin air.
    both_ambient = higher(preempt, replace(preempt, priority=50))
    assert both_ambient.routing_class == "ambient"
