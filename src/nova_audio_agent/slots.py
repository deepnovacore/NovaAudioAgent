"""Single-flight three slots: sliced by call, not by backend (01-spine.md + R1).

There are three slots: fast / surrogate.watch / compress.
**watch and compress land on the same backend model, but they must be two separate
slots** — their signatures differ, and so do their trigger sources (one is woken by
memory changes, the other by a watermark). Sharing one slot would let "compress
arrives while watch is in flight" get dropped outright. (After R21 split them into
two ports, this rule now constrains "two calls to the same backend," not "two
methods on the same port.")

A new wake doesn't just set a boolean flag — it merges into a **pending wake
reason**: a boolean would throw away the trigger reason, and the pending rerun
wouldn't know which speaking priority to use (R1).

## The four steps of on_done are fixed in this order

    1. consume the output first
    2. take and clear pending
    3. then clear inflight
    4. if there's a pending, rerun once

Swapping steps 3 and 4 → the rerun fires while inflight is still true, so it gets
merged into pending too and no one takes it, leaving a **ghost pending** that fires
one extra run (an over-wake) the next time an unrelated wake finishes.
Moving step 2 to after step 3 → inflight is already clear but pending hasn't been
taken yet, so a wake arriving at that instant spawns directly, and then the stale
pending gets read out and rerun (also an over-wake).
Both directions need a test case.

## What wake throttling actually looks like here (O1 → R43)

The multiple wakes during a burst are entirely absorbed by **single-flight pending
merging**; no separate throttle is needed: whenever `inflight[slot]` is false, a
wake spawns immediately, no window, no retry timer scheduled.
Scheduling a timer would just be bringing back, under a different name, the exact
flush timer that R2 killed.
That's why the `min_interval` field on `HandoffPolicy`, which never had a reader,
was removed in R43 — this is where the thing it claimed to do actually happens.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from typing import Literal

from nova_audio_agent.events import WakeReason

Slot = Literal["fast", "surrogate.watch", "compress"]
SLOTS: tuple[Slot, ...] = ("fast", "surrogate.watch", "compress")

_ROUTING_RANK = {"user_awaited": 1, "ambient": 0}


def higher(current: WakeReason | None, candidate: WakeReason) -> WakeReason:
    """Merge two wake reasons into one. Total order = (priority, routing_class), ties
    broken by **first one in wins**.

    Both tie-breaking dimensions must be explicit, otherwise "take the highest
    priority" isn't deterministic on a tie.

    **But routing_class isn't just a tie-breaking dimension — it's also unioned
    separately** (R52). In the total order above, priority outranks routing_class,
    so an ambient wake with `priority > USER_PRIORITY` would swallow a pending
    `user_awaited` whole — the rerun's reason would be ambient, `bind_delegate`
    inherits it, and **the task that's actually answering the user gets bound as
    ambient**, routing back into `policy.wake`'s hands, and the user's question can
    end up with no follow-up ever (the door R44 just closed).

    The two axes were already orthogonal (D5): priority answers "how urgent," and
    routing_class answers "is someone waiting." Letting the former decide the
    latter is a cross-axis leak. The rerun produced by the merge has to answer both
    reasons at once, so it must speak at the more urgent priority **while also**
    acknowledging someone is waiting — "routing can only escalate, never
    downgrade" (R44) applies at this same step of the merge.

    Out of reach today: the highest channel priority is sims' 50, `USER_PRIORITY`
    is 100, and no channel declares itself more urgent than the user. But
    `HandoffPolicy.priority` is an unbounded `int`, and `08-deferred.md`'s "AI
    interrupting the user" section **has already planned a preemption tier above
    `USER_PRIORITY`**. That day, this would be wrong, and silently so: the dropped
    wake wouldn't error, wouldn't go red. So fix it now.
    """
    if current is None:
        return candidate
    current_key = (current.priority, _ROUTING_RANK[current.routing_class])
    candidate_key = (candidate.priority, _ROUTING_RANK[candidate.routing_class])
    winner = candidate if candidate_key > current_key else current
    # The winner takes kind / origin / selected_suggestion (only one of those three
    # makes sense — see the note on WakeReason about "the loser drops its picked
    # suggestion along with it"); only routing_class gets unioned — it's the one
    # fact that both reasons agree on.
    if "user_awaited" in (current.routing_class, candidate.routing_class):
        if winner.routing_class != "user_awaited":
            return replace(winner, routing_class="user_awaited")
    return winner


class SlotSet:
    """In-flight state and pending wake reason for the three slots."""

    def __init__(self, spawn: Callable[[Slot, WakeReason], None]) -> None:
        self._spawn = spawn
        self.inflight: dict[Slot, bool] = dict.fromkeys(SLOTS, False)
        self.pending: dict[Slot, WakeReason | None] = dict.fromkeys(SLOTS, None)

    def wake(self, slot: Slot, reason: WakeReason) -> None:
        """If in flight, merge into pending taking the higher one; otherwise spawn immediately."""
        if self.inflight[slot]:
            self.pending[slot] = higher(self.pending[slot], reason)
            return
        self.inflight[slot] = True
        self._spawn(slot, reason)

    def on_done(self, slot: Slot, consume: Callable[[], None]) -> None:
        """Four steps, order fixed. consume is "consume this call's output," passed
        in by the runtime."""
        consume()  # 1
        reason = self.pending[slot]  # 2
        self.pending[slot] = None
        self.inflight[slot] = False  # 3
        if reason is not None:  # 4
            self.wake(slot, reason)
