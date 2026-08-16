"""The in-flight table, the terminated table, and runtime validation of `origin_ref` (05-executors.md).

## Why these two tables live in the runtime, not in Memory

None of the blackboard's three content categories (02-memory.md) fit: the writer here is
the main loop, not FastBrain; the reader is the main loop itself (ContextView only ever
gets a **read-only snapshot**); and convergence relies on the three termination rules, not
on cooldown or compression. Forcing it in there would just be creating a fourth content category.

## The terminated table isn't a graveyard — it's a registry of "termination ownership"

Step 3 of termination rule 2, "cancel this dispatch attempt", is **not** `task.cancel()` (R25):
that would mean the adapter's late handoff could never come back, while 05-executors.md
explicitly states it should "still append as usual". What actually needs canceling is
**this delegate's right to terminate**: the deadline has already written `unknown` on its
behalf, and any handoff that comes back afterward is just an observation — it no longer
terminates anything or produces a new deadline.
So what's recorded here is "**which event** terminated it", and the late-arrival path as well
as termination rule 3 both rely on it entirely.

## Routing records are reclaimed after their last reader

First, what it's **not**: it is not `Runtime.applied`, nor is it the kind of grow-only
table that channel entries are. Those two are the authoritative history pinned by D14 —
grow-only is their definition; this table is a **routing index**. Treating them as the
same category conflates two different things.

Safe points do exist, and there are three of them:
(1) the handoff-wins path — once the wake target of that handoff has been computed, this
record has no more readers; (2) the deadline-wins path — once that **one** possibly-late
handoff (05 pins that an adapter's one delegate produces exactly one handoff) has finished
routing; (3) the handoff-never-comes-back path — `run()`'s teardown cancels the remaining
adapter jobs, after which no more handoffs can ever come in.

Before Stage C, what was missing wasn't a safe point but **a place to reclaim at that
point**. Clearing between apply and wake-target computation was too early because
`_wake_handoff` still needed the routing class, while clearing inside WAKE_TABLE would
make the wake table stateful. Capping by entry count was also rejected: an evicted late
handoff would fall back to `ambient`, silently downgrading an awaited self-correction.

Stage C supplied the missing production lifecycle landing point (R57): after apply consumes
transient handoff authority and wake-target computation, `serve()` has `_process_event` call
`after_routing`. Definite handoffs are reclaimed there; unknown records survive their one R49
fence and possible late handoff; production shutdown clears every remaining session-local
routing index. Deterministic termination history remains in `_termination_kinds`, while
deterministic `run()` deliberately retains routing records for scenario assertions.
`_termination_kinds` keeps only compact kind strings and is never consulted for routing.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from nova_audio_agent.context_view import ContextView
from nova_audio_agent.events import Deadline, Event, HandoffEvent, RoutingClass
from nova_audio_agent.memory import Memory, MemoryRef, parse_ref
from nova_audio_agent.ports import Delegate, DelegateRequest

# The wake reason when the main loop refuses to dispatch a delegate. It doesn't correspond to any
# row in the event table — because there is no event for this: it happens in step 1 of on_done, where
# the main loop writes its own observation and wakes itself.
REJECTED_WAKE_KIND = "delegate_rejected"


@dataclass(frozen=True, slots=True)
class _Termination:
    """A record of one termination. What's recorded is **the event itself**, not "handoff vs. deadline".

    Recording the event rather than the category is what makes "was it this hop that
    terminated it" answerable (see `terminated_by_deadline`). The category can be read back
    from the event's `KIND`, but not the other way around — storing both would add a "the two
    must stay consistent" constraint that nothing would actually maintain.
    """

    delegate: Delegate
    event: Event


class DelegateLedger:
    """Dispatched tasks. Two tables: still in flight, and already terminated (along with **the event that terminated it**).

    Plus a memo of rejected dispatch attempts — that's not a table, it's the brake on R30's self-wake loop.
    """

    def __init__(self) -> None:
        self._in_flight: dict[str, Delegate] = {}
        self._terminated: dict[str, _Termination] = {}
        # Compact audit history for deterministic assertions. Unlike `_terminated`,
        # this retains no Delegate and is never consulted for routing.
        self._termination_kinds: dict[str, str] = {}
        self._rejected: list[DelegateRequest] = []
        # Unknowns that have already been used to block one resend (R49). See unresolved_duplicate_of.
        self._fenced: set[str] = set()
        # Ones that later received a verdict and so no longer count as unknown (R53). See note_resolved.
        self._resolved: set[str] = set()
        # A routed handoff means the adapter's one allowed return has arrived.
        self._handoff_seen: set[str] = set()
        self._observer_handoff_claim: tuple[HandoffEvent, Delegate] | None = None

    def dispatch(self, delegate: Delegate) -> None:
        self._in_flight[delegate.delegate_id] = delegate

    def terminate(self, delegate_id: str, *, event: Event) -> Delegate | None:
        """Remove from the in-flight table and record **which event** terminated it.

        **Returns None if it's no longer in flight** — that's termination rule 3, the first
        terminator isn't overridden. `event` has no default: if that were allowed, the one
        place someone forgot to pass it would be a task that times out and never gets a
        follow-up, and it wouldn't error, wouldn't fail a test — it would just silently
        miss a wake-up.
        """
        delegate = self._in_flight.pop(delegate_id, None)
        if delegate is None:
            return None
        self._terminated[delegate_id] = _Termination(delegate=delegate, event=event)
        self._termination_kinds[delegate_id] = event.KIND
        return delegate

    def claim_first_handoff(self, event: HandoffEvent) -> Delegate | None:
        """Claim one dispatch-authorized handoff and expose it to observers."""
        if event.delegate_id in self._handoff_seen:
            return None
        delegate = self._in_flight.get(event.delegate_id)
        if delegate is None:
            record = self._terminated.get(event.delegate_id)
            if record is None or not isinstance(record.event, Deadline):
                return None
            delegate = record.delegate
        self._handoff_seen.add(event.delegate_id)
        self._observer_handoff_claim = (event, delegate)
        return delegate

    def claimed_handoff(self, event: HandoffEvent) -> Delegate | None:
        claim = self._observer_handoff_claim
        if claim is None or claim[0] is not event:
            return None
        return claim[1]

    def clear_observer_handoff_claim(self, event: HandoffEvent) -> None:
        """Clear the exact event's transient observer projection."""
        claim = self._observer_handoff_claim
        if claim is not None and claim[0] is event:
            self._observer_handoff_claim = None

    def in_flight_delegate(self, delegate_id: str) -> Delegate | None:
        """The one still in flight, **without looking at the terminated table**. This is exactly the watershed between rule 2 and rule 3.

        `_apply_deadline` needs this because the design doc pins the four steps as append-first,
        remove-after: it has to answer "is it still in flight" before it knows whether to write
        that `unknown`, and at that point the in-flight table can't be touched yet.
        The difference from `find` is exactly this — `find` checks both tables (a late handoff
        needs that), this one only checks the in-flight one.
        """
        return self._in_flight.get(delegate_id)

    def terminated_by(self, delegate_id: str) -> str | None:
        """The KIND of the event that terminated it (`handoff` / `deadline`). **No production code reads this.**

        Kept around because it's the only place tests can observe "did rule 1 win or rule 2",
        and that's exactly what the scenario-3 test cases need to distinguish. What decides
        "should it wake up" is the method below, not this one.
        """
        return self._termination_kinds.get(delegate_id)

    def terminated_by_deadline(self, event: Deadline) -> bool:
        """Was it **this hop** that terminated it. `_wake_deadline` only trusts this.

        Why we can't just ask "is it still in flight": rule 2's atomic four steps already
        remove the delegate from the in-flight table inside apply, and the loop applies
        first, then computes wake targets. By the time of waking, rule 2 and rule 3 look
        identical.

        Why we can't just ask `terminated_by(id) == "deadline"`: that answers "in this
        delegate's whole lifetime". The same delegate receiving a second deadline would
        still be true, so it would wake again — a violation of rule 3.

        The comparison is by **object identity** (`is`), not value. What I originally wrote
        was `==`, on the reasoning that "the seq stamped at enqueue time is globally
        monotonic, so equal values mean the same event" — neither half of that holds
        (codex review round three, accepted as-is): `_seq` is a counter private to each
        `EventQueue` instance, not global; and `Deadline`'s `ts` / `seq` have defaults
        (`0.0` / `-1`), so two hand-constructed `Deadline("d-1")` with identical fields
        are equal on the spot — `==` would mistake the second one for the first.
        The earlier claim that "comparing by value is what makes replay and a live run
        agree" was also wrong: the main loop passes the **same** local variable to `apply`
        and then to `wake_targets` (the three-branch section in `runtime.py`); a replay
        reconstructs a new object, but within that one iteration, apply and wake still use
        that same new object, so `is` still holds. So R16's `seq` goes back to being purely
        for ordering, no longer moonlighting as identity.
        """
        record = self._terminated.get(event.delegate_id)
        return record is not None and record.event is event

    def rejected_before(self, request: DelegateRequest) -> bool:
        """Has this bad request been rejected before. **Only used as a wording reference for observations, no longer decides waking** (R30, revised).

        The original R30 used this memo as a brake: the same bad request only wakes once.
        codex review round three's testing overturned that — the value spaces of the four
        fields `executor` / `op` / `request` / `origin_ref` are all unbounded, so the model
        only needs to invent a different fake executor name each round (`ghost-1`,
        `ghost-2`, ...) or stuff a changing nonce into the request, and every single one is
        absent from this table, and every single one earns a fresh wake-up for free. Testing
        produced 50 model calls with 49 rejection observations: the loop hadn't converged,
        it had just changed from "repeating the same line" to "enumerating infinite new lines".

        The brake was replaced with counting by **wake chain**; see `Runtime._reject`. This
        table is therefore downgraded to a clue — no production code reads it — kept
        because it's the only place to tell after the fact whether the model is spinning in
        place or trying something new, and those two ailments call for different prescriptions.

        Stores a copy: the `request` dict comes from the model, and if anyone mutates it in
        place, this memo would misidentify who it belongs to. **It's a shallow copy** — nested
        dict/list would still drift along with it (reproduced by codex testing) — every op
        parameter installed so far this round is flat (`set_light` / `get_state` are all
        string/integer), so this hole can't be reached today. It's the same hole as
        `bind_delegate` and the copy handed to the adapter, to be dealt with together in R33.
        """
        return request in self._rejected

    def note_rejection(self, request: DelegateRequest) -> None:
        """Record one rejected dispatch attempt into the memo (a read-only clue only, see rationale above)."""
        self._rejected.append(replace(request, request=dict(request.request)))

    def duplicate_of(self, executor: str, op: str, request: dict[str, object]) -> Delegate | None:
        """Is there an **exact match** already in the in-flight table. If so, it's a duplicate dispatch (R28).

        Compares all three: executor, op, and the whole request. Not (executor, op) alone —
        "dim the living-room light" and "dim the bedroom light" are two different tasks with
        the same op, and running them concurrently is entirely legitimate. Only when all
        three match is there no legitimate explanation: **that exact thing is already
        happening**, and dispatching it again would just be doing it twice.

        Linear scan: the in-flight table is single-digit in size, so building an index for
        it would be trading complexity for performance that doesn't exist.
        """
        for delegate in self._in_flight.values():
            if delegate.executor == executor and delegate.op == op and delegate.request == request:
                return delegate
        return None

    def unresolved_duplicate_of(
        self, executor: str, op: str, request: dict[str, object]
    ) -> Delegate | None:
        """Is there an entry in the terminated table for the same thing that's **stuck on unknown**, and hasn't been fenced yet (R49).

        `duplicate_of` only scans the in-flight table, and that's correct: a task that
        already has a verdict can legitimately be done again ("turn the light back, then
        dim it once more"). But `unknown` is not a verdict — its whole meaning is
        "we don't know whether this actually happened or not." Dispatching the same thing
        again as-is at that point means stacking another attempt on top of an action that
        may have already taken effect, and that's exactly the shape reproduced by codex #34:
        `[('d-1','unknown'), ('d-2','unknown')]`, both stuck in uncertainty.

        **Both kinds of unknown count**, because they're saying the same thing:
        - terminated by `Deadline` -> step 1 of termination rule 2 writes `unknown` into the channel;
        - terminated by `HandoffEvent` with `outcome == "unknown"` -> the adapter itself
          reports uncertainty (timeout, transport interruption).
        Recognizing only the first kind would miss half the cases, and the missed half is
        exactly the uncertainty the executor **reports about itself**.

        **Blocks at most once** — that's what `_fenced` exists for. The reasoning is that this
        fence blocks a **reflex**, not "resending this task at all": in the R28 test case, the
        model's speech track was saying "the light is already being adjusted" while its
        action track dispatched it again anyway — each track reading only itself, that's a
        reflex. Blocking once, plus an observation that states the reason, turns the reflex
        into an **informed** choice: by then the recheck probe is on the table (R31 puts it
        first), and the model can probe before deciding. If it still chooses to resend after
        that, that's a call made at the decision layer, and the main loop stops intervening.
        Blocking permanently would mean the main loop making the decision on its behalf, and
        making it into **a box with no way out**: when the probe comes back saying "the light
        was never actually adjusted", the one correct action would also be blocked.

        **`_resolved` is the second unblocking table**, for a different reason than `_fenced`:
        that one records "already fenced once"; this one records "the answer became known
        later". See `note_resolved`.

        **This is not a safety gate.** Non-idempotent, dangerous ops rely on D4's
        action-level confirmation (`OpSpec.confirm`) — the same principle as `trust` not
        carrying a gate (D7): calling this a safety gate would lead people to think
        dangerous actions are already being kept in check.
        """
        for delegate_id, record in self._terminated.items():
            if delegate_id in self._fenced or delegate_id in self._resolved:
                continue
            delegate = record.delegate
            if delegate.executor != executor or delegate.op != op:
                continue
            if delegate.request != request:
                continue
            if isinstance(record.event, Deadline) or (
                isinstance(record.event, HandoffEvent) and record.event.outcome == "unknown"
            ):
                return delegate
        return None

    def note_fenced(self, delegate_id: str) -> None:
        """This unknown has already been fenced once — the same resend is let through next time (rationale above)."""
        self._fenced.add(delegate_id)
        if delegate_id in self._handoff_seen:
            self._forget_routing(delegate_id)

    def note_resolved(self, delegate_id: str) -> None:
        """This task later got a verdict (`ok` / `failed`), so it no longer counts as an unknown (R53).

        **Why this needs a second table instead of amending the termination record.**
        Termination rule 3 says the first terminator isn't overridden, so `terminate`
        returns None outright for a delegate that's no longer in flight — a late `ok`
        arriving after a deadline can't change a single character of that entry in
        `_terminated`. That record is correct (**it really was the deadline that terminated
        it**), and `terminated_by_deadline` still relies on `record.event is event` to
        recognize its own hop; overwriting it would break rule 3 along with it.
        So what's recorded here is something that happened **later**, unrelated to "who terminated it".

        Without this, `unresolved_duplicate_of` would keep treating this one as stuck on
        unknown forever, so:
        - the rejection observation would say "d-1 is stuck on unknown, recheck before
          deciding whether to resend", while the blackboard plainly has a late `ok` sitting
          right there — **the main loop would be telling the model a lie**;
        - and it would be blocking a legitimate resend. The docstring above itself says
          "a task that already has a verdict can legitimately be done again (turn the light
          back, then dim it once more)" — a late `ok` is exactly a verdict, and at that
          point the fence contradicts its own rule.

        Only `ok` / `failed` count as a verdict, using a **positive allowlist** rather than
        `!= "unknown"`: the `Literal` type `Outcome` can't stop anything at runtime (R41),
        and when an adapter hands over `outcome="garbage input"`, we genuinely don't
        know whether that thing happened or not — when in doubt, don't let it through.

        In production this marker is reclaimed with the routing record once its handoff/fence
        readers are done, or cleared with the remaining session-local indexes at shutdown (R57).
        Deterministic `run()` retains it for scenario assertions.
        """
        self._resolved.add(delegate_id)

    def after_routing(self, event: Event) -> None:
        """Reclaim a handoff's routing record after its wake targets were computed.

        A definite handoff has no future routing or R49 reader. An unknown must
        remain until its one anti-reflex fence has been used. Deadline records stay
        until the adapter's one possible late handoff arrives (or shutdown).
        """
        if not isinstance(event, HandoffEvent):
            return
        self.clear_observer_handoff_claim(event)
        if event.delegate_id not in self._terminated:
            return
        self._handoff_seen.add(event.delegate_id)
        if event.outcome in {"ok", "failed"} or event.delegate_id in self._fenced:
            self._forget_routing(event.delegate_id)

    def clear_routing_indexes(self) -> None:
        """Drop session-local routing state once production jobs can no longer return."""
        self._in_flight.clear()
        self._terminated.clear()
        self._fenced.clear()
        self._resolved.clear()
        self._handoff_seen.clear()
        self._observer_handoff_claim = None
        self._rejected.clear()

    def _forget_routing(self, delegate_id: str) -> None:
        self._terminated.pop(delegate_id, None)
        self._fenced.discard(delegate_id)
        self._resolved.discard(delegate_id)
        self._handoff_seen.discard(delegate_id)

    def find(self, delegate_id: str) -> Delegate | None:
        """The delegate from either table, **regardless of whether it's still in flight**.

        A late handoff also needs to wake using the values bound at dispatch time, so terminated ones need to be findable too.
        """
        delegate = self._in_flight.get(delegate_id)
        if delegate is not None:
            return delegate
        record = self._terminated.get(delegate_id)
        return record.delegate if record is not None else None

    def routing_class_of(self, delegate_id: str) -> RoutingClass:
        """The routing class **bound at dispatch time** for this delegate (R12).

        Falls back to `ambient` if not found: a handoff nobody claims shouldn't be entitled
        to interrupt the user. Wakes using the value bound at dispatch time, not by
        recomputing "this occasion's wake reason" from scratch — the latter is exactly the
        counterexample in 05-executors.md.
        """
        delegate = self.find(delegate_id)
        return delegate.routing_class if delegate is not None else "ambient"

    def snapshot(self) -> tuple[Delegate, ...]:
        """An **immutable** snapshot for ContextView, ordered by (dispatched_at, delegate_id).

        Both matter: passing a dict in would make the compiled view drift with insertion
        order, so snapshot tests couldn't pin anything down; passing a mutable reference in
        would kill the "pure function" property on the spot.
        """
        return tuple(
            sorted(
                self._in_flight.values(),
                key=lambda delegate: (delegate.dispatched_at, delegate.delegate_id),
            )
        )


def validate_origin_ref(ref: MemoryRef, *, memory: Memory, view: ContextView) -> str | None:
    """Validate `origin_ref` before dispatch, returning a problem description; `None` = passed.

    05-executors.md lists three checks: parseable / same scope / appeared in this call's
    ContextView. **This round implements two**, because the second can't be falsified in
    the current shape: one Memory is one ConversationScope, and the canonical form of ref,
    `channel:seq`, has no scope segment — "a cross-scope ref" is a sentence that can't be
    said right now. So it's absorbed into the first: parses successfully, and that
    MemoryItem is findable on **this** blackboard. Once multi-scope lands, it becomes an
    independent check again (R27).

    The third check is the most useful one: it turns "the model can only reference things
    it has actually seen" into something checkable. Once an entry is pushed out of the
    recent window by summarization, it's no longer visible — and if the model cites it at
    that point, it really is making things up.
    """
    try:
        channel, seq = parse_ref(ref)
    except ValueError as problem:
        return str(problem)

    stored = memory.channels.get(channel)
    if stored is None or not any(item.seq == seq for item in stored.items):
        return f"origin_ref 指向的条目不存在：{ref}"

    if not any(item.ref == ref for channel_view in view.channels for item in channel_view.recent):
        return f"origin_ref 不在这次调用看到的上下文里：{ref}"
    return None
